-- Disposable PostgreSQL 14+ only, with roles anon/authenticated/service_role and local owner authentication.
-- Apply 0002_laya_samples.sql, run its baseline tests, then apply 0003_laya_revoked_installs.sql and run:
-- psql -X -v ON_ERROR_STOP=1 -f tests/laya_revoked_installs_test.sql
-- Never run against a Supabase project or a database containing real data.
\set ON_ERROR_STOP on
set statement_timeout='15s';

create or replace function pg_temp.laya_assert(ok boolean, message text) returns void language plpgsql as $$
begin
  if ok is distinct from true then raise exception 'ASSERTION FAILED: %',message; end if;
end $$;

create or replace function pg_temp.laya_expect_error(query text, expected text) returns void language plpgsql as $$
begin
  begin
    execute query;
  exception when others then
    if SQLERRM=expected or SQLSTATE=expected then return; end if;
    raise;
  end;
  raise exception 'Expected error: %',expected;
end $$;

begin;
select pg_temp.laya_assert((select bool_and(relrowsecurity) from pg_class
  where oid in ('public.laya_installs'::regclass,'public.laya_samples'::regclass)),'RLS remains enabled');
do $$
declare client_role text;
begin
  foreach client_role in array array['anon','authenticated'] loop
    perform pg_temp.laya_assert(not has_table_privilege(client_role,'public.laya_installs','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'),'no direct install grants');
    perform pg_temp.laya_assert(not has_table_privilege(client_role,'public.laya_samples','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'),'no direct sample grants');
    perform pg_temp.laya_assert(has_function_privilege(client_role,'public.submit_laya_sample(uuid,text,text,text,jsonb)','EXECUTE'),'submit remains callable');
    perform pg_temp.laya_assert(has_function_privilege(client_role,'public.delete_laya_samples(uuid,text)','EXECUTE'),'delete remains callable');
    perform pg_temp.laya_assert(not has_function_privilege(client_role,'public.delete_expired_laya_samples()','EXECUTE'),'cleanup remains owner-only');
  end loop;
end $$;

set local role anon;
select public.submit_laya_sample('30000000-0000-0000-0000-000000000001',repeat('a',64),'test-model','test-app','{"synthetic":1}');
select public.submit_laya_sample('30000000-0000-0000-0000-000000000001',repeat('a',64),null,null,'{"synthetic":2}');
select public.submit_laya_sample('30000000-0000-0000-0000-000000000002',repeat('b',64),null,null,'{}');
select pg_temp.laya_assert(public.delete_laya_samples('30000000-0000-0000-0000-000000000001',repeat('a',64))=2,'first deletion returns removed count');
reset role;
select pg_temp.laya_assert((select revoked_at is not null and deleted_count=2
  and token_hash=encode(sha256(convert_to(repeat('a',64),'UTF8')),'hex')
  from public.laya_installs where install_id='30000000-0000-0000-0000-000000000001'),'tombstone retains only hash and deletion receipt');
select pg_temp.laya_assert(not exists(select 1 from public.laya_samples where install_id='30000000-0000-0000-0000-000000000001'),'samples removed');
select pg_temp.laya_assert((select count(*)=1 from public.laya_samples where install_id='30000000-0000-0000-0000-000000000002'),'other install untouched');
set local role authenticated;
select pg_temp.laya_assert(public.delete_laya_samples('30000000-0000-0000-0000-000000000001',repeat('a',64))=2,'lost-response retry returns original count');
select pg_temp.laya_expect_error($q$select public.submit_laya_sample('30000000-0000-0000-0000-000000000001',repeat('a',64),null,null,'{}')$q$,'LAYA_INSTALL_REVOKED');
select pg_temp.laya_expect_error($q$select public.submit_laya_sample('30000000-0000-0000-0000-000000000001',repeat('z',64),null,null,'{}')$q$,'INVALID_LAYA_TOKEN');
select pg_temp.laya_expect_error($q$select public.delete_laya_samples('30000000-0000-0000-0000-000000000001',repeat('z',64))$q$,'INVALID_LAYA_TOKEN');
select pg_temp.laya_expect_error($q$select public.delete_laya_samples('30000000-0000-0000-0000-000000000002',repeat('z',64))$q$,'INVALID_LAYA_TOKEN');

