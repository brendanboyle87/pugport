import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { Controller } from '../src/server/controller.ts';
import { Store } from '../src/server/store.ts';
import { codexAdapter } from '../src/server/adapters/codex.ts';
import { piAdapter } from '../src/server/adapters/pi.ts';
import { responseLatencyKey } from '../src/server/response-latency.ts';
import type { RouteCapacity } from '../src/server/routing.ts';
import type {
  ExecuteContext,
  ExecuteResult,
  RunInput,
  RunRecord,
  RuntimeSnapshot,
  RuntimeTarget,
} from '../src/shared/types.ts';

function fixture(t: TestContext) {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'pugport-response-latency-')));
  const home = join(directory, 'home');
  mkdirSync(home);
  const environment: Record<string, string | undefined> = {
    HOME: home,
    USERPROFILE: home,
    APPDATA: home,
    LOCALAPPDATA: home,
    XDG_CONFIG_HOME: home,
    CODEX_HOME: join(home, 'codex'),
    GROK_HOME: join(home, 'grok'),
    CLAUDE_CONFIG_DIR: join(home, 'claude'),
    COMBORUNNER_SECRETS_DIR: join(directory, 'secrets'),
    PATH: '',
    JEV_API_KEY: undefined,
    TYPESAFE_API_KEY: undefined,
  };
  const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(environment))
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  let monotonic = 0;
  t.mock.method(performance, 'now', () => monotonic);
  const target: RuntimeTarget = {
    id: 'codex-latency-fixture',
    provider: 'codex',
    label: 'Fixture',
    command: 'never-spawn',
    environment: 'native',
    enabled: true,
    accountFingerprint: 'fixture-identity',
  };
  const snapshot: RuntimeSnapshot = {
    ...target,
    installed: true,
    status: 'ready',
    version: 'fixture-1',
    authMode: 'chatgpt',
    models: [{ id: 'fixture-model', label: 'Fixture', efforts: ['low'] }],
    quota: { status: 'known', source: 'fixture', observedAt: new Date().toISOString(), windows: [] },
    capabilities: { execute: true, resume: true, cancel: true, approvals: true },
    refreshedAt: new Date().toISOString(),
  };
  const controller = new Controller(directory, join(directory, 'data'), {
    readAccountIdentity: () => 'fixture-identity',
    nativeLogin: { pending: () => false },
  });
  clearInterval(controller.timer);
  controller.targets = [target];
  controller.snapshots = [snapshot];
  t.mock.method(codexAdapter, 'discover', async () => snapshot);
  t.after(async () => {
    await controller.close();
    for (const [key, value] of Object.entries(previous))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    assert.equal(dirname(directory).toLowerCase(), realpathSync.native(tmpdir()).toLowerCase());
    assert.ok(basename(directory).startsWith('pugport-response-latency-'));
    rmSync(directory, { recursive: true, force: true });
  });
  const run: RunRecord = {
    id: 'latency-run',
    status: 'running',
    prompt: 'Synthetic natural conversation',
    projectPath: directory,
    kind: 'general',
    route: {
      runtimeId: target.id,
      accountFingerprint: 'fixture-identity',
      model: 'fixture-model',
      effort: 'low',
      kind: 'general',
      reasons: [],
      warnings: [],
    },
    account: { id: target.id, provider: target.provider, label: target.label, fingerprint: 'fixture-identity' },
    startedAt: new Date(Date.now() - 3600_000).toISOString(),
    output: '',
    events: [],
  };
  const abort = new AbortController();
  const input: RunInput = {
    prompt: run.prompt,
    projectPath: directory,
    kind: 'general',
    permissionMode: 'read-only',
    latencySensitiveChat: true,
  };
  return {
    controller,
    target,
    snapshot,
    run,
    abort,
    input,
    advance: (ms: number) => {
      monotonic += ms;
    },
    execute: async (adapter: (ctx: ExecuteContext) => Promise<ExecuteResult>, sessionId?: string, runtime = target) => {
      t.mock.method(runtime.provider === 'pi' ? piAdapter : codexAdapter, 'execute', adapter);
      controller.active.set(run.id, { run, abort, project: directory, permissionMode: 'read-only' });
      controller.store.saveRun(run);
      await controller.execute(run, input, runtime, abort, sessionId);
    },
  };
}

