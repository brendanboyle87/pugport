import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { piAdapter } from '../src/server/adapters/pi.ts';
import type { ExecuteContext, RuntimeTarget } from '../src/shared/types.ts';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { Controller } from '../src/server/controller.ts';
import { IdleNativeSessionSlot } from '../src/server/idle-native-session.ts';
import { VerificationReceipts } from '../src/server/verification-receipts.ts';
import { Store } from '../src/server/store.ts';
import { Workspace } from '../src/server/workspace.ts';
import { WorkspaceStore } from '../src/server/workspace-store.ts';
import { UsageLedger } from '../src/server/usage.ts';
import { RequestLedger } from '../src/server/usage-requests.ts';
import { ToolOperationIndex } from '../src/server/tool-operations.ts';
import { QuotaHistory } from '../src/server/quota-history.ts';
import { JudgmentStore } from '../src/server/judgment-store.ts';
import type { RunRecord, Workflow } from '../src/shared/types.ts';
import { runOutputTail } from '../src/shared/run-output.ts';
import { listenForFetch } from './helpers/fetch-port.ts';

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'pug-state-perf-'));
  const store = new Store(join(directory, 'data'));
  t.after(() => {
    controller.flushBroadcast();
    if (store.db.isOpen) {
      controller.requestLedger.flush();
      controller.toolOperations.flush();
      store.close();
    }
    const safe = resolve(directory);
    assert.ok(safe.startsWith(resolve(tmpdir()) + sep) && basename(safe).startsWith('pug-state-perf-'));
    rmSync(safe, { recursive: true, force: true });
  });
  const records = new WorkspaceStore(store.db);
  const usage = new UsageLedger(store.db);
  const quotaHistory = new QuotaHistory(store.db);
  const judgments = new JudgmentStore(store.db);
  // Real state paths, without constructor probes, real credentials or background jobs.
  const workspace = Object.assign(Object.create(Workspace.prototype), {
    store: records,
    folderAvailability: new Map(),
    tastes: { list: () => [] },
  }) as Workspace;
  const controller = Object.assign(Object.setPrototypeOf(new EventEmitter(), Controller.prototype), {
    root: directory,
    dataDir: directory,
    store,
    usage,
    requestLedger: new RequestLedger(store.db),
    toolOperations: new ToolOperationIndex(store.db),
    quotaHistory,
    judgments,
    targets: [],
    snapshots: [],
    settings: {},
    active: new Map(),
    idleClaudeSession: new IdleNativeSessionSlot(),
    verificationReceipts: new VerificationReceipts(async () => {
      throw new Error('State fixtures must not execute verification commands');
    }),
    webSearch: { close: async () => {} },
    laya: { close: async () => {} },
    idleDiscoveries: 0,
    idleDiscoveryQueue: new Map(),
    approvals: new Map(),
    bridgeTokens: new Map(),
    watchedLogins: new Map(),
    autoResetCards: { records: {} },
    sandboxHealth: { snapshot: () => ({}) },
    inbox: { summary: () => ({ open: [], unread: 0, attention: 0 }) },
    jevConfiguration: { configured: false, enabled: false, status: 'not-configured', note: 'synthetic' },
    workspaceState: () => workspace.state(),
  }) as Controller;
  Object.assign(workspace, { controller });
  return { directory, store, records, usage, quotaHistory, judgments, workspace, controller };
}

