import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { Controller } from '../src/server/controller.ts';
import { codexAdapter } from '../src/server/adapters/codex.ts';
import { claudeAdapter } from '../src/server/adapters/claude.ts';
import { RouteUnavailableError } from '../src/server/routing.ts';
import { handoffNoteIn } from '../src/shared/handoff-note.ts';
import type {
  ExecuteContext,
  ExecuteResult,
  RunInput,
  RunRecord,
  RuntimeSnapshot,
  RuntimeTarget,
} from '../src/shared/types.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!predicate() && Date.now() < deadline) await new Promise((done) => setTimeout(done, 5));
  assert.equal(predicate(), true, 'synthetic native run reaches the expected lifecycle');
}
function fixture(t: TestContext) {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'pugport-quota-handoff-')));
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
    OPENAI_API_KEY: undefined,
    CODEX_API_KEY: undefined,
  };
  const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(overrides))
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  const targets: RuntimeTarget[] = ['codex-a', 'codex-b', 'claude-c'].map((id) => ({
    id,
    provider: id.startsWith('claude') ? 'claude' : 'codex',
    label: id,
    environment: 'native',
    enabled: true,
    command: 'never-spawn',
    commandDiscovery: 'fixed',
    accountId: id,
    accountHome: join(home, id),
    accountFingerprint: `identity-${id}`,
  }));
  const identities = new Map(targets.map((target) => [target.id, target.accountFingerprint]));
  let clock = Date.now();
  const stamp = (delta = 0) => new Date(clock + delta).toISOString();
  const observed = (target: RuntimeTarget): RuntimeSnapshot => ({
    id: target.id,
    provider: target.provider,
    label: target.label,
    environment: 'native',
    installed: true,
    status: 'ready',
    authMode: 'chatgpt',
    accountFingerprint: identities.get(target.id),
    models: [
      {
        id: target.provider === 'claude' ? 'claude-sonnet-5' : target.id === 'codex-a' ? 'gpt-6-sol' : 'gpt-6-terra',
        label: target.id,
        efforts: ['low', 'medium', 'high'],
      },
    ],
    quota: {
      status: 'known',
      source: 'Synthetic quota',
      observedAt: stamp(),
      windows: [{ id: 'week', label: 'Week', usedPercent: 10, resetsAt: stamp(86400000) }],
    },
    capabilities: { execute: true, resume: true, cancel: true, approvals: true },
    refreshedAt: stamp(),
  });
  const controller = new Controller(directory, join(directory, 'data'), {
    readAccountIdentity: (target) => identities.get(target.id),
    now: () => clock,
    nativeLogin: { pending: () => false },
  });
  clearInterval(controller.timer);
  controller.targets = targets;
  controller.snapshots = targets.map(observed);
  t.mock.method(controller, 'refresh', async () => {});
  const calls: ExecuteContext[] = [];
  let behavior: (context: ExecuteContext) => Promise<ExecuteResult> = async () => ({ output: 'Synthetic completion' });
  for (const adapter of [codexAdapter, claudeAdapter])
    t.mock.method(adapter, 'execute', async (context: ExecuteContext) => {
      calls.push(context);
      return behavior(context);
    });
  t.after(async () => {
    try {
      await controller.close();
    } finally {
      for (const [key, value] of Object.entries(previous))
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      assert.equal(dirname(directory).toLowerCase(), realpathSync.native(tmpdir()).toLowerCase());
      assert.ok(basename(directory).startsWith('pugport-quota-handoff-'));
      rmSync(directory, { recursive: true, force: true });
    }
  });
  const input: RunInput = {
    prompt: 'Complete this synthetic step',
    routingPrompt: 'Implement a parser',
    projectPath: directory,
    kind: 'general',
    permissionMode: 'workspace-write',
    executionPolicy: 'cli-only',
    workflowId: 'workflow',
    stepId: 'step',
    writeShare: { callerId: 'parent', scope: ['fixture.ts'] },
  };
  const start = async (patch: Partial<RunInput> = {}) => {
    const run = await controller.start({ ...input, ...patch });
    await until(() => !controller.active.has(run.id));
    return controller.store.run(run.id)!;
  };
  return {
    controller,
    targets,
    identities,
    observed,
    calls,
    input,
    start,
    stamp,
    advance: (delta: number) => {
      clock += delta;
    },
    behavior: (value: typeof behavior) => {
      behavior = value;
    },
  };
}
function settled(context: ExecuteContext, id = 'write-1') {
  context.emit({
    at: new Date().toISOString(),
    type: 'tool',
    data: { itemId: id, kind: 'commandExecution', status: 'inProgress' },
  });
  context.emit({
    at: new Date().toISOString(),
    type: 'tool',
    data: { itemId: id, kind: 'commandExecution', status: 'completed', exitCode: 0 },
  });
}

