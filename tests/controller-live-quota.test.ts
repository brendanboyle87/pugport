import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { Controller } from '../src/server/controller.ts';
import { Store } from '../src/server/store.ts';
import { codexAdapter } from '../src/server/adapters/codex.ts';
import { claudeAdapter } from '../src/server/adapters/claude.ts';
import { cursorAdapter } from '../src/server/adapters/cursor.ts';
import { quotaPoolKey, route, RouteUnavailableError } from '../src/server/routing.ts';
import type {
  AppState,
  DiscoveryOptions,
  ExecuteContext,
  ExecuteResult,
  RunEvent,
  RunRecord,
  RuntimeSnapshot,
  RuntimeTarget,
} from '../src/shared/types.ts';

async function fixture(t: TestContext, provider: 'codex' | 'claude' | 'cursor' = 'codex', resetInMs = 86_400_000) {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'pugport-live-quota-')));
  const home = join(directory, 'home');
  mkdirSync(home);
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
    JEV_API_KEY: undefined,
    TYPESAFE_API_KEY: undefined,
  };
  const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(overrides))
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  let clock = Date.now();
  const stamp = (offset = 0) => new Date(clock + offset).toISOString();
  const target: RuntimeTarget = {
    id: `${provider}-native`,
    provider,
    label: 'Fixture A',
    command: 'never-spawn',
    commandDiscovery: 'fixed',
    environment: 'native',
    enabled: true,
    accountFingerprint: 'identity-a',
  };
  const second: RuntimeTarget = {
    ...target,
    id: `${provider}-account-b`,
    accountId: 'account-b',
    accountHome: join(directory, 'account-b'),
    accountFingerprint: 'identity-b',
    label: 'Fixture B',
  };
  const identities = new Map([
    [target.id, 'identity-a'],
    [second.id, 'identity-b'],
  ]);
  const observed = (runtime = target, at = stamp(), used = 10): RuntimeSnapshot => ({
    id: runtime.id,
    provider: runtime.provider,
    label: runtime.label,
    environment: 'native',
    installed: true,
    status: 'ready',
    authMode: 'chatgpt',
    accountFingerprint: identities.get(runtime.id),
    models: [{ id: 'fixture', label: 'Fixture', efforts: ['low'] }],
    quota: {
      status: 'known',
      source: 'Fixture provider read',
      observedAt: at,
      windows: [{ id: 'week', label: 'Week', usedPercent: used, resetsAt: stamp(resetInMs), durationMinutes: 10080 }],
      resetCredits: { availableCount: 2, details: [], source: 'Fixture credits', observedAt: at },
      subscription: { label: 'Fixture plan', source: 'Fixture profile', observedAt: at },
    },
    capabilities: { execute: true, resume: true, cancel: true, approvals: true },
    refreshedAt: at,
  });
  const data = join(directory, 'data');
  const seed = new Store(data);
  seed.setConfig('targets', [target, second]);
  seed.setConfig('settings', { updateCheck: false });
  seed.close();
  const controller = new Controller(directory, data, {
    readAccountIdentity: (runtime) => identities.get(runtime.id),
    now: () => clock,
    nativeLogin: { pending: () => false },
  });
  clearInterval(controller.timer);
  controller.targets = controller.targets.filter((runtime) => runtime.id === target.id || runtime.id === second.id);
  controller.snapshots = [observed(), observed(second)];
  const discoveries: Array<{ id: string; options?: DiscoveryOptions }> = [];
  let discovery: (runtime: RuntimeTarget) => Promise<RuntimeSnapshot> = async (runtime) => observed(runtime);
  const adapter = { claude: claudeAdapter, codex: codexAdapter, cursor: cursorAdapter }[provider];
  t.mock.method(adapter, 'discover', async (runtime: RuntimeTarget, options?: DiscoveryOptions) => {
    discoveries.push({ id: runtime.id, options });
    return discovery(runtime);
  });
  let context!: ExecuteContext;
  let finish!: () => void;
  let entered!: () => void;
  const executing = new Promise<void>((resolve) => (entered = resolve));
  let result: ExecuteResult = { output: 'Fixture complete' };
  t.mock.method(adapter, 'execute', async (value: ExecuteContext) => {
    context = value;
    await new Promise<void>((resolve) => {
      finish = resolve;
      entered();
    });
    return result;
  });
  const run: RunRecord = {
    id: 'fixture-run',
    status: 'running',
    prompt: 'Synthetic task',
    projectPath: directory,
    kind: 'general',
    route: {
      runtimeId: target.id,
      accountFingerprint: 'identity-a',
      model: 'fixture',
      effort: 'low',
      kind: 'general',
      reasons: [],
      warnings: [],
    },
    account: { id: target.id, label: target.label, provider, fingerprint: 'identity-a' },
    startedAt: stamp(),
    events: [],
    output: '',
  };
  const abort = new AbortController();
  controller.active.set(run.id, { run, abort, project: directory });
  let closing: Promise<void> | undefined;
  const close = () => (closing ??= controller.close());
  const execution = controller.execute(
    run,
    { prompt: run.prompt, projectPath: directory, kind: 'general', permissionMode: 'read-only' },
    controller.targets[0]!,
    abort,
  );
  t.after(async () => {
    try {
      finish?.();
      await execution;
      await close();
    } finally {
      for (const [key, value] of Object.entries(previous))
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      assert.equal(dirname(directory).toLowerCase(), realpathSync.native(tmpdir()).toLowerCase());
      assert.ok(basename(directory).startsWith('pugport-live-quota-'));
      rmSync(directory, { recursive: true, force: true });
    }
  });
  await Promise.race([
    executing,
    execution.then(() => {
      throw new Error('fixture execution ended before entering the adapter');
    }),
  ]);
  return {
    controller,
    close,
    target,
    second,
    identities,
    run,
    abort,
    discoveries,
    complete: async (value: ExecuteResult) => {
      result = value;
      finish();
      await execution;
    },
    observed,
    stamp,
    advance: (ms: number) => {
      clock += ms;
    },
    discovery: (value: typeof discovery) => {
      discovery = value;
    },
    emit: (event: RunEvent) => context.emit(event),
    quota: (used: number, at = stamp(), extra = {}) =>
      context.emit({
        at,
        type: 'quota',
        data: {
          quota: {
            status: 'known',
            source: 'Fixture live provider',
            observedAt: at,
            windows: [{ id: 'week', label: 'Week', usedPercent: used, resetsAt: stamp(resetInMs) }],
            ...extra,
          },
        },
      }),
  };
}

test('context travels with incremental run events without a state broadcast', async (t) => {
  for (const provider of ['codex', 'claude', 'cursor'] as const) {
    const f = await fixture(t, provider);
    const broadcasts = t.mock.method(f.controller, 'broadcast');
    const messages: Array<{ runId: string; event: RunEvent; context?: RunRecord['context'] }> = [];
    f.controller.on('run', (message) => messages.push(message));
    f.run.route.model = 'sonnet[1m]';
    f.run.effectiveModel = { model: 'claude-sonnet', source: 'fixture' };
    const update: RunEvent =
      provider === 'codex'
        ? {
            at: f.stamp(),
            type: 'usage',
            data: { last: { totalTokens: 126010, reasoningOutputTokens: 10 }, modelContextWindow: 200000 },
          }
        : provider === 'claude'
          ? {
              at: f.stamp(),
              type: 'status',
              data: { messageUsage: { input_tokens: 26000, cache_read_input_tokens: 100000 } },
            }
          : { at: f.stamp(), type: 'status', data: { contextTokens: 126000, contextWindow: 200000 } };
    f.emit(update);
    assert.deepEqual(f.run.context, {
      tokens: 126000,
      window: provider === 'claude' ? 1000000 : 200000,
      at: update.at,
    });
    assert.deepEqual(messages.at(-1)?.context, f.run.context);
    assert.equal(messages.at(-1)?.runId, f.run.id);
    if (provider === 'claude') {
      assert.equal(messages.at(-1)?.event.seq, undefined);
      assert.ok(f.run.events.every((event) => !event.data?.messageUsage));
      assert.ok(f.controller.store.withAudit(f.run).events.every((event) => !event.data?.messageUsage));
    }
    f.emit({ at: f.stamp(), type: 'usage', data: { totalTokens: 999999 } });
    assert.equal(messages.at(-1)?.context, undefined);
    assert.equal(f.run.context?.tokens, 126000);
    assert.equal(broadcasts.mock.callCount(), 0);
  }
});