-- A delete can win before even the first upload reaches the database.
select pg_temp.laya_assert(public.delete_laya_samples('30000000-0000-0000-0000-000000000003',repeat('c',64))=0,'unseen install is revoked with zero count');
select pg_temp.laya_expect_error($q$select public.submit_laya_sample('30000000-0000-0000-0000-000000000003',repeat('c',64),null,null,'{}')$q$,'LAYA_INSTALL_REVOKED');
select pg_temp.laya_assert(public.delete_laya_samples('30000000-0000-0000-0000-000000000003',repeat('c',64))=0,'unseen-delete retry remains zero');
select pg_temp.laya_expect_error($q$select public.delete_laya_samples('30000000-0000-0000-0000-000000000004',null)$q$,'INVALID_LAYA_TOKEN');
select pg_temp.laya_expect_error($q$select public.submit_laya_sample('30000000-0000-0000-0000-000000000004',repeat('d',64),null,null,null)$q$,'INVALID_LAYA_SAMPLE');
select pg_temp.laya_expect_error($q$select public.submit_laya_sample('30000000-0000-0000-0000-000000000004',repeat('d',64),null,null,to_jsonb(repeat('x',65535)))$q$,'LAYA_SAMPLE_TOO_LARGE');
reset role;
select pg_temp.laya_assert(not exists(select 1 from public.laya_installs where install_id='30000000-0000-0000-0000-000000000004'),'invalid requests do not register');
insert into public.laya_samples(install_id,sample)
  select '30000000-0000-0000-0000-000000000002','{}'::jsonb from generate_series(1,499);
select pg_temp.laya_expect_error($q$select public.submit_laya_sample('30000000-0000-0000-0000-000000000002',repeat('b',64),null,null,'{}')$q$,'LAYA_SAMPLE_QUOTA_EXCEEDED');
rollback;

create extension if not exists dblink;
select dblink_connect('laya_revoke_a',format('dbname=%L application_name=laya_revoke_test_a',current_database()));
select dblink_connect('laya_revoke_b',format('dbname=%L application_name=laya_revoke_test_b',current_database()));
select dblink_exec('laya_revoke_a','set statement_timeout=''10s''');
select dblink_exec('laya_revoke_b','set statement_timeout=''10s''');
select dblink_exec('laya_revoke_a','set role anon');
select dblink_exec('laya_revoke_b','set role authenticated');

create or replace function pg_temp.laya_wait_for_revoke_lock() returns void language plpgsql as $$
declare deadline timestamptz := clock_timestamp()+interval '5 seconds';
begin
  loop
    perform pg_stat_clear_snapshot();
    if exists(select 1 from pg_stat_activity where application_name='laya_revoke_test_b' and wait_event_type='Lock') then return; end if;
    if clock_timestamp()>deadline then raise exception 'Second session did not wait for the install lock'; end if;
    perform pg_sleep(0.01);
  end loop;
end $$;

-- Upload wins first: a waiting deletion includes its committed sample and then seals the ID.
select dblink_exec('laya_revoke_a','begin');
select * from dblink('laya_revoke_a',$q$select public.submit_laya_sample('40000000-0000-0000-0000-000000000001',repeat('a',64),null,null,'{}')$q$) as result(id uuid);
select pg_temp.laya_assert(dblink_send_query('laya_revoke_b',$q$select public.delete_laya_samples('40000000-0000-0000-0000-000000000001',repeat('a',64))$q$)=1,'delete queued behind first upload');
select pg_temp.laya_wait_for_revoke_lock();
select dblink_exec('laya_revoke_a','commit');
select pg_temp.laya_assert(deleted=1,'delete counts preceding upload') from dblink_get_result('laya_revoke_b') as result(deleted bigint);
select * from dblink_get_result('laya_revoke_b') as result(deleted bigint);
select pg_temp.laya_expect_error($q$select public.submit_laya_sample('40000000-0000-0000-0000-000000000001',repeat('a',64),null,null,'{}')$q$,'LAYA_INSTALL_REVOKED');

