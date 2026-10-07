/**
 * Code piece — Personalize (per recipient), loopless-at-flow-level.
 *
 * Runs over the flat `recipients` list (one row per person) and writes a
 * subject + body for each. Ling via OpenRouter by default.
 *
 * PROMPT IS EDITABLE FROM THE STEP INPUTS — the four fields below are the whole
 * pitch, so you can tune copy in the Activepieces UI without touching code.
 * Buyer-specific facts (company, product, greeting, China hook, track) are
 * filled in by the code; your text is used verbatim around them.
 *   systemPrompt  — the persona + rules (voice, length, "return JSON")
 *   pitchUS       — the angle for US importers
 *   pitchROW      — the angle for non-US importers
 *   companyBlurb  — the "about Acme" facts block
 * Placeholders you may use inside any of the four: {senderName}, {greeting},
 * {company}, {product}, {chinaHook}, {catalogUrl}.
 *
 * INPUT  recipients = assemble.recipients
 *        llmApiKey [required], model, llmBaseUrl, jsonMode,
 *        senderName, catalogUrl, systemPrompt, pitchUS, pitchROW, companyBlurb,
 *        maxToWrite (default 40), delayMs (default 900)
 * OUTPUT { emails:[{buyerKey,company,to,spocName,subject,body,track,domain,emailType}], stats }
 */

export const code = async (inputs) => {
  const recipients = Array.isArray(inputs.recipients) ? inputs.recipients : [];
  const apiKey = inputs.llmApiKey || inputs.openRouterApiKey || inputs.groqApiKey;
  const model = inputs.model || 'inclusionai/ling-3.0-flash';
  const baseUrl = inputs.llmBaseUrl || 'https://openrouter.ai/api/v1/chat/completions';
  const jsonMode = inputs.jsonMode === true;
  const senderName = inputs.senderName || 'the sender';
  const catalogUrl = inputs.catalogUrl || '';
  const maxToWrite = Number(inputs.maxToWrite) > 0 ? Number(inputs.maxToWrite) : 40;
  const delayMs = Number(inputs.delayMs) >= 0 ? Number(inputs.delayMs) : 900;

  // ---- editable copy (defaults; override any from the step inputs) --------
  const systemPrompt = inputs.systemPrompt ||
    `You are {senderName}, founder of Acme Exports. You write short, direct ` +
    `B2B cold outreach to importers of disposable foodservice tableware. Plain, ` +
    `human, no fluff, 90-140 words. Never invent facts about the recipient. The ` +
    `email MUST open with exactly "{greeting}" and must NOT greet them by company ` +
    `name. Return ONLY valid JSON: {"subject":"...","body":"..."}. No signature ` +
    `block. One clear CTA.`;
  const pitchUS = inputs.pitchUS ||
    `US importer. If they currently source from China (chinaHook={chinaHook}), lead ` +
    `with the China-tariff angle: rising US tariffs raise landed cost; India is a ` +
    `reliable alternative with lower overall landed cost, faster turnarounds, quicker shipments.`;
  const pitchROW = inputs.pitchROW ||
    `Non-US importer. Angle: diversify sourcing from India — competitive Ex-factory ` +
    `and FOB pricing, a consistent supply chain, optimised landed cost and inventory.`;
  const companyBlurb = inputs.companyBlurb ||
    `Acme Exports supplies compostable sugarcane bagasse tableware (HS 4823.70). ` +
    `Range: 100+ SKUs — plates, bowls, clamshells, cups, containers, egg cartons. ` +
    `Capacity 15 tons/day. Certified quality, maintained weight/thickness for high ` +
    `durability and oil & grease resistance (OGR).`;

  const norm = (s) => String(s || '').toLowerCase();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const parseJson = (s) => {
    let t = String(s || '').trim();
    const m = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (m) t = m[1].trim();
    return JSON.parse(t);
  };
  const roleGreeting = (email) => {
    const local = norm(email).split('@')[0];
    if (/purchas|procure|sourc|buyer/.test(local)) return 'Hi Procurement Team,';
    if (/import|order/.test(local)) return 'Hi Purchasing Team,';
    if (/sales/.test(local)) return 'Hi Sales Team,';
    return 'Hi Team,';
  };
  const fill = (tpl, v) => String(tpl).replace(/\{(\w+)\}/g, (_, k) => (k in v ? v[k] : `{${k}}`));

  const writeOne = async (r) => {
    const dest = norm((r.destinations && r.destinations[0]) || r.country || '');
    const isUS = /united states|usa|u\.s|america/.test(dest);
    const track = isUS ? 'US' : 'ROW';
    const greeting = (r.emailType === 'named' && r.spocFirstName)
      ? `Hi ${r.spocFirstName},` : roleGreeting(r.to);
    const sourceText = norm([].concat(r.origins || [], r.sellers || []).join(' '));
    const chinaHook = /china|chinese|zhejiang|guangzhou|shenzhen|ningbo|shanghai|fujian|xiamen/.test(sourceText);
    const product = (r.productLabels && r.productLabels[0]) || (r.products && r.products[0])
      || 'bagasse / molded-fiber tableware';

    const vars = { senderName, greeting, company: r.company, product, chinaHook, catalogUrl };
    const system = fill(systemPrompt, vars);
    const user =
      `Write a personalized cold email.\nRecipient company: ${r.company}\n` +
      `They import: ${product}\nCurrently sourcing from China: ${chinaHook}\n` +
      `Track brief: ${fill(isUS ? pitchUS : pitchROW, vars)}\n` +
      `About us: ${fill(companyBlurb, vars)}\n` +
      (catalogUrl ? `Mention a product catalogue is attached.\n` : '') +
      `CTA: ask for a quick call on SKUs, samples and landed pricing (US) or which ` +
      `SKUs interest them for an Ex-factory/FOB quote (non-US).`;

    const payload = { model, temperature: 0.6,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }] };
    if (jsonMode) payload.response_format = { type: 'json_object' };
    const headers = { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' };
    if (inputs.appUrl) headers['HTTP-Referer'] = String(inputs.appUrl);
    if (inputs.appName) headers['X-Title'] = String(inputs.appName);
    const res = await fetch(baseUrl, { method: 'POST', headers,
      body: JSON.stringify(payload), signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + (await res.text().catch(() => '')).slice(0, 200));
    const j = await res.json();
    const content = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    if (!content) throw new Error('no content');
    const p = parseJson(content);
    const signature = `\n\n${senderName}\nFounder, Acme Exports`
      + (catalogUrl ? `\nProduct catalogue: ${catalogUrl}` : '');
    return {
      buyerKey: r.buyerKey, company: r.company, to: r.to, spocName: r.spocName || '',
      domain: r.domain || '', emailType: r.emailType, track,
      subject: String(p.subject || '').trim(),
      body: String(p.body || '').trim() + signature,
    };
  };

  const emails = [];
  const errors = [];
  const stats = { input: recipients.length, written: 0, failed: 0 };
  for (const r of recipients.slice(0, maxToWrite)) {
    try {
      const e = await writeOne(r);
      if (e.subject && e.body) { emails.push(e); stats.written++; }
      else { stats.failed++; if (errors.length < 3) errors.push('empty subject/body'); }
    } catch (err) { stats.failed++; if (errors.length < 3) errors.push(String(err && err.message)); }
    if (delayMs) await sleep(delayMs);
  }
  stats.errors = errors;
  return { emails, stats };
};
