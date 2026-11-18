-- Files only: apply and deploy after owner review.
begin;

create sequence public.problem_report_seq start 1000;
create table public.problem_reports (
  id text primary key default 'PP-' || nextval('public.problem_report_seq'),
  created_at timestamptz not null default now(),
  install_hash text not null,
  ip_hash text not null,
  version text not null,
  os text not null,
  description text not null check (char_length(description) <= 4000),
  diagnostics jsonb not null check (jsonb_typeof(diagnostics) = 'object'),
  status text not null default 'new' check (status in ('new','seen','fixed','ignored')),
  secret_hash text not null,
  fingerprint text,
  duplicate_of text references public.problem_reports(id),
  fixed_in text
);
create index problem_reports_install_time on public.problem_reports(install_hash, created_at);
create index problem_reports_ip_time on public.problem_reports(ip_hash, created_at);
create index problem_reports_open_fingerprint on public.problem_reports(fingerprint) where status in ('new','seen');
create index problem_reports_duplicates on public.problem_reports(duplicate_of);
create unique index problem_reports_secret_hash on public.problem_reports(secret_hash);
create index problem_reports_created_at on public.problem_reports(created_at);
create table public.problem_report_files (
  report_id text not null references public.problem_reports(id) on delete cascade,
  path text primary key,
  ready boolean not null default false,
  created_at timestamptz not null default now()
);
-- Accounts allowed to read reports (the admin function checks this when OWNER_USER_ID is unset).
create table public.problem_report_admins (user_id uuid primary key);
alter table public.problem_report_admins enable row level security;
revoke all on public.problem_report_admins from public, anon, authenticated;
grant all on public.problem_report_admins to service_role;
alter table public.problem_reports enable row level security;
alter table public.problem_report_files enable row level security;
revoke all on public.problem_reports, public.problem_report_files from public, anon, authenticated;
revoke all on sequence public.problem_report_seq from public, anon, authenticated;
grant all on public.problem_reports, public.problem_report_files to service_role;
grant usage, select on sequence public.problem_report_seq to service_role;

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('problem-report-files', 'problem-report-files', false, 1048576, array['image/jpeg','image/webp']);

-- A single lock serializes the short quota check and insert across edge workers.
create function public.create_problem_report(
  p_install_hash text, p_ip_hash text, p_version text, p_os text,
  p_description text, p_diagnostics text, p_secret_hash text, p_fingerprint text
) returns text language plpgsql security invoker set search_path = '' as $$
declare report_id text; duplicate_id text;
begin
  -- Measure the transmitted JSON, before jsonb adds display whitespace.
  if octet_length(p_diagnostics) > 204800 then raise exception 'DIAGNOSTICS_LIMIT'; end if;
  perform pg_advisory_xact_lock(714206);
  select id into report_id from public.problem_reports where secret_hash=p_secret_hash;
  if found then return report_id; end if;
  if (select count(*) from public.problem_reports where install_hash=p_install_hash and created_at > now()-interval '1 hour') >= 5
    or (select count(*) from public.problem_reports where ip_hash=p_ip_hash and created_at > now()-interval '1 hour') >= 20
    or (select count(*) from public.problem_reports where created_at > now()-interval '1 hour') >= 300 then
    raise exception 'RATE_LIMIT' using errcode='P0001';
  end if;
  if p_fingerprint is not null then
    select id into duplicate_id from public.problem_reports
      where fingerprint=p_fingerprint and status in ('new','seen') and duplicate_of is null
      order by created_at limit 1;
  end if;
  insert into public.problem_reports(install_hash,ip_hash,version,os,description,diagnostics,secret_hash,fingerprint,duplicate_of)
    values(p_install_hash,p_ip_hash,p_version,p_os,p_description,p_diagnostics::jsonb,p_secret_hash,p_fingerprint,duplicate_id)
    on conflict (secret_hash) do update set secret_hash = excluded.secret_hash
    returning id into report_id;
  return report_id;
end $$;

-- Reservations count toward the limit even while another worker uploads.
create function public.reserve_problem_report_files(p_id text, p_secret_hash text, p_paths text[])
returns void language plpgsql security invoker set search_path = '' as $$
begin
  perform 1 from public.problem_reports where id=p_id and secret_hash=p_secret_hash for update;
  if not found then raise exception 'REPORT_NOT_FOUND'; end if;
  if cardinality(p_paths) < 1 or cardinality(p_paths) > 4 or
    (select count(*) from public.problem_report_files where report_id=p_id)+
    (select count(distinct candidate.path) from unnest(p_paths) candidate(path) where not exists
      (select 1 from public.problem_report_files f where f.path=candidate.path)) > 4 then
    raise exception 'IMAGE_LIMIT';
  end if;
  insert into public.problem_report_files(report_id,path) select p_id, unnest(p_paths) on conflict do nothing;
end $$;
revoke all on function public.create_problem_report(text,text,text,text,text,text,text,text) from public, anon, authenticated;
revoke all on function public.reserve_problem_report_files(text,text,text[]) from public, anon, authenticated;
grant execute on function public.create_problem_report(text,text,text,text,text,text,text,text) to service_role;
grant execute on function public.reserve_problem_report_files(text,text,text[]) to service_role;
commit;
