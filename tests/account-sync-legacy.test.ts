import { filterSyncValue } from '../src/shared/account-sync.ts';
import type { SyncEngine } from '../src/server/account-sync.ts';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateLegacyCloud } from '../src/server/account-sync-legacy.ts';
import { MemorySyncRemote, PostgrestSyncRemote, type LegacyRecord } from '../src/server/account-sync-remote.ts';
import { createDataKey, encryptRecord, messageProvenanceHash } from '../src/server/account-sync-crypto.ts';
import { AccountService } from '../src/server/account-service.ts';
import { WorkspaceStore } from '../src/server/workspace-store.ts';
import { SyncStore } from '../src/server/account-sync-store.ts';
import type { SyncPayload } from '../src/shared/account-sync.ts';

const config = { url: 'https://synthetic.invalid', publishableKey: 'sb_publishable_test' };
const key = createDataKey();
function row(
  kind: string,
  id: string,
  value: Record<string, unknown> = { id },
  owner = '',
  deleted = false,
): LegacyRecord {
  return {
    kind,
    id,
    seq: 1,
    device_id: 'old-windows',
    deleted,
    size: 100,
    server_updated_at: '2026-01-01',
    key_id: 'old-key',
    body: encryptRecord(key, kind, id, { owner, value, deleted, observedSeq: 99 }),
  };
}
function cloud() {
  const remote = new MemorySyncRemote();
  remote.legacyKeyId = 'old-key';
  return remote;
}
async function plant(remote: MemorySyncRemote, ...rows: LegacyRecord[]) {
  await remote.legacyPush(rows);
}
const upgrade = (remote: MemorySyncRemote, isCurrent = () => true) =>
  migrateLegacyCloud({ remote, key, generation: remote.generation, deviceId: 'windows', isCurrent });
const recordKey = (kind: string, id: string) => JSON.stringify([kind, id]);
function fixture(t: TestContext, remote: MemorySyncRemote) {
  const dir = mkdtempSync(join(tmpdir(), 'legacy-sync-'));
  const db = new DatabaseSync(join(dir, 'workspace.sqlite'));
  db.exec("CREATE TABLE config(key TEXT PRIMARY KEY,value TEXT); INSERT INTO config VALUES('settings','{}')");
  const workspace = new WorkspaceStore(db, { recoverInterrupted: false });
  const sent: unknown[] = [];
  const states: string[] = [];
  const service = new AccountService({
    workspace,
    directory: dir,
    secretsDirectory: join(dir, 'secrets'),
    config,
    desktop: true,
    remote: () => remote,
    send: (m) => sent.push(m),
    changed: () => states.push(service.view().setup),
  });
  t.after(async () => {
    await service.close();
    db.close();
  });
  const session = () =>
    service.handleMainMessage({
      type: 'account-session',
      session: {
        userId: 'user',
        email: 'test@example.invalid',
        accessToken: 'synthetic',
        expiresAt: Date.now() + 3600000,
      },
    });
  const handKey = (keyId = 'old-key', value = key) =>
    service.handleMainMessage({ type: 'account-key', userId: 'user', keyId, key: value.toString('base64') });
  return { workspace, db, dir, service, session, handKey, sent, states };
}
async function until(check: () => boolean) {
  for (let n = 0; n < 400 && !check(); n++) await delay(10);
  assert.ok(check());
}

test('imports all core kinds, preserves metadata, strips cursor and skips extensions', async () => {
  const remote = cloud();
  const kinds = ['conversation', 'message', 'human-message', 'conversation-folder', 'project', 'memory', 'settings'];
  for (const kind of [...kinds, 'remote-server', 'server-node', 'api-provider'])
    await plant(
      remote,
      row(kind, kind, kind === 'settings' ? { locale: 'en' } : { id: kind }, 'owner', kind === 'memory'),
    );
  await upgrade(remote);
  assert.equal(remote.records.size, 7);
  assert.equal(remote.migrated, true);
  for (const kind of kinds) {
    const saved = remote.records.get(recordKey(kind, kind))!;
    assert.deepEqual(saved.body, {
      owner: 'owner',
      value: kind === 'settings' ? { locale: 'en' } : { id: kind },
      deleted: kind === 'memory',
    });
    assert.equal(saved.device_id, 'old-windows');
    assert.equal(saved.deleted, kind === 'memory');
  }
  const before = structuredClone(remote.records);
  assert.equal((await remote.legacyPush([row('conversation', 'conversation')]))[0].code, 'CLIENT_UPGRADE_REQUIRED');
  assert.deepEqual(remote.records, before);
});

