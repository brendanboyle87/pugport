import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { StartupMaintenance } from '../src/server/startup-maintenance.ts';
import { Controller } from '../src/server/controller.ts';
import { Workspace } from '../src/server/workspace.ts';
import { Store } from '../src/server/store.ts';
import { WorkspaceStore } from '../src/server/workspace-store.ts';
import type { Workflow, RunRecord } from '../src/shared/types.ts';
import { nativeCliProviders } from '../src/shared/provider-registry.ts';
import { UsageLedger } from '../src/server/usage.ts';

function startupCpuBenchmark() {
  let value = 0x12345678;
  for (let index = 0; index < 8_000_000; index++) value = (Math.imul(value ^ index, 1664525) + 1013904223) | 0;
  return value;
}

function trimmedMaxLag(samples: number[]) {
  assert.ok(samples.length > 2, 'event loop monitor needs more than two samples');
  return [...samples].sort((a, b) => b - a)[2]!;
}

function lagThreshold(baselineMs: number, absoluteLimitMs: number) {
  return Math.max(baselineMs + 400, absoluteLimitMs);
}

test('startup lag gate tolerates two outliers but rejects repeated excess delay', () => {
  const baseline = trimmedMaxLag([5, 10, 15, 537, 626]);
  assert.equal(baseline, 15);
  const threshold = lagThreshold(baseline, 500);
  assert.equal(threshold, 500);
  assert.ok(trimmedMaxLag([10, 20, 30, 537, 626]) <= threshold);
  assert.ok(trimmedMaxLag([10, 20, 600, 610, 620]) > threshold);
  assert.equal(lagThreshold(300, 500), 700);
  assert.equal(lagThreshold(10, 1000), 1000);
});

test('maintenance yields between budgeted slices and cancellation leaves remaining work untouched', async () => {
  let count = 0;
  function* work() {
    for (let i = 0; i < 20; i++) {
      const start = performance.now();
      while (performance.now() - start < 2) {
        /* synthetic synchronous unit */
      }
      count++;
      yield;
    }
  }
  const job = new StartupMaintenance(work(), 4);
  assert.equal(count, 0, 'construction must not run maintenance');
  await delay(1);
  assert.ok(count > 0 && count < 20);
  job.stop();
  const stopped = count;
  await job.done;
  await delay(10);
  assert.equal(count, stopped);
});

test('follow-up maintenance rechecks deleted rows and detects successors added after its watermark', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'startup-followup-'));
  const storage = new Store(root);
  const store = new WorkspaceStore(storage.db);
  t.after(() => storage.close());
  const workspace = Object.assign(Object.create(Workspace.prototype), { store }) as Workspace;
  const steps = (since?: string): Generator<void> =>
    Reflect.get(Workspace.prototype, 'repairWorkflowFollowUpSteps').call(workspace, undefined, since);
  const save = (id: string, status: Workflow['status']) => {
    const workflow: Workflow = {
      id,
      projectId: 'p',
      conversationId: 'c',
      userMessageId: `m-${id}`,
      input: { content: 'Synthetic', mode: 'build', permissionMode: 'read-only', executionPolicy: 'cli-first' },
      status,
      phase: 'execute',
      plan: [],
      runIds: [],
      memoryRevision: 0,
      memoryExcerpt: '',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    store.save('workflow', id, 'c', workflow);
    store.save('message', `m-${id}`, 'c', { role: 'user', content: 'Synthetic' });
    return workflow;
  };
  const old = save('old', 'blocked');
  save('next', 'completed');
  const pending = steps();
  pending.next(); // collection query
  pending.next(); // yield before the first row
  store.save('workflow', old.id, 'c', { ...old, deletedAt: '2026-02-01T00:00:00.000Z' });
  for (const _ of pending) {
    /* drain */
  }
  assert.equal(store.get<Workflow>('workflow', old.id)?.followUp, undefined);
  store.save('workflow', old.id, 'c', old);
  store.db.prepare("DELETE FROM workspace_records WHERE kind='workflow' AND id='next'").run();
  store.db.prepare("UPDATE workspace_records SET updated_at='2026-01-01T00:00:00.000Z'").run();
  const watermark = '2026-02-01T00:00:00.000Z';
  for (const _ of steps(watermark)) {
    /* unchanged old row has no new successor */
  }
  assert.equal(store.get<Workflow>('workflow', old.id)?.followUp, undefined);
  save('new-successor', 'completed');
  for (const _ of steps(watermark)) {
    /* new workflow makes this conversation eligible again */
  }
  assert.equal(store.get<Workflow>('workflow', old.id)?.followUp?.workflowId, 'new-successor');
});

