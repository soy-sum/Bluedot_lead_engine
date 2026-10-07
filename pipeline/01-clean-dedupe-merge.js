/**
 * Activepieces Code piece — Stack 1: Clean, Normalize, Resolve Buyers.
 *
 * Flow position:  Google Sheets (Get Rows)  ->  THIS Code step  ->  enrichment.
 *
 * INPUT  (define one input named `rows` in the Code piece UI, mapped to the
 *         Google Sheets action output — an array of row objects keyed by the
 *         sheet's column headers).
 *
 * OUTPUT { uniqueBuyers: [...], stats: {...} }
 *         One record per real-world buyer company, with every email / contact /
 *         domain / HS code / product seen across that buyer's rows merged in,
 *         and a `needsEnrichment` flag telling the next stack whether we still
 *         have to hunt for an email.
 */

export const code = async (inputs) => {
  // Normalize whatever "Get all rows" hands us into header-keyed row objects.
  // Handles: bare array; {rows|values|body:[...]}; rows nested under `values`;
  // and the column-LETTER shape ({A,B,C...} with row 1 as the header).
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
  let rows = normSheet(inputs.rows);

  // ---- helpers -----------------------------------------------------------

  const clean = (v) =>
    (v === null || v === undefined ? '' : String(v))
      .replace(/\s+/g, ' ')
      .trim();

  // Free mailbox providers — a domain from one of these is NOT a company domain.
  const FREE_MAIL = new Set([
    'gmail.com', 'yahoo.com', 'yahoo.co.in', 'hotmail.com', 'outlook.com',
    'live.com', 'aol.com', 'icloud.com', 'rediffmail.com', 'ymail.com',
    'protonmail.com', 'gmx.com', 'mail.com', 'qq.com', '163.com', '126.com',
  ]);

  // Legal suffixes / noise stripped ONLY to build the dedupe key.
  const LEGAL = [
    'private limited', 'pvt ltd', 'pvt. ltd.', 'pvt', 'private', 'limited',
    'ltd', 'llp', 'llc', 'inc', 'incorporated', 'corp', 'corporation',
    'company', 'co', 'gmbh', 'ag', 'bv', 'nv', 'sa', 'srl', 'spa', 'pte',
    'pte ltd', 'sdn bhd', 'sdn', 'bhd', 'plc', 'kg', 'oy', 'as', 'sas',
    'the', 'and', '&',
  ];

  const EMAIL_RE = /[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/gi;
  const URL_RE = /((https?:\/\/)?(www\.)?)([a-z0-9\-]+\.)+[a-z]{2,}(\/[^\s,;]*)?/gi;

  // Ocean-carrier / customs boilerplate that shows up in Product Description and
  // is pure noise for personalization. Anything from these markers on is dropped.
  const BOILERPLATE_RE =
    /(please note[\s-]+quantity|cargo are based on the shipper|ocean carrier has no knowledge|shipper'?s load and co).*$/is;

  // Pull a human-readable product label out of the messy description:
  //  - prefer the SHIPPER_DESCRIPTION(...) or HSCD_DESCRIPTION(...) parenthetical
  //  - strip trailing carrier boilerplate
  //  - drop stray commas that sit mid-word from the broken CSV export
  const productLabel = (desc) => {
    let s = clean(desc);
    const paren =
      s.match(/SHIPPER_DESCRIPTION\s*\(([^)]+)\)/i) ||
      s.match(/HSCD_DESCRIPTION\s*\(([^)]+)\)/i);
    if (paren) s = paren[1];
    s = s.replace(BOILERPLATE_RE, '');
    // strip trade-data noise: HS/HTS codes, PO numbers, "this shipment"
    s = s.replace(/\b(HS(CD)?|HTS)\s*(CODE)?\s*[:#]?\s*\d[\d.]*/ig, ' ');
    s = s.replace(/\bPO\s*#?\s*[:#]?\s*[A-Z0-9]+/ig, ' ');
    s = s.replace(/\bthis shipment\b/ig, ' ');
    s = s.replace(/,(?=\S)/g, ' ');   // ", " left alone, ",X" -> " X"
    s = s.replace(/\s+/g, ' ').trim().replace(/[,\-]+$/, '').trim();
    return s.slice(0, 120);
  };

  // First 6 digits group HS codes into one product family (482370 == 48237010).
  const hsFamily = (code) => clean(code).replace(/\D/g, '').slice(0, 6);

  const dedupeKey = (name) => {
    let k = clean(name).toLowerCase();
    k = k.replace(/[.,/#!$%^*;:{}=\-_`~()@'"]/g, ' '); // punctuation -> space
    k = k.replace(/\s+/g, ' ').trim();
    // strip legal suffix words (whole words only)
    const parts = k.split(' ').filter((w) => w && !LEGAL.includes(w));
    return parts.join(' ').trim();
  };

  const extractEmails = (text) => {
    const found = clean(text).toLowerCase().match(EMAIL_RE) || [];
    return found.map((e) => e.trim());
  };

  const domainOfEmail = (email) => {
    const m = String(email).toLowerCase().match(/@([a-z0-9.\-]+\.[a-z]{2,})$/);
    return m ? m[1] : '';
  };

  const extractDomain = (contactWeb, emails) => {
    // 1) prefer an explicit website in Contact/Web
    const urls = clean(contactWeb).toLowerCase().match(URL_RE) || [];
    for (const u of urls) {
      const host = u
        .replace(/^https?:\/\//, '')
        .replace(/^www\./, '')
        .split('/')[0]
        .trim();
      if (host && host.includes('.') && !host.includes('@')) return host;
    }
    // 2) otherwise derive from a non-free company email
    for (const e of emails) {
      const d = domainOfEmail(e);
      if (d && !FREE_MAIL.has(d)) return d;
    }
    return '';
  };

  const phoneOf = (text) => {
    const m = clean(text).match(/\+?\d[\d\s\-()]{6,}\d/);
    return m ? m[0].trim() : '';
  };

  const addUniq = (arr, val) => {
    const v = clean(val);
    if (v && !arr.some((x) => x.toLowerCase() === v.toLowerCase())) arr.push(v);
  };

  // Role/department mailboxes that are NOT a person's name.
  const ROLE_LOCALS = new Set(['info', 'sales', 'contact', 'hello', 'admin',
    'office', 'support', 'enquiry', 'enquiries', 'inquiry', 'orders', 'order',
    'purchasing', 'purchase', 'procurement', 'sourcing', 'buyer', 'import',
    'imports', 'export', 'exports', 'accounts', 'finance', 'mail', 'general',
    'marketing', 'team', 'customerservice', 'service', 'help', 'reception']);
  const cap = (s) => s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : '';

  // Derive a person's name from a personal-looking email local-part.
  // "priya.sharma@acme.com" -> {name:'Priya Sharma', first:'Priya'}; role
  // inboxes and gibberish return null so we never greet a fake name.
  const nameFromEmail = (email) => {
    const local = String(email || '').toLowerCase().split('@')[0]
      .replace(/\d+/g, '').replace(/[._-]+/g, '.').replace(/^\.|\.$/g, '');
    if (!local || ROLE_LOCALS.has(local)) return null;
    const parts = local.split('.').filter(Boolean);
    if (parts.length >= 2 && parts.every((p) => p.length >= 2)) {
      return { name: parts.map(cap).join(' '), first: cap(parts[0]) };
    }
    // single token: only trust it as a first name if it's alphabetic & 3-12 chars
    if (parts.length === 1 && /^[a-z]{3,12}$/.test(parts[0]) && !ROLE_LOCALS.has(parts[0])) {
      return { name: cap(parts[0]), first: cap(parts[0]) };
    }
    return null;
  };

  // ---- fold rows into unique buyers -------------------------------------

  const buyers = new Map();
  let skipped = 0;

  for (const raw0 of rows) {
    // some Sheets versions nest the columns under `values`
    const raw = (raw0 && typeof raw0.values === 'object' && raw0.values)
      ? raw0.values : (raw0 || {});
    const buyerName = clean(raw['Buyer']);
    if (!buyerName) { skipped++; continue; }

    const key = dedupeKey(buyerName);
    if (!key) { skipped++; continue; }

    const mailField = clean(raw['Mail ID']);
    const contactField = clean(raw['Contact/Web']);
    const emails = [
      ...extractEmails(mailField),
      ...extractEmails(contactField),
    ].filter((e) => !FREE_MAIL.has(domainOfEmail(e)) || true); // keep all, flag later

    if (!buyers.has(key)) {
      buyers.set(key, {
        buyerKey: key,
        buyerName,               // display name (longest seen wins below)
        domain: '',
        emails: [],
        freeEmails: [],          // gmail/yahoo etc. — usable but low-trust
        phones: [],
        websites: [],
        hsCodes: [],
        hsFamilies: [],
        products: [],
        productLabels: [],
        origins: [],
        destinations: [],
        ports: [],
        sellers: [],
        assignedTo: [],
        shipmentCount: 0,
        lastDate: '',
        contactName: '',
      });
    }
    const b = buyers.get(key);

    // longest / most complete original name as the display name
    if (buyerName.length > b.buyerName.length) b.buyerName = buyerName;

    for (const e of emails) {
      if (FREE_MAIL.has(domainOfEmail(e))) addUniq(b.freeEmails, e);
      else addUniq(b.emails, e);
    }

    const ph = phoneOf(contactField);
    if (ph) addUniq(b.phones, ph);

    // researched contact name (from the coworker research sheet), if present
    const cn = clean(raw['Contact Name']);
    if (cn && !b.contactName) b.contactName = cn;

    const dom = extractDomain(contactField, emails);
    if (dom && !b.domain) b.domain = dom;
    if (dom) addUniq(b.websites, dom);

    addUniq(b.hsCodes, raw['HS Code']);
    addUniq(b.hsFamilies, hsFamily(raw['HS Code']));
    addUniq(b.products, raw['Product Description']);
    addUniq(b.productLabels, productLabel(raw['Product Description']));
    addUniq(b.origins, raw['Origin']);
    addUniq(b.destinations, raw['Country of Destination'] || raw['Destination']);
    addUniq(b.ports, raw['Port of Origin']);
    addUniq(b.sellers, raw['Seller']);
    addUniq(b.assignedTo, raw['Assigned To']);
    b.shipmentCount += 1;

    const d = clean(raw['Date']);
    if (d && d > b.lastDate) b.lastDate = d;
  }

  // ---- finalize ----------------------------------------------------------

  const uniqueBuyers = [...buyers.values()].map((b) => {
    const hasCompanyEmail = b.emails.length > 0;
    const hasAnyEmail = hasCompanyEmail || b.freeEmails.length > 0;

    // Pull a SPOC name from any personal-looking email the sheet already had.
    let spoc = null;
    let spocEmail = '';
    for (const e of [...b.emails, ...b.freeEmails]) {
      const n = nameFromEmail(e);
      if (n) { spoc = n; spocEmail = e; break; }
    }

    // A researched Contact Name from the sheet wins — greet that real person
    // even though the address may be a role inbox (contact@, sales@).
    if (b.contactName) {
      const parts = String(b.contactName).trim().split(/\s+/);
      spoc = { name: b.contactName, first: cap(parts[0]) };
      spocEmail = b.emails[0] || b.freeEmails[0] || spocEmail;
    }

    return {
      ...b,
      // prefer a named personal email as the primary contact when we have one
      primaryEmail: spocEmail || b.emails[0] || b.freeEmails[0] || '',
      spocName: spoc ? spoc.name : '',
      spocFirstName: spoc ? spoc.first : '',
      spocEmail,
      // Skip the (rate-limited) email finder when we already have a company email.
      needsEnrichment: !hasCompanyEmail,
      hasAnyEmail,
    };
  });

  // Most active buyers first — spend scarce free finder credits on these.
  uniqueBuyers.sort((a, b) => b.shipmentCount - a.shipmentCount);

  return {
    uniqueBuyers,
    stats: {
      inputRows: rows.length,
      skippedNoBuyer: skipped,
      uniqueBuyers: uniqueBuyers.length,
      alreadyHaveCompanyEmail: uniqueBuyers.filter((b) => !b.needsEnrichment).length,
      needEnrichment: uniqueBuyers.filter((b) => b.needsEnrichment).length,
    },
  };
};
