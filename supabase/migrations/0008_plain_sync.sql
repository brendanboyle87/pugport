-- Plain (not end-to-end encrypted) account sync. Apply as the database owner after review.
-- Safe while old clients run: legacy tables keep working until an account finishes its one-time
-- upgrade (sync_accounts.legacy_migrated_at); after that, legacy writes fail with CLIENT_UPGRADE_REQUIRED.
-- Legacy data is removed later by 0009. Uses only Supabase Vault's public API.
begin;

create extension if not exists supabase_vault with schema vault;

-- Never add this schema to the API's exposed schemas.
create schema if not exists account_private;
revoke all on schema account_private from public, anon;
grant usage on schema account_private to authenticated;

-- One row per account. Cloud deletion removes it; the next ensure_sync_account() starts a new generation,
-- which stops stale computers from re-uploading into the emptied cloud.
create table public.sync_accounts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  generation uuid not null default gen_random_uuid(),
  legacy_migrated_at timestamptz,
  legacy_migrated_by text check (char_length(legacy_migrated_by) <= 128),
  created_at timestamptz not null default now()
);

create table public.sync_records (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  kind text not null constraint sync_records_kind_check check (kind in (
    'conversation','message','human-message','conversation-folder','project','memory','settings',
    'remote-server','server-node','api-provider')),
  id text not null check (char_length(id) <= 128),
  seq bigint not null,
  body jsonb not null check (jsonb_typeof(body) = 'object'),
  deleted boolean not null default false,
  device_id text not null check (char_length(device_id) <= 128),
  size bigint not null check (size >= 0),
  server_updated_at timestamptz not null default now(),
  primary key (user_id, kind, id)
);
create index sync_records_user_seq on public.sync_records(user_id, seq);

-- Maps a record to its Vault secret. No client role can read or write this table.
create table account_private.record_secrets (
  user_id uuid not null,
  kind text not null check (kind in ('api-provider','server-node')),
  id text not null,
  secret_id uuid not null unique,
  primary key (user_id, kind, id),
  foreign key (user_id, kind, id) references public.sync_records(user_id, kind, id) on delete cascade
);

-- Vault rows whose delete was refused. They are blanked first; the database owner removes them later.
create table account_private.orphan_secrets (
  secret_id uuid primary key,
  user_id uuid not null,
  failed_at timestamptz not null default now()
);

alter table public.sync_accounts enable row level security;
alter table public.sync_records enable row level security;
alter table account_private.record_secrets enable row level security;
alter table account_private.orphan_secrets enable row level security;
revoke all on public.sync_accounts, public.sync_records from anon, authenticated;
revoke all on account_private.record_secrets, account_private.orphan_secrets from public, anon, authenticated;
grant select on public.sync_accounts to authenticated;
grant select, insert, update on public.sync_records to authenticated;

create policy sync_accounts_select on public.sync_accounts for select to authenticated
  using ((select auth.uid()) = user_id);
create policy sync_records_select on public.sync_records for select to authenticated
  using ((select auth.uid()) = user_id);
create policy sync_records_insert on public.sync_records for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy sync_records_update on public.sync_records for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

-- Same rules as account_sync_record() in 0001, minus the key check, plus the secret-in-body guard.
create function public.sync_record_stamp() returns trigger
language plpgsql security invoker set search_path = '' as $$
declare total bigint; previous bigint := 0;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  if TG_OP = 'UPDATE' and (OLD.user_id <> auth.uid() or OLD.kind <> NEW.kind or OLD.id <> NEW.id) then
    raise exception 'IMMUTABLE_RECORD_ID';
  end if;
  NEW.user_id := auth.uid();
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(NEW.user_id::text, 0));
  if not exists (select 1 from public.sync_accounts where user_id = auth.uid()) then
    raise exception 'CLOUD_DATA_RESET';
  end if;
  if (NEW.kind = 'api-provider' and NEW.body->'value' ? 'key')
     or (NEW.kind = 'server-node' and NEW.body->'value' ? 'token') then
    raise exception 'SECRET_IN_BODY';
  end if;
  NEW.size := pg_catalog.octet_length(NEW.body::text) + pg_catalog.octet_length(NEW.id)
            + pg_catalog.octet_length(NEW.device_id) + 128;
  if NEW.size > 512 * 1024 then raise exception 'RECORD_TOO_LARGE'; end if;
  if TG_OP = 'UPDATE' then previous := OLD.size; end if;
  select coalesce(sum(size), 0) into total from public.sync_records where user_id = auth.uid();
  if total - previous + NEW.size > public.account_sync_quota_bytes() then raise exception 'QUOTA_EXCEEDED'; end if;
  -- Shared with legacy records: every plain seq is newer than every legacy seq.
  NEW.seq := pg_catalog.nextval('public.account_sync_seq'::regclass);
  NEW.server_updated_at := now();
  return NEW;
