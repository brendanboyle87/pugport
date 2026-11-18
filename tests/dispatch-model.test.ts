import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { Controller } from '../src/server/controller.ts';
import { Store } from '../src/server/store.ts';
import { codexAdapter } from '../src/server/adapters/codex.ts';
import type { ExecuteContext } from '../src/shared/types.ts';
import { Workspace } from '../src/server/workspace.ts';
import { ExternalTasks, externalTaskRoutes, dispatchSchema, followSchema } from '../src/server/external-tasks.ts';
import { route, RouteUnavailableError } from '../src/server/routing.ts';
import type {
  MessageInput,
  RuntimeTarget,
  RuntimeSnapshot,
  Workflow,
  RunInput,
  RunRecord,
} from '../src/shared/types.ts';

function fixture(t: TestContext, realSend = false) {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'dispatch-model-test-')));
  const previousMemory = process.env.COMBORUNNER_MEMORY_DIR;
  process.env.COMBORUNNER_MEMORY_DIR = join(directory, 'memory');
  const targets: RuntimeTarget[] = [
    ['a', 'codex', 'Codex A'],
    ['b', 'codex', 'Codex B'],
    ['c', 'claude', 'Claude'],
    ['api', 'pi', 'API'],
  ].map(
    ([id, provider, label]) =>
      ({ id, provider, label, enabled: true, command: 'unused', environment: 'native' }) as RuntimeTarget,
  );
  const seed = new Store(join(directory, 'data'));
  seed.setConfig('targets', targets);
  seed.close();
  const controller = new Controller(directory, join(directory, 'data'), {
    readAccountIdentity: () => 'synthetic-account',
    nativeLogin: { pending: () => false },
  });
  clearInterval(controller.timer);
  controller.targets = targets;
  controller.settings.decisionMode = 'auto';
  controller.agentBridgeUrl = 'http://127.0.0.1:0/mcp';
  t.mock.method(controller, 'refresh', async () => {});
  t.mock.method(controller, 'machineReading', () => ({
    totalBytes: 32 * 1024 ** 3,
    cpus: 16,
    availableMemoryBytes: 16 * 1024 ** 3,
    cpuPercent: 20,
  }));
  controller.snapshots = controller.targets.map((target, index): RuntimeSnapshot => ({
    ...target,
    installed: true,
    authMode: 'chatgpt',
    accountFingerprint: 'synthetic-account',
    status: 'ready',
    models: [{ id: index === 0 ? 'Exact-Model' : 'other', label: 'Synthetic model', efforts: ['Low', 'High'] }],
    quota: {
      status: 'known',
      source: 'synthetic',
      observedAt: new Date().toISOString(),
      windows: [{ id: 'week', label: 'week', usedPercent: 10, resetsAt: new Date(Date.now() + 3600000).toISOString() }],
    },
    capabilities: { execute: true, resume: true, cancel: true, approvals: true },
    refreshedAt: new Date().toISOString(),
  }));
  const workspace = new Workspace(controller, { autoTick: false });
  const tasks = new ExternalTasks(workspace);
  const sent: MessageInput[] = [];
  if (!realSend)
    t.mock.method(workspace, 'send', async (id: string, input: MessageInput) => {
      sent.push(input);
      return { workflow: { id: 'synthetic-task', conversationId: id, status: 'queued', input } as Workflow };
    });
  t.after(async () => {
    await workspace.close();
    await controller.close();
    if (previousMemory === undefined) delete process.env.COMBORUNNER_MEMORY_DIR;
    else process.env.COMBORUNNER_MEMORY_DIR = previousMemory;
    assert.ok(resolve(directory).startsWith(realpathSync.native(tmpdir()) + sep + 'dispatch-model-test-'));
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const dispatch = (extra: Partial<Parameters<ExternalTasks['dispatch']>[0]> = {}) =>
    tasks.dispatch({ task: 'Explain synthetic parser', ...extra });
  return { directory, controller, workspace, tasks, sent, dispatch };
}

test('dispatch validates model/effort before creating a conversation and preserves catalog spelling', async (t) => {
  const f = fixture(t);
  assert.equal(dispatchSchema.safeParse({ task: 'x', model: 'x', effort: 'low' }).success, true);
  assert.equal(followSchema.safeParse({ message: 'x', model: 'x', effort: 'low' }).success, true);
  for (const extra of [{ model: 'bad' }, { model: 'exact-model', effort: 'bad' }, { effort: 'low' }]) {
    await assert.rejects(f.dispatch({ agent: 'Codex A', ...extra }), /see list_agents|effort requires model/);
    assert.equal(f.workspace.store.conversations().length, 0);
  }
  await f.dispatch({ agent: 'Codex A', model: 'eXact-MODEL', effort: 'hIGH' });
  assert.equal(f.sent[0].model, 'Exact-Model');
  assert.equal(f.sent[0].effort, 'High');
  assert.equal(f.sent[0].runtimeId, 'a');
  assert.equal(f.sent[0].allowExecutorFallback, false);
  assert.equal(f.sent[0].autoEscalate, true);
});

test('provider pins validate all enabled cards; model-only inherits and applies checklist and CLI policy', async (t) => {
  const f = fixture(t);
  f.controller.settings.excludedExecutors = ['a', 'c', 'api'];
  await f.dispatch({ agent: 'Codex', model: 'exact-model', effort: 'LOW' });
  assert.equal(f.sent[0].provider, 'codex');
  assert.equal(f.sent[0].runtimeId, undefined);
  await f.dispatch({ agent: 'Codex', model: 'OTHER', effort: 'high' });
  assert.equal(f.sent.at(-1)?.provider, 'codex');
  assert.equal(f.sent.at(-1)?.model, 'other');
  assert.equal(f.sent.at(-1)?.effort, 'High');
  await assert.rejects(f.dispatch({ model: 'exact-model' }), /see list_agents/);
  await f.dispatch({ model: 'exact-model', executors: ['Codex'], exclude: ['Codex B'] });
  const selected = f.sent.at(-1)!;
  assert.equal(selected.executionPolicy, 'cli-only');
  assert.equal(selected.allowExecutorFallback, false);
  assert.deepEqual(selected.automaticExecutors, ['a']);
  const input: RunInput = { ...selected, prompt: selected.content, projectPath: f.directory, kind: 'general' };
  assert.equal(route(input, f.controller.snapshots, f.controller.settings).runtimeId, 'a');
  await assert.rejects(f.dispatch({ model: 'exact-model', exclude: ['Codex A'] }), /see list_agents/);
  await assert.rejects(f.dispatch({ model: 'default' }), /default.*agent/);
  f.controller.snapshots[3].models = [{ id: 'api-only-model', label: 'API', efforts: [] }];
  await assert.rejects(f.dispatch({ model: 'api-only-model', executors: ['API'] }), /see list_agents/);
  await assert.rejects(f.dispatch({ model: 'exact-model', executors: [] }), /自动路由/);
});

test('empty catalogs, effort-only and device combinations are refused without creation', async (t) => {
  const f = fixture(t);
  f.controller.snapshots[0].models = [];
  await assert.rejects(
    f.dispatch({ agent: 'Codex A', model: 'anything' }),
    /model list for Codex A not loaded yet, try again shortly/,
  );
  await assert.rejects(f.dispatch({ model: 'missing' }), (error: Error) => {
    assert.doesNotMatch(error.message, /not loaded/, 'one empty catalog must not hide the others');
    assert.match(error.message, /Available models/);
    return true;
  });
  await assert.rejects(f.dispatch({ device: 'fake', model: 'anything' }), /Device tasks.*model/);
  await assert.rejects(f.dispatch({ device: 'fake', effort: 'low' }), /Device tasks.*model/);
  await assert.rejects(f.dispatch({ effort: 'low' }), /effort requires model/);
  assert.equal(f.workspace.store.conversations().length, 0);
});

test('follow validates executor mentions or the inherited automatic list and reports queued messages', async (t) => {
  const f = fixture(t);
  const created = await f.dispatch();
  const id = created.conversationId;
  await assert.rejects(f.tasks.follow(id, { message: 'inspect', effort: 'low' }), /effort requires model/);
  await f.tasks.follow(id, { message: '@Codex A inspect', model: 'EXACT-model', effort: 'low' });
  assert.equal(f.sent.at(-1)?.runtimeId, 'a');
  assert.equal(f.sent.at(-1)?.model, 'Exact-Model');
  assert.equal(f.sent.at(-1)?.effort, 'Low');
  assert.equal(f.sent.at(-1)?.allowExecutorFallback, false);
  await assert.rejects(
    f.tasks.follow(id, { message: '@Codex B inspect', model: 'exact-model' }),
    /Codex B.*|see list_agents/,
  );
  const conversation = f.workspace.store.get<any>('conversation', id)!;
  conversation.routing = { automaticExecutors: ['b'] };
  f.workspace.store.save('conversation', id, conversation.projectId, conversation);
  await assert.rejects(f.tasks.follow(id, { message: 'inspect', model: 'exact-model' }), /see list_agents/);
  const result = await f.tasks.follow(id, { message: 'inspect', model: 'exact-model', executors: ['Codex A'] });
  assert.equal(f.sent.at(-1)?.executionPolicy, 'cli-only');
  assert.equal(result?.queued, undefined, 'an idle conversation is not reported as queued');
  await assert.rejects(
    f.tasks.follow(id, { message: '@@Muse inspect', model: 'exact-model' }),
    /device or external agent/,
  );
  f.workspace.remote = { directory: () => [{ id: 'd', name: 'fake' }] } as any;
  await assert.rejects(
    f.tasks.follow(id, { message: '@@fake inspect', model: 'exact-model' }),
    /device or external agent/,
  );
});

test('list_agents lists only executor catalogs and task_status reports the actual model', async (t) => {
  const f = fixture(t);
  const list = f.tasks.agents();
  assert.equal(list.agents.length, 4);
  assert.deepEqual(list.agents[0].models[0], { id: 'Exact-Model', label: 'Synthetic model', efforts: ['Low', 'High'] });
  assert.equal(list.agents[0].label, 'Codex A');
  const created = await f.dispatch();
  const run = {
    id: 'used',
    startedAt: new Date().toISOString(),
    route: { runtimeId: 'a', model: 'requested' },
    effectiveModel: { model: 'actually-used' },
    events: [],
    status: 'completed',
  } as unknown as RunRecord;
  const workflow = {
    id: 'status',
    conversationId: created.conversationId,
    status: 'completed',
    input: {},
    runIds: ['used'],
    plan: [],
  } as unknown as Workflow;
  f.workspace.store.save('workflow', workflow.id, created.conversationId, workflow);
  t.mock.method(f.controller.store, 'storedRun', () => run);
  t.mock.method(f.controller, 'run', () => run);
  assert.equal(f.tasks.status('status')?.model, 'actually-used');
});

test('low quota and technical failures wait without replacing the chosen model; content refusal cannot relay', async (t) => {
  const f = fixture(t);
  await f.dispatch({ model: 'exact-model' });
  const selected = f.sent[0];
  const input: RunInput = { ...selected, prompt: selected.content, projectPath: f.directory, kind: 'general' };
  f.controller.snapshots[0].quota.windows[0].usedPercent = 100;
  assert.throws(
    () => route(input, f.controller.snapshots, f.controller.settings),
    (error: unknown) => {
      assert.ok(error instanceof RouteUnavailableError);
      assert.equal(error.kind, 'quota');
      return true;
    },
  );
  assert.equal(input.model, 'Exact-Model');
  const previous = {
    status: 'completed',
    output: 'I cannot help with that request because of content policy.',
    route: { runtimeId: 'a', model: 'Exact-Model' },
  } as RunRecord;
  const grok = { ...f.controller.targets[2], id: 'grok', provider: 'grok' as const, label: 'Synthetic Grok' };
  f.controller.targets.push(grok);
  f.controller.snapshots.push({
    ...f.controller.snapshots[2],
    ...grok,
    models: [{ id: 'grok-4.7', label: 'Grok', efforts: ['low'] }],
  });
  assert.ok(
    f.controller.contentRelay({ ...input, automaticExecutorSelection: true, allowExecutorFallback: true }, previous),
    'positive control: automatic refusal would relay',
  );
  assert.equal(f.controller.contentRelay(input, previous), undefined);
  assert.equal(
    f.controller.contentRelay({ ...input, automaticExecutorSelection: true, relayReason: 'quota' }, previous),
    undefined,
    'quota handoff must retain the model lock when the next account refuses',
  );
  assert.equal(
    f.controller.technicalRelay(input, { ...previous, status: 'failed', errorCode: 'runtime-network-error' }),
    undefined,
  );
});

test('a busy task with another model queues a successor and returns its configuration note', async (t) => {
  const f = fixture(t, true);
  f.controller.snapshots[0].models.push({ id: 'new-model', label: 'New', efforts: ['Low'] });
  let running: ExecuteContext | undefined;
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    running = ctx;
    await new Promise<void>((done) => ctx.signal.addEventListener('abort', () => done(), { once: true }));
    return { output: 'synthetic result' };
  });
  const first = await f.dispatch({ agent: 'Codex A', model: 'Exact-Model' });
  await f.workspace.tickQueue();
  for (let i = 0; i < 300 && !running; i++) await new Promise((done) => setTimeout(done, 10));
  assert.ok(running, 'synthetic adapter started');
  const result = await f.tasks.follow(first.conversationId, { message: 'Include another example', model: 'new-model' });
  assert.equal(result?.queued, true);
  assert.match(result?.note ?? '', /\u6a21\u578b.*\u4e0d\u540c/);
  assert.notEqual(result?.taskId, first.taskId);
  assert.equal(f.workspace.store.get<Workflow>('workflow', result!.taskId!)!.input.model, 'new-model');
});