test('verified live quota updates the running account and broadcasts while preserving plan, credits and other accounts', async (t) => {
  const f = await fixture(t);
  const states: AppState[] = [];
  let resources = 0;
  f.controller.on('state', (state) => states.push(state));
  f.controller.on('resources-refreshed', () => resources++);
  f.advance(1000);
  f.quota(36);
  assert.equal(resources, 1, 'resource notification stays immediate');
  assert.equal(states.length, 0, 'full state waits for the coalescing window');
  await new Promise((resolve) => setTimeout(resolve, 350));
  const snapshot = f.controller.snapshots[0]!;
  assert.equal(snapshot.quota.windows[0]?.usedPercent, 36);
  assert.equal(snapshot.quota.source, 'Fixture live provider');
  assert.equal(snapshot.accountFingerprint, 'identity-a');
  assert.equal(snapshot.quota.resetCredits?.availableCount, 2);
  assert.equal(snapshot.subscription?.label, 'Fixture plan');
  assert.equal(f.controller.snapshots[1]?.quota.windows[0]?.usedPercent, 10);
  assert.equal(states.length, 1);
  assert.equal(resources, 1);
  assert.equal(states[0]?.runtimes[0]?.quota.windows[0]?.usedPercent, 36);
  assert.equal(f.run.status, 'running');
});

test('old, malformed, unnormalized, other-account and post-cancel quota events cannot replace a valid observation', async (t) => {
  const f = await fixture(t);
  f.advance(2000);
  f.quota(40);
  f.quota(5, f.stamp(-1000));
  f.quota(150, f.stamp(1));
  f.quota(80, f.stamp(2), {
    windows: [{ id: 'week', label: 'Week', usedPercent: 80, resetsAt: f.stamp(86400000), observedAt: f.stamp(5000) }],
  });
  f.emit({
    at: f.stamp(2),
    type: 'quota',
    data: { source: 'Claude runtime event', status: 'allowed', window: 'five_hour' },
  });
  f.emit({ at: f.stamp(2), type: 'usage', data: { totalTokens: 999999 } });
  f.emit({
    at: f.stamp(3),
    type: 'quota',
    data: { accountFingerprint: 'identity-b', quota: f.observed(f.target, f.stamp(3), 70).quota },
  });
  assert.equal(f.controller.snapshots[0]?.quota.windows[0]?.usedPercent, 40);
  f.identities.set(f.target.id, 'identity-b');
  f.advance(1000);
  f.quota(70);
  assert.equal(f.controller.snapshots[0]?.quota.windows[0]?.usedPercent, 40);
  f.identities.set(f.target.id, 'identity-a');
  f.abort.abort();
  f.advance(1000);
  f.quota(80);
  assert.equal(f.controller.snapshots[0]?.quota.windows[0]?.usedPercent, 40);
});

test('replacing the current account or command rejects late events from the old CLI', async (t) => {
  const f = await fixture(t);
  f.advance(1000);
  f.controller.snapshots[0]!.accountFingerprint = 'identity-b';
  f.quota(50);
  assert.equal(f.controller.snapshots[0]?.quota.windows[0]?.usedPercent, 10);
  f.controller.snapshots[0]!.accountFingerprint = 'identity-a';
  f.controller.targets[0]!.command = 'another-cli';
  f.quota(60);
  assert.equal(f.controller.snapshots[0]?.quota.windows[0]?.usedPercent, 10);
});

test('a slow overlapping discovery cannot overwrite a newer live event from the same account', async (t) => {
  const f = await fixture(t);
  let release!: (snapshot: RuntimeSnapshot) => void;
  const oldPlan = { label: 'Old polled plan', source: 'Fixture old profile', observedAt: f.stamp() };
  f.discovery(async () => new Promise((resolve) => (release = resolve)));
  const refresh = f.controller.refresh({ runtimeIds: [f.target.id] });
  f.advance(1000);
  f.quota(65, f.stamp(), {
    subscription: { label: 'New live plan', source: 'Fixture live profile', observedAt: f.stamp() },
  });
  // A late response carrying an earlier reading must not rewind live quota.
  const polled = f.observed(f.target, f.stamp(-500), 15);
  release({
    ...polled,
    quota: { ...polled.quota, subscription: oldPlan },
    subscription: oldPlan,
  });
  await refresh;
  assert.equal(f.controller.snapshots[0]?.quota.windows[0]?.usedPercent, 65);
  assert.equal(f.controller.snapshots[0]?.quota.source, 'Fixture live provider');
  assert.equal(f.controller.snapshots[0]?.subscription?.label, 'New live plan');
  assert.equal(f.controller.snapshots[0]?.quota.subscription?.label, 'New live plan');
  f.discovery(async (target) => f.observed(target, f.stamp(), 65));
});

test('polls cannot rewind quota without any live event, and equal observation times stay stable', async (t) => {
  const f = await fixture(t);
  f.advance(2000);
  const latest = f.observed(f.target, f.stamp(), 60);
  f.controller.snapshots[0] = latest;
  for (const offset of [-1000, 0]) {
    f.discovery(async (target) => f.observed(target, f.stamp(offset), 10));
    await f.controller.refresh({ runtimeIds: [f.target.id] });
    assert.equal(f.controller.snapshots[0]?.quota.windows[0]?.usedPercent, 60);
    assert.equal(f.controller.snapshots[0]?.quota.observedAt, latest.quota.observedAt);
  }
  f.advance(1000);
  f.discovery(async (target) => f.observed(target, f.stamp(), 65));
  await f.controller.refresh({ runtimeIds: [f.target.id] });
  assert.equal(f.controller.snapshots[0]?.quota.windows[0]?.usedPercent, 65);
  assert.equal(f.controller.snapshots[0]?.quota.observedAt, f.stamp());
});

test('a genuinely newer poll wins an overlapping live event, including provider increases and resets', async (t) => {
  const f = await fixture(t);
  let release!: (snapshot: RuntimeSnapshot) => void;
  f.discovery(async () => new Promise((resolve) => (release = resolve)));
  const refresh = f.controller.refresh({ runtimeIds: [f.target.id] });
  f.advance(1000);
  f.quota(65);
  f.advance(500);
  release(f.observed(f.target, f.stamp(), 15));
  await refresh;
  assert.equal(f.controller.snapshots[0]?.quota.windows[0]?.usedPercent, 15, 'a later provider correction is accepted');
  assert.equal(f.controller.snapshots[0]?.quota.observedAt, f.stamp());
  assert.equal(f.controller.snapshots[0]?.quota.source, 'Fixture provider read');

  f.advance(1000);
  const reset = f.observed(f.target, f.stamp(), 0);
  reset.quota.windows[0]!.resetsAt = f.stamp(2 * 86400000);
  f.discovery(async () => reset);
  await f.controller.refresh({ runtimeIds: [f.target.id] });
  assert.equal(f.controller.snapshots[0]?.quota.windows[0]?.usedPercent, 0);
  assert.equal(f.controller.snapshots[0]?.quota.windows[0]?.resetsAt, reset.quota.windows[0]!.resetsAt);
});

test('temporary unknown observations retain an identified last reading without renewing routing freshness', async (t) => {
  const f = await fixture(t);
  f.advance(1000);
  f.quota(60);
  const verified = structuredClone(f.controller.snapshots[0]!.quota);
  f.discovery(async (target) => ({
    ...f.observed(target),
    quota: {
      status: 'unknown',
      source: 'Fixture unavailable quota',
      observedAt: null,
      windows: [],
      note: 'Synthetic quota timeout.',
    },
  }));
  for (let index = 0; index < 2; index++) {
    f.advance(1000);
    await f.controller.refresh({ runtimeIds: [f.target.id] });
    const snapshot = f.controller.snapshots[0]!;
    assert.equal(snapshot.quota.status, 'unknown', 'reference data never changes an unknown poll into known quota');
    assert.deepEqual(snapshot.quota.windows, []);
    assert.equal(snapshot.quota.observedAt, null);
    const quota = snapshot.lastKnownQuota!;
    assert.equal(quota.windows[0]?.usedPercent, 60);
    assert.equal(quota.observedAt, verified.observedAt);
    assert.equal(quota.source, verified.source);
    assert.equal(quota.note, '本次额度读取未取得新读数；显示上次已核验读数。 Synthetic quota timeout.');
  }
  const snapshot = f.controller.snapshots[0]!;
  const limited = route(
    { prompt: 'Synthetic inspection', projectPath: f.run.projectPath, kind: 'general' },
    [snapshot],
    f.controller.settings,
    new Set(),
    Date.parse(verified.observedAt!) + f.controller.settings.maxQuotaAgeSeconds * 1000,
  );
  assert.equal(limited.runtimeId, snapshot.id);
  assert.ok(limited.warnings.some((warning) => /剩余额度未知/.test(warning)));
  assert.equal(snapshot.quota.observedAt, null, 'the limited attempt never refreshes stale quota evidence');
  assert.throws(
    () =>
      route(
        { prompt: 'Synthetic inspection', projectPath: f.run.projectPath, kind: 'general' },
        [snapshot],
        f.controller.settings,
        {
          reservations: new Map([[quotaPoolKey(snapshot), 1]]),
          settlingPools: new Set(),
        },
      ),
    (error) => error instanceof RouteUnavailableError && error.kind === 'capacity',
    'a busy account must not get another limited attempt',
  );
  f.advance(1000);
  f.discovery(async (target) => f.observed(target, f.stamp(), 62));
  await f.controller.refresh({ runtimeIds: [f.target.id] });
  assert.equal(f.controller.snapshots[0]?.quota.windows[0]?.usedPercent, 62);
  assert.equal(f.controller.snapshots[0]?.quota.note, undefined, 'fresh quota clears the reference notice');
  assert.equal(f.controller.snapshots[0]?.lastKnownQuota, undefined);
});

