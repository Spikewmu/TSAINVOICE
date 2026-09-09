-- Archive (soft-deactivate) users: adds an `archived` flag to the users table.
-- Archived users keep their account + all their data, but cannot sign in and are
-- hidden from the active roster, manager pickers, assignment dropdowns, login
-- reminders and onboarding lists. Un-archiving reverses it. See api/auth.js
-- (login block + archiveUser/unarchiveUser actions) and index.html (Archive button).
--
-- Run once in the Supabase SQL editor.

alter table users add column if not exists archived boolean not null default false;
