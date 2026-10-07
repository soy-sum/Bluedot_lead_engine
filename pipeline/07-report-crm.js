/**
 * Code piece — Report to CRM (/ingest), loopless.
 *
 * One batched POST /ingest that reports the companies we prospected and the
 * contacts we found, so Service B's SQLite (the shared source of truth) learns
 * about them and Service A's next-run /lookup dedups against them.
 *
 * NEVER reports a send — the CRM reads sends from the sender@ mailbox, and an
 * `email_sent` event is rejected with 422 (see deploy/ACTIVEPIECES.md).
 *
 * Idempotent: an identical body replays as {"status":"duplicate"}. If the batch
 * is rejected (422) it is all-or-nothing and the response names the bad row.
 *
 * INPUT  companies = assemble.companies, contacts = assemble.contacts
 *        crmBaseUrl (default https://your-crm.example.com), crmToken,
 *        batch (default a timestamp)
 * OUTPUT { status, seen, new, by_op } | { skipped } | { error }
 */

export const code = async (inputs) => {
  const companies = Array.isArray(inputs.companies) ? inputs.companies : [];
  const contacts = Array.isArray(inputs.contacts) ? inputs.contacts : [];
  const base = String(inputs.crmBaseUrl || 'https://your-crm.example.com').replace(/\/+$/, '');
  const token = String(inputs.crmToken || '').trim();
  const batch = String(inputs.batch || `ap-${Date.now()}`);

  if (!token) return { skipped: 'no crmToken' };
  if (!companies.length && !contacts.length) return { skipped: 'nothing to report' };

  // icpScore (number) -> the CRM's A/B/C fit_rating (drives queue order)
  const fitRating = (fit) => {
    const n = Number(fit);
    if (Number.isNaN(n)) return 'C';
    return n >= 7 ? 'A' : n >= 4 ? 'B' : 'C';
  };

  const records = [];
  for (const c of companies) {
    if (!c.name && !c.domain) continue;
    records.push({
      op: 'company', name: c.name, domain: c.domain || '',
      website: c.domain ? `https://${c.domain}` : '',
      country: c.country || '', fit_rating: fitRating(c.fit),
    });
  }
  for (const p of contacts) {
    if (!p.email) continue;
    // Link to the company by DOMAIN — that is what Service B matches on, and
    // the domain rides in the same batch as the company record (see
    // deploy/ACTIVEPIECES.md A4). `company_name` lets the CRM auto-create the
    // company if the domain is somehow absent, so a contact never voids the
    // all-or-nothing batch.
    records.push({
      op: 'contact',
      company: p.domain || (p.email.split('@')[1] || ''),
      company_name: p.company || '',
      email: p.email, full_name: p.spocName || '', title: p.title || '',
    });
  }
  if (!records.length) return { skipped: 'no valid records' };

  try {
    const r = await fetch(`${base}/ingest`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ service: 'A', batch, records }),
      signal: AbortSignal.timeout(30000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { error: `HTTP ${r.status}`, detail: j.error || j.status || '', reported: records.length };
    return { ...j, reported: records.length };
  } catch (e) {
    return { error: String(e && e.message ? e.message : e), reported: records.length };
  }
};
