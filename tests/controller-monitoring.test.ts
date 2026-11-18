import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { Controller } from '../src/server/controller.ts';
import { Store } from '../src/server/store.ts';
import { TaskJudge } from '../src/server/task-judgment.ts';
import { grokAdapter } from '../src/server/adapters/grok.ts';
import { codexAdapter } from '../src/server/adapters/codex.ts';
import type { RunRecord, RuntimeSnapshot, RuntimeTarget } from '../src/shared/types.ts';

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!predicate() && Date.now() < deadline) await sleep(5);
  assert.equal(predicate(), true, 'the login completion should be checked without a manual request');
}
function observed(target: RuntimeTarget): RuntimeSnapshot {
  return {
    id: target.id,
    provider: target.provider,
    authMode: target.provider === 'codex' ? 'chatgpt' : undefined,
    label: target.label,
    environment: 'native',
    installed: true,
    status: 'ready',
    models: [{ id: 'grok-4.7', label: 'Synthetic model', efforts: ['medium'] }],
    quota: {
      status: 'known',
      source: 'Synthetic billing observation',
      observedAt: new Date().toISOString(),
      windows: [
        {
          id: 'week',
          label: '每周额度',
          usedPercent: 24,
          resetsAt: new Date(Date.now() + 86400000).toISOString(),
          durationMinutes: 10080,
        },
      ],
    },
    accounting: { mode: 'subscription', source: 'Synthetic login type' },
    capabilities: { execute: true, resume: true, cancel: true, approvals: false },
    refreshedAt: new Date().toISOString(),
  };
}
function fixture(
  t: TestContext,
  options: { pendingAtStartup?: boolean; duplicate?: boolean; provider?: 'grok' | 'codex' } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), 'comborunner-login-monitor-')),
    home = join(directory, 'home'),
    dataDir = join(directory, 'data');
  mkdirSync(home, { recursive: true });
  const env: Record<string, string | undefined> = {
    HOME: home,
    USERPROFILE: home,
    APPDATA: home,
    LOCALAPPDATA: home,
    XDG_CONFIG_HOME: home,
    PATH: '',
    GROK_HOME: join(home, 'grok'),
    CODEX_HOME: join(home, 'codex'),
    CLAUDE_CONFIG_DIR: join(home, 'claude'),
    JEV_API_KEY: undefined,
    TYPESAFE_API_KEY: undefined,
  };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(env))
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  assert.equal(resolve(homedir()), resolve(home), 'the fixture must never read the real home or credentials');
  const provider = options.provider ?? 'grok';
  const original: RuntimeTarget = {
    id: `${provider}-native`,
    provider,
    label: 'Synthetic A',
    command: 'fixture-only',
    commandDiscovery: 'fixed',
    environment: 'native',
    enabled: true,
    accountFingerprint: 'account-a',
  };
  const managed: RuntimeTarget = {
    ...original,
    id: `${provider}-account-fixture`,
    label: 'Synthetic B',
    enabled: false,
    accountId: 'fixture-profile',
    accountHome: join(dataDir, 'accounts', 'fixture-profile'),
    accountFingerprint: options.duplicate ? 'account-a' : 'account-b',
  };
  const seed = new Store(dataDir);
  seed.setConfig('targets', [
    original,
    managed,
    {
      id: 'pi-local',
      provider: 'pi',
      label: 'Unused Pi',
      command: 'fixture-only',
      environment: 'native',
      enabled: false,
    },
  ]);
  seed.close();
  const identities = new Map([
    [original.id, original.accountFingerprint],
    [managed.id, managed.accountFingerprint],
  ]);
  const pending = new Set<string>(options.pendingAtStartup ? [managed.id] : []);
  const discoveries: string[] = [];
  let discover: (target: RuntimeTarget) => Promise<RuntimeSnapshot> = async (target) => observed(target),
    launchFails = false;
  const adapter = provider === 'codex' ? codexAdapter : grokAdapter;
  t.mock.method(adapter, 'discover', async (target: RuntimeTarget) => {
    discoveries.push(target.id);
    return discover(target);
  });
  t.mock.method(adapter, 'execute', async () => {
    throw new Error('No model execution is permitted in these tests.');
  });
  let controller: Controller,
    closed = true;
  const open = () => {
    controller = new Controller(directory, dataDir, {
      readAccountIdentity: (target) => identities.get(target.id),
      taskJudge: new TaskJudge({
        credential: () => undefined,
        fetch: async () => {
          throw new Error('No network in login fixtures.');
        },
      }),
      nativeLogin: {
        pollMs: 10,
        pending: (target) => pending.has(target.id),
        launch: async (target) => {
          if (launchFails) throw new Error('Synthetic terminal launch failed');
          pending.add(target.id);
          return { opened: true };
        },
      },
    });
    closed = false;
    clearInterval(controller.timer);
  };
  open();
  const close = async () => {
    if (!closed) {
      await controller.close();
      closed = true;
    }
  };
  t.after(async () => {
    try {
      await close();
    } finally {
      for (const [key, value] of Object.entries(previous))
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      assert.ok(
        resolve(directory).startsWith(resolve(tmpdir()) + sep) &&
          basename(directory).startsWith('comborunner-login-monitor-'),
      );
      rmSync(directory, { recursive: true, force: true });
    }
  });
  return {
    id: managed.id,
    pending,
    discoveries,
    identities,
    get controller() {
      return controller;
    },
    get target() {
      return controller.targets.find((target) => target.id === managed.id)!;
    },
    discovery: (fn: typeof discover) => {
      discover = fn;
    },
    failLaunch: () => {
      launchFails = true;
    },
    close,
    restart: async () => {
      await close();
      open();
    },
  };
}

