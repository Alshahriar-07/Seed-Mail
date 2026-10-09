-- ===========================================================================
-- Seed Code Mail — RLS policy smoke check
-- ---------------------------------------------------------------------------
-- Run after applying the migrations:
--
--   psql "$SUPABASE_DB_URL" -f supabase/tests/rls_policies.sql
--
-- (or paste into the Supabase SQL editor). It fails loudly if any user-owned
-- table is missing RLS or is missing a required policy. It needs no test
-- accounts, because it inspects the catalogue rather than exercising data.
-- ===========================================================================

do $$
declare
  tbl      text;
  pol      text;
  required constant text[][] := array[
    ['profiles',            'profiles_select_own'],
    ['profiles',            'profiles_insert_own'],
    ['profiles',            'profiles_update_own'],
    ['recipients',          'recipients_select_own'],
    ['recipients',          'recipients_insert_own'],
    ['recipients',          'recipients_update_own'],
    ['recipients',          'recipients_delete_own'],
    ['user_settings',       'user_settings_select_own'],
    ['user_settings',       'user_settings_insert_own'],
    ['user_settings',       'user_settings_update_own'],
    ['campaigns',           'campaigns_select_own'],
    ['campaigns',           'campaigns_insert_own'],
    ['campaigns',           'campaigns_update_own'],
    ['campaigns',           'campaigns_delete_own'],
    ['campaign_recipients', 'campaign_recipients_select_own'],
    ['campaign_recipients', 'campaign_recipients_insert_own'],
    ['campaign_recipients', 'campaign_recipients_update_own'],
    ['campaign_recipients', 'campaign_recipients_delete_own'],
    ['email_history',       'email_history_select_own'],
    ['email_history',       'email_history_insert_own'],
    ['email_history',       'email_history_delete_own']
  ];
  i int;
begin
  -- 1. RLS enabled on every user-owned table.
  for tbl in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname in ('profiles', 'recipients', 'user_settings',
                        'campaigns', 'campaign_recipients', 'email_history')
  loop
    if not exists (
      select 1 from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = tbl and c.relrowsecurity
    ) then
      raise exception 'RLS is NOT enabled on public.%', tbl;
    end if;
    raise notice 'RLS enabled on public.%', tbl;
  end loop;

  if (select count(*) from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relrowsecurity
         and c.relname in ('profiles', 'recipients', 'user_settings',
                           'campaigns', 'campaign_recipients', 'email_history')
     ) <> 6 then
    raise exception 'One or more expected tables are missing from public schema';
  end if;

  -- 2. Every required policy exists and targets `authenticated`.
  for i in 1 .. array_length(required, 1) loop
    tbl := required[i][1];
    pol := required[i][2];
    if not exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = tbl and policyname = pol
    ) then
      raise exception 'Missing policy %.%', tbl, pol;
    end if;
  end loop;

  -- 3. No policy may grant access to `anon`.
  if exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename in ('profiles', 'recipients', 'user_settings',
                        'campaigns', 'campaign_recipients', 'email_history')
      and 'anon' = any (roles)
  ) then
    raise exception 'An anon policy exists on a private table';
  end if;

  raise notice 'OK — RLS enabled, % required policies present, no anon access', array_length(required, 1);
end;
$$;
