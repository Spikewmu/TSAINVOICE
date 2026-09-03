-- STEP 5 (the write lock): stop the shared anon key from writing to `records` directly.
-- Run this ONLY AFTER confirming writes go through /api/data (action=write) in production
-- (submit an End of Day / deal and see it appear). Until then, leave it - the app still has a
-- direct-write fallback that this policy would remove.
--
-- After this: the anon key can neither read nor write `records`. ALL writes go through /api/data,
-- which stamps the caller's workspace server-side, so a client can never write into another
-- workspace's data. The service_role key (server) still bypasses RLS.

drop policy if exists records_anon_insert on records;
-- (no anon insert policy remains -> anon cannot INSERT; combined with the read lock, anon has no
--  access to `records` at all. Everything flows through the server.)
