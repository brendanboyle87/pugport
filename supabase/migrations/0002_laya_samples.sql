-- Apply as the database owner. Clients retain a random token and call only these RPCs.
begin;

create table public.laya_installs (
  install_id uuid primary key,
  token_hash text not null check (token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now()
);

create table public.laya_samples (
  id uuid primary key default gen_random_uuid(),
  install_id uuid not null references public.laya_installs(install_id) on delete cascade,
  created_at timestamptz not null default now(),
  model_version text check (char_length(model_version)<=64),
  sample jsonb not null check (octet_length(convert_to(sample::text,'UTF8'))<=64*1024),
  app_version text check (char_length(app_version)<=64)
);
create index laya_samples_install_created on public.laya_samples(install_id,created_at);
create index laya_samples_created on public.laya_samples(created_at);

alter table public.laya_installs enable row level security;
alter table public.laya_samples enable row level security;
revoke all on public.laya_installs, public.laya_samples from public, anon, authenticated;

create function public.submit_laya_sample(install_id uuid, token text, model_version text, app_version text, sample jsonb)
returns uuid
language plpgsql security definer set search_path='' as $$
declare
  supplied_hash text;
  stored_hash text;
  received_at timestamptz;
  saved_id uuid;
begin
  if $1 is null or $2 is null or pg_catalog.octet_length(pg_catalog.convert_to($2,'UTF8')) not between 32 and 512 then
    raise exception 'INVALID_LAYA_TOKEN';
  end if;
  if $5 is null then raise exception 'INVALID_LAYA_SAMPLE'; end if;
  if pg_catalog.octet_length(pg_catalog.convert_to($5::text,'UTF8'))>64*1024 then
    raise exception 'LAYA_SAMPLE_TOO_LARGE';
  end if;
  supplied_hash := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to($2,'UTF8')),'hex');

  -- The no-op update locks registration, quota and deletion, and detects stale repeatable-read snapshots.
  insert into public.laya_installs as existing(install_id,token_hash)
    values($1,supplied_hash)
    on conflict on constraint laya_installs_pkey do update set token_hash=existing.token_hash
    returning existing.token_hash into stored_hash;
  if stored_hash<>supplied_hash then raise exception 'INVALID_LAYA_TOKEN'; end if;

  received_at := pg_catalog.clock_timestamp();
  if (select count(*) from public.laya_samples as s
      where s.install_id=$1 and s.created_at>received_at-interval '24 hours')>=500 then
    raise exception 'LAYA_SAMPLE_QUOTA_EXCEEDED';
  end if;
  insert into public.laya_samples(install_id,created_at,model_version,app_version,sample)
    values($1,received_at,$3,$4,$5) returning id into saved_id;
  return saved_id;
end $$;

create function public.delete_laya_samples(install_id uuid, token text)
returns bigint
language plpgsql security definer set search_path='' as $$
declare stored_hash text; deleted_count bigint;
begin
  if $1 is null or $2 is null or pg_catalog.octet_length(pg_catalog.convert_to($2,'UTF8')) not between 32 and 512 then
    raise exception 'INVALID_LAYA_TOKEN';
  end if;
  select i.token_hash into stored_hash from public.laya_installs as i where i.install_id=$1 for update;
  if stored_hash is null or stored_hash<>pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to($2,'UTF8')),'hex') then
    raise exception 'INVALID_LAYA_TOKEN';
  end if;
  delete from public.laya_samples as s where s.install_id=$1;
  get diagnostics deleted_count = row_count;
  delete from public.laya_installs as i where i.install_id=$1;
  return deleted_count;
end $$;

-- An owner-controlled scheduler may call this daily; this migration never enables pg_cron.
create function public.delete_expired_laya_samples() returns bigint
language plpgsql security invoker set search_path='' as $$
declare deleted_count bigint;
begin
  delete from public.laya_samples as s where s.created_at<pg_catalog.clock_timestamp()-interval '2 years';
  get diagnostics deleted_count = row_count;
  return deleted_count;
end $$;

revoke all on function public.submit_laya_sample(uuid,text,text,text,jsonb),public.delete_laya_samples(uuid,text),public.delete_expired_laya_samples() from public, anon, authenticated;
revoke all on function public.delete_expired_laya_samples() from service_role;
grant execute on function public.submit_laya_sample(uuid,text,text,text,jsonb),public.delete_laya_samples(uuid,text) to anon, authenticated;
commit;
