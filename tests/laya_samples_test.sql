-- Disposable PostgreSQL 14+ only. Never run against a Supabase project or a database with real data.
-- Bootstrap roles anon, authenticated and service_role, apply 0002_laya_samples.sql, then:
-- psql -X -v ON_ERROR_STOP=1 -f tests/laya_samples_test.sql
-- The concurrency checks require the standard dblink extension and local owner authentication.
\set ON_ERROR_STOP on
set statement_timeout='15s';

create function pg_temp.laya_assert(ok boolean, message text) returns void language plpgsql as $$
begin
  if ok is distinct from true then raise exception 'ASSERTION FAILED: %',message; end if;
end $$;

create function pg_temp.laya_expect_error(query text, expected text) returns void language plpgsql as $$
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
  where oid in ('public.laya_installs'::regclass,'public.laya_samples'::regclass)),'RLS enabled on both tables');

do $$
declare client_role text;
begin
  foreach client_role in array array['anon','authenticated'] loop
    perform pg_temp.laya_assert(not has_table_privilege(client_role,'public.laya_samples','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'),'no direct sample grants');
    perform pg_temp.laya_assert(not has_table_privilege(client_role,'public.laya_installs','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'),'no direct install grants');
    perform pg_temp.laya_assert(has_function_privilege(client_role,'public.submit_laya_sample(uuid,text,text,text,jsonb)','EXECUTE'),'submit RPC granted');
    perform pg_temp.laya_assert(has_function_privilege(client_role,'public.delete_laya_samples(uuid,text)','EXECUTE'),'delete RPC granted');
    perform pg_temp.laya_assert(not has_function_privilege(client_role,'public.delete_expired_laya_samples()','EXECUTE'),'cleanup is owner-only');
    execute format('set local role %I',client_role);
    perform pg_temp.laya_expect_error('select * from public.laya_samples','42501');
    perform pg_temp.laya_expect_error('select * from public.laya_installs','42501');
    perform pg_temp.laya_expect_error('select public.delete_expired_laya_samples()','42501');
    execute 'reset role';
  end loop;
  perform pg_temp.laya_assert(not has_function_privilege('service_role','public.delete_expired_laya_samples()','EXECUTE'),'service role cannot clean up');
end $$;

set local role anon;
select public.submit_laya_sample('10000000-0000-0000-0000-000000000001',repeat('a',64),'test-model','test-app','{"task":"synthetic"}');
reset role;
select pg_temp.laya_assert((select token_hash=encode(sha256(convert_to(repeat('a',64),'UTF8')),'hex')
  from public.laya_installs where install_id='10000000-0000-0000-0000-000000000001'),'only token SHA256 stored');
select pg_temp.laya_assert((select model_version='test-model' and app_version='test-app' and sample='{"task":"synthetic"}'::jsonb
  from public.laya_samples where install_id='10000000-0000-0000-0000-000000000001'),'sample and versions saved');
select pg_temp.laya_assert((select created_at>transaction_timestamp() from public.laya_samples
  where install_id='10000000-0000-0000-0000-000000000001'),'submission time is not frozen at transaction start');

select pg_temp.laya_expect_error($q$select public.submit_laya_sample('10000000-0000-0000-0000-000000000001',repeat('b',64),null,null,'{}')$q$,'INVALID_LAYA_TOKEN');
select pg_temp.laya_expect_error($q$select public.delete_laya_samples('10000000-0000-0000-0000-000000000001',repeat('b',64))$q$,'INVALID_LAYA_TOKEN');
select pg_temp.laya_expect_error($q$select public.submit_laya_sample('10000000-0000-0000-0000-000000000003','',null,null,'{}')$q$,'INVALID_LAYA_TOKEN');
select pg_temp.laya_expect_error($q$select public.submit_laya_sample('10000000-0000-0000-0000-000000000003',repeat('a',513),null,null,'{}')$q$,'INVALID_LAYA_TOKEN');
select pg_temp.laya_expect_error($q$select public.submit_laya_sample(null,repeat('a',64),null,null,'{}')$q$,'INVALID_LAYA_TOKEN');
select pg_temp.laya_expect_error($q$select public.delete_laya_samples('10000000-0000-0000-0000-000000000001',null)$q$,'INVALID_LAYA_TOKEN');
select pg_temp.laya_expect_error($q$select public.submit_laya_sample('10000000-0000-0000-0000-000000000003',repeat('a',64),null,null,null)$q$,'INVALID_LAYA_SAMPLE');
select pg_temp.laya_expect_error($q$select public.submit_laya_sample('10000000-0000-0000-0000-000000000003',repeat('a',64),null,null,to_jsonb(repeat('x',65535)))$q$,'LAYA_SAMPLE_TOO_LARGE');
select pg_temp.laya_expect_error($q$select public.submit_laya_sample('10000000-0000-0000-0000-000000000003',repeat('a',64),null,null,to_jsonb(repeat(chr(233),32768)))$q$,'LAYA_SAMPLE_TOO_LARGE');
select pg_temp.laya_assert(not exists(select 1 from public.laya_installs where install_id='10000000-0000-0000-0000-000000000003'),'rejected first upload does not register');

