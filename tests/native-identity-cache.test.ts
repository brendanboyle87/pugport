import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  linkSync,
  utimesSync,
  statSync,
  realpathSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as accounts from '../src/server/native-accounts.ts';
import { Controller } from '../src/server/controller.ts';
import type { RuntimeTarget, RuntimeSnapshot } from '../src/shared/types.ts';
type Reader = (target: RuntimeTarget) => string | undefined;
type Cache = { read(target: RuntimeTarget, reader: Reader): string | undefined; clear(): void };
function cache(): Cache {
  const ctor = (accounts as unknown as { NativeAccountDisplayCache?: new () => Cache }).NativeAccountDisplayCache;
  return ctor ? new ctor() : { read: (target, reader) => reader(target), clear() {} };
}
function fixture(provider: RuntimeTarget['provider']) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'identity-display-')));
  const id = '11111111-1111-4111-8111-111111111111';
  const home = join(root, 'accounts', id);
  mkdirSync(home, { recursive: true });
  const target: RuntimeTarget = {
    id: `${provider}-account-${id}`,
    provider,
    label: 'synthetic',
    command: process.execPath,
    environment: 'native',
    enabled: true,
    accountId: id,
    accountHome: home,
  };
  return { root, home, target };
}
test('display cache reuses identity twenty times; metadata, TTL and direct readers remain fresh', (t) => {
  const { home, target } = fixture('grok');
  const file = join(home, 'auth.json');
  const write = (id: string) => writeFileSync(file, JSON.stringify({ main: { auth_mode: 'web_login', user_id: id } }));
  write('synthetic-A');
  let reads = 0,
    now = 1000;
  t.mock.method(Date, 'now', () => now);
  const reader: Reader = (value) => {
    reads++;
    return accounts.nativeAccountFingerprint(value);
  };
  const display = cache();
  const first = display.read(target, reader);
  assert.ok(first);
  for (let i = 0; i < 20; i++) assert.equal(display.read(target, reader), first);
  assert.equal(reads, 1);
  const metadata = statSync(file);
  write('synthetic-B');
  utimesSync(file, metadata.atime, metadata.mtime);
  assert.notEqual(display.read(target, reader), first, 'same-size rewrite is caught by ctime');
  assert.equal(reads, 2);
  utimesSync(file, metadata.atime, new Date(metadata.mtimeMs + 10000));
  display.read(target, reader);
  assert.equal(reads, 3);
  now += 60000;
  display.read(target, reader);
  assert.equal(reads, 4);
  display.clear();
  display.read(target, reader);
  assert.equal(reads, 5);
  for (let i = 0; i < 3; i++) reader(target);
  assert.equal(reads, 8, 'execution/routing reader remains uncached');
  renameSync(file, join(home, 'saved-auth.json'));
  assert.equal(display.read(target, reader), undefined);
  const missingReads = reads;
  display.read(target, reader);
  assert.equal(reads, missingReads);
  write('synthetic-C');
  assert.ok(display.read(target, reader));
  linkSync(file, join(home, 'hardlink.json'));
  assert.equal(display.read(target, reader), undefined, 'cached hit cannot bypass link safety');
  const savedEnv = {
    GROK_HOME: process.env.GROK_HOME,
    GROK_AUTH_PATH: process.env.GROK_AUTH_PATH,
    CODEX_HOME: process.env.CODEX_HOME,
  };
  t.after(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  for (const provider of ['grok', 'codex'] as const) {
    const { home: defaultHome } = fixture(provider);
    const auth = join(defaultHome, provider === 'grok' ? 'custom-auth.json' : 'auth.json');
    process.env[provider === 'grok' ? 'GROK_HOME' : 'CODEX_HOME'] = defaultHome;
    if (provider === 'grok') process.env.GROK_AUTH_PATH = auth;
    writeFileSync(
      auth,
      JSON.stringify(
        provider === 'grok'
          ? { main: { auth_mode: 'web_login', user_id: 'default-synthetic' } }
          : { auth_mode: 'chatgpt', tokens: { account_id: 'default-synthetic' } },
      ),
    );
    const defaultTarget: RuntimeTarget = {
      ...target,
      id: `${provider}-native`,
      provider,
      accountId: undefined,
      accountHome: undefined,
    };
    let defaultReads = 0;
    const directDefault: Reader = (value) => {
      defaultReads++;
      return accounts.defaultNativeAccountFingerprint(value);
    };
    const defaultDisplay = cache();
    for (let i = 0; i < 20; i++) assert.ok(defaultDisplay.read(defaultTarget, directDefault));
    assert.equal(defaultReads, 1, provider);
    directDefault(defaultTarget);
    directDefault(defaultTarget);
    assert.equal(defaultReads, 3, 'default direct identity remains uncached');
  }
});
test('one display pass shares folder resolutions across accounts; the next pass resolves again', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'identity-display-')));
  const ids = ['22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'];
  const targets = ids.map((id): RuntimeTarget => {
    const home = join(root, 'base', 'accounts', id);
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'auth.json'), JSON.stringify({ main: { auth_mode: 'web_login', user_id: id } }));
    return {
      id: `grok-account-${id}`,
      provider: 'grok',
      label: 'synthetic',
      command: process.execPath,
      environment: 'native',
      enabled: true,
      accountId: id,
      accountHome: home,
    };
  });
  const display = new accounts.NativeAccountDisplayCache();
  const reader: Reader = (value) => accounts.nativeAccountFingerprint(value);
  const paths = new Map<string, string>();
  const identities = targets.map((target) => display.read(target, reader, paths));
  assert.deepEqual(identities, targets.map(reader), 'the same identities as direct reads');
  assert.ok(identities.every(Boolean));
  assert.ok(paths.has(join(root, 'base', 'accounts')), 'the shared accounts folder is resolved once for both');
  assert.deepEqual(
    targets.map((target) => display.read(target, reader, new Map())),
    identities,
    'a later pass hits the cache',
  );
  // A parent folder swapped for a link is invisible to lstat of the account folders; only resolving again sees it.
  renameSync(join(root, 'base'), join(root, 'base-real'));
  symlinkSync(join(root, 'base-real'), join(root, 'base'), 'junction');
  assert.deepEqual(
    targets.map((target) => display.read(target, reader, new Map())),
    [undefined, undefined],
  );
});
test('display cache tracks Claude and Cursor login markers independently', () => {
  for (const provider of ['claude', 'cursor'] as const) {
    if (provider === 'cursor' && process.platform !== 'win32') continue;
    const { home, target } = fixture(provider);
    const identity = provider === 'claude' ? join(home, '.claude.json') : join(home, '.cursor', 'cli-config.json');
    const marker =
      provider === 'claude' ? join(home, '.credentials.json') : join(home, 'AppData', 'Roaming', 'Cursor', 'auth.json');
    mkdirSync(join(identity, '..'), { recursive: true });
    mkdirSync(join(marker, '..'), { recursive: true });
    writeFileSync(
      identity,
      JSON.stringify(
        provider === 'claude'
          ? { oauthAccount: { emailAddress: 'synthetic@example.test', organizationUuid: 'test' } }
          : { authInfo: { userId: 'synthetic' } },
      ),
    );
    writeFileSync(marker, '{}');
    let reads = 0;
    const reader: Reader = (value) => {
      reads++;
      return accounts.nativeAccountFingerprint(value);
    };
    const display = cache();
    assert.ok(display.read(target, reader));
    for (let i = 0; i < 20; i++) display.read(target, reader);
    assert.equal(reads, 1, provider);
    if (provider !== 'claude' || process.platform !== 'darwin') {
      renameSync(marker, `${marker}.saved`);
      assert.equal(display.read(target, reader), undefined, provider);
      writeFileSync(marker, '{}');
      assert.ok(display.read(target, reader), provider);
    }
  }
});
test('controller display guard accepts cached reader while routing and execution guard read every time', async (t) => {
  const { home, target } = fixture('grok');
  writeFileSync(join(home, 'auth.json'), JSON.stringify({ main: { auth_mode: 'web_login', user_id: 'synthetic' } }));
  target.accountFingerprint = accounts.nativeAccountFingerprint(target);
  const snapshot = {
    id: target.id,
    provider: target.provider,
    status: 'ready',
    accountFingerprint: target.accountFingerprint,
    quota: { status: 'known', windows: [] },
  } as unknown as RuntimeSnapshot;
  let reads = 0;
  const reader: Reader = (value) => {
    reads++;
    return accounts.nativeAccountFingerprint(value);
  };
  const controller = Object.assign(Object.create(Controller.prototype), {
    readAccountIdentity: reader,
    nativeLoginPending: () => false,
  }) as { identityGuard(target: RuntimeTarget, snapshot: RuntimeSnapshot, reader?: Reader): RuntimeSnapshot };
  const display = cache();
  for (let i = 0; i < 20; i++) controller.identityGuard(target, snapshot, (value) => display.read(value, reader));
  assert.equal(reads, 1);
  for (let i = 0; i < 3; i++) controller.identityGuard(target, snapshot);
  assert.equal(reads, 4);
  reads = 0;
  const usageReport = { synthetic: true };
  const legacyUsage = {
    report() {
      assert.equal(this, legacyUsage);
      return usageReport;
    },
  };
  Object.assign(controller, {
    root: home,
    dataDir: home,
    store: { runSummaries: () => [] },
    targets: [target],
    snapshots: [snapshot],
    active: new Map(),
    approvals: new Map(),
    autoResetCards: { records: {} },
    settings: {},
    apiProviders: () => [],
    backgroundTasks: () => [],
    inbox: { summary: () => ({}) },
    sandboxHealth: { snapshot: () => ({}) },
    usage: legacyUsage,
    quotaHistory: { summary: () => ({}) },
    judgments: { report: () => ({}) },
  });
  for (let i = 0; i < 20; i++)
    assert.equal(Controller.prototype.state.call(controller as unknown as Controller).usage, usageReport);
  assert.equal(reads, 1, 'only real state builds opt into the display cache');
  controller.identityGuard(target, snapshot);
  assert.equal(reads, 2, 'a guard after state still reads directly');
  const cachedFingerprint = target.accountFingerprint;
  target.accountFingerprint = 'synthetic-wrong-account';
  const beforeEnable = reads;
  for (let i = 0; i < 2; i++)
    assert.throws(
      () => Controller.prototype.updateTarget.call(controller as unknown as Controller, target.id, { enabled: true }),
      Error,
    );
  assert.equal(reads, beforeEnable + 2, 'enabling rereads despite the display cache');
  target.accountFingerprint = cachedFingerprint;
  Object.assign(controller, {
    bridgeTokens: new Map(),
    canSteer: () => true,
    active: new Map([
      [
        'run',
        {
          run: { route: { runtimeId: target.id, accountFingerprint: 'synthetic-wrong-account' } },
          abort: new AbortController(),
        },
      ],
    ]),
  });
  const beforeSteer = reads;
  for (let i = 0; i < 2; i++)
    await assert.rejects(
      () => Controller.prototype.steer.call(controller as unknown as Controller, 'run', 'synthetic supplement'),
      Error,
    );
  assert.equal(reads, beforeSteer + 2, 'steering rereads despite the display cache');
  Object.assign(controller, {
    active: new Map(),
    assertAvailableRuntime() {},
    routeCapacity: () => ({}),
    clock: Date.now,
    resetRedemptions: new Set(),
    health: (value: RuntimeSnapshot) => value,
  });
  target.accountFingerprint = 'synthetic-wrong-account';
  const beforePreview = reads;
  for (let i = 0; i < 2; i++)
    assert.throws(() =>
      Controller.prototype.preview.call(controller as unknown as Controller, {
        runtimeId: target.id,
        prompt: 'synthetic',
        projectPath: home,
        kind: 'routine',
      }),
    );
  assert.equal(reads, beforePreview + 2, 'the pre-execution route preview rereads despite the display cache');
  target.accountFingerprint = cachedFingerprint;

  const live = controller as unknown as Controller;
  const displayCache = (controller as unknown as { identityDisplayCache: Cache }).identityDisplayCache;
  const clears = t.mock.method(displayCache, 'clear');
  Object.assign(controller, {
    updating: new Set(),
    launchingLogins: new Set(),
    watchedLogins: new Set(),
    targetGeneration: 0,
    nativeAccount: () => target,
    repairManagedTargetPaths() {},
    clearCursorReference() {},
    watchNativeLogin() {},
    pollNativeLogins: async () => {},
    launchNativeLogin: async () => {},
    store: { runSummaries: () => [], setConfig() {}, config: () => ({}) },
    broadcast: () => assert.ok(clears.mock.callCount() > 0, 'clear before announcing login'),
    health: (value: RuntimeSnapshot) => value,
    cooldown: { clear() {}, forget() {} },
    saveCursorReferences() {},
    emit() {},
    nativeAccounts: () => [],
    discoverTarget: async () => {
      Controller.prototype.state.call(live);
      return snapshot;
    },
  });
  await live.loginNativeAccount(target.id);
  assert.equal(clears.mock.callCount(), 1);
  Object.assign(controller, { snapshots: [snapshot] });
  await live.checkNativeAccount(target.id);
  assert.equal(clears.mock.callCount(), 3, 'check clears before and after asynchronous discovery');
  const afterCheck = reads;
  Controller.prototype.state.call(live);
  assert.equal(reads, afterCheck + 1, 'successful check cannot leave a display cache filled during discovery');
  const builtIn = { ...target, id: 'grok-native', accountId: undefined, accountHome: undefined };
  Object.assign(controller, {
    targets: [builtIn],
    inbox: { resolveRuntime() {} },
    accountHealth: { forget() {} },
    freeHealth: { forget() {} },
  });
  await live.removeNativeAccount(builtIn.id);
  assert.equal(clears.mock.callCount(), 4, 'removing the card clears display state without touching a real folder');
});
