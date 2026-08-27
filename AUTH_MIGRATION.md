# Auth migration — Apps Script → Vercel + Supabase

Moves logins and user management off Google Apps Script onto `api/auth.js` (Vercel) + a Supabase `users` table. **Nobody has to reset a password.** Existing users keep their passwords: on first login the new backend validates them against the old Apps Script one last time, stores the hash, and never needs Apps Script for that user again.

At every stage login still works — if the new backend is unreachable or unconfigured, the app falls back to the old Apps Script login, and `tsaboss` master always works.

---

## Step 1 — create the users table (Supabase → SQL Editor)

```sql
create table if not exists public.users (
  username   text primary key,
  name       text,
  role       text,          -- admin | manager | closer | setter | founder
  pass_hash  text,          -- set automatically on first login; null until migrated
  created_at timestamptz default now()
);

-- RLS on, NO anon policies: only the service key (server-side /api/auth) touches it.
alter table public.users enable row level security;
```

## Step 2 — Vercel env vars (Project → Settings → Environment Variables), then redeploy

| Name | Value |
|------|-------|
| `SUPABASE_URL` | `https://wiwmogfurmdwrjndsuct.supabase.co` |
| `SUPABASE_SERVICE_KEY` | Supabase → Settings → API → **service_role** key |
| `SUPABASE_ANON_KEY` | the **publishable** key (`sb_publishable_...`) — returned to the browser for reading records |
| `AUTH_PEPPER` | a long random string (mixed into password hashes) |
| `SESSION_SECRET` | a long random string (signs login tokens) |
| `MASTER_USER` | `tsaboss` |
| `MASTER_PASS` | the current master admin password |
| `APPS_SCRIPT_URL` | the existing Apps Script `/exec` URL (used only to migrate un-migrated users) |

## Step 3 — cut over

1. Redeploy after setting the env vars.
2. Sign in as admin (your account migrates on first login; `tsaboss` also works).
3. **Users tab → "Import from old backend"** once. This copies every account (name + role, no password) into Supabase so the rep dropdowns are complete immediately. Passwords still migrate lazily on each person's next login.
4. That's it — everyone keeps logging in as normal. Watch the `users` table fill in `pass_hash` as people sign in.

## Step 4 — retire Apps Script (after everyone has logged in once)

Once every active user has a `pass_hash` (they've each logged in once under the new system), Apps Script is no longer used for login. To fully remove it, do a follow-up change that drops the Apps Script fallback in `tryGate` / `loadUsers` and clears `DEFAULT_CFG.endpoint`. Keep it around a week or two as a safety net first.

---

## How it works

- **Login** (`/api/auth` action `login`): checks Supabase `users`. If the user has a `pass_hash`, verify it. If not (missing or newly imported), proxy to Apps Script; on success store `pass_hash` and return a signed session token + the Supabase read key.
- **Session** = a short signed token (HMAC over username/role/exp with `SESSION_SECRET`). No password is stored in the browser for the new path.
- **User management** (`listUsers`, `saveUser`, `deleteUser`, `importUsers`) all run through `/api/auth` with the token; create/delete require an admin token.
- **Isolation of secrets:** the service key, pepper, and session secret live only in Vercel env vars, never in the client.