test('retaining last quota never conceals a runtime error, authentication failure or identity change', async (t) => {
  for (const scenario of [
    'runtime-error',
    'authentication',
    'unknown-auth',
    'changed-identity',
    'missing-identity',
  ] as const)
    await t.test(scenario, async (t) => {
      const f = await fixture(t);
      f.advance(1000);
      f.quota(60);
      if (scenario === 'changed-identity') f.identities.set(f.target.id, 'identity-b');
      if (scenario === 'missing-identity') f.controller.snapshots[0]!.accountFingerprint = undefined;
      f.discovery(async (target) => ({
        ...f.observed(target),
        status: scenario === 'runtime-error' ? 'error' : scenario === 'authentication' ? 'auth-required' : 'ready',
        authMode: scenario === 'unknown-auth' ? 'unknown' : 'chatgpt',
        ...(scenario === 'runtime-error'
          ? {
              note: 'runtime-timeout',
              capabilities: { execute: false, resume: false, cancel: false, approvals: false },
            }
          : {}),
        quota: { status: 'unknown', source: 'Fixture failed quota', observedAt: null, windows: [] },
      }));
      await f.controller.refresh({ runtimeIds: [f.target.id] });
      const snapshot = f.controller.snapshots[0]!;
      if (scenario === 'runtime-error') {
        assert.equal(snapshot.quota.status, 'unknown');
        assert.equal(snapshot.lastKnownQuota?.windows[0]?.usedPercent, 60, 'same-identity reference remains visible');
        assert.equal(snapshot.status, 'error');
        assert.equal(snapshot.note, 'runtime-timeout');
        assert.equal(snapshot.capabilities.execute, false);
        assert.throws(
          () =>
            f.controller.preview({
              runtimeId: f.target.id,
              prompt: 'Synthetic inspection',
              projectPath: f.run.projectPath,
              kind: 'general',
            }),
          /runtime-timeout/,
        );
        const displayed = f.controller.state().runtimes.find((runtime) => runtime.id === f.target.id)!;
        assert.equal(displayed.quota.status, 'unknown');
        assert.equal(
          displayed.lastKnownQuota?.windows[0]?.usedPercent,
          60,
          'state identity guard retains display-only data',
        );
        f.identities.set(f.target.id, 'identity-b');
        assert.equal(
          f.controller.state().runtimes.find((runtime) => runtime.id === f.target.id)?.lastKnownQuota,
          undefined,
          'a reference must disappear when the physical login identity changes',
        );
      } else {
        assert.equal(snapshot.quota.status, 'unknown');
        assert.deepEqual(snapshot.quota.windows, []);
        assert.equal(snapshot.lastKnownQuota, undefined);
        assert.ok(!snapshot.quota.note?.includes('上次已核验读数'));
        if (scenario === 'authentication' || scenario === 'unknown-auth')
          assert.equal(snapshot.status, 'auth-required');
      }
    });
});

test('Claude official profile plans survive newer login caches while newer official downgrades still apply', async (t) => {
  const f = await fixture(t, 'claude');
  const official = { label: 'Max (20x)', source: 'Claude 官方账户资料', observedAt: f.stamp() };
  f.controller.snapshots[0]!.subscription = official;
  f.controller.snapshots[0]!.quota.subscription = official;
  for (const source of ['Claude CLI auth status（登录缓存）', 'Claude CLI get_usage（登录缓存）']) {
    f.advance(1000);
    const cached = { label: 'Pro', source, observedAt: f.stamp() };
    f.discovery(async (target) => ({
      ...f.observed(target),
      subscription: cached,
      quota: { ...f.observed(target).quota, subscription: cached },
    }));
    await f.controller.refresh({ runtimeIds: [f.target.id] });
    assert.deepEqual(f.controller.snapshots[0]?.subscription, official);
    assert.deepEqual(f.controller.snapshots[0]?.quota.subscription, official);
  }
  f.advance(1000);
  f.quota(25, f.stamp(), {
    subscription: { label: 'Pro', source: 'Claude CLI get_usage（登录缓存）', observedAt: f.stamp() },
  });
  assert.deepEqual(
    f.controller.snapshots[0]?.subscription,
    official,
    'live cache reads also cannot re-date the official plan',
  );
  f.advance(1000);
  const downgrade = { label: 'Pro', source: 'Claude 官方账户资料', observedAt: f.stamp() };
  f.discovery(async (target) => ({
    ...f.observed(target),
    subscription: downgrade,
    quota: { ...f.observed(target).quota, subscription: downgrade },
  }));
  await f.controller.refresh({ runtimeIds: [f.target.id] });
  assert.deepEqual(f.controller.snapshots[0]?.subscription, downgrade, 'a new official downgrade is authoritative');
  f.advance(1000);
  f.quota(27, f.stamp(), {
    subscription: { label: 'Max (20x)', source: 'Claude CLI get_usage（登录缓存）', observedAt: f.stamp() },
  });
  assert.deepEqual(f.controller.snapshots[0]?.subscription, downgrade);
  f.identities.set(f.target.id, 'identity-b');
  f.advance(1000);
  const otherAccount = { label: 'Free', source: 'Claude CLI auth status（登录缓存）', observedAt: f.stamp() };
  f.discovery(async (target) => ({
    ...f.observed(target),
    subscription: otherAccount,
    quota: { ...f.observed(target).quota, subscription: otherAccount },
  }));
  await f.controller.refresh({ runtimeIds: [f.target.id] });
  assert.deepEqual(
    f.controller.snapshots[0]?.subscription,
    otherAccount,
    'official plans never cross account identities',
  );
});

test('Claude authentication failures and API snapshots do not borrow the old official plan', async (t) => {
  for (const scenario of ['signed-out', 'api', 'authentication-error'] as const)
    await t.test(scenario, async (t) => {
      const f = await fixture(t, 'claude');
      const official = { label: 'Max (20x)', source: 'Claude 官方账户资料', observedAt: f.stamp() };
      f.controller.snapshots[0]!.subscription = official;
      f.controller.snapshots[0]!.quota.subscription = official;
      f.advance(1000);
      if (scenario === 'authentication-error')
        f.controller.accountHealth.failure(f.target, {
          ...f.run,
          status: 'failed',
          errorCode: 'authentication-required',
        });
      f.discovery(async (target) => ({
        ...f.observed(target),
        accountFingerprint: scenario === 'api' ? undefined : 'identity-a',
        status: scenario === 'signed-out' ? 'auth-required' : scenario === 'authentication-error' ? 'error' : 'ready',
        ...(scenario === 'authentication-error'
          ? { availability: { reason: 'authentication' as const, observedAt: f.stamp() } }
          : {}),
        subscription: undefined,
        accounting: { mode: scenario === 'api' ? 'usage' : 'unknown', source: 'Claude CLI auth status' },
        quota: { status: 'unknown', source: 'Claude CLI', observedAt: null, windows: [] },
      }));
      await f.controller.refresh({ runtimeIds: [f.target.id] });
      assert.equal(f.controller.snapshots[0]?.subscription, undefined);
      assert.equal(f.controller.snapshots[0]?.quota.subscription, undefined);
      assert.equal(f.controller.snapshots[0]?.lastKnownQuota, undefined);
    });
});

test('error and missing snapshots cannot expose a previous ChatGPT quota under unknown or API authentication', async (t) => {
  const f = await fixture(t);
  const verified = structuredClone(f.controller.snapshots[0]!.quota);
  for (const status of ['error', 'missing'] as const)
    for (const authMode of ['unknown', 'apiKey'] as const) {
      f.controller.snapshots[0] = {
        ...f.observed(),
        status,
        authMode,
        quota: { status: 'unknown', source: 'Synthetic failed protocol', observedAt: null, windows: [] },
        lastKnownQuota: verified,
      };
      const displayed = f.controller.state().runtimes.find((runtime) => runtime.id === f.target.id)!;
      assert.equal(displayed.status, status, 'withholding a reference preserves the actual runtime failure');
      assert.equal(displayed.lastKnownQuota, undefined);
      assert.equal(displayed.quota.status, 'unknown');
      assert.deepEqual(displayed.quota.windows, []);
      f.advance(1000);
      f.quota(90);
      assert.deepEqual(
        f.controller.snapshots[0]?.lastKnownQuota,
        verified,
        'a live event cannot bypass unknown/API auth',
      );
      assert.equal(f.controller.snapshots[0]?.quota.status, 'unknown');
    }
});