test('settled native progress is persisted and hands only the current step to a different model/account in a fresh session', async (t) => {
  const f = fixture(t);
  f.behavior(async (context) => {
    settled(context);
    context.emit({ at: new Date().toISOString(), type: 'session', data: { sessionId: 'source-session' } });
    context.emit({ at: new Date().toISOString(), type: 'text', text: 'Synthetic first batch completed.' });
    throw new Error('quota-or-rate-limit');
  });
  const previous = await f.start();
  assert.equal(previous.handoffCheckpoint?.safe, true);
  assert.deepEqual(previous.handoffCheckpoint?.completedToolIds, ['write-1']);
  assert.equal(previous.errorCode, 'quota-or-rate-limit');
  const next = f.controller.accountRelay(f.input, previous)!;
  assert.ok(next);
  assert.equal(next.model, undefined, 'automatic model choices do not become user pins');
  assert.equal(next.workflowId, f.input.workflowId);
  assert.equal(next.stepId, f.input.stepId);
  assert.deepEqual(next.writeShare, f.input.writeShare);
  assert.equal(next.permissionMode, 'workspace-write');
  assert.equal(next.resumeRunId, undefined);
  assert.equal(next.continuationRunId, undefined);
  assert.equal(next.relayReason, 'quota');
  assert.match(next.prompt, /不重放已完成/);
  assert.match(next.prompt, /Synthetic first batch/);
  const decision = f.controller.preview(next);
  assert.notEqual(decision.runtimeId, previous.route.runtimeId);
  assert.notEqual(decision.model, previous.route.model);
  f.behavior(async () => ({ output: 'Synthetic remaining work completed.', nativeSessionId: 'new-session' }));
  const continued = await f.start(next);
  assert.equal(continued.workflowId, previous.workflowId);
  assert.equal(continued.stepId, previous.stepId);
  assert.equal(continued.parentRunId, undefined);
  assert.equal(f.calls[1]?.nativeSessionId, undefined);
  assert.notEqual(continued.nativeSessionId, previous.nativeSessionId);
  assert.deepEqual(continued.relay, {
    fromRunId: previous.id,
    fromRuntimeId: previous.route.runtimeId,
    reason: 'quota',
  });
  assert.equal(f.controller.store.run(previous.id)?.handoffCheckpoint?.safe, true);
});

test('a quota handoff carries a short note with readable actions, not raw tool IDs or the whole earlier output', async (t) => {
  const f = fixture(t);
  const long = `EARLY_OUTPUT_MARKER\n${'Synthetic progress narrative.\n'.repeat(4000)}LATE_OUTPUT_MARKER`;
  f.behavior(async (context) => {
    context.emit({
      at: f.stamp(),
      type: 'tool',
      data: { itemId: 'call_RAW_NATIVE_ID', kind: 'commandExecution', status: 'inProgress', command: 'npm run build' },
    });
    context.emit({
      at: f.stamp(),
      type: 'tool',
      data: { itemId: 'call_RAW_NATIVE_ID', kind: 'commandExecution', status: 'completed', exitCode: 0 },
    });
    context.emit({ at: f.stamp(), type: 'text', text: long });
    throw new Error('quota-or-rate-limit');
  });
  const previous = await f.start({ userInput: 'Build the synthetic parser' });
  assert.equal(previous.handoffCheckpoint?.safe, true);
  const next = f.controller.accountRelay(f.input, previous)!;
  const note = handoffNoteIn(next.prompt)!;
  assert.ok(note, 'the relay prompt carries a handoff note');
  assert.ok(!next.prompt.includes('call_RAW_NATIVE_ID'), 'no raw native tool IDs anywhere in the prompt');
  assert.match(note, /命令 `npm run build` → 退出码 0/);
  assert.match(note, /交接原因：先前执行器 \S+ \/ \S+ 因已确认的额度不足或限流结束/);
  assert.match(note, /目标：Build the synthetic parser/);
  assert.ok(note.length <= 6000);
  assert.ok(next.prompt.includes('LATE_OUTPUT_MARKER'), 'the tail of the earlier output stays');
  assert.ok(!next.prompt.includes('EARLY_OUTPUT_MARKER'), 'the whole earlier output does not');
  assert.ok(next.prompt.length < f.input.prompt.length + 8000);
});