test('a managed login completion triggers one real discovery and publishes its quota without a manual GET/check', async (t) => {
  const f = fixture(t);
  await f.controller.loginNativeAccount(f.id);
  assert.equal(f.target.enabled, false);
  assert.equal(f.discoveries.length, 0);
  await sleep(30);
  assert.equal(f.discoveries.length, 0, 'a pending login must not be inspected');
  f.pending.delete(f.id);
  await until(() => f.target.enabled);
  assert.deepEqual(f.discoveries, [f.id]);
  const account = f.controller.nativeAccounts().accounts.find((account) => account.runtimeId === f.id)!;
  assert.equal(account.loginPending, false);
  assert.equal(account.quota.status, 'known');
  assert.equal(account.quota.windows[0]?.usedPercent, 24);
  assert.ok(account.quota.windows[0]?.resetsAt);
  for (let i = 0; i < 3; i++) f.controller.nativeAccounts();
  await sleep(40);
  assert.deepEqual(f.discoveries, [f.id], 'completion is consumed once and cached reads have no side effects');
});

test('restart recovers an in-progress managed login but not an unrelated disabled profile', async (t) => {
  const f = fixture(t, { pendingAtStartup: true });
  await f.restart();
  await sleep(25);
  assert.equal(f.discoveries.length, 0);
  f.pending.delete(f.id);
  await until(() => f.target.enabled);
  assert.deepEqual(f.discoveries, [f.id]);
  f.target.enabled = false;
  f.controller.store.setConfig('targets', f.controller.targets);
  await f.restart();
  await sleep(40);
  assert.equal(f.target.enabled, false);
  assert.deepEqual(f.discoveries, [f.id], 'a finished or disabled profile is not a new login request');
});

for (const provider of ['grok', 'codex'] as const) {
  test(`${provider}: explicit execution opt-out survives successful checking and restart until re-enabled`, async (t) => {
    const f = fixture(t, { provider });
    await f.controller.checkNativeAccount(f.id);
    assert.equal(f.target.enabled, true, 'a new verified profile may become usable');
    f.controller.updateTarget(f.id, { enabled: false });
    await f.controller.refresh();
    assert.equal(f.target.executionDisabledByUser, true);
    await f.controller.checkNativeAccount(f.id);
    assert.equal(f.target.enabled, false, 'reading quota does not authorize inference');
    assert.equal(
      f.controller.nativeAccounts().accounts.find((account) => account.runtimeId === f.id)?.quota.windows[0]
        ?.usedPercent,
      24,
    );
    assert.throws(() =>
      f.controller.preview({ runtimeId: f.id, prompt: 'Synthetic', projectPath: process.cwd(), kind: 'general' }),
    );
    await f.restart();
    assert.equal(f.target.executionDisabledByUser, true);
    assert.equal(f.target.enabled, false);
    await f.controller.checkNativeAccount(f.id);
    assert.equal(f.target.enabled, false);
    f.controller.updateTarget(f.id, { enabled: true });
    await f.controller.refresh();
    assert.equal(f.target.enabled, true);
    assert.equal(f.target.executionDisabledByUser, undefined);
    await f.restart();
    assert.equal(f.target.enabled, true);
    assert.equal(f.target.executionDisabledByUser, undefined);
  });

  test(`${provider}: a completed re-login refreshes but never re-enables an opted-out account`, async (t) => {
    const f = fixture(t, { provider });
    f.controller.updateTarget(f.id, { enabled: false });
    await f.controller.refresh();
    f.discoveries.length = 0;
    await f.controller.loginNativeAccount(f.id);
    await f.restart();
    f.pending.delete(f.id);
    await until(() => f.controller.snapshots.some((snapshot) => snapshot.id === f.id));
    assert.deepEqual(f.discoveries, [f.id]);
    assert.equal(f.target.enabled, false);
    assert.equal(f.target.executionDisabledByUser, true);
    assert.equal(f.controller.nativeAccounts().accounts.find((account) => account.runtimeId === f.id)?.status, 'ready');
  });
}