test('delegation maintenance rechecks live state after yielding and safely records missing conversations', (t) => {
  const storage = new Store(mkdtempSync(join(tmpdir(), 'startup-archive-')));
  const store = new WorkspaceStore(storage.db);
  t.after(() => storage.close());
  const parent = {
    id: 'parent',
    projectId: 'p',
    conversationId: 'c',
    input: {},
    status: 'completed',
    runIds: [],
    createdAt: '',
    updatedAt: '',
  };
  const child = { ...parent, id: 'child', delegation: { parentId: 'parent', role: 'worker', requestId: 'r' } };
  store.save('workflow', 'parent', 'c', parent);
  store.save('workflow', 'child', 'c', child);
  store.save('project', 'p', 'p', { id: 'p' });
  store.save('conversation', 'c', 'p', { id: 'c', projectId: 'p', createdAt: '', updatedAt: '' });
  let archives = 0;
  const workspace = Object.assign(Object.create(Workspace.prototype), {
    store,
    active: new Map(),
    ownsExecutionWorkspace: () => false,
    workflowSubtree: () => [store.get('workflow', 'child')],
    archiveWorkflow: () => {
      archives++;
    },
  }) as Workspace;
  const steps = (): Generator<void> =>
    Reflect.get(Workspace.prototype, 'archiveSettledDelegationSteps').call(workspace, 'parent');
  const pending = steps();
  pending.next();
  store.save('workflow', 'parent', 'c', { ...parent, status: 'running' });
  for (const _ of pending) {
    /* current parent is active */
  }
  assert.equal(archives, 0);
  store.save('workflow', 'parent', 'c', parent);
  for (const _ of steps()) {
    /* eligible child */
  }
  assert.equal(archives, 1);
  store.save('conversation', 'c', 'p', { id: 'c', deletedAt: '2026-01-01' });
  for (const _ of steps()) {
    /* invalid conversation */
  }
  const revision = store.db.prepare('SELECT n FROM workspace_revision').get();
  for (const _ of steps()) {
    /* restart repeats the safe guard without rewriting the marker */
  }
  assert.equal(archives, 1);
  assert.equal(store.get<{ reason: string }>('startup-archive-skip', 'parent')?.reason, 'conversation-unavailable');
  assert.deepEqual(store.db.prepare('SELECT n FROM workspace_revision').get(), revision);
  store.save('conversation', 'c', 'p', { id: 'c', projectId: 'p' });
  store.save('project', 'p', 'p', { id: 'p', removedAt: '2026-02-01' });
  for (const _ of steps()) {
    /* removed project cannot reach archiveWorkflow either */
  }
  assert.equal(archives, 1);
});