set local role authenticated;
select public.submit_laya_sample('10000000-0000-0000-0000-000000000002',repeat('c',64),null,null,to_jsonb(repeat('x',65534)));
reset role;
select pg_temp.laya_assert((select octet_length(sample::text)=65536 from public.laya_samples
  where install_id='10000000-0000-0000-0000-000000000002'),'exact 64 KiB accepted');
select pg_temp.laya_expect_error($q$insert into public.laya_samples(install_id,sample) values('10000000-0000-0000-0000-000000000002',to_jsonb(repeat('x',65535)))$q$,'23514');

-- RLS still denies access even if someone accidentally grants table privileges.
grant select,insert on public.laya_samples,public.laya_installs to anon;
set local role anon;
select pg_temp.laya_assert((select count(*)=0 from public.laya_samples),'RLS hides samples');
select pg_temp.laya_assert((select count(*)=0 from public.laya_installs),'RLS hides token hashes');
select pg_temp.laya_expect_error($q$insert into public.laya_samples(install_id,sample) values('10000000-0000-0000-0000-000000000001','{}')$q$,'42501');
reset role;
revoke select,insert on public.laya_samples,public.laya_installs from anon;

insert into public.laya_samples(install_id,sample)
  select '10000000-0000-0000-0000-000000000001','{}'::jsonb from generate_series(1,499);
select pg_temp.laya_expect_error($q$select public.submit_laya_sample('10000000-0000-0000-0000-000000000001',repeat('a',64),null,null,'{}')$q$,'LAYA_SAMPLE_QUOTA_EXCEEDED');
update public.laya_samples set created_at=clock_timestamp()-interval '24 hours 1 second'
  where id=(select id from public.laya_samples where install_id='10000000-0000-0000-0000-000000000001' limit 1);
select public.submit_laya_sample('10000000-0000-0000-0000-000000000001',repeat('a',64),null,null,'{}');
select pg_temp.laya_assert((select count(*)=501 from public.laya_samples where install_id='10000000-0000-0000-0000-000000000001'),'rolling window releases expired quota');

insert into public.laya_samples(install_id,sample,created_at)
  values('10000000-0000-0000-0000-000000000001','{}',clock_timestamp()-interval '2 years 1 day');
select pg_temp.laya_assert(public.delete_expired_laya_samples()=1,'cleanup deletes only samples older than two years');
select pg_temp.laya_assert((select count(*)=2 from public.laya_installs),'retention preserves install credentials');
set local role authenticated;
select pg_temp.laya_assert(public.delete_laya_samples('10000000-0000-0000-0000-000000000001',repeat('a',64))=501,'delete returns sample count');
reset role;
select pg_temp.laya_assert(not exists(select 1 from public.laya_samples where install_id='10000000-0000-0000-0000-000000000001'),'own samples deleted');
select pg_temp.laya_assert(not exists(select 1 from public.laya_installs where install_id='10000000-0000-0000-0000-000000000001'),'own install deleted');
select pg_temp.laya_assert((select count(*)=1 from public.laya_samples where install_id='10000000-0000-0000-0000-000000000002'),'other install survives deletion');
select pg_temp.laya_expect_error($q$select public.delete_laya_samples('10000000-0000-0000-0000-000000000001',repeat('a',64))$q$,'INVALID_LAYA_TOKEN');
rollback;

-- Two independent transactions must actually contend before either is released.
create extension if not exists dblink;
select dblink_connect('laya_a',format('dbname=%L application_name=laya_samples_test_a',current_database()));
select dblink_connect('laya_b',format('dbname=%L application_name=laya_samples_test_b',current_database()));
select dblink_exec('laya_a','set statement_timeout=''10s''');
select dblink_exec('laya_b','set statement_timeout=''10s''');
select dblink_exec('laya_a','set role anon');
select dblink_exec('laya_b','set role authenticated');

create function pg_temp.laya_wait_for_lock() returns void language plpgsql as $$
declare deadline timestamptz := clock_timestamp()+interval '5 seconds';
begin
  loop
    perform pg_stat_clear_snapshot();
    if exists(select 1 from pg_stat_activity where application_name='laya_samples_test_b' and wait_event_type='Lock') then return; end if;
    if clock_timestamp()>deadline then raise exception 'Second session did not wait for the install lock'; end if;
    perform pg_sleep(0.01);
  end loop;
end $$;