test('checking a default Codex API login also preserves an explicit execution opt-out', async (t) => {
  const f = fixture(t, { provider: 'codex' }),
    id = 'codex-native';
  f.discovery(async (target) => ({ ...observed(target), authMode: 'apiKey' }));
  await f.controller.checkNativeAccount(id);
  f.controller.updateTarget(id, { enabled: false });
  await f.controller.refresh();
  await f.controller.checkNativeAccount(id);
  const target = f.controller.targets.find((value) => value.id === id)!;
  assert.equal(target.enabled, false);
  assert.equal(target.executionDisabledByUser, true);
  assert.equal(f.controller.snapshots.find((value) => value.id === id)?.accounting?.mode, 'usage');
  f.controller.updateTarget(id, { enabled: true });
  await f.controller.refresh();
  assert.equal(target.enabled, true);
  assert.equal(target.executionDisabledByUser, undefined);
});

test('a login into the same identity remains disabled after its automatic check', async (t) => {
  const f = fixture(t, { duplicate: true });
  await f.controller.loginNativeAccount(f.id);
  f.pending.delete(f.id);
  await until(() => f.controller.snapshots.some((snapshot) => snapshot.id === f.id));
  assert.equal(f.target.enabled, false);
  assert.deepEqual(f.discoveries, [f.id]);
  assert.equal(
    f.controller.nativeAccounts().accounts.find((account) => account.runtimeId === f.id)?.duplicateOf,
    'grok-native',
  );
});

test('automatic post-login checking preserves an existing quota cooldown', async (t) => {
  const f = fixture(t),
    at = new Date().toISOString();
  const failed: RunRecord = {
    id: 'synthetic-quota-failure',
    prompt: 'Synthetic',
    projectPath: '',
    kind: 'general',
    status: 'failed',
    route: { runtimeId: f.id, model: 'grok-4.7', kind: 'general', reasons: [], warnings: [] },
    startedAt: at,
    output: '',
    events: [],
    error: 'quota-or-rate-limit',
  };
  f.controller.accountHealth.failure(f.target, failed);
  const before = f.controller.accountHealth.report();
  await f.controller.loginNativeAccount(f.id);
  f.pending.delete(f.id);
  await until(() => f.target.enabled);
  assert.deepEqual(f.controller.accountHealth.report(), before);
  assert.equal(
    f.controller.nativeAccounts().accounts.find((account) => account.runtimeId === f.id)?.availability?.reason,
    'quota',
  );
});

test('a failed completion check is not retried indefinitely and explicit checking still works', async (t) => {
  const f = fixture(t);
  f.discovery(async () => {
    throw new Error('Synthetic discovery failed');
  });
  await f.controller.loginNativeAccount(f.id);
  f.pending.delete(f.id);
  await until(() => f.discoveries.length === 1);
  await sleep(50);
  assert.equal(f.target.enabled, false);
  assert.equal(f.discoveries.length, 1);
  f.discovery(async (target) => observed(target));
  await f.controller.checkNativeAccount(f.id);
  assert.equal(f.target.enabled, true);
  assert.equal(f.discoveries.length, 2);
});

test('failed terminal launch does not trigger a successful-login check', async (t) => {
  const f = fixture(t);
  f.failLaunch();
  await assert.rejects(f.controller.loginNativeAccount(f.id), /Synthetic terminal launch failed/);
  await sleep(40);
  assert.equal(f.discoveries.length, 0);
  assert.equal(f.target.enabled, false);
});

test('shutdown stops a pending-login observer and rejects new login work', async (t) => {
  const f = fixture(t);
  await f.controller.loginNativeAccount(f.id);
  await f.close();
  f.pending.delete(f.id);
  await sleep(40);
  assert.equal(f.discoveries.length, 0);
  await assert.rejects(f.controller.loginNativeAccount(f.id), /正在关闭/);
});

test('shutdown waits for an in-flight login check and never applies it to a closed store', async (t) => {
  const f = fixture(t);
  let release!: () => void;
  const gate = new Promise<void>((done) => {
    release = done;
  });
  f.discovery(async (target) => {
    await gate;
    return observed(target);
  });
  await f.controller.loginNativeAccount(f.id);
  f.pending.delete(f.id);
  await until(() => f.discoveries.length === 1);
  let closed = false;
  const closing = f.close().then(() => {
    closed = true;
  });
  await sleep(20);
  assert.equal(closed, false);
  release();
  await closing;
  assert.equal(f.target.enabled, false);
  assert.equal(f.controller.snapshots.length, 0);
  assert.equal(f.discoveries.length, 1);
});