test('pins, changed scopes, unknown identities and untyped quota text cannot borrow a handoff checkpoint', async (t) => {
  const f = fixture(t);
  f.controller.settings.routePreferencesEnabled = true;
  f.controller.settings.routePolicy = { general: ['codex'] };
  f.behavior(async (context) => {
    settled(context);
    throw new Error('quota-or-rate-limit');
  });
  const previous = await f.start();
  for (const patch of [
    { runtimeId: previous.route.runtimeId },
    { confirmedRoute: previous.route },
    { resumeRunId: previous.id },
    { workflowId: 'other-workflow' },
    { stepId: 'other-step' },
    { permissionMode: 'read-only' as const },
    { connectorRevision: 'other' },
  ])
    assert.equal(f.controller.accountRelay({ ...f.input, ...patch }, previous), undefined);
  assert.equal(
    f.controller.accountRelay(f.input, {
      ...previous,
      route: { ...previous.route, accountFingerprint: undefined },
      account: undefined,
    }),
    undefined,
  );
  assert.equal(
    f.controller.accountRelay(f.input, { ...previous, errorCode: undefined, error: 'quota-or-rate-limit' }),
    undefined,
  );
  assert.equal(f.controller.accountRelay(f.input, { ...previous, status: 'cancelled' }), undefined);
  const pinned = f.controller.accountRelay({ ...f.input, model: 'gpt-6-sol', effort: 'high' }, previous)!;
  assert.equal(pinned.model, 'gpt-6-sol');
  assert.equal(pinned.effort, 'high');
  assert.throws(() => f.controller.preview(pinned), /指定模型/);
});

test('pending writes, missing exit results, unknown lifecycle, denial and unrelated native errors block replay after log truncation', async (t) => {
  for (const scenario of ['pending', 'no-exit', 'unknown-id', 'denial', 'other-error', 'failed-write'] as const)
    await t.test(scenario, async (t) => {
      const f = fixture(t);
      f.behavior(async (context) => {
        const data =
          scenario === 'unknown-id'
            ? { status: 'completed' }
            : {
                itemId: 'uncertain-write',
                kind: 'commandExecution',
                status: scenario === 'pending' ? 'inProgress' : 'completed',
                ...(scenario === 'no-exit' || scenario === 'pending'
                  ? {}
                  : { exitCode: scenario === 'failed-write' ? 1 : 0 }),
              };
        context.emit({ at: f.stamp(), type: 'tool', data });
        if (scenario === 'denial') context.emit({ at: f.stamp(), type: 'status', data: { decision: 'deny' } });
        if (scenario === 'other-error')
          context.emit({ at: f.stamp(), type: 'error', text: 'runtime-permission-or-sandbox-error' });
        for (let index = 0; index < 1100; index++)
          context.emit({ at: f.stamp(), type: 'status', text: 'Synthetic later status' });
        throw new Error('quota-or-rate-limit');
      });
      const previous = await f.start();
      assert.equal(
        previous.events.some((event) => event.type === 'tool'),
        true,
        'the full source ledger restores tool evidence beyond the bounded live buffer',
      );
      assert.equal(previous.handoffCheckpoint?.safe, false);
      assert.equal(f.controller.accountRelay(f.input, previous), undefined);
      if (['pending', 'no-exit', 'failed-write'].includes(scenario)) {
        assert.deepEqual(
          previous.handoffCheckpoint?.unconfirmedTools.map((tool) => tool.id),
          ['uncertain-write'],
        );
        assert.match(previous.error!, /待核验工具：uncertain-write/);
      }
      assert.equal(f.calls.length, 1);
    });
});

test('quota checkpoints settle already-sent steering before handoff and never copy uncertain delivery', async (t) => {
  for (const accepted of [true, false])
    await t.test(accepted ? 'accepted' : 'failed', async (t) => {
      const f = fixture(t);
      const failure = deferred<void>(),
        receipt = deferred<void>();
      f.behavior(async (context) => {
        settled(context);
        context.registerSteer?.(async () => {
          await receipt.promise;
          if (!accepted) throw new Error('steer-rejected');
        });
        await failure.promise;
        throw new Error('quota-or-rate-limit');
      });
      const source = await f.controller.start(f.input);
      const delivery = f.controller.steer(source.id, 'Use the latest acceptance criteria.').then(
        () => true,
        () => false,
      );
      await new Promise((done) => setImmediate(done));
      failure.resolve();
      await until(() => source.status === 'failed');
      assert.equal(source.handoffCheckpoint, undefined, 'terminal error alone cannot race an in-flight correction');
      receipt.resolve();
      assert.equal(await delivery, accepted);
      await until(() => !f.controller.active.has(source.id));
      const saved = f.controller.store.run(source.id)!;
      const next = f.controller.accountRelay(f.input, saved);
      if (accepted) {
        assert.equal(saved.handoffCheckpoint?.safe, true);
        assert.match(next!.prompt, /用户已接受的最新补充/);
        assert.match(next!.prompt, /Use the latest acceptance criteria/);
      } else {
        assert.equal(saved.handoffCheckpoint?.safe, false);
        assert.equal(next, undefined);
        assert.equal(saved.steeringInputs, undefined);
      }
    });
});

