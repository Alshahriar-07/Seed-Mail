-- ===========================================================================
-- Seed Code Mail — 0002 row level security
-- ---------------------------------------------------------------------------
-- Every table that carries user-owned information gets RLS enabled and a set
-- of least-privilege policies for the `authenticated` role only.
--
--   * Ownership is always proven with `auth.uid()`, which comes from the
--     verified JWT — never from a user id the browser supplied.
--   * There is no policy at all for `anon`, so an anonymous request sees zero
--     rows and cannot insert/update/delete anything.
--   * There is no policy that reads or writes another user's rows, so changing
--     a request id (e.g. ?id=<someone-else's-uuid>) returns no rows / is
--     rejected by the WITH CHECK clause.
--
-- Safe to re-run: each policy is dropped before it is recreated.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Enable RLS
-- ---------------------------------------------------------------------------

alter table public.profiles            enable row level security;
alter table public.recipients          enable row level security;
alter table public.user_settings       enable row level security;
alter table public.campaigns           enable row level security;
alter table public.campaign_recipients enable row level security;
alter table public.email_history       enable row level security;

-- Belt and braces: RLS applies to the table owner too. Without this the table
-- owner could accidentally bypass RLS.
alter table public.profiles            force row level security;
alter table public.recipients          force row level security;
alter table public.user_settings       force row level security;
alter table public.campaigns           force row level security;
alter table public.campaign_recipients force row level security;
alter table public.email_history       force row level security;

-- ---------------------------------------------------------------------------
-- Privileges: authenticated may use these tables; anon may not touch them.
-- ---------------------------------------------------------------------------

grant usage on schema public to authenticated;
grant select, insert, update, delete on public.profiles            to authenticated;
grant select, insert, update, delete on public.recipients          to authenticated;
grant select, insert, update, delete on public.user_settings       to authenticated;
grant select, insert, update, delete on public.campaigns           to authenticated;
grant select, insert, update, delete on public.campaign_recipients to authenticated;
grant select, insert, update, delete on public.email_history       to authenticated;

revoke all on public.profiles            from anon;
revoke all on public.recipients          from anon;
revoke all on public.user_settings       from anon;
revoke all on public.campaigns           from anon;
revoke all on public.campaign_recipients from anon;
revoke all on public.email_history       from anon;

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------

drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles
  for select to authenticated using (auth.uid() = id);

drop policy if exists profiles_insert_own on public.profiles;
create policy profiles_insert_own on public.profiles
  for insert to authenticated with check (auth.uid() = id);

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles
  for update to authenticated
  using (auth.uid() = id) with check (auth.uid() = id);

-- ---------------------------------------------------------------------------
-- recipients
-- ---------------------------------------------------------------------------

drop policy if exists recipients_select_own on public.recipients;
create policy recipients_select_own on public.recipients
  for select to authenticated using (auth.uid() = user_id);

drop policy if exists recipients_insert_own on public.recipients;
create policy recipients_insert_own on public.recipients
  for insert to authenticated with check (auth.uid() = user_id);

drop policy if exists recipients_update_own on public.recipients;
create policy recipients_update_own on public.recipients
  for update to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists recipients_delete_own on public.recipients;
create policy recipients_delete_own on public.recipients
  for delete to authenticated using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- user_settings
-- ---------------------------------------------------------------------------

drop policy if exists user_settings_select_own on public.user_settings;
create policy user_settings_select_own on public.user_settings
  for select to authenticated using (auth.uid() = user_id);

drop policy if exists user_settings_insert_own on public.user_settings;
create policy user_settings_insert_own on public.user_settings
  for insert to authenticated with check (auth.uid() = user_id);

drop policy if exists user_settings_update_own on public.user_settings;
create policy user_settings_update_own on public.user_settings
  for update to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- campaigns
-- ---------------------------------------------------------------------------

drop policy if exists campaigns_select_own on public.campaigns;
create policy campaigns_select_own on public.campaigns
  for select to authenticated using (auth.uid() = user_id);

drop policy if exists campaigns_insert_own on public.campaigns;
create policy campaigns_insert_own on public.campaigns
  for insert to authenticated with check (auth.uid() = user_id);

drop policy if exists campaigns_update_own on public.campaigns;
create policy campaigns_update_own on public.campaigns
  for update to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists campaigns_delete_own on public.campaigns;
create policy campaigns_delete_own on public.campaigns
  for delete to authenticated using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- campaign_recipients
-- The campaign_id must ALSO belong to the caller, otherwise a user could
-- attach a job to somebody else's campaign id.
-- ---------------------------------------------------------------------------

drop policy if exists campaign_recipients_select_own on public.campaign_recipients;
create policy campaign_recipients_select_own on public.campaign_recipients
  for select to authenticated using (auth.uid() = user_id);

drop policy if exists campaign_recipients_insert_own on public.campaign_recipients;
create policy campaign_recipients_insert_own on public.campaign_recipients
  for insert to authenticated
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.campaigns c
      where c.id = campaign_id and c.user_id = auth.uid()
    )
  );

drop policy if exists campaign_recipients_update_own on public.campaign_recipients;
create policy campaign_recipients_update_own on public.campaign_recipients
  for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists campaign_recipients_delete_own on public.campaign_recipients;
create policy campaign_recipients_delete_own on public.campaign_recipients
  for delete to authenticated
  using (
    auth.uid() = user_id
    and exists (
      select 1 from public.campaigns c
      where c.id = campaign_id and c.user_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------------
-- email_history
-- Append-only from the client's point of view: own rows may be read and
-- created, and cleared (delete). There is no UPDATE policy, so a stored
-- submission record cannot be silently rewritten.
-- ---------------------------------------------------------------------------

drop policy if exists email_history_select_own on public.email_history;
create policy email_history_select_own on public.email_history
  for select to authenticated using (auth.uid() = user_id);

drop policy if exists email_history_insert_own on public.email_history;
create policy email_history_insert_own on public.email_history
  for insert to authenticated with check (auth.uid() = user_id);

drop policy if exists email_history_delete_own on public.email_history;
create policy email_history_delete_own on public.email_history
  for delete to authenticated using (auth.uid() = user_id);