test('owner-scale HTTP state regression', async (t) => {
  const { directory, store, records, controller, workspace, usage } = fixture(t);
  const stamp = '2026-01-01T00:00:00.000Z';
  records.transaction(() => {
    for (let i = 0; i < 180; i++)
      records.save('project', `p${i}`, '', {
        id: `p${i}`,
        name: `Project ${i}`,
        path: join(directory, `p${i}`),
        createdAt: stamp,
        updatedAt: stamp,
      });
    for (let i = 0; i < 53; i++)
      records.save('conversation', `c${i}`, '', {
        id: `c${i}`,
        projectId: `p${i}`,
        title: `Conversation ${i}`,
        createdAt: stamp,
        updatedAt: stamp,
      });
    for (let i = 0; i < 800; i++)
      records.save('workflow', `w${i}`, `c${i % 53}`, {
        id: `w${i}`,
        projectId: `p${i % 180}`,
        conversationId: `c${i % 53}`,
        userMessageId: `m${i}`,
        input: { content: 'synthetic '.repeat(600), mode: 'build' },
        status: 'completed',
        phase: 'execute',
        plan: [],
        runIds: [`r${i}`],
        memoryRevision: 0,
        memoryExcerpt: '',
        createdAt: stamp,
        updatedAt: stamp,
      });
    for (let i = 0; i < 3000; i++) {
      const run: RunRecord = {
        id: `r${i}`,
        workflowId: `w${i % 800}`,
        prompt: 'synthetic',
        projectPath: directory,
        kind: 'routine',
        status: 'completed',
        startedAt: new Date(Date.parse(stamp) + i * 1000).toISOString(),
        output: 'x'.repeat(8000),
        events: [],
        route: { runtimeId: 'synthetic', model: 'synthetic', kind: 'routine', reasons: [], warnings: [] },
      };
      store.saveRun(run);
      usage.begin(run, { id: 'synthetic', provider: 'pi', label: 'synthetic' }, 'subscription');
    }
  });
  const sections: Record<string, number> = {};
  for (const [object, key] of [
    [workspace, 'state'],
    [store, 'runSummaries'],
    [usage, 'report'],
  ] as const) {
    const original = object[key as keyof typeof object] as (...args: unknown[]) => unknown;
    t.mock.method(object, key as never, function (this: unknown, ...args: unknown[]) {
      const at = performance.now();
      try {
        return original.apply(this, args);
      } finally {
        sections[key] = (sections[key] ?? 0) + performance.now() - at;
      }
    });
  }
  const at = performance.now();
  const state = controller.recentState();
  const cold = performance.now() - at;
  const serializedAt = performance.now();
  const json = JSON.stringify(state);
  const serialization = performance.now() - serializedAt;
  await delay(300);
  const warmAt = performance.now();
  controller.recentState();
  const warm = performance.now() - warmAt;
  t.diagnostic(JSON.stringify({ cold, warm, serialization, bytes: Buffer.byteLength(json), sections }));
  assert.equal(state.projects!.length, 180);
  assert.equal(state.workflows!.length, 200, 'existing settled workflow window');
  assert.equal(state.runs.length, 200);
  assert.equal(state.usage!.totals.runs, 3000);
  const history = workspace.conversation('c0');
  assert.ok(
    history.usageRuns.some((run) => run.runId === 'r0'),
    'opening history restores old task usage',
  );
  const historyIds = new Set(history.workflows.flatMap((workflow) => workflow.runIds));
  assert.ok(history.usageRuns.every((run) => historyIds.has(run.runId)));
  const page = store.runSummaryPage(0, 200);
  const older = store.runSummaryPage(page.nextOffset!, 200);
  assert.equal(new Set([...page.runs, ...older.runs].map((run) => run.id)).size, 400);
  assert.equal(store.runSummaryPage(2999).nextOffset, undefined);
  assert.equal(store.runSummaryPage(2999).runs[0]!.id, 'r0');
  assert.throws(() => store.runSummaryPage(0, 201));
  assert.ok(cold < 1500, `cold ${cold} ms`);
  assert.ok(warm < 200, `warm ${warm} ms`);
  assert.equal(controller.recentState(), state, 'snapshot survives the old 250 ms expiry');
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(controller.recentStateJson());
  });
  await listenForFetch(server);
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/state`;
  for (let i = 0; i < 2; i++) {
    const start = performance.now();
    const body = await (await fetch(url)).text();
    const elapsed = performance.now() - start;
    assert.deepEqual(JSON.parse(body), JSON.parse(json));
    assert.ok(elapsed < 200, `HTTP ${elapsed} ms`);
    t.diagnostic(`HTTP ${i}: ${elapsed} ms`);
  }
  const before = controller.recentStateJson();
  controller.settings.keepAwake = false;
  controller.broadcast();
  assert.notEqual(controller.recentStateJson(), before);
  let revision = '1';
  controller.workspaceStateRevision = () => revision;
  const firstRevision = controller.recentState();
  revision = '2';
  assert.notEqual(controller.recentState(), firstRevision);
  records.transaction(() => {
    for (let i = 0; i < 800; i++) {
      const workflow = records.get<Workflow>('workflow', `w${i}`)!;
      records.save('workflow', workflow.id, workflow.conversationId, { ...workflow, status: 'queued' });
    }
  });
  controller.broadcast();
  const liveAt = performance.now();
  const live = controller.recentState();
  const liveMs = performance.now() - liveAt;
  assert.equal(live.workflows!.length, 800, 'all live workflows remain visible beyond the history window');
  assert.ok(liveMs < 1500, `800 visible workflows: ${liveMs} ms`);
  t.diagnostic(`800 visible workflows: ${liveMs} ms`);
});

test('state cache periodically refreshes observations without a mutation signal', (t) => {
  const { controller } = fixture(t);
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const before = controller.recentState();
  now = 29_999;
  assert.equal(controller.recentState(), before);
  now = 30_000;
  assert.notEqual(controller.recentState(), before);
});

test(
  'synthetic full state stays small and fast at owner-sized volumes',
  { skip: !process.env.PUGPORT_PERF },
  async (t) => {
    const { directory, store, records, usage, quotaHistory, judgments, workspace, controller } = fixture(t);
    const stamp = '2026-01-01T00:00:00.000Z';
    const input = 'synthetic input '.repeat(410).slice(0, 6144);
    const insertAudit = store.db.prepare('INSERT INTO run_audit_events(run_id,seq,value) VALUES(?,?,?)');
    records.transaction(() => {
      for (let i = 0; i < 35; i++) {
        const path = join(directory, `project-${i}`);
        mkdirSync(path);
        records.save('project', `p${i}`, `p${i}`, {
          id: `p${i}`,
          name: `Project ${i}`,
          path,
          createdAt: stamp,
          updatedAt: stamp,
        });
      }
      for (let i = 0; i < 68; i++)
        records.save('conversation', `c${i}`, `p${i}`, {
          id: `c${i}`,
          projectId: `p${i % 35}`,
          title: `Conversation ${i}`,
          createdAt: stamp,
          updatedAt: stamp,
        });
      for (let i = 0; i < 300; i++) {
        const workflow: Workflow = {
          id: `w${i}`,
          projectId: `p${i % 35}`,
          conversationId: `c${i % 68}`,
          userMessageId: `m${i}`,
          input: { content: input, mode: 'build', permissionMode: 'read-only', executionPolicy: 'cli-first' },
          status: 'completed',
          phase: 'execute',
          plan: [
            {
              id: 'step',
              title: 'Synthetic step',
              instruction: input,
              kind: 'routine',
              status: 'completed',
              transport: 'auto',
              dependsOn: [],
              runIds: [`r${i}`],
            },
          ],
          runIds: [`r${i}`],
          memoryRevision: 0,
          memoryExcerpt: '',
          createdAt: stamp,
          updatedAt: stamp,
        };
        if (i < 253) records.save('workflow', workflow.id, workflow.conversationId, workflow);
        const run: RunRecord = {
          id: `r${i}`,
          workflowId: `w${i % 253}`,
          prompt: input,
          projectPath: join(directory, `project-${i % 17}`),
          kind: 'routine',
          status: 'completed',
          startedAt: new Date(Date.parse(stamp) + i * 1000).toISOString(),
          output: 'o'.repeat(i >= 290 ? 1_000_000 : i >= 100 ? 120_000 : 20_000),
          events: Array.from({ length: i >= 290 ? 1000 : 100 }, (_, seq) => ({
            type: 'text',
            at: stamp,
            seq: 1167 - (i >= 290 ? 1000 : 100) + seq + 1,
            text: 'e'.repeat(i >= 290 ? 1000 + (i - 290) * 500 : i >= 100 ? 400 : 100),
          })),
          route: { runtimeId: 'synthetic', model: 'synthetic', kind: 'routine', reasons: [], warnings: [] },
        };
        store.saveRun(run);
        usage.begin(run, { id: 'synthetic', provider: 'pi', label: 'Synthetic' }, 'subscription');
        for (let seq = 1; seq <= 1167; seq++)
          insertAudit.run(run.id, seq, JSON.stringify({ type: 'text', seq, at: stamp, text: 'a'.repeat(440) }));
      }
      for (let i = 0; i < 4136; i++)
        records.save('message', `m${i}`, `c${i % 68}`, {
          id: `m${i}`,
          conversationId: `c${i % 68}`,
          role: 'user',
          content: input.slice(0, 2400),
          createdAt: stamp,
        });
    });
    t.diagnostic(
      JSON.stringify({
        sizes: ['runs', 'run_audit_events', 'workspace_records'].map((table) => ({
          table,
          ...store.db
            .prepare(
              `SELECT count(*) AS rows, sum(length(value)) AS bytes, max(length(value)) AS largest FROM ${table}`,
            )
            .get(),
        })),
      }),
    );
    // Exercise the one-time migration too, rather than only a freshly populated summary table.
    store.db.exec(`DROP TRIGGER IF EXISTS runs_summary_insert; DROP TRIGGER IF EXISTS runs_summary_update;
    DROP TRIGGER runs_summary_delete; DROP TABLE run_summaries;`);
    const migrationAt = performance.now();
    const reopened = new Store(join(directory, 'data'));
    reopened.close();
    t.diagnostic(JSON.stringify({ legacySummaryBackfillMs: performance.now() - migrationAt }));
    const times: Record<string, number> = {};
    function measure(object: object, key: string, label: string) {
      const original = (object as Record<string, (...args: unknown[]) => unknown>)[key]!;
      t.mock.method(object, key as never, function (this: unknown, ...args: unknown[]) {
        const start = performance.now();
        try {
          return original.apply(this, args);
        } finally {
          times[label] = (times[label] ?? 0) + performance.now() - start;
        }
      });
    }
    measure(workspace, 'state', 'workspace');
    for (const key of ['projects', 'conversations', 'visibleWorkflows', 'recentMessages']) measure(records, key, key);
    measure(store, 'runSummaries', 'runs');
    measure(usage, 'report', 'usage');
    measure(quotaHistory, 'summary', 'quota');
    measure(judgments, 'report', 'judgments');
    const totals: number[] = [];
    let bytes = 0;
    for (let i = 0; i < 3; i++) {
      for (const key of Object.keys(times)) times[key] = 0;
      const start = performance.now();
      const state = controller.state();
      const built = performance.now();
      const json = JSON.stringify(state);
      bytes = Buffer.byteLength(json);
      totals.push(built - start);
      t.diagnostic(
        JSON.stringify({
          sample: i,
          ...times,
          other:
            built -
            start -
            (times.workspace ?? 0) -
            (times.runs ?? 0) -
            (times.usage ?? 0) -
            (times.quota ?? 0) -
            (times.judgments ?? 0),
          state: built - start,
          stringify: performance.now() - built,
          bytes,
        }),
      );
      assert.ok(state.workflows!.length >= 200);
      assert.equal(state.runs.length, 200);
    }
    const server = createServer((req, res) => {
      const value =
        req.url === '/api/session'
          ? { token: 'synthetic' }
          : req.url === '/api/state'
            ? (workspace.refreshProjectFolders(), controller.recentState())
            : workspace.conversation('c37');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(value));
    });
    await listenForFetch(server);
    t.after(() => {
      server.closeAllConnections();
      server.close();
    });
    const address = server.address() as { port: number };
    const endpoints: Record<string, number[]> = {};
    for (const path of ['/api/state', '/api/conversations/c37', '/api/session']) {
      endpoints[path] = [];
      for (let i = 0; i < 3; i++) {
        await delay(260);
        const start = performance.now();
        const response = await fetch(`http://127.0.0.1:${address.port}${path}`);
        const body = await response.text();
        endpoints[path].push(performance.now() - start);
        t.diagnostic(JSON.stringify({ path, ms: endpoints[path].at(-1), bytes: Buffer.byteLength(body) }));
      }
    }
    await t.test('synthetic stream stays responsive', { skip: !process.env.PUGPORT_PERF }, (t) =>
      streamBenchmark(t, controller, store),
    );
    assert.ok(Math.max(...totals) < 300, `state target: ${totals}`);
    assert.ok(Math.max(...endpoints['/api/conversations/c37']!) < 300, 'conversation target');
    assert.ok(bytes < 3_000_000, `state is ${bytes} bytes, target < 3 MB`);
    const summary = controller.state().workflows![0]!;
    assert.ok(summary.input.content.length <= 301);
    const full = records.get<Workflow>('workflow', summary.id)!;
    assert.equal(full.input.content, input);
    assert.equal(full.plan[0]!.instruction, input);
    assert.equal(summary.plan[0]!.title, full.plan[0]!.title);
    assert.deepEqual(summary.plan[0]!.runIds, full.plan[0]!.runIds);
    for (const status of ['queued', 'waiting-confirmation', 'running'] as const) {
      records.save('workflow', full.id, full.conversationId, { ...full, status });
      assert.equal(controller.state().workflows!.find((w) => w.id === full.id)!.input.content, input);
    }
    assert.equal(store.run('r0')!.output.length, 20000);
    assert.equal(store.run('r0')!.events.length, 1167);
  },
);

