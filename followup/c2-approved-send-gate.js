/**
 * Activepieces Code piece — Service C, Stack C2: Auto-send gate + composer.
 *
 * Runs inside the **C-send** flow (Webhook trigger). Reads the Followup-Outbox tab
 * (identity only — no subject/body stored there) and, for every row not already
 * sent, composes the email FRESH right here from the current template code, then
 * releases it. No per-row human approval — the follow-up copy is fixed (the sender's
 * 4 templates, no LLM). The release point is the coworker's CRM dashboard "Send
 * follow-up emails" button (which fires webhook #2 after C5's /handoff), not a
 * sheet checkbox.
 *
 * Composing here (not at draft time in C1) means editing a template always takes
 * effect immediately, even for rows already queued — fixes the staleness bug
 * where already-drafted rows kept sending old copy after a template edit.
 * Mirrors Service A's send-gate design.
 *
 * THREADING: each Outbox row carries `inReplyTo` (the previous touch's Gmail
 * Message-ID, set by C1 from the CRM's previous_emails). Passed through into
 * `toSend` so the Gmail send step can set In-Reply-To and thread the follow-up
 * into the existing conversation instead of sending a new one. Empty string if
 * C1 didn't have one — the Gmail step just won't set the header for that row.
 *
 * Applies a throttle + test-mode redirect, then hands back: the batch to send,
 * the rows to append to the separate Followup-Sent sheet, and the Outbox rows to
 * DELETE (clean-up) — sorted bottom-up so deleting one row never shifts the row
 * number of another pending one.
 *
 * Flow:  Webhook -> Sheets Get Rows (Followup-Outbox) -> THIS
 *        -> Loop(toSend)->Gmail Send
 *        -> Loop(sentRows)->Sheets Insert Row (Followup-Sent)
 *        -> Loop(outboxDeletes)->Sheets Delete Row (Followup-Outbox).
 *
 * INPUTS
 *   outbox        = rows from the Followup-Outbox tab (must include each row's line no.)
 *   maxPerRun     = default 100
 *   dailyCap      = default 100
 *   testMode      = boolean
 *   testRecipient = your inbox (required if testMode)
 *
 * OUTPUT { toSend, sentRows, outboxDeletes, skipped }
 */

