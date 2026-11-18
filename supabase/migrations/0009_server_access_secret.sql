-- Account-bound server access (owner ruling 2026-11-16): a server node's record may carry a second secret,
-- `access` (the account's tunnel-only SSH key and where it connects), next to the pairing `token`. Both live in the
-- record's one Vault secret. Apply as the database owner after 0008, before releasing a client that sends `access`;
-- until then such a push fails with INVALID_SECRET. Older clients keep working: they only read `token`.
-- Only these two functions change; their bodies are 0008's apart from the allowed field list.
begin;

create or replace function public.sync_record_stamp() returns trigger
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
     or (NEW.kind = 'server-node' and NEW.body->'value' ?| array['token', 'access']) then
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

create or replace function account_private.write_secret(p_kind text, p_id text, p_secrets jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare
  existing uuid;
  allowed text[] := case p_kind when 'api-provider' then array['key'] when 'server-node' then array['token', 'access'] end;
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
     or exists (select 1 from jsonb_each(p_secrets) e
                 where not (e.key = any (allowed)) or jsonb_typeof(e.value) <> 'string') then
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

-- create or replace keeps grants; restated so this file alone shows who may call what.
revoke all on function public.sync_record_stamp(), account_private.write_secret(text, text, jsonb)
  from public, anon, authenticated;
grant execute on function account_private.write_secret(text, text, jsonb) to authenticated;
commit;
