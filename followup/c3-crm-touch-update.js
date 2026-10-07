/**
 * Activepieces Code piece — Service C, Stack C3: the CRM touch write-back.
 *
 * Runs inside the **C-send** flow, right after the follow-ups are sent. For each
 * contact just nudged it updates the the CRM Contact record so the next C-draft run
 * sees the new state: bumps the touch count and stamps the last-touch time. This is
 * what closes the loop — the CRM is Service C's source of truth, so without this the
 * same contacts would be re-drafted next run.
 *
 * In testMode nothing is written to the CRM (so a dry run leaves the CRM untouched),
 * unless writeInTestMode=true.
 *
 * Flow:  … Gmail Send -> Insert Followup-Sent -> THIS -> Loop(outboxDeletes)->Delete.
 *
 * INPUTS
 *   updates         = c2.touchUpdates  [{ the CRMId, to, touchNo, lastTouchAt, testMode }]
 *   the CRMAccessToken = {{connections['the CRM'].access_token}}   (required)
 *   apiDomain       = the CRM DC host (default https://www.the CRMapis.com)
 *   apiVersion      = default 'v2'
 *   touchCountField = default 'Touch_Count'
 *   lastTouchField  = default 'Last_Touch_At'
 *   writeInTestMode = default false (skip the CRM writes while testing)
 *
 * OUTPUT { updated, skipped, errors }
 */

export const code = async (inputs) => {
  const updates = Array.isArray(inputs.updates) ? inputs.updates : [];
  const token = String(inputs.the CRMAccessToken || '').trim();
  const apiDomain = String(inputs.apiDomain || 'https://www.the CRMapis.com').replace(/\/+$/, '');
  const apiVersion = String(inputs.apiVersion || 'v2').replace(/^\/+|\/+$/g, '');
  const F_TOUCH = String(inputs.touchCountField || 'Touch_Count');
  const F_LAST = String(inputs.lastTouchField || 'Last_Touch_At');
  const writeInTestMode = Boolean(inputs.writeInTestMode);

  if (!token) return { updated: 0, skipped: updates.length, errors: ['no the CRMAccessToken'] };

  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  const base = `${apiDomain}/crm/${apiVersion}/Contacts`;

  let updated = 0;
  let skipped = 0;
  const errors = [];

  for (const u of updates) {
    if (!writeInTestMode && String(u.testMode) === 'yes') { skipped++; continue; }
    const id = String(u.the CRMId || '').trim();
    if (!id) { skipped++; continue; } // no the CRM id — can't target the record

    const record = {};
    record[F_TOUCH] = Number(u.touchNo || 0);
    record[F_LAST] = u.lastTouchAt || new Date().toISOString();

    try {
      const r = await fetch(`${base}/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: {
          Authorization: 'the CRM-oauthtoken ' + token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ data: [record] }),
        signal: AbortSignal.timeout(20000),
      });
      const body = await r.json().catch(() => ({}));
      const ok = r.ok && body && Array.isArray(body.data) &&
        body.data[0] && body.data[0].code === 'SUCCESS';
      if (ok) updated++;
      else errors.push({ id, status: r.status, detail: body && body.data && body.data[0] });
    } catch (e) {
      errors.push({ id, error: String(e && e.message) });
    }
    await sleep(120); // stay under the CRM's per-second write budget
  }

  return { updated, skipped, errors };
};