test('turning off Cursor editor usage clears its last verified reference even when the current poll has another source', async (t) => {
  const f = await fixture(t);
  const editorQuota = { ...f.observed().quota, source: 'Cursor 编辑器登录 / usage' };
  f.controller.snapshots[0] = {
    ...f.observed(),
    provider: 'cursor',
    quota: { status: 'unknown', source: 'Cursor CLI', observedAt: null, windows: [] },
    lastKnownQuota: editorQuota,
  };
  f.controller.updateSettings({ cursorUsageFromEditor: false });
  assert.equal(f.controller.snapshots[0]?.lastKnownQuota, undefined);
  assert.equal(f.controller.snapshots[0]?.quota.source, 'Cursor CLI');
  assert.equal(f.controller.snapshots[0]?.quota.status, 'unknown');
  f.controller.snapshots[0] = { ...f.controller.snapshots[0]!, quota: editorQuota, lastKnownQuota: editorQuota };
  f.controller.updateSettings({ cursorUsageFromEditor: false });
  assert.equal(f.controller.snapshots[0]?.lastKnownQuota, undefined);
  assert.equal(f.controller.snapshots[0]?.quota.source, 'Cursor CLI');
  assert.deepEqual(f.controller.snapshots[0]?.quota.windows, []);
});

test('disabling a runtime discards its last verified display reference', async (t) => {
  const f = await fixture(t);
  f.controller.snapshots[1]!.lastKnownQuota = structuredClone(f.controller.snapshots[1]!.quota);
  f.run.status = 'completed';
  f.controller.updateTarget(f.second.id, { enabled: false });
  if (f.controller.refreshPromise) await f.controller.refreshPromise;
  assert.equal(
    f.controller.snapshots.find((snapshot) => snapshot.id === f.second.id),
    undefined,
  );
  assert.equal(
    f.controller.state().runtimes.find((snapshot) => snapshot.id === f.second.id),
    undefined,
  );
});

test('reset credits follow their own observation time independently of quota windows and live packets', async (t) => {
  const f = await fixture(t);
  f.advance(1000);
  f.quota(60);
  f.advance(1000);
  const credits = { availableCount: 1, details: [], source: 'Fixture credit update', observedAt: f.stamp() };
  const oldQuota = f.observed(f.target, f.stamp(-2000), 10);
  oldQuota.quota.resetCredits = credits;
  f.discovery(async () => oldQuota);
  await f.controller.refresh({ runtimeIds: [f.target.id] });
  assert.equal(f.controller.snapshots[0]?.quota.windows[0]?.usedPercent, 60);
  assert.deepEqual(f.controller.snapshots[0]?.quota.resetCredits, credits);
  f.advance(1000);
  f.quota(61, f.stamp(), { resetCredits: { ...credits, availableCount: 4, observedAt: f.stamp(-2000) } });
  assert.deepEqual(f.controller.snapshots[0]?.quota.resetCredits, credits);
  f.advance(1000);
  const consumed = { ...credits, availableCount: 0, observedAt: f.stamp() };
  f.quota(62, f.stamp(), { resetCredits: consumed });
  assert.deepEqual(f.controller.snapshots[0]?.quota.resetCredits, consumed);
});

test('null-only reset-credit reads do not clear or re-date a real observation, and mixed reads stay unknown where unreported', async (t) => {
  const f = await fixture(t);
  const previous = structuredClone(f.controller.snapshots[0]!.quota.resetCredits!);
  const unavailable = () => ({
    availableCount: null,
    details: null,
    source: 'Unavailable credit read',
    observedAt: f.stamp(),
  });
  f.advance(1000);
  f.discovery(async (target) => ({
    ...f.observed(target),
    quota: { ...f.observed(target).quota, resetCredits: unavailable() },
  }));
  await f.controller.refresh({ runtimeIds: [f.target.id] });
  assert.deepEqual(f.controller.snapshots[0]?.quota.resetCredits, previous);
  f.advance(1000);
  f.quota(12, f.stamp(), { resetCredits: unavailable() });
  assert.deepEqual(f.controller.snapshots[0]?.quota.resetCredits, previous);
  f.advance(1000);
  f.emit({
    at: f.stamp(),
    type: 'quota',
    data: {
      quotaUpdate: 'sparse',
      quota: {
        status: 'unknown',
        source: 'Codex sparse credit fixture',
        observedAt: f.stamp(),
        windows: [],
        resetCredits: unavailable(),
      },
    },
  });
  assert.deepEqual(
    f.controller.snapshots[0]?.quota.resetCredits,
    previous,
    'sparse metadata must preserve the original credit source/time',
  );
  f.advance(1000);
  const mixed = { availableCount: 0, details: null, source: 'Reported count only', observedAt: f.stamp() };
  f.emit({
    at: f.stamp(),
    type: 'quota',
    data: {
      quotaUpdate: 'sparse',
      quota: {
        status: 'unknown',
        source: 'Codex sparse credit fixture',
        observedAt: f.stamp(),
        windows: [],
        resetCredits: mixed,
      },
    },
  });
  assert.deepEqual(
    f.controller.snapshots[0]?.quota.resetCredits,
    mixed,
    'unreported old detail cannot gain the new count timestamp',
  );
});

test('Codex sparse notifications preserve all other windows and their age without allowing an older full poll to rewind them', async (t) => {
  const f = await fixture(t);
  const initial = f.controller.snapshots[0]!;
  initial.quota.windows = [
    { id: 'codex:primary', label: 'Session', usedPercent: 60, resetsAt: f.stamp(3600000), durationMinutes: 300 },
    { id: 'codex:secondary', label: 'Week', usedPercent: 20, resetsAt: f.stamp(86400000), durationMinutes: 10080 },
  ];
  const oldTime = initial.quota.observedAt;
  const rolling = (status: 'known' | 'unknown', windows: RuntimeSnapshot['quota']['windows'], extra = {}) =>
    f.emit({
      at: f.stamp(),
      type: 'quota',
      data: {
        quotaUpdate: 'sparse',
        quota: { status, source: 'Codex sparse fixture', observedAt: f.stamp(), windows, ...extra },
      },
    });
  f.advance(1000);
  rolling('known', [{ id: 'codex:primary', label: 'codex · primary', usedPercent: 65, resetsAt: null }]);
  let quota = f.controller.snapshots[0]!.quota;
  assert.equal(quota.windows.length, 2);
  assert.equal(quota.windows[0]!.usedPercent, 65);
  assert.equal(quota.windows[0]!.resetsAt, initial.quota.windows[0]!.resetsAt);
  assert.equal(quota.windows[0]!.observedAt, f.stamp());
  assert.equal(quota.windows[1]!.usedPercent, 20);
  assert.equal(quota.windows[1]!.observedAt, oldTime);
  assert.equal(
    quota.observedAt,
    f.stamp(),
    'ordering uses the newest real packet, while window freshness stays separate',
  );
  f.discovery(async (target) => f.observed(target, f.stamp(-500), 5));
  await f.controller.refresh({ runtimeIds: [f.target.id] });
  assert.equal(f.controller.snapshots[0]!.quota.windows[0]!.usedPercent, 65);
  assert.equal(f.controller.snapshots[0]!.quota.windows.length, 2);

  f.advance(1000);
  rolling('unknown', [], {
    resetCredits: { availableCount: 1, details: [], source: 'Codex sparse credits', observedAt: f.stamp() },
  });
  quota = f.controller.snapshots[0]!.quota;
  assert.equal(quota.status, 'known');
  assert.equal(quota.windows[0]!.observedAt, f.stamp(-1000));
  assert.equal(quota.windows[1]!.observedAt, oldTime, 'metadata-only notifications never renew quota-window age');
  assert.equal(quota.resetCredits?.availableCount, 1);

  f.advance(1000);
  rolling('unknown', [
    { id: 'codex:primary', label: 'codex · primary', usedPercent: null, resetsAt: f.stamp(7200000) },
  ]);
  quota = f.controller.snapshots[0]!.quota;
  assert.equal(
    quota.windows[0]!.usedPercent,
    null,
    'a new cycle without reported utilization does not inherit the old percentage',
  );
  assert.equal(quota.windows[1]!.usedPercent, 20);
  assert.equal(quota.windows[1]!.observedAt, oldTime);
  f.discovery(async (target) => f.observed(target, f.stamp(), 20));
});

test('only Codex-marked sparse events may inherit absent or all-null utilization', async (t) => {
  const f = await fixture(t);
  const initial = structuredClone(f.controller.snapshots[0]!.quota);
  f.advance(1000);
  f.emit({
    at: f.stamp(),
    type: 'quota',
    data: {
      quota: {
        status: 'unknown',
        source: 'Unmarked incomplete fixture',
        observedAt: f.stamp(),
        windows: [{ id: 'week', label: 'Week', usedPercent: null, resetsAt: null }],
      },
    },
  });
  assert.deepEqual(f.controller.snapshots[0]!.quota, initial);
});

