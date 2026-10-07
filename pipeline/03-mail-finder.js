/**
 * Code piece — Mail finder (seed → resolve → scrape → infer → verify), loopless.
 *
 *   1. SEED CHECK   — provided email passes mx+syntax → A_high, 0 credits
 *   2. RESOLVE      — seed_web, else search (SearXNG → Brave → Serper → Tavily),
 *                     else Clearbit; corroborate candidate vs name + MX
 *   3. FIND EMAIL   — scrape /contact /about /team /impressum … + mailto:
 *                     self-published → A_high (0 credits); else pattern+name;
 *                     else people finders Hunter → Apollo → Snov (budgeted)
 *   4. VERIFY       — inferred only: Reoon → ZeroBounce (budget)
 *                     valid→B_medium, catch_all/unverified→C_hold (review)
 *
 * INPUT  buyers = clean.uniqueBuyers ; companies/sent/outbox = cache rows
 *        searxngUrl, braveApiKey, serperApiKey, tavilyApiKey,
 *        hunterApiKey, apolloApiKey, snovClientId, snovClientSecret,
 *        reoonApiKey, zeroBounceApiKey,
 *        hunterMax(25), apolloMax(25), snovMax(50), searchMax(90),
 *        reoonMax(500), zbMax(100), icpMin(2), maxCompanies(60)
 * OUTPUT { recipients, review, companies, contacts, stats, budgets }
 */

