# TSA Slack Bot — setup

A single Slack app (`/tsa` slash command) installed into each client's Slack workspace. It answers with **only that client's** data. The wall is the `slack_workspaces` table: each workspace's `team_id` maps to exactly one client, and every query is hard-filtered to that client. An unmapped workspace gets nothing.

Backend: `api/tsa-bot.js` (Vercel serverless function). Data: Supabase.

---

## 1. Add the mapping table (Supabase → SQL Editor)

```sql
create table if not exists public.slack_workspaces (
  team_id    text primary key,
  client     text not null,          -- must match the client name exactly as it appears in the dashboard
  note       text,
  created_at timestamptz default now()
);

-- RLS on, NO anon policies: the publishable key can't read the map.
-- Only the service_role key (used server-side by the bot) can.
alter table public.slack_workspaces enable row level security;
```

## 2. Env vars (Vercel → Project → Settings → Environment Variables)

| Name | Value | Where to get it |
|------|-------|-----------------|
| `SLACK_SIGNING_SECRET` | the app's signing secret | Slack app → Basic Information → App Credentials |
| `SUPABASE_URL` | `https://wiwmogfurmdwrjndsuct.supabase.co` | Supabase → Settings → API |
| `SUPABASE_SERVICE_KEY` | the **service_role** key | Supabase → Settings → API (keep secret; server-side only) |
| `BOT_ADMIN_TOKEN` | any long random string you make up | you choose it; it unlocks the in-dashboard linking screen |

Redeploy after adding them.

## 3. Create the Slack app

1. https://api.slack.com/apps → **Create New App** → From scratch.
2. **Slash Commands** → Create New Command:
   - Command: `/tsa`
   - Request URL: `https://tsainvoice.vercel.app/api/tsa-bot`
   - Short description: "TSA status for this client"
3. **OAuth & Permissions** → Bot Token Scopes → add `commands` (that's all a slash command needs).
4. **Manage Distribution** → activate public distribution (so it can be installed into more than one workspace).

## 4. Install into each client workspace

Use the app's **Install / Share** link once per client workspace (each client's Slack admin approves it). This is how it lands in DAB's Slack, Prime's Slack, etc.

## 5. Link each workspace to its client (the isolation step)

You need each workspace's `team_id`. After installing, run `/tsa status` in that workspace — the bot replies that the workspace isn't linked **and prints its `team_id`**.

**Easiest way (no SQL): the dashboard.** Sign in as admin → **Settings → Slack bot - workspace linking**. Paste your `BOT_ADMIN_TOKEN` once to unlock it, then add the `team_id`, pick the client from the dropdown, and click **Link**. Unlink or re-point any workspace from the same table. Only an admin (Settings is admin-only) with the token can touch this.

**Or by SQL** if you prefer:

```sql
insert into public.slack_workspaces (team_id, client, note) values
  ('T0PRIME123', 'Prime (Billy)', 'Prime / Billy workspace'),
  ('T0DAB456',   'DAB',           'DAB workspace');
```

The `client` value **must match the dashboard client name exactly** (check Client Overview). Current names: `Prime (Billy)`, `Social Revelation (Ryan)`, `MSP`, `DAB`, `Eight-Figure Sales`. To re-point a workspace, update its row.

## 6. Commands

- `/tsa status` — onboarding progress, what's overdue, what's next
- `/tsa numbers` — this month's closed deals + cash
- `/tsa help`

All replies are **ephemeral** (only the person who typed the command sees them).

---

## Security notes

- Every request is verified against `SLACK_SIGNING_SECRET` (rejects anything not signed by Slack, and replays older than 5 min).
- `team_id → client` is resolved server-side on every call; **there is no code path that returns another client's data**. Unmapped workspace → "not linked," nothing else.
- The `slack_workspaces` map and the service key never reach the browser.
- To add data to a command later, keep the same rule: every Supabase query filters on the resolved `client`.