select dblink_exec('laya_a','begin');
select * from dblink('laya_a',$q$select public.submit_laya_sample('20000000-0000-0000-0000-000000000001',repeat('a',64),null,null,'{}')$q$) as result(id uuid);
select pg_temp.laya_assert(dblink_send_query('laya_b',$q$select public.submit_laya_sample('20000000-0000-0000-0000-000000000001',repeat('b',64),null,null,'{}')$q$)=1,'concurrent registration sent');
select pg_temp.laya_wait_for_lock();
select dblink_exec('laya_a','commit');
select * from dblink_get_result('laya_b',false) as result(id uuid);
select pg_temp.laya_assert(dblink_error_message('laya_b') like '%INVALID_LAYA_TOKEN%','first registration owns the token');
select * from dblink_get_result('laya_b') as result(id uuid);

insert into public.laya_samples(install_id,sample)
  select '20000000-0000-0000-0000-000000000001','{}'::jsonb from generate_series(1,498);
select dblink_exec('laya_a','begin');
select * from dblink('laya_a',$q$select public.submit_laya_sample('20000000-0000-0000-0000-000000000001',repeat('a',64),null,null,'{}')$q$) as result(id uuid);
select pg_temp.laya_assert(dblink_send_query('laya_b',$q$select public.submit_laya_sample('20000000-0000-0000-0000-000000000001',repeat('a',64),null,null,'{}')$q$)=1,'concurrent quota request sent');
select pg_temp.laya_wait_for_lock();
select dblink_exec('laya_a','commit');
select * from dblink_get_result('laya_b',false) as result(id uuid);
select pg_temp.laya_assert(dblink_error_message('laya_b') like '%LAYA_SAMPLE_QUOTA_EXCEEDED%','concurrent requests cannot exceed quota');
select * from dblink_get_result('laya_b') as result(id uuid);
select pg_temp.laya_assert((select count(*)=500 from public.laya_samples where install_id='20000000-0000-0000-0000-000000000001'),'concurrent quota stops at 500');

-- A delete waiting behind a successful upload includes that upload in its count.
select dblink_exec('laya_a','begin');
select * from dblink('laya_a',$q$select public.submit_laya_sample('20000000-0000-0000-0000-000000000002',repeat('c',64),null,null,'{}')$q$) as result(id uuid);
select dblink_exec('laya_a','commit');
select dblink_exec('laya_a','begin');
select * from dblink('laya_a',$q$select public.submit_laya_sample('20000000-0000-0000-0000-000000000002',repeat('c',64),null,null,'{}')$q$) as result(id uuid);
select pg_temp.laya_assert(dblink_send_query('laya_b',$q$select public.delete_laya_samples('20000000-0000-0000-0000-000000000002',repeat('c',64))$q$)=1,'concurrent delete sent');
select pg_temp.laya_wait_for_lock();
select dblink_exec('laya_a','commit');
select pg_temp.laya_assert(deleted=2,'delete sees the committed concurrent upload')
  from dblink_get_result('laya_b') as result(deleted bigint);
select * from dblink_get_result('laya_b') as result(deleted bigint);
select pg_temp.laya_assert(not exists(select 1 from public.laya_samples where install_id='20000000-0000-0000-0000-000000000002'),'concurrent delete leaves no samples');
select pg_temp.laya_assert(not exists(select 1 from public.laya_installs where install_id='20000000-0000-0000-0000-000000000002'),'concurrent delete removes install');

-- A stale repeatable-read snapshot must abort instead of accepting sample 501.
select * from dblink('laya_a',$q$select public.submit_laya_sample('20000000-0000-0000-0000-000000000003',repeat('d',64),null,null,'{}')$q$) as result(id uuid);
insert into public.laya_samples(install_id,sample)
  select '20000000-0000-0000-0000-000000000003','{}'::jsonb from generate_series(1,498);
select dblink_exec('laya_b','begin isolation level repeatable read');
select * from dblink('laya_b','select pg_current_snapshot()::text') as result(snapshot text);
select * from dblink('laya_a',$q$select public.submit_laya_sample('20000000-0000-0000-0000-000000000003',repeat('d',64),null,null,'{}')$q$) as result(id uuid);
select * from dblink('laya_b',$q$select public.submit_laya_sample('20000000-0000-0000-0000-000000000003',repeat('d',64),null,null,'{}')$q$,false) as result(id uuid);
select pg_temp.laya_assert(dblink_error_message('laya_b') like '%could not serialize access%','stale quota snapshots must abort');
select dblink_exec('laya_b','rollback');
select pg_temp.laya_assert(public.delete_laya_samples('20000000-0000-0000-0000-000000000003',repeat('d',64))=500,'repeatable-read quota stops at 500');

select dblink_disconnect('laya_a');
select dblink_disconnect('laya_b');
select pg_temp.laya_assert(public.delete_laya_samples('20000000-0000-0000-0000-000000000001',repeat('a',64))=500,'concurrent fixtures removed');
\echo 'Laya sample permissions, validation, retention, deletion and concurrency checks passed.'
