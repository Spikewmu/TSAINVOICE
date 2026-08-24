# TSA Sales Tracking + Invoicing

Interim sales-ops command center that replaces the Excel tracking sheet until Sales Team HQ is ready. Reps submit their numbers, leadership sees live KPIs, invoicing, client status, and onboarding progress, all from one page, shared across every computer.

**Live:** https://tsainvoice.vercel.app/ (also mirrored on GitHub Pages)

## What it does
- **Two submission forms**
  - **Log a Closed Deal** (submit at close: client, closer, setter, product, contract value, cash, deposit).
  - **End of Day** (daily activity, role-specific): setters log dials / appointments set / connected / no-shows / speed-to-lead; closers log call capacity + the closing numbers. Today's date auto-fills.
- **Dashboard** (filter by month / client / role): KPI cards, team leaderboard (setter cash attributed from the deal's "setter who set it" field), by-client invoicing table, closed-deals log.
- **Client Overview**: every client at a glance, status / manager / service line / existing monthly / cash collected this month / next step, plus active-count KPIs.
- **Onboarding**: a per-client launch checklist with % complete and the current bottleneck step, so you see where each client is stuck. Admins can reorder / rename / reassign / add / remove the steps for everyone.
- **Data + Export**: closed-deals CSV, end-of-day CSV, full JSON backup / import.
- **Automation** (optional, backend): every checklist step change and new client fires a Slack message with step-by-step routing, plus an optional generic outbound webhook.

Field set matches Robb's `[TEMPLATE] Sales Team Tracking Sheet` exactly.

## Accounts + roles
Each person logs in with their **own username + password** (Sign out is top-right). Accounts live in the shared Google Sheet (passwords stored only as salted SHA-256 hashes).

| Role | Sees |
|------|------|
| **Admin** | Everything: dashboard, client overview, onboarding (+ step editor), forms, data, users, settings |
| **Sales Manager** | Dashboard, Client Overview, Onboarding, Users (can create only closers/setters) |
| **Closer** | Log Closed Deal + closer End of Day (name locked in) |
| **Setter** | Setter End of Day only (name locked in) |

**Multi-admin, multi-computer:** account management is authorized by the caller's own logged-in account, so any admin manages users from any computer with zero per-browser setup. Create one account per admin (steve / robb / josh) and use those, not the shared master.

**Master admin (break-glass):** `tsaboss` + the master password (`ADMIN_PASS`) still works for emergency access, but prefer named accounts.

## Architecture
- **Frontend:** a single static `index.html` (no build, no framework), served by Vercel / GitHub Pages. The backend URL is baked in, so every browser auto-connects, nothing to configure per device.
- **Backend / database:** one Google Sheet driven by `apps-script/Code.gs` (a Web App). Chosen deliberately, this is an interim tool until HQ, so a throwaway-friendly, free, human-readable backend is the right call. If lag/quotas ever hurt before HQ, the swap target is Supabase (Postgres) which pairs with Vercel and works from the same static frontend.
- **Records model** (all in the sheet's `records` tab, one row per submission): `type` is `deal`, `eod`, `client`, `onboard` (checklist status), or `onbconfig` (the editable step order). `users` tab holds accounts.

## Backend setup (Google Apps Script)
1. Create a Google Sheet, copy its ID from the URL.
2. Sheet > **Extensions > Apps Script**, paste `apps-script/Code.gs`.
3. Set the constants at the top:
   - `SHEET_ID` = your sheet ID
   - `ADMIN_PASS` = master admin password (must match the app's Settings master password)
   - `MANAGER_PASS` = must match the app's `managerCode` (lets managers create closers/setters)
   - `SALT` = any phrase, **set once**, never change it (changing it invalidates every stored password)
   - `SLACK_WEBHOOK` = (optional) a Slack Incoming Webhook URL to turn on onboarding pings
   - `OUT_WEBHOOK` = (optional) a generic webhook (Zapier/Make/n8n) that receives every record
   - `SLACK_IDS` = (optional) `{ 'Keithen':'U123...' }` to `@`-ping owners by name
4. **Deploy > New deployment > Web app** (Execute as: Me, Who has access: Anyone). Copy the `/exec` URL.
5. The URL is baked into `index.html` (`DEFAULT_CFG.endpoint`). To point at a different backend, change that line and redeploy the site.
6. **After editing the script, always redeploy:** Deploy > Manage deployments > (edit) > Version: New version > Deploy. Just saving the code does not update the live Web App.

Two tabs auto-create on first use: `records` and `users`.

## Deploy the frontend (Vercel)
Push to the `TSAINVOICE` GitHub repo; Vercel is connected and auto-deploys on every push. GitHub Pages also serves it. Both read the same shared Google Sheet, so they show identical data. The repo holds only app code (no client data), so a public repo is fine.

To update: edit files, `git add . && git commit -m "..." && git push`.

## Automation (onboarding routing)
With `SLACK_WEBHOOK` set, the backend posts to Slack automatically:
- **Step change:** `Prime (Billy) — "Intake form completed" set to Done`. On **Done**, it adds `➡️ Next up: <next step> @owner`.
- **New client:** `🆕 New client: X (Onboarding) — manager Khadija`.

Still to wire (need external access): **HelloSign contract signed → welcome email** (Zapier), and **Airtable intake submitted → auto-populate the checklist** (Airtable automation posting `onboard` records to the backend). Once intake auto-populates, the Slack routing above carries the rest.

## Metric definitions
- **Cash collected %** = cash collected / contract value
- **Close %** = closed deals / connected meetings
- **Show rate** = connected meetings / (connected + no shows)
- **Call capacity used** = connected meetings / call capacity (low % = need more calls, not more closers)
- **Est. payout** = cash collected x payout rate (closer 7% / setter 3%, editable in Settings)

## Roadmap (toward HQ)
- Feed HQ call reports into this format via webhook, then retire the manual forms.
- Speed-to-lead automatically from GHL (needs per-client GHL access; today an optional manual field).
- Optional migration to Supabase if the Sheets backend hits latency/quota limits before HQ ships.
