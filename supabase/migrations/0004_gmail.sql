-- ===========================================================================
-- Seed Code Mail — 0004 Gmail connection + per-message provider metadata
-- ---------------------------------------------------------------------------
-- Gmail becomes the mailbox for ordinary mail (Inbox / Compose / Sent), served
-- by the trusted backend in `api/gmail/` with Gmail's official API and OAuth
-- 2.0. Two things must be persisted for that to work, and one must NOT be:
--
--   * `gmail_connections` — which Google account a user connected, which scopes
--     were granted, and the OAuth refresh token that makes reading/sending
--     possible. The refresh token is a long-lived credential, so it is stored
--     ENCRYPTED (AES-256-GCM, key held by the backend) in a table that the
--     `authenticated` role cannot read or write AT ALL — RLS is enabled and
--     forced with no policy for anyone except `service_role`. The backend is
--     the only reader, and it only ever returns a masked status to the browser.
--
--   * `provider*` columns — the relationship between an application campaign
--     job and the message the provider actually accepted, so campaign history
--     can report provider-backed evidence instead of a guess.
--
--   * Mailbox contents are deliberately NOT copied into Postgres. Gmail holds
--     the messages; the app reads them on demand through the API.
--
-- Nothing here deletes or rewrites existing rows: every statement is additive
-- and safe to re-run.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- gmail_connections — server-side only. Never readable by the browser.
-- ---------------------------------------------------------------------------
--
-- Why the browser is denied completely rather than "seeing its own row":
-- RLS filters rows, not columns. A user-readable row would have to expose the
-- encrypted refresh token to the client, and "the client can read the
-- ciphertext" is not a boundary this project is willing to rely on. So the row
-- belongs to the backend (`service_role`) alone; the UI learns its own
-- connection state from `GET /api/gmail/status`, which the backend derives.

create table if not exists public.gmail_connections (
  user_id           uuid primary key references auth.users (id) on delete cascade,
  -- The connected Google account address. Displayed in Profile; not a secret.
  gmail_email       text not null default '' check (char_length(gmail_email) <= 254),
  -- Space-separated scope list as granted by Google (for truthful UI copy and
  -- for detecting a connection that needs re-consent after a scope change).
  scopes            text not null default '' check (char_length(scopes) <= 2048),
  -- AES-256-GCM payload (base64 of iv || auth-tag || ciphertext) of the OAuth
  -- refresh token. Empty means "connected but no refresh token was issued".
  token_ciphertext  text not null default '',
  -- Identifies which key encrypted the payload, so a key can be rotated.
  key_version       integer not null default 1 check (key_version >= 1),
  status            text not null default 'connected'
                      check (status in ('connected', 'revoked', 'error')),
  last_error        text not null default '' check (char_length(last_error) <= 400),
  connected_at      timestamptz not null default now(),
  last_refreshed_at timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

drop trigger if exists gmail_connections_set_updated_at on public.gmail_connections;
create trigger gmail_connections_set_updated_at
  before update on public.gmail_connections
  for each row execute function public.set_updated_at();

alter table public.gmail_connections enable row level security;
alter table public.gmail_connections force row level security;

-- No policy is created for `authenticated` or `anon`, on purpose. With RLS
-- forced and no policy, both roles see zero rows and can write nothing.
revoke all on public.gmail_connections from anon;
revoke all on public.gmail_connections from authenticated;
grant select, insert, update, delete on public.gmail_connections to service_role;

-- ---------------------------------------------------------------------------
-- Per-message provider metadata
-- ---------------------------------------------------------------------------
-- `provider` records which channel produced a submission, and
-- `provider_message_id` records the id the provider assigned to it — the Gmail
-- message id when the Gmail API accepted the send, empty when the channel
-- (SMTP) returns no such id. An empty id must be read as "not reported", never
-- as "delivered".

alter table public.campaign_recipients
  add column if not exists provider            text not null default 'smtp',
  add column if not exists provider_message_id text not null default '';

alter table public.email_history
  add column if not exists provider            text not null default 'smtp',
  add column if not exists provider_message_id text not null default '';

alter table public.campaigns
  add column if not exists provider            text not null default 'smtp';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'campaign_recipients_provider_len'
  ) then
    alter table public.campaign_recipients
      add constraint campaign_recipients_provider_len
      check (char_length(provider) <= 40 and char_length(provider_message_id) <= 200);
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'email_history_provider_len'
  ) then
    alter table public.email_history
      add constraint email_history_provider_len
      check (char_length(provider) <= 40 and char_length(provider_message_id) <= 200);
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'campaigns_provider_len'
  ) then
    alter table public.campaigns
      add constraint campaigns_provider_len check (char_length(provider) <= 40);
  end if;
end
$$;

-- Looking up "which campaign produced this Gmail message?" must be cheap.
create index if not exists email_history_provider_message_idx
  on public.email_history (user_id, provider, provider_message_id)
  where provider_message_id <> '';

create index if not exists campaign_recipients_provider_message_idx
  on public.campaign_recipients (campaign_id, provider_message_id)
  where provider_message_id <> '';