for (const location of ['snapshot', 'quota'] as const) {
  test(`a newer ${location} plan from discovery survives a concurrent live windows update`, async (t) => {
    const f = await fixture(t);
    const oldPlan = f.controller.snapshots[0]!.quota.subscription!;
    let release!: (snapshot: RuntimeSnapshot) => void;
    f.discovery(async () => new Promise((resolve) => (release = resolve)));
    const refresh = f.controller.refresh({ runtimeIds: [f.target.id] });
    f.advance(1000);
    f.quota(65);
    assert.equal(f.controller.snapshots[0]?.quota.subscription?.observedAt, oldPlan.observedAt);

    f.advance(500);
    const upgraded = { label: 'Max', source: 'Fixture fresh profile', observedAt: f.stamp() };
    const polled = f.observed(f.target, f.stamp(-1000), 15);
    release({
      ...polled,
      quota: { ...polled.quota, subscription: location === 'quota' ? upgraded : oldPlan },
      subscription: location === 'snapshot' ? upgraded : oldPlan,
    });
    await refresh;
    let snapshot = f.controller.snapshots[0]!;
    assert.equal(snapshot.quota.windows[0]?.usedPercent, 65, 'newer live usage is retained');
    assert.deepEqual(snapshot.subscription, upgraded);
    assert.deepEqual(snapshot.quota.subscription, upgraded);

    f.advance(1000);
    f.quota(66, f.stamp(), { subscription: oldPlan });
    snapshot = f.controller.snapshots[0]!;
    assert.equal(snapshot.quota.windows[0]?.usedPercent, 66, 'fresh usage is independent of stale plan data');
    assert.deepEqual(snapshot.subscription, upgraded);
    assert.deepEqual(snapshot.quota.subscription, upgraded);
    f.discovery(async (target) => f.observed(target, f.stamp(), 66));
  });
}

test('a full periodic tick refreshes idle accounts while sharing a slow active-only poll', async (t) => {
  const f = await fixture(t);
  let tick!: () => void;
  t.mock.method(globalThis, 'setInterval', ((callback: () => void) => {
    tick = callback;
    return { unref() {} };
  }) as typeof setInterval);
  f.controller.resetTimer();
  let release!: (snapshot: RuntimeSnapshot) => void;
  let first = true;
  f.discovery(async (target) => {
    if (first) {
      first = false;
      return new Promise((resolve) => (release = resolve));
    }
    return f.observed(target);
  });
  f.advance(15000);
  tick();
  const activePoll = f.controller.refreshPromise;
  f.advance(45000);
  tick(); // Full/idle deadline occurs while the active poll is pending.
  f.advance(15000);
  tick(); // Another active tick must share, not duplicate, either poll.
  assert.deepEqual(
    f.discoveries.map((call) => call.id),
    [f.target.id, f.second.id],
  );
  release(f.observed());
  await activePoll;
  await new Promise((resolve) => setImmediate(resolve));
  if (f.controller.refreshPromise) await f.controller.refreshPromise;
  assert.deepEqual(
    f.discoveries.map((call) => call.id),
    [f.target.id, f.second.id],
  );
  assert.equal(f.discoveries.at(-1)?.options?.quotaMaxAgeMs, 60000);
  assert.equal(f.controller.refreshPromise, undefined);
});

test('fifteen-second ticks query active runtimes only, keep idle polling at sixty seconds, and do not overlap discovery', async (t) => {
  const f = await fixture(t);
  let tick!: () => void;
  let delay = 0;
  const fakeTimer = { unref() {} };
  t.mock.method(globalThis, 'setInterval', ((callback: () => void, ms: number) => {
    tick = callback;
    delay = ms;
    return fakeTimer;
  }) as typeof setInterval);
  f.controller.resetTimer();
  assert.equal(delay, 15000);
  f.discovery(async (runtime) => {
    f.advance(3000);
    return f.observed(runtime);
  });
  f.advance(15000);
  tick();
  await f.controller.refreshPromise;
  assert.deepEqual(
    f.discoveries.map((call) => call.id),
    [f.target.id],
  );
  assert.equal(f.discoveries[0]?.options?.quotaMaxAgeMs, 15000);
  f.discovery(async (runtime) => f.observed(runtime));
  // The response took three seconds. The next timer tick is still due 15 seconds
  // after the request began, not 15 seconds after that response completed.
  f.advance(12000);
  tick();
  await f.controller.refreshPromise;
  assert.deepEqual(
    f.discoveries.map((call) => call.id),
    [f.target.id, f.target.id],
  );
  f.advance(30000);
  tick();
  await f.controller.refreshPromise;
  assert.deepEqual(
    f.discoveries.slice(-2).map((call) => call.id),
    [f.target.id, f.second.id],
  );
  assert.equal(f.discoveries.at(-1)?.options?.quotaMaxAgeMs, 60000);
  let release!: (value: RuntimeSnapshot) => void;
  f.discovery(async () => new Promise((resolve) => (release = resolve)));
  const before = f.discoveries.length;
  f.advance(15000);
  tick();
  f.advance(15000);
  tick();
  assert.equal(f.discoveries.length, before + 1, 'a pending discovery is shared');
  release(f.observed());
  await f.controller.refreshPromise;
  f.discovery(async (target) => f.observed(target));
});

for (const used of [25, 95])
  test(`complete post-turn quota ${used}% avoids redundant discovery and preserves the reserve`, async (t) => {
    const f = await fixture(t, 'codex', 48 * 3_600_000);
    f.advance(100);
    const turnCompletedAt = f.stamp();
    f.advance(1);
    const requestedAt = f.stamp();
    f.advance(1);
    const quota = f.observed(f.target, f.stamp(), used).quota;
    await f.complete({
      output: 'Fixture complete',
      postTurnQuota: {
        source: 'codex/account/rateLimits/read',
        complete: true,
        accountFingerprint: 'identity-a',
        turnCompletedAt,
        requestedAt,
        receivedAt: f.stamp(),
        quota,
      },
    } as ExecuteResult);
    assert.equal(f.discoveries.length, 0);
    assert.equal(f.controller.snapshots[0]?.quota.windows[0]?.usedPercent, used);
    const input = {
      prompt: 'Next synthetic request',
      projectPath: f.run.projectPath,
      kind: 'general' as const,
      runtimeId: f.target.id,
      model: 'fixture',
      permissionMode: 'read-only' as const,
    };
    if (used === 95) assert.throws(() => f.controller.preview(input), /保护阈值/);
    else assert.equal(f.controller.preview(input).runtimeId, f.target.id);
  });

for (const invalid of [
  'stale',
  'sparse',
  'missing-window',
  'unknown',
  'null-use',
  'identity',
  'login-changed',
  'target-changed',
  'cancelled',
] as const)
  test(`post-turn quota fails closed for ${invalid}`, async (t) => {
    const f = await fixture(t);
    f.advance(100);
    const proof = {
      source: 'codex/account/rateLimits/read' as const,
      complete: true,
      accountFingerprint: 'identity-a',
      turnCompletedAt: f.stamp(),
      requestedAt: f.stamp(),
      receivedAt: f.stamp(),
      quota: f.observed().quota,
    };
    if (invalid === 'stale') proof.requestedAt = f.stamp(-1);
    if (invalid === 'sparse') proof.complete = false;
    if (invalid === 'missing-window') proof.quota.windows[0]!.id = 'other-window';
    if (invalid === 'unknown') proof.quota.status = 'unknown';
    if (invalid === 'null-use') proof.quota.windows[0]!.usedPercent = null;
    if (invalid === 'identity') proof.accountFingerprint = 'identity-b';
    if (invalid === 'login-changed') f.identities.set(f.target.id, 'identity-b');
    if (invalid === 'target-changed') f.controller.targets[0]!.command = 'different-command';
    if (invalid === 'cancelled') f.abort.abort();
    await f.complete({ output: 'Fixture complete', postTurnQuota: proof } as ExecuteResult);
    assert.equal(f.discoveries.length, 1, 'the existing post-run observation remains required');
  });

for (const mode of ['other-active', 'closing'] as const)
  test(`post-turn quota preserves ${mode} safeguards`, async (t) => {
    const f = await fixture(t);
    f.advance(100);
    const result: ExecuteResult = {
      output: 'Fixture complete',
      postTurnQuota: {
        source: 'codex/account/rateLimits/read',
        complete: true,
        accountFingerprint: 'identity-a',
        turnCompletedAt: f.stamp(),
        requestedAt: f.stamp(),
        receivedAt: f.stamp(),
        quota: f.observed(undefined, undefined, 25).quota,
      },
    };
    if (mode === 'closing') {
      const closing = f.close();
      await f.complete(result);
      await closing;
      assert.equal(f.controller.snapshots[0]?.quota.windows[0]?.usedPercent, 10, 'shutdown rejects the late reading');
      assert.equal(
        f.run.events.some((event) => event.data?.kind === 'post-turn-quota' && event.data.outcome === 'accepted'),
        false,
      );
    } else {
      f.controller.settings.maxRunsPerAccount = 1;
      f.controller.active.set('other-run', {
        run: { ...f.run, id: 'other-run' },
        abort: new AbortController(),
        project: f.run.projectPath,
      });
      try {
        await f.complete(result);
        assert.equal(f.discoveries.length, 0);
        assert.equal(f.controller.active.has('other-run'), true);
        assert.throws(
          () =>
            f.controller.preview({
              prompt: 'Next synthetic request',
              projectPath: f.run.projectPath,
              runtimeId: f.target.id,
              model: 'fixture',
              kind: 'general',
              permissionMode: 'read-only',
            }),
          /并发容量已满/,
        );
      } finally {
        f.controller.active.delete('other-run');
      }
    }
  });

