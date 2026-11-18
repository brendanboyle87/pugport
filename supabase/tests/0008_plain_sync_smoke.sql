-- Smoke test for 0008_plain_sync.sql. Run it on a Supabase test branch only, never on production:
-- apply 0001-0008 there, then run this whole file in the SQL editor as the role that applied them (postgres).
-- It uses two synthetic users and ends with ROLLBACK, so nothing it creates is kept.
-- Pass: the notice 'PLAIN SYNC SMOKE TEST PASSED' appears. Any failed check raises 'SMOKE: ...' and aborts.
begin;

insert into auth.users (id, aud, role, email)
values ('00000000-0000-4000-8000-00000000000a', 'authenticated', 'authenticated', 'smoke-a@example.test'),
       ('00000000-0000-4000-8000-00000000000b', 'authenticated', 'authenticated', 'smoke-b@example.test');

-- 1. Privileges: anon reaches nothing new; authenticated reaches only the RPCs and its own rows.
do $$
declare fn regprocedure;
begin
  for fn in
    select p.oid::regprocedure from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'account_private'
    union all
    select f::regprocedure from unnest(array[
      'public.sync_record_stamp()', 'public.legacy_key_retired()', 'public.account_sync_record()',
      'public.ensure_sync_account()', 'public.finish_legacy_migration(text)',
      'public.push_sync_records(uuid,jsonb)', 'public.pull_sync_records(bigint,integer)',
      'public.delete_my_cloud_data()']) f
  loop
    if has_function_privilege('anon', fn, 'execute') then raise exception 'SMOKE: anon can execute %', fn; end if;
  end loop;
  foreach fn in array array[
    'public.sync_record_stamp()', 'public.legacy_key_retired()', 'public.account_sync_record()',
    'account_private.drop_vault_secret()', 'account_private.purge_orphan_secrets(uuid)',
    'account_private.secret_count(uuid)']::regprocedure[]
  loop
    if has_function_privilege('authenticated', fn, 'execute') then
      raise exception 'SMOKE: authenticated can execute %', fn;
    end if;
  end loop;
  if has_schema_privilege('anon', 'account_private', 'usage') then raise exception 'SMOKE: anon uses account_private'; end if;
  if has_table_privilege('anon', 'public.sync_records', 'select')
     or has_table_privilege('anon', 'public.sync_accounts', 'select')
     or has_table_privilege('authenticated', 'public.sync_records', 'delete')
     or has_table_privilege('authenticated', 'public.sync_accounts', 'insert')
     or has_table_privilege('authenticated', 'account_private.record_secrets', 'select')
     or has_table_privilege('authenticated', 'account_private.orphan_secrets', 'select') then
    raise exception 'SMOKE: table privileges too wide';
  end if;
end $$;

-- 2. Vault as the function owner: create, update, read, delete.
do $$
declare s uuid; v text;
begin
  if (select pg_catalog.pg_get_userbyid(proowner) from pg_catalog.pg_proc
       where oid = 'account_private.write_secret(text,text,jsonb)'::regprocedure) <> current_user then
    raise exception 'SMOKE: run this file as the owner of account_private.write_secret';
  end if;
  s := vault.create_secret('{"key":"sk-smoke-probe-1"}');
  perform vault.update_secret(s, '{"key":"sk-smoke-probe-2"}');
  select decrypted_secret into v from vault.decrypted_secrets where id = s;
  if v is distinct from '{"key":"sk-smoke-probe-2"}' then raise exception 'SMOKE: vault read returned %', v; end if;
  begin
    delete from vault.secrets where id = s;
    if exists (select 1 from vault.secrets where id = s) then raise exception 'SMOKE: vault delete kept the row'; end if;
    raise notice 'vault delete: allowed';
  exception when insufficient_privilege then
    raise notice 'vault delete: DENIED; deleted secrets will be blanked and parked in account_private.orphan_secrets';
  end;