async function streamBenchmark(t: TestContext, controller: Controller, store: Store) {
  const target: RuntimeTarget = {
    id: 'synthetic',
    provider: 'pi',
    label: 'Synthetic',
    command: 'unused',
    enabled: false,
    environment: 'native',
  };
  const contexts: ExecuteContext[] = [];
  let allEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    allEntered = resolve;
  });
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  t.mock.method(piAdapter, 'execute', async (context: ExecuteContext) => {
    contexts.push(context);
    if (contexts.length === 5) allEntered();
    await gate;
    return { output: '', exitCode: 0 };
  });
  Object.assign(controller, {
    bridgeTokens: new Map(),
    clock: Date.now,
    freeHealth: { failure() {} },
    cooldown: { failure() {}, clear() {} },
    accountHealth: { failure() {} },
    diagnosis: { check() {} },
    refresh: async () => {},
  });
  const executions: Promise<void>[] = [];
  for (let i = 0; i < 5; i++) {
    const run = store.storedRun(`r${295 + i}`)!;
    run.status = 'running';
    store.saveRun(run);
    const abort = new AbortController();
    (controller as unknown as { active: Map<string, unknown> }).active.set(run.id, { run, abort });
    executions.push(
      controller.execute(
        run,
        { prompt: 'synthetic', projectPath: controller.root, kind: 'routine', permissionMode: 'read-only' },
        target,
        abort,
      ),
    );
  }
  await Promise.race([
    entered,
    Promise.all(executions).then(() => {
      throw new Error('Executions ended before the adapter entered');
    }),
  ]);
  assert.equal(contexts.length, 5, 'exercise the real execute callback');
  const saves = t.mock.method(store, 'saveRun');
  const countAudit = () =>
    (store.db.prepare('SELECT count(*) AS count FROM run_audit_events').get() as { count: number }).count;
  const auditBefore = countAudit();
  let auditMs = 0;
  const append = store.appendRunAuditEvent.bind(store);
  t.mock.method(store, 'appendRunAuditEvent', (...args: Parameters<Store['appendRunAuditEvent']>) => {
    const at = performance.now();
    append(...args);
    auditMs = performance.now() - at;
  });
  const slowEvents: { total: number; audit: number }[] = [];
  const eventMs: number[] = [];
  let lag = 0,
    previous = performance.now();
  const monitor = setInterval(() => {
    const at = performance.now();
    lag = Math.max(lag, at - previous - 20);
    previous = at;
  }, 20);
  const listener = (state: unknown) => {
    JSON.stringify(state);
  };
  const deltaListener = (value: unknown) => {
    JSON.stringify(value);
  };
  controller.on('state', listener);
  controller.on('run', deltaListener);
  const began = performance.now();
  try {
    for (let tick = 0; tick < 250; tick++) {
      await delay(Math.max(0, began + tick * 20 - performance.now()));
      for (const context of contexts) {
        const at = performance.now();
        context.emit({ type: 'text', at: new Date().toISOString(), text: 'synthetic stream '.repeat(8) });
        const total = performance.now() - at;
        eventMs.push(total);
        if (total >= 5) slowEvents.push({ total, audit: auditMs });
      }
      controller.broadcast();
    }
    await delay(50);
  } finally {
    clearInterval(monitor);
    controller.off('state', listener);
    controller.off('run', deltaListener);
    finish();
    await Promise.all(executions);
  }
  eventMs.sort((a, b) => a - b);
  t.diagnostic(
    JSON.stringify({
      stream: {
        events: eventMs.length,
        elapsed: performance.now() - began,
        mean: eventMs.reduce((a, b) => a + b, 0) / eventMs.length,
        p95: eventMs[Math.floor(eventMs.length * 0.95)],
        max: eventMs.at(-1),
        lag,
        saves: saves.mock.callCount(),
        slowEvents: slowEvents.sort((a, b) => b.total - a.total).slice(0, 5),
      },
    }),
  );
  assert.ok(eventMs.at(-1)! < 5, `event target: ${eventMs.at(-1)}`);
  assert.ok(lag < 500, `lag target: ${lag}`);
  assert.ok(countAudit() >= auditBefore + eventMs.length, 'every streamed event reaches the durable audit table');
}