test('post-turn quota cannot release a reservation ahead of an older in-flight discovery', async (t) => {
  const f = await fixture(t, 'codex', 48 * 3_600_000);
  let releaseOld!: (snapshot: RuntimeSnapshot) => void;
  let entered!: () => void;
  const observing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let reads = 0;
  f.discovery(async () => {
    if (++reads === 1) {
      entered();
      return new Promise<RuntimeSnapshot>((resolve) => {
        releaseOld = resolve;
      });
    }
    f.advance(1);
    return f.observed(undefined, undefined, 95);
  });
  const refreshing = f.controller.refresh({ runtimeIds: [f.target.id] });
  await observing;
  f.advance(100);
  const completion = f.complete({
    output: 'Fixture complete',
    postTurnQuota: {
      source: 'codex/account/rateLimits/read',
      complete: true,
      accountFingerprint: 'identity-a',
      turnCompletedAt: f.stamp(),
      requestedAt: f.stamp(),
      receivedAt: f.stamp(),
      quota: f.observed(undefined, undefined, 95).quota,
    },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  f.advance(100);
  releaseOld(f.observed(undefined, undefined, 25));
  await Promise.all([refreshing, completion]);
  assert.equal(reads, 2, 'an older discovery must be followed by a fresh post-run observation');
  assert.equal(f.controller.snapshots[0]?.quota.windows[0]?.usedPercent, 95);
  assert.throws(
    () =>
      f.controller.preview({
        prompt: 'Next',
        projectPath: f.run.projectPath,
        runtimeId: f.target.id,
        model: 'fixture',
        kind: 'general',
        permissionMode: 'read-only',
      }),
    /保护阈值/,
  );
});

for (const change of ['replacement', 'age', 'identity'] as const)
  test(`accepted post-turn quota is rechecked before release: ${change}`, async (t) => {
    const f = await fixture(t);
    f.discovery(async () => {
      f.advance(1);
      return f.observed(undefined, undefined, 95);
    });
    f.advance(100);
    f.controller.on('run', ({ event }: { event: RunEvent }) => {
      if (event.data?.kind !== 'post-turn-quota' || event.data.outcome !== 'accepted') return;
      if (change === 'age') f.advance(1501);
      if (change === 'identity') f.identities.set(f.target.id, 'identity-b');
      if (change === 'replacement') {
        f.advance(1);
        f.controller.snapshots[0] = f.observed(undefined, undefined, 25);
      }
    });
    await f.complete({
      output: 'Fixture complete',
      postTurnQuota: {
        source: 'codex/account/rateLimits/read',
        complete: true,
        accountFingerprint: 'identity-a',
        turnCompletedAt: f.stamp(),
        requestedAt: f.stamp(),
        receivedAt: f.stamp(),
        quota: f.observed(undefined, undefined, 95).quota,
      },
    });
    assert.equal(f.discoveries.length, 1, 'a changed or aged proof cannot skip settlement');
  });

test('requested account refreshes publish without waiting for an unrelated full-batch account', async (t) => {
  const f = await fixture(t);
  f.advance(15000);
  let releaseOther!: (snapshot: RuntimeSnapshot) => void;
  let reads = 0;
  f.discovery(async (target) => {
    if (target.id === f.second.id) return new Promise((resolve) => (releaseOther = resolve));
    return f.observed(target, f.stamp(), ++reads === 1 ? 25 : 95);
  });
  const full = f.controller.refresh({ periodic: true });
  await new Promise<void>((resolve) => setImmediate(resolve));
  try {
    assert.equal(f.controller.snapshots[0]?.quota.windows[0]?.usedPercent, 25);
    f.advance(100);
    const requested = Promise.all([
      f.controller.refresh({ runtimeIds: [f.target.id] }),
      f.controller.refresh({ runtimeIds: [f.target.id] }),
    ]);
    await Promise.race([
      requested,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('unrelated account blocked refresh')), 1000)),
    ]);
    assert.equal(reads, 2, 'same-target manual requests share one fresh read');
    assert.equal(f.controller.snapshots[0]?.quota.windows[0]?.usedPercent, 95);
    assert.ok(f.controller.refreshPromise, 'the full batch still reports its unfinished account');
  } finally {
    releaseOther(f.observed(f.second));
    await full;
  }
  assert.equal(f.controller.snapshots[0]?.quota.windows[0]?.usedPercent, 95, 'the older batch cannot rewind A');
});

for (const proof of [false, true])
  test(`post-turn settlement ignores unrelated account refreshes, proof=${proof}`, async (t) => {
    const f = await fixture(t);
    let releaseOther!: (snapshot: RuntimeSnapshot) => void;
    f.discovery(async (target) => {
      if (target.id === f.second.id) return new Promise((resolve) => (releaseOther = resolve));
      f.advance(1);
      return f.observed(target, f.stamp(), 95);
    });
    const other = f.controller.refresh({ runtimeIds: [f.second.id] });
    f.advance(100);
    const completion = f.complete({
      output: 'Fixture complete',
      ...(proof
        ? {
            postTurnQuota: {
              source: 'codex/account/rateLimits/read' as const,
              complete: true as const,
              accountFingerprint: 'identity-a',
              turnCompletedAt: f.stamp(),
              requestedAt: f.stamp(),
              receivedAt: f.stamp(),
              quota: f.observed(undefined, undefined, 95).quota,
            },
          }
        : {}),
    });
    try {
      await Promise.race([
        completion,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('unrelated account blocked settlement')), 1000),
        ),
      ]);
      assert.equal(f.controller.active.has(f.run.id), false);
      assert.equal(f.discoveries.filter((call) => call.id === f.target.id).length, proof ? 0 : 1);
      assert.equal(f.controller.snapshots[0]?.quota.windows[0]?.usedPercent, 95);
    } finally {
      releaseOther(f.observed(f.second));
      await Promise.all([other, completion]);
    }
  });