for (const sessionMode of ['new', 'resume'] as const)
  test(`completed natural chat records monotonic first text for ${sessionMode}, excluding earlier waits`, async (t) => {
    const f = fixture(t);
    f.controller.on('run', ({ event }) => {
      if (event.type === 'status' && event.text?.startsWith('已通过资源检查')) f.advance(5000);
    });
    await f.execute(
      async (ctx) => {
        f.advance(50);
        ctx.emit({ type: 'text', at: '2099-01-01T00:00:00Z', text: ' \n' });
        f.advance(75);
        ctx.emit({ type: 'text', at: '1900-01-01T00:00:00Z', text: 'Hello' });
        f.advance(900);
        ctx.emit({ type: 'text', at: new Date().toISOString(), text: ' again' });
        return {
          output: 'Hello again',
          nativeSessionId: 'final-id-for-both-modes',
          effectiveModel: { model: 'verified-model', effort: 'medium', source: 'fixture' },
        };
      },
      sessionMode === 'resume' ? 'previous-session' : undefined,
    );
    assert.deepEqual(f.run.responseLatency, {
      runId: f.run.id,
      runtimeId: f.target.id,
      key: responseLatencyKey(f.target, f.snapshot),
      model: 'verified-model',
      effort: 'medium',
      sessionMode,
      firstTextMs: 125,
      observedAt: f.run.endedAt,
    });
    assert.deepEqual(f.controller.store.storedRunSummary(f.run.id)?.responseLatency, f.run.responseLatency);
    const capacity = (f.controller as unknown as { routeCapacity(input: RunInput): RouteCapacity }).routeCapacity(
      f.input,
    );
    assert.deepEqual(capacity.responseLatencySamples, [f.run.responseLatency]);
    assert.equal(capacity.responseLatencyKeys?.get(f.target.id), f.run.responseLatency.key);
  });

test('ordinary routing and capacity checks do not read response latency metadata', (t) => {
  const f = fixture(t);
  const samples = t.mock.method(f.controller.store, 'responseLatencySamples', () => []);
  const internal = f.controller as unknown as { routeCapacity(input?: RunInput): RouteCapacity };
  assert.equal(internal.routeCapacity().responseLatencySamples, undefined);
  assert.equal(internal.routeCapacity({ ...f.input, latencySensitiveChat: false }).responseLatencySamples, undefined);
  assert.equal(samples.mock.callCount(), 0);
  assert.deepEqual(internal.routeCapacity(f.input).responseLatencySamples, []);
  assert.equal(samples.mock.callCount(), 1);
});

for (const kind of ['api', 'free'] as const)
  test(`${kind} credential replacement and re-adding the same ID persist distinct latency identities`, async (t) => {
    const f = fixture(t);
    t.mock.method(process, 'emitWarning', () => {});
    t.mock.method(f.controller as unknown as { checkApiKey(): void }, 'checkApiKey', () => {});
    const preset = kind === 'api' ? 'deepseek' : 'groq-free';
    const add = (key: string) =>
      kind === 'api' ? f.controller.addApiProvider(preset, key) : f.controller.addFreeSource(preset, key);
    await add('synthetic-first');
    const first = f.controller.targets.find((target) => target.apiProvider === preset)!;
    assert.ok(first.responseLatencyEpoch);
    await f.controller.replaceApiKey(first.id, 'synthetic-second');
    const second = f.controller.targets.find((target) => target.id === first.id)!;
    assert.notEqual(second, first, 'in-flight targets retain their original connection identity');
    assert.notEqual(second.responseLatencyEpoch, first.responseLatencyEpoch);
    await f.controller.removeApiProvider(second.id);
    await add('synthetic-third');
    const third = f.controller.targets.find((target) => target.id === first.id)!;
    assert.notEqual(third.responseLatencyEpoch, second.responseLatencyEpoch);
    const reopened = new Store(f.controller.dataDir);
    try {
      assert.equal(
        reopened.config<RuntimeTarget[]>('targets', []).find((target) => target.id === first.id)?.responseLatencyEpoch,
        third.responseLatencyEpoch,
      );
    } finally {
      reopened.close();
    }
  });