test('a fixed native model cannot use Cursor quota fallback', async (t) => {
  const f = fixture(t);
  f.controller.snapshots[0].models = [{ id: 'gpt-6-sol', label: 'Sol', efforts: ['low'] }];
  f.controller.snapshots[0].quota.windows[0].usedPercent = 100;
  const cursor = {
    ...f.controller.snapshots[1],
    id: 'cursor',
    provider: 'cursor' as const,
    models: [{ id: 'gpt-6-sol', label: 'Sol', efforts: ['low'] }],
  };
  await f.dispatch({ agent: 'Codex A', model: 'gpt-6-sol' });
  const selected = f.sent[0];
  const request: RunInput = { ...selected, prompt: selected.content, projectPath: f.directory, kind: 'general' };
  assert.throws(
    () => route(request, [f.controller.snapshots[0], cursor], f.controller.settings),
    RouteUnavailableError,
  );
  // The app's own technical relay keeps the model and may still reach Cursor (unchanged behaviour).
  const technical: RunInput = {
    ...request,
    runtimeId: undefined,
    provider: 'codex',
    relayReason: 'technical',
    allowExecutorFallback: false,
  };
  assert.equal(route(technical, [f.controller.snapshots[0], cursor], f.controller.settings).runtimeId, 'cursor');
});