end $$;
create trigger sync_records_stamp before insert or update on public.sync_records
  for each row execute function public.sync_record_stamp();

-- STABLE: inside one pull statement, bodies and secrets come from the same snapshot.
create function account_private.read_secret(p_kind text, p_id text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select d.decrypted_secret::jsonb
    from account_private.record_secrets s
    join vault.decrypted_secrets d on d.id = s.secret_id
   where s.user_id = auth.uid() and s.kind = p_kind and s.id = p_id
$$;

-- Retries refused Vault deletes. Any failure leaves the blanked rows for the database owner.
create function account_private.purge_orphan_secrets(p_user uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  delete from vault.secrets where id in (select secret_id from account_private.orphan_secrets where user_id = p_user);
  delete from account_private.orphan_secrets where user_id = p_user;
exception when others then
  null;
end $$;

-- Vault rows count toward a per-user cap (orphans included); 500 secrets of at most 8 KiB each.
create function account_private.secret_count(p_user uuid) returns bigint
language sql stable security invoker set search_path = '' as $$
  select (select count(*) from account_private.record_secrets where user_id = p_user)
       + (select count(*) from account_private.orphan_secrets where user_id = p_user)
$$;

create function account_private.write_secret(p_kind text, p_id text, p_secrets jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  existing uuid;
  allowed text := case p_kind when 'api-provider' then 'key' when 'server-node' then 'token' end;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  if allowed is null then raise exception 'INVALID_SECRET'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(auth.uid()::text, 0));
  select secret_id into existing from account_private.record_secrets
   where user_id = auth.uid() and kind = p_kind and id = p_id;
  if p_secrets is null or p_secrets = '{}'::jsonb then
    -- The delete trigger removes the Vault row.
    delete from account_private.record_secrets where user_id = auth.uid() and kind = p_kind and id = p_id;
    return;
  end if;
  if jsonb_typeof(p_secrets) <> 'object' or pg_catalog.octet_length(p_secrets::text) > 8192
     or exists (select 1 from jsonb_each(p_secrets) e where e.key <> allowed or jsonb_typeof(e.value) <> 'string') then
    raise exception 'INVALID_SECRET';
  end if;
  if existing is null then
    if account_private.secret_count(auth.uid()) >= 500 then
      perform account_private.purge_orphan_secrets(auth.uid());
      if account_private.secret_count(auth.uid()) >= 500 then raise exception 'SECRET_LIMIT'; end if;
    end if;
    insert into account_private.record_secrets(user_id, kind, id, secret_id)
      values (auth.uid(), p_kind, p_id, vault.create_secret(p_secrets::text));
  else
    perform vault.update_secret(existing, p_secrets::text);
  end if;
end $$;

-- Covers tombstones, cloud deletion and auth.users cascades. A refused Vault delete never fails the
-- tombstone or the cloud deletion: the secret is blanked and parked in orphan_secrets instead.
create function account_private.drop_vault_secret() returns trigger
language plpgsql security definer set search_path = '' as $$
declare failure text;
begin
  begin
    delete from vault.secrets where id = OLD.secret_id;
  exception when others then
    failure := SQLERRM;
    begin
      perform vault.update_secret(OLD.secret_id, '{}');
    exception when others then
      null;
    end;
    insert into account_private.orphan_secrets(secret_id, user_id) values (OLD.secret_id, OLD.user_id)
      on conflict (secret_id) do nothing;
    raise warning 'VAULT_DELETE_FAILED %: %', OLD.secret_id, failure;
  end;
  return OLD;
end $$;
create trigger record_secrets_drop_vault after delete on account_private.record_secrets
  for each row execute function account_private.drop_vault_secret();

create function public.ensure_sync_account() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare caller uuid := auth.uid(); account public.sync_accounts; legacy_key uuid;
begin
  if caller is null then raise exception 'AUTH_REQUIRED'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(caller::text, 0));
  insert into public.sync_accounts(user_id) values (caller) on conflict (user_id) do nothing;
  select * into account from public.sync_accounts where user_id = caller;
  select key_id into legacy_key from public.user_keys where user_id = caller;
  return jsonb_build_object(
    'generation', account.generation,
    'legacy_pending', legacy_key is not null and account.legacy_migrated_at is null,
    'legacy_key_id', legacy_key);
end $$;

create function public.finish_legacy_migration(p_device_id text) returns void
language plpgsql security definer set search_path = '' as $$
declare caller uuid := auth.uid();
begin
  if caller is null then raise exception 'AUTH_REQUIRED'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(caller::text, 0));
  update public.sync_accounts
     set legacy_migrated_at = coalesce(legacy_migrated_at, now()),
         legacy_migrated_by = coalesce(legacy_migrated_by, left(p_device_id, 128))
   where user_id = caller;
  if not found then raise exception 'CLOUD_DATA_RESET'; end if;
