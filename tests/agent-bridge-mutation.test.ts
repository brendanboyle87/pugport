import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test, type TestContext } from 'node:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { AgentBridge } from '../src/server/agent-bridge.ts';
import { Controller } from '../src/server/controller.ts';
import { extensions } from '../src/server/extensions.ts';
import type { Workspace } from '../src/server/workspace.ts';
import type { RunEvent, RunRecord, RuntimeTarget, Settings, Workflow } from '../src/shared/types.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
const call = (name: string, args: Record<string, unknown> = {}, id = 1) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name, arguments: args },
});
const result = (response: { body?: unknown }) => (response.body as any).result;

function fixture(t: TestContext) {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'pugport-bridge-mutation-')));
  // Allocate the real Controller methods and state without starting timers, a database, or native processes.
  const controller = new EventEmitter() as unknown as Controller;
  Object.setPrototypeOf(controller, Controller.prototype);
  controller.active = new Map();
  controller.machineReading = () => ({
    totalBytes: 16 * 1024 ** 3,
    cpus: 8,
    availableMemoryBytes: 8 * 1024 ** 3,
    cpuPercent: 20,
  });
  controller.settings = { maxConcurrentRuns: 1, maxRunsPerAccount: 0 } as Settings;
  controller.targets = [
    { id: 'parent-runtime', provider: 'codex', label: 'Parent', enabled: true },
    { id: 'sibling-runtime', provider: 'claude', label: 'Sibling', enabled: true },
  ] as RuntimeTarget[];
  const tokens = new Map();
  const auditEvents: { runId: string; event: RunEvent }[] = [];
  const storedRuns = new Map<string, RunRecord>();
  const internals = controller as unknown as { resumeExecutions(): void };
  Object.assign(controller, {
    store: {
      // An empty database: no workspace records, so no workflow here is a swarm member.
      db: { prepare: () => ({ get: () => undefined, all: () => [] }) },
      appendRunAuditEvent: (runId: string, event: RunEvent) => {
        auditEvents.push({ runId, event: structuredClone(event) });
      },
      saveRun: (run: RunRecord) => storedRuns.set(run.id, structuredClone(run)),
      storedRun: (runId: string) => {
        const run = storedRuns.get(runId);
        return run && structuredClone(run);
      },
    },
    dataDir: join(directory, 'data'),
    bridgeTokens: tokens,
    executionResumes: [],
    projectDeliveries: new Set(),
    closing: false,
  });
  controller.on('execution-capacity', () => internals.resumeExecutions());
  const run: RunRecord = {
    id: 'parent-run',
    workflowId: 'parent',
    projectPath: 'fixture-project',
    permissionMode: 'workspace-write',
    prompt: 'fixture',
    kind: 'general',
    status: 'running',
    route: { runtimeId: 'parent-runtime', model: 'unused', kind: 'general', reasons: [], warnings: [] },
    output: '',
    events: [],
    startedAt: new Date().toISOString(),
  };
  const abort = new AbortController();
  const entry = { run, abort, project: 'fixture-project', permissionMode: 'workspace-write' as const };
  controller.active.set(run.id, entry);
  tokens.set('parent', {
    runId: run.id,
    delegate: true,
    recycle: true,
    child: false,
    write: true,
    abort: new AbortController(),
  });
  const child = {
    id: 'child',
    status: 'running',
    runIds: [],
    delegation: { parentId: 'parent', agent: { label: 'Child' } },
  } as unknown as Workflow;
  const workspace = {
    store: { get: (_kind: string, id: string) => (id === 'child' ? child : undefined) },
    scopeChecked: async () => {},
    markResultDelivered: () => {},
    takeNotices: () => [],
    queueNotice: () => {},
  } as unknown as Workspace;
  const bridge = new AgentBridge(workspace, controller, 'unused', {
    toolTimeoutMs: 1000,
    returnMarginMs: 20,
    restoreMarginMs: 200,
    pollMs: 5,
  });
  const effects: string[] = [];
  let effect: (name: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<string> = async () =>
    'fixture result';
  const builtins = bridge as unknown as {
    call(caller: unknown, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string>;
  };
  const original = builtins.call.bind(bridge);
  t.mock.method(
    builtins,
    'call',
    async (caller: unknown, name: string, args: Record<string, unknown>, signal?: AbortSignal) => {
      if (name === 'get_result') return original(caller, name, args, signal);
      effects.push(name);
      return effect(name, args, signal);
    },
  );
  t.mock.method(extensions, 'handles', (name: string) => name.startsWith('fixture__'));
  t.mock.method(extensions, 'bridgeTools', (write: boolean) => [
    { name: 'fixture__read', description: '', inputSchema: {} },
    ...(write ? [{ name: 'fixture__write', description: '', inputSchema: {} }] : []),
  ]);
  t.mock.method(
    extensions,
    'call',
    async (name: string, args: Record<string, unknown>, _write: boolean, signal?: AbortSignal) => {
      effects.push(name);
      return { content: [{ type: 'text' as const, text: await effect(name, args, signal) }] };
    },
  );
  const parentEntry = () => controller.active.get(run.id)!;
  t.after(async () => {
    abort.abort(new Error('fixture cleanup'));
    await bridge.close();
    controller.active.clear();
    controller.removeAllListeners();
    assert.equal(dirname(directory).toLowerCase(), realpathSync.native(tmpdir()).toLowerCase());
    assert.ok(basename(directory).startsWith('pugport-bridge-mutation-'));
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    controller,
    bridge,
    child,
    abort,
    effects,
    auditEvents,
    parentEntry,
    effect(fn: typeof effect) {
      effect = fn;
    },
    handle(body: unknown, signal?: AbortSignal) {
      return bridge.handle('Bearer parent', body, signal);
    },
    blockWithSibling() {
      controller.active.set('sibling-run', {
        run: {
          ...run,
          id: 'sibling-run',
          workflowId: 'sibling',
          route: { ...run.route, runtimeId: 'sibling-runtime' },
        },
        abort: new AbortController(),
        project: 'fixture-project',
        permissionMode: 'workspace-write',
      });
      return () => {
        controller.active.delete('sibling-run');
        controller.emit('execution-capacity');
      };
    },
  };
}

test('a wait-first batch denies every confirmed mutator after its writer slot parks', async (t) => {
  const f = fixture(t);
  const tools = [
    call('organize_files', {}, 2),
    call('undo_organize', {}, 3),
    call('recycle_files', {}, 4),
    ...['click', 'type', 'press'].map((action, index) => call('test_page', { steps: [{ action }] }, index + 5)),
    call('fixture__write', {}, 8),
  ];
  const pending = f.handle([call('get_result', { task_id: 'child', wait_seconds: 50 }), ...tools]);
  assert.equal(f.parentEntry().parked, true);
  assert.deepEqual(f.effects, [], 'a stale caller.write must never reach a mutation implementation');
  f.child.status = 'completed';
  const response = await pending;
  const replies = response.body as any[];
  assert.equal(replies[0].result.isError, undefined);
  for (const reply of replies.slice(1)) {
    assert.equal(reply.result.isError, true);
    assert.match(reply.result.content[0].text, /正在等待子任务/);
  }
  assert.equal(f.parentEntry().parked, false);
  assert.equal(f.parentEntry().bridgeMutations ?? 0, 0);
});

test('partial organize receipts survive the bridge and are audited as partial, preserving successful operations', async (t) => {
  const f = fixture(t);
  const receipt = {
    status: 'partial',
    operationIds: ['saved-operation'],
    requested: 2,
    succeeded: 1,
    failed: 1,
    skipped: 0,
    moves: [{ from: 'synthetic-source', to: 'synthetic-target' }],
    recycled: [],
  };
  t.mock.method(f.bridge as any, 'call', async () => ({
    content: [{ type: 'text', text: '成功 1 项，失败 1 项。' }],
    structuredContent: receipt,
    isError: true,
  }));
  const response = result(await f.handle(call('organize_files')));
  assert.deepEqual(response.structuredContent, receipt);
  assert.equal(response.isError, true);
  const terminal = [...f.auditEvents].reverse().find(({ event }) => event.data?.kind === 'pugportToolCall')!.event;
  assert.equal(terminal.data?.status, 'partial');
  assert.deepEqual((terminal.data?.result as any).structuredContent, receipt);
});

for (const name of ['organize_files', 'fixture__write']) {
  test(`an accepted ${name} pins a mutation-first batch until its side effect settles`, async (t) => {
    const f = fixture(t);
    const mutation = deferred<string>();
    f.effect(async (tool) => (tool === name ? mutation.promise : 'read finished'));
    const parked = deferred<void>();
    f.controller.on('execution-capacity', () => {
      if (f.parentEntry().parked) parked.resolve();
    });
    const pending = f.handle([
      call(name, {}, 1),
      call('get_result', { task_id: 'child', wait_seconds: 50 }, 2),
      call('find_files', {}, 3),
    ]);
    assert.equal(f.parentEntry().bridgeMutations, 1);
    assert.equal(f.parentEntry().yieldRequested, true);
    assert.equal(f.parentEntry().parked ?? false, false);
    assert.equal(f.controller.hasExecutionCapacity(), false);
    assert.deepEqual(f.effects, [name, 'find_files'], 'read-only work in the same batch remains concurrent');
    mutation.resolve('mutation finished');
    await parked.promise;
    assert.equal(f.parentEntry().bridgeMutations, 0);
    assert.equal(f.controller.hasExecutionCapacity(), true);
    f.child.status = 'completed';
    const response = await pending;
    assert.equal((response.body as any[]).length, 3);
    assert.equal(f.parentEntry().parked, false);
    assert.equal(f.controller.hasExecutionCapacity(), false);
    const mutationAudit = f.auditEvents.filter(({ event }) => event.data?.tool === name);
    assert.deepEqual(
      mutationAudit.map(({ event }) => event.data?.status),
      ['inProgress', 'completed'],
    );
    assert.ok(
      mutationAudit.every(
        ({ runId, event }) => runId === 'parent-run' && event.data?.hostAudit === true && typeof event.seq === 'number',
      ),
    );
    assert.equal(mutationAudit[0].event.data?.toolCallId, mutationAudit[1].event.data?.toolCallId);
  });
}

test('a concurrent read-only reply reacquires the actual writer slot before waking its parked caller', async (t) => {
  const f = fixture(t);
  const waiting = f.handle(call('get_result', { task_id: 'child', wait_seconds: 50 }));
  assert.equal(f.parentEntry().parked, true);
  const releaseSibling = f.blockWithSibling();
  let delivered = false;
  const reading = f.handle(call('fixture__read')).then((response) => {
    delivered = true;
    return response;
  });
  await turn();
  assert.deepEqual(f.effects, ['fixture__read']);
  assert.equal(delivered, false, 'the readonly implementation may run, but its reply cannot wake an unleased writer');
  assert.equal(f.parentEntry().resuming, true);
  assert.equal(f.parentEntry().suspensions, 1, 'returning an unrelated reply must not consume the pending wait');
  const denied = f.handle(call('fixture__write'));
  await turn();
  assert.deepEqual(f.effects, ['fixture__read']);
  releaseSibling();
  assert.equal(result(await reading).isError, undefined);
  assert.equal(result(await denied).isError, true);
  assert.equal(f.parentEntry().parked, false);
  assert.equal(f.parentEntry().suspensions, 1);
  assert.equal(f.controller.hasExecutionCapacity(), false);
  assert.equal(result(await f.handle(call('organize_files'))).isError, undefined);
  f.child.status = 'completed';
  await waiting;
  assert.equal(f.parentEntry().suspensions, 0);
});

test('a separate readonly reply clears yielding so a late accepted mutation cannot park a resumed caller', async (t) => {
  const f = fixture(t);
  const mutation = deferred<string>();
  f.effect(async (name) => (name === 'organize_files' ? mutation.promise : 'read finished'));
  const writing = f.handle(call('organize_files'));
  const waiting = f.handle(call('get_result', { task_id: 'child', wait_seconds: 50 }));
  assert.equal(f.parentEntry().yieldRequested, true);
  assert.equal(f.parentEntry().parked ?? false, false);
  assert.equal(result(await f.handle(call('find_files'))).isError, undefined);
  assert.equal(f.parentEntry().yieldRequested, false);
  mutation.resolve('finished');
  await writing;
  assert.equal(f.parentEntry().parked ?? false, false);
  assert.equal(f.controller.hasExecutionCapacity(), false);
  f.child.status = 'completed';
  await waiting;
});

test('mutator failures release their real leases and authoritative readonly permission overrides cached write grants', async (t) => {
  const f = fixture(t);
  f.effect(async () => {
    throw new Error('fixture side effect failed');
  });
  for (const name of ['organize_files', 'fixture__write']) {
    const failed = result(await f.handle(call(name)));
    assert.equal(failed.isError, true);
    assert.match(failed.content[0].text, /fixture side effect failed/);
    assert.equal(f.parentEntry().bridgeMutations, 0);
  }
  const before = f.effects.length;
  f.parentEntry().permissionMode = 'read-only';
  for (const name of ['organize_files', 'fixture__write']) {
    const denied = result(await f.handle(call(name)));
    assert.equal(denied.isError, true);
    assert.match(denied.content[0].text, /只读/);
  }
  assert.equal(f.effects.length, before);
});

test('nonmutating page actions and installed readonly tools do not take mutation leases', async (t) => {
  const f = fixture(t);
  const retain = t.mock.method(f.controller, 'retainMutation', () => {
    throw new Error('readonly tool attempted to lock writes');
  });
  const response = await f.handle([
    call('test_page', { steps: [{ action: 'wait' }, { action: 'expect_text' }, { action: 'screenshot' }] }, 1),
    call('fixture__read', {}, 2),
    call('get_result', { task_id: 'child', wait_seconds: 0 }, 3),
  ]);
  assert.equal(retain.mock.callCount(), 0);
  assert.deepEqual(f.effects, ['test_page', 'fixture__read']);
  for (const reply of response.body as any[]) assert.equal(reply.result.isError, undefined);
});

test('aborting a pending readonly return preserves an explicit tool error and cancels only the unleased caller', async (t) => {
  const f = fixture(t);
  const resume = f.controller.suspendExecution('parent-run');
  f.blockWithSibling();
  f.effect(async () => {
    throw new Error('explicit tool failure');
  });
  const transport = new AbortController();
  const pending = f.handle(call('find_files'), transport.signal);
  await turn();
  assert.equal(f.parentEntry().resuming, true);
  transport.abort(new Error('fixture transport disconnected'));
  const failed = result(await pending);
  assert.equal(failed.isError, true);
  assert.match(failed.content[0].text, /explicit tool failure/);
  assert.equal(f.abort.signal.aborted, true);
  assert.equal(f.controller.active.get('sibling-run')!.abort.signal.aborted, false);
  await assert.rejects(resume(), /恢复执行资源超时/);
});

test('a success cannot be delivered after return-slot timeout, and notifications do not resume a caller', async (t) => {
  const f = fixture(t);
  const resume = f.controller.suspendExecution('parent-run');
  f.blockWithSibling();
  const notification = await f.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(notification.status, 202);
  assert.equal(f.parentEntry().resuming, undefined);
  const transport = new AbortController();
  const pending = f.handle(call('find_files'), transport.signal);
  await turn();
  transport.abort(new Error('fixture disconnected'));
  const response = await pending;
  assert.equal((response.body as any).result, undefined);
  assert.match((response.body as any).error.message, /fixture disconnected/);
  assert.equal(f.abort.signal.aborted, true);
  await assert.rejects(resume(), /恢复执行资源超时/);
});
