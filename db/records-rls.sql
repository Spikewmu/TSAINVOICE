-- STEP 4 (the lock): stop the shared anon key from reading across workspaces.
-- Run this in Supabase SQL Editor ONLY AFTER confirming the live app loads through /api/data
-- (i.e. reads are server-scoped). Until then, leave it off so nothing breaks.
--
-- After this: the client can still APPEND records (writes stay client-side, append-only), but it
-- can no longer SELECT the table directly - all reads must go through /api/data (service key,
-- which bypasses RLS and returns only the caller's workspace). This is what makes tenant isolation real.

alter table records enable row level security;

-- keep the app able to append new records
drop policy if exists records_anon_insert on records;
create policy records_anon_insert on records for insert to anon with check (true);

-- (Deliberately no anon SELECT / UPDATE / DELETE policy: with RLS on, the anon key can read nothing.
--  The service_role key used by the API bypasses RLS.)
--
-- Later hardening (when onboarding outside customers): route writes through the server too, so a
-- workspace can only insert rows stamped with its own ws.