test('50 publishes coalesce, GET shares the window, deltas stay immediate and shutdown flushes', async (t) => {
  const { controller, workspace, records } = fixture(t);
  let clock = 0;
  t.mock.method(performance, 'now', () => clock);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const builds = t.mock.method(controller, 'state');
  const received: number[] = [];
  controller.on('state', (state) => received.push(state.conversationFolders[0].revision));
  let deltas = 0;
  controller.on('run', () => deltas++);
  const publish = (revision: number) => {
    records.save('conversation-folder', 'synthetic', '', { id: 'synthetic', revision });
    (workspace as unknown as { publish(): void }).publish();
  };
  for (let i = 1; i <= 50; i++) publish(i);
  controller.emit('run', { runId: 'synthetic', event: { type: 'text', text: 'immediate' } });
  assert.equal(deltas, 1);
  assert.equal(builds.mock.callCount(), 0);
  const first = controller.recentState();
  assert.equal(controller.recentState(), first);
  assert.equal(builds.mock.callCount(), 1);
  // This change arrives after the GET; it must be included in the trailing broadcast.
  clock = 100;
  t.mock.timers.tick(100);
  publish(51);
  const updated = controller.recentState();
  assert.notEqual(updated, first);
  assert.deepEqual(updated.conversationFolders, [{ id: 'synthetic', revision: 51 }]);
  assert.equal(controller.recentState(), updated, 'unchanged state still shares the snapshot');
  clock = 249;
  t.mock.timers.tick(149);
  assert.deepEqual(received, []);
  clock = 250;
  t.mock.timers.tick(1);
  assert.deepEqual(received, [51]);
  assert.equal(builds.mock.callCount(), 2);
  publish(52);
  controller.recentState();
  clock = 500;
  t.mock.timers.tick(250);
  assert.deepEqual(received, [51, 52]);
  // Even if GET consumed the dirty state, the pending notification must still be delivered.
  publish(53);
  controller.state();
  controller.flushBroadcast();
  assert.deepEqual(received, [51, 52, 53]);
  publish(54);
  await controller.close();
  assert.deepEqual(received, [51, 52, 53, 54]);
  clock = 800;
  t.mock.timers.tick(300);
  assert.deepEqual(received, [51, 52, 53, 54]);
});