test('crash before mark reruns idempotently and preserves newer plain conflicts', async () => {
  const remote = cloud();
  await plant(remote, row('conversation', 'c'), row('memory', 'm'));
  const finish = remote.finishLegacyMigration.bind(remote);
  remote.finishLegacyMigration = async () => {
    throw Error('OFFLINE');
  };
  await assert.rejects(upgrade(remote), /OFFLINE/);
  const first = structuredClone(remote.records);
  remote.finishLegacyMigration = finish;
  await upgrade(remote);
  assert.deepEqual(remote.records, first);
  const prior = remote.records.get(recordKey('memory', 'm'))!;
  await remote.push(remote.generation, [
    { ...prior, body: { ...prior.body, value: { id: 'm', text: 'newer' } }, last_seq: prior.seq },
  ]);
  await upgrade(remote);
  assert.equal(remote.records.get(recordKey('memory', 'm'))!.body.value.text, 'newer');
});

test('restart imports a newer legacy edit but a racing plain edit wins the retry', async () => {
  for (const race of [false, true]) {
    const remote = cloud();
    await plant(remote, row('memory', 'm', { id: 'm', content: 'old' }));
    const finish = remote.finishLegacyMigration.bind(remote);
    remote.finishLegacyMigration = async () => {
      throw Error('OFFLINE');
    };
    await assert.rejects(upgrade(remote), /OFFLINE/);
    await plant(remote, row('memory', 'm', { id: 'm', content: 'new\u0000legacy\uD800' }));
    remote.finishLegacyMigration = finish;
    const push = remote.push.bind(remote);
    let retries = 0;
    remote.push = async (generation, changes) => {
      if (changes.some((c) => c.last_seq > 0)) {
        retries++;
        if (race) {
          const prior = remote.records.get(recordKey('memory', 'm'))!;
          await push(generation, [
            { ...prior, body: { ...prior.body, value: { id: 'm', content: 'newest plain' } }, last_seq: prior.seq },
          ]);
        }
      }
      return push(generation, changes);
    };
    await upgrade(remote);
    assert.equal(retries, 1);
    assert.equal(
      remote.records.get(recordKey('memory', 'm'))!.body.value.content,
      race ? 'newest plain' : 'new�legacy�',
    );
    assert.equal(remote.migrated, true);
  }
});

test('failed legacy retry after upgrade does not block normal sync or leak error detail', async (t) => {
  const remote = cloud();
  await plant(remote, row('memory', 'm'));
  await upgrade(remote);
  remote.legacyPull = async () => {
    throw Error('sensitive-ciphertext-detail');
  };
  const warnings: unknown[][] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => warnings.push(args));
  const f = fixture(t, remote);
  const local = new SyncStore(f.workspace, f.dir);
  await local.activate('user');
  local.dispose();
  await f.handKey();
  await f.session();
  assert.equal(f.service.view().setup, 'ready');
  await (f.service as unknown as { engine: SyncEngine }).engine.syncNow();
  assert.equal(f.service.view().sync, 'idle');
  assert.ok(f.workspace.get('memory', 'm'));
  assert.equal(warnings.length, 1);
  assert.doesNotMatch(JSON.stringify(warnings), /sensitive-ciphertext-detail/);
});

test('first plain sync resets the legacy cursor but preserves its merge base', async (t) => {
  const remote = cloud();
  await plant(remote, row('memory', 'm', { id: 'm', content: 'cloud' }));
  await upgrade(remote);
  const f = fixture(t, remote);
  const local = new SyncStore(f.workspace, f.dir);
  await local.activate('user');
  const { readLocalSealKey } = await import('../src/server/account-sync-crypto.ts');
  local.setSealKey(await readLocalSealKey(join(f.dir, 'secrets')));
  const base = { owner: '', value: { id: 'base', content: 'keep' }, deleted: false };
  local.suppress(() => f.workspace.save('memory', 'base', '', base.value));
  local.setBase('memory', 'base', 17, base, 'old');
  local.cursor = 9999;
  local.dispose();
  const pull = remote.pull.bind(remote);
  const cursors: number[] = [];
  remote.pull = async (after, limit) => {
    cursors.push(after);
    assert.deepEqual(local.base('memory', 'base')?.value, base.value);
    return pull(after, limit);
  };
  await f.session();
  await (f.service as unknown as { engine: SyncEngine }).engine.syncNow();
  assert.equal(f.service.view().sync, 'idle');
  assert.equal(cursors[0], 0);
  assert.ok(f.workspace.get('memory', 'm'));
  assert.ok(f.workspace.get('account-sync-cloud', 'user'));
  await f.service.handleMainMessage({ type: 'account-clear' });
  cursors.length = 0;
  await f.session();
  await (f.service as unknown as { engine: SyncEngine }).engine.syncNow();
  assert.ok(cursors[0] > 0, 'subsequent plain sessions keep their cursor');
});