test('dispatch sweep rechecks active work after yielding', (t) => {
  const storage = new Store(mkdtempSync(join(tmpdir(), 'startup-dispatch-')));
  const store = new WorkspaceStore(storage.db);
  t.after(() => storage.close());
  const at = '2026-01-01T00:00:00.000Z';
  store.save('conversation', 'c', 'p', { id: 'c', projectId: 'p', createdAt: at, updatedAt: at });
  store.save('external-conversation', 'c', 'c', { dispatched: true });
  const workflow = {
    id: 'w',
    projectId: 'p',
    conversationId: 'c',
    status: 'completed',
    input: {},
    createdAt: at,
    updatedAt: at,
  };
  store.save('workflow', 'w', 'c', workflow);
  const active = new Map();
  const workspace = Object.assign(Object.create(Workspace.prototype), {
    store,
    active,
    clock: () => Date.parse('2026-02-01'),
    controller: { broadcast() {} },
  }) as Workspace;
  const steps = (): Generator<void> => Reflect.get(Workspace.prototype, 'archiveSettledDispatchSteps').call(workspace);
  const pending = steps();
  pending.next();
  active.set('new-task', { workflow });
  for (const _ of pending) {
    /* task arrived between slices */
  }
  assert.equal(store.get<{ archivedAt?: string }>('conversation', 'c')?.archivedAt, undefined);
  active.clear();
  for (const _ of steps()) {
    /* now safe */
  }
  assert.ok(store.get<{ archivedAt?: string }>('conversation', 'c')?.archivedAt);
});

test('history slices read current runs and do not checkpoint concurrent changes outside their snapshot', (t) => {
  const storage = new Store(mkdtempSync(join(tmpdir(), 'startup-usage-')));
  t.after(() => storage.close());
  const ledger = new UsageLedger(storage.db);
  const run: RunRecord = {
    id: 'old',
    prompt: 'Synthetic',
    projectPath: storage.directory,
    kind: 'routine',
    status: 'completed',
    startedAt: '2026-02-01',
    events: [],
    output: '',
    route: { runtimeId: 'synthetic', model: 'synthetic', kind: 'routine', reasons: [], warnings: [] },
  };
  storage.saveRun(run);
  const pending = ledger.historyImportSteps([]);
  pending.next();
  storage.saveRun({ ...run, status: 'failed' });
  storage.saveRun({ ...run, id: 'inserted-between-slices', startedAt: '2026-01-01' });
  for (const _ of pending) {
    /* captured ID is reread; inserted ID waits for the next import */
  }
  const saved = storage.db.prepare("SELECT value FROM usage_runs WHERE id='old'").get() as { value: string };
  assert.equal(JSON.parse(saved.value).status, 'failed');
  const checkpoint = storage.db.prepare('SELECT revision,imported_revision FROM usage_history_state').get() as {
    revision: number;
    imported_revision: number | null;
  };
  assert.notEqual(checkpoint.revision, checkpoint.imported_revision);
  assert.equal(ledger.historyImport([]).importedRuns, 1);
  assert.equal(ledger.historyImport([]).importedRuns, 0);
});

function admissionFixture(gateway?: 'api', budget = false) {
  const directory = mkdtempSync(join(tmpdir(), 'startup-admission-'));
  let complete!: () => void;
  let admitted = 0;
  let resets = 0;
  let previews = 0;
  const leases = new Map<string, string>();
  const target = {
    id: 'fixture',
    provider: gateway ? 'pi' : 'codex',
    gateway,
    enabled: true,
    ...(budget ? { apiBudget: { limitUsd: 10 } } : {}),
    get args(): never {
      admitted++;
      throw new Error('admission-reached');
    },
  };
  const controller = Object.assign(Object.create(Controller.prototype), {
    usageHistoryComplete: false,
    usageHistoryMaintenance: {
      done: new Promise<void>((resolve) => {
        complete = resolve;
      }),
    },
    targets: [target],
    snapshots: [
      {
        id: 'fixture',
        provider: target.provider,
        capabilities: { execute: true },
        models: [{ id: 'model' }],
        status: 'ready',
      },
    ],
    settings: { autoUseResetCards: true },
    leases,
    assertAvailableRuntime: () => {},
    hasExecutionCapacity: () => true,
    hasSwarmExecutionCapacity: () => true,
    writerExecuting: () => false,
    preview: () => {
      previews++;
      return { runtimeId: 'fixture', model: 'model' };
    },
    autoReset: async () => {
      resets++;
      return false;
    },
  }) as Controller;
  const start = (signal?: AbortSignal, permissionMode = 'read-only') =>
    Reflect.get(Controller.prototype, 'startOnce').call(
      controller,
      { projectPath: directory, permissionMode },
      undefined,
      signal,
    ) as Promise<unknown>;
  const waiting = async () => {
    for (let i = 0; i < 200 && previews < 2; i++) await delay(1);
    assert.ok(previews >= 2, 'reached the selected route');
  };
  return {
    controller,
    leases,
    directory,
    start,
    waiting,
    complete: () => complete(),
    admitted: () => admitted,
    resets: () => resets,
  };
}