test('slow state diagnostics report sections and log at most once per minute', (t) => {
  const { controller } = fixture(t);
  let clock = 0;
  t.mock.method(performance, 'now', () => clock);
  const logs = t.mock.method(console, 'warn', () => {});
  Object.assign(controller, {
    workspaceState: () => {
      clock += 501;
      return {};
    },
  });
  controller.state();
  assert.equal(logs.mock.callCount(), 1);
  const line = logs.mock.calls[0]!.arguments[0] as string;
  assert.ok(line.startsWith('[slow-state] '));
  const report = JSON.parse(line.slice('[slow-state] '.length));
  assert.equal(report.total, 501);
  assert.equal(report.sections.workspace, 501);
  clock += 10000;
  controller.state();
  assert.equal(logs.mock.callCount(), 1);
  clock += 60000;
  controller.state();
  assert.equal(logs.mock.callCount(), 2);
  Object.assign(controller, { workspaceState: () => ({}) });
  clock += 60000;
  controller.state();
  assert.equal(logs.mock.callCount(), 2, 'fast builds do not log');
});

test('stream persistence waits one second, archives each event and flushes status changes and completion', async (t) => {
  const { controller, store, directory } = fixture(t);
  const run: RunRecord = {
    id: 'stream-save',
    prompt: 'synthetic',
    projectPath: directory,
    kind: 'routine',
    status: 'running',
    startedAt: '2026-01-01T00:00:00.000Z',
    output: 'initial',
    events: [],
    route: { runtimeId: 'synthetic', model: 'synthetic', kind: 'routine', reasons: [], warnings: [] },
  };
  const target: RuntimeTarget = {
    id: 'synthetic',
    provider: 'pi',
    label: 'Synthetic',
    command: 'unused',
    enabled: false,
    environment: 'native',
  };
  let context!: ExecuteContext;
  let adapterEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    adapterEntered = resolve;
  });
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  t.mock.method(piAdapter, 'execute', async (value: ExecuteContext) => {
    context = value;
    adapterEntered();
    await gate;
    return { output: '', exitCode: 0 };
  });
  Object.assign(controller, {
    bridgeTokens: new Map(),
    clock: Date.now,
    freeHealth: { failure() {} },
    cooldown: { failure() {}, clear() {} },
    accountHealth: { failure() {} },
    diagnosis: { check() {} },
    refresh: async () => {},
  });
  const abort = new AbortController();
  Object.assign(controller, { active: new Map([[run.id, { run, abort }]]) });
  store.saveRun(run);
  t.mock.method(performance, 'now', () => 0);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const saves = t.mock.method(store, 'saveRun');
  const execution = controller.execute(
    run,
    { prompt: 'synthetic', projectPath: directory, kind: 'routine', permissionMode: 'read-only' },
    target,
    abort,
  );
  try {
    await Promise.race([
      entered,
      execution.then(() => {
        throw new Error('Execution ended before the adapter entered');
      }),
    ]);
    const snapshot = controller.recentState();
    for (const text of [' one', ' two', ' three']) context.emit({ type: 'text', at: run.startedAt, text });
    assert.equal(run.output, 'initial one two three', 'detail reads see every buffered delta');
    assert.equal(controller.recentState().runs[0]!.output, run.output);
    assert.equal(snapshot.runs[0]!.output, 'initial');
    assert.equal(store.storedRun(run.id)!.output, 'initial');
    assert.equal(saves.mock.callCount(), 0);
    assert.equal(store.run(run.id)!.events.filter((e) => e.type === 'text').length, 3);
    t.mock.timers.tick(999);
    assert.equal(saves.mock.callCount(), 0);
    t.mock.timers.tick(1);
    t.mock.timers.tick(1); // The persistence queue yields between large run writes.
    assert.equal(saves.mock.callCount(), 1);
    assert.equal(store.storedRun(run.id)!.output, run.output);
    context.emit({ type: 'session', at: run.startedAt, data: { sessionId: 'new-native-session' } });
    assert.equal(store.storedRun(run.id)!.nativeSessionId, 'new-native-session');
    assert.equal(saves.mock.callCount(), 2, 'a changed session is saved immediately');
    context.emit({ type: 'session', at: run.startedAt, data: { sessionId: 'new-native-session' } });
    assert.equal(saves.mock.callCount(), 2, 'the same session does not force another save');
    const approval = controller.approve(run, 'synthetic', 'synthetic', abort.signal);
    assert.equal(store.storedRun(run.id)!.status, 'waiting-approval');
    const [id] = controller.state().approvals.map((a) => a.id);
    controller.answerApproval(id!, true);
    assert.equal(await approval, true);
    assert.equal(store.storedRun(run.id)!.status, 'running');
    context.emit({ type: 'text', at: run.startedAt, text: ' final' });
  } finally {
    finish();
    await execution;
  }
  assert.equal(store.storedRun(run.id)!.status, 'completed');
  assert.ok(store.storedRun(run.id)!.output.endsWith(' final'));
  assert.equal(Object.getOwnPropertyDescriptor(run, 'output')!.get, undefined, 'release the streaming closure');
  const count = saves.mock.callCount();
  t.mock.timers.tick(1000);
  assert.equal(saves.mock.callCount(), count, 'completion cancels deferred saves');
  for (const text of ['短句', '界🙂'.repeat(100), 'a'.repeat(10000)])
    assert.equal(runOutputTail(text, 20), text.slice(-20));
});

