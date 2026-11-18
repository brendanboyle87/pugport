-- Smoke test for 0009_server_access_secret.sql. Run it on a Supabase test branch only, never on production:
-- apply 0001-0009 there, then run this whole file in the SQL editor as the role that applied them (postgres).
-- It uses one synthetic user and ends with ROLLBACK, so nothing it creates is kept.
-- Pass: the notice 'SERVER ACCESS SMOKE TEST PASSED' appears. Any failed check raises 'SMOKE: ...' and aborts.
begin;

insert into auth.users (id, aud, role, email)
values ('00000000-0000-4000-8000-00000000000c', 'authenticated', 'authenticated', 'smoke-c@example.test');

do $$
begin
  if has_function_privilege('anon', 'account_private.write_secret(text,text,jsonb)', 'execute')
     or has_function_privilege('anon', 'public.sync_record_stamp()', 'execute')
     or has_function_privilege('authenticated', 'public.sync_record_stamp()', 'execute') then
    raise exception 'SMOKE: function privileges too wide';
  end if;
end $$;

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000000c","role":"authenticated"}', true);
select set_config('smoke.gen_c', public.ensure_sync_account()->>'generation', true);

do $$
declare
  gen uuid := current_setting('smoke.gen_c')::uuid;
  r jsonb;
  node_seq bigint;
begin
  -- Token and access key together, as one Vault secret.
  r := public.push_sync_records(gen, jsonb_build_array(
    jsonb_build_object('kind', 'server-node', 'id', 'smoke-node', 'last_seq', 0, 'deleted', false,
                       'device_id', 'smoke-c', 'body', '{"value":{"name":"synthetic-box"}}'::jsonb,
                       'secrets', '{"token":"smoke-token-1","access":"{\"version\":1}"}'::jsonb)));
  if r->0->>'status' <> 'accepted' then raise exception 'SMOKE: token+access push: %', r; end if;
  node_seq := (r->0->'record'->>'seq')::bigint;
  select e into r from jsonb_array_elements(public.pull_sync_records(0)) e where e->>'id' = 'smoke-node';
  if r->'secrets'->>'token' is distinct from 'smoke-token-1'
     or r->'secrets'->>'access' is distinct from '{"version":1}' then
    raise exception 'SMOKE: token+access pull: %', r;
  end if;

  -- An older client's push carries only the token.
  r := public.push_sync_records(gen, jsonb_build_array(
    jsonb_build_object('kind', 'server-node', 'id', 'smoke-node', 'last_seq', node_seq, 'deleted', false,
                       'device_id', 'smoke-c', 'body', '{"value":{"name":"synthetic-box"}}'::jsonb,
                       'secrets', '{"token":"smoke-token-2"}'::jsonb)));
  if r->0->>'status' <> 'accepted' then raise exception 'SMOKE: token-only push: %', r; end if;

  -- The access key never sits in a body, and no other field becomes a secret.
  r := public.push_sync_records(gen, jsonb_build_array(
    jsonb_build_object('kind', 'server-node', 'id', 'smoke-leak', 'last_seq', 0, 'deleted', false,
                       'device_id', 'smoke-c', 'body', '{"value":{"access":"in-body"}}'::jsonb)));
  if r->0->>'code' is distinct from 'SECRET_IN_BODY' then raise exception 'SMOKE: access in body: %', r; end if;
  r := public.push_sync_records(gen, jsonb_build_array(
    jsonb_build_object('kind', 'server-node', 'id', 'smoke-odd', 'last_seq', 0, 'deleted', false,
                       'device_id', 'smoke-c', 'body', '{"value":{}}'::jsonb,
                       'secrets', '{"token":"t","password":"p"}'::jsonb),
    jsonb_build_object('kind', 'api-provider', 'id', 'smoke-card', 'last_seq', 0, 'deleted', false,
                       'device_id', 'smoke-c', 'body', '{"value":{}}'::jsonb,
                       'secrets', '{"access":"a"}'::jsonb)));
  if r->0->>'code' is distinct from 'INVALID_SECRET' or r->1->>'code' is distinct from 'INVALID_SECRET' then
    raise exception 'SMOKE: unexpected secret fields: %', r;
  end if;
end $$;
reset role;

do $$ begin raise notice 'SERVER ACCESS SMOKE TEST PASSED'; end $$;
rollback;