export const code = async (inputs) => {
  const buyers = Array.isArray(inputs.buyers) ? inputs.buyers : [];
  const searxngUrl = String(inputs.searxngUrl || '').replace(/\/+$/, '');
  const braveKey = String(inputs.braveApiKey || '').trim();
  const serperKey = String(inputs.serperApiKey || '').trim();
  const tavilyKey = String(inputs.tavilyApiKey || '').trim();
  const hunterKey = String(inputs.hunterApiKey || '').trim();
  const apolloKey = String(inputs.apolloApiKey || '').trim();
  const snovId = String(inputs.snovClientId || '').trim();
  const snovSecret = String(inputs.snovClientSecret || '').trim();
  const reoonKey = String(inputs.reoonApiKey || '').trim();
  const zbKey = String(inputs.zeroBounceApiKey || '').trim();
  const num = (v, d) => (Number(v) >= 0 ? Number(v) : d);
  const hunterMax = num(inputs.hunterMax, 25), apolloMax = num(inputs.apolloMax, 25), snovMax = num(inputs.snovMax, 50);
  const searchMax = num(inputs.searchMax, 90), reoonMax = num(inputs.reoonMax, 500), zbMax = num(inputs.zbMax, 100);
  const icpMin = num(inputs.icpMin, 2), maxCompanies = num(inputs.maxCompanies, 60);

  const normSheet = (v) => {
    let rows = Array.isArray(v) ? v : (v && (Array.isArray(v.rows) ? v.rows : Array.isArray(v.values) ? v.values : [])) || [];
    rows = rows.map((r) => (r && typeof r.values === 'object' && r.values) ? { row: r.row, ...r.values } : r);
    const lettered = rows.some((r) => r && (r.A !== undefined || r.B !== undefined));
    if (!lettered) return rows;
    const header = rows.find((r) => String(r.row) === '1') || rows[0];
    if (!header) return [];
    const map = {}; for (const [k, val] of Object.entries(header)) if (k !== 'row') map[k] = String(val).trim();
    return rows.filter((r) => r !== header && String(r.row) !== '1').map((r) => {
      const o = {}; for (const [k, val] of Object.entries(r)) { if (k === 'row') continue; const n = map[k]; if (n) o[n] = val; } return o;
    });
  };

  const FREE = new Set(['gmail.com', 'yahoo.com', 'yahoo.co.in', 'hotmail.com', 'outlook.com', 'live.com', 'aol.com', 'icloud.com', 'rediffmail.com', 'ymail.com', 'protonmail.com', 'gmx.com', 'mail.com', 'qq.com', '163.com', '126.com']);
  const DIRECTORY = new Set(['importkey.com', 'importinfo.com', 'importgenius.com', 'panjiva.com', 'volza.com', 'zauba.com', 'seair.co.in', 'exportgenius.in', 'trademo.com', 'tradeindia.com', 'indiamart.com', 'alibaba.com', 'made-in-china.com', 'ec21.com', 'go4worldbusiness.com', 'exportersindia.com', 'thomasnet.com', 'kompass.com', 'europages.com', 'dnb.com', 'bloomberg.com', 'linkedin.com', 'facebook.com', 'instagram.com', 'twitter.com', 'x.com', 'crunchbase.com', 'zoominfo.com', 'yelp.com', 'shop.app', 'wikipedia.org', 'amazon.com', 'ebay.com', 'youtube.com']);
  const ROLE_RANK = { procurement: 0, purchasing: 0, sourcing: 0, buyer: 0, buying: 0, sales: 1, info: 2, contact: 2, hello: 2, enquiry: 2, enquiries: 2, orders: 2, office: 3 };
  const lc = (s) => String(s || '').toLowerCase().trim();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const hostOf = (u) => lc(u).replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[/?#]/)[0];
  const domainOfEmail = (e) => lc(e).split('@')[1] || '';
  const localOf = (e) => lc(e).split('@')[0];
  const EMAIL_RE = /[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/gi;
  const wellFormed = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(e || ''));
  const cap = (s) => s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : '';
  const STOP = new Set(['the', 'and', 'llc', 'inc', 'ltd', 'co', 'corp', 'corporation', 'company', 'group', 'international', 'enterprises', 'solutions', 'pvt', 'private', 'limited', 'trading', 'exports', 'imports', 'usa', 'us', 'uk', 'canada', 'india', 'intl', 'i']);
  const nameTokens = (s) => lc(s).replace(/[^a-z0-9]+/g, ' ').split(' ').filter((t) => t.length >= 2 && !STOP.has(t));
  const badDomain = (d) => !d || DIRECTORY.has(d) || FREE.has(d) || !d.includes('.');
  // ICP score is computed here now (it used to live in resolve_domain, which
  // this piece replaced — clean does NOT emit it, so recompute from signals).
  const ICP_HS = new Set(['482370', '482361', '482369']);
  const ICP_KW = ['bagasse', 'tableware', 'compostable', 'molded fiber', 'moulded fibre', 'clamshell', 'plate', 'bowl', 'cup', 'container', 'egg carton', 'paper pulp', 'disposable', 'foodservice', 'cutlery', 'tray'];
  const icpScore = (b) => { const text = lc((b.productLabels || []).concat(b.products || []).join(' ')); const kw = ICP_KW.filter((k) => text.includes(k)).length; const hs = (b.hsFamilies || []).some((h) => ICP_HS.has(h)); const vol = Math.min(b.shipmentCount || 1, 5); let s = kw * 2 + (hs ? 3 : 0) + vol; if (kw === 0 && (b.shipmentCount || 1) <= 1) s -= 3; return s; };

  const mxCache = new Map();
  const hasMX = async (domain) => {
    if (mxCache.has(domain)) return mxCache.get(domain);
    let ok = false;
    try {
      const r = await fetch('https://dns.google/resolve?name=' + domain + '&type=MX', { signal: AbortSignal.timeout(7000) });
      const j = await r.json();
      ok = Array.isArray(j.Answer) && j.Answer.length > 0;
      if (!ok) { const r2 = await fetch('https://dns.google/resolve?name=' + domain + '&type=A', { signal: AbortSignal.timeout(7000) }); const j2 = await r2.json(); ok = Array.isArray(j2.Answer) && j2.Answer.length > 0; }
    } catch { ok = false; }
    mxCache.set(domain, ok); return ok;
  };
  const mxSyntaxGate = async (email) => wellFormed(email) && await hasMX(domainOfEmail(email));
  const fetchText = async (url, ms = 9000) => {
    try {
      const r = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AcmeBot/1.0)' }, signal: AbortSignal.timeout(ms) });
      if (!r.ok) return '';
      return (await r.text()).slice(0, 200000);
    } catch { return ''; }
  };

  // ---- STEP 2: search backends → candidate domains, then corroborate ----
  const hostsFrom = (urls) => { const out = []; for (const u of urls || []) { const h = hostOf(u); if (h && !badDomain(h) && !out.includes(h)) out.push(h); if (out.length >= 6) break; } return out; };
  let searchUsed = 0;
  const searxngSearch = async (q) => { if (!searxngUrl) return []; try { const r = await fetch(`${searxngUrl}/search?q=${encodeURIComponent(q)}&format=json`, { signal: AbortSignal.timeout(10000) }); const j = await r.json(); return (j.results || []).map((x) => x.url); } catch { return []; } };
  const braveSearch = async (q) => { if (!braveKey) return []; try { const r = await fetch('https://api.search.brave.com/res/v1/web/search?count=8&q=' + encodeURIComponent(q), { headers: { 'X-Subscription-Token': braveKey, Accept: 'application/json' }, signal: AbortSignal.timeout(12000) }); const j = await r.json(); return ((j.web && j.web.results) || []).map((x) => x.url); } catch { return []; } };
  const serperSearch = async (q) => { if (!serperKey) return []; try { const r = await fetch('https://google.serper.dev/search', { method: 'POST', headers: { 'X-API-KEY': serperKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ q, num: 8 }), signal: AbortSignal.timeout(12000) }); const j = await r.json(); return (j.organic || []).map((x) => x.link); } catch { return []; } };
  const tavilySearch = async (q) => { if (!tavilyKey) return []; try { const r = await fetch('https://api.tavily.com/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ api_key: tavilyKey, query: q, max_results: 8 }), signal: AbortSignal.timeout(12000) }); const j = await r.json(); return (j.results || []).map((x) => x.url); } catch { return []; } };
  const clearbit = async (name) => { try { const r = await fetch('https://autocomplete.clearbit.com/v1/companies/suggest?query=' + encodeURIComponent(name), { signal: AbortSignal.timeout(8000) }); const j = await r.json(); return Array.isArray(j) ? j.map((c) => hostOf(c.domain || '')).filter((d) => d && !badDomain(d)) : []; } catch { return []; } };
  const resolveCandidates = async (name, country) => {
    const q = `${name} ${country || ''} official website`.trim();
    if (searchUsed < searchMax) {
      searchUsed++;
      let urls = await searxngSearch(q);
      if (!urls.length) { await sleep(120); urls = await braveSearch(q); }
      if (!urls.length) { await sleep(120); urls = await serperSearch(q); }
      if (!urls.length) { await sleep(120); urls = await tavilySearch(q); }
      const hosts = hostsFrom(urls);
      if (hosts.length) return hosts;
    }
    return clearbit(name); // free, no key
  };
  const corroborateDomain = async (domain, name) => {
    domain = hostOf(domain);
    if (badDomain(domain)) return null;
    if (!await hasMX(domain)) return null;
    const html = await fetchText('https://' + domain);
    if (!html) return { domain, confidence: 'low' };
    const text = lc(html.replace(/<[^>]+>/g, ' '));
    const toks = nameTokens(name);
    const hit = toks.filter((t) => text.includes(t)).length;
    return { domain, confidence: toks.length && hit / toks.length >= 0.6 ? 'high' : 'low', html };
  };

  // ---- STEP 3: scrape ----
  const patternCache = new Map();
  const CONTACT_PATHS = ['', '/contact', '/contact-us', '/contactus', '/about', '/about-us', '/team', '/people', '/leadership', '/company', '/kontakt', '/impressum'];
  const scrapeEmails = async (domain, homeHtml) => {
    if (patternCache.has(domain)) return patternCache.get(domain);
    const found = new Set();
    const pages = homeHtml ? [homeHtml] : [];
    for (const p of CONTACT_PATHS) { if (p === '' && homeHtml) continue; const html = await fetchText('https://' + domain + p, 7000); if (html) pages.push(html); await sleep(100); }
    for (const html of pages) for (const m of (html.match(EMAIL_RE) || [])) { const e = lc(m); if (domainOfEmail(e) === domain) found.add(e); }
    const emails = [...found];
    let pattern = '';
    for (const e of emails) { const l = localOf(e); if (/^[a-z]+\.[a-z]+$/.test(l)) { pattern = '{first}.{last}'; break; } if (/^[a-z]\.[a-z]+$/.test(l)) { pattern = '{f}.{last}'; break; } if (/^[a-z]+[a-z]$/.test(l) && l.length > 4 && !ROLE_RANK.hasOwnProperty(l)) pattern = pattern || '{first}{last}'; }
    const res = { emails, pattern }; patternCache.set(domain, res); return res;
  };
  const pickRole = (emails) => { const roles = emails.filter((e) => ROLE_RANK.hasOwnProperty(localOf(e).split(/[._-]/)[0])); roles.sort((a, b) => (ROLE_RANK[localOf(a).split(/[._-]/)[0]] ?? 9) - (ROLE_RANK[localOf(b).split(/[._-]/)[0]] ?? 9)); return roles[0] || null; };
  const patternEngine = (pattern, first, last, domain) => { first = lc(first).replace(/[^a-z]/g, ''); last = lc(last).replace(/[^a-z]/g, ''); if (!pattern || (!first && !last)) return ''; const local = pattern.replace('{first}', first).replace('{last}', last).replace('{f}', first[0] || '').replace('{l}', last[0] || ''); return local && !local.includes('{') ? `${local}@${domain}` : ''; };

  // ---- STEP 3: people finders (Hunter → Apollo → Snov, budgeted) ----
  let hunterUsed = 0, apolloUsed = 0, snovUsed = 0, snovToken = '';
  const hunterSearch = async (domain) => {
    if (!hunterKey || hunterUsed >= hunterMax) return null; hunterUsed++;
    try { const r = await fetch(`https://api.hunter.io/v2/domain-search?domain=${domain}&limit=10&api_key=${hunterKey}`, { signal: AbortSignal.timeout(12000) }); const j = await r.json(); const d = j && j.data; if (!d) return null; return { pattern: d.pattern || '', people: (d.emails || []).filter((e) => e.value).map((e) => ({ email: lc(e.value), first: e.first_name || '', last: e.last_name || '', title: e.position || '' })) }; } catch { return null; }
  };
  const apolloSearch = async (domain) => {
    if (!apolloKey || apolloUsed >= apolloMax) return null; apolloUsed++;
    try { const r = await fetch('https://api.apollo.io/v1/mixed_people/search', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Key': apolloKey }, body: JSON.stringify({ q_organization_domains: domain, page: 1, per_page: 10 }), signal: AbortSignal.timeout(12000) }); const j = await r.json(); return { pattern: '', people: ((j && j.people) || []).filter((p) => p.email).map((p) => ({ email: lc(p.email), first: p.first_name || '', last: p.last_name || '', title: p.title || '' })) }; } catch { return null; }
  };
  const snovAuth = async () => { if (!snovId || !snovSecret) return ''; if (snovToken) return snovToken; try { const r = await fetch('https://api.snov.io/v1/oauth/access_token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ grant_type: 'client_credentials', client_id: snovId, client_secret: snovSecret }), signal: AbortSignal.timeout(12000) }); const j = await r.json(); snovToken = j.access_token || ''; return snovToken; } catch { return ''; } };
  const snovSearch = async (domain) => {
    if (snovUsed >= snovMax) return null; const tok = await snovAuth(); if (!tok) return null; snovUsed++;
    try { const r = await fetch('https://api.snov.io/v2/domain-emails-with-info', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ access_token: tok, domain, type: 'personal', limit: 10 }), signal: AbortSignal.timeout(12000) }); const j = await r.json(); return { pattern: '', people: ((j && j.emails) || []).map((e) => ({ email: lc(e.email || ''), first: e.firstName || '', last: e.lastName || '', title: e.position || '' })) }; } catch { return null; }
  };
  const peopleSearch = async (domain) => {
    let r = await hunterSearch(domain); if (r && (r.people.length || r.pattern)) return { ...r, provider: 'hunter' };
    await sleep(150); r = await apolloSearch(domain); if (r && r.people.length) return { ...r, provider: 'apollo' };
    await sleep(150); r = await snovSearch(domain); if (r && r.people.length) return { ...r, provider: 'snov' };
    return null;
  };

  // ---- STEP 4: verify with budget guard ----
  let reoonUsed = 0, zbUsed = 0;
  const mapStatus = (raw, catchAll) => { const s = lc(raw); if (catchAll || /catch.?all|accept.?all/.test(s)) return 'catch_all'; if (/^(valid|deliverable|safe|ok)$/.test(s)) return 'valid'; if (/invalid|undeliverable|do_not|disposable|spamtrap|reject/.test(s)) return 'invalid'; return 'unknown'; };
  const verifyEmail = async (email) => {
    if (reoonKey && reoonUsed < reoonMax) { reoonUsed++; try { const r = await fetch(`https://emailverifier.reoon.com/api/v1/verify?email=${encodeURIComponent(email)}&key=${reoonKey}&mode=quick`, { signal: AbortSignal.timeout(12000) }); const j = await r.json(); return mapStatus(j.status, j.is_catch_all_domain === true || j.status === 'catch_all'); } catch { return 'unknown'; } }
    if (zbKey && zbUsed < zbMax) { zbUsed++; try { const r = await fetch(`https://api.zerobounce.net/v2/validate?api_key=${zbKey}&email=${encodeURIComponent(email)}`, { signal: AbortSignal.timeout(12000) }); const j = await r.json(); return mapStatus(j.status, lc(j.status) === 'catch-all'); } catch { return 'unknown'; } }
    return 'no_budget';
  };

  // ---- dedup cache ----
  const cache = [...normSheet(inputs.companies), ...normSheet(inputs.sent), ...normSheet(inputs.outbox)];
  const knownDomains = new Set(); const knownKeys = new Set();
  for (const r of cache) { if (r.domain) knownDomains.add(lc(r.domain)); if (r.buyerKey) knownKeys.add(lc(r.buyerKey)); if (r.to) knownDomains.add(domainOfEmail(r.to)); }

  const recipients = [], review = [], companies = [], contacts = [];
  const nowIso = new Date().toISOString();
  const stats = { input: buyers.length, seed: 0, scrape: 0, verifiedValid: 0, hold: 0, noDomain: 0, noEmail: 0, skippedCache: 0, lowIcp: 0, processed: 0 };
  const pushRecipient = (b, email, grade, method, person) => {
    recipients.push({ buyerKey: b.buyerKey, company: b.buyerName, domain: domainOfEmail(email), to: email, spocName: person ? person.name : '', spocFirstName: person ? person.first : '', title: person ? person.title : '', emailType: person ? 'named' : 'role', grade, method, country: b.country || '', destinations: b.destinations || [], origins: b.origins || [], sellers: b.sellers || [], productLabels: b.productLabels || [], products: b.products || [] });
    contacts.push({ buyerKey: b.buyerKey, company: b.buyerName, domain: domainOfEmail(email), spocName: person ? person.name : '', title: person ? person.title : '', email, emailType: person ? 'named' : 'role', verifyStatus: grade, source: method, foundAt: nowIso });
  };
  const pushCompany = (b, domain) => companies.push({ buyerKey: b.buyerKey, name: b.buyerName, domain, country: (b.destinations && b.destinations[0]) || b.country || '', fit: b.icpScore ?? '', stage: 'new', foundAt: nowIso });
  const toReview = (b, reason, domain) => review.push({ buyerName: b.buyerName, domain: domain || b.domain || '', reason, at: nowIso });

  for (const b of buyers) {
    const score = (b.icpScore !== undefined && b.icpScore !== null && b.icpScore !== '') ? Number(b.icpScore) : icpScore(b);
    b.icpScore = score;
    if (score < icpMin) { stats.lowIcp++; toReview(b, 'low_icp'); continue; }
    if (stats.processed >= maxCompanies) { toReview(b, 'run_cap'); continue; }
    stats.processed++;

    // 1. SEED
    const seedEmail = (b.emails && b.emails[0]) || (b.freeEmails && b.freeEmails[0]) || '';
    if (seedEmail && await mxSyntaxGate(seedEmail)) { stats.seed++; pushCompany(b, domainOfEmail(seedEmail)); pushRecipient(b, seedEmail, 'A_high', 'seed', null); continue; }

    // 2. RESOLVE
    let resolved = null;
    const seedWeb = (b.websites && b.websites[0]) || b.domain || '';
    if (seedWeb) resolved = await corroborateDomain(seedWeb, b.buyerName);
    if (!resolved || resolved.confidence !== 'high') {
      const cands = await resolveCandidates(b.buyerName, b.country);
      for (const c of cands) { const ok = await corroborateDomain(c, b.buyerName); if (ok && ok.confidence === 'high') { resolved = ok; break; } if (ok && !resolved) resolved = ok; }
    }
    if (!resolved || resolved.confidence !== 'high') { stats.noDomain++; toReview(b, resolved ? 'domain_low_confidence' : 'no_domain', resolved && resolved.domain); continue; }
    const domain = resolved.domain;
    if (knownDomains.has(domain) || knownKeys.has(lc(b.buyerKey))) { stats.skippedCache++; continue; }

    // 3. SCRAPE (self-published → A_high, 0 credits)
    const { emails, pattern } = await scrapeEmails(domain, resolved.html);
    const selfAny = pickRole(emails) || emails[0];
    if (selfAny && await mxSyntaxGate(selfAny)) { stats.scrape++; pushCompany(b, domain); pushRecipient(b, selfAny, 'A_high', 'scrape', null); continue; }

    // 3b. infer candidates (scrape pattern + name, then people finders)
    const candidates = [];
    let person = null;
    if (pattern && (b.spocFirstName || b.spocName)) {
      const parts = lc(b.spocName || b.spocFirstName).split(' ');
      const cand = patternEngine(pattern, parts[0] || b.spocFirstName, parts[parts.length - 1] || '', domain);
      if (cand) { candidates.push(cand); person = { name: b.spocName || '', first: b.spocFirstName || '', title: '' }; }
    }
    const h = await peopleSearch(domain);
    if (h) {
      for (const p of h.people) { if (p.email && domainOfEmail(p.email) === domain && !ROLE_RANK.hasOwnProperty(localOf(p.email).split(/[._-]/)[0])) { candidates.push(p.email); person = person || { name: [p.first, p.last].filter(Boolean).map(cap).join(' '), first: cap(p.first), title: p.title }; } }
      if (!candidates.length && (h.pattern || pattern) && h.people[0]) { const p = h.people[0]; const cand = patternEngine(h.pattern || pattern, p.first, p.last, domain); if (cand) { candidates.push(cand); person = { name: [p.first, p.last].filter(Boolean).map(cap).join(' '), first: cap(p.first), title: p.title }; } }
    }
    if (!candidates.length) { stats.noEmail++; pushCompany(b, domain); toReview(b, 'no_email', domain); continue; }

    // 4. VERIFY (inferred only)
    const method = h ? h.provider : 'pattern';
    let placed = false;
    for (const cand of candidates) {
      if (!await mxSyntaxGate(cand)) continue;
      const status = await verifyEmail(cand);
      if (status === 'valid') { stats.verifiedValid++; pushCompany(b, domain); pushRecipient(b, cand, 'B_medium', method, person); placed = true; break; }
      if (status === 'catch_all' || status === 'no_budget') {
        stats.hold++; pushCompany(b, domain);
        contacts.push({ buyerKey: b.buyerKey, company: b.buyerName, domain, spocName: person ? person.name : '', title: person ? person.title : '', email: cand, emailType: person ? 'named' : 'role', verifyStatus: 'C_hold', source: method, foundAt: nowIso });
        toReview(b, `${status === 'no_budget' ? 'unverified' : 'catch_all'} (${cand})`, domain);
        placed = true; break;
      }
    }
    if (!placed) { stats.noEmail++; pushCompany(b, domain); toReview(b, 'all_invalid', domain); }
    await sleep(150);
  }

  return { recipients, review, companies, contacts, stats, budgets: { searchUsed, hunterUsed, apolloUsed, snovUsed, reoonUsed, zbUsed } };
};