test('workspace cache invalidates after saves, direct SQL, rollback and folder changes', (t) => {
  const { workspace, records, directory } = fixture(t);
  records.save('project', 'p', 'p', { id: 'p', path: join(directory, 'later'), name: 'Synthetic' });
  const first = workspace.state();
  assert.equal(workspace.state().conversationMessages, first.conversationMessages);
  assert.equal(first.projects![0]!.folderMissing, true);
  mkdirSync(join(directory, 'later'));
  workspace.refreshProjectFolders();
  assert.equal(workspace.state().projects![0]!.folderMissing, false);
  records.save('conversation-folder', 'f', '', { id: 'f', name: 'Before' });
  assert.equal(workspace.state().conversationFolders![0]!.name, 'Before');
  records.db
    .prepare("UPDATE workspace_records SET value=json_set(value,'$.name','After') WHERE kind='conversation-folder'")
    .run();
  assert.equal(workspace.state().conversationFolders![0]!.name, 'After');
  assert.throws(() =>
    records.transaction(() => {
      records.save('conversation-folder', 'f', '', { id: 'f', name: 'Rolled back' });
      assert.equal(workspace.state().conversationFolders![0]!.name, 'Rolled back');
      throw new Error('synthetic rollback');
    }),
  );
  assert.equal(workspace.state().conversationFolders![0]!.name, 'After');
  const other = new DatabaseSync(join(directory, 'data', 'studio.sqlite'));
  try {
    other
      .prepare(
        "UPDATE workspace_records SET value=json_set(value,'$.name','External') WHERE kind='conversation-folder'",
      )
      .run();
    assert.equal(workspace.state().conversationFolders![0]!.name, 'External');
  } finally {
    other.close();
  }
});