end $$;

-- 3. User A writes plain records and secrets.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000000a","role":"authenticated"}', true);
select set_config('smoke.gen_a', public.ensure_sync_account()->>'generation', true);

do $$
declare
  gen uuid := current_setting('smoke.gen_a')::uuid;
  r jsonb;
  card_seq bigint;
begin
  r := public.push_sync_records(gen, jsonb_build_array(
    jsonb_build_object('kind', 'conversation', 'id', 'smoke-conv', 'last_seq', 0, 'deleted', false,
                       'device_id', 'smoke-a', 'body', '{"value":{"title":"Synthetic chat A"}}'::jsonb),
    jsonb_build_object('kind', 'api-provider', 'id', 'smoke-card', 'last_seq', 0, 'deleted', false,
                       'device_id', 'smoke-a', 'body', '{"value":{"name":"Synthetic card A"}}'::jsonb,
                       'secrets', '{"key":"sk-smoke-a-1"}'::jsonb)));
  if exists (select 1 from jsonb_array_elements(r) e where e->>'status' <> 'accepted') then
    raise exception 'SMOKE: A push not accepted: %', r;
  end if;
  card_seq := (r->1->'record'->>'seq')::bigint;

  -- Update the secret.
  r := public.push_sync_records(gen, jsonb_build_array(
    jsonb_build_object('kind', 'api-provider', 'id', 'smoke-card', 'last_seq', card_seq, 'deleted', false,
                       'device_id', 'smoke-a', 'body', '{"value":{"name":"Synthetic card A"}}'::jsonb,
                       'secrets', '{"key":"sk-smoke-a-2"}'::jsonb)));
  if r->0->>'status' <> 'accepted' then raise exception 'SMOKE: A secret update: %', r; end if;
  select e into r from jsonb_array_elements(public.pull_sync_records(0)) e where e->>'id' = 'smoke-card';
  if r->'secrets'->>'key' is distinct from 'sk-smoke-a-2' then raise exception 'SMOKE: A pull secret: %', r; end if;

  r := public.push_sync_records(gen, jsonb_build_array(
    jsonb_build_object('kind', 'api-provider', 'id', 'smoke-leak', 'last_seq', 0, 'deleted', false,
                       'device_id', 'smoke-a', 'body', '{"value":{"key":"sk-smoke-in-body"}}'::jsonb)));
  if r->0->>'code' is distinct from 'SECRET_IN_BODY' then raise exception 'SMOKE: secret in body: %', r; end if;

  begin
    delete from public.sync_records;
    raise exception 'SMOKE: authenticated deleted sync_records';
  exception when insufficient_privilege then null;
  end;
  begin
    perform count(*) from account_private.record_secrets;
    raise exception 'SMOKE: authenticated read record_secrets';
  exception when insufficient_privilege then null;
  end;
  begin
    perform count(*) from vault.decrypted_secrets;
    raise exception 'SMOKE: authenticated read vault.decrypted_secrets';
  exception when insufficient_privilege then null;
  end;
end $$;

-- 4. User B cannot read or change A's rows or secrets.
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000000b","role":"authenticated"}', true);
select set_config('smoke.gen_b', public.ensure_sync_account()->>'generation', true);

do $$
declare
  gen uuid := current_setting('smoke.gen_b')::uuid;
  a uuid := '00000000-0000-4000-8000-00000000000a';
  r jsonb;
  n bigint;