end $$;

create function public.push_sync_records(p_generation uuid, changes jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare change jsonb; prior public.sync_records; saved public.sync_records; results jsonb := '[]'::jsonb;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  if jsonb_typeof(changes) <> 'array' or jsonb_array_length(changes) > 100 then raise exception 'INVALID_BATCH'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(auth.uid()::text, 0));
  if not exists (select 1 from public.sync_accounts where user_id = auth.uid() and generation = p_generation) then
    select coalesce(jsonb_agg(jsonb_build_object('kind', c->>'kind', 'id', c->>'id',
                                                 'status', 'error', 'code', 'CLOUD_DATA_RESET')), '[]'::jsonb)
      into results from jsonb_array_elements(changes) c;
    return results;
  end if;
  for change in select * from jsonb_array_elements(changes) loop
    select * into prior from public.sync_records
     where user_id = auth.uid() and kind = change->>'kind' and id = change->>'id';
    if coalesce(prior.seq, 0) <> coalesce((change->>'last_seq')::bigint, -1) then
      results := results || jsonb_build_array(jsonb_build_object(
        'kind', change->>'kind', 'id', change->>'id', 'status', 'conflict',
        'record', case when prior.seq is null then null else to_jsonb(prior) - 'user_id' end,
        'secrets', case when prior.seq is null or prior.deleted then null
                        else account_private.read_secret(prior.kind, prior.id) end));
      continue;
    end if;
    begin
      if prior.seq is null then
        insert into public.sync_records(kind, id, body, deleted, device_id, size)
          values (change->>'kind', change->>'id', change->'body', (change->>'deleted')::boolean, change->>'device_id', 0)
          returning * into saved;
      else
        update public.sync_records
           set body = change->'body', deleted = (change->>'deleted')::boolean, device_id = change->>'device_id'
         where user_id = auth.uid() and kind = change->>'kind' and id = change->>'id'
         returning * into saved;
      end if;
      if saved.kind in ('api-provider', 'server-node') then
        perform account_private.write_secret(saved.kind, saved.id,
          case when saved.deleted then null else change->'secrets' end);
      end if;
      results := results || jsonb_build_array(jsonb_build_object(
        'kind', saved.kind, 'id', saved.id, 'status', 'accepted', 'record', to_jsonb(saved) - 'user_id'));
    exception when raise_exception then
      if SQLERRM not in ('QUOTA_EXCEEDED', 'RECORD_TOO_LARGE', 'SECRET_IN_BODY', 'INVALID_SECRET', 'SECRET_LIMIT') then
        raise;
      end if;
      results := results || jsonb_build_array(jsonb_build_object(
        'kind', change->>'kind', 'id', change->>'id', 'status', 'error', 'code', SQLERRM));
    end;
  end loop;
  return results;
end $$;

