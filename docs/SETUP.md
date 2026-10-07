# Setup

The engine runs as a single scheduled [Activepieces](https://www.activepieces.com/)
flow whose logic lives in the `pipeline/` code steps.

## 1. Google Sheet

Create one spreadsheet with these tabs (row 1 = headers):

- **Leads** — source rows (trade data): `Buyer, Mail ID, Contact/Web, HS Code, Product Description, Origin, Country of Destination, Seller, Port of Origin, Date`
- **Found** — contact log: `buyerKey, company, domain, domainConfidence, spocName, title, email, emailType, verifyStatus, source, foundAt`
- **Outbox** — drafts to approve: `buyerKey, company, domain, to, spocName, emailType, subject, body, track, approved, status, queuedAt`
- **Sent** — send log: `buyerKey, company, to, subject, track, status, sentAt, testMode`
- **Review** — unresolved leads: `buyerName, domain, reason, at`

## 2. Connections (in Activepieces)

- **Google Sheets** — OAuth to the account that owns the sheet.
- **Gmail** — the sending mailbox (use a test inbox first).

## 3. Import the flow

Import `flows/activepieces-flow.json`. On each Google Sheets / Gmail step, select the
connection, spreadsheet, and tab (Activepieces imports never carry those over).

## 4. Fill the step inputs (all optional except the LLM key)

| Step | Input | Notes |
|---|---|---|
| `04-personalize` | `llmApiKey` | OpenAI-compatible endpoint key (required to generate copy) |
| `03-mail-finder` | `braveApiKey` / `serperApiKey` / `tavilyApiKey` / `searxngUrl` | domain search — any subset; blank falls back to Clearbit |
| `03-mail-finder` | `hunterApiKey` / `apolloApiKey` / `snovClientId`+`snovClientSecret` | people finders — optional |
| `03-mail-finder` | `reoonApiKey` / `zeroBounceApiKey` | email verification — optional |
| `02/07 CRM` | `crmBaseUrl` + `crmToken` | optional; blank skips CRM dedup/reporting |
| `06-approved-gate` | `testMode` + `testRecipient` | keep `testMode` on; every email redirects to `testRecipient` |

With **no** provider keys, the engine still runs on the free backbone
(search-resolve + website scrape + seed emails).

## 5. Test → go live

1. Put a few rows in **Leads**, run the flow. Check **Outbox** fills with drafts and
   **Found** / **Review** populate.
2. Mark a row `approved = yes`, run again → it sends to `testRecipient`, logs to
   **Sent**, and clears from **Outbox**.
3. Go live: switch the Gmail connection to the real sending mailbox, clear `testMode`,
   publish, and enable the schedule. Keep send caps low at first to warm the mailbox.