test('native and unbudgeted API admission do not wait for history maintenance', async () => {
  for (const gateway of [undefined, 'api'] as const) {
    const f = admissionFixture(gateway);
    await Promise.race([
      assert.rejects(f.start(), /admission-reached/),
      delay(1000).then(() => assert.fail('unbudgeted route waited for historical usage')),
    ]);
    assert.equal(f.admitted(), 1);
    assert.equal(f.resets(), 1);
    assert.equal(Reflect.get(f.controller, 'usageHistoryComplete'), false);
    f.complete();
    await assert.rejects(f.start(), /admission-reached/);
    assert.equal(f.admitted(), 2, 'failed historical maintenance does not block an unbudgeted route');
  }
});

test('budgeted API admission waits, fails closed, and rechecks cancellation and leases', async () => {
  const f = admissionFixture('api', true);
  const pending = f.start();
  await f.waiting();
  assert.equal(f.admitted(), 0);
  Reflect.set(f.controller, 'usageHistoryComplete', true);
  f.complete();
  await assert.rejects(pending, /admission-reached/);
  assert.equal(f.resets(), 1, 'history completion must not replay automatic reset');
  Reflect.set(f.controller, 'usageHistoryComplete', false);
  await assert.rejects(f.start(), /历史用量回填未完成/);

  const cancelled = admissionFixture('api', true);
  const abort = new AbortController();
  const starting = cancelled.start(abort.signal);
  await cancelled.waiting();
  abort.abort(new Error('cancelled-while-awaiting-history'));
  cancelled.complete();
  await assert.rejects(starting, /cancelled-while-awaiting-history/);
  assert.equal(cancelled.admitted(), 0);

  const leased = admissionFixture('api', true);
  const writing = leased.start(undefined, 'workspace-write');
  await leased.waiting();
  const key = process.platform === 'win32' ? leased.directory.toLowerCase() : leased.directory;
  leased.leases.set(key, 'another-workflow');
  Reflect.set(leased.controller, 'usageHistoryComplete', true);
  leased.complete();
  await assert.rejects(writing, /等待执行容量/);
  assert.equal(leased.admitted(), 0);
});

test('budgeted API admission reselects the route and rejects shutdown after waiting', async () => {
  const rerouted = admissionFixture('api', true);
  const switching = rerouted.start();
  await rerouted.waiting();
  Reflect.set(rerouted.controller, 'preview', () => ({ runtimeId: 'replacement', model: 'model' }));
  rerouted.controller.targets = [
    {
      id: 'replacement',
      provider: 'codex',
      environment: 'native',
      enabled: true,
      label: 'Synthetic native',
      command: 'never-execute',
      get args(): never {
        throw new Error('replacement-admission-reached');
      },
    },
  ];
  rerouted.complete();
  await assert.rejects(switching, /replacement-admission-reached/);

  const closing = admissionFixture('api', true);
  const starting = closing.start();
  await closing.waiting();
  Reflect.set(closing.controller, 'closing', true);
  closing.complete();
  await assert.rejects(starting, /应用正在关闭/);
  assert.equal(closing.admitted(), 0);
});