export const code = async (inputs) => {
  const normSheet = (v) => {
    let rows = Array.isArray(v) ? v
      : (v && (Array.isArray(v.rows) ? v.rows
        : Array.isArray(v.values) ? v.values
        : Array.isArray(v.body) ? v.body : [])) || [];
    if (!Array.isArray(rows)) rows = [];
    rows = rows.map((r) => (r && typeof r.values === 'object' && r.values) ? { row: r.row, ...r.values } : r);
    const lettered = rows.some((r) => r && (r.A !== undefined || r.B !== undefined));
    if (!lettered) return rows;
    const header = rows.find((r) => String(r.row) === '1') || rows[0];
    if (!header) return [];
    const map = {};
    for (const [k, val] of Object.entries(header)) if (k !== 'row') map[k] = String(val).trim();
    const out = [];
    for (const r of rows) {
      if (r === header || String(r.row) === '1') continue;
      const obj = {};
      if (r.row !== undefined) obj.row = r.row;
      for (const [k, val] of Object.entries(r)) {
        if (k === 'row') continue;
        const name = map[k];
        if (name) obj[name] = val;
      }
      out.push(obj);
    }
    return out;
  };

  const outbox = normSheet(inputs.outbox);
  const maxPerRun = Number(inputs.maxPerRun) > 0 ? Number(inputs.maxPerRun) : 100;
  const dailyCap = Number(inputs.dailyCap) > 0 ? Number(inputs.dailyCap) : 100;
  const testMode = Boolean(inputs.testMode);
  const testRecipient = String(inputs.testRecipient || '').trim();

  const isSent = (v) => /^(sent|done)$/i.test(String(v || '').trim());
  const clean = (s) => (s === null || s === undefined ? '' : String(s)).replace(/\s+/g, ' ').trim();
  const firstName = (full) => clean(full).split(' ')[0] || '';

  if (testMode && !testRecipient) {
    return { toSend: [], sentRows: [], outboxDeletes: [],
      skipped: { error: 'testMode on but no testRecipient' } };
  }

  // Fixed follow-up copy, keyed by CRM touch number (2-5), sent verbatim —
  // no trailing "Best," sign-off, no appended signature block.
  const TEMPLATES = {
    2: (name, company) => `Hi ${name},\n\nthe sender this side again from Acme Exports, just wanted to follow up with you on my previous email for ${company}.\n\nDid you get the chance to review the products in our catalogue I shared previously?\n\nWe're confident that our pricing, product quality, and one-stop sourcing solutions provide excellent value compared to other Indian or Chinese suppliers.\n\nLooking forward to hearing from you.`,
    3: (name, company) => `Hi ${name},\n\nExcuse my regular follow ups - I know you might be busy, but that's where we come in, so that you can forget about your order once you place it with Acme.\n\nWhat I can do for you is share you a straightforward best Ex-factory and FOB rates for the top moving SKU's for a cost comparison against what you are paying now.\n\nJust need a confirmation from you on the same to send it across.\n\nLooking forward to building a long term working relation with ${company}`,
    4: (name, company) => `Hi ${name},\n\nI know we are adamant, but that follows while delivering your order and our services as well.\n\nSwitching suppliers is usually easier than it sounds. We can match your current spec on weight and thickness so nothing changes on your end, and we handle more painful parts as well - like sourcing multiple products at one place, logistics, and hassle-free paperwork.\n\nWorth a quick call or reply to see if the numbers work for you?\n\nAlso, still happy to send over samples if useful, they tend to answer the quality question faster than any spec sheet.\n\nLet me know if that would help.`,
    5: (name, company) => `Hi ${name},\n\nLast note from me on this one, don't want to clutter your inbox.\n\nBut if sourcing disposable tableware products from India across categories with great quality and service with competitive pricing becomes relevant down the line, I'm happy to pick this back up, just reply anytime.\n\nYou can always find us at Instagram @Acme Exports and on your-company.example.com\n\nEither way, thanks for your time and for building a sustainable brand like yours.`,
  };

  const composeEmail = (r) => {
    const n = Number(r.touchNo) || 2;
    const key = TEMPLATES[n] ? n : (n < 2 ? 2 : 5); // clamp anything outside 2-5 to the nearest real touch
    const name = firstName(r.contact) || 'there';
    const company = r.client || 'your team';
    return { subject: 'Re: Bagasse tableware from India', body: TEMPLATES[key](name, company) };
  };

  const skipped = { alreadySent: 0, noRow: 0, noEmail: 0 };
  const eligible = [];
  for (const r of outbox) {
    if (isSent(r.status)) { skipped.alreadySent++; continue; }
    if (r.row === undefined || r.row === null || r.row === '') { skipped.noRow++; continue; }
    if (!String(r.to || '').includes('@')) { skipped.noEmail++; continue; }
    eligible.push(r);
  }

  const takeN = Math.min(maxPerRun, dailyCap, eligible.length);
  const batch = eligible.slice(0, takeN);

  const nowIso = new Date().toISOString();
  const toSend = [];
  const sentRows = [];
  const outboxDeletes = [];

  for (const r of batch) {
    const { subject, body } = composeEmail(r);
    const realTo = r.to;
    toSend.push({
      to: testMode ? testRecipient : realTo,
      subject: testMode ? `[TEST → ${realTo}] ${subject}` : subject,
      body,
      inReplyTo: testMode ? '' : (r.inReplyTo || ''), // don't thread into the real conversation while testing
    });
    sentRows.push({
      touchNo: r.touchNo || '', contact: r.contact || '', client: r.client || '',
      country: r.country || '', to: realTo, subject,
      status: 'sent', sentAt: nowIso, the CRMId: r.the CRMId || '',
      buyerKey: r.buyerKey || '', testMode: testMode ? 'yes' : 'no',
    });
    outboxDeletes.push({ row: Number(r.row) });
  }

  // delete bottom-up so removing one row doesn't renumber the rows still pending.
  outboxDeletes.sort((a, b) => b.row - a.row);

  return {
    toSend, sentRows, outboxDeletes,
    skipped: { ...skipped, eligible: eligible.length, sending: batch.length,
      heldByThrottle: Math.max(0, eligible.length - batch.length) },
  };
};
