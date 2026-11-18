import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PostgrestSyncRemote } from '../src/server/account-sync-remote.ts';

test('cloud counts issue HEAD with exact count and live kind filters', async () => {
  const remote = new PostgrestSyncRemote(
    { url: 'https://synthetic.invalid', publishableKey: 'sb_publishable_test' },
    'u',
    () => `e30.${Buffer.from(JSON.stringify({ sub: 'u' })).toString('base64url')}.synthetic`,
    async (url, init) => {
      assert.equal(init?.method, 'HEAD');
      assert.equal(new Headers(init?.headers).get('Prefer'), 'count=exact');
      assert.match(String(url), /\/rest\/v1\/sync_records\?select=id&kind=eq.conversation&deleted=is.false/);
      return new Response(null, { headers: { 'Content-Range': '*/23' } });
    },
  );
  assert.equal(await remote.count('conversation'), 23);
});

test('legacy 0001 SQL bounds metadata, all row bytes, devices and immutable key generations', () => {
  const sql = readFileSync(new URL('../supabase/migrations/0001_account_sync.sql', import.meta.url), 'utf8');
  assert.match(sql, /id text not null check \(char_length\(id\)<=128\)/);
  assert.match(sql, /device_id text not null check \(char_length\(device_id\)<=128\)/);
  assert.match(sql, /char_length\(name\)<=128/);
  assert.match(sql, /char_length\(platform\)<=32/);
  assert.match(sql, /jsonb_array_length\(cli_providers\)<=8/);
  assert.match(
    sql,
    /octet_length\(NEW.body::text\)\s*\+\s*pg_catalog.octet_length\(NEW.id\)\s*\+\s*pg_catalog.octet_length\(NEW.device_id\)\s*\+\s*128/,
  );
  assert.match(sql, /DEVICE_LIMIT/);
  assert.match(sql, /count\(\*\).*>=20/s);
  assert.match(sql, /octet_length\(wrapped_key::text\)<=4096/);
  assert.match(sql, /key_id uuid not null/);
  assert.doesNotMatch(sql, /grant select, insert, update on[^;]*user_keys/);
  assert.match(sql, /CLOUD_DATA_RESET/);
});

test('plain sync SQL keeps rows under RLS, secrets in Vault and old clients out', () => {
  const sql = readFileSync(new URL('../supabase/migrations/0008_plain_sync.sql', import.meta.url), 'utf8');
  for (const table of ['public.sync_accounts', 'public.sync_records', 'account_private.record_secrets']) {
    assert.match(sql, new RegExp(`alter table ${table.replace('.', '\\.')} enable row level security;`));
  }
  const grants = sql.match(/^grant [^;]*;/gm) ?? [];
  assert.ok(grants.length > 0);
  for (const grant of grants) {
    assert.doesNotMatch(grant, /\bdelete\b/);
    assert.doesNotMatch(grant, /record_secrets/);
  }

  const functions = sql.split(/\bcreate (?:or replace )?function /).slice(1);
  const header = (name: string) => {
    const found = functions.find((body) => body.startsWith(name));
    assert.ok(found, name);
    return found.slice(0, found.indexOf('$$'));
  };
  const definers = functions
    .map((body) => body.slice(0, body.indexOf('$$')))
    .filter((head) => /security definer/.test(head));
  assert.ok(definers.length >= 5);
  for (const head of definers) assert.match(head, /set search_path = ''/);
  assert.match(header('public.push_sync_records('), /security invoker/);
  assert.match(header('public.pull_sync_records('), /security invoker/);

  assert.match(sql, /SECRET_IN_BODY/);
  assert.match(sql, /CLIENT_UPGRADE_REQUIRED/);
  assert.match(sql, /CLOUD_DATA_RESET/);
  assert.match(sql, /nextval\('public\.account_sync_seq'/);
  assert.match(sql, /generation uuid not null default gen_random_uuid\(\)/);
  assert.match(sql, /vault\.create_secret\(/);
  assert.doesNotMatch(sql, /pgsodium/i);

  // Vault secrets are capped per user, and a refused Vault delete never fails a tombstone or cloud deletion.
  assert.match(header('account_private.write_secret('), /security definer/);
  const writeSecret = functions.find((body) => body.startsWith('account_private.write_secret('))!;
  assert.match(writeSecret, /secret_count\(auth\.uid\(\)\) >= 500[\s\S]*raise exception 'SECRET_LIMIT'/);
  assert.match(sql, /'INVALID_SECRET', 'SECRET_LIMIT'\) then/);
  const dropSecret = functions.find((body) => body.startsWith('account_private.drop_vault_secret('))!;
  assert.match(dropSecret, /delete from vault\.secrets[^;]*;\s*exception when others then/);
  assert.match(dropSecret, /insert into account_private\.orphan_secrets/);
  assert.match(sql, /alter table account_private\.orphan_secrets enable row level security;/);
  assert.match(
    sql,
    /revoke all on account_private\.record_secrets, account_private\.orphan_secrets from public, anon, authenticated;/,
  );
});

test('plain sync smoke SQL checks every new function and rolls back', () => {
  const migration = readFileSync(new URL('../supabase/migrations/0008_plain_sync.sql', import.meta.url), 'utf8');
  const smoke = readFileSync(new URL('../supabase/tests/0008_plain_sync_smoke.sql', import.meta.url), 'utf8');
  for (const [, name] of migration.matchAll(/\bcreate (?:or replace )?function (public\.\w+)\(/g))
    assert.ok(smoke.includes(`'${name}(`), name);
  assert.match(smoke, /where n\.nspname = 'account_private'/);
  assert.match(smoke, /has_function_privilege\('anon'/);
  for (const call of [
    'vault.create_secret(',
    'vault.update_secret(',
    'vault.decrypted_secrets',
    'delete from vault.secrets',
  ])
    assert.ok(smoke.includes(call), call);
  assert.match(smoke, /'SECRET_LIMIT'/);
  assert.match(smoke, /select public\.delete_my_cloud_data\(\);/);
  assert.match(smoke, /\nrollback;\s*$/);
  assert.doesNotMatch(smoke, /^\s*commit\b/im);
});
