# Service C — Follow-ups Runbook

Follows up with contacts Service A mailed who **haven't replied**, at an escalating
cadence, with a human approval gate — the same draft → approve → send shape as
Service A, split into two webhook-triggered Activepieces flows:

- **C-draft** (`flow-C-phase1-draft.json`) — pulls mailed contacts from **the CRM**, finds who's due a follow-up (touch count < schedule, not replied, gap
  elapsed), writes a personalised draft per contact to the **Followup-Outbox**
  sheet, then `POST /handoff` to unlock the C-send button.
- **C-send** (`flow-C-phase2-send.json`) — reads Followup-Outbox, sends only the
  rows you marked `approved`, logs each to the separate **Followup-Sent** sheet,
  writes the new touch count back to the CRM, then **deletes the sent rows** from the
  Outbox (clean-up).

You approve in between by editing the **Followup-Outbox** tab.

---

## ⚠️ Read this first — two things you own, not me

The instructions referenced `deploy/ACTIVEPIECES.md` (steps A6/C5), `server.py
--check`, a `/handoff` endpoint, and Railway webhook variables. **None of that
exists in this repo** — it lives in your separate CRM/control-plane service
(`https://your-crm.example.com`). So:

1. **The `/handoff` contract is a placeholder.** The C5 step posts
   `{ service:'C', button:'C-send', staged:<n>, batch, ready:true }` with a bearer
   token to `{crmBaseUrl}/handoff`. If your real endpoint expects a different path,
   payload, or button id, fix the `handoff` code step's inputs/body to match your
   `deploy/ACTIVEPIECES.md`. Until `crmToken` is set on that step, handoff is
   skipped and the C-send button stays locked (by design).
2. **The two webhook variables are yours to set.** After importing, each flow shows
   a webhook URL. Put them in Railway on the CRM service so its buttons can trigger
   the flows — e.g. `AP_WEBHOOK_C_DRAFT` and `AP_WEBHOOK_C_SEND` (use whatever names
   `server.py --check` already looks for). Then `railway restart --yes` and
   `python3 server.py --check`.

## Data source — the CRM (as you asked)

C-draft reads contacts **straight from the CRM** (`GET /crm/v2/Contacts`, paged). But
Service A writes the CRM **identity-only** (name + email), so the follow-up state has
to live in three Contact fields that C3 keeps updated. **Create these once** (the CRM
→ Settings → Modules → Contacts → new fields), or map existing ones via the
`*Field` inputs on C1/C3:

| Purpose | Default field API name | Type |
|---|---|---|
| touches sent so far | `Touch_Count` | Number |
| when the last touch went | `Last_Touch_At` | Date/Time |
| reply / opt-out state (stops follow-ups) | `Follow_Up_Status` | Text/Picklist |

A contact is followed up while `Touch_Count < 4` and `Follow_Up_Status` is **not**
one of `replied / bounced / unsubscribed / closed / opted_out`. Your reply handler
(the existing 04c reply flow) must set `Follow_Up_Status = replied` in the CRM so the
loop stops — otherwise C keeps nudging people who answered.

> First touch: for the day-4 clock to work, Service A's send should stamp
> `Last_Touch_At` (and `Touch_Count = 1`) on the contact. If it doesn't yet, a
> contact with no `Last_Touch_At` is treated as **immediately due** for touch #1.

## Google Sheet — two new tabs (row 1 = headers, exact spelling)

- **Followup-Outbox**: `touchNo, contact, client, country, to, subject, body,
  approved, status, the CRMId, buyerKey, queuedAt`
- **Followup-Sent**: `touchNo, contact, client, country, to, subject, status,
  sentAt, the CRMId, buyerKey, testMode`

## Cadence

Days after the previous touch that each follow-up is due: **4 / 7 / 14 / 30**
(`followupSchedule` input on C1), max **4** follow-ups. Escalating, low-pressure
copy; the touch-3 note adds a China-tariff line for US contacts. Change the copy in
`c1-followup-scan.js` (`followupBody`).

---

## Import + wire

1. Flows → **+** → **Import from file** → import both `flow-C-phase*.json`.
2. **Connections:** add/confirm a **the CRM OAuth2** connection named `the CRM`
   (scopes `the CRMCRM.modules.contacts.ALL`) and your **Google Sheets** + **Gmail**
   connections. Set `apiDomain` on C1/C3 to your DC (`.in`, `.eu`, …) if not `.com`.
3. On every node with a warning, pick the spreadsheet + tab and re-select the
   action. `Get rows: Followup-Outbox` must return each row's number (default).
4. **C1 inputs:** confirm the three the CRM field names, `senderName`, `catalogUrl`.
5. **C5 handoff inputs:** `crmBaseUrl`, `crmToken` (= CRM_API_TOKEN), `button`.
6. **C2 inputs:** `testMode = true`, `testRecipient = your inbox` for now.
7. Copy each flow's **webhook URL** into Railway (step 2 above), restart, `--check`.

## Test → live

1. `testMode = true`, `testRecipient` = your inbox on **C2**;
   `writeInTestMode = false` on **C3** (the CRM stays untouched during the dry run).
2. Trigger **C-draft** (hit its webhook, or Test flow). Check: Followup-Outbox
   fills with drafts, correct `touchNo`, unreplied contacts only, handoff returns
   2xx (button unlocks).
3. In **Followup-Outbox**, edit copy if you like, put `yes` in `approved`.
4. Trigger **C-send**. Check: mail lands in **your** inbox tagged
   `[TEST → real@…]`, a **Followup-Sent** row is written, the Outbox row is
   **deleted**, and (since testMode) **the CRM is not written**.
5. Go live: switch Gmail to `sender@your-company.example.com`, set `testMode` empty on
   C2, `writeInTestMode` stays false but real sends now write the CRM (testMode flag
   on each row is `no`), confirm real `crmToken`. Keep `maxPerRun` low at first.

## Notes / limits

- **Clean-up deletes bottom-up.** C2 returns `outboxDeletes` sorted by row number
  descending so deleting one row never renumbers a pending one. Don't reorder that
  loop.
- **No `buyerKey` dedup against Sent here** — the Outbox row is deleted on send and
  the CRM's `Touch_Count` is the guard against re-drafting, so a contact can't be
  double-sent within a run. Cross-run safety is the the CRM touch count.
- Same zero-cost, templated personalisation as Service A's `04b` — no LLM key
  needed. Swap in an LLM step in C-draft if you want per-contact generation.
