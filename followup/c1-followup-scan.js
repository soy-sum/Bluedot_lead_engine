/**
 * Service C, C1: pull the follow-up queue from the CRM (deploy/ACTIVEPIECES.md)
 * and stage one IDENTITY-ONLY row per queue entry -> Followup-Outbox.
 * GET /queue.csv (Bearer).
 *
 * CRM terminology (kept consistent here): `touch` = the Nth mail.
 *   touch 1 = first mail, sent by SERVICE A         -> C SKIPS it
 *   touch 2 = first mail + 1st follow-up            -> C sends (Follow-up 1)
 *   touch 3 = first mail + 2nd follow-up            -> C sends (Follow-up 2)
 *   touch 4 = first mail + 3rd follow-up            -> C sends (Follow-up 4)
 *   touch 5 = first mail + 4th (final) follow-up    -> C sends (Follow-up 5)
 * Cadence (set on the CRM side, not here): FOLLOWUP_INTERVALS=4,3,7,16 —
 * 4 days after the first mail, 3 after the 1st follow-up, 7 after the 2nd,
 * 16 after the 3rd. FOLLOWUP_MAX_TOUCHES=5. The touch->template mapping
 * above doesn't depend on these gap values — it only cares which touch
 * number arrives, so this cadence can change again without touching this
 * code, only the CRM's config.
 *
 * NO subject/body is written here. The actual email is composed by C2 at
 * SEND time, from the current template code — so editing the templates
 * always takes effect immediately, even for rows already sitting in
 * Followup-Outbox (this deliberately mirrors Service A's design, after C
 * hit the staleness bug where already-drafted rows kept sending old copy).
 * No `approved` column either — no approval gate any more.
 *
 * THREADING: `previous_emails` (queue.csv) carries every past touch keyed
 * by touch number, each with its own `message_id` (RFC 5322 Message-ID —
 * see outreach-crm PR "Expose message_id in /queue.csv's previous_emails").
 * The latest touch's message_id (key = touch-1, the most recent mail this
 * company actually received) is pulled out here as `inReplyTo` and carried
 * on the Outbox row, so C2 can pass it to Gmail's In-Reply-To at send time
 * and thread the follow-up into the existing conversation instead of
 * sending a new one. Empty string if missing (older row, or the CRM's fix
 * hasn't shipped yet) — C2 just won't set In-Reply-To for those.
 *
 * OUTPUT { outboxRows, drafts, stats }
 */
export const code = async (inputs) => {
  const base = String(inputs.crmBaseUrl || 'https://your-crm.example.com').replace(/\/+$/, '');
  const token = String(inputs.crmToken || '').trim();
  const maxDrafts = Number(inputs.maxDrafts) > 0 ? Number(inputs.maxDrafts) : 100;
  if (!token) return { outboxRows: [], drafts: [], stats: { error: 'no crmToken' } };

  let text = '';
  try {
    const r = await fetch(base + '/queue.csv', { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(30000) });
    if (!r.ok) return { outboxRows: [], drafts: [], stats: { error: 'queue fetch ' + r.status } };
    text = await r.text();
  } catch (e) { return { outboxRows: [], drafts: [], stats: { error: String(e && e.message) } }; }

  const splitLine = (line) => {
    const out = []; let cur = ''; let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
      else { if (ch === '"') q = true; else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch; }
    }
    out.push(cur); return out;
  };
  const lines = text.replace(/\r\n/g, '\n').split('\n').filter((l) => l.trim() !== '');
  if (!lines.length) return { outboxRows: [], drafts: [], stats: { queued: 0 } };
  const headers = splitLine(lines[0]).map((h) => h.trim());
  const queue = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitLine(lines[i]);
    const obj = {}; headers.forEach((h, idx) => { obj[h] = (cells[idx] !== undefined ? cells[idx] : '').trim(); });
    queue.push(obj);
  }

  const clean = (s) => (s === null || s === undefined ? '' : String(s)).replace(/\s+/g, ' ').trim();

  const latestMessageId = (raw, touch) => {
    if (!raw) return '';
    try {
      const history = JSON.parse(raw);
      const key = String((Number(touch) || 1) - 1);
      return (history[key] && history[key].message_id) || '';
    } catch { return ''; }
  };

  const outboxRows = [];
  const nowIso = new Date().toISOString();
  const stats = { queued: queue.length, drafted: 0, noEmail: 0, firstTouchSkipped: 0 };
  for (const q of queue) {
    const touch = Number(q.touch) || 0;
    if (touch <= 1) { stats.firstTouchSkipped++; continue; } // touch 1 = Service A's first mail, not C
    const email = clean(q.email);
    if (!email.includes('@')) { stats.noEmail++; continue; }
    const contact = clean(q.contact_name);
    const company = clean(q.company);
    const country = clean(q.country);
    const inReplyTo = latestMessageId(q.previous_emails, touch);
    outboxRows.push({
      touchNo: touch, contact, client: company, country, to: email,
      status: 'pending', inReplyTo,
      the CRMId: '', buyerKey: clean(q.domain) || (company || email).toLowerCase(), queuedAt: nowIso,
    });
    stats.drafted++;
    if (outboxRows.length >= maxDrafts) { stats.heldByCap = true; break; }
  }
  return { outboxRows, drafts: outboxRows, stats };
};