create function public.pull_sync_records(after_seq bigint, max_rows integer default 200) returns jsonb
language sql stable security invoker set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'kind', r.kind, 'id', r.id, 'seq', r.seq, 'body', r.body, 'deleted', r.deleted,
           'device_id', r.device_id, 'size', r.size, 'server_updated_at', r.server_updated_at,
           'secrets', case when r.kind in ('api-provider', 'server-node') and not r.deleted
                           then account_private.read_secret(r.kind, r.id) end)
         order by r.seq), '[]'::jsonb)
    from (select * from public.sync_records
           where user_id = auth.uid() and seq > after_seq
           order by seq
           limit least(greatest(max_rows, 1), 200)) r
$$;

-- Deletes old and new cloud data. Records cascade to record_secrets, whose trigger removes Vault rows.
create or replace function public.delete_my_cloud_data() returns void
language plpgsql security definer set search_path = '' as $$
declare caller uuid := auth.uid();
begin
  if caller is null then raise exception 'AUTH_REQUIRED'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(caller::text, 0));
  delete from public.sync_records where user_id = caller;
  delete from public.sync_accounts where user_id = caller;
  delete from public.records where user_id = caller;
  delete from public.devices where user_id = caller;
  delete from public.user_keys where user_id = caller;
  perform account_private.purge_orphan_secrets(caller);
end $$;

-- Legacy guard: once an account is migrated, old builds cannot write encrypted records.
-- Same body as 0001 plus the CLIENT_UPGRADE_REQUIRED check.
create or replace function public.account_sync_record() returns trigger
language plpgsql security invoker set search_path = '' as $$
declare total bigint; previous bigint := 0;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  if TG_OP = 'UPDATE' and (OLD.user_id <> auth.uid() or OLD.kind <> NEW.kind or OLD.id <> NEW.id) then
    raise exception 'IMMUTABLE_RECORD_ID';
  end if;
  NEW.user_id := auth.uid();
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(NEW.user_id::text, 0));
  if exists (select 1 from public.sync_accounts where user_id = auth.uid() and legacy_migrated_at is not null) then
    raise exception 'CLIENT_UPGRADE_REQUIRED';
  end if;
  if not exists (select 1 from public.user_keys where user_id = auth.uid() and key_id = NEW.key_id) then
    raise exception 'CLOUD_DATA_RESET';
  end if;
  NEW.size := pg_catalog.octet_length(NEW.body::text) + pg_catalog.octet_length(NEW.id)
            + pg_catalog.octet_length(NEW.device_id) + 128;
  if NEW.size > 512 * 1024 then raise exception 'RECORD_TOO_LARGE'; end if;
  if TG_OP = 'UPDATE' then previous := OLD.size; end if;
  select coalesce(sum(size), 0) into total from public.records where user_id = auth.uid();
  if total - previous + NEW.size > public.account_sync_quota_bytes() then raise exception 'QUOTA_EXCEEDED'; end if;
  NEW.seq := pg_catalog.nextval('public.account_sync_seq'::regclass);
  NEW.server_updated_at := now();
  return NEW;
end $$;

create function public.legacy_key_retired() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if exists (select 1 from public.sync_accounts where user_id = auth.uid()) then
    raise exception 'CLIENT_UPGRADE_REQUIRED';
  end if;
  return NEW;
end $$;
create trigger user_keys_retired before insert on public.user_keys
  for each row execute function public.legacy_key_retired();

revoke all on function
  public.sync_record_stamp(), public.legacy_key_retired(),
  account_private.read_secret(text, text), account_private.write_secret(text, text, jsonb),
  account_private.drop_vault_secret(), account_private.purge_orphan_secrets(uuid),
  account_private.secret_count(uuid),
  public.ensure_sync_account(), public.finish_legacy_migration(text),
  public.push_sync_records(uuid, jsonb), public.pull_sync_records(bigint, integer)
  from public, anon, authenticated;
grant execute on function
  account_private.read_secret(text, text), account_private.write_secret(text, text, jsonb),
  public.ensure_sync_account(), public.finish_legacy_migration(text),
  public.push_sync_records(uuid, jsonb), public.pull_sync_records(bigint, integer)
  to authenticated;
commit;