test('drain imports a racing update and insertion; cancellation and reset stop the mark', async () => {
  const remote = cloud();
  await plant(remote, row('conversation', 'c'));
  const finish = remote.finishLegacyMigration.bind(remote);
  remote.finishLegacyMigration = async (id) => {
    await plant(remote, row('conversation', 'c', { id: 'c', title: 'raced' }), row('memory', 'm'));
    await finish(id);
  };
  await upgrade(remote);
  assert.equal(remote.records.get(recordKey('conversation', 'c'))!.body.value.title, 'raced');
  assert.equal(remote.records.size, 2);
  const cancelled = cloud();
  await plant(cancelled, row('memory', 'm'));
  await assert.rejects(
    upgrade(cancelled, () => false),
    /SIGNED_OUT/,
  );
  assert.equal(cancelled.migrated, false);
  const push = cancelled.push.bind(cancelled);
  cancelled.push = async (generation, changes) => {
    await cancelled.deleteMyCloudData();
    return push(generation, changes);
  };
  await assert.rejects(upgrade(cancelled), /CLOUD_DATA_RESET/);
  assert.equal(cancelled.migrated, false);
});

test('bad ciphertext or invalid later page fails before any plain write', async () => {
  for (const corrupt of [true, false]) {
    const remote = cloud();
    for (let n = 0; n < 201; n++) await plant(remote, row('memory', `m${n}`));
    const bad = remote.legacy.get(recordKey('memory', 'm200'))!;
    bad.body = corrupt
      ? { ...bad.body, tag: Buffer.alloc(16).toString('base64') }
      : encryptRecord(key, bad.kind, bad.id, { owner: '', value: [], deleted: false });
    await assert.rejects(upgrade(remote), /UPGRADE_FAILED/);
    assert.equal(remote.records.size, 0);
    assert.equal(remote.migrated, false);
  }
});

test('matching key upgrades, keeps local data and wakes a waiting computer without a prompt', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const remote = cloud();
  const message = { id: 'm', conversationId: 'c', role: 'user', content: 'Hello', createdAt: '2026-01-01' };
  const rows = [
    row('conversation', 'c', { id: 'c', title: 'Chat', createdAt: '2026-01-01' }),
    row('message', 'm', message, 'c'),
    row('human-message', 'm', { id: 'm', messageHash: messageProvenanceHash('c', message) }, 'c'),
    row('conversation-folder', 'f'),
    row('project', 'p'),
    row('memory', 'memo'),
    row('settings', 'settings', { locale: 'en' }),
  ];
  await plant(remote, ...rows);
  const a = fixture(t, remote),
    b = fixture(t, remote);
  for (const f of [a, b]) {
    const local = new SyncStore(f.workspace, f.dir);
    await local.activate('user');
    local.dispose();
  }
  const local = new SyncStore(a.workspace, a.dir);
  for (const r of rows) {
    const { decryptRecord } = await import('../src/server/account-sync-crypto.ts');
    const body = decryptRecord<SyncPayload>(key, r.kind, r.id, r.body);
    local.suppress(() => {
      if (r.kind === 'settings')
        a.db.prepare("UPDATE config SET value=? WHERE key='settings'").run(JSON.stringify(body.value));
      else a.workspace.save(r.kind, r.id, body.owner, body.value);
    });
    local.setBase(r.kind, r.id, remote.legacy.get(recordKey(r.kind, r.id))!.seq, body, r.device_id);
  }
  local.dispose();
  const before = a.workspace.list('message');
  await b.session();
  assert.equal(b.service.view().setup, 'waiting-upgrade');
  await a.handKey();
  await a.session();
  assert.equal(a.service.view().setup, 'ready');
  assert.ok(a.states.includes('upgrading'));
  assert.ok(a.sent.some((m) => (m as { type: string }).type === 'account-persist-key' && !('key' in (m as object))));
  assert.deepEqual(a.workspace.list('message'), before);
  t.mock.timers.tick(60000);
  await until(() => b.service.view().setup === 'ready').catch(() => {
    assert.fail(JSON.stringify(b.service.view()));
  });
  await (b.service as unknown as { engine: SyncEngine }).engine.syncNow();
  await (a.service as unknown as { engine: SyncEngine }).engine.syncNow();
  assert.equal(b.service.view().sync, 'idle');
  assert.equal(a.service.view().sync, 'idle');
  for (const kind of ['conversation', 'message', 'human-message', 'conversation-folder', 'project', 'memory'])
    assert.deepEqual(
      b.workspace.list<Record<string, unknown>>(kind).map((v) => filterSyncValue(kind, v)),
      a.workspace.list<Record<string, unknown>>(kind).map((v) => filterSyncValue(kind, v)),
    );
  assert.deepEqual(
    b.db.prepare("SELECT value FROM config WHERE key='settings'").get(),
    a.db.prepare("SELECT value FROM config WHERE key='settings'").get(),
  );
  assert.equal(b.workspace.list('message').length, 1);
});

