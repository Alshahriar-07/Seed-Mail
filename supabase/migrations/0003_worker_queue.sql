-- ===========================================================================
-- Seed Code Mail — 0003 durable campaign queue for the remote send worker
-- ---------------------------------------------------------------------------
-- Campaign sending used to require a Python process on the user's own machine:
-- the browser posted the whole campaign (template + recipients) to a worker
-- listening on 127.0.0.1, which held the run in memory. That cannot work for a
-- hosted deployment, so the queue now lives in Postgres:
--
--   * the browser QUEUES a campaign (status 'queued') together with the run
--     snapshot it needs (template HTML/design + sending preferences);
--   * a continuously available worker CLAIMS one campaign at a time with an
--     atomic, row-locked claim, and holds a renewable lease;
--   * progress, per-recipient job state and email history are written back to
--     Postgres, so the UI can read real state from the database;
--   * pause / resume / cancel are flags in the database, so any worker (and
--     every browser tab) sees the same truth.
--
-- Security notes
--   * The template snapshot is only readable by its owner: it lives on the
--     owner's own `campaigns` row, which is already protected by RLS
--     (campaigns_select_own / campaigns_update_own in 0002_rls.sql).
--   * The claim/renew/finish helpers are SECURITY DEFINER and their EXECUTE
--     privilege is revoked from anon/authenticated, so a signed-in user cannot
--     claim somebody else's campaign.
--   * Nothing here stores a credential. The Gmail App Password stays in the
--     worker host's environment and never enters Postgres.
--
-- Safe to re-run.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Run snapshot + queue bookkeeping on campaigns
-- ---------------------------------------------------------------------------

alter table public.campaigns
  -- Run snapshot captured when the campaign is queued. Previously the template
  -- was only ever held in the browser, which made a durable queue impossible.
  add column if not exists template_html     text not null default '',
  add column if not exists template_design   jsonb not null default '{}'::jsonb,
  add column if not exists run_config        jsonb not null default '{}'::jsonb,
  -- Queue / lease state.
  add column if not exists queued_at         timestamptz,
  add column if not exists claimed_by        text not null default '',
  add column if not exists claimed_at        timestamptz,
  add column if not exists lease_expires_at  timestamptz,
  add column if not exists attempt_count     integer not null default 0 check (attempt_count >= 0),
  add column if not exists last_error        text not null default '' check (char_length(last_error) <= 400),
  -- Cooperative control flags, honoured between delivery attempts.
  add column if not exists pause_requested   boolean not null default false,
  add column if not exists cancel_requested  boolean not null default false;

-- The claim query only ever looks at queued (or lease-expired) campaigns.
create index if not exists campaigns_queue_idx
  on public.campaigns (status, queued_at)
  where status = 'queued';

create index if not exists campaigns_lease_idx
  on public.campaigns (lease_expires_at)
  where status = 'running';

-- ---------------------------------------------------------------------------
-- Worker heartbeats — the honest source of "is the remote worker alive?"
-- ---------------------------------------------------------------------------
-- Only the worker (service role) may touch this table: there is deliberately no
-- policy for `authenticated`, so the browser reads worker availability from the
-- worker's own API instead of from a value it could fake.

create table if not exists public.worker_heartbeats (
  worker_id    text primary key check (char_length(worker_id) between 1 and 120),
  kind         text not null default 'queue' check (char_length(kind) <= 40),
  version      text not null default '' check (char_length(version) <= 40),
  detail       jsonb not null default '{}'::jsonb,
  started_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

alter table public.worker_heartbeats enable row level security;
alter table public.worker_heartbeats force row level security;

revoke all on public.worker_heartbeats from anon;
revoke all on public.worker_heartbeats from authenticated;
grant select, insert, update, delete on public.worker_heartbeats to service_role;

-- ---------------------------------------------------------------------------
-- Atomic claim / lease renewal / completion
-- ---------------------------------------------------------------------------

-- Claims the oldest queued campaign, or one whose lease has expired (its worker
-- died mid-run). `for update skip locked` makes concurrent workers safe: two
-- workers polling at the same time can never claim the same campaign.
create or replace function public.claim_next_campaign(
  p_worker text,
  p_lease_seconds integer default 300
)
returns setof public.campaigns
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  select id into v_id
    from public.campaigns
   where status = 'queued'
      or (status = 'running'
          and lease_expires_at is not null
          and lease_expires_at < now())
   order by coalesce(queued_at, created_at) asc
   limit 1
   for update skip locked;

  if v_id is null then
    return;
  end if;

  return query
    update public.campaigns
       set status           = 'running',
           claimed_by       = p_worker,
           claimed_at       = now(),
           lease_expires_at = now() + make_interval(secs => greatest(30, p_lease_seconds)),
           attempt_count    = attempt_count + 1,
           last_error       = '',
           started_at       = coalesce(started_at, now()),
           updated_at       = now()
     where id = v_id
    returning *;
end;
$$;

-- Extends the lease while the run is in progress. Returns false when the lease
-- was taken over by another worker (or the campaign was cancelled), which tells
-- the current worker to stop immediately rather than sending twice.
create or replace function public.renew_campaign_lease(
  p_campaign uuid,
  p_worker text,
  p_lease_seconds integer default 300
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_updated integer;
begin
  update public.campaigns
     set lease_expires_at = now() + make_interval(secs => greatest(30, p_lease_seconds)),
         updated_at       = now()
   where id = p_campaign
     and claimed_by = p_worker
     and status = 'running';

  get diagnostics v_updated = row_count;
  return v_updated > 0;
end;
$$;

-- Releases the lease when a run ends so the row cannot be claimed again while
-- it is finished, paused or failed.
create or replace function public.release_campaign(
  p_campaign uuid,
  p_worker text,
  p_status text,
  p_error text default ''
)
returns public.campaigns
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.campaigns;
begin
  if p_status not in ('completed', 'cancelled', 'paused', 'failed', 'queued') then
    raise exception 'invalid release status: %', p_status;
  end if;

  update public.campaigns
     set status           = p_status,
         claimed_by       = '',
         lease_expires_at = null,
         last_error       = left(coalesce(p_error, ''), 400),
         finished_at      = case when p_status in ('completed', 'cancelled', 'failed')
                                 then coalesce(finished_at, now()) else finished_at end,
         updated_at       = now()
   where id = p_campaign
     and claimed_by = p_worker
    returning * into v_row;

  return v_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges: the queue helpers belong to the worker (service role) only.
-- ---------------------------------------------------------------------------

revoke all on function public.claim_next_campaign(text, integer) from public, anon, authenticated;
revoke all on function public.renew_campaign_lease(uuid, text, integer) from public, anon, authenticated;
revoke all on function public.release_campaign(uuid, text, text, text) from public, anon, authenticated;

grant execute on function public.claim_next_campaign(text, integer) to service_role;
grant execute on function public.renew_campaign_lease(uuid, text, integer) to service_role;
grant execute on function public.release_campaign(uuid, text, text, text) to service_role;
