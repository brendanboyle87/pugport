import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, unlinkSync, rmdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Controller } from '../src/server/controller.ts';
import { Store } from '../src/server/store.ts';
import { WorkspaceStore } from '../src/server/workspace-store.ts';
import { codexAdapter } from '../src/server/adapters/codex.ts';
import { claudeAdapter } from '../src/server/adapters/claude.ts';
import { claudeSessionConfig } from '../src/server/claude-session-config.ts';
import { cursorAdapter } from '../src/server/adapters/cursor.ts';
import { cursorEditorUsage } from '../src/server/cursor-usage.ts';
import { steeringProgressFromEvent } from '../src/shared/steering-progress.ts';
import type {
  AppState,
  ExecuteContext,
  ExecuteResult,
  RunInput,
  RunRecord,
  RunEvent,
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

async function within<T>(promise: Promise<T>, description: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${description}`)), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const target: RuntimeTarget = {
  id: 'codex-mock',
  provider: 'codex',
  label: 'Mock Codex',
  environment: 'native',
  enabled: true,
  command: 'before-command',
};

function snapshot(source: string, usedPercent = 20): RuntimeSnapshot {
  return {
    id: target.id,
    provider: 'codex',
    label: target.label,
    environment: 'native',
    installed: true,
    status: 'ready',
    accountFingerprint: 'synthetic-native-account',
    models: [{ id: 'mock-model', label: 'Mock model', efforts: ['low', 'medium', 'high'] }],
    quota: {
      status: 'known',
      source,
      observedAt: new Date().toISOString(),
      windows: [
        { id: 'weekly', label: 'Weekly', usedPercent, resetsAt: new Date(Date.now() + 3600_000).toISOString() },
      ],
    },
    capabilities: { execute: true, resume: true, cancel: true, approvals: true },
    refreshedAt: new Date().toISOString(),
  };
}

function fixture(t: TestContext, options: { now?: () => number } = {}) {
  // Hosted runners may expose TMP through a short path or symlink. Match the canonical
  // project paths used by Workspace before comparing leases with Controller.start().
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'agent-studio-controller-test-')));
  const dataDir = join(directory, 'data');
  const controller = new Controller(directory, dataDir, options);
  t.mock.method(controller, 'machineReading', () => ({
    totalBytes: 32 * 1024 ** 3,
    cpus: 16,
    availableMemoryBytes: 16 * 1024 ** 3,
    cpuPercent: 20,
  }));
  // The constructor only configures targets. Disable polling before selecting the sole mocked adapter.
  clearInterval(controller.timer);
  controller.targets = [{ ...target }];
  let closing: Promise<void> | undefined;
  const close = () => (closing ??= controller.close());
  t.after(async () => {
    await close();
    for (const name of ['studio.sqlite', 'studio.sqlite-wal', 'studio.sqlite-shm']) {
      const path = join(dataDir, name);
      if (existsSync(path)) unlinkSync(path);
    }
    const connectionDirectory = join(dataDir, 'connection-tests');
    if (existsSync(connectionDirectory)) rmdirSync(connectionDirectory);
    rmdirSync(dataDir);
    rmdirSync(directory);
  });
  const input: RunInput = {
    prompt: 'Mock-only task',
    projectPath: directory,
    kind: 'general',
    permissionMode: 'read-only',
  };
  return { controller, input, close };
}

test('disabling Cursor usage immediately removes editor balances and bounds its cache by quota freshness', async (t) => {
  const { controller } = fixture(t);
  const quota = { ...snapshot('Cursor 编辑器登录 · cursor.com 用量').quota, unlimited: true };
  controller.snapshots = [
    { ...snapshot('fixture'), id: 'cursor-native', provider: 'cursor', quota },
    snapshot('Codex native quota'),
  ];
  controller.settings.cursorUsageFromEditor = true;
  cursorEditorUsage.enabled = true;
  controller.updateSettings({ cursorUsageFromEditor: false, maxQuotaAgeSeconds: 120 });
  assert.equal(cursorEditorUsage.enabled, false);
  assert.equal(cursorEditorUsage.maxAgeMs, 120_000);
  assert.equal(controller.snapshots[0]!.quota.status, 'unknown');
  assert.deepEqual(controller.snapshots[0]!.quota.windows, []);
  assert.equal(controller.snapshots[0]!.quota.unlimited, undefined);
  assert.equal(controller.snapshots[1]!.quota.status, 'known');
  assert.equal(controller.snapshots[1]!.quota.source, 'Codex native quota');
});

for (const reopen of [false, true])
  test(`Cursor usage completed before a slower provider cannot reappear after disabling${reopen ? ' and re-enabling' : ''}`, async (t) => {
    const { controller } = fixture(t);
    const cursorTarget: RuntimeTarget = { ...target, id: 'cursor-fixture', provider: 'cursor', label: 'Cursor' };
    controller.targets.push(cursorTarget);
    controller.settings.cursorUsageFromEditor = true;
    cursorEditorUsage.enabled = true;
    const slow = deferred<void>(),
      cursorRead = deferred<void>();
    let reads = 0;
    t.mock.method(codexAdapter, 'discover', async () => {
      await slow.promise;
      return snapshot('fixture');
    });
    t.mock.method(cursorAdapter, 'discover', async () => {
      reads++;
      cursorRead.resolve();
      return {
        ...snapshot('Cursor 编辑器登录 · cursor.com 用量', reads === 1 ? 20 : 40),
        id: cursorTarget.id,
        provider: 'cursor' as const,
        label: 'Cursor',
      };
    });
    const refresh = controller.refresh();
    try {
      await cursorRead.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      controller.updateSettings({ cursorUsageFromEditor: false });
      if (reopen) controller.updateSettings({ cursorUsageFromEditor: true });
    } finally {
      slow.resolve();
    }
    await refresh;
    const quota = controller.snapshots.find((value) => value.id === cursorTarget.id)!.quota;
    if (reopen) {
      assert.equal(reads, 2, 'reopening must obtain a new observation instead of accepting the old in-flight result');
      assert.equal(quota.windows[0]!.usedPercent, 40);
    } else {
      assert.equal(quota.status, 'unknown');
      assert.deepEqual(quota.windows, []);
    }
    cursorEditorUsage.enabled = false;
  });

test('native tools retain their actual executor and configured execution context in the durable audit', async (t) => {
  const { controller, input } = fixture(t);
  t.mock.method(codexAdapter, 'discover', async () => snapshot('fixture'));
  const entered = deferred<ExecuteContext>(),
    finish = deferred<ExecuteResult>();
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    entered.resolve(ctx);
    return finish.promise;
  });
  const run = await controller.start(input);
  const ctx = await within(entered.promise, 'synthetic native execution');
  try {
    ctx.emit({
      at: new Date().toISOString(),
      type: 'tool',
      data: { tool: 'read_file', toolCallId: 'fixture-call', status: 'completed', output: 'safe fixture' },
    });
    const saved = controller.runWithAudit(run.id)!;
    const tool = saved.events.find((event) => event.data?.toolCallId === 'fixture-call')!;
    assert.equal(tool.data?.executor, target.label);
    assert.equal(tool.data?.provider, target.provider);
    assert.equal(tool.data?.runtimeId, target.id);
    assert.equal(tool.data?.source, 'native');
    assert.equal(tool.data?.transport, 'cli');
    const context = saved.events.find((event) => event.data?.kind === 'execution-context')!.data?.detail as Record<
      string,
      unknown
    >;
    assert.equal(context.configuredCommand, target.command);
    assert.equal(context.cwd, input.projectPath);
    assert.equal(context.executor, target.label);
    assert.equal(context.nativeSystemPrompt, 'not-reported');
    assert.equal(context.environment, 'native');
    assert.ok(!('env' in context));
  } finally {
    finish.resolve({ output: 'done' });
    await until(() => !controller.active.has(run.id), 'run completion');
  }
});

test('automatic tool handling is the default and is frozen for each run independently of route confirmation', async (t) => {
  const { controller, input } = fixture(t);
  t.mock.method(codexAdapter, 'discover', async () => snapshot('fixture'));
  const entered = deferred<ExecuteContext>(),
    finish = deferred<ExecuteResult>();
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    entered.resolve(ctx);
    return finish.promise;
  });
  assert.equal(controller.settings.toolApprovalMode, 'auto');
  controller.updateSettings({ decisionMode: 'confirm' });
  const run = await controller.start(input),
    ctx = await within(entered.promise, 'automatic execution');
  try {
    assert.equal(ctx.approvalMode, 'auto');
    assert.equal(run.toolApprovalMode, 'auto');
    controller.updateSettings({ toolApprovalMode: 'ask' });
    assert.equal(await ctx.approve('Unexpected escalation', 'outside project'), false);
    assert.equal(controller.approvals.size, 0);
    assert.equal(run.status, 'running');
    assert.ok(run.events.some((event) => event.text?.includes('已拒绝')));
  } finally {
    finish.resolve({ output: 'done' });
    await until(() => !controller.active.has(run.id), 'run completion');
  }
  assert.equal(controller.store.run(run.id)?.toolApprovalMode, 'auto');
});

test('explicit ask mode still shows and resolves a per-tool approval', async (t) => {
  const { controller, input } = fixture(t);
  controller.updateSettings({ toolApprovalMode: 'ask' });
  t.mock.method(codexAdapter, 'discover', async () => snapshot('fixture'));
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => ({
    output: (await ctx.approve('Fixture tool', 'Fixture operation')) ? 'allowed' : 'denied',
  }));
  const run = await controller.start(input);
  await until(() => controller.approvals.size === 1, 'manual approval');
  assert.equal(run.status, 'waiting-approval');
  controller.answerApproval([...controller.approvals.keys()][0]!, true);
  await until(() => !controller.active.has(run.id), 'manual completion');
  assert.equal(controller.store.run(run.id)?.output, 'allowed');
  const approvals = controller.store.run(run.id)!.events.filter((event) => event.type === 'approval');
  assert.deepEqual(
    approvals.map((event) => event.data?.status),
    ['requested', 'approved'],
  );
  assert.equal(approvals[0].data?.approvalId, approvals[1].data?.approvalId);
  assert.ok(approvals.every((event) => typeof event.seq === 'number'));
  assert.ok(!JSON.stringify(approvals).includes('Fixture operation'));
  assert.equal(controller.store.run(run.id)?.eventsDropped, 0);
});

test('cancelling a waiting approval persists one safe terminal decision and ignores a late answer', async (t) => {
  const { controller, input } = fixture(t);
  controller.updateSettings({ toolApprovalMode: 'ask' });
  t.mock.method(codexAdapter, 'discover', async () => snapshot('fixture'));
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => ({
    output: (await ctx.approve('Fixture tool', 'private approval description')) ? 'allowed' : 'denied',
  }));
  const run = await controller.start(input);
  await until(() => controller.approvals.size === 1, 'waiting approval');
  const approvalId = [...controller.approvals.keys()][0]!;
  controller.cancel(run.id);
  assert.throws(() => controller.answerApproval(approvalId, true), /审批已失效/);
  await until(() => !controller.active.has(run.id), 'cancelled approval completion');
  const approvals = controller.store.run(run.id)!.events.filter((event) => event.type === 'approval');
  assert.deepEqual(
    approvals.map((event) => event.data?.status),
    ['requested', 'cancelled'],
  );
  assert.equal(approvals[0].data?.approvalId, approvals[1].data?.approvalId);
  assert.ok(!JSON.stringify(approvals).includes('private approval description'));
});

test('execution rejects a changed confirmed route after discovery before calling an executor', async (t) => {
  const { controller, input } = fixture(t);
  t.mock.method(codexAdapter, 'discover', async () => snapshot('fixture'));
  const execute = t.mock.method(codexAdapter, 'execute', async () => ({ output: 'should not run' }));
  await assert.rejects(
    controller.start({
      ...input,
      model: 'mock-model',
      confirmedRoute: { runtimeId: target.id, model: 'mock-model', effort: 'low' },
    }),
    /需要重新确认/,
  );
  assert.equal(execute.mock.callCount(), 0);
  assert.equal(controller.active.size, 0);
  assert.equal(controller.store.runSummaries().length, 0);
});

test(
  'changing target during discovery discards the old result and publishes only the new configuration',
  { timeout: 10_000 },
  async (t) => {
    const { controller } = fixture(t);
    const oldEntered = deferred<void>();
    const newEntered = deferred<void>();
    const oldResult = deferred<RuntimeSnapshot>();
    const newResult = deferred<RuntimeSnapshot>();
    const oldSnapshot = snapshot('old account', 0);
    const observedSources: string[] = [];
    let originalTarget: RuntimeTarget | undefined;
    controller.on('state', (state: AppState) =>
      observedSources.push(...state.runtimes.map((runtime) => runtime.quota.source)),
    );
    const discover = t.mock.method(codexAdapter, 'discover', async (value: RuntimeTarget) => {
      if (value.command === 'before-command') {
        originalTarget = value;
        oldEntered.resolve();
        return oldResult.promise;
      }
      assert.equal(value.command, 'after-command');
      newEntered.resolve();
      return newResult.promise;
    });
    const refresh = controller.refresh();
    try {
      await within(oldEntered.promise, 'first discovery');
      controller.updateTarget(target.id, { command: 'after-command' });
      assert.equal(
        originalTarget?.command,
        'before-command',
        'in-flight discovery must retain an immutable configuration snapshot',
      );
      oldResult.resolve(oldSnapshot);
      await within(newEntered.promise, 'replacement discovery');
      assert.equal(
        controller.snapshots.length,
        0,
        'old credentials/configuration must not repopulate the cleared resource snapshot',
      );
      assert.ok(!observedSources.includes('old account'), 'stale quota must never be broadcast, even transiently');
      newResult.resolve(snapshot('new account', 80));
      await within(refresh, 'replacement discovery completion');
      assert.equal(discover.mock.callCount(), 2);
      assert.equal(controller.snapshots[0]?.quota.source, 'new account');
      assert.equal(controller.snapshots[0]?.quota.windows[0]?.usedPercent, 80);
      assert.ok(!observedSources.includes('old account'));
    } finally {
      oldResult.resolve(snapshot('old account'));
      newResult.resolve(snapshot('new account'));
      await within(refresh, 'discovery cleanup');
    }
  },
);

async function until(predicate: () => boolean, description: string): Promise<void> {
  await within(
    (async () => {
      while (!predicate()) await new Promise((resolve) => setTimeout(resolve, 10));
    })(),
    description,
  );
}

test(
  'cancelling a queued start during discovery never invokes the adapter or writes a run',
  { timeout: 10_000 },
  async (t) => {
    const { controller, input } = fixture(t);
    const entered = deferred<void>();
    const result = deferred<RuntimeSnapshot>();
    t.mock.method(codexAdapter, 'discover', async () => {
      entered.resolve();
      return result.promise;
    });
    const execute = t.mock.method(codexAdapter, 'execute', async () => ({ output: 'must not execute' }));
    const save = t.mock.method(controller.store, 'saveRun');
    const abort = new AbortController();
    const pending = controller.start(input, undefined, abort.signal);
    const rejection = assert.rejects(pending, { name: 'AbortError' });
    try {
      await within(entered.promise, 'queued discovery');
      abort.abort();
      result.resolve(snapshot('available after cancellation'));
      await within(rejection, 'cancelled start');
      assert.equal(execute.mock.callCount(), 0);
      assert.equal(save.mock.callCount(), 0);
      assert.equal(controller.active.size, 0);
      await assert.rejects(controller.start(input, undefined, abort.signal), { name: 'AbortError' });
    } finally {
      result.resolve(snapshot('cleanup'));
      await rejection;
    }
  },
);

test('resource refresh notifies schedulers after the snapshot is usable without waking on ordinary broadcasts', async (t) => {
  const { controller } = fixture(t);
  t.mock.method(codexAdapter, 'discover', async () => snapshot('new observation'));
  let refreshes = 0;
  controller.on('resources-refreshed', () => {
    refreshes++;
    assert.equal(controller.refreshPromise, undefined);
    assert.equal(controller.snapshots[0]?.quota.source, 'new observation');
  });
  controller.broadcast();
  assert.equal(refreshes, 0);
  await controller.refresh();
  assert.equal(refreshes, 1);
  controller.broadcast();
  assert.equal(refreshes, 1);
});

test(
  'connection test records terminal success while only its quota pool is settling',
  { timeout: 10_000 },
  async (t) => {
    const { controller, close } = fixture(t);
    const postResult = deferred<RuntimeSnapshot>();
    let discoveries = 0;
    t.mock.method(codexAdapter, 'discover', async () =>
      ++discoveries === 1 ? snapshot('initial') : postResult.promise,
    );
    t.mock.method(codexAdapter, 'execute', async () => ({ output: 'STUDIO_CONNECTED' }));
    try {
      const run = await controller.testConnection(target.id);
      await until(
        () => controller.snapshots[0]?.lastConnectionTest?.ok === true,
        'connection success before post-refresh',
      );
      assert.equal(controller.active.get(run.id)?.run.status, 'completed');
      assert.ok(controller.active.has(run.id), 'post-run quota observation must still own its quota reservation');
      assert.equal(controller.hasExecutionCapacity(), true, 'inference capacity is free after completion');
      assert.equal(
        controller.active.get(run.id)?.abort.signal.aborted,
        false,
        'a completed inference must not be cancelled',
      );
      const saved = controller.store.config<Record<string, { fingerprint?: string }>>('connectionTests', {});
      assert.match(saved[target.id]?.fingerprint ?? '', /^[a-f0-9]{64}$/);
    } finally {
      postResult.resolve(snapshot('post-run'));
      await close();
    }
  },
);

test('connection timeout records failure and aborts the active run', { timeout: 10_000 }, async (t) => {
  const { controller, close } = fixture(t);
  const entered = deferred<void>();
  let signal: AbortSignal | undefined;
  t.mock.method(codexAdapter, 'discover', async () => snapshot('available'));
  t.mock.method(
    codexAdapter,
    'execute',
    async (ctx: ExecuteContext) =>
      new Promise<ExecuteResult>((_resolve, reject) => {
        signal = ctx.signal;
        entered.resolve();
        ctx.signal.addEventListener('abort', () => reject(new Error('operation-cancelled')), { once: true });
      }),
  );
  const originalNow = Date.now;
  try {
    await controller.testConnection(target.id);
    await entered.promise;
    const future = originalNow() + 100_000;
    const clock = t.mock.method(Date, 'now', () => future);
    await until(() => controller.snapshots[0]?.lastConnectionTest?.error === 'runtime-timeout', 'persisted timeout');
    assert.equal(controller.snapshots[0]?.lastConnectionTest?.ok, false);
    assert.equal(signal?.aborted, true);
    clock.mock.restore();
  } finally {
    Date.now = originalNow;
    await close();
  }
});

test(
  'connection evidence only follows matching command/provider/environment/args configuration',
  { timeout: 10_000 },
  async (t) => {
    const { controller } = fixture(t);
    const latestTest = () => controller.snapshots[0]?.lastConnectionTest;
    t.mock.method(codexAdapter, 'discover', async () => snapshot('available'));
    t.mock.method(codexAdapter, 'execute', async () => ({ output: 'STUDIO_CONNECTED' }));
    controller.store.setConfig('connectionTests', {
      [target.id]: { at: new Date().toISOString(), ok: true, model: 'mock-model' },
    });
    await controller.refresh();
    assert.equal(latestTest(), undefined, 'legacy evidence without a fingerprint is not current proof');
    await controller.testConnection(target.id);
    await until(() => controller.active.size === 0 && latestTest()?.ok === true, 'successful test and released run');
    controller.updateTarget(target.id, { accountingMode: 'usage' });
    await controller.refresh();
    assert.equal(latestTest()?.ok, true, 'statistics selection does not change the execution entry');
    controller.updateTarget(target.id, { command: 'after-command' });
    await controller.refresh();
    assert.equal(latestTest(), undefined, 'changed command cannot display previous success');
    controller.updateTarget(target.id, { command: target.command, args: ['new-argument'] });
    await controller.refresh();
    assert.equal(latestTest(), undefined, 'changed arguments cannot display previous success');
    controller.updateTarget(target.id, { args: [] });
    await controller.refresh();
    assert.equal(latestTest()?.ok, true, 'restoring the same entry can display timestamped historical proof');
  },
);

test('connection observer exits safely when application closes', { timeout: 10_000 }, async (t) => {
  const { controller, close } = fixture(t);
  t.mock.method(codexAdapter, 'discover', async () => snapshot('available'));
  t.mock.method(
    codexAdapter,
    'execute',
    async (ctx: ExecuteContext) =>
      new Promise<ExecuteResult>((_resolve, reject) => {
        ctx.signal.addEventListener('abort', () => reject(new Error('operation-cancelled')), { once: true });
      }),
  );
  const writes = t.mock.method(controller.store, 'setConfig');
  await controller.testConnection(target.id);
  await close();
  const count = writes.mock.callCount();
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(writes.mock.callCount(), count, 'an observer cannot write a late result to a closed database');
  await assert.rejects(controller.testConnection(target.id), /正在关闭/);
});

test(
  'completion waits for a new post-run observation before releasing its quota reservation',
  { timeout: 10_000 },
  async (t) => {
    const { controller, input, close } = fixture(t);
    controller.snapshots = [snapshot('initial observation')];
    const execution = deferred<ExecuteResult>();
    const oldEntered = deferred<void>();
    const newEntered = deferred<void>();
    const oldResult = deferred<RuntimeSnapshot>();
    const newResult = deferred<RuntimeSnapshot>();
    const finalSaved = deferred<void>();
    const released = deferred<void>();
    let run: RunRecord | undefined;
    let observations = 0;
    t.mock.method(codexAdapter, 'execute', async () => execution.promise);
    const discover = t.mock.method(codexAdapter, 'discover', async () => {
      observations++;
      if (observations === 1) {
        oldEntered.resolve();
        return oldResult.promise;
      }
      assert.equal(observations, 2, 'completion requires one new observation after the old one');
      newEntered.resolve();
      return newResult.promise;
    });
    const saveRun = controller.store.saveRun.bind(controller.store);
    t.mock.method(controller.store, 'saveRun', (value: RunRecord) => {
      saveRun(value);
      if (value.status === 'completed' && value.endedAt) finalSaved.resolve();
    });
    controller.on('state', () => {
      if (run && !controller.active.has(run.id)) released.resolve();
    });
    let periodicRefresh: Promise<void> | undefined;
    try {
      run = await within(controller.start(input), 'task reservation');
      periodicRefresh = controller.refresh();
      await within(oldEntered.promise, 'observation started before task completion');
      execution.resolve({ output: 'mock completed' });
      await within(finalSaved.promise, 'completed run persistence');
      assert.equal(discover.mock.callCount(), 1, 'new discovery must wait for the in-flight discovery');
      assert.ok(controller.active.has(run.id), 'completion alone must not release the account reservation');
      oldResult.resolve(snapshot('pre-completion observation', 20));
      await within(newEntered.promise, 'fresh post-completion observation');
      assert.ok(controller.active.has(run.id), 'the old observation must not release the quota reservation');
      assert.throws(() => controller.preview(input), /额度结算/);
      const postRunQuota = snapshot('post-completion observation', 95);
      postRunQuota.quota.windows[0]!.resetsAt = new Date(Date.now() + 48 * 3_600_000).toISOString();
      newResult.resolve(postRunQuota);
      await within(released.promise, 'reservation release');
      await periodicRefresh;
      assert.equal(discover.mock.callCount(), 2);
      assert.equal(controller.active.size, 0);
      assert.equal(controller.snapshots[0]?.quota.source, 'post-completion observation');
      assert.throws(() => controller.preview(input), /保护阈值/, 'the next task must see the newly depleted balance');
      assert.equal(controller.store.run(run.id)?.output, 'mock completed');
    } finally {
      execution.resolve({ output: 'mock completed' });
      oldResult.resolve(snapshot('pre-completion observation'));
      newResult.resolve(snapshot('post-completion observation'));
      await periodicRefresh;
      await close();
    }
  },
);

test(
  'shutdown rejects a start waiting on discovery before it can reserve or invoke an adapter',
  { timeout: 10_000 },
  async (t) => {
    const { controller, input, close } = fixture(t);
    const discoveryEntered = deferred<void>();
    const discoveryResult = deferred<RuntimeSnapshot>();
    const discover = t.mock.method(codexAdapter, 'discover', async () => {
      discoveryEntered.resolve();
      return discoveryResult.promise;
    });
    const execute = t.mock.method(codexAdapter, 'execute', async () => ({ output: 'must not execute' }));
    const saveRun = t.mock.method(controller.store, 'saveRun');
    let broadcasts = 0;
    controller.on('state', () => {
      broadcasts++;
    });
    const pendingStart = controller.start(input);
    // Attach rejection handling before closing so a failed assertion cannot cause an unhandled rejection.
    const rejection = assert.rejects(pendingStart, /正在关闭/);
    try {
      await within(discoveryEntered.promise, 'pending start discovery');
      assert.equal(controller.active.size, 0);
      await close();
      const countAtClose = broadcasts;
      discoveryResult.resolve(snapshot('discovery completed after shutdown'));
      await within(rejection, 'pending start rejection');
      assert.equal(discover.mock.callCount(), 1);
      assert.equal(execute.mock.callCount(), 0);
      assert.equal(saveRun.mock.callCount(), 0);
      assert.equal(controller.active.size, 0);
      assert.deepEqual(controller.snapshots, []);
      assert.equal(broadcasts, countAtClose, 'late discovery must not broadcast using the closed database');
      await assert.rejects(controller.start(input), /正在关闭/);
    } finally {
      discoveryResult.resolve(snapshot('cleanup'));
      await close();
      await rejection;
    }
  },
);

test('independent read-only conversations share a native account without a provider-wide queue', async (t) => {
  const { controller, input } = fixture(t);
  controller.snapshots = [snapshot('fresh')];
  const finish = deferred<ExecuteResult>();
  const execute = t.mock.method(codexAdapter, 'execute', async () => finish.promise);
  t.mock.method(codexAdapter, 'discover', async () => snapshot('after run'));
  try {
    const first = await controller.start({ ...input, prompt: 'Long answer in chat A' });
    const second = await controller.start({ ...input, prompt: 'Hello in chat B' });
    assert.notEqual(first.id, second.id);
    assert.equal(execute.mock.callCount(), 2, 'both CLI sessions start before either has completed');
    // No limit by default: a third task on the same account starts too.
    assert.equal(controller.settings.maxConcurrentRuns, 0);
    assert.equal(controller.hasExecutionCapacity(), true);
    await controller.start({ ...input, prompt: 'Third simultaneous request' });
    assert.equal(execute.mock.callCount(), 3);
    // An explicit per-account limit is enforced.
    controller.updateSettings({ maxRunsPerAccount: 2 });
    await assert.rejects(controller.start({ ...input, prompt: 'Fourth simultaneous request' }), /此账号的并发容量/);
  } finally {
    finish.resolve({ output: 'done' });
    await until(() => controller.active.size === 0, 'both conversations finished');
  }
});

test('project write exclusion still permits a separate read-only conversation', async (t) => {
  const { controller, input } = fixture(t);
  controller.snapshots = [snapshot('fresh')];
  const finish = deferred<ExecuteResult>();
  t.mock.method(codexAdapter, 'execute', async () => finish.promise);
  t.mock.method(codexAdapter, 'discover', async () => snapshot('after run'));
  controller.reserveProject(input.projectPath, 'writer');
  try {
    await controller.start({ ...input, permissionMode: 'workspace-write' }, 'writer');
    controller.reserveProject(input.projectPath, 'reader', 'read-only');
    await controller.start(input, 'reader');
    assert.throws(() => controller.reserveProject(input.projectPath, 'second-writer'), /已有执行/);
    await assert.rejects(controller.start({ ...input, permissionMode: 'workspace-write' }), /工作流占用/);
  } finally {
    finish.resolve({ output: 'done' });
    await until(() => controller.active.size === 0, 'writer and reader finished');
    controller.releaseProject(input.projectPath, 'writer');
  }
});

for (const stale of [false, true])
  test(`a ${stale ? 'stale' : 'fresh'} chosen CLI starts while an unrelated resource observation is slow`, async (t) => {
    const { controller, input } = fixture(t);
    const other = { ...target, id: 'codex-other', label: 'Other account' };
    controller.targets.push(other);
    controller.snapshots = [snapshot('fresh')];
    if (stale) controller.snapshots[0]!.quota.observedAt = new Date(Date.now() - 3600_000).toISOString();
    const observation = deferred<RuntimeSnapshot>();
    const observed = deferred<void>();
    t.mock.method(codexAdapter, 'discover', async (selected: RuntimeTarget) => {
      if (selected.id === other.id) {
        observed.resolve();
        return observation.promise;
      }
      return snapshot('after run');
    });
    const finish = deferred<ExecuteResult>();
    const execute = t.mock.method(codexAdapter, 'execute', async () => finish.promise);
    const refresh = controller.refresh({ runtimeIds: [other.id] });
    try {
      await within(observed.promise, 'slow other resource');
      const run = await within(controller.start({ ...input, runtimeId: target.id }), 'fresh direct start');
      assert.equal(run.status, 'running');
      assert.equal(execute.mock.callCount(), 1, 'no discovery wait is inserted before the selected CLI');
    } finally {
      observation.resolve({ ...snapshot('other refreshed'), id: other.id, label: other.label });
      finish.resolve({ output: 'done' });
      await refresh;
      await until(() => controller.active.size === 0, 'run finished');
    }
  });

test('completed execution frees global capacity while only its quota pool waits for observation', async (t) => {
  const { controller, input } = fixture(t);
  controller.updateSettings({ maxConcurrentRuns: 1 });
  const other = { ...target, id: 'codex-other', label: 'Other account' };
  controller.targets.push(other);
  controller.snapshots = [
    snapshot('fresh'),
    { ...snapshot('other fresh'), id: other.id, label: other.label, accountFingerprint: 'synthetic-other-account' },
  ];
  const observation = deferred<RuntimeSnapshot>();
  const observed = deferred<void>();
  t.mock.method(codexAdapter, 'discover', async (selected: RuntimeTarget) => {
    if (selected.id === target.id) {
      observed.resolve();
      return observation.promise;
    }
    return {
      ...snapshot('other after run'),
      id: other.id,
      label: other.label,
      accountFingerprint: 'synthetic-other-account',
    };
  });
  const second = deferred<ExecuteResult>();
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) =>
    ctx.target.id === target.id ? { output: 'first done' } : second.promise,
  );
  try {
    const first = await controller.start({ ...input, runtimeId: target.id });
    await within(observed.promise, 'first account post-run observation');
    assert.equal(controller.active.get(first.id)?.run.status, 'completed');
    assert.equal(controller.hasExecutionCapacity(), true);
    assert.throws(() => controller.preview({ ...input, runtimeId: target.id }), /额度结算/);
    const next = await controller.start({ ...input, runtimeId: other.id });
    assert.equal(next.status, 'running');
    assert.equal(controller.hasExecutionCapacity(), false);
  } finally {
    observation.resolve(snapshot('settled'));
    second.resolve({ output: 'second done' });
    await until(() => controller.active.size === 0, 'both accounts settled');
  }
});

test('post-run observation touches only the used runtime', async (t) => {
  const { controller, input } = fixture(t);
  const other = { ...target, id: 'codex-other', label: 'Other account' };
  controller.targets.push(other);
  controller.snapshots = [snapshot('fresh'), { ...snapshot('other fresh'), id: other.id, label: other.label }];
  const discover = t.mock.method(codexAdapter, 'discover', async (selected: RuntimeTarget) => ({
    ...snapshot('after run'),
    id: selected.id,
    label: selected.label,
  }));
  t.mock.method(codexAdapter, 'execute', async () => ({ output: 'done' }));
  const run = await controller.start({ ...input, runtimeId: target.id });
  await until(() => !controller.active.has(run.id), 'targeted observation');
  assert.equal(discover.mock.callCount(), 1);
  assert.equal(discover.mock.calls[0]?.arguments[0].id, target.id);
  assert.equal(controller.snapshots.find((value) => value.id === other.id)?.quota.source, 'other fresh');
});

test('a slow post-run refresh holds the account for at most five seconds', async (t) => {
  let clock = Date.now();
  const { controller, input } = fixture(t, { now: () => clock });
  controller.snapshots = [snapshot('fresh')];
  clock = Date.now();
  const observation = deferred<RuntimeSnapshot>();
  const observed = deferred<void>();
  t.mock.method(codexAdapter, 'discover', async () => {
    observed.resolve();
    return observation.promise;
  });
  t.mock.method(codexAdapter, 'execute', async () => ({ output: 'done' }));
  try {
    await controller.start(input);
    await within(observed.promise, 'settling refresh');
    assert.throws(() => controller.preview(input), /额度结算/);
    clock += 4999;
    assert.throws(() => controller.preview(input), /额度结算/);
    clock += 1;
    assert.equal(controller.preview(input).runtimeId, target.id, 'refresh no longer monopolizes the account');
  } finally {
    observation.resolve(snapshot('settled'));
    await until(() => controller.active.size === 0, 'settling cleanup');
  }
});

test('soft continuation reuses a native session and compact prompt only when the chosen route matches', async (t) => {
  const { controller, input } = fixture(t);
  const workspace = new WorkspaceStore(controller.store.db, { recoverInterrupted: false });
  for (const id of ['first-workflow', 'second-workflow', 'third-workflow'])
    workspace.save('workflow', id, 'same-chat', { projectId: 'same-project' });
  controller.snapshots = [snapshot('fresh')];
  t.mock.method(codexAdapter, 'discover', async () => snapshot('after run'));
  const execute = t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => ({
    output: 'done',
    nativeSessionId: ctx.nativeSessionId || 'original-native-thread',
  }));
  const first = await controller.start({ ...input, workflowId: 'first-workflow' });
  await until(() => !controller.active.has(first.id), 'first turn completed');
  const next = await controller.start({
    ...input,
    prompt: 'Long reconstructed cross-provider context',
    continuationRunId: first.id,
    continuationPrompt: 'Current turn and relevant memory only',
    workflowId: 'second-workflow',
  });
  await until(() => !controller.active.has(next.id), 'continuation completed');
  assert.equal(execute.mock.calls[1]?.arguments[0].nativeSessionId, 'original-native-thread');
  assert.equal(next.parentRunId, first.id);
  assert.equal(next.prompt, 'Current turn and relevant memory only');
  assert.equal(execute.mock.calls[1]?.arguments[0].input.prompt, next.prompt);

  controller.snapshots[0]!.capabilities.resume = false;
  const fresh = await controller.start({
    ...input,
    continuationRunId: next.id,
    continuationPrompt: 'Must not use',
    workflowId: 'third-workflow',
  });
  await until(() => !controller.active.has(fresh.id), 'unsupported resume fresh turn');
  assert.equal(execute.mock.calls[2]?.arguments[0].nativeSessionId, undefined);
  assert.equal(fresh.parentRunId, undefined);
  assert.equal(fresh.prompt, input.prompt);
});

test('soft continuation never resumes a session from a run that produced nothing', async (t) => {
  // A run that announced a native session but timed out before any reply may have no session on disk.
  const { controller, input } = fixture(t);
  const workspace = new WorkspaceStore(controller.store.db, { recoverInterrupted: false });
  for (const id of ['first-workflow', 'second-workflow'])
    workspace.save('workflow', id, 'same-chat', { projectId: 'same-project' });
  controller.snapshots = [snapshot('fresh')];
  t.mock.method(codexAdapter, 'discover', async () => snapshot('after run'));
  const execute = t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    if (execute.mock.callCount() === 0) {
      ctx.emit({ at: new Date().toISOString(), type: 'session', data: { sessionId: 'never-saved-session' } });
      throw new Error('runtime-timeout');
    }
    return { output: 'done', nativeSessionId: ctx.nativeSessionId || 'fresh-native-thread' };
  });
  const first = await controller.start({ ...input, workflowId: 'first-workflow' });
  await until(() => !controller.active.has(first.id), 'empty first turn ended');
  assert.equal(controller.store.run(first.id)?.nativeSessionId, 'never-saved-session');
  // The timeout's technical cooldown is not under test.
  controller.cooldown.clear(target.id);
  controller.snapshots = [snapshot('fresh')];
  const next = await controller.start({
    ...input,
    prompt: 'Long reconstructed context with the handoff',
    continuationRunId: first.id,
    continuationPrompt: 'Current turn only',
    workflowId: 'second-workflow',
  });
  await until(() => !controller.active.has(next.id), 'fresh turn completed');
  assert.equal(execute.mock.calls[1]?.arguments[0].nativeSessionId, undefined);
  assert.equal(next.parentRunId, undefined);
  assert.equal(next.prompt, 'Long reconstructed context with the handoff');
});

test('Claude simple chat keeps tool mode per run and rebuilds context when ordinary tools return', async (t) => {
  const { controller, input } = fixture(t);
  const claude = { ...target, id: 'claude-mock', provider: 'claude' as const };
  controller.targets = [claude];
  const catalog = { ...snapshot('fresh'), id: claude.id, provider: 'claude' as const };
  controller.snapshots = [catalog];
  Object.assign(controller, { readAccountIdentity: () => catalog.accountFingerprint });
  t.mock.method(claudeAdapter, 'discover', async () => ({ ...catalog }));
  controller.agentBridgeUrl = 'http://127.0.0.1:0/mcp';
  const workspace = new WorkspaceStore(controller.store.db, { recoverInterrupted: false });
  const calls: ExecuteContext[] = [];
  t.mock.method(claudeAdapter, 'execute', async (ctx: ExecuteContext) => {
    calls.push(ctx);
    const current = [...controller.active.values()].find((entry) => entry.run.workflowId === ctx.input.workflowId)!.run;
    ctx.registerSteer?.(async () => undefined);
    assert.equal(controller.canSteer(current.id), !ctx.input.latencySensitiveChat && !ctx.input.explicitNoTools);
    return { output: '你好', nativeSessionId: ctx.nativeSessionId ?? `native-${calls.length}` };
  });
  let previous: RunRecord | undefined;
  const modes = ['simple', 'simple', 'recall', 'configured', 'configured', 'simple'] as const;
  for (const [index, mode] of modes.entries()) {
    const simple = mode !== 'configured';
    const workflowId = `chat-${index}`;
    workspace.save('workflow', workflowId, 'same-chat', { projectId: 'same-project' });
    const sameMode = index > 0 && simple === (modes[index - 1] !== 'configured');
    const run = await controller.start({
      ...input,
      runtimeId: claude.id,
      workflowId,
      stepId: 'reply',
      prompt: 'Full local conversation context and current request',
      userInput: mode === 'recall' ? '刚才我说了什么？不使用工具。' : simple ? '你好' : '读取 README.md',
      ...(mode === 'simple' ? { latencySensitiveChat: true } : {}),
      ...(mode === 'recall' ? { explicitNoTools: true } : {}),
      ...(previous ? { continuationRunId: previous.id, continuationPrompt: 'Compact current turn' } : {}),
    });
    await until(() => !controller.active.has(run.id), `chat turn ${index}`);
    assert.equal(run.status, 'completed');
    assert.equal(run.nativeToolMode, simple ? 'none' : undefined);
    assert.equal(run.toolless, undefined);
    assert.equal(run.textOnly, undefined);
    assert.equal(
      run.events.find((event) => event.data?.kind === 'startup-timing' && event.data.phase === 'sandbox-prepare')?.data
        ?.status,
      'completed',
    );
    assert.equal(run.parentRunId, sameMode ? previous?.id : undefined);
    assert.equal(calls[index]!.nativeSessionId, sameMode ? previous?.nativeSessionId : undefined);
    const expectedPrompt = sameMode ? 'Compact current turn' : 'Full local conversation context and current request';
    assert.equal(run.prompt, expectedPrompt);
    const executionPrompt = calls[index]!.input.prompt;
    if (simple) assert.equal(executionPrompt, expectedPrompt);
    else {
      assert.ok(executionPrompt.startsWith(`${expectedPrompt}\n\n`));
      for (const tool of ['search_tools', 'call_read_only_tool', 'call_tool'])
        assert.equal(executionPrompt.match(new RegExp(`\\b${tool}\\b`, 'g'))?.length, 1);
    }
    assert.equal(!!calls[index]!.agentBridge, !simple);
    assert.equal(
      controller.store.db
        .prepare("SELECT json_extract(value,'$.nativeToolMode') AS mode FROM runs WHERE id=?")
        .get(run.id)?.mode,
      simple ? 'none' : null,
    );
    previous = run;
  }
  await assert.rejects(
    controller.start({ ...input, runtimeId: claude.id, resumeRunId: previous!.id }),
    /权限或审批模式已变化/,
  );
});

for (const interrupted of [false, true])
  test(`Controller retains a Claude idle child only after fresh quota settlement: interrupted=${interrupted}`, async (t) => {
    const { controller, input, close } = fixture(t);
    const claude = { ...target, id: 'claude-live-mock', provider: 'claude' as const };
    const catalog = { ...snapshot('fresh'), id: claude.id, provider: 'claude' as const };
    controller.targets = [claude];
    controller.snapshots = [catalog];
    Object.assign(controller, { readAccountIdentity: () => catalog.accountFingerprint });
    t.mock.method(controller, 'machineReading', () => ({
      totalBytes: 32 * 1024 ** 3,
      cpus: 16,
      availableMemoryBytes: 16 * 1024 ** 3,
      cpuPercent: 20,
      sampledAt: Date.now(),
    }));
    t.mock.method(claudeSessionConfig, 'fingerprint', async () => 'synthetic-native-config');
    const quotaStarted = deferred<void>(),
      releaseQuota = deferred<void>();
    let executed = false,
      closes = 0;
    t.mock.method(claudeAdapter, 'discover', async () => {
      if (executed) {
        quotaStarted.resolve();
        await releaseQuota.promise;
      }
      return { ...catalog, quota: { ...catalog.quota, observedAt: new Date().toISOString() } };
    });
    let alive = true;
    const resource = {
      key: 'key',
      nativeSessionId: 'session',
      isAlive: () => alive,
      close: async () => {
        if (alive) closes++;
        alive = false;
      },
    };
    let ctx!: ExecuteContext;
    t.mock.method(claudeAdapter, 'execute', async (context: ExecuteContext) => {
      ctx = context;
      executed = true;
      return { output: 'done', nativeSessionId: 'session', idleNativeSession: resource };
    });
    const run = await controller.start({ ...input, runtimeId: claude.id, explicitNoTools: true });
    await within(quotaStarted.promise, 'post-run fresh quota');
    assert.equal(ctx.nativeSessionConfiguration, 'synthetic-native-config');
    assert.ok(ctx.takeNativeSession);
    if (interrupted) {
      assert.equal(
        await ctx.takeNativeSession('key', 'session'),
        undefined,
        'a new turn cannot borrow a pending child',
      );
      assert.equal(closes, 1, 'a new turn must close the pending child before starting another process');
    }
    assert.ok(controller.active.has(run.id));
    releaseQuota.resolve();
    await until(() => !controller.active.has(run.id), 'Claude settlement');
    assert.equal(closes, interrupted ? 1 : 0);
    if (interrupted)
      assert.equal(
        await ctx.takeNativeSession('key', 'session'),
        undefined,
        'the older settlement cannot resurrect its discarded child',
      );
    await close();
    assert.equal(closes, 1);
  });

for (const sameConversation of [true, false])
  test(`Claude pending child does not extend the five-second quota reservation: sameConversation=${sameConversation}`, async (t) => {
    let clock = Date.now();
    const { controller, input } = fixture(t, { now: () => clock });
    const claude = { ...target, id: 'claude-pending-mock', provider: 'claude' as const };
    const catalog = { ...snapshot('fresh'), id: claude.id, provider: 'claude' as const };
    clock = Date.now();
    controller.targets = [claude];
    controller.snapshots = [catalog];
    Object.assign(controller, { readAccountIdentity: () => catalog.accountFingerprint });
    const workspace = new WorkspaceStore(controller.store.db, { recoverInterrupted: false });
    workspace.save('workflow', 'first', 'chat', { projectId: 'project' });
    workspace.save('workflow', 'second', sameConversation ? 'chat' : 'other-chat', { projectId: 'project' });
    t.mock.method(controller, 'machineReading', () => ({
      totalBytes: 32 * 1024 ** 3,
      cpus: 16,
      availableMemoryBytes: 16 * 1024 ** 3,
      cpuPercent: 20,
      sampledAt: clock,
    }));
    t.mock.method(claudeSessionConfig, 'fingerprint', async () => 'synthetic-native-config');
    const quotaStarted = deferred<void>(),
      releaseQuota = deferred<void>();
    t.after(() => releaseQuota.resolve());
    let calls = 0,
      alive = true,
      closes = 0;
    const resource = {
      key: 'key',
      nativeSessionId: 'session',
      isAlive: () => alive,
      close: async () => {
        if (alive) closes++;
        alive = false;
      },
    };
    t.mock.method(claudeAdapter, 'discover', async () => {
      if (calls === 1) {
        quotaStarted.resolve();
        await releaseQuota.promise;
      }
      return { ...catalog, quota: { ...catalog.quota, observedAt: new Date(clock).toISOString() } };
    });
    let borrowed = false;
    t.mock.method(claudeAdapter, 'execute', async (ctx: ExecuteContext) => {
      calls++;
      if (calls === 1) return { output: 'first', nativeSessionId: 'session', idleNativeSession: resource };
      borrowed = (await ctx.takeNativeSession?.('key', ctx.nativeSessionId)) === resource;
      return { output: 'second', nativeSessionId: 'session' };
    });
    const base = { ...input, runtimeId: claude.id, explicitNoTools: true };
    const first = await controller.start({ ...base, workflowId: 'first' });
    await within(quotaStarted.promise, 'pending continuation quota');
    const next: RunInput = { ...base, workflowId: 'second', continuationRunId: first.id, continuationPrompt: 'second' };
    clock += 4999;
    await assert.rejects(controller.start(next), /额度结算/);
    assert.equal(calls, 1, 'the original five-second quota reservation remains');
    clock++;
    const second = await controller.start(next);
    await until(() => calls === 2, 'single cold continuation invocation');
    releaseQuota.resolve();
    await until(() => !controller.active.has(first.id) && !controller.active.has(second.id), 'both runs settled');
    assert.equal(borrowed, false, 'the pending child must not be borrowed');
    assert.equal(calls, 2, 'the incoming prompt is submitted once');
    assert.equal(closes, 1, 'the pending owned child is closed before cold execution');
    assert.ok(
      controller.store.run(first.id)!.events.every((event) => event.data?.kind !== 'native-session-settlement-wait'),
    );
  });

for (const boundary of [
  'cancelled',
  'identity',
  'generation',
  'low-memory',
  'unknown-memory',
  'stale-memory',
  'unknown-quota',
] as const)
  test(`Controller discards the completed Claude child when ${boundary} invalidates retention`, async (t) => {
    const { controller, input } = fixture(t);
    const claude = { ...target, id: 'claude-live-mock', provider: 'claude' as const };
    const catalog = { ...snapshot('fresh'), id: claude.id, provider: 'claude' as const };
    controller.targets = [claude];
    controller.snapshots = [catalog];
    let executed = false,
      closes = 0;
    Object.assign(controller, {
      readAccountIdentity: () => (executed && boundary === 'identity' ? 'changed-account' : catalog.accountFingerprint),
    });
    t.mock.method(controller, 'machineReading', () => ({
      totalBytes: 32 * 1024 ** 3,
      cpus: 16,
      cpuPercent: 20,
      availableMemoryBytes:
        executed && boundary === 'unknown-memory'
          ? undefined
          : executed && boundary === 'low-memory'
            ? 1024 ** 3
            : 16 * 1024 ** 3,
      sampledAt: Date.now() - (executed && boundary === 'stale-memory' ? 60_000 : 0),
    }));
    t.mock.method(claudeSessionConfig, 'fingerprint', async () => 'synthetic-native-config');
    t.mock.method(claudeAdapter, 'discover', async () => ({
      ...catalog,
      quota: {
        ...catalog.quota,
        status: executed && boundary === 'unknown-quota' ? ('unknown' as const) : ('known' as const),
        observedAt: new Date(Date.now() - (boundary === 'unknown-quota' ? 2000 : 0)).toISOString(),
      },
    }));
    t.mock.method(claudeAdapter, 'execute', async () => {
      executed = true;
      if (boundary === 'generation') Object.assign(controller, { targetGeneration: 1 });
      if (boundary === 'cancelled') [...controller.active.values()][0]!.abort.abort();
      return {
        output: 'done',
        nativeSessionId: 'session',
        idleNativeSession: {
          key: 'key',
          nativeSessionId: 'session',
          isAlive: () => true,
          close: async () => {
            closes++;
          },
        },
      };
    });
    const run = await controller.start({ ...input, runtimeId: claude.id, explicitNoTools: true });
    await until(() => !controller.active.has(run.id), `discard ${boundary}`);
    assert.equal(closes, 1);
  });

test('permission and approval changes use a fresh native session with full context', async (t) => {
  const { controller, input } = fixture(t);
  const workspace = new WorkspaceStore(controller.store.db, { recoverInterrupted: false });
  for (const id of ['readonly', 'writable', 'new-approval'])
    workspace.save('workflow', id, 'same-chat', { projectId: 'same-project' });
  controller.snapshots = [snapshot('fresh')];
  t.mock.method(codexAdapter, 'discover', async () => snapshot('fresh'));
  const calls: ExecuteContext[] = [];
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    calls.push(ctx);
    return { output: 'done', nativeSessionId: `native-${calls.length}` };
  });
  const first = await controller.start({ ...input, workflowId: 'readonly', permissionMode: 'read-only' });
  await until(() => !controller.active.has(first.id), 'readonly task');
  const next = await controller.start({
    ...input,
    workflowId: 'writable',
    permissionMode: 'workspace-write',
    continuationRunId: first.id,
    continuationPrompt: 'not safe after a scope change',
    prompt: 'Current user request and full previous context',
  });
  await until(() => !controller.active.has(next.id), 'writable task');
  assert.equal(calls[1]?.nativeSessionId, undefined);
  assert.equal(calls[1]?.input.prompt, 'Current user request and full previous context');
  assert.equal(next.parentRunId, undefined);
  assert.equal(next.permissionMode, 'workspace-write');
  controller.settings.toolApprovalMode = 'ask';
  const differentApproval = await controller.start({
    ...input,
    workflowId: 'new-approval',
    permissionMode: 'workspace-write',
    continuationRunId: next.id,
    continuationPrompt: 'old mode context',
  });
  await until(() => !controller.active.has(differentApproval.id), 'changed approval');
  assert.equal(calls[2]?.nativeSessionId, undefined);
  assert.equal(calls[2]?.approvalMode, 'ask');
  await assert.rejects(
    controller.start({ ...input, resumeRunId: next.id, permissionMode: 'workspace-write' }),
    /审批模式已变化/,
  );
});

test('executor reports of blocked work do not become completed runs or expose the report marker', async (t) => {
  const { controller, input } = fixture(t);
  controller.snapshots = [snapshot('fresh')];
  t.mock.method(codexAdapter, 'discover', async () => snapshot('fresh'));
  t.mock.method(codexAdapter, 'execute', async () => ({
    output: 'Only checked the files.\nCOMBORUNNER_TASK_RESULT: {"status":"partial","summary":"No files were moved."}',
  }));
  const run = await controller.start({ ...input, reportTaskOutcome: true });
  await until(() => !controller.active.has(run.id), 'reported partial task');
  assert.equal(run.status, 'failed');
  assert.equal(run.taskOutcome?.status, 'partial');
  assert.match(run.error!, /No files were moved/);
  assert.equal(run.output, 'Only checked the files.');
});

test('an unresolved native permission block cannot be promoted to successful completion', async (t) => {
  const { controller, input } = fixture(t);
  controller.snapshots = [snapshot('fresh')];
  t.mock.method(codexAdapter, 'discover', async () => snapshot('fresh'));
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    ctx.emit({ at: new Date().toISOString(), type: 'error', data: { executionBlocked: true, reason: 'permission' } });
    return { output: 'The operation did not run.' };
  });
  const run = await controller.start({ ...input, reportTaskOutcome: true });
  await until(() => !controller.active.has(run.id), 'native block reported');
  assert.equal(run.status, 'failed');
  assert.equal(run.taskOutcome?.source, 'native-permission');
});

test('native denial reasons survive incomplete reports and remain visible in the saved run', async (t) => {
  for (const status of ['partial', 'blocked', 'missing-report'])
    await t.test(status, async (t) => {
      const { controller, input } = fixture(t);
      controller.snapshots = [snapshot('fresh')];
      t.mock.method(codexAdapter, 'discover', async () => snapshot('fresh'));
      const detail = 'Auto mode blocked this action (The request only asks for review; moving files is unrequested).';
      t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
        ctx.emit({
          at: new Date().toISOString(),
          type: 'error',
          text: 'Generic native confirmation block.',
          data: { executionBlocked: true, reason: 'permission' },
        });
        ctx.emit({
          at: new Date().toISOString(),
          type: 'error',
          text: '原生权限拒绝了操作。',
          data: { executionBlocked: true, reason: 'permission', detail },
        });
        return {
          output:
            'Inspection results.' +
            (status === 'missing-report'
              ? ''
              : `\nCOMBORUNNER_TASK_RESULT: ${JSON.stringify({ status, summary: 'No files were moved.' })}`),
        };
      });
      const run = await controller.start({ ...input, reportTaskOutcome: true });
      await until(() => !controller.active.has(run.id), 'incomplete run with a concrete native reason');
      assert.equal(run.status, 'failed');
      assert.ok(run.error?.includes(detail));
      assert.ok(!run.error?.includes('Generic native confirmation block.'));
      assert.match(run.error!, /原生工具拒绝原因/);
      assert.equal(controller.store.run(run.id)?.error, run.error);
      assert.equal(run.taskOutcome?.status, status === 'missing-report' ? 'blocked' : status);
    });
});

test('a completed review can recover from an unrequested operation denial without pretending files changed', async (t) => {
  const { controller, input } = fixture(t);
  controller.snapshots = [snapshot('fresh')];
  t.mock.method(codexAdapter, 'discover', async () => snapshot('fresh'));
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    ctx.emit({
      at: new Date().toISOString(),
      type: 'error',
      data: {
        executionBlocked: true,
        reason: 'permission',
        detail: 'Auto mode blocked this action (Moving files was not requested).',
      },
    });
    return {
      output:
        'Reviewed the collection. No files were changed.\nCOMBORUNNER_TASK_RESULT: {"status":"completed","summary":"The requested review is complete; no modifications were requested."}',
    };
  });
  const run = await controller.start({ ...input, reportTaskOutcome: true });
  await until(() => !controller.active.has(run.id), 'completed review after an unnecessary operation was denied');
  assert.equal(run.status, 'completed');
  assert.equal(run.taskOutcome?.status, 'completed');
  assert.equal(run.error, undefined);
  assert.match(run.output, /No files were changed/);
  assert.ok(run.events.some((event) => event.data?.executionBlocked === true));
});

test('native refusal details survive later adapter exceptions and verification failures', async (t) => {
  for (const failure of ['exception', 'verification', 'quota', 'authentication'])
    await t.test(failure, async (t) => {
      const { controller, input } = fixture(t);
      controller.snapshots = [snapshot('fresh')];
      t.mock.method(codexAdapter, 'discover', async () => snapshot('fresh'));
      const detail = 'Auto mode blocked this action (Moving files was not requested).';
      t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
        ctx.emit({
          at: new Date().toISOString(),
          type: 'error',
          data: { executionBlocked: true, reason: 'permission', detail },
        });
        if (failure !== 'verification')
          throw new Error(
            failure === 'quota'
              ? 'quota-or-rate-limit'
              : failure === 'authentication'
                ? 'authentication-required'
                : 'runtime-process-closed',
          );
        return { output: 'COMBORUNNER_TASK_RESULT: {"status":"completed","summary":"Inspection complete."}' };
      });
      const verify = t.mock.method(
        controller as unknown as { verify: () => Promise<NonNullable<RunRecord['verification']>> },
        'verify',
        async () => ({ command: 'synthetic-check', status: 'failed', exitCode: 1, output: 'Synthetic mismatch' }),
      );
      controller.isVerificationApproved = (value) => value.verificationCommand === 'synthetic-check';
      const run = await controller.start({
        ...input,
        reportTaskOutcome: true,
        ...(failure === 'verification' ? { verificationCommand: 'synthetic-check' } : {}),
      });
      await until(() => !controller.active.has(run.id), 'failure after a concrete native refusal');
      assert.equal(run.status, 'failed');
      assert.ok(run.error?.includes(detail));
      assert.equal(controller.store.run(run.id)?.error, run.error);
      if (failure !== 'verification') {
        const expectedCode =
          failure === 'quota'
            ? 'quota-or-rate-limit'
            : failure === 'authentication'
              ? 'authentication-required'
              : 'runtime-process-closed';
        assert.equal(run.errorCode, expectedCode);
        assert.ok(run.error?.startsWith(expectedCode));
        assert.equal(verify.mock.callCount(), 0);
        if (failure === 'quota' || failure === 'authentication')
          assert.ok(controller.accountHealth.report().some((entry) => entry.reason === failure));
      } else {
        assert.match(run.error!, /^验收命令失败/);
        assert.equal(verify.mock.callCount(), 1);
        assert.equal(run.verification?.status, 'failed');
      }
    });
});

test('repeated native denial diagnostics are deduplicated, bounded and redacted in the final error', async (t) => {
  const { controller, input } = fixture(t);
  controller.snapshots = [snapshot('fresh')];
  t.mock.method(codexAdapter, 'discover', async () => snapshot('fresh'));
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    const details = [
      'Unrequested action was blocked. token="synthetic secret with spaces"',
      'Unrequested action was blocked. token="synthetic secret with spaces"',
      'Second blocked operation: ' + 'x'.repeat(2000),
      'Third blocked operation: ' + 'y'.repeat(2000),
      'Fourth blocked operation must stay in events instead of enlarging the final error.',
    ];
    for (const detail of details)
      ctx.emit({
        at: new Date().toISOString(),
        type: 'error',
        data: { executionBlocked: true, reason: 'permission', detail },
      });
    return { output: 'COMBORUNNER_TASK_RESULT: {"status":"blocked","summary":"The requested operation did not run."}' };
  });
  const run = await controller.start({ ...input, reportTaskOutcome: true });
  await until(() => !controller.active.has(run.id), 'bounded denied run');
  assert.equal(run.status, 'failed');
  assert.ok(!run.error?.includes('synthetic secret'));
  assert.equal(run.error?.split('Unrequested action was blocked.').length, 2);
  assert.ok(run.error!.length < 4000);
  assert.ok(!run.error?.includes('Fourth blocked operation'));
});

test('soft continuation needs a known identity even for a custom native target', async (t) => {
  const { controller, input } = fixture(t);
  const workspace = new WorkspaceStore(controller.store.db, { recoverInterrupted: false });
  for (const id of ['source-workflow', 'next-workflow'])
    workspace.save('workflow', id, 'same-chat', { projectId: 'same-project' });
  const unknownIdentity = () => ({ ...snapshot('unknown identity'), accountFingerprint: undefined });
  controller.snapshots = [unknownIdentity()];
  t.mock.method(codexAdapter, 'discover', async () => unknownIdentity());
  const execute = t.mock.method(codexAdapter, 'execute', async (_ctx: ExecuteContext) => ({
    output: 'done',
    nativeSessionId: 'old-session',
  }));
  const source = await controller.start({ ...input, workflowId: 'source-workflow' });
  await until(() => !controller.active.has(source.id), 'source completed');
  const next = await controller.start({
    ...input,
    workflowId: 'next-workflow',
    continuationRunId: source.id,
    continuationPrompt: 'Unsafe compact prompt',
  });
  await until(() => !controller.active.has(next.id), 'new session completed');
  assert.equal(execute.mock.calls[1]?.arguments[0].nativeSessionId, undefined);
  assert.equal(next.parentRunId, undefined);
  assert.equal(next.prompt, input.prompt);
});

test('soft continuation never transfers a native session to a different account or project', async (t) => {
  const { controller, input } = fixture(t);
  const workspace = new WorkspaceStore(controller.store.db, { recoverInterrupted: false });
  for (const id of ['first-workflow', 'second-workflow', 'third-workflow'])
    workspace.save('workflow', id, 'same-chat', { projectId: 'same-project' });
  const identity = 'first-account';
  controller.snapshots = [{ ...snapshot('fresh'), accountFingerprint: identity }];
  const discover = t.mock.method(codexAdapter, 'discover', async () => ({
    ...snapshot('after run'),
    accountFingerprint: identity,
  }));
  const execute = t.mock.method(codexAdapter, 'execute', async (_ctx: ExecuteContext) => ({
    output: 'done',
    nativeSessionId: 'first-native-thread',
  }));
  const first = await controller.start({ ...input, workflowId: 'first-workflow' });
  await until(() => !controller.active.has(first.id), 'original account finished');
  controller.snapshots[0]!.accountFingerprint = 'other-account';
  discover.mock.restore();
  t.mock.method(codexAdapter, 'discover', async () => ({
    ...snapshot('after account change'),
    accountFingerprint: 'other-account',
  }));
  const changed = await controller.start({
    ...input,
    continuationRunId: first.id,
    continuationPrompt: 'compact',
    workflowId: 'second-workflow',
  });
  await until(() => !controller.active.has(changed.id), 'changed account fresh turn');
  assert.equal(execute.mock.calls[1]?.arguments[0].nativeSessionId, undefined);
  assert.equal(changed.parentRunId, undefined);
  assert.equal(changed.prompt, input.prompt);
  const stored = controller.store.run(changed.id)!;
  stored.projectPath = join(input.projectPath, 'other-project');
  controller.store.saveRun(stored);
  const relocated = await controller.start({
    ...input,
    continuationRunId: changed.id,
    continuationPrompt: 'compact',
    workflowId: 'third-workflow',
  });
  await until(() => !controller.active.has(relocated.id), 'different project fresh turn');
  assert.equal(execute.mock.calls[2]?.arguments[0].nativeSessionId, undefined);
  assert.equal(relocated.parentRunId, undefined);
});

test('former factory concurrency limits upgrade to unlimited once while a later explicit limit is preserved', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-studio-parallel-settings-'));
  const dataDir = join(directory, 'data');
  const seed = new Store(dataDir);
  seed.setConfig('settings', { maxConcurrentRuns: 1 });
  seed.close();
  let controller: Controller | undefined;
  t.after(async () => {
    await controller?.close();
    for (const name of ['studio.sqlite', 'studio.sqlite-wal', 'studio.sqlite-shm']) {
      const path = join(dataDir, name);
      if (existsSync(path)) unlinkSync(path);
    }
    rmdirSync(dataDir);
    rmdirSync(directory);
  });
  controller = new Controller(directory, dataDir);
  clearInterval(controller.timer);
  assert.equal(controller.settings.maxConcurrentRuns, 0);
  controller.updateSettings({ maxConcurrentRuns: 1 });
  await controller.close();
  controller = new Controller(directory, dataDir);
  clearInterval(controller.timer);
  assert.equal(controller.settings.maxConcurrentRuns, 1);
});

test('soft continuation cannot import a native thread from another conversation in the same project', async (t) => {
  const { controller, input } = fixture(t);
  const workspace = new WorkspaceStore(controller.store.db, { recoverInterrupted: false });
  workspace.save('workflow', 'source-workflow', 'chat-one', { projectId: 'same-project' });
  workspace.save('workflow', 'other-workflow', 'chat-two', { projectId: 'same-project' });
  controller.snapshots = [snapshot('fresh')];
  t.mock.method(codexAdapter, 'discover', async () => snapshot('after run'));
  const execute = t.mock.method(codexAdapter, 'execute', async (_ctx: ExecuteContext) => ({
    output: 'done',
    nativeSessionId: 'source-thread',
  }));
  const first = await controller.start({ ...input, workflowId: 'source-workflow' });
  await until(() => !controller.active.has(first.id), 'source completed');
  const next = await controller.start({
    ...input,
    workflowId: 'other-workflow',
    continuationRunId: first.id,
    continuationPrompt: 'unsafe compact',
  });
  await until(() => !controller.active.has(next.id), 'other chat completed');
  assert.equal(execute.mock.calls[1]?.arguments[0].nativeSessionId, undefined);
  assert.equal(next.parentRunId, undefined);
  assert.equal(next.prompt, input.prompt);
});

test('two simultaneous resumes cannot execute inside one native session while an independent chat can', async (t) => {
  const { controller, input } = fixture(t);
  controller.snapshots = [snapshot('fresh')];
  t.mock.method(codexAdapter, 'discover', async () => snapshot('after run'));
  const pending = deferred<ExecuteResult>();
  let calls = 0;
  t.mock.method(codexAdapter, 'execute', async () =>
    ++calls === 1 ? { output: 'done', nativeSessionId: 'source-thread' } : pending.promise,
  );
  const source = await controller.start(input);
  await until(() => !controller.active.has(source.id), 'source turn completed');
  try {
    const resumed = await controller.start({ ...input, resumeRunId: source.id });
    assert.equal(resumed.nativeSessionId, 'source-thread');
    await assert.rejects(controller.start({ ...input, resumeRunId: source.id }), /原生会话正在执行上一条消息/);
    const independent = await controller.start({ ...input, prompt: 'Other chat' });
    assert.equal(independent.status, 'running');
    assert.equal(independent.nativeSessionId, undefined);
  } finally {
    pending.resolve({ output: 'done' });
    await until(() => controller.active.size === 0, 'resumed and independent chats complete');
  }
});

test('the later factory limit of four also upgrades to unlimited once', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-studio-unlimited-settings-'));
  const dataDir = join(directory, 'data');
  const seed = new Store(dataDir);
  seed.setConfig('settings', { maxConcurrentRuns: 4 });
  seed.setConfig('parallelConversationsMigration', { completed: true });
  seed.close();
  let controller: Controller | undefined;
  t.after(async () => {
    await controller?.close();
    for (const name of ['studio.sqlite', 'studio.sqlite-wal', 'studio.sqlite-shm']) {
      const path = join(dataDir, name);
      if (existsSync(path)) unlinkSync(path);
    }
    rmdirSync(dataDir);
    rmdirSync(directory);
  });
  controller = new Controller(directory, dataDir);
  clearInterval(controller.timer);
  assert.equal(controller.settings.maxConcurrentRuns, 0);
  assert.equal(controller.hasExecutionCapacity(99), false, 'unlimited settings still obey machine capacity');
  controller.updateSettings({ maxConcurrentRuns: 4 });
  await controller.close();
  controller = new Controller(directory, dataDir);
  clearInterval(controller.timer);
  assert.equal(controller.settings.maxConcurrentRuns, 4, 'an explicit choice after the migration stays');
});

test('bridge credentials are rejected immediately on cancel or a direct run abort', async (t) => {
  const { controller, input } = fixture(t);
  controller.agentBridgeUrl = 'http://127.0.0.1:0/mcp';
  controller.snapshots = [snapshot('fresh')];
  t.mock.method(codexAdapter, 'discover', async () => snapshot('after run'));
  const entered = deferred<ExecuteContext>();
  const done = deferred<ExecuteResult>();
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    entered.resolve(ctx);
    return done.promise;
  });
  const run = await controller.start({ ...input, workflowId: 'bridge-parent', stepId: 'step' });
  const ctx = await within(entered.promise, 'bridge execution');
  const token = ctx.agentBridge!.token;
  const caller = controller.agentBridgeCaller(token)!;
  assert.equal(caller.signal.aborted, false);
  controller.cancel(run.id);
  assert.equal(caller.signal.aborted, true);
  assert.equal(controller.agentBridgeCaller(token), undefined, 'cancel must reject before the adapter has returned');
  // Revocation survives even a replacement handle, rather than depending only on the current abort flag.
  controller.active.get(run.id)!.abort = new AbortController();
  assert.equal(controller.agentBridgeCaller(token), undefined);
  done.resolve({ output: 'done' });
  await until(() => !controller.active.has(run.id), 'cancelled execution ends');

  const nextEntered = deferred<ExecuteContext>(),
    nextDone = deferred<ExecuteResult>();
  t.mock.method(codexAdapter, 'execute', async (next: ExecuteContext) => {
    nextEntered.resolve(next);
    return nextDone.promise;
  });
  const next = await controller.start({ ...input, workflowId: 'bridge-parent', stepId: 'step2' });
  const nextCtx = await within(nextEntered.promise, 'second bridge execution');
  const nextCaller = controller.agentBridgeCaller(nextCtx.agentBridge!.token)!;
  controller.active.get(next.id)!.abort.abort();
  assert.equal(nextCaller.signal.aborted, true, 'already accepted tools must also observe a direct run abort');
  assert.equal(
    controller.agentBridgeCaller(nextCtx.agentBridge!.token),
    undefined,
    'non-cancel abort paths must also reject',
  );
  nextDone.resolve({ output: 'done' });
  await until(() => !controller.active.has(next.id), 'aborted execution ends');
});

test('bridge authorization survives input transitions but ends at explicit native completion before cleanup', async (t) => {
  const { controller, input } = fixture(t);
  controller.agentBridgeUrl = 'http://127.0.0.1:0/mcp';
  controller.settings.toolApprovalMode = 'ask';
  controller.snapshots = [snapshot('fresh')];
  t.mock.method(codexAdapter, 'discover', async () => snapshot('after run'));
  const entered = deferred<ExecuteContext>(),
    finishTurn = deferred<void>(),
    finishing = deferred<void>(),
    cleanup = deferred<void>();
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    ctx.registerSteer?.(async () => undefined);
    entered.resolve(ctx);
    await finishTurn.promise;
    ctx.registerSteer?.(undefined, { state: 'finishing' });
    ctx.endTools?.();
    finishing.resolve();
    await cleanup.promise;
    return { output: 'success after native cleanup' };
  });
  const run = await controller.start({ ...input, workflowId: 'bridge-parent', stepId: 'step' });
  const ctx = await within(entered.promise, 'bridge execution');
  const token = ctx.agentBridge!.token;
  const caller = controller.agentBridgeCaller(token)!;
  try {
    assert.equal(run.steeringStatus?.state, 'ready');
    assert.equal(caller.signal.aborted, false);
    ctx.registerSteer?.(undefined, { state: 'waiting' });
    assert.ok(controller.agentBridgeCaller(token), 'temporarily waiting native turns retain tool authorization');
    ctx.registerSteer?.(undefined, { state: 'finishing' });
    assert.ok(controller.agentBridgeCaller(token), 'input state alone cannot revoke a living execution');
    assert.equal(caller.signal.aborted, false);
    ctx.registerSteer?.(async () => undefined);
    assert.ok(controller.agentBridgeCaller(token), 'an accepted next turn can still call tools');
    const approval = ctx.approve('Mock tool', 'Mock operation');
    await until(() => controller.approvals.size === 1, 'tool approval');
    assert.equal(run.status, 'waiting-approval');
    assert.ok(controller.agentBridgeCaller(token), 'approval waits retain tool authorization');
    assert.equal(caller.signal.aborted, false);
    controller.answerApproval([...controller.approvals.keys()][0]!, true);
    assert.equal(await approval, true);

    finishTurn.resolve();
    await within(finishing.promise, 'native finishing before cleanup');
    assert.equal(run.status, 'running', 'native cleanup has not returned to Controller yet');
    assert.equal(controller.active.has(run.id), true);
    assert.equal(controller.agentBridgeCaller(token), undefined, 'finishing must revoke before cleanup settles');
    assert.equal(caller.signal.aborted, true, 'tools accepted before finishing must receive cancellation');
    assert.equal(ctx.signal.aborted, false, 'revoking tool grants must not cancel successful native cleanup');
  } finally {
    for (const id of controller.approvals.keys()) controller.answerApproval(id, false);
    finishTurn.resolve();
    cleanup.resolve();
    await until(() => !controller.active.has(run.id), 'successful execution completes');
  }
  assert.equal(run.status, 'completed');
  assert.equal(run.output, 'success after native cleanup');
});

test('Controller also aborts borrowed tool authorization when an adapter returns without reporting finishing', async (t) => {
  const { controller, input } = fixture(t);
  controller.agentBridgeUrl = 'http://127.0.0.1:0/mcp';
  controller.snapshots = [snapshot('fresh')];
  t.mock.method(codexAdapter, 'discover', async () => snapshot('after run'));
  const entered = deferred<ExecuteContext>(),
    done = deferred<ExecuteResult>();
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    entered.resolve(ctx);
    return done.promise;
  });
  const run = await controller.start({ ...input, workflowId: 'bridge-parent', stepId: 'step' });
  const ctx = await within(entered.promise, 'bridge execution');
  const token = ctx.agentBridge!.token;
  const caller = controller.agentBridgeCaller(token)!;
  done.resolve({ output: 'success' });
  await until(() => !controller.active.has(run.id), 'successful execution completes');
  assert.equal(controller.agentBridgeCaller(token), undefined);
  assert.equal(caller.signal.aborted, true);
  assert.equal(ctx.signal.aborted, false);
  assert.equal(run.status, 'completed');
});

test('the first returning nested wait reacquires a real slot even while another tool still waits', async (t) => {
  const { controller, input } = fixture(t);
  controller.settings.maxConcurrentRuns = 1;
  controller.settings.maxRunsPerAccount = 1;
  controller.snapshots = [snapshot('fresh')];
  t.mock.method(codexAdapter, 'discover', async () => snapshot('after run'));
  const endings = new Map<string, ReturnType<typeof deferred<ExecuteResult>>>();
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    const ending = deferred<ExecuteResult>();
    endings.set(ctx.input.prompt, ending);
    return ending.promise;
  });
  const parent = await controller.start({ ...input, prompt: 'parent' });
  const resumeOuter = controller.suspendExecution(parent.id),
    resumeInner = controller.suspendExecution(parent.id);
  assert.equal(controller.hasExecutionCapacity(), true);
  const child = await controller.start({ ...input, prompt: 'child' });
  let restored = false;
  const resuming = resumeInner().then(() => {
    restored = true;
  });
  await Promise.resolve();
  assert.equal(restored, false);
  assert.equal(controller.hasExecutionCapacity(), false);
  await assert.rejects(controller.start({ ...input, prompt: 'unrelated' }), /并发容量已满/);
  endings.get('child')!.resolve({ output: 'child done' });
  await within(resuming, 'parent regains its slot');
  assert.equal(controller.active.get(parent.id)!.resuming, false);
  assert.equal(controller.active.get(parent.id)!.suspensions, 1, 'another tool may still be waiting');
  assert.equal(controller.active.get(parent.id)!.parked, false, 'the returned tool has activated the native caller');
  assert.equal(controller.hasExecutionCapacity(), false);
  await assert.rejects(controller.start({ ...input, prompt: 'unrelated after resume' }), /并发容量已满/);
  await resumeOuter();
  assert.equal(controller.hasExecutionCapacity(), false, 'later returns do not release or duplicate the slot');
  endings.get('parent')!.resolve({ output: 'parent done' });
  await until(() => !controller.active.has(parent.id) && !controller.active.has(child.id), 'all runs finish');
});

test('a bounded resumption cancels only its caller and retains the running child', async (t) => {
  const { controller, input } = fixture(t);
  controller.settings.maxConcurrentRuns = 1;
  controller.snapshots = [snapshot('fresh')];
  t.mock.method(codexAdapter, 'discover', async () => snapshot('after run'));
  const endings = new Map<string, ReturnType<typeof deferred<ExecuteResult>>>();
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    const end = deferred<ExecuteResult>();
    endings.set(ctx.input.prompt, end);
    ctx.signal.addEventListener('abort', () => end.resolve({ output: 'stopped' }), { once: true });
    return end.promise;
  });
  const parent = await controller.start({ ...input, prompt: 'parent' });
  const resume = controller.suspendExecution(parent.id);
  const child = await controller.start({ ...input, prompt: 'child' });
  const childAbort = controller.active.get(child.id)!.abort;
  await assert.rejects(resume({ deadline: Date.now() + 25 }), /恢复执行资源超时/);
  assert.equal(childAbort.signal.aborted, false);
  assert.equal(child.status, 'running');
  await until(() => !controller.active.has(parent.id), 'parent paused after resource deadline');
  assert.match(parent.error!, /恢复执行资源超时/);
  endings.get('child')!.resolve({ output: 'child work preserved' });
  await until(() => !controller.active.has(child.id), 'child completes normally');
  assert.equal(child.status, 'completed');
});

test('a resumption with no remaining time still succeeds if capacity is immediately available', async (t) => {
  const { controller, input } = fixture(t);
  controller.snapshots = [snapshot('fresh')];
  t.mock.method(codexAdapter, 'discover', async () => snapshot('after run'));
  const done = deferred<ExecuteResult>();
  t.mock.method(codexAdapter, 'execute', async () => done.promise);
  const run = await controller.start(input);
  const resume = controller.suspendExecution(run.id);
  await resume({ deadline: Date.now() });
  assert.equal(controller.active.get(run.id)!.parked, false);
  assert.equal(controller.active.get(run.id)!.abort.signal.aborted, false);
  done.resolve({ output: 'done' });
  await until(() => !controller.active.has(run.id), 'run ends');
});

test('a disconnected tool can shorten an already pending resource restoration deadline', async (t) => {
  const { controller, input } = fixture(t);
  controller.settings.maxConcurrentRuns = 1;
  controller.snapshots = [snapshot('fresh')];
  t.mock.method(codexAdapter, 'discover', async () => snapshot('after run'));
  const done = deferred<ExecuteResult>();
  t.mock.method(codexAdapter, 'execute', async () => done.promise);
  const parent = await controller.start(input);
  const resume = controller.suspendExecution(parent.id);
  const child = await controller.start({ ...input, prompt: 'child' });
  const pending = resume({ deadline: Date.now() + 10_000 });
  const rejected = assert.rejects(pending, /恢复执行资源超时/);
  assert.equal(resume({ deadline: Date.now() }), pending, 'repeat calls tighten the same reservation');
  await rejected;
  assert.equal(controller.active.get(parent.id)!.abort.signal.aborted, true);
  assert.equal(controller.active.get(child.id)!.abort.signal.aborted, false);
  done.resolve({ output: 'done' });
  await until(() => controller.active.size === 0, 'runs end');
});

test('a returned nested writer remains exclusive while another bridge wait is outstanding', async (t) => {
  const { controller, input } = fixture(t);
  controller.snapshots = [snapshot('fresh')];
  t.mock.method(codexAdapter, 'discover', async () => snapshot('after run'));
  const endings = new Map<string, ReturnType<typeof deferred<ExecuteResult>>>();
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    const ending = deferred<ExecuteResult>();
    endings.set(ctx.input.prompt, ending);
    return ending.promise;
  });
  controller.reserveProject(input.projectPath, 'parent');
  const writing = { ...input, permissionMode: 'workspace-write' as const };
  const parent = await controller.start({ ...writing, prompt: 'parent', workflowId: 'parent' }, 'parent');
  const outer = controller.suspendExecution(parent.id),
    inner = controller.suspendExecution(parent.id);
  await controller.start({ ...writing, prompt: 'child', workflowId: 'child' }, 'parent');
  let returned = false;
  const restoring = inner().then(() => {
    returned = true;
  });
  await Promise.resolve();
  assert.equal(returned, false);
  endings.get('child')!.resolve({ output: 'done' });
  await within(restoring, 'parent regains exclusive writer');
  await assert.rejects(
    controller.start({ ...writing, prompt: 'sibling', workflowId: 'sibling' }, 'parent'),
    /同一工作区只允许一个写入者/,
  );
  await outer();
  endings.get('parent')!.resolve({ output: 'done' });
  await until(() => controller.active.size === 0, 'runs end');
  controller.releaseProject(input.projectPath, 'parent');
});

test('host mutations retain the writer slot until all accepted writes settle, then a wait may yield', async (t) => {
  const { controller, input } = fixture(t);
  controller.settings.maxConcurrentRuns = 1;
  controller.snapshots = [snapshot('fresh')];
  t.mock.method(codexAdapter, 'discover', async () => snapshot('after run'));
  const endings = new Map<string, ReturnType<typeof deferred<ExecuteResult>>>();
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    const ending = deferred<ExecuteResult>();
    endings.set(ctx.input.prompt, ending);
    return ending.promise;
  });
  const writing = { ...input, permissionMode: 'workspace-write' as const };
  const parent = await controller.start({ ...writing, prompt: 'parent' });
  const first = controller.retainMutation(parent.id),
    second = controller.retainMutation(parent.id);
  const resume = controller.suspendExecution(parent.id);
  assert.equal(controller.hasExecutionCapacity(), false, 'an in-flight mutation still owns its execution slot');
  await assert.rejects(controller.start({ ...writing, prompt: 'child' }), /并发容量已满/);
  first();
  first();
  assert.equal(controller.hasExecutionCapacity(), false, 'release is idempotent and another mutation is active');
  second();
  assert.equal(controller.hasExecutionCapacity(), true);
  const child = await controller.start({ ...writing, prompt: 'child' });
  assert.throws(() => controller.retainMutation(parent.id), /正在等待子任务/);
  const restoring = resume();
  await until(() => endings.has('child'), 'child executor started');
  endings.get('child')!.resolve({ output: 'done' });
  await within(restoring, 'writer slot restored after child');
  const release = controller.retainMutation(parent.id);
  const early = controller.suspendExecution(parent.id);
  await early();
  release();
  assert.equal(controller.hasExecutionCapacity(), false, 'a late write completion cannot park a resumed caller');
  assert.equal(controller.active.get(parent.id)!.parked, false);
  endings.get('parent')!.resolve({ output: 'done' });
  await until(() => !controller.active.has(parent.id) && !controller.active.has(child.id), 'runs end');
});

test('a queued slot resumption rejects as soon as its run is cancelled', async (t) => {
  const { controller, input } = fixture(t);
  controller.settings.maxConcurrentRuns = 1;
  controller.snapshots = [snapshot('fresh')];
  t.mock.method(codexAdapter, 'discover', async () => snapshot('after run'));
  const finish = deferred<ExecuteResult>();
  t.mock.method(codexAdapter, 'execute', async () => finish.promise);
  const parent = await controller.start(input),
    resume = controller.suspendExecution(parent.id);
  const child = await controller.start({ ...input, prompt: 'child' });
  const resuming = resume();
  controller.cancel(parent.id);
  await assert.rejects(resuming, /abort/i);
  finish.resolve({ output: 'done' });
  await until(() => !controller.active.has(parent.id) && !controller.active.has(child.id), 'all runs finish');
});

test('shutdown wakes a queued slot resumption before closing the run store', async (t) => {
  const { controller, input, close } = fixture(t);
  controller.settings.maxConcurrentRuns = 1;
  controller.snapshots = [snapshot('fresh')];
  t.mock.method(
    codexAdapter,
    'execute',
    async (ctx: ExecuteContext) =>
      new Promise<ExecuteResult>((done) => {
        ctx.signal.addEventListener('abort', () => done({ output: 'stopped' }), { once: true });
      }),
  );
  const parent = await controller.start(input),
    resume = controller.suspendExecution(parent.id);
  await controller.start({ ...input, prompt: 'child' });
  const rejected = assert.rejects(resume(), /abort/i);
  await close();
  await rejected;
});

test('returning parents reclaim a finite slot in request order', async (t) => {
  const { controller, input } = fixture(t);
  controller.settings.maxConcurrentRuns = 1;
  controller.snapshots = [snapshot('fresh')];
  t.mock.method(codexAdapter, 'discover', async () => snapshot('after run'));
  const endings = new Map<string, ReturnType<typeof deferred<ExecuteResult>>>();
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    const ending = deferred<ExecuteResult>();
    endings.set(ctx.input.prompt, ending);
    return ending.promise;
  });
  const first = await controller.start({ ...input, prompt: 'first' });
  const resumeFirst = controller.suspendExecution(first.id);
  const second = await controller.start({ ...input, prompt: 'second' });
  const resumeSecond = controller.suspendExecution(second.id);
  await controller.start({ ...input, prompt: 'child' });
  const order: string[] = [];
  const firstRestored = resumeFirst().then(() => {
    order.push('first');
  });
  const secondRestored = resumeSecond().then(() => {
    order.push('second');
  });
  const anotherReplyFromFirst = controller.returnExecution(first.id)();
  endings.get('child')!.resolve({ output: 'done' });
  await within(firstRestored, 'first parent resumes');
  await within(anotherReplyFromFirst, 'an already restored caller returns another tool reply');
  assert.deepEqual(order, ['first']);
  assert.equal(controller.hasExecutionCapacity(), false);
  endings.get('first')!.resolve({ output: 'done' });
  await within(secondRestored, 'second parent resumes');
  assert.deepEqual(order, ['first', 'second']);
  endings.get('second')!.resolve({ output: 'done' });
  await until(() => controller.active.size === 0, 'all runs finish');
});

test('steering progress follows actual delivery, preserves early native resume, and isolates later failures', async (t) => {
  const { controller, input } = fixture(t);
  controller.snapshots = [snapshot('fresh')];
  t.mock.method(codexAdapter, 'discover', async () => snapshot('after run'));
  const entered = deferred<ExecuteContext>(),
    done = deferred<ExecuteResult>();
  const deliveries: Array<{ id: string; mode?: 'interrupt' | 'append' }> = [];
  const events: RunEvent[] = [];
  let clientProgress: RunRecord['steeringProgress'];
  controller.on('run', ({ event }: { runId: string; event: RunEvent }) => {
    events.push(event);
    clientProgress = steeringProgressFromEvent(clientProgress, event);
  });
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    ctx.registerSteer?.(async (prompt, delivery) => {
      assert.ok(delivery, 'every controller delivery has a correlation id');
      deliveries.push(delivery);
      assert.equal(clientProgress?.id, delivery.id, 'sending is published before entering the native adapter');
      assert.equal(clientProgress?.phase, 'sending');
      if (prompt === 'fail') throw new Error('mock delivery rejected');
      if (prompt === 'resume immediately')
        ctx.emit({
          type: 'status',
          at: new Date().toISOString(),
          data: { steeringPhase: 'resuming', steeringId: delivery.id },
        });
    });
    entered.resolve(ctx);
    return done.promise;
  });
  const record = await controller.start({ ...input, workflowId: 'steer-parent', stepId: 'steer-step' });
  const ctx = await within(entered.promise, 'steer registration');
  try {
    assert.equal(controller.steerInterrupts(record.id), false);
    assert.equal(await controller.steer(record.id, 'resume immediately'), true);
    assert.equal(record.steeringProgress?.phase, 'resuming');
    assert.deepEqual(clientProgress, record.steeringProgress);
    assert.equal(deliveries[0].mode, 'append');
    assert.deepEqual(record.steeringInputs, ['resume immediately']);
    assert.equal(controller.store.run(record.id)?.steeringProgress?.phase, 'resuming');

    await assert.rejects(controller.steer(record.id, 'fail'), /mock delivery rejected/);
    assert.equal(record.steeringProgress?.phase, 'failed');
    assert.deepEqual(record.steeringInputs, ['resume immediately'], 'failed messages are not claimed as accepted');
    const failedId = record.steeringProgress?.id;
    assert.notEqual(failedId, deliveries[0].id);
    assert.equal(await controller.steer(record.id, 'try new correction'), true);
    assert.equal(record.steeringProgress?.phase, 'received');
    const latest = record.steeringProgress;
    ctx.emit({
      type: 'status',
      at: new Date().toISOString(),
      data: { steeringPhase: 'resuming', steeringId: failedId },
    });
    assert.equal(record.steeringProgress, latest, 'a late native receipt must retain the new delivery state');
    assert.deepEqual(clientProgress, record.steeringProgress, 'SSE and server use the same transitions');
    assert.equal(events.filter((event) => event.data?.steeringPhase === 'sending').length, 3);
    for (const provider of ['grok', 'claude'] as const) {
      controller.targets[0].provider = provider;
      assert.equal(
        controller.steerInterrupts(record.id),
        true,
        `${provider} must not receive automatic interrupting child notices`,
      );
    }
    controller.targets[0].provider = 'codex';
  } finally {
    done.resolve({ output: 'done' });
    await until(() => !controller.active.has(record.id), 'steer fixture completion');
  }
});
