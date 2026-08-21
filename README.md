# TSA Sales Tracking + Invoicing

A single-page dashboard that replaces the Excel tracking sheet until Sales Team HQ is ready. Reps submit two forms (Log a Closed Deal, End of Day), and leadership sees a live dashboard: team leaderboard, per-client invoicing view, closed-deal log, and the core KPIs from Robb's master sheet (cash collected, contract value, close %, show rate, call-capacity utilization, cash-collected %).

Built to match the `[TEMPLATE] Sales Team Tracking Sheet` fields exactly: follow-up / new outreach, calls offered / set, call capacity, connected meetings, no shows, closed deals, contract value, cash collected, deposits, AOSi, Product B.

## What it is
- **One file:** `index.html`. No build step, no framework.
- **Two submission forms:** Closed Deal (submit at close) and End of Day (daily activity, closer or setter).
- **Dashboard:** filter by month / client / role. KPI cards, leaderboard, by-client invoicing table, closed-deals table.
- **Export:** closed deals CSV, end-of-day CSV, full JSON backup, JSON import.
- **Light access gate:** a submit code for reps and an admin code for leadership. This is a soft gate, not real security (the code ships in the page). Real logins come with HQ. Do not put anything you would not want a viewer to see in the code itself.

## Data: local vs shared
- **Default (works instantly):** data is saved in the browser (localStorage). Great for a single-machine demo. Each browser has its own copy.
- **Shared across the team (recommended for real use):** deploy the included Google Apps Script so all submissions land in one Google Sheet and every dashboard reads from it. See `apps-script/Code.gs` for the 5-minute setup, then paste the Web App URL into **Settings > Apps Script Web App URL**.

Either way you can export CSV for invoicing at any time.

## Deploy to GitHub Pages
1. Create a new repo named **TSAINVOICE** on GitHub.
2. Push these files to it:
   ```bash
   cd TSAINVOICE
   git init
   git add .
   git commit -m "TSA invoicing dashboard"
   git branch -M main
   git remote add origin https://github.com/<your-user>/TSAINVOICE.git
   git push -u origin main
   ```
3. On GitHub: **Settings > Pages > Build and deployment > Source: Deploy from a branch**, branch **main**, folder **/ (root)**, Save.
4. Wait ~1 minute. Your dashboard is live at `https://<your-user>.github.io/TSAINVOICE/`.

Note: GitHub Pages on a **public** repo is free. The repo holds only the app code (no client data), so public is fine. If you want the repo private, GitHub Pages on private repos needs a paid plan, or just keep the code public and keep the real data in the shared Google Sheet.

## First-run setup (in the app)
1. Open the site, enter the admin code (default `tsaboss`, change it in Settings).
2. Go to **Settings**: set your real clients, closers, setters, products, the monthly cash-collected goal, payout rates (closer 7 / setter 3), and change both access codes.
3. If you want shared data, deploy the Apps Script and paste its URL.
4. Hand the **submit code** to reps; keep the **admin code** for you, Robb, and Josh.

## Metric definitions
- **Cash collected %** = cash collected / contract value
- **Close %** = closed deals / connected meetings
- **Show rate** = connected meetings / (connected + no shows)
- **Call capacity used** = connected meetings / call capacity (utilization: low % means we need more calls, not more closers)
- **Est. payout** = cash collected x payout rate (closer 7% / setter 3%, editable in Settings)

## Roadmap (once HQ is stable)
- Feed HQ call reports into this same format via webhook, then retire the manual forms.
- Add speed-to-lead automatically from GHL (needs per-client GHL access; today it is an optional manual field).
