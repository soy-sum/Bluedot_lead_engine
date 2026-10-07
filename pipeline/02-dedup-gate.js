/**
 * Code piece — Dedup gate, loopless. Runs AFTER resolve_domain (so we have a
 * domain) and BEFORE find_spocs (so no finder credit is spent on a company we
 * already handled).
 *
 * Two sources, cheapest first:
 *  1. Local cache — the Companies / Sent / Outbox sheets (by domain + buyerKey).
 *  2. CRM /lookup?domain= — authoritative (SQLite), and it also knows the
 *     disqualified/closed companies the CRM drops. Only queried for domains the
 *     local cache didn't already resolve, and capped by maxLookups.
 *
 * A resolved company that is already known is dropped. Everything else (incl.
 * needs_review / no_domain buyers) passes through so assemble can Review them.
 *
 * INPUT  enriched = resolve_domain.enriched
 *        companies / sent / outbox = those sheet rows (cache)
 *        crmBaseUrl (default …your-company.example.com), crmToken (optional),
 *        maxLookups (default 80)
 * OUTPUT { fresh, skipped, stats }
 */

export const code = async (inputs) => {
  const normSheet = (v) => {
    let rows = Array.isArray(v) ? v
      : (v && (Array.isArray(v.rows) ? v.rows : Array.isArray(v.values) ? v.values
        : Array.isArray(v.body) ? v.body : [])) || [];
    if (!Array.isArray(rows)) rows = [];
    rows = rows.map((r) => (r && typeof r.values === 'object' && r.values) ? { row: r.row, ...r.values } : r);
    const lettered = rows.some((r) => r && (r.A !== undefined || r.B !== undefined));
    if (!lettered) return rows;
    const header = rows.find((r) => String(r.row) === '1') || rows[0];
    if (!header) return [];
    const map = {}; for (const [k, val] of Object.entries(header)) if (k !== 'row') map[k] = String(val).trim();
    const out = [];
    for (const r of rows) {
      if (r === header || String(r.row) === '1') continue;
      const obj = {}; for (const [k, val] of Object.entries(r)) { if (k === 'row') continue; const n = map[k]; if (n) obj[n] = val; }
      out.push(obj);
    }
    return out;
  };

  const enriched = Array.isArray(inputs.enriched) ? inputs.enriched : [];
  const companies = normSheet(inputs.companies);
  const sent = normSheet(inputs.sent);
  const outbox = normSheet(inputs.outbox);
  const base = String(inputs.crmBaseUrl || 'https://your-crm.example.com').replace(/\/+$/, '');
  const token = String(inputs.crmToken || '').trim();
  const maxLookups = Number(inputs.maxLookups) >= 0 ? Number(inputs.maxLookups) : 80;

  const lc = (s) => String(s || '').toLowerCase().trim();
  const knownDomains = new Set();
  const knownKeys = new Set();
  for (const r of companies) { if (r.domain) knownDomains.add(lc(r.domain)); if (r.buyerKey) knownKeys.add(lc(r.buyerKey)); }
  for (const r of [...sent, ...outbox]) {
    if (r.buyerKey) knownKeys.add(lc(r.buyerKey));
    if (r.domain) knownDomains.add(lc(r.domain));
  }

  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  let lookups = 0;
  const crmKnown = async (domain) => {
    if (!token || lookups >= maxLookups) return false;
    lookups++;
    try {
      const r = await fetch(`${base}/lookup?domain=${encodeURIComponent(domain)}`,
        { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(12000) });
      if (!r.ok) return false;
      const j = await r.json();
      await sleep(80);
      // should_prospect === false means already in the pipeline (any stage).
      return j && j.should_prospect === false;
    } catch { return false; }
  };

  const fresh = [];
  const skipped = [];
  const stats = { input: enriched.length, skippedCache: 0, skippedCrm: 0, crmLookups: 0, fresh: 0, passthrough: 0 };

  for (const b of enriched) {
    if (b.enrichStatus !== 'resolved') { fresh.push(b); stats.passthrough++; continue; }
    const dom = lc(b.domain);
    if (knownDomains.has(dom) || knownKeys.has(lc(b.buyerKey))) {
      skipped.push({ ...b, skipReason: 'in_cache' }); stats.skippedCache++; continue;
    }
    if (await crmKnown(dom)) {
      skipped.push({ ...b, skipReason: 'in_crm' }); stats.skippedCrm++; continue;
    }
    fresh.push(b); stats.fresh++;
  }
  stats.crmLookups = lookups;
  return { fresh, skipped, stats };
};