test(
  'owner-scale startup serves state and keeps the event loop responsive for two minutes',
  { timeout: 160_000 },
  async (t) => {
    // Node 24 on the owner's Ultra 9 185H takes about 12ms for this fixed workload.
    const referenceCpuMs = 12;
    assert.equal(startupCpuBenchmark(), -650180488); // Warm JIT before timing.
    const cpuSamplesMs = Array.from({ length: 5 }, () => {
      const started = performance.now();
      const checksum = startupCpuBenchmark();
      const elapsed = performance.now() - started;
      assert.equal(checksum, -650180488);
      return elapsed;
    });
    const cpuBenchmarkMs = [...cpuSamplesMs].sort((a, b) => a - b)[2]!;
    const cpuSpeedFactor = cpuBenchmarkMs / referenceCpuMs;
    const postListenLagLimitMs = Math.min(1500, Math.max(500, 500 * cpuSpeedFactor));
    t.diagnostic(
      JSON.stringify({ cpuSamplesMs, cpuBenchmarkMs, referenceCpuMs, cpuSpeedFactor, postListenLagLimitMs }),
    );
    const root = mkdtempSync(join(tmpdir(), 'startup-scale-'));
    const data = join(root, 'data');
    mkdirSync(data);
    const store = new Store(data);
    const records = new WorkspaceStore(store.db);
    const stamp = '2026-01-01T00:00:00.000Z';
    records.transaction(() => {
      for (let i = 0; i < 180; i++) {
        records.save('project', `p${i}`, `p${i}`, {
          id: `p${i}`,
          name: 'Synthetic',
          path: join(root, `p${i}`),
          createdAt: stamp,
          updatedAt: stamp,
          localMemory: { exportEnabled: false, cliEnabled: false },
        });
        records.save('conversation', `c${i}`, `p${i}`, {
          id: `c${i}`,
          projectId: `p${i}`,
          title: 'Synthetic',
          ...(i === 179 ? { deletedAt: stamp } : {}),
          createdAt: stamp,
          updatedAt: stamp,
        });
      }
      for (let i = 0; i < 800; i++) {
        const workflow: Workflow = {
          id: `w${i}`,
          projectId: `p${i % 180}`,
          conversationId: `c${i % 180}`,
          userMessageId: `m${i}`,
          input: {
            content: 'Synthetic task',
            mode: 'build',
            permissionMode: 'read-only',
            executionPolicy: 'cli-first',
          },
          status: i === 0 ? 'blocked' : 'completed',
          ...(i > 180
            ? { delegation: { parentId: `w${i % 180}`, role: 'worker' as const, requestId: `request-${i}` } }
            : {}),
          phase: 'execute',
          plan: [],
          runIds: [],
          memoryRevision: 0,
          memoryExcerpt: '',
          createdAt: stamp,
          updatedAt: stamp,
        };
        records.save('workflow', workflow.id, workflow.conversationId, workflow);
        records.save('message', `m${i}`, workflow.conversationId, {
          id: `m${i}`,
          conversationId: workflow.conversationId,
          role: 'user',
          content: 'Synthetic',
          workflowId: workflow.id,
          createdAt: stamp,
        });
      }
      for (let i = 0; i < 3000; i++) {
        const run: RunRecord = {
          id: `r${i}`,
          workflowId: `w${i % 800}`,
          prompt: 'Synthetic',
          projectPath: root,
          kind: 'routine',
          status: 'completed',
          startedAt: stamp,
          output: 'Synthetic output'.repeat(50),
          events: [],
          route: { runtimeId: 'synthetic', model: 'synthetic', kind: 'routine', reasons: [], warnings: [] },
        };
        store.saveRun(run);
      }
      store.setConfig('targets', []);
      store.setConfig('nativeCliFactoryMigration', { providers: nativeCliProviders });
    });
    store.close();
    let previous = performance.now();
    let maxLagMs = 0;
    let postListenMaxLagMs = 0;
    const baselineSamplesMs: number[] = [];
    const postListenSamplesMs: number[] = [];
    let samplingBaseline = true;
    let lastServiceTick: number | undefined;
    const monitor = setInterval(() => {
      const now = performance.now();
      maxLagMs = Math.max(maxLagMs, now - previous - 10);
      if (samplingBaseline) baselineSamplesMs.push(Math.max(0, now - previous - 10));
      if (lastServiceTick !== undefined) {
        postListenMaxLagMs = Math.max(postListenMaxLagMs, now - lastServiceTick - 10);
        postListenSamplesMs.push(Math.max(0, now - lastServiceTick - 10));
        lastServiceTick = now;
      }
      previous = now;
    }, 10);
    t.after(() => clearInterval(monitor));
    // Sample this process immediately before construction, with no startup maintenance running.
    await delay(5000);
    samplingBaseline = false;
    const baselineTrimmedMaxLagMs = trimmedMaxLag(baselineSamplesMs);
    const effectiveLagThresholdMs = lagThreshold(baselineTrimmedMaxLagMs, postListenLagLimitMs);
    previous = performance.now();
    const started = performance.now();
    const controller = new Controller(root, data, { readAccountIdentity: () => undefined });
    const controllerMs = performance.now() - started;
    clearInterval(controller.timer);
    assert.ok(controller.targets.every((target) => !target.enabled));
    const workspace = new Workspace(controller, { autoTick: false });
    const constructedMs = performance.now() - started;
    const server = createServer((_req, res) => res.end(JSON.stringify(controller.recentState())));
    t.after(async () => {
      clearInterval(monitor);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await workspace.close();
      await controller.close();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const listeningAt = performance.now();
    lastServiceTick = listeningAt;
    const port = (server.address() as { port: number }).port;
    assert.notEqual(port, 4317);
    const response = await fetch(`http://127.0.0.1:${port}`);
    assert.equal(response.status, 200);
    const state = await response.json();
    assert.equal(state.projects.length, 180);
    const readyMs = performance.now() - started;
    await workspace.startupMaintenanceDone;
    await controller.usageHistoryReady;
    assert.ok(workspace.store.get('migration', 'workflow-follow-ups-v1'));
    assert.ok(workspace.store.get<Workflow>('workflow', 'w0')?.followUp);
    assert.equal(
      workspace.store.get<{ reason: string }>('startup-archive-skip', 'w179')?.reason,
      'conversation-unavailable',
    );
    assert.ok(
      workspace.store.get<Workflow>('workflow', 'w181')?.archivedAt,
      'settled delegated tasks archive in background',
    );
    await delay(Math.max(0, 120_000 - (performance.now() - listeningAt)));
    const postListenTrimmedMaxLagMs = trimmedMaxLag(postListenSamplesMs);
    t.diagnostic(
      JSON.stringify({
        controllerMs,
        constructedMs,
        readyMs,
        maxLagMs,
        postListenMaxLagMs,
        baselineTrimmedMaxLagMs,
        postListenTrimmedMaxLagMs,
        effectiveLagThresholdMs,
        baselineSampleCount: baselineSamplesMs.length,
        postListenSampleCount: postListenSamplesMs.length,
        cpuSpeedFactor,
        postListenLagLimitMs,
        observedMs: performance.now() - listeningAt,
      }),
    );
    assert.ok(readyMs < 3000, `first HTTP state took ${readyMs} ms`);
    assert.ok(
      postListenTrimmedMaxLagMs <= effectiveLagThresholdMs,
      `trimmed maximum post-listen event loop delay ${postListenTrimmedMaxLagMs} ms exceeds ${effectiveLagThresholdMs} ms (baseline ${baselineTrimmedMaxLagMs} ms + 400 ms, absolute limit ${postListenLagLimitMs} ms, CPU factor ${cpuSpeedFactor})`,
    );
  },
);