test('same-account aliases keep the settlement barrier until their older read finishes', async (t) => {
  const f = await fixture(t);
  f.identities.set(f.second.id, 'identity-a');
  f.controller.targets.find((target) => target.id === f.second.id)!.accountFingerprint = 'identity-a';
  f.controller.snapshots[1] = f.observed(f.second);
  let releaseOld!: (snapshot: RuntimeSnapshot) => void;
  f.discovery(async (target) => {
    if (target.id === f.second.id) return new Promise((resolve) => (releaseOld = resolve));
    f.advance(1);
    return f.observed(target, f.stamp(), 95);
  });
  const older = f.controller.refresh({ runtimeIds: [f.second.id] });
  f.advance(100);
  const completion = f.complete({
    output: 'Fixture complete',
    postTurnQuota: {
      source: 'codex/account/rateLimits/read',
      complete: true,
      accountFingerprint: 'identity-a',
      turnCompletedAt: f.stamp(),
      requestedAt: f.stamp(),
      receivedAt: f.stamp(),
      quota: f.observed(undefined, undefined, 95).quota,
    },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  try {
    assert.equal(f.controller.active.has(f.run.id), true, 'alias traffic is not an unrelated account');
    assert.equal(f.discoveries.length, 1, 'fresh settlement follows the old alias observation');
    assert.equal(f.run.events.find((event) => event.data?.kind === 'post-turn-quota')?.data?.outcome, 'fallback');
  } finally {
    f.advance(1);
    releaseOld(f.observed(f.second, f.stamp(), 25));
    await Promise.all([older, completion]);
  }
  assert.equal(f.controller.snapshots[0]?.quota.windows[0]?.usedPercent, 95);
  assert.equal(f.discoveries.at(-1)?.id, f.target.id);
});

for (const change of ['identity', 'close'] as const)
  test(`obsolete discovery cannot publish stale quota after ${change}`, async (t) => {
    const f = await fixture(t);
    let release!: (snapshot: RuntimeSnapshot) => void;
    const old = f.observed(f.target, f.stamp(), 25);
    f.discovery(async () => new Promise((resolve) => (release = resolve)));
    const refreshing = f.controller.refresh({ runtimeIds: [f.target.id] });
    f.discovery(async (target) => f.observed(target));
    if (change === 'identity') f.identities.set(f.target.id, 'identity-replaced');
    else {
      const closing = f.close();
      await f.complete({ output: 'Fixture complete' });
      await closing;
    }
    release(old);
    await refreshing;
    if (change !== 'close') assert.notEqual(f.controller.snapshots[0]?.quota.windows[0]?.usedPercent, 25);
  });

test('an empty manual refresh still removes disabled runtime snapshots', async (t) => {
  const f = await fixture(t);
  for (const target of f.controller.targets) target.enabled = false;
  await f.controller.refresh({ runtimeIds: [] });
  assert.equal(f.controller.snapshots.length, 0);
  assert.equal(f.discoveries.length, 0);
});

test('aborting a shared waiter keeps other batch reads visible until they finish', async (t) => {
  const f = await fixture(t);
  f.advance(15000);
  const releases = new Map<string, (snapshot: RuntimeSnapshot) => void>();
  f.discovery(async (target) => new Promise((resolve) => releases.set(target.id, resolve)));
  const periodic = f.controller.refresh({ periodic: true, runtimeIds: [f.target.id] });
  const abort = new AbortController();
  const full = f.controller.refresh({ runtimeIds: [f.target.id, f.second.id], signal: abort.signal });
  const rejected = assert.rejects(full, { name: 'AbortError' });
  let completed = false;
  full.then(
    () => (completed = true),
    () => (completed = true),
  );
  let notifications = 0;
  f.controller.on('resources-refreshed', () => notifications++);
  try {
    abort.abort();
    releases.get(f.target.id)!(f.observed());
    await periodic;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(completed, false, 'an aborted waiter does not abandon another active discovery');
    assert.ok(f.controller.refreshPromise);
  } finally {
    f.advance(1);
    releases.get(f.second.id)!(f.observed(f.second, f.stamp(), 95));
    f.discovery(async (target) => f.observed(target));
    await Promise.all([periodic, rejected]);
  }
  assert.equal(f.controller.refreshPromise, undefined);
  assert.equal(f.controller.snapshots[1]?.quota.windows[0]?.usedPercent, 95);
  assert.equal(notifications, 2, 'the completed read still notifies resource consumers');
});

async function idleDiscoveryFixture(t: TestContext, provider: 'codex' | 'claude' | 'cursor' = 'codex') {
  const f = await fixture(t, provider);
  await f.complete({ output: 'Fixture complete' });
  const sourceScans = t.mock.method(
    f.controller as unknown as { detectLocalFreeSources(): Promise<void> },
    'detectLocalFreeSources',
    async () => {},
  );
  f.discoveries.length = 0;
  f.advance(60000);
  const extra = ['c', 'd'].map((name) => {
    const target = {
      ...f.second,
      id: `${provider}-account-${name}`,
      accountId: `account-${name}`,
      accountHome: join(dirname(f.second.accountHome!), `account-${name}`),
      accountFingerprint: `identity-${name}`,
    };
    f.identities.set(target.id, target.accountFingerprint);
    f.controller.targets.push(target);
    f.controller.snapshots.push(f.observed(target));
    return target;
  });
  const pending = new Map<string, (snapshot: RuntimeSnapshot) => void>();
  f.discovery(async (target) => new Promise((resolve) => pending.set(target.id, resolve)));
  const release = (target: RuntimeTarget, used = 10) => {
    const done = pending.get(target.id);
    assert.ok(done, `${target.id} has started`);
    pending.delete(target.id);
    done(f.observed(target, f.stamp(), used));
  };
  const drain = async (...batches: Promise<unknown>[]) => {
    f.discovery(async (target) => f.observed(target));
    for (const [id, done] of pending) {
      pending.delete(id);
      done(f.observed(f.controller.targets.find((target) => target.id === id) ?? f.target));
    }
    await Promise.all(batches);
  };
  return { ...f, third: extra[0]!, fourth: extra[1]!, release, drain, sourceScans };
}

const idleDiscoveryModes = [
  { label: 'periodic', options: { periodic: true } },
  { label: 'startup', options: { backgroundStartup: true } },
] as const;

test('startup discovery includes missing and recently failed targets with uncached observations', async (t) => {
  const f = await idleDiscoveryFixture(t);
  f.controller.snapshots = f.controller.snapshots
    .filter((snapshot) => snapshot.id !== f.fourth.id)
    .map((snapshot) =>
      snapshot.id === f.third.id ? { ...snapshot, status: 'error' as const, refreshedAt: f.stamp() } : snapshot,
    );
  const startup = f.controller.refresh({ backgroundStartup: true });
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(f.discoveries.length, 2);
    f.release(f.target);
    f.release(f.second);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(
      f.discoveries.map((call) => call.id),
      [f.target.id, f.second.id, f.third.id, f.fourth.id],
    );
    assert.ok(f.discoveries.every((call) => call.options?.quotaMaxAgeMs === 0));
  } finally {
    await f.drain(startup);
  }
});

test('startup upgrades queued periodic observations and later ticks cannot replace its uncached follow-up reads', async (t) => {
  const f = await idleDiscoveryFixture(t);
  const periodic = f.controller.refresh({ periodic: true });
  const startup = f.controller.refresh({ backgroundStartup: true });
  let repeated: Promise<void> | undefined;
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(f.discoveries.length, 2, 'already-running polls occupy both slots');
    repeated = f.controller.refresh({ periodic: true });
    f.release(f.target, 25);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(
      f.discoveries.map((call) => call.id),
      [f.target.id, f.second.id, f.third.id],
    );
    assert.equal(f.discoveries.at(-1)?.options?.quotaMaxAgeMs, 0, 'startup upgrades the queued poll');
    f.release(f.second, 25);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(f.discoveries.at(-1)?.id, f.fourth.id);
    f.release(f.third, 95);
    f.release(f.fourth, 95);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(
      f.discoveries.slice(4).map((call) => call.id),
      [f.target.id, f.second.id],
    );
    assert.ok(f.discoveries.slice(2).every((call) => call.options?.quotaMaxAgeMs === 0));
    f.advance(1);
    f.release(f.target, 95);
    f.release(f.second, 95);
    await Promise.all([periodic, startup, repeated]);
    assert.equal(
      f.controller.snapshots.find((snapshot) => snapshot.id === f.target.id)?.quota.windows[0]?.usedPercent,
      95,
    );
  } finally {
    await f.drain(periodic, startup, ...(repeated ? [repeated] : []));
  }
});

test('periodic discovery shares startup reads and cannot downgrade queued startup observations', async (t) => {
  const f = await idleDiscoveryFixture(t);
  const startup = f.controller.refresh({ backgroundStartup: true });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const periodic = f.controller.refresh({ periodic: true });
  try {
    assert.equal(f.discoveries.length, 2);
    f.release(f.target);
    f.release(f.second);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(f.discoveries.length, 4);
    assert.ok(f.discoveries.every((call) => call.options?.quotaMaxAgeMs === 0));
  } finally {
    await f.drain(startup, periodic);
  }
  assert.equal(f.discoveries.length, 4);
});

test('fresh startup requests bypass the background slots while preserving an uncached requested read', async (t) => {
  const f = await idleDiscoveryFixture(t);
  const startup = f.controller.refresh({ backgroundStartup: true });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const requested = f.controller.refresh({ backgroundStartup: true, fresh: true, runtimeIds: [f.third.id] });
  try {
    assert.deepEqual(
      f.discoveries.map((call) => call.id),
      [f.target.id, f.second.id, f.third.id],
    );
    assert.equal(f.discoveries.at(-1)?.options?.quotaMaxAgeMs, 0);
    f.release(f.third, 95);
    await requested;
    assert.ok(f.controller.refreshPromise, 'the unrelated startup reads are still pending');
  } finally {
    await f.drain(startup, requested);
  }
  assert.equal(f.discoveries.filter((call) => call.id === f.third.id).length, 1);
});

test('startup retries after a Cursor usage generation change retain the background slots', async (t) => {
  const f = await idleDiscoveryFixture(t, 'cursor');
  f.controller.settings.cursorUsageFromEditor = true;
  const startup = f.controller.refresh({ backgroundStartup: true });
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(f.discoveries.length, 2);
    // Isolate the old startup batch's retry from the settings action's separate foreground refresh.
    const refresh = t.mock.method(f.controller, 'refresh', async () => {});
    f.controller.updateSettings({ cursorUsageFromEditor: false });
    f.controller.updateSettings({ cursorUsageFromEditor: true });
    refresh.mock.restore();
    f.advance(1);
    f.release(f.target, 25);
    f.release(f.second, 25);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(
      f.discoveries.map((call) => call.id),
      [f.target.id, f.second.id, f.target.id, f.second.id],
    );
    assert.ok(f.discoveries.every((call) => call.options?.quotaMaxAgeMs === 0));
    f.advance(1);
    f.release(f.target, 95);
    f.release(f.second, 95);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(
      f.discoveries.slice(4).map((call) => call.id),
      [f.third.id, f.fourth.id],
    );
  } finally {
    await f.drain(startup);
    f.controller.updateSettings({ cursorUsageFromEditor: false });
  }
  assert.equal(
    f.controller.snapshots.find((snapshot) => snapshot.id === f.target.id)?.quota.windows[0]?.usedPercent,
    95,
  );
});