begin
  if exists (select 1 from public.sync_records where user_id = a) then raise exception 'SMOKE: B sees A rows'; end if;
  if jsonb_array_length(public.pull_sync_records(0)) <> 0 then raise exception 'SMOKE: B pulls A rows'; end if;
  if account_private.read_secret('api-provider', 'smoke-card') is not null then
    raise exception 'SMOKE: B reads A secret';
  end if;
  update public.sync_records set body = '{"value":{"title":"hijacked"}}' where user_id = a;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'SMOKE: B updated A rows'; end if;
  begin
    perform account_private.write_secret('api-provider', 'smoke-card', '{"key":"sk-smoke-b-steal"}');
    raise exception 'SMOKE: B wrote a secret for A''s record id';
  exception when foreign_key_violation then null;
  end;

  r := public.push_sync_records(current_setting('smoke.gen_a')::uuid, jsonb_build_array(
    jsonb_build_object('kind', 'conversation', 'id', 'smoke-conv', 'last_seq', 0, 'deleted', false,
                       'device_id', 'smoke-b', 'body', '{"value":{"title":"hijacked"}}'::jsonb)));
  if r->0->>'code' is distinct from 'CLOUD_DATA_RESET' then raise exception 'SMOKE: B used A generation: %', r; end if;

  -- Same ids as A, but B's own rows.
  r := public.push_sync_records(gen, jsonb_build_array(
    jsonb_build_object('kind', 'conversation', 'id', 'smoke-conv', 'last_seq', 0, 'deleted', false,
                       'device_id', 'smoke-b', 'body', '{"value":{"title":"Synthetic chat B"}}'::jsonb),
    jsonb_build_object('kind', 'server-node', 'id', 'smoke-node', 'last_seq', 0, 'deleted', false,
                       'device_id', 'smoke-b', 'body', '{"value":{"name":"Synthetic node B"}}'::jsonb,
                       'secrets', '{"token":"tok-smoke-b"}'::jsonb)));
  if exists (select 1 from jsonb_array_elements(r) e where e->>'status' <> 'accepted') then
    raise exception 'SMOKE: B push not accepted: %', r;
  end if;
  -- A direct insert naming A is stamped as B's own row.
  insert into public.sync_records(user_id, kind, id, seq, body, device_id, size)
    values (a, 'memory', 'smoke-direct', 0, '{"value":{}}', 'smoke-b', 0);
end $$;

reset role;
do $$
begin
  if (select body->'value'->>'title' from public.sync_records
       where user_id = '00000000-0000-4000-8000-00000000000a' and kind = 'conversation' and id = 'smoke-conv')
     is distinct from 'Synthetic chat A' then
    raise exception 'SMOKE: A conversation changed by B';
  end if;
  if exists (select 1 from public.sync_records
              where user_id = '00000000-0000-4000-8000-00000000000a' and id = 'smoke-direct') then
    raise exception 'SMOKE: B inserted a row owned by A';
  end if;
end $$;

-- 5. A hits the secret cap, a tombstone frees a slot and drops its Vault row.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000000a","role":"authenticated"}', true);

do $$
declare
  gen uuid := current_setting('smoke.gen_a')::uuid;
  r jsonb;
  b integer;
  card_seq bigint;