test('shutdown saves the latest output even if an adapter misses the abort deadline and cancels queued writes', async (t) => {
  const { controller, store, directory } = fixture(t);
  const run: RunRecord = {
    id: 'shutdown',
    prompt: 'synthetic',
    projectPath: directory,
    kind: 'routine',
    status: 'running',
    startedAt: '2026-01-01T00:00:00.000Z',
    output: 'initial',
    events: [],
    route: { runtimeId: 'synthetic', model: 'synthetic', kind: 'routine', reasons: [], warnings: [] },
  };
  store.saveRun(run);
  run.output = 'last synthetic output';
  const abort = new AbortController();
  Object.assign(controller, { active: new Map([[run.id, { run, abort }]]) });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let clock = 0;
  t.mock.method(Date, 'now', () => clock);
  const saves = t.mock.method(store, 'saveRun');
  (controller as unknown as { queueRunSave(run: RunRecord, saved: () => void): void }).queueRunSave(run, () => {});
  const closing = controller.close();
  assert.equal(saves.mock.callCount(), 1, 'save before the first shutdown wait');
  clock = 10001;
  t.mock.timers.tick(100);
  await closing;
  assert.equal(abort.signal.aborted, true);
  const savedAtClose = saves.mock.callCount();
  t.mock.timers.tick(2000);
  assert.equal(saves.mock.callCount(), savedAtClose, 'no queued write after the database closes');
  const reopened = new Store(join(directory, 'data'));
  try {
    assert.equal(reopened.storedRun(run.id)!.output, run.output);
  } finally {
    reopened.close();
  }
});

