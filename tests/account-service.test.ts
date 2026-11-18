import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readdirSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceStore } from '../src/server/workspace-store.ts';
import { AccountService, accountCliProviders } from '../src/server/account-service.ts';
import { MemorySyncRemote, PostgrestSyncRemote, SyncRemoteError } from '../src/server/account-sync-remote.ts';
import { createDataKey } from '../src/server/account-sync-crypto.ts';
import { SyncStore } from '../src/server/account-sync-store.ts';
import { SyncEngine } from '../src/server/account-sync.ts';
import { AccountSyncFiles } from '../src/server/account-sync-files.ts';
import { AccountSyncApi, type ApiSyncRecord } from '../src/server/account-sync-api.ts';
import { DeviceStore } from '../src/server/devices/store.ts';

const config = { url: 'https://synthetic.invalid', publishableKey: 'sb_publishable_test' };
test('device providers require an installed CLI and a signed-in identity, while retaining offline and quota accounts', () => {
  const accounts = [
    { runtimeId: 'uninstalled', provider: 'codex', enabled: true, identityKnown: true, status: 'ready' },
    { runtimeId: 'signed-out', provider: 'claude', enabled: true, identityKnown: true, status: 'auth-required' },
    { runtimeId: 'missing', provider: 'codex', enabled: true, identityKnown: true, status: 'missing' },
    { runtimeId: 'unprobed', provider: 'claude', enabled: true, identityKnown: true, status: 'ready' },
    { runtimeId: 'offline', provider: 'grok', enabled: true, identityKnown: true, status: 'error' },
    {
      runtimeId: 'quota',
      provider: 'cursor',
      enabled: true,
      identityKnown: true,
      status: 'ready',
      availability: { reason: 'quota', observedAt: '2026-01-01' },
    },
    {
      runtimeId: 'auth-failure',
      provider: 'codex',
      enabled: true,
      identityKnown: true,
      status: 'ready',
      availability: { reason: 'authentication', observedAt: '2026-01-01' },
    },
  ] as const;
  const snapshots = [
    { id: 'uninstalled', installed: false, status: 'ready' },
    { id: 'signed-out', installed: true, status: 'auth-required' },
    { id: 'missing', installed: true, status: 'ready' },
    { id: 'offline', installed: true, status: 'error' },
    { id: 'quota', installed: true, status: 'ready' },
    { id: 'auth-failure', installed: true, status: 'ready' },
  ] as const;
  assert.deepEqual(accountCliProviders(accounts, snapshots), ['grok', 'cursor']);
});
function fixture(t: TestContext, configured = true, sharedRemote?: MemorySyncRemote) {
  const dir = mkdtempSync(join(tmpdir(), 'account-service-'));
  const secrets = join(dir, 'secrets');
  const db = new DatabaseSync(join(dir, 'studio.sqlite'));
  const workspace = new WorkspaceStore(db, { recoverInterrupted: false });
  const remote = sharedRemote ?? new MemorySyncRemote(undefined, 'user');
  const sent: unknown[] = [];
  const service = new AccountService({
    workspace,
    directory: dir,
    secretsDirectory: secrets,
    config: configured ? config : { url: '', publishableKey: '' },
    desktop: true,
    send: (message) => sent.push(message),
    remote: () => remote,
    providers: () => ['codex'],
  });
  t.after(async () => {
    await service.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const session = () =>
    service.handleMainMessage({
      type: 'account-session',
      session: {
        userId: 'user',
        email: 'test@example.invalid',
        accessToken: 'synthetic-access',
        expiresAt: Date.now() + 3600000,
      },
    });
  return { service, session, remote, workspace, db, dir, secrets, sent };
}
/** Real event-loop turns; works while only setTimeout is mocked. */
async function until(check: () => boolean) {
  for (let n = 0; n < 200 && !check(); n++) await new Promise<void>((resolve) => setImmediate(resolve));
}
async function flush(turns = 50) {
  for (let n = 0; n < turns; n++) await Promise.resolve();
}
const localChat = (workspace: WorkspaceStore, id = 'here') =>
  workspace.save('conversation', id, '', { id, title: 'Synthetic local chat' });
const syncState = (db: DatabaseSync) =>
  db.prepare("SELECT name FROM sqlite_master WHERE name='sync_state'").get()
    ? (db.prepare('SELECT account,backup FROM sync_state').get() as { account: string; backup: string | null })
    : undefined;
test('unconfigured account stays inert and creates no sync files or tables', async (t) => {
  const f = fixture(t, false);
  const files = readdirSync(f.dir);
  await f.session();
  assert.equal(f.service.view().configured, false);
  assert.equal(f.service.view().setup, 'none');
  assert.deepEqual(readdirSync(f.dir), files);
  assert.equal(f.db.prepare("SELECT name FROM sqlite_master WHERE name='sync_state'").get(), undefined);
});
test('an empty computer starts its first sync without a confirm call, backup first', async (t) => {
  const f = fixture(t);
  await f.remote.push(f.remote.generation, [
    {
      kind: 'conversation',
      id: 'cloud-chat',
      last_seq: 0,
      deleted: false,
      device_id: 'other',
      body: { owner: '', value: { id: 'cloud-chat', title: 'From another computer' }, deleted: false },
    },
  ]);
  const merge = t.mock.method(f.service, 'merge');
  await f.session();
  assert.equal(merge.mock.callCount(), 0);
  assert.equal(f.service.view().setup, 'ready');
  assert.equal(f.service.view().merge, undefined);
  assert.equal(syncState(f.db)?.account, 'user');
  assert.ok(syncState(f.db)?.backup && existsSync(syncState(f.db)!.backup!), 'The backup is taken before enabling');
  assert.deepEqual(f.workspace.get('account-sync-cloud', 'user'), { generation: f.remote.generation });
  await assert.rejects(f.service.merge(true, false), /MERGE_NOT_READY/);
  await (f.service as unknown as { engine: SyncEngine }).engine.syncNow();
  assert.equal(f.service.view().sync, 'idle');
  assert.equal(f.workspace.get<{ title: string }>('conversation', 'cloud-chat')?.title, 'From another computer');
});
test('an empty computer and an empty cloud start syncing without a confirm call', async (t) => {
  const f = fixture(t);
  await f.session();
  assert.equal(f.service.view().setup, 'ready');
  await (f.service as unknown as { engine: SyncEngine }).engine.syncNow();
  assert.equal(f.service.view().sync, 'idle');
  assert.equal(f.remote.records.size, 0);
});
test('local data on a new computer stops at merge and needs confirmation', async (t) => {
  const f = fixture(t);
  localChat(f.workspace);
  await f.session();
  assert.equal(f.service.view().setup, 'merge');
  assert.deepEqual(f.service.view().merge, {
    local: { chats: 1, folders: 0, projects: 0, memories: 0 },
    cloud: { chats: 0, folders: 0, projects: 0, memories: 0 },
    accountChange: false,
  });
  assert.equal(f.db.prepare("SELECT name FROM sqlite_master WHERE name='sync_state'").get(), undefined);
  await assert.rejects(f.service.merge(false, false), /MERGE_CONFIRMATION_REQUIRED/);
  assert.equal(f.db.prepare("SELECT name FROM sqlite_master WHERE name='sync_state'").get(), undefined);
  await f.service.merge(true, false);
  assert.equal(f.service.view().setup, 'ready');
  assert.deepEqual(f.workspace.get('account-sync-cloud', 'user'), { generation: f.remote.generation });
  assert.ok(!JSON.stringify(f.service.view()).includes('synthetic-access'));
});
test('servers, enrolled nodes or API cards on this computer keep the merge confirmation without reading keys', async (t) => {
  const zero = { chats: 0, folders: 0, projects: 0, memories: 0 };
  const card: ApiSyncRecord = {
    id: 'api-synthetic',
    value: {
      id: 'api-synthetic',
      card: { apiProvider: 'deepseek', label: 'Synthetic card', enabled: true },
      excluded: false,
    },
  };
  for (const local of ['server', 'node', 'card', 'unreadable', 'none'] as const) {
    const f = fixture(t);
    const serversFile = join(f.dir, 'remote-servers.json');
    const devicesFile = join(f.dir, 'devices.json');
    writeFileSync(
      serversFile,
      local === 'unreadable'
        ? '{'
        : JSON.stringify({ servers: local === 'server' ? [{ name: 'synthetic-box', ssh: 'synthetic-box' }] : [] }),
    );
    const node = {
      id: '00000000-0000-4000-8000-000000000001',
      name: 'synthetic-node',
      enrolledServer: 'synthetic-node',
      address: '100.100.1.1',
      token: Buffer.alloc(32, 7).toString('base64url'),
      peerId: '00000000-0000-4000-8000-000000000002',
      pairedAt: '2026-11-01T00:00:00Z',
    };
    writeFileSync(devicesFile, JSON.stringify({ version: 1, devices: local === 'node' ? [node] : [] }));
    const keyReads: string[] = [];
    const api = new AccountSyncApi(
      {
        readSyncedApiCards: async (keys) => {
          keys?.read('synthetic-target');
          return local === 'card' ? [card] : [];
        },
        applySyncedApiCards: async () => {},
      },
      {
        read: (id) => {
          keyReads.push(id);
          return undefined;
        },
        save: async () => {},
        remove: async () => {},
      },
    );
    const files = new AccountSyncFiles(new DeviceStore(devicesFile), serversFile, () => {}, api);
    assert.equal(await files.hasLocalEntries(), local !== 'none', local);
    f.service.setSyncFiles(files);
    await f.session();
    if (local === 'none') {
      assert.equal(f.service.view().setup, 'ready', 'Empty files do not block the first sync');
      continue;
    }
    assert.equal(f.service.view().setup, 'merge', local);
    assert.deepEqual(f.service.view().merge, { local: zero, cloud: zero, accountChange: false }, local);
    assert.equal(syncState(f.db), undefined, local);
    assert.deepEqual(keyReads, [], 'Counting cards must not open the keychain');
  }
});
test('a failed automatic first sync shows the error code and retries on its own', async (t) => {
  const f = fixture(t);
  // The seal key folder is a file, so enabling fails after the cloud answered.
  writeFileSync(f.secrets, 'synthetic-not-a-folder');
  await f.session();
  assert.equal(f.service.view().error, 'SYNC_FAILED');
  assert.equal(f.service.view().sync, 'error: SYNC_FAILED');
  assert.equal(f.service.view().setup, 'loading');
  await assert.rejects(f.service.merge(true, false), /MERGE_NOT_READY/);
  rmSync(f.secrets);
  for (let n = 0; n < 100 && f.service.view().setup !== 'ready'; n++)
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  assert.equal(f.service.view().setup, 'ready');
  assert.equal(f.service.view().error, undefined);
});
test('account change requires explicit consent before enabling the union, even with nothing local', async (t) => {
  const f = fixture(t);
  await f.session();
  assert.equal(f.service.view().setup, 'ready');
  await f.service.handleMainMessage({ type: 'account-clear' });
  const remote = new MemorySyncRemote(undefined, 'other');
  const second = new AccountService({
    workspace: f.workspace,
    directory: f.dir,
    secretsDirectory: f.secrets,
    config,
    desktop: true,
    remote: () => remote,
  });
  await second.handleMainMessage({
    type: 'account-session',
    session: {
      userId: 'other',
      email: 'other@example.invalid',
      accessToken: 'other-token',
      expiresAt: Date.now() + 3600000,
    },
  });
  assert.equal(second.view().setup, 'merge');
  assert.equal(second.view().merge?.accountChange, true);
  assert.deepEqual(second.view().merge?.local, { chats: 0, folders: 0, projects: 0, memories: 0 });
  await assert.rejects(second.merge(true, false), /ACCOUNT_CHANGE_REQUIRES_CONSENT/);
  assert.equal(f.db.prepare('SELECT account FROM sync_state').get()?.account, 'user');
  await second.merge(true, true);
  assert.equal(f.db.prepare('SELECT account FROM sync_state').get()?.account, 'other');
  await second.close();
});
test('waiting-upgrade escape hatch deletes cloud data and starts from this computer, local chats kept', async (t) => {
  const f = fixture(t);
  f.remote.legacyKeyId = 'legacy-synthetic-key';
  f.workspace.save('conversation', 'chat', '', { id: 'chat', title: 'Keep' });
  await f.session();
  assert.equal(f.service.view().setup, 'waiting-upgrade');
  assert.equal(f.db.prepare("SELECT name FROM sqlite_master WHERE name='sync_state'").get(), undefined);
  await assert.rejects(f.service.deleteCloud(false), /DELETE_CONFIRMATION_REQUIRED/);
  await f.service.deleteCloud(true);
  assert.equal(f.remote.legacyKeyId, undefined);
  assert.ok(f.workspace.get('conversation', 'chat'));
  await until(() => f.service.view().setup === 'merge');
  assert.equal(f.service.view().setup, 'merge');
  assert.equal(f.service.view().merge?.local.chats, 1);
  await f.service.merge(true, false);
  await (f.service as unknown as { engine: SyncEngine }).engine.syncNow();
  assert.ok(f.remote.records.has(JSON.stringify(['conversation', 'chat'])));
});

test('offline ensure retries without a second account row', async (t) => {
  const f = fixture(t);
  localChat(f.workspace);
  const ensure = f.remote.account.bind(f.remote);
  const generations: string[] = [];
  f.remote.account = async () => {
    const account = await ensure();
    generations.push(account.generation);
    // The row was created, but the response was lost.
    if (generations.length === 1) throw new SyncRemoteError('OFFLINE');
    return account;
  };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await f.session();
  assert.equal(f.service.view().sync, 'offline');
  assert.equal(f.service.view().setup, 'loading');
  t.mock.timers.tick(1000);
  await until(() => f.service.view().setup === 'merge');
  assert.equal(f.service.view().setup, 'merge');
  assert.equal(generations.length, 2);
  assert.equal(generations[0], generations[1]);
});

test('same account resumes without prompt; token refresh keeps setup', async (t) => {
  const f = fixture(t);
  localChat(f.workspace);
  await f.session();
  assert.equal(f.service.view().setup, 'merge');
  await f.session();
  assert.equal(f.service.view().setup, 'merge');
  await f.service.merge(true, false);
  await f.service.handleMainMessage({ type: 'account-clear' });
  await f.session();
  assert.equal(f.service.view().setup, 'ready');
  await f.session();
  assert.equal(f.service.view().setup, 'ready');
});

test('legacy cloud without a key waits, then syncs after the remote reports migrated', async (t) => {
  const f = fixture(t);
  f.remote.legacyKeyId = 'legacy-synthetic-key';
  f.workspace.save('conversation', 'here', '', { id: 'here', title: 'From this computer' });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await f.session();
  assert.equal(f.service.view().setup, 'waiting-upgrade');
  // A key that does not match the cloud's old key keeps waiting; nothing is typed or confirmed.
  await f.service.handleMainMessage({
    type: 'account-key',
    userId: 'user',
    key: createDataKey().toString('base64'),
    keyId: 'another-key',
  });
  assert.equal(f.service.view().setup, 'waiting-upgrade');
  t.mock.timers.tick(60000);
  await flush();
  assert.equal(f.service.view().setup, 'waiting-upgrade');
  assert.equal(f.db.prepare("SELECT name FROM sqlite_master WHERE name='sync_state'").get(), undefined);
  f.remote.migrated = true;
  t.mock.timers.tick(60000);
  await until(() => f.service.view().setup === 'merge');
  assert.equal(f.service.view().setup, 'merge');
  t.mock.timers.reset();
  await f.service.merge(true, false);
  assert.equal(f.service.view().setup, 'ready');
  await (f.service as unknown as { engine: SyncEngine }).engine.syncNow();
  assert.equal(f.service.view().sync, 'idle');
  assert.ok(f.remote.records.has(JSON.stringify(['conversation', 'here'])));
});

test('view JSON never contains a key, token or seal key', async (t) => {
  const f = fixture(t);
  const legacy = createDataKey().toString('base64');
  await f.service.handleMainMessage({ type: 'account-key', userId: 'user', key: legacy, keyId: 'legacy-id' });
  await f.session();
  assert.equal(f.service.view().setup, 'ready');
  const seal = readFileSync(join(f.secrets, 'account-sync-seal.key'), 'utf8').trim();
  assert.equal(Buffer.from(seal, 'base64').length, 32);
  const view = JSON.stringify(f.service.view());
  for (const secret of [legacy, seal, 'synthetic-access', 'legacy-id']) assert.ok(!view.includes(secret), secret);
  assert.doesNotMatch(view, /"(key|token|sealKey|accessToken)"/);
  // No legacy cloud: the handed-over key is forgotten in Electron as well.
  assert.ok(
    f.sent.some(
      (m) => (m as { type: string; key?: string }).type === 'account-persist-key' && !(m as { key?: string }).key,
    ),
  );
});

test('new-machine checklist exposes only supported provider names', async (t) => {
  const f = fixture(t);
  f.remote.devices.set('other', {
    id: 'other',
    name: 'Other',
    platform: 'linux',
    cli_providers: ['codex', 'grok', 'claude', 'gemini', 'agy'],
  });
  await f.session();
  assert.deepEqual(f.service.view().missingProviders.sort(), ['claude', 'grok']);
  assert.doesNotMatch(JSON.stringify(f.service.view()), /gemini|agy/);
});

test('pulled settings notify live adapters only after committed data and advance workspace revision', async (t) => {
  const f = fixture(t);
  f.db.exec("CREATE TABLE config(key TEXT PRIMARY KEY,value TEXT); INSERT INTO config VALUES('settings','{}')");
  await f.remote.push(f.remote.generation, [
    {
      kind: 'settings',
      id: 'settings',
      last_seq: 0,
      deleted: false,
      device_id: 'other',
      body: {
        owner: '',
        value: { appearanceTheme: 'dark', appearanceAccent: 'teal', locale: 'en' },
        deleted: false,
      },
    },
  ]);
  const local = new SyncStore(f.workspace, f.dir);
  let applied = 0;
  const before = f.db.prepare('SELECT n FROM workspace_revision WHERE id=1').get()!.n as number;
  const engine = new SyncEngine({
    local,
    remote: f.remote,
    deviceId: 'here',
    config,
    sealKey: createDataKey(),
    onApplied: () => {
      assert.equal(f.db.isTransaction, false);
      assert.equal(local.settings().locale, 'en');
      f.workspace.invalidateRevision();
      ++applied;
    },
  });
  await engine.enable({ userId: 'user', generation: f.remote.generation });
  await engine.syncNow(false);
  engine.stop();
  assert.equal(applied, 1);
  assert.deepEqual(local.settings(), { appearanceTheme: 'dark', appearanceAccent: 'teal', locale: 'en' });
  assert.ok((f.db.prepare('SELECT n FROM workspace_revision WHERE id=1').get()!.n as number) > before);
});

test('a failed confirmed cloud deletion retries without reuploading or resetting the baseline early', async (t) => {
  const f = fixture(t);
  await f.session();
  const oldGeneration = f.remote.generation;
  f.workspace.save('conversation', 'keep', '', { id: 'keep', title: 'Local stays' });
  f.db.prepare('UPDATE sync_state SET cursor=42').run();
  let attempts = 0;
  const jwt = `e30.${Buffer.from(JSON.stringify({ sub: 'user' })).toString('base64url')}.synthetic`;
  const transport = new PostgrestSyncRemote(
    config,
    'user',
    () => jwt,
    async () => {
      ++attempts;
      return new Response(null, { status: attempts === 1 ? 503 : 204 });
    },
  );
  const remove = f.remote.deleteMyCloudData.bind(f.remote);
  f.remote.deleteMyCloudData = async () => {
    await transport.deleteMyCloudData();
    await remove();
  };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await assert.rejects(f.service.deleteCloud(true), /HTTP_503/);
  assert.equal(f.db.prepare('SELECT cursor FROM sync_state').get()!.cursor, 42);
  assert.equal(f.service.view().sync, 'error: HTTP_503');
  assert.equal(f.service.view().setup, 'loading');
  assert.equal(attempts, 1);
  assert.ok(f.workspace.get('account-cloud-delete', 'user'));
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(attempts, 2);
  assert.equal(f.db.prepare('SELECT cursor FROM sync_state').get()!.cursor, 0);
  assert.equal(f.workspace.get('account-cloud-delete', 'user'), undefined);
  t.mock.timers.tick(1);
  await until(() => f.service.view().setup === 'merge');
  assert.equal(f.service.view().setup, 'merge', 'A new generation asks before uploading again');
  assert.notEqual(f.remote.generation, oldGeneration);
  assert.equal(f.remote.records.size, 0);
  assert.ok(f.workspace.get('conversation', 'keep'));
});

test('a pending cloud deletion resumes after a new session before merging', async (t) => {
  const f = fixture(t);
  f.workspace.save('account-cloud-delete', 'user', '', { pending: true });
  f.remote.legacyKeyId = 'legacy-synthetic-key';
  await f.session();
  assert.equal(f.remote.legacyKeyId, undefined);
  assert.equal(f.workspace.get('account-cloud-delete', 'user'), undefined);
  await until(() => f.service.view().setup === 'merge');
  assert.equal(f.service.view().setup, 'merge');
});

test('sign-out and same-user sign-in drain an outstanding cloud deletion before preparing the new session', async (t) => {
  const f = fixture(t);
  await f.session();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requests = 0;
  const remove = f.remote.deleteMyCloudData.bind(f.remote);
  f.remote.deleteMyCloudData = async () => {
    if (++requests === 1) await gate;
    await remove();
  };
  const deleting = f.service.deleteCloud(true);
  for (let n = 0; n < 20; n++) await Promise.resolve();
  await f.service.handleMainMessage({ type: 'account-clear' });
  let resumed = false;
  const signingIn = f.session().then(() => {
    resumed = true;
  });
  for (let n = 0; n < 30; n++) await Promise.resolve();
  const requestsWhilePending = requests;
  const resumedWhilePending = resumed;
  release();
  await Promise.all([deleting, signingIn]);
  assert.equal(requestsWhilePending, 1);
  assert.equal(resumedWhilePending, false);
  assert.equal(requests, 2);
  assert.equal(f.workspace.get('account-cloud-delete', 'user'), undefined);
  await until(() => f.service.view().setup === 'merge');
  assert.equal(f.service.view().setup, 'merge');
});

test('a new cloud generation resets the baseline and waits at merge, even with nothing local', async (t) => {
  const f = fixture(t);
  f.db.exec(
    `CREATE TABLE config(key TEXT PRIMARY KEY,value TEXT); INSERT INTO config VALUES('settings','{"locale":"en"}')`,
  );
  const local = new SyncStore(f.workspace, f.dir);
  await local.activate('user');
  f.db.prepare('UPDATE sync_state SET cursor=99').run();
  f.workspace.save('account-sync-cloud', 'user', '', { generation: 'generation-before-deletion' });
  const reset = t.mock.method((f.service as unknown as { local: SyncStore }).local, 'resetAfterCloudDeletion');
  await f.session();
  assert.equal(reset.mock.callCount(), 1);
  assert.equal(f.service.view().setup, 'merge');
  assert.deepEqual(f.service.view().merge?.local, { chats: 0, folders: 0, projects: 0, memories: 0 });
  assert.equal(f.service.view().merge?.accountChange, false);
  assert.equal(local.cursor, 0, 'A new cloud generation cannot reuse the old cloud cursor');
  assert.equal(f.service.view().sync, 'off');
  assert.equal(f.db.prepare('SELECT enabled FROM sync_state').get()?.enabled, 0, 'Nothing uploads before confirmation');
  await f.service.merge(true, false);
  assert.deepEqual(f.workspace.get('account-sync-cloud', 'user'), { generation: f.remote.generation });
  await (f.service as unknown as { engine: SyncEngine }).engine.syncNow();
  assert.ok(f.remote.records.has(JSON.stringify(['settings', 'settings'])), 'Confirmed: the settings refill the cloud');
});

test('merge summary counts live records without downloading them', async (t) => {
  const f = fixture(t);
  f.remote.pull = async () => {
    assert.fail('summary must not download records');
  };
  localChat(f.workspace);
  await f.session();
  assert.deepEqual(f.service.view().merge?.cloud, { chats: 0, folders: 0, projects: 0, memories: 0 });
});

test('two running devices stop stale new-record uploads after cloud deletion and wait at merge', async (t) => {
  const a = fixture(t);
  const b = fixture(t, true, a.remote);
  const sync = async (service: AccountService) => {
    // Drive the real service-owned engine without wall-clock polling delays.
    const engine = (service as unknown as { engine: SyncEngine }).engine;
    await engine.syncNow();
  };
  await a.session();
  await b.session();
  assert.equal(a.service.view().setup, 'ready');
  assert.equal(b.service.view().setup, 'ready');
  await sync(a.service);
  await sync(b.service);
  const oldGeneration = a.remote.generation;
  await a.service.deleteCloud(true);
  await until(() => a.service.view().setup === 'merge');
  assert.equal(a.service.view().setup, 'merge');
  assert.notEqual(a.remote.generation, oldGeneration);
  b.workspace.save('conversation', 'offline-new', '', { id: 'offline-new', title: 'Keep local edit' });
  await sync(b.service);
  await until(() => b.service.view().setup === 'merge');
  assert.equal(b.service.view().setup, 'merge');
  assert.equal(a.remote.records.size, 0, 'Even a last_seq=0 upload must reject the stale generation');
  assert.equal(b.workspace.get<{ title: string }>('conversation', 'offline-new')?.title, 'Keep local edit');
  await b.service.merge(true, false);
  assert.equal(b.service.view().setup, 'ready');
  await sync(b.service);
  await a.service.merge(true, false);
  await sync(a.service);
  assert.equal(a.workspace.get<{ title: string }>('conversation', 'offline-new')?.title, 'Keep local edit');
  assert.equal(a.service.view().sync, 'idle');
  assert.equal(b.service.view().sync, 'idle');
});

test('expired merge backup does not revoke an existing account sync consent', async (t) => {
  const f = fixture(t);
  await f.session();
  await f.service.handleMainMessage({ type: 'account-clear' });
  f.db.prepare('UPDATE sync_state SET backup=NULL').run();
  await f.session();
  assert.equal(f.service.view().setup, 'ready');
});

test('sign-out cleans expired backups after engine drain and close waits cleanup before disposal', async (t) => {
  const f = fixture(t);
  await f.session();
  const owned = f.service as unknown as { local: SyncStore; engine: SyncEngine; draining: Promise<unknown> };
  await owned.engine.syncNow();
  const backup = owned.local.backupPath!;
  assert.equal(existsSync(backup), true);
  f.db.prepare('UPDATE sync_backups SET first_success_at=?').run(Date.now() - 15 * 86400_000);
  await f.service.handleMainMessage({ type: 'account-clear' });
  await owned.draining;
  assert.equal(existsSync(backup), false, 'Signing out must retain the backup expiry cleanup');

  let release!: () => void;
  let cleanupStarted = false;
  const cleanup = t.mock.method(owned.local, 'cleanupBackups', async () => {
    cleanupStarted = true;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  await f.service.handleMainMessage({ type: 'account-clear' });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(cleanupStarted, true);
  let closed = false;
  const closing = f.service.close().then(() => {
    closed = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closed, false, 'Close must await outstanding cleanup before the owner closes SQLite');
  release();
  await closing;
  cleanup.mock.restore();
});
