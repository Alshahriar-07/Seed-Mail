-- ===========================================================================
-- Seed Code Mail — 0001 schema
-- ---------------------------------------------------------------------------
-- Creates the tables that back the hosted (Vercel + Supabase) web app.
--
-- Design notes
--   * Every user-owned table carries a `user_id` that defaults to auth.uid(),
--     so a row can only ever be created on behalf of the signed-in user.
--   * `status` columns use text + CHECK constraints instead of Postgres enums
--     so later migrations can extend the allowed set without a type rewrite.
--   * Email templates are NOT stored here. They live in the user's browser
--     (IndexedDB). Campaigns only keep a local `template_ref` (an id/name),
--     never the template HTML.
--   * Gmail App Passwords are NEVER stored in Postgres. The send worker keeps
--     them in its own server-side environment (see README / worker/).
--   * Safe to re-run: every statement is `if not exists`/`or replace`.
-- ===========================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Timestamp helper
-- ---------------------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- profiles — one row per authenticated user
-- ---------------------------------------------------------------------------

create table if not exists public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  display_name text not null default '' check (char_length(display_name) <= 120),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- recipients — the user's contact list
-- ---------------------------------------------------------------------------

create table if not exists public.recipients (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null default auth.uid() references auth.users (id) on delete cascade,
  company_name    text not null check (char_length(company_name) between 1 and 200),
  email           text not null
                    check (char_length(email) between 3 and 254
                           and email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  status          text not null default 'pending'
                    check (status in ('pending', 'sent', 'failed', 'unknown')),
  last_attempt_at timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- An address is unique per user (case-insensitively), but not globally.
create unique index if not exists recipients_user_email_key
  on public.recipients (user_id, lower(email));
create index if not exists recipients_user_created_idx
  on public.recipients (user_id, created_at desc);
create index if not exists recipients_user_status_idx
  on public.recipients (user_id, status);

drop trigger if exists recipients_set_updated_at on public.recipients;
create trigger recipients_set_updated_at
  before update on public.recipients
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- user_settings — non-secret sending preferences (no App Password, ever)
-- ---------------------------------------------------------------------------

create table if not exists public.user_settings (
  user_id              uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  sender_email         text not null default '' check (char_length(sender_email) <= 254),
  sender_display_name  text not null default '' check (char_length(sender_display_name) <= 120),
  github_url           text not null default '' check (char_length(github_url) <= 2048),
  smtp_host            text not null default 'smtp.gmail.com' check (char_length(smtp_host) <= 255),
  smtp_port            integer not null default 465 check (smtp_port between 1 and 65535),
  send_delay_seconds   integer not null default 5 check (send_delay_seconds >= 0),
  smtp_timeout_seconds integer not null default 30 check (smtp_timeout_seconds > 0),
  max_retries          integer not null default 2 check (max_retries between 0 and 10),
  retry_delay_seconds  integer not null default 10 check (retry_delay_seconds >= 0),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

drop trigger if exists user_settings_set_updated_at on public.user_settings;
create trigger user_settings_set_updated_at
  before update on public.user_settings
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- campaigns — the subject lives here and is required per campaign.
-- There is deliberately no global/default-subject column anywhere.
-- ---------------------------------------------------------------------------

create table if not exists public.campaigns (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name             text not null check (char_length(name) between 1 and 120),
  subject          text not null check (char_length(subject) between 1 and 200),
  -- Local (browser) template identifier/name only. The template HTML is never
  -- stored in Postgres.
  template_ref     text not null default '' check (char_length(template_ref) <= 200),
  status           text not null default 'draft'
                     check (status in ('draft', 'queued', 'running', 'paused', 'completed', 'cancelled')),
  total_recipients integer not null default 0 check (total_recipients >= 0),
  processed_count  integer not null default 0 check (processed_count >= 0),
  sent_count       integer not null default 0 check (sent_count >= 0),
  failed_count     integer not null default 0 check (failed_count >= 0),
  unknown_count    integer not null default 0 check (unknown_count >= 0),
  started_at       timestamptz,
  finished_at      timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists campaigns_user_created_idx
  on public.campaigns (user_id, created_at desc);
create index if not exists campaigns_user_status_idx
  on public.campaigns (user_id, status);

drop trigger if exists campaigns_set_updated_at on public.campaigns;
create trigger campaigns_set_updated_at
  before update on public.campaigns
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- campaign_recipients — one job per recipient inside a campaign
-- (the persisted queue the send worker claims from)
-- ---------------------------------------------------------------------------

create table if not exists public.campaign_recipients (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null default auth.uid() references auth.users (id) on delete cascade,
  campaign_id         uuid not null references public.campaigns (id) on delete cascade,
  recipient_id        uuid references public.recipients (id) on delete set null,
  company_name        text not null default '' check (char_length(company_name) <= 200),
  email               text not null,
  attempts            integer not null default 0 check (attempts >= 0),
  status              text not null default 'pending'
                        check (status in ('pending', 'sent', 'failed', 'unknown', 'skipped')),
  last_error_category text not null default '' check (char_length(last_error_category) <= 60),
  last_error          text not null default '' check (char_length(last_error) <= 400),
  last_attempt_at     timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- Never queue the same address twice inside one campaign.
create unique index if not exists campaign_recipients_campaign_email_key
  on public.campaign_recipients (campaign_id, lower(email));
create index if not exists campaign_recipients_campaign_status_idx
  on public.campaign_recipients (campaign_id, status);
create index if not exists campaign_recipients_user_idx
  on public.campaign_recipients (user_id, created_at desc);

drop trigger if exists campaign_recipients_set_updated_at on public.campaign_recipients;
create trigger campaign_recipients_set_updated_at
  before update on public.campaign_recipients
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- email_history — append-only submission log (sanitized, no credentials)
-- ---------------------------------------------------------------------------

create table if not exists public.email_history (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null default auth.uid() references auth.users (id) on delete cascade,
  campaign_id    uuid references public.campaigns (id) on delete set null,
  recipient_id   uuid references public.recipients (id) on delete set null,
  company_name   text not null default '' check (char_length(company_name) <= 200),
  email          text not null default '' check (char_length(email) <= 254),
  subject        text not null default '' check (char_length(subject) <= 200),
  -- 'sent' means the SMTP relay accepted the message — never inbox delivery.
  status         text not null check (status in ('sent', 'failed', 'unknown')),
  attempt        integer not null default 1 check (attempt >= 0),
  error_category text not null default '' check (char_length(error_category) <= 60),
  error_message  text not null default '' check (char_length(error_message) <= 400),
  created_at     timestamptz not null default now()
);

create index if not exists email_history_user_created_idx
  on public.email_history (user_id, created_at desc);
create index if not exists email_history_user_campaign_idx
  on public.email_history (user_id, campaign_id);
create index if not exists email_history_user_status_idx
  on public.email_history (user_id, status);

-- ---------------------------------------------------------------------------
-- Signup hook — create the profile + default settings exactly once per user,
-- so the app never has to insert duplicate profiles on the client.
-- ---------------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'display_name', ''))
  on conflict (id) do nothing;

  insert into public.user_settings (user_id)
  values (new.id)
  on conflict (user_id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
