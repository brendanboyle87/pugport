-- Apply after 0003 as the database owner. Bound hourly sample writes and new installation registrations.
begin;

create or replace function public.submit_laya_sample(install_id uuid, token text, model_version text, app_version text, sample jsonb)
returns uuid
language plpgsql security definer set search_path='' as $$
declare
  supplied_hash text;
  stored_hash text;
  revoked_time timestamptz;
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

  if not exists (select 1 from public.laya_installs as i where i.install_id=$1) then
    if (select count(*) from public.laya_installs as i
        where i.created_at>pg_catalog.statement_timestamp()-interval '1 hour')>2000 then
      raise exception 'LAYA_INSTALL_RATE_LIMITED';
    end if;
  end if;

  -- Registration, revocation and quota checks all serialize on this row, including stale snapshots.
  insert into public.laya_installs as existing(install_id,token_hash)
    values($1,supplied_hash)
    on conflict on constraint laya_installs_pkey do update set token_hash=existing.token_hash
    returning existing.token_hash,existing.revoked_at into stored_hash,revoked_time;
  if stored_hash<>supplied_hash then raise exception 'INVALID_LAYA_TOKEN'; end if;
  if revoked_time is not null then raise exception 'LAYA_INSTALL_REVOKED'; end if;

  received_at := pg_catalog.clock_timestamp();
  if (select count(*) from public.laya_samples as s
      where s.install_id=$1 and s.created_at>received_at-interval '24 hours')>=500 then
    raise exception 'LAYA_SAMPLE_QUOTA_EXCEEDED';
  end if;
  if (select count(*) from public.laya_samples as s
      where s.created_at>received_at-interval '1 hour')>20000 then
    raise exception 'LAYA_GLOBAL_RATE_LIMITED';
  end if;
  insert into public.laya_samples(install_id,created_at,model_version,app_version,sample)
    values($1,received_at,$3,$4,$5) returning id into saved_id;
  return saved_id;
end $$;

-- No table grants, RLS changes or cleanup scheduling; retain the existing public RPC boundary.
revoke all on function public.submit_laya_sample(uuid,text,text,text,jsonb),public.delete_laya_samples(uuid,text) from public, anon, authenticated;
grant execute on function public.submit_laya_sample(uuid,text,text,text,jsonb),public.delete_laya_samples(uuid,text) to anon, authenticated;
commit;
