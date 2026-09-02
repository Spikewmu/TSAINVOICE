-- Private candidate-messaging table for /api/messages + /api/twilio-inbound.
-- Run this once in the Supabase SQL editor (Dashboard -> SQL Editor -> New query -> Run).
--
-- IMPORTANT: RLS is enabled with NO policies, so the public/anon key (which the dashboard uses to
-- read the shared `records` table) can read NOTHING here. Only the SERVICE key (used server-side by
-- the API routes) bypasses RLS. That is what keeps message content + candidate contact info private.

create table if not exists messages (
  id          uuid primary key default gen_random_uuid(),
  cand_id     text not null,          -- Airtable candidate record id
  owner       text,                   -- username of the owning recruiter (denormalized for fast scoping)
  dir         text not null,          -- 'out' (we sent) | 'in' (candidate replied)
  channel     text not null,          -- 'text' | 'email'
  body        text,
  subject     text,
  contact     text,                   -- normalized phone (10 digits) or lowercased email; used to route inbound. NEVER sent to the client.
  by_user     text,                   -- who sent an outbound (username)
  by_name     text,
  created_at  timestamptz default now()
);

create index if not exists messages_cand_idx    on messages (cand_id);
create index if not exists messages_owner_idx    on messages (owner);
create index if not exists messages_contact_idx  on messages (contact);

alter table messages enable row level security;
-- (Deliberately no CREATE POLICY statements: anon/public cannot select, insert, update or delete.
--  The server's service key bypasses RLS and is the only way in.)