for (const { label, options } of idleDiscoveryModes)
  for (const provider of ['codex', 'claude'] as const)
    test(`idle ${label} ${provider} discovery uses two slots and coalesces repeated ticks including the default CLI`, async (t) => {
      const f = await idleDiscoveryFixture(t, provider);
      const first = f.controller.refresh(options);
      const repeated = f.controller.refresh(options);
      try {
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(f.sourceScans.mock.callCount(), label === 'startup' ? 2 : 0);
        assert.deepEqual(
          f.discoveries.map((call) => call.id),
          [f.target.id, f.second.id],
        );
        f.release(f.target);
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.deepEqual(
          f.discoveries.map((call) => call.id),
          [f.target.id, f.second.id, f.third.id],
        );
        assert.ok(f.controller.refreshPromise, 'queued and running observations remain visible');
      } finally {
        await f.drain(first, repeated);
      }
      assert.deepEqual(
        f.discoveries.map((call) => call.id),
        [f.target.id, f.second.id, f.third.id, f.fourth.id],
      );
      assert.equal(f.controller.refreshPromise, undefined);
    });

for (const { label, options } of idleDiscoveryModes)
  for (const fresh of [false, true])
    test(`requested discovery promotes an idle ${label} queued target without waiting for other accounts, fresh=${fresh}`, async (t) => {
      const f = await idleDiscoveryFixture(t);
      const periodic = f.controller.refresh(options);
      await new Promise<void>((resolve) => setImmediate(resolve));
      const requested = f.controller.refresh({ runtimeIds: [f.third.id], fresh });
      try {
        assert.deepEqual(
          f.discoveries.map((call) => call.id),
          [f.target.id, f.second.id, f.third.id],
        );
        assert.equal(f.discoveries.at(-1)?.options?.quotaMaxAgeMs, 0);
        f.advance(1);
        f.release(f.third, 95);
        await requested;
        assert.equal(
          f.controller.snapshots.find((snapshot) => snapshot.id === f.third.id)?.quota.windows[0]?.usedPercent,
          95,
        );
        assert.ok(f.controller.refreshPromise, 'the other periodic reads are still pending');
      } finally {
        await f.drain(periodic, requested);
      }
      assert.equal(
        f.discoveries.filter((call) => call.id === f.third.id).length,
        1,
        'the promoted poll is not replayed',
      );
    });

test('a periodic tick shares foreground discovery already in flight instead of queuing a second read', async (t) => {
  const f = await idleDiscoveryFixture(t);
  const blockers = f.controller.refresh({ periodic: true, runtimeIds: [f.target.id, f.second.id] });
  const requested = f.controller.refresh({ runtimeIds: [f.third.id] });
  const periodic = f.controller.refresh({ periodic: true, runtimeIds: [f.third.id] });
  try {
    assert.equal(f.discoveries.length, 3);
    f.release(f.third);
    await Promise.all([requested, periodic]);
    assert.ok(f.controller.refreshPromise, 'unrelated background slots are still occupied');
  } finally {
    await f.drain(blockers, requested, periodic);
  }
  assert.equal(f.discoveries.filter((call) => call.id === f.third.id).length, 1);
});

for (const { label, options } of idleDiscoveryModes)
  test(`active periodic discovery promotes queued ${label} work without weakening its freshness`, async (t) => {
    const f = await idleDiscoveryFixture(t);
    const periodic = f.controller.refresh(options);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const run = {
      ...f.run,
      id: 'active-third',
      status: 'running' as const,
      route: { ...f.run.route, runtimeId: f.third.id },
    };
    f.controller.active.set(run.id, { run, abort: new AbortController(), project: run.projectPath });
    f.advance(15000);
    const active = f.controller.refresh({ periodic: true, runtimeIds: [f.third.id] });
    try {
      assert.deepEqual(
        f.discoveries.map((call) => call.id),
        [f.target.id, f.second.id, f.third.id],
      );
      assert.equal(f.discoveries.at(-1)?.options?.quotaMaxAgeMs, label === 'startup' ? 0 : 15000);
      f.release(f.third);
      await active;
    } finally {
      f.controller.active.delete(run.id);
      await f.drain(periodic, active);
    }
    assert.equal(f.discoveries.filter((call) => call.id === f.third.id).length, 1);
  });

test('active promotion of startup waits for its old periodic read and then obtains an uncached observation', async (t) => {
  const f = await idleDiscoveryFixture(t);
  const periodic = f.controller.refresh({ periodic: true });
  const startup = f.controller.refresh({ backgroundStartup: true });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const run = { ...f.run, id: 'active-startup-first', status: 'running' as const };
  f.controller.active.set(run.id, { run, abort: new AbortController(), project: run.projectPath });
  f.advance(15000);
  const active = f.controller.refresh({ periodic: true, runtimeIds: [f.target.id] });
  try {
    assert.equal(f.discoveries.length, 2, 'the old periodic observation is still pending');
    f.release(f.target, 25);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const observations = f.discoveries.filter((call) => call.id === f.target.id);
    assert.equal(observations.length, 2, 'the cached poll cannot satisfy startup');
    assert.equal(observations[1]?.options?.quotaMaxAgeMs, 0);
    f.advance(1);
    f.release(f.target, 95);
    await active;
    assert.equal(
      f.controller.snapshots.find((snapshot) => snapshot.id === f.target.id)?.quota.windows[0]?.usedPercent,
      95,
    );
  } finally {
    f.controller.active.delete(run.id);
    await f.drain(periodic, startup, active);
  }
});

for (const { label, options } of idleDiscoveryModes)
  for (const cancelled of [false, true])
    test(`promoted ${label} fresh discovery retains the old same-account alias barrier, cancelled=${cancelled}`, async (t) => {
      const f = await idleDiscoveryFixture(t);
      f.third.accountFingerprint = 'identity-a';
      f.identities.set(f.third.id, 'identity-a');
      const periodic = f.controller.refresh(options);
      await new Promise<void>((resolve) => setImmediate(resolve));
      const abort = new AbortController();
      const fresh = f.controller.refresh({ runtimeIds: [f.third.id], fresh: true, signal: abort.signal });
      const finished = cancelled ? assert.rejects(fresh, { name: 'AbortError' }) : fresh;
      try {
        assert.equal(f.discoveries.length, 2, 'the pre-completion alias read must finish first');
        if (cancelled) abort.abort();
        f.release(f.target, 25);
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (!cancelled) {
          assert.equal(f.discoveries.filter((call) => call.id === f.third.id).length, 1);
          f.advance(1);
          f.release(f.third, 95);
        }
        await finished;
      } finally {
        await f.drain(periodic, finished);
      }
      assert.equal(f.discoveries.filter((call) => call.id === f.third.id).length, cancelled ? 0 : 1);
      if (!cancelled)
        assert.equal(
          f.controller.snapshots.find((snapshot) => snapshot.id === f.third.id)?.quota.windows[0]?.usedPercent,
          95,
        );
    });

for (const { label, options } of idleDiscoveryModes)
  test(`closing resolves queued ${label} waiters without starting their discovery`, async (t) => {
    const f = await idleDiscoveryFixture(t);
    const periodic = f.controller.refresh(options);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const queued = f.controller.refresh({ ...options, runtimeIds: [f.third.id, f.fourth.id] });
    try {
      await f.close();
      await queued;
      assert.deepEqual(
        f.discoveries.map((call) => call.id),
        [f.target.id, f.second.id],
      );
      assert.ok(f.controller.refreshPromise, 'already-started observations remain tracked until they finish');
    } finally {
      await f.drain(periodic, queued);
    }
    assert.equal(f.discoveries.length, 2);
    assert.equal(f.controller.refreshPromise, undefined);
  });

for (const { label, options } of idleDiscoveryModes)
  for (const mutation of ['removed', 'disabled', 'reconfigured'] as const)
    test(`queued ${label} discovery does not launch an obsolete ${mutation} target`, async (t) => {
      const f = await idleDiscoveryFixture(t);
      const changed = mutation === 'reconfigured' ? f.target : f.third;
      if (mutation === 'reconfigured') f.controller.targets = [f.second, f.third, f.target, f.fourth];
      const periodic = f.controller.refresh(options);
      await new Promise<void>((resolve) => setImmediate(resolve));
      // Hold the automatic full refresh so this test can release the old generation first.
      const refresh = t.mock.method(f.controller, 'refresh', async () => {});
      if (mutation === 'removed')
        f.controller.targets = f.controller.targets.filter((target) => target.id !== f.third.id);
      f.controller.updateTarget(
        mutation === 'removed' ? f.target.id : changed.id,
        mutation === 'disabled'
          ? { enabled: false }
          : mutation === 'reconfigured'
            ? { command: 'replacement-cli' }
            : { label: 'Changed generation' },
      );
      refresh.mock.restore();
      const commands: string[] = [];
      f.discovery(async (target) => {
        if (target.id === changed.id) commands.push(target.command);
        return f.observed(target, f.stamp(), 95);
      });
      f.advance(1);
      f.release(mutation === 'reconfigured' ? f.third : f.target, 25);
      f.release(f.second, 25);
      await periodic;
      assert.deepEqual(commands, mutation === 'reconfigured' ? ['replacement-cli'] : []);
      const snapshot = f.controller.snapshots.find((value) => value.id === changed.id);
      if (mutation === 'reconfigured') assert.equal(snapshot?.quota.windows[0]?.usedPercent, 95);
      else assert.equal(snapshot, undefined);
    });
