import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { Controller } from '../src/server/controller.ts';
import { Store } from '../src/server/store.ts';
import { TaskJudge } from '../src/server/task-judgment.ts';
import { codexAdapter } from '../src/server/adapters/codex.ts';
import { syntheticCodex } from './helpers/codex-rpc.ts';
import { RouteUnavailableError } from '../src/server/routing.ts';
import type { ExecuteContext, RunRecord, RuntimeSnapshot, RuntimeTarget } from '../src/shared/types.ts';

type Mode = NonNullable<RuntimeSnapshot['authMode']>;
function snapshot(target: RuntimeTarget, mode: Mode): RuntimeSnapshot {
  return {
    id: target.id,
    provider: target.provider,
    label: target.label,
    environment: 'native',
    installed: true,
    status: 'ready',
    authMode: mode,
    models: [{ id: 'fixture-model', label: 'Synthetic full model', efforts: ['medium'] }],
    // Deliberately retain stale quota on API fixtures: the controller must not
    // carry an earlier subscription balance across a verified mode change.
    quota: {
      status: 'known',
      source: 'Synthetic subscription',
      observedAt: new Date().toISOString(),
      windows: [
        { id: 'week', label: 'Week', usedPercent: 10, resetsAt: new Date(Date.now() + 86_400_000).toISOString() },
      ],
    },
    capabilities: { execute: true, resume: true, cancel: true, approvals: true },
    refreshedAt: new Date().toISOString(),
  };
}
function fixture(t: TestContext, mode: Mode, managed = false) {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'comborunner-codex-auth-mode-'))),
    home = join(directory, 'home'),
    dataDir = join(directory, 'data');
  mkdirSync(home, { recursive: true });
  const overrides: Record<string, string | undefined> = {
    HOME: home,
    USERPROFILE: home,
    APPDATA: home,
    LOCALAPPDATA: home,
    XDG_CONFIG_HOME: home,
    PATH: '',
    CODEX_HOME: join(home, 'codex'),
    GROK_HOME: join(home, 'grok'),
    CLAUDE_CONFIG_DIR: join(home, 'claude'),
    OPENAI_API_KEY: undefined,
    CODEX_API_KEY: undefined,
    JEV_API_KEY: undefined,
    TYPESAFE_API_KEY: undefined,
  };
  const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  let controller: Controller;
  t.after(async () => {
    try {
      await controller?.close();
    } finally {
      for (const [key, value] of Object.entries(previous))
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      assert.ok(
        resolve(directory).startsWith(realpathSync.native(tmpdir()) + sep) &&
          basename(directory).startsWith('comborunner-codex-auth-mode-'),
      );
      rmSync(directory, { recursive: true, force: true });
    }
  });
  for (const [key, value] of Object.entries(overrides))
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  assert.equal(resolve(homedir()), resolve(home));
  const target: RuntimeTarget = {
    id: managed ? 'codex-account-fixture' : 'codex-native',
    provider: 'codex',
    label: 'Synthetic Codex',
    command: 'never-spawned',
    commandDiscovery: 'fixed',
    environment: 'native',
    enabled: true,
    accountFingerprint: 'old-chatgpt-identity',
    ...(managed ? { accountId: 'fixture-account', accountHome: join(dataDir, 'accounts', 'fixture-account') } : {}),
  };
  const modes = new Map<string, Mode>([[target.id, mode]]),
    identities = new Map<string, string | undefined>([
      [target.id, mode === 'chatgpt' ? target.accountFingerprint : undefined],
    ]);
  const seed = new Store(dataDir);
  seed.setConfig('targets', [
    target,
    { id: 'pi-local', provider: 'pi', label: 'Disabled Pi', command: 'unused', environment: 'native', enabled: false },
  ]);
  seed.close();
  controller = new Controller(directory, dataDir, {
    readAccountIdentity: (runtime) => identities.get(runtime.id),
    taskJudge: new TaskJudge({
      credential: () => undefined,
      fetch: async () => {
        throw new Error('Network is forbidden');
      },
    }),
  });
  clearInterval(controller.timer);
  controller.settings.architectureProvider = 'codex';
  const calls: ExecuteContext[] = [];
  let failureInfo: unknown;
  t.mock.method(codexAdapter, 'discover', async (runtime: RuntimeTarget) =>
    snapshot(runtime, modes.get(runtime.id) ?? 'unknown'),
  );
  t.mock.method(codexAdapter, 'execute', async (context: ExecuteContext) => {
    calls.push(context);
    return syntheticCodex(
      failureInfo ? { failure: { message: 'Synthetic failure', codexErrorInfo: failureInfo } } : {},
    ).execute(context);
  });
  return {
    directory,
    controller,
    target: controller.targets.find((runtime) => runtime.id === target.id)!,
    modes,
    identities,
    calls,
    failExecution: (info: unknown = 'usageLimitExceeded') => {
      failureInfo = info;
    },
    input: { prompt: 'Synthetic task', projectPath: directory, kind: 'general' as const, provider: 'codex' as const },
  };
}
async function done(controller: Controller, run: RunRecord) {
  const deadline = Date.now() + 4000;
  while (controller.active.has(run.id) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(controller.active.has(run.id), false);
  return controller.store.run(run.id)!;
}
function prior(target: RuntimeTarget, projectPath: string): RunRecord {
  return {
    id: 'old-chatgpt-run',
    prompt: 'Prior synthetic request',
    projectPath,
    kind: 'general',
    status: 'failed',
    output: '',
    events: [],
    error: 'authentication-required',
    account: {
      id: target.accountId ?? target.id,
      label: target.label,
      provider: 'codex',
      fingerprint: target.accountFingerprint,
    },
    nativeSessionId: 'old-chatgpt-thread',
    route: {
      runtimeId: target.id,
      model: 'fixture-model',
      kind: 'general',
      reasons: [],
      warnings: [],
      accountFingerprint: target.accountFingerprint,
    },
    startedAt: new Date().toISOString(),
  };
}

test('checking an explicit default Codex API login clears stale identity while preserving ready execution and usage accounting', async (t) => {
  const f = fixture(t, 'apiKey'),
    old = prior(f.target, f.directory);
  f.controller.accountHealth.failure(f.target, old);
  f.controller.store.saveRun(old);
  const state = await f.controller.checkNativeAccount(f.target.id),
    current = f.controller.snapshots[0]!;
  assert.equal(f.target.enabled, true);
  assert.equal(f.target.accountFingerprint, undefined);
  assert.equal(current.accountFingerprint, undefined);
  assert.equal(current.authMode, 'apiKey');
  assert.equal(current.status, 'ready');
  assert.equal(current.accounting?.mode, 'usage');
  assert.equal(current.quota.status, 'unknown');
  assert.deepEqual(current.quota.windows, []);
  assert.equal(state.accounts[0]?.identityKnown, false);
  assert.equal(state.accounts[0]?.availability, undefined);
  assert.equal(f.controller.accountHealth.report().length, 1, 'old subscription failure remains historical data');
  assert.equal(f.controller.preview(f.input).runtimeId, f.target.id);
  await assert.rejects(f.controller.start({ ...f.input, resumeRunId: old.id }), /身份已变化/);
  const run = await done(f.controller, await f.controller.start(f.input));
  assert.equal(run.status, 'completed');
  assert.equal(run.account, undefined);
  assert.equal(run.route.accountFingerprint, undefined);
  assert.equal(f.controller.usage.report().perRun.find((row) => row.runId === run.id)?.accountingMode, 'usage');
});

test('regular discovery transitions a default Codex profile from stored ChatGPT identity to explicit API mode', async (t) => {
  const f = fixture(t, 'apiKey');
  await f.controller.refresh();
  assert.equal(f.target.accountFingerprint, undefined);
  assert.equal(f.controller.snapshots[0]?.authMode, 'apiKey');
  assert.equal(f.controller.snapshots[0]?.accounting?.mode, 'usage');
  assert.equal(f.controller.preview(f.input).accountFingerprint, undefined);
  const stored = f.controller.store.config<RuntimeTarget[]>('targets', []).find((target) => target.id === f.target.id)!;
  assert.equal(stored.accountFingerprint, undefined);
  assert.equal(stored.enabled, true);
  assert.equal(f.calls.length, 0);
});

for (const mode of ['apiKey', 'unknown'] as const)
  test(`a managed Codex ${mode} response cannot enable or dispatch a subscription account`, async (t) => {
    const f = fixture(t, mode, true);
    // Even a leftover parseable identity cannot make the wrong auth mode valid.
    f.identities.set(f.target.id, 'old-chatgpt-identity');
    await f.controller.checkNativeAccount(f.target.id);
    assert.equal(f.target.enabled, false);
    assert.equal(f.controller.snapshots[0]?.status, 'auth-required');
    assert.throws(() => f.controller.updateTarget(f.target.id, { enabled: true }), /ChatGPT/);
    assert.throws(() => f.controller.preview({ ...f.input, runtimeId: f.target.id }), RouteUnavailableError);
    assert.equal(f.calls.length, 0);
  });

test('unknown default authentication is not treated as API and does not erase the last known ChatGPT identity', async (t) => {
  const f = fixture(t, 'unknown');
  await f.controller.refresh();
  assert.equal(f.target.accountFingerprint, 'old-chatgpt-identity');
  assert.equal(f.controller.snapshots[0]?.authMode, 'unknown');
  assert.equal(f.controller.snapshots[0]?.status, 'auth-required');
  assert.throws(() => f.controller.preview(f.input), RouteUnavailableError);
  await f.controller.checkNativeAccount(f.target.id);
  assert.equal(f.target.enabled, false);
  assert.equal(f.target.accountFingerprint, 'old-chatgpt-identity');
  assert.equal(f.calls.length, 0);
});

for (const status of ['missing', 'error'] as const)
  test(`a managed Codex ${status} discovery keeps its real failure instead of claiming login is required`, async (t) => {
    const f = fixture(t, 'unknown', true);
    f.identities.set(f.target.id, 'old-chatgpt-identity');
    const note = status === 'missing' ? 'runtime-not-found' : 'runtime-protocol-incompatible';
    t.mock.method(codexAdapter, 'discover', async (runtime: RuntimeTarget) => ({
      ...snapshot(runtime, 'unknown'),
      status,
      installed: status !== 'missing',
      note,
      subscription: { label: 'Stale plan', source: 'Synthetic', observedAt: new Date().toISOString() },
    }));
    await f.controller.refresh();
    const current = f.controller.state().runtimes.find((runtime) => runtime.id === f.target.id)!;
    assert.equal(current.status, status);
    assert.equal(current.note, note);
    assert.equal(current.installed, status !== 'missing');
    assert.equal(current.subscription, undefined);
    assert.equal(current.quota.status, 'unknown');
    assert.deepEqual(current.quota.windows, []);
    assert.equal(current.quota.observedAt, null);
    assert.equal(f.target.accountFingerprint, 'old-chatgpt-identity');
    assert.throws(() => f.controller.preview({ ...f.input, runtimeId: f.target.id }), RouteUnavailableError);
    assert.equal(f.calls.length, 0);
  });

test('checking an existing account repairs a removed desktop binary before native discovery', async (t) => {
  if (process.platform !== 'win32') return;
  const f = fixture(t, 'chatgpt', true),
    accountId = '12345678-1234-4234-8234-123456789abc',
    root = join(process.env.LOCALAPPDATA!, 'OpenAI', 'Codex', 'bin'),
    current = join(root, '1111111111111111', 'codex.exe');
  mkdirSync(dirname(current), { recursive: true });
  writeFileSync(current, 'Synthetic binary; discovery is mocked and never launches it.');
  f.target.id = `codex-account-${accountId}`;
  f.target.accountId = accountId;
  f.target.command = join(root, '0000000000000000', 'codex.exe');
  const home = f.target.accountHome;
  f.identities.set(f.target.id, 'old-chatgpt-identity');
  const observed: RuntimeTarget[] = [];
  t.mock.method(codexAdapter, 'discover', async (runtime: RuntimeTarget) => {
    observed.push({ ...runtime });
    return snapshot(runtime, 'chatgpt');
  });
  await f.controller.checkNativeAccount(f.target.id);
  assert.equal(observed[0]?.command, current);
  assert.equal(f.target.commandDiscovery, 'auto');
  assert.equal(f.target.accountHome, home);
  assert.equal(f.target.accountFingerprint, 'old-chatgpt-identity');
  assert.equal(f.controller.snapshots[0]?.status, 'ready');
  const saved = f.controller.store.config<RuntimeTarget[]>('targets', []).find((target) => target.id === f.target.id)!;
  assert.equal(saved.command, current);
  assert.equal(saved.commandDiscovery, 'auto');
  assert.equal(saved.accountHome, home);
  assert.equal(f.calls.length, 0);
});

test('API failures keep their own runtime cooldown and never rotate into ChatGPT accounts', async (t) => {
  const f = fixture(t, 'apiKey');
  await f.controller.checkNativeAccount(f.target.id);
  const managed: RuntimeTarget = {
    ...f.target,
    id: 'codex-account-other',
    accountId: 'other',
    accountHome: join(f.directory, 'accounts', 'other'),
    accountFingerprint: 'other-chatgpt-identity',
  };
  f.controller.targets.push(managed);
  f.modes.set(managed.id, 'chatgpt');
  f.identities.set(managed.id, managed.accountFingerprint);
  f.controller.snapshots.push({ ...snapshot(managed, 'chatgpt'), accountFingerprint: managed.accountFingerprint });
  f.failExecution();
  const run = await done(f.controller, await f.controller.start({ ...f.input, runtimeId: f.target.id }));
  assert.equal(run.error, 'quota-or-rate-limit');
  assert.equal(run.account, undefined);
  assert.equal(f.controller.accountRelay(f.input, run), undefined);
  const health = f.controller.accountHealth.report();
  assert.equal(health.length, 1);
  assert.equal(health[0]!.reason, 'quota');
  assert.equal(health[0]!.accountFingerprint, undefined);
  assert.throws(
    () => f.controller.preview({ ...f.input, runtimeId: f.target.id }),
    (error: unknown) => error instanceof RouteUnavailableError && error.kind === 'quota',
  );
  assert.equal(
    f.controller.accountHealth.apply(f.controller.snapshots.find((snapshot) => snapshot.id === managed.id)!)
      .availability,
    undefined,
  );
});

test('an explicit default API profile is excluded as the second account for a ChatGPT quota failure', async (t) => {
  const f = fixture(t, 'apiKey');
  await f.controller.checkNativeAccount(f.target.id);
  const managed: RuntimeTarget = {
    ...f.target,
    id: 'codex-account-other',
    accountId: 'other',
    accountHome: join(f.directory, 'accounts', 'other'),
    accountFingerprint: 'other-chatgpt-identity',
  };
  f.controller.targets.push(managed);
  f.modes.set(managed.id, 'chatgpt');
  f.identities.set(managed.id, managed.accountFingerprint);
  f.controller.snapshots.push({ ...snapshot(managed, 'chatgpt'), accountFingerprint: managed.accountFingerprint });
  const failed = { ...prior(managed, f.directory), error: 'quota-or-rate-limit' };
  assert.equal(f.controller.accountRelay(f.input, failed), undefined);
  assert.equal(f.calls.length, 0);
});

test('only an explicit successful API check clears its authentication latch while preserving old subscription history', async (t) => {
  const f = fixture(t, 'apiKey'),
    old = prior(f.target, f.directory);
  f.controller.accountHealth.failure(f.target, old);
  await f.controller.checkNativeAccount(f.target.id);
  f.failExecution('unauthorized');
  const run = await done(f.controller, await f.controller.start(f.input));
  assert.equal(run.error, 'authentication-required');
  assert.equal(f.controller.accountHealth.report().length, 2);
  assert.throws(() => f.controller.preview(f.input), RouteUnavailableError);
  await f.controller.refresh();
  assert.throws(
    () => f.controller.preview(f.input),
    RouteUnavailableError,
    'background refresh does not clear authentication failure',
  );
  await f.controller.checkNativeAccount(f.target.id);
  assert.equal(f.controller.preview(f.input).runtimeId, f.target.id);
  assert.equal(f.controller.accountHealth.report().length, 1);
  assert.equal(f.controller.accountHealth.report()[0]!.accountFingerprint, 'old-chatgpt-identity');
});
