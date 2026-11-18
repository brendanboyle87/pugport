-- Apply as the database owner. Clients use only a publishable key and their user JWT.
begin;

create sequence public.account_sync_seq as bigint;
create table public.records (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  kind text not null check (kind in ('conversation','message','human-message','conversation-folder','project','memory','settings')),
  id text not null check (char_length(id)<=128),
  seq bigint not null,
  body jsonb not null,
  deleted boolean not null default false,
  device_id text not null check (char_length(device_id)<=128),
  key_id uuid not null,
  size bigint not null check (size >= 0),
  server_updated_at timestamptz not null default now(),
  primary key (user_id,kind,id)
);
create index records_user_seq on public.records(user_id,seq);
create table public.devices (
  id text not null check (char_length(id)<=128),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null check (char_length(name)<=128),
  platform text not null check (char_length(platform)<=32),
  last_seen_at timestamptz not null default now(),
  cli_providers jsonb not null default '[]'::jsonb check (jsonb_typeof(cli_providers)='array' and jsonb_array_length(cli_providers)<=8 and octet_length(cli_providers::text)<=1024),
  primary key (user_id,id)
);
create table public.user_keys (
  user_id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  key_id uuid not null default gen_random_uuid(),
  wrapped_key jsonb not null check (octet_length(wrapped_key::text)<=4096),
  kdf_params jsonb not null check (octet_length(kdf_params::text)<=1024)
);

alter table public.records enable row level security;
alter table public.devices enable row level security;
alter table public.user_keys enable row level security;
revoke all on public.records, public.devices, public.user_keys from anon, authenticated;
revoke all on sequence public.account_sync_seq from public, anon, authenticated;
grant select, insert, update on public.records, public.devices to authenticated;
grant select, insert on public.user_keys to authenticated;
grant usage on sequence public.account_sync_seq to authenticated;

create policy records_select on public.records for select to authenticated using ((select auth.uid())=user_id);
create policy records_insert on public.records for insert to authenticated with check ((select auth.uid())=user_id);
create policy records_update on public.records for update to authenticated using ((select auth.uid())=user_id) with check ((select auth.uid())=user_id);
create policy devices_select on public.devices for select to authenticated using ((select auth.uid())=user_id);
create policy devices_insert on public.devices for insert to authenticated with check ((select auth.uid())=user_id);
create policy devices_update on public.devices for update to authenticated using ((select auth.uid())=user_id) with check ((select auth.uid())=user_id);
create policy user_keys_select on public.user_keys for select to authenticated using ((select auth.uid())=user_id);
create policy user_keys_insert on public.user_keys for insert to authenticated with check ((select auth.uid())=user_id);

-- The only quota setting. Counts the actual UTF-8 JSON ciphertext, including tombstones.
create function public.account_sync_quota_bytes() returns bigint
language sql immutable security invoker set search_path='' as $$ select 50::bigint*1024*1024 $$;

create function public.account_sync_owner() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  if TG_OP='UPDATE' and OLD.user_id<>auth.uid() then raise exception 'WRONG_OWNER'; end if;
  NEW.user_id := auth.uid();
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(NEW.user_id::text,0));
  if TG_TABLE_NAME='devices' and TG_OP='INSERT' then
    if not exists(select 1 from public.devices where user_id=auth.uid() and id=NEW.id)
       and (select count(*) from public.devices where user_id=auth.uid())>=20 then
      raise exception 'DEVICE_LIMIT';
    end if;
  end if;
  return NEW;
end $$;
create trigger devices_owner before insert or update on public.devices for each row execute function public.account_sync_owner();
create trigger user_keys_owner before insert or update on public.user_keys for each row execute function public.account_sync_owner();