test('HTTP catalog is read-only and guarded against PugPort calling itself', (t) => {
  const f = fixture(t);
  const gets = new Map<string, Function>();
  let guardPaths: string[] = [];
  let guard: Function = () => {};
  const app = {
    use: (paths: string[], handler: Function) => {
      guardPaths = paths;
      guard = handler;
    },
    get: (path: string, handler: Function) => gets.set(path, handler),
    post: () => {},
  };
  externalTaskRoutes(app as any, f.tasks, { root: f.directory, port: 0, ownsProcess: (pid) => pid === 123 });
  assert.ok(guardPaths.includes('/api/external/agents'));
  let data: any;
  const res = {
    json: (value: unknown) => {
      data = value;
    },
    status: (status: number) => {
      assert.equal(status, 403);
      return res;
    },
  };
  gets.get('/api/external/agents')!({}, res);
  assert.deepEqual(data, f.tasks.agents());
  guard({ headers: { 'x-pugport-mcp-parent': '123' } }, res, () => assert.fail('loop guard bypassed'));
  assert.match((data as any).error, /own executors/);
});

test('bad pins show only the relevant catalog; large errors stay below HTTP truncation', async (t) => {
  const f = fixture(t);
  await assert.rejects(f.dispatch({ agent: 'Codex B', model: 'bad' }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /Codex B \| codex \| other/);
    assert.doesNotMatch(error.message, /Codex A|Claude|API/);
    return true;
  });
  f.controller.snapshots[0].models = Array.from({ length: 100 }, (_, i) => ({
    id: `model-${i}`,
    label: 'Synthetic model label'.repeat(10),
    efforts: ['low', 'high'],
  }));
  await assert.rejects(f.dispatch({ agent: 'Codex A', model: 'bad' }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok(error.message.length < 4000);
    assert.match(error.message, /see list_agents/);
    return true;
  });
  f.controller.targets[0].executionDisabledByUser = true;
  await assert.rejects(f.dispatch({ model: 'model-1' }), /see list_agents/);
});

