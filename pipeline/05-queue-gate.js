/**
 * Code piece — Queue gate (dedup by EMAIL + throttle), loopless.
 *
 * Turns personalized drafts into Outbox rows, dropping any recipient we've
 * already mailed or already queued. Dedup key is the ADDRESS (`to`), because
 * the unit of sending is now a recipient, not a company.
 *
 * INPUT  emails   = personalize.emails
 *        sentLog  = Sent tab rows      (skip addresses already sent)
 *        outbox   = Outbox tab rows    (skip addresses already queued & pending)
 * OUTPUT { toQueue:[Outbox row], stats }
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
      const obj = {}; if (r.row !== undefined) obj.row = r.row;
      for (const [k, val] of Object.entries(r)) { if (k === 'row') continue; const n = map[k]; if (n) obj[n] = val; }
      out.push(obj);
    }
    return out;
  };

  const emails = Array.isArray(inputs.emails) ? inputs.emails : [];
  const sentLog = normSheet(inputs.sentLog);
  const outbox = normSheet(inputs.outbox);
  const lc = (s) => String(s || '').toLowerCase().trim();
  const nowIso = new Date().toISOString();

  const contacted = new Set();
  for (const r of sentLog) if (r.to) contacted.add(lc(r.to));
  for (const r of outbox) if (r.to) contacted.add(lc(r.to));

  const seen = new Set();
  const toQueue = [];
  const stats = { emailsIn: emails.length, queued: 0, alreadyHandled: 0, noAddress: 0, dupInBatch: 0 };

  for (const e of emails) {
    const to = lc(e.to);
    if (!to || !to.includes('@')) { stats.noAddress++; continue; }
    if (contacted.has(to)) { stats.alreadyHandled++; continue; }
    if (seen.has(to)) { stats.dupInBatch++; continue; }
    seen.add(to);
    toQueue.push({
      buyerKey: e.buyerKey || '', company: e.company || '', domain: e.domain || '',
      to: e.to, spocName: e.spocName || '', emailType: e.emailType || '',
      subject: e.subject || '', body: e.body || '', track: e.track || '',
      approved: '', status: 'pending', queuedAt: nowIso,
    });
    stats.queued++;
  }
  return { toQueue, stats };
};