create function public.account_sync_record() returns trigger
language plpgsql security invoker set search_path='' as $$
declare total bigint; previous bigint := 0;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  if TG_OP='UPDATE' and (OLD.user_id<>auth.uid() or OLD.kind<>NEW.kind or OLD.id<>NEW.id) then
    raise exception 'IMMUTABLE_RECORD_ID';
  end if;
  NEW.user_id := auth.uid();
  -- Serialize all writes for this account, including direct REST writes. Sequence order is commit order per user.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(NEW.user_id::text,0));
  if not exists(select 1 from public.user_keys where user_id=auth.uid() and key_id=NEW.key_id) then
    raise exception 'CLOUD_DATA_RESET';
  end if;
  NEW.size := pg_catalog.octet_length(NEW.body::text) + pg_catalog.octet_length(NEW.id) + pg_catalog.octet_length(NEW.device_id) + 128;
  if NEW.size>512*1024 then raise exception 'RECORD_TOO_LARGE'; end if;
  if TG_OP='UPDATE' then previous := OLD.size; end if;
  select coalesce(sum(size),0) into total from public.records where user_id=auth.uid();
  if total-previous+NEW.size>public.account_sync_quota_bytes() then raise exception 'QUOTA_EXCEEDED'; end if;
  NEW.seq := pg_catalog.nextval('public.account_sync_seq'::regclass);
  NEW.server_updated_at := now();
  return NEW;
end $$;
create trigger records_stamp before insert or update on public.records for each row execute function public.account_sync_record();

create function public.push_records(changes jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare change jsonb; prior public.records; saved public.records; results jsonb := '[]'::jsonb;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  if jsonb_typeof(changes)<>'array' or jsonb_array_length(changes)>100 then raise exception 'INVALID_BATCH'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(auth.uid()::text,0));
  for change in select * from jsonb_array_elements(changes) loop
    if not exists(select 1 from public.user_keys where user_id=auth.uid() and key_id::text=change->>'key_id') then
      results := results || jsonb_build_array(jsonb_build_object('kind',change->>'kind','id',change->>'id','status','error','code','CLOUD_DATA_RESET'));
      continue;
    end if;
    select * into prior from public.records where user_id=auth.uid() and kind=change->>'kind' and id=change->>'id';
    if coalesce(prior.seq,0)<>coalesce((change->>'last_seq')::bigint,-1) then
      results := results || jsonb_build_array(jsonb_build_object('kind',change->>'kind','id',change->>'id','status','conflict','record',to_jsonb(prior)));
      continue;
    end if;
    begin
      if prior.seq is null then
        insert into public.records(kind,id,body,deleted,device_id,key_id,size)
          values(change->>'kind',change->>'id',change->'body',(change->>'deleted')::boolean,change->>'device_id',(change->>'key_id')::uuid,0) returning * into saved;
      else
        update public.records set body=change->'body',deleted=(change->>'deleted')::boolean,device_id=change->>'device_id',key_id=(change->>'key_id')::uuid
          where user_id=auth.uid() and kind=change->>'kind' and id=change->>'id' returning * into saved;
      end if;
      results := results || jsonb_build_array(jsonb_build_object('kind',saved.kind,'id',saved.id,'status','accepted','record',to_jsonb(saved)));
    exception when raise_exception then
      if SQLERRM not in ('QUOTA_EXCEEDED','RECORD_TOO_LARGE') then raise; end if;
      results := results || jsonb_build_array(jsonb_build_object('kind',change->>'kind','id',change->>'id','status','error','code',SQLERRM));
    end;
  end loop;
  return results;
end $$;

-- Deliberately separate from invoker push: only this RPC can physically delete caller-owned rows.
create function public.delete_my_cloud_data() returns void
language plpgsql security definer set search_path='' as $$
declare caller uuid := auth.uid();
begin
  if caller is null then raise exception 'AUTH_REQUIRED'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(caller::text,0));
  delete from public.records where user_id=caller;
  delete from public.devices where user_id=caller;
  delete from public.user_keys where user_id=caller;
end $$;

revoke all on function public.account_sync_quota_bytes(),public.account_sync_owner(),public.account_sync_record(),public.push_records(jsonb),public.delete_my_cloud_data() from public, anon, authenticated;
grant execute on function public.account_sync_quota_bytes(),public.push_records(jsonb),public.delete_my_cloud_data() to authenticated;
commit;