test('an API run completing after key replacement keeps its launch latency identity', async (t) => {
  const f = fixture(t);
  t.mock.method(process, 'emitWarning', () => {});
  t.mock.method(f.controller as unknown as { checkApiKey(): void }, 'checkApiKey', () => {});
  await f.controller.addApiProvider('deepseek', 'synthetic-first');
  const target = f.controller.targets.find((target) => target.apiProvider === 'deepseek')!;
  const snapshot: RuntimeSnapshot = {
    ...f.snapshot,
    id: target.id,
    provider: 'pi',
    gateway: 'api',
    accountFingerprint: undefined,
    apiProvider: 'deepseek',
  };
  f.controller.snapshots = [snapshot];
  f.run.route.runtimeId = target.id;
  const key = responseLatencyKey(target, snapshot);
  t.mock.method(piAdapter, 'discover', async () => snapshot);
  await f.execute(
    async (ctx) => {
      f.advance(100);
      ctx.emit({ type: 'text', at: new Date().toISOString(), text: 'Hello' });
      await f.controller.replaceApiKey(target.id, 'synthetic-replacement');
      return { output: 'Hello' };
    },
    undefined,
    target,
  );
  assert.equal(f.run.responseLatency?.key, key);
  const current = f.controller.targets.find((value) => value.id === target.id)!;
  assert.notEqual(responseLatencyKey(current, snapshot), key);
});

for (const invalid of [
  'not-chat',
  'no-text',
  'failure',
  'cancel',
  'tool',
  'approval',
  'steering',
  'host-text',
] as const)
  test(`response latency ignores ${invalid}`, async (t) => {
    const f = fixture(t);
    if (invalid === 'not-chat') f.input.latencySensitiveChat = false;
    await f.execute(async (ctx) => {
      f.advance(100);
      if (invalid !== 'no-text')
        ctx.emit({
          type: 'text',
          at: new Date().toISOString(),
          text: 'Hello',
          ...(invalid === 'host-text' ? { data: { hostAudit: true, source: 'pugport' } } : {}),
        });
      if (invalid === 'failure') throw new Error('synthetic failure');
      if (invalid === 'cancel') f.abort.abort();
      if (invalid === 'tool' || invalid === 'approval')
        ctx.emit({ type: invalid, at: new Date().toISOString(), data: {} });
      if (invalid === 'steering')
        ctx.emit({
          type: 'status',
          at: new Date().toISOString(),
          data: { steeringPhase: 'sending', steeringId: 'fixture', steeringMode: 'append' },
        });
      return { output: 'Hello' };
    });
    assert.ok(f.run.adapterStartedAt);
    assert.ok(f.run.adapterEndedAt);
    assert.ok(Date.parse(f.run.adapterEndedAt) >= Date.parse(f.run.adapterStartedAt));
    if (invalid === 'no-text' || invalid === 'host-text') assert.equal(f.run.firstTextAt, undefined);
    else assert.ok(f.run.firstTextAt);
    const observed = f.controller.usage.report().perRun.find((row) => row.runId === f.run.id)!;
    assert.equal(observed.adapterStartedAt, f.run.adapterStartedAt);
    assert.equal(observed.firstTextAt, f.run.firstTextAt ?? null);
    assert.equal(observed.adapterEndedAt, f.run.adapterEndedAt);
    assert.equal(f.run.responseLatency, undefined);
    assert.deepEqual(f.controller.store.responseLatencySamples(), []);
  });