test('continuous mutations keep GET fresh while broadcasts still coalesce to four per second', (t) => {
  const { controller, records } = fixture(t);
  let clock = 0;
  t.mock.method(performance, 'now', () => clock);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const builds = t.mock.method(controller, 'state');
  let received = 0;
  controller.on('state', () => received++);
  for (let i = 0; i < 100; i++) {
    records.save('conversation-folder', 'synthetic', '', { id: 'synthetic', revision: i });
    controller.broadcast();
    const snapshot = controller.recentState();
    assert.deepEqual(snapshot.conversationFolders, [{ id: 'synthetic', revision: i }]);
    assert.equal(controller.recentState(), snapshot);
    clock += 10;
    t.mock.timers.tick(10);
  }
  assert.equal(builds.mock.callCount(), 100, 'one build per mutation; repeated unchanged GETs reuse it');
  assert.equal(received, 4);
});

test('live runs retain output and new run events invalidate a pending snapshot', (t) => {
  const { controller, store, directory } = fixture(t);
  t.mock.method(performance, 'now', () => 0);
  const run: RunRecord = {
    id: 'live',
    prompt: 'Synthetic live request',
    projectPath: directory,
    kind: 'routine',
    status: 'running',
    startedAt: '2026-01-01T00:00:00.000Z',
    output: 'live '.repeat(1000),
    reasoning: 'synthetic reasoning',
    events: [],
    route: { runtimeId: 'synthetic', model: 'synthetic', kind: 'routine', reasons: [], warnings: [] },
  };
  store.saveRun(run);
  Object.assign(controller, { active: new Map([[run.id, { run }]]) });
  controller.broadcast();
  const first = controller.recentState();
  assert.equal(first.runs[0]!.output, run.output);
  assert.equal(first.runs[0]!.reasoning, run.reasoning);
  let deltas = 0;
  controller.on('run', () => deltas++);
  controller.recordRunEvent(run.id, { type: 'status', at: run.startedAt, text: 'New synthetic observation' });
  assert.equal(deltas, 1);
  assert.equal(first.runs[0]!.events.length, 0);
  assert.equal(controller.recentState().runs[0]!.events.length, 1, 'GET must not undo delivered deltas');
  // Workspace paths also emit directly, bypassing recordRunEvent and the adapter callback.
  run.output += 'direct delta';
  controller.once('run', () => {
    assert.equal(controller.recentState().runs[0]!.output, run.output, 'invalidate before notifying run listeners');
  });
  controller.emit('run', { runId: run.id, event: { type: 'text', at: run.startedAt, text: 'direct delta' } });
  let delivered: RunRecord | undefined;
  controller.on('state', (state) => {
    delivered = state.runs[0];
  });
  controller.flushBroadcast();
  assert.equal(delivered!.events.length, 1);
});