test('model-only never spends API quota and technical failures cannot widen the selection', async (t) => {
  const f = fixture(t);
  f.controller.snapshots[3].models = f.controller.snapshots[0].models;
  f.controller.snapshots[0].quota.windows[0].usedPercent = 100;
  await f.dispatch({ model: 'exact-model' });
  const selected = f.sent[0];
  const request: RunInput = { ...selected, prompt: selected.content, projectPath: f.directory, kind: 'general' };
  assert.throws(() => route(request, f.controller.snapshots, f.controller.settings), RouteUnavailableError);
  f.controller.snapshots[0].status = 'auth-required';
  assert.throws(() => route(request, f.controller.snapshots, f.controller.settings), RouteUnavailableError);
  assert.equal(
    route({ ...request, allowExecutorFallback: true }, f.controller.snapshots, f.controller.settings).model,
    'other',
  );
});

test('the workflow waits on low quota on its only offering card and retains its model', async (t) => {
  const f = fixture(t, true);
  f.controller.snapshots[0].quota.windows[0].usedPercent = 100;
  t.mock.method(codexAdapter, 'execute', async () => {
    assert.fail('low-quota card must not execute');
  });
  const task = await f.dispatch({ model: 'exact-model', effort: 'low' });
  await f.workspace.tickQueue();
  for (
    let i = 0;
    i < 300 && f.workspace.store.get<Workflow>('workflow', task.taskId)?.status !== 'waiting-resource';
    i++
  )
    await new Promise((done) => setTimeout(done, 10));
  const workflow = f.workspace.store.get<Workflow>('workflow', task.taskId)!;
  assert.equal(workflow.status, 'waiting-resource');
  assert.equal(workflow.input.model, 'Exact-Model');
  assert.equal(workflow.input.effort, 'Low');
});