-- Delete wins before first registration: the blocked upload must reject the committed tombstone.
select dblink_exec('laya_revoke_a','begin');
select * from dblink('laya_revoke_a',$q$select public.delete_laya_samples('40000000-0000-0000-0000-000000000002',repeat('b',64))$q$) as result(deleted bigint);
select pg_temp.laya_assert(dblink_send_query('laya_revoke_b',$q$select public.submit_laya_sample('40000000-0000-0000-0000-000000000002',repeat('b',64),null,null,'{}')$q$)=1,'upload queued behind unseen-install deletion');
select pg_temp.laya_wait_for_revoke_lock();
select dblink_exec('laya_revoke_a','commit');
select * from dblink_get_result('laya_revoke_b',false) as result(id uuid);
select pg_temp.laya_assert(dblink_error_message('laya_revoke_b') like '%LAYA_INSTALL_REVOKED%','delayed first upload cannot resurrect ID');
select * from dblink_get_result('laya_revoke_b') as result(id uuid);

-- Concurrent retries return the same receipt, rather than losing the original removed count.
select public.submit_laya_sample('40000000-0000-0000-0000-000000000003',repeat('c',64),null,null,'{}');
select dblink_exec('laya_revoke_a','begin');
select pg_temp.laya_assert(deleted=1,'first concurrent deletion count')
  from dblink('laya_revoke_a',$q$select public.delete_laya_samples('40000000-0000-0000-0000-000000000003',repeat('c',64))$q$) as result(deleted bigint);
select pg_temp.laya_assert(dblink_send_query('laya_revoke_b',$q$select public.delete_laya_samples('40000000-0000-0000-0000-000000000003',repeat('c',64))$q$)=1,'retry queued behind deletion');
select pg_temp.laya_wait_for_revoke_lock();
select dblink_exec('laya_revoke_a','commit');
select pg_temp.laya_assert(deleted=1,'concurrent retry returns original count') from dblink_get_result('laya_revoke_b') as result(deleted bigint);
select * from dblink_get_result('laya_revoke_b') as result(deleted bigint);

-- A snapshot taken before revocation must abort rather than reviving the installation.
select public.submit_laya_sample('40000000-0000-0000-0000-000000000004',repeat('d',64),null,null,'{}');
select dblink_exec('laya_revoke_b','begin isolation level repeatable read');
select * from dblink('laya_revoke_b','select pg_current_snapshot()::text') as result(snapshot text);
select * from dblink('laya_revoke_a',$q$select public.delete_laya_samples('40000000-0000-0000-0000-000000000004',repeat('d',64))$q$) as result(deleted bigint);
select * from dblink('laya_revoke_b',$q$select public.submit_laya_sample('40000000-0000-0000-0000-000000000004',repeat('d',64),null,null,'{}')$q$,false) as result(id uuid);
select pg_temp.laya_assert(dblink_error_message('laya_revoke_b') like '%could not serialize access%','stale revocation snapshot aborts');
select dblink_exec('laya_revoke_b','rollback');
select pg_temp.laya_assert(public.delete_laya_samples('40000000-0000-0000-0000-000000000004',repeat('d',64))=1,'receipt survives serialization failure');

select dblink_disconnect('laya_revoke_a');
select dblink_disconnect('laya_revoke_b');
select pg_temp.laya_assert(not exists(select 1 from public.laya_samples where install_id in (
  '40000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000002',
  '40000000-0000-0000-0000-000000000003','40000000-0000-0000-0000-000000000004')),'no racing upload survives deletion');
delete from public.laya_installs where install_id in (
  '40000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000002',
  '40000000-0000-0000-0000-000000000003','40000000-0000-0000-0000-000000000004');
\echo 'Laya revocation, idempotent deletion and concurrency checks passed.'