test('all exhausted inventory waits on genuine health and needs newer provider observations before the failed pool can resume', async (t) => {
  const f = fixture(t);
  f.controller.targets = [f.targets[0]!];
  f.controller.snapshots = [f.observed(f.targets[0]!)];
  f.behavior(async (context) => {
    settled(context);
    throw new Error('quota-or-rate-limit');
  });
  const previous = await f.start();
  const next = f.controller.accountRelay(f.input, previous)!;
  assert.ok(next, 'a safe checkpoint stays queued rather than becoming a blocked quota string');
  assert.equal(next.excludeRuntimeIds, undefined);
  assert.throws(
    () => f.controller.preview(next),
    (error) => error instanceof RouteUnavailableError && error.kind === 'quota' && !!error.retryAt,
  );
  f.advance(61000);
  assert.throws(
    () => f.controller.preview(next),
    (error) =>
      error instanceof RouteUnavailableError && error.kind === 'refresh' && /新读数尚未核验/.test(error.message),
  );
  const refreshed = f.observed(f.targets[0]!);
  // A metadata-only notification cannot give an old window a new age.
  refreshed.quota.windows[0]!.observedAt = previous.startedAt;
  f.controller.snapshots = [refreshed];
  assert.throws(() => f.controller.preview(next), /新读数尚未核验/);
  delete refreshed.quota.windows[0]!.observedAt;
  assert.equal(
    f.controller.preview(next).runtimeId,
    f.targets[0]!.id,
    'a real new full observation can resume the remaining step',
  );
  assert.equal(f.calls.length, 1, 'refresh checks never launch models or consume the attempt budget');
});

test('a retried connection error does not make an otherwise settled quota checkpoint unsafe', async (t) => {
  const f = fixture(t);
  f.behavior(async (context) => {
    settled(context);
    // Codex reports transient failures it retries itself before the turn ends on quota.
    context.emit({ at: f.stamp(), type: 'error', text: 'runtime-network-error' });
    throw new Error('quota-or-rate-limit');
  });
  const previous = await f.start();
  assert.equal(previous.handoffCheckpoint?.safe, true);
  assert.ok(f.controller.accountRelay(f.input, previous));
});

test('with nothing unused left, a handoff keeps the exclusions it carried and only re-admits the quota-failed account', async (t) => {
  const f = fixture(t);
  f.controller.targets = [f.targets[0]!, f.targets[2]!];
  f.controller.snapshots = f.controller.targets.map(f.observed);
  f.behavior(async (context) => {
    settled(context);
    throw new Error('quota-or-rate-limit');
  });
  const input = { ...f.input, excludeRuntimeIds: ['claude-c'] };
  const previous = await f.start(input);
  assert.equal(previous.route.runtimeId, 'codex-a');
  const next = f.controller.accountRelay(input, previous)!;
  assert.ok(next);
  assert.deepEqual(next.excludeRuntimeIds, ['claude-c'], 'an exclusion from before the handoff still applies');
});

test('an account that never reports a known quota resumes after its health cooldown, not after a reading it cannot give', async (t) => {
  const f = fixture(t);
  f.controller.targets = [f.targets[0]!];
  const unknown = (): RuntimeSnapshot => ({
    ...f.observed(f.targets[0]!),
    quota: { status: 'unknown', source: 'Synthetic quota', observedAt: null, windows: [] },
  });
  f.controller.snapshots = [unknown()];
  f.behavior(async (context) => {
    settled(context);
    throw new Error('quota-or-rate-limit');
  });
  // Only a task that accepts unknown quota can use such an account at all.
  const input = { ...f.input, allowUnknownQuota: true };
  const previous = await f.start(input);
  const next = f.controller.accountRelay(input, previous)!;
  assert.ok(next);
  assert.throws(
    () => f.controller.preview(next),
    (error) => error instanceof RouteUnavailableError && error.kind === 'quota',
  );
  f.advance(61000);
  f.controller.snapshots = [unknown()];
  assert.equal(f.controller.preview(next).runtimeId, f.targets[0]!.id);
});