test('key mismatch waits; decrypt failure retries with backoff and retains the key', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const remote = cloud();
  await plant(remote, row('memory', 'm'));
  const f = fixture(t, remote);
  await f.handKey('wrong-id');
  await f.session();
  assert.equal(f.service.view().setup, 'waiting-upgrade');
  await f.handKey('old-key', createDataKey());
  assert.equal(f.service.view().sync, 'error: UPGRADE_FAILED');
  assert.equal(remote.records.size, 0);
  assert.equal(f.sent.length, 0);
  await f.handKey();
  t.mock.timers.tick(1000);
  // Nothing local to mix in: the first sync starts on its own after the upgrade.
  await until(() => f.service.view().setup === 'ready');
  assert.equal(remote.migrated, true);
  assert.equal(remote.records.size, 1);
});

test('interrupted drain retries after mark before forgetting the key', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const remote = cloud();
  await plant(remote, row('memory', 'm'));
  const pull = remote.legacyPull.bind(remote);
  let fail = true;
  remote.legacyPull = async (after, limit) => {
    if (remote.migrated && fail) {
      fail = false;
      throw Error('OFFLINE');
    }
    return pull(after, limit);
  };
  const f = fixture(t, remote);
  await f.handKey();
  await f.session();
  assert.equal(remote.migrated, true);
  assert.equal(f.sent.length, 0);
  t.mock.timers.tick(1000);
  await until(() => f.service.view().setup === 'ready');
  assert.equal(f.sent.length, 1);
});

test('legacy REST reads are paged and finish uses only its owner RPC', async () => {
  const calls: { url: string; body?: string }[] = [];
  const token = `x.${Buffer.from(JSON.stringify({ sub: 'user' })).toString('base64url')}.x`;
  const remote = new PostgrestSyncRemote(
    config,
    'user',
    () => token,
    async (url, init) => {
      calls.push({ url: String(url), body: init?.body as string });
      return new Response(String(url).includes('records?') ? '[]' : '', { status: 200 });
    },
  );
  await remote.legacyPull(42, 200);
  await remote.finishLegacyMigration('windows');
  assert.match(calls[0].url, /records\?select=.*key_id&seq=gt.42&order=seq.asc&limit=200$/);
  assert.ok(calls[1].url.endsWith('/rpc/finish_legacy_migration'));
  assert.deepEqual(JSON.parse(calls[1].body!), { p_device_id: 'windows' });
});

test('a record updated during pagination imports its latest legacy value', async () => {
  const remote = cloud();
  for (let n = 0; n < 201; n++) await plant(remote, row('memory', `m${n}`));
  const pull = remote.legacyPull.bind(remote);
  let raced = false;
  remote.legacyPull = async (after, limit) => {
    const rows = await pull(after, limit);
    if (!raced) {
      raced = true;
      await plant(remote, row('memory', 'm0', { id: 'm0', content: 'latest' }));
    }
    return rows;
  };
  await upgrade(remote);
  assert.equal(remote.records.size, 201);
  assert.equal(remote.records.get(recordKey('memory', 'm0'))!.body.value.content, 'latest');
});