begin
  -- A already has one secret; add 499 more.
  for b in 0..4 loop
    select public.push_sync_records(gen, jsonb_agg(jsonb_build_object(
             'kind', 'api-provider', 'id', 'smoke-fill-' || i, 'last_seq', 0, 'deleted', false,
             'device_id', 'smoke-a', 'body', '{"value":{}}'::jsonb, 'secrets', jsonb_build_object('key', 'sk-fill-' || i))))
      into r from generate_series(b * 100 + 1, least(b * 100 + 100, 499)) i;
    if exists (select 1 from jsonb_array_elements(r) e where e->>'status' <> 'accepted') then
      raise exception 'SMOKE: fill batch % not accepted', b;
    end if;
  end loop;
  r := public.push_sync_records(gen, jsonb_build_array(
    jsonb_build_object('kind', 'api-provider', 'id', 'smoke-over', 'last_seq', 0, 'deleted', false,
                       'device_id', 'smoke-a', 'body', '{"value":{}}'::jsonb, 'secrets', '{"key":"sk-over"}'::jsonb)));
  if r->0->>'code' is distinct from 'SECRET_LIMIT' then raise exception 'SMOKE: secret cap: %', r; end if;
  if exists (select 1 from public.sync_records where id = 'smoke-over') then
    raise exception 'SMOKE: capped record was stored';
  end if;

  select seq into card_seq from public.sync_records where kind = 'api-provider' and id = 'smoke-card';
  r := public.push_sync_records(gen, jsonb_build_array(
    jsonb_build_object('kind', 'api-provider', 'id', 'smoke-card', 'last_seq', card_seq, 'deleted', true,
                       'device_id', 'smoke-a', 'body', '{"value":{}}'::jsonb)));
  if r->0->>'status' <> 'accepted' then raise exception 'SMOKE: tombstone: %', r; end if;
  r := public.push_sync_records(gen, jsonb_build_array(
    jsonb_build_object('kind', 'api-provider', 'id', 'smoke-over', 'last_seq', 0, 'deleted', false,
                       'device_id', 'smoke-a', 'body', '{"value":{}}'::jsonb, 'secrets', '{"key":"sk-over"}'::jsonb)));
  if r->0->>'status' <> 'accepted' then raise exception 'SMOKE: freed slot: %', r; end if;
end $$;

-- 6. delete_my_cloud_data removes A's rows and Vault secrets; B keeps everything.
reset role;
create temp table smoke_a_secrets on commit drop as
  select secret_id from account_private.record_secrets where user_id = '00000000-0000-4000-8000-00000000000a';

set local role authenticated;
select public.delete_my_cloud_data();
reset role;

do $$
declare
  a uuid := '00000000-0000-4000-8000-00000000000a';
  b uuid := '00000000-0000-4000-8000-00000000000b';
begin
  if (select count(*) from smoke_a_secrets) <> 500 then raise exception 'SMOKE: expected 500 A secrets before delete'; end if;
  if exists (select 1 from public.sync_records where user_id = a)
     or exists (select 1 from public.sync_accounts where user_id = a)
     or exists (select 1 from account_private.record_secrets where user_id = a)
     or exists (select 1 from public.records where user_id = a)
     or exists (select 1 from public.devices where user_id = a)
     or exists (select 1 from public.user_keys where user_id = a) then
    raise exception 'SMOKE: delete_my_cloud_data left A rows';
  end if;
  -- Each A secret is gone, or (if Vault refused the delete) blanked and parked.
  if exists (select 1 from smoke_a_secrets s join vault.decrypted_secrets d on d.id = s.secret_id
              where d.decrypted_secret <> '{}'
                 or not exists (select 1 from account_private.orphan_secrets o where o.secret_id = s.secret_id)) then
    raise exception 'SMOKE: an A Vault secret survived delete_my_cloud_data';
  end if;
  if (select count(*) from public.sync_records where user_id = b) <> 3
     or (select count(*) from account_private.record_secrets where user_id = b) <> 1 then
    raise exception 'SMOKE: B data changed by A cloud deletion';
  end if;
end $$;

-- 7. A starts a new generation; the old one is refused.
set local role authenticated;
do $$
declare r jsonb;
begin
  if public.ensure_sync_account()->>'generation' = current_setting('smoke.gen_a') then
    raise exception 'SMOKE: generation reused after cloud deletion';
  end if;
  r := public.push_sync_records(current_setting('smoke.gen_a')::uuid, jsonb_build_array(
    jsonb_build_object('kind', 'conversation', 'id', 'smoke-conv', 'last_seq', 0, 'deleted', false,
                       'device_id', 'smoke-a', 'body', '{"value":{"title":"stale"}}'::jsonb)));
  if r->0->>'code' is distinct from 'CLOUD_DATA_RESET' then raise exception 'SMOKE: stale generation: %', r; end if;
end $$;
reset role;

do $$ begin raise notice 'PLAIN SYNC SMOKE TEST PASSED'; end $$;
rollback;
