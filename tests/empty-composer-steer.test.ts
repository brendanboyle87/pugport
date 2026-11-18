import assert from 'node:assert/strict';
import test from 'node:test';
import type { AppState, RunRecord, Workflow } from '../src/shared/types.ts';
import { steerFirstQueuedMessage, steerQueuedWorkflow } from '../src/ui/composer-steering.ts';
import type { Api } from '../src/ui/Workspace.tsx';

const stamp = '2026-09-30T12:00:00.000Z';
const conversationId = 'conversation';
const workflow = (id: string, patch: Partial<Workflow> = {}): Workflow => ({
  id,
  conversationId,
  projectId: 'project',
  userMessageId: `message-${id}`,
  input: { content: `Fixture ${id}`, mode: 'build', permissionMode: 'workspace-write', executionPolicy: 'cli-first' },
  status: 'queued',
  phase: 'queue',
  plan: [],
  runIds: [],
  memoryRevision: 0,
  memoryExcerpt: '',
  createdAt: stamp,
  updatedAt: stamp,
  ...patch,
});
const executing = (patch: Partial<Workflow> = {}) =>
  workflow('executing', { status: 'running', phase: 'execute', runIds: ['run'], ...patch });
const run = (patch: Partial<RunRecord> = {}): RunRecord => ({
  id: 'run',
  workflowId: 'executing',
  stepId: 'step',
  prompt: 'Fixture prompt',
  projectPath: 'C:/Fixture',
  kind: 'general',
  status: 'running',
  route: { runtimeId: 'fixture', model: 'fixture', kind: 'general', reasons: [], warnings: [] },
  toolApprovalMode: 'auto',
  steerAvailable: true,
  steeringStatus: { state: 'ready' },
  startedAt: stamp,
  output: 'Fixture reply',
  events: [],
  ...patch,
});
const state = (
  workflows: Workflow[],
  runs: RunRecord[] = [run()],
): Pick<AppState, 'workflows' | 'runs' | 'settings'> => ({
  workflows,
  runs,
  settings: {
    refreshSeconds: 60,
    reservePercent: 10,
    maxQuotaAgeSeconds: 120,
    preferCli: true,
    designProvider: 'claude',
    architectureProvider: 'codex',
    routineProvider: 'codex',
    unknownQuotaPolicy: 'manual-only',
    defaultProjectPath: 'C:/Fixture',
    maxConcurrentRuns: 1,
  },
});
type ApiCall = [string, unknown?, string?];

test('empty composer steer takes the durable first queue item rather than the oldest message', async () => {
  const older = workflow('older', { queueOrder: 200, createdAt: '2026-09-30T11:00:00.000Z' });
  const first = workflow('first/id', { queueOrder: 100, createdAt: '2026-09-30T13:00:00.000Z' });
  const view = state([older, executing(), first]);
  const before = structuredClone(view);
  const calls: ApiCall[] = [];
  const api: Api = async <T>(...args: ApiCall) => {
    calls.push(args);
    return { ok: true } as T;
  };

  assert.equal(await steerFirstQueuedMessage(api, view, conversationId), true);
  assert.deepEqual(calls, [['/api/workflows/first%2Fid/steer', {}, 'POST']]);
  assert.deepEqual(view, before, 'Selecting queued input must not rewrite it or create a new task');
});

test('empty composer steer is a no-op without a local queue or a ready local run', async () => {
  const localQueued = workflow('queued');
  const cases = [
    { name: 'no queued message', view: state([executing()]), id: conversationId },
    {
      name: 'channel not ready',
      view: state([executing(), localQueued], [run({ steerAvailable: false })]),
      id: conversationId,
    },
    { name: 'no native run', view: state([executing(), localQueued], []), id: conversationId },
    {
      name: 'waiting for approval',
      view: state([executing(), localQueued], [run({ status: 'waiting-approval' })]),
      id: conversationId,
    },
    {
      name: 'only foreign execution',
      view: state([executing({ conversationId: 'other' }), localQueued]),
      id: conversationId,
    },
    {
      name: 'only foreign queue',
      view: state([executing(), workflow('foreign', { conversationId: 'other' })]),
      id: conversationId,
    },
    { name: 'no conversation selected', view: state([executing(), localQueued]), id: undefined },
  ];
  const calls: ApiCall[] = [];
  const api: Api = async <T>(...args: ApiCall) => {
    calls.push(args);
    return { ok: true } as T;
  };

  for (const fixture of cases) {
    const before = structuredClone(fixture.view);
    assert.equal(await steerFirstQueuedMessage(api, fixture.view, fixture.id), false, fixture.name);
    assert.deepEqual(fixture.view, before, fixture.name);
  }
  assert.deepEqual(calls, [], 'No-op cases must not create messages, conversations, or steering requests');
});

