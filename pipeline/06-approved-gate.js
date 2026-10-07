/**
 * Activepieces Code piece — Stack 6: Approved-send gate.
 *
 * Reads the Outbox tab and releases ONLY rows you approved and that haven't been
 * sent yet. Applies the same throttle + test-mode redirect as the old send gate.
 * Produces: the batch to send, the Sent-log rows to append, and the Outbox rows
 * to mark as sent.
 *
 * Flow: get_outbox -> THIS -> Loop(toSend)->Gmail -> Loop(newLogRows)->Insert Sent
 *       -> Loop(outboxUpdates)->Update Row (Outbox).
 *
 * INPUTS:
 *   outbox        = rows from the Outbox tab (must include each row's line number)
 *   sentLog       = rows from the Sent tab (for the daily counter + safety dedup)
 *   maxPerRun     = default 5
 *   dailyCap      = default 40
 *   testMode      = boolean
 *   testRecipient = your inbox (required if testMode)
 *
 * OUTPUT { toSend, newLogRows, outboxUpdates, skipped }
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
  const sentLog = normSheet(inputs.sentLog);
  const maxPerRun = Number(inputs.maxPerRun) > 0 ? Number(inputs.maxPerRun) : 5;
  const dailyCap = Number(inputs.dailyCap) > 0 ? Number(inputs.dailyCap) : 40;
  const testMode = Boolean(inputs.testMode);
  const testRecipient = String(inputs.testRecipient || '').trim();

  const lc = (s) => String(s || '').toLowerCase().trim();
  const today = new Date().toISOString().slice(0, 10);
  const isApproved = (v) => /^(y|yes|true|1|approve|approved|✓|x)$/i.test(String(v || '').trim());
  const isSent = (v) => /^(sent|done)$/i.test(String(v || '').trim());

  if (testMode && !testRecipient) {
    return { toSend: [], newLogRows: [], outboxUpdates: [],
      skipped: { error: 'testMode on but no testRecipient' } };
  }

  // already-sent guard + today's counter (from Sent log)
  const sentKeys = new Set();
  let sentToday = 0;
  for (const r of sentLog) {
    if (r.buyerKey) sentKeys.add(lc(r.buyerKey));
    if (String(r.sentAt || '').slice(0, 10) === today) sentToday++;
  }

  const skipped = { notApproved: 0, alreadySent: 0, noRow: 0 };
  const eligible = [];
  for (const r of outbox) {
    if (!isApproved(r.approved)) { skipped.notApproved++; continue; }
    if (isSent(r.status) || sentKeys.has(lc(r.buyerKey))) { skipped.alreadySent++; continue; }
    if (r.row === undefined || r.row === null || r.row === '') { skipped.noRow++; continue; }
    eligible.push(r);
  }

  const remainingDaily = Math.max(0, dailyCap - sentToday);
  const takeN = Math.min(maxPerRun, remainingDaily, eligible.length);
  const batch = eligible.slice(0, takeN);

  const nowIso = new Date().toISOString();
  const toSend = [];
  const newLogRows = [];
  const outboxUpdates = [];

  for (const r of batch) {
    const realTo = r.to;
    toSend.push({
      to: testMode ? testRecipient : realTo,
      subject: testMode ? `[TEST → ${realTo}] ${r.subject}` : r.subject,
      body: r.body,
    });
    newLogRows.push({
      buyerKey: r.buyerKey || '', buyerName: r.buyerName || '', to: realTo,
      subject: r.subject || '', track: r.track || '', status: 'sent',
      sentAt: nowIso, lastActionAt: nowIso, followupCount: 0,
      testMode: testMode ? 'yes' : 'no',
    });
    outboxUpdates.push({ row: r.row, status: 'sent', sentAt: nowIso });
  }

  return {
    toSend, newLogRows, outboxUpdates,
    skipped: { ...skipped, sentTodayBefore: sentToday,
      eligible: eligible.length, sending: batch.length,
      heldByThrottle: Math.max(0, eligible.length - batch.length) },
  };
};