test('an incompatible first pending-steer anchor rejects without skipping the second item', async () => {
  const calls: ApiCall[] = [];
  const api: Api = async <T>(...args: ApiCall) => {
    calls.push(args);
    return { ok: true } as T;
  };
  for (const pendingSteer of [
    { workflowId: 'executing', runId: 'previous-run' },
    { workflowId: 'previous-workflow', runId: 'run' },
  ]) {
    const first = workflow('first', { queueOrder: 100, pendingSteer });
    const second = workflow('second', { queueOrder: 200 });
    const view = state([second, executing(), first]);
    const before = structuredClone(view);

    await assert.rejects(steerFirstQueuedMessage(api, view, conversationId), /首条排队消息/);
    assert.deepEqual(view, before, 'The incompatible first item and its queue order must remain intact');
  }
  assert.deepEqual(calls, [], 'The second compatible message must never replace the first');
});

test('API incompatibility rejection preserves the first queued input and never tries a later item', async () => {
  const first = workflow('first', { queueOrder: 100 });
  first.input.runtimeId = 'different-runtime';
  const second = workflow('second', { queueOrder: 200 });
  const view = state([second, executing(), first]);
  const before = structuredClone(view);
  const calls: ApiCall[] = [];
  const incompatibility = new Error('Fixture: execution settings differ; the message remains queued.');
  const api: Api = async (...args: ApiCall) => {
    calls.push(args);
    throw incompatibility;
  };

  await assert.rejects(steerFirstQueuedMessage(api, view, conversationId), (error) => error === incompatibility);
  assert.deepEqual(calls, [['/api/workflows/first/steer', {}, 'POST']]);
  assert.deepEqual(view, before, 'Rejection must preserve queued content, execution configuration, status, and order');
});

test('empty composer and row steer share one in-flight request until acknowledgment and can retry afterward', async () => {
  const view = state([executing(), workflow('first', { queueOrder: 100 }), workflow('second', { queueOrder: 200 })]);
  let acknowledge!: () => void;
  const acknowledgment = new Promise<void>((resolve) => {
    acknowledge = resolve;
  });
  let entered!: () => void;
  const requestStarted = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const calls: ApiCall[] = [];
  const api: Api = async <T>(...args: ApiCall) => {
    calls.push(args);
    entered();
    if (calls.length === 1) await acknowledgment;
    return { ok: true } as T;
  };

  const fromComposer = steerFirstQueuedMessage(api, view, conversationId);
  const fromRow = steerQueuedWorkflow(api, 'first');
  const repeatedEnter = steerFirstQueuedMessage(api, view, conversationId);
  await requestStarted;
  assert.deepEqual(calls, [['/api/workflows/first/steer', {}, 'POST']]);
  assert.equal(
    steerQueuedWorkflow(api, 'first'),
    fromRow,
    'Row dispatch must retain the same pending delivery promise',
  );

  acknowledge();
  assert.deepEqual(await Promise.all([fromComposer, fromRow, repeatedEnter]), [true, undefined, true]);
  assert.equal(await steerFirstQueuedMessage(api, view, conversationId), true);
  assert.deepEqual(calls, [
    ['/api/workflows/first/steer', {}, 'POST'],
    ['/api/workflows/first/steer', {}, 'POST'],
  ]);
});

test('a failed shared delivery releases the in-flight lock for an explicit retry', async () => {
  const view = state([executing(), workflow('first')]);
  const calls: ApiCall[] = [];
  const api: Api = async <T>(...args: ApiCall) => {
    calls.push(args);
    if (calls.length === 1) throw new Error('Fixture: delivery rejected');
    return { ok: true } as T;
  };

  const fromComposer = steerFirstQueuedMessage(api, view, conversationId);
  const fromRow = steerQueuedWorkflow(api, 'first');
  await Promise.all([assert.rejects(fromComposer, /delivery rejected/), assert.rejects(fromRow, /delivery rejected/)]);
  assert.equal(calls.length, 1);
  await steerQueuedWorkflow(api, 'first');
  assert.equal(calls.length, 2);
});
