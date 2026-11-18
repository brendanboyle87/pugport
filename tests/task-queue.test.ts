import { machineLoadReasons } from '../src/shared/machine-load.ts';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { setImmediate as immediate } from 'node:timers/promises';
import { backendActivity } from '../src/server/backend-activity.ts';
import { Controller } from '../src/server/controller.ts';
import { localRunLimit } from '../src/server/member-allocation.ts';
import { Workspace, type WorkspaceOptions } from '../src/server/workspace.ts';
import { retrieveLocalMemory } from '../src/server/memory-retrieval.ts';
import { compareQueuedWorkflows } from '../src/server/task-queue.ts';
import { RouteUnavailableError } from '../src/server/routing.ts';
import { ExternalTasks } from '../src/server/external-tasks.ts';
import type { MessageInput, RunInput, RunRecord, TaskSchedule, Workflow } from '../src/shared/types.ts';

const base: MessageInput = {
  content: 'Explain this project',
  mode: 'chat',
  permissionMode: 'read-only',
  executionPolicy: 'cli-first',
};
const epoch = Date.parse('2026-09-26T12:00:00.000Z');
function fixture(t: TestContext, options: WorkspaceOptions = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'studio-task-queue-'));
  const controller = new Controller(directory, join(directory, 'data'));
  t.mock.method(controller, 'machineReading', () => ({
    totalBytes: 32 * 1024 ** 3,
    cpus: 16,
    availableMemoryBytes: 16 * 1024 ** 3,
    cpuPercent: 20,
  }));
  clearInterval(controller.timer);
  const controllerListeners = new Map(
    ['resources-refreshed', 'execution-capacity', 'steering-ready'].map((event) => [
      event,
      controller.listeners(event),
    ]),
  );
  let clock = epoch;
  const workspace = new Workspace(controller, {
    now: () => clock,
    autoTick: false,
    retryMs: 1000,
    retrieveMemory: (store, input) => retrieveLocalMemory(store, input, { inline: true }),
    ...options,
  });
  const starts: RunInput[] = [];
  const complete = (input: RunInput): RunRecord => {
    starts.push(input);
    const run: RunRecord = {
      id: randomUUID(),
      prompt: input.prompt,
      projectPath: input.projectPath,
      kind: input.kind,
      status: 'completed',
      route: { runtimeId: 'test', model: 'test', kind: input.kind, reasons: [], warnings: [] },
      startedAt: new Date(clock).toISOString(),
      output: 'verified reply',
      events: [],
      workflowId: input.workflowId,
      stepId: input.stepId,
    };
    controller.store.saveRun(run);
    return run;
  };
  t.mock.method(controller, 'start', async (input: RunInput) => complete(input));
  // Workspaces a test reopens on this controller; hooks run in registration order, so a test's own
  // t.after would close them only after this hook had already tried to delete the folder.
  const closeFirst: (() => Promise<void>)[] = [];
  t.after(async () => {
    for (const close of closeFirst) await close();
    await workspace.close();
    await controller.close();
    const cleanup = resolve(directory);
    assert.ok(cleanup.startsWith(resolve(tmpdir()) + sep) && basename(cleanup).startsWith('studio-task-queue-'));
    rmSync(cleanup, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return {
    directory,
    controller,
    controllerListeners,
    workspace,
    closeFirst,
    starts,
    complete,
    advance: (ms: number) => {
      clock += ms;
    },
    now: () => clock,
  };
}
async function settle() {
  for (let i = 0; i < 4; i++) await immediate();
}
async function dispatch(workspace: Workspace) {
  await workspace.tickQueue();
  await settle();
}
function state(workspace: Workspace, id: string) {
  return workspace.store.get<Workflow>('workflow', id)!;
}
function unavailable(kind: RouteUnavailableError['kind'], retryAt?: string): RouteUnavailableError {
  return new RouteUnavailableError(kind, [`test-${kind}`], retryAt);
}

const reviewSteps = [
  {
    id: 'first',
    title: 'First',
    instruction: 'INSPECT_FIRST',
    kind: 'routine',
    dependsOn: [],
    acceptance: 'FIRST_EVIDENCE',
  },
  {
    id: 'second',
    title: 'Second',
    instruction: 'INSPECT_SECOND',
    kind: 'design',
    dependsOn: ['first'],
    acceptance: 'SECOND_EVIDENCE',
  },
];
async function until(check: () => boolean, details: () => unknown = () => '') {
  const end = Date.now() + 20_000;
  while (!check()) {
    assert.ok(Date.now() < end, `workflow should advance: ${JSON.stringify(details())}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
async function planFixture(
  t: TestContext,
  output = JSON.stringify({ steps: reviewSteps }),
  confirmRoute = false,
  input: Partial<MessageInput> = {},
) {
  const f = fixture(t);
  f.controller.settings.maxConcurrentRuns = 1;
  if (confirmRoute) {
    f.controller.settings.decisionMode = 'confirm';
    t.mock.method(f.controller, 'preview', () => ({
      runtimeId: 'test',
      model: 'test',
      kind: 'general',
      reasons: [],
      warnings: [],
    }));
  }
  const released = t.mock.method(f.controller, 'releaseProject');
  t.mock.method(f.controller, 'start', async (input: RunInput) => {
    const run = f.complete(input);
    run.output = input.stepId
      ? 'COMBORUNNER_TASK_RESULT: {"status":"completed","summary":"Inspected","claims":[]}'
      : output;
    f.controller.store.saveRun(run);
    return run;
  });
  const project = await f.workspace.createProject(f.directory);
  const conversation = f.workspace.createConversation(project.id);
  const submitted = await f.workspace.send(conversation.id, {
    ...base,
    content: 'Format src/utils.ts.',
    provider: 'codex',
    planFirst: true,
    ...input,
  });
  await dispatch(f.workspace);
  if (confirmRoute) {
    assert.equal(f.starts.length, 0);
    f.workspace.confirm(submitted.workflow.id, state(f.workspace, submitted.workflow.id).routingReview!.id);
    await dispatch(f.workspace);
  }
  await until(
    () =>
      state(f.workspace, submitted.workflow.id).status === 'waiting-confirmation' &&
      released.mock.calls.some((call) => call.arguments[1] === submitted.workflow.id),
  );
  return { ...f, project, conversation, id: submitted.workflow.id };
}

test('planFirst keeps a selected Pi lookup on the planner and waits for plan approval', async (t) => {
  const f = await planFixture(t, undefined, false, { provider: 'pi', content: 'Find the config file in docs/.' });
  assert.equal(state(f.workspace, f.id).planning?.strategy, 'model');
  assert.equal(state(f.workspace, f.id).planReview, 'pending');
  assert.equal(f.starts.length, 1);
  assert.equal(f.starts[0]!.stepId, undefined);
  await f.workspace.approvePlan(f.id, {});
  await dispatch(f.workspace);
  await until(() => state(f.workspace, f.id).status === 'completed');
  assert.equal(f.starts.length, 3);
  assert.deepEqual(
    f.starts.slice(1).map((start) => start.stepId),
    ['step1', 'step2'],
  );
});

test('planFirst forces the model planner even for a direct native edit, pauses and releases the project slot', async (t) => {
  const f = await planFixture(t);
  const saved = state(f.workspace, f.id);
  assert.equal(saved.input.mode, 'build');
  assert.equal(saved.input.permissionMode, 'read-only');
  assert.equal(saved.planning?.strategy, 'model');
  assert.equal(saved.planReview, 'pending');
  assert.deepEqual(
    f.workspace.state().workflows!.find((flow) => flow.id === f.id)!.plan,
    saved.plan,
    'the review UI needs complete instructions in state summaries',
  );
  const external = new ExternalTasks(f.workspace);
  assert.equal(external.status(f.id)?.planReview, 'pending');
  const result = await external.result(f.id);
  assert.ok(result && 'planReview' in result);
  assert.equal(result.planReview, 'pending');
  assert.equal(f.starts.length, 1);
  assert.equal(f.starts[0]!.stepId, undefined);
  assert.equal(f.starts[0]!.permissionMode, 'read-only');
  f.controller.reserveProject(f.project.path, 'competing', 'workspace-write');
  f.controller.releaseProject(f.project.path, 'competing');
  const another = f.workspace.createConversation(f.project.id);
  const next = await f.workspace.send(another.id, { ...base, permissionMode: 'workspace-write' });
  await dispatch(f.workspace);
  await until(() => state(f.workspace, next.workflow.id).status === 'completed');
  assert.equal(state(f.workspace, f.id).planReview, 'pending');
});

test('route confirmation remains approved while the plan waits for its own approval', async (t) => {
  const f = await planFixture(t, undefined, true);
  assert.equal(state(f.workspace, f.id).routingReview?.status, 'approved');
  await f.workspace.approvePlan(f.id, {});
  await dispatch(f.workspace);
  await until(() => state(f.workspace, f.id).status === 'completed');
  assert.equal(f.starts.length, 3);
  assert.ok(
    f.workspace
      .state()
      .workflows!.find((flow) => flow.id === f.id)!
      .plan.every((step) => step.instruction === ''),
    'completed plans stay trimmed',
  );
});

test('without planFirst a direct build runs immediately without a review', async (t) => {
  const f = fixture(t);
  const project = await f.workspace.createProject(f.directory);
  const conversation = f.workspace.createConversation(project.id);
  const submitted = await f.workspace.send(conversation.id, {
    ...base,
    mode: 'build',
    content: 'Format src/utils.ts.',
    provider: 'codex',
  });
  await dispatch(f.workspace);
  await until(() => state(f.workspace, submitted.workflow.id).status === 'completed');
  assert.equal(state(f.workspace, submitted.workflow.id).planReview, undefined);
  assert.equal(f.starts.length, 1);
  assert.equal(f.starts[0]!.stepId, 'step1');
});

test('a real planner decline ends the planFirst task without a review or executor', async (t) => {
  const f = fixture(t);
  t.mock.method(f.controller, 'start', async (input: RunInput) => {
    const run = f.complete(input);
    run.output = JSON.stringify({ declined: true, reason: 'Fixture refusal' });
    f.controller.store.saveRun(run);
    return run;
  });
  const project = await f.workspace.createProject(f.directory);
  const conversation = f.workspace.createConversation(project.id);
  const submitted = await f.workspace.send(conversation.id, { ...base, planFirst: true, provider: 'codex' });
  await dispatch(f.workspace);
  await until(() => state(f.workspace, submitted.workflow.id).status === 'completed');
  assert.equal(state(f.workspace, submitted.workflow.id).planReview, undefined);
  assert.equal(f.starts.length, 1);
  assert.equal(f.starts[0]!.stepId, undefined);
});

for (const permissionMode of ['read-only', 'workspace-write'] as const)
  for (const edited of [false, true])
    test(`approve plan ${edited ? 'with deletion and edits' : 'without edits'} executes exactly the approved steps with ${permissionMode} without replanning`, async (t) => {
      const f = await planFixture(t, undefined, false, { permissionMode });
      const steps = edited ? [{ title: 'Edited second', instruction: 'INSPECT_SECOND_EDITED' }] : undefined;
      const approved = await f.workspace.approvePlan(f.id, steps ? { steps } : {});
      assert.deepEqual(
        approved.plan.map((step) => [step.id, step.dependsOn, step.kind, step.transport]),
        edited
          ? [['step1', [], 'general', 'auto']]
          : [
              ['step1', [], 'routine', 'auto'],
              ['step2', [], 'design', 'auto'],
            ],
      );
      await dispatch(f.workspace);
      await until(
        () => ['completed', 'failed', 'blocked'].includes(state(f.workspace, f.id).status),
        () => state(f.workspace, f.id),
      );
      assert.equal(state(f.workspace, f.id).status, 'completed', state(f.workspace, f.id).error ?? '');
      assert.equal(f.starts.filter((input) => !input.stepId).length, 1);
      assert.deepEqual(
        f.starts.slice(1).map((input) => input.stepId),
        edited ? ['step1'] : ['step1', 'step2'],
      );
      const expected = steps ?? reviewSteps;
      for (let i = 0; i < expected.length; i++) {
        assert.ok(f.starts[i + 1]!.prompt.includes(expected[i]!.instruction));
        assert.equal(f.starts[i + 1]!.permissionMode, permissionMode);
        assert.equal(approved.plan[i]!.acceptance, edited ? undefined : reviewSteps[i]!.acceptance);
      }
      assert.equal(f.starts[0]!.permissionMode, 'read-only');
      if (edited) assert.ok(!f.starts[1]!.prompt.includes('INSPECT_FIRST'));
      await assert.rejects(f.workspace.approvePlan(f.id, {}), /待批准/);
    });

test('invalid plan edits leave the original pending plan intact', async (t) => {
  const f = await planFixture(t);
  const invalid = [
    null,
    { steps: [] },
    { steps: Array(7).fill({ title: 'A', instruction: 'B' }) },
    { steps: [{ title: ' ', instruction: 'B' }] },
    { steps: [{ title: 'A', instruction: '' }] },
    { steps: [{ title: 'A'.repeat(151), instruction: 'B' }] },
    { steps: [{ title: 'A', instruction: 'B'.repeat(50001) }] },
    { steps: [{ title: 'A', instruction: 'B', dependsOn: ['missing'] }] },
  ];
  for (const body of invalid) await assert.rejects(f.workspace.approvePlan(f.id, body), /计划格式无效/);
  assert.equal(state(f.workspace, f.id).planReview, 'pending');
  assert.equal(state(f.workspace, f.id).plan.length, 2);
  assert.equal(f.starts.length, 1);
  const saved = state(f.workspace, f.id);
  saved.plan[0]!.instruction = 'x'.repeat(50001);
  f.workspace.store.save('workflow', f.id, f.conversation.id, saved);
  await assert.rejects(f.workspace.approvePlan(f.id, {}), /计划格式无效/);
  assert.equal(state(f.workspace, f.id).planReview, 'pending');
});

test('approval of an already executing plan is refused immediately', async (t) => {
  const f = await planFixture(t);
  await f.workspace.approvePlan(f.id, {});
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.mock.method(f.controller, 'start', async (input: RunInput) => {
    const run = f.complete(input);
    await held;
    return run;
  });
  await dispatch(f.workspace);
  await until(() => f.starts.length > 1);
  let rejected = false;
  const approval = f.workspace.approvePlan(f.id, {}).catch((error) => {
    assert.match(error.message, /待批准/);
    rejected = true;
  });
  try {
    await settle();
    assert.equal(rejected, true);
  } finally {
    release();
    await approval;
  }
});

test('unparseable planner output exposes the fallback for review and cancel starts no executor', async (t) => {
  const f = await planFixture(t, 'not JSON');
  assert.equal(state(f.workspace, f.id).plan[0]!.title, '按原始需求执行');
  f.workspace.cancel(f.id);
  await dispatch(f.workspace);
  assert.equal(state(f.workspace, f.id).status, 'cancelled');
  assert.match(state(f.workspace, f.id).error!, /计划已取消/);
  assert.doesNotMatch(state(f.workspace, f.id).error!, /未启动执行器/);
  assert.equal(f.starts.length, 1);
  await assert.rejects(f.workspace.approvePlan(f.id, {}), /待批准/);
});

for (const editedBody of [false, true])
  test(`a message-limit fallback can be approved ${editedBody ? 'through the plan card' : 'without edits'}`, async (t) => {
    const content = 'x'.repeat(50000);
    const f = await planFixture(t, 'not JSON', false, { content });
    assert.equal(state(f.workspace, f.id).plan[0]!.instruction, content);
    const body = editedBody
      ? { steps: state(f.workspace, f.id).plan.map(({ title, instruction }) => ({ title, instruction })) }
      : {};
    const approved = await f.workspace.approvePlan(f.id, body);
    assert.equal(approved.planReview, 'approved');
    assert.equal(approved.plan[0]!.instruction, content);
  });

test('an approved plan queued at restart is interrupted and one continue resumes it', async (t) => {
  const f = await planFixture(t);
  await f.workspace.approvePlan(f.id, {});
  await f.workspace.close();
  const restarted = new Workspace(f.controller, {
    autoTick: false,
    retrieveMemory: (store, input) => retrieveLocalMemory(store, input, { inline: true }),
  });
  f.closeFirst.push(() => restarted.close());
  assert.equal(state(restarted, f.id).status, 'interrupted');
  const continued = await restarted.continue(f.id, '继续');
  await dispatch(restarted);
  await until(() => state(restarted, continued.workflow.id).status === 'completed');
  assert.equal(f.starts.filter((input) => !input.stepId).length, 1);
  assert.deepEqual(
    f.starts.slice(1).map((input) => input.permissionMode),
    ['read-only', 'read-only'],
  );
});

test('pending plan survives restart and approval still does not replan', async (t) => {
  const f = await planFixture(t);
  await f.workspace.close();
  const restarted = new Workspace(f.controller, {
    autoTick: false,
    retrieveMemory: (store, input) => retrieveLocalMemory(store, input, { inline: true }),
  });
  f.closeFirst.push(() => restarted.close());
  assert.equal(state(restarted, f.id).planReview, 'pending');
  await dispatch(restarted);
  assert.equal(f.starts.length, 1);
  await restarted.approvePlan(f.id, {});
  await dispatch(restarted);
  await until(() => state(restarted, f.id).status === 'completed');
  assert.equal(f.starts.filter((input) => !input.stepId).length, 1);
  await restarted.close();
});

test('approved resend and continuation strip planFirst; swarm, participants, devices and subtasks ignore it', async (t) => {
  const f = await planFixture(t);
  await f.workspace.approvePlan(f.id, {});
  const interrupted = state(f.workspace, f.id);
  interrupted.status = 'interrupted';
  f.workspace.store.save('workflow', f.id, f.conversation.id, interrupted);
  const resent = await f.workspace.resendMessage(f.conversation.id, interrupted.userMessageId);
  assert.equal(resent.workflow.input.planFirst, undefined);
  f.workspace.cancel(resent.workflow.id);
  const continued = await f.workspace.continue(f.id);
  assert.equal(continued.workflow.input.planFirst, undefined);
  for (const extra of [
    { swarm: true },
    { deviceId: 'fixture-device' },
    {
      participants: [
        { kind: 'executor', id: 'a', name: 'A', agent: 'A' },
        { kind: 'executor', id: 'b', name: 'B', agent: 'B' },
      ],
    },
  ] as Partial<MessageInput>[]) {
    const submitted = await f.workspace.send(f.conversation.id, { ...base, ...extra, queue: true, planFirst: true });
    assert.equal(submitted.workflow.input.planFirst, undefined);
  }
  const child = await f.workspace.send(f.conversation.id, { ...base, planFirst: true, queue: true }, undefined, {
    parentId: f.id,
    role: 'worker',
    requestId: 'fixture-child',
  });
  assert.equal(child.workflow.input.planFirst, undefined);
});

for (const status of ['blocked', 'planning'] as const)
  for (const action of ['continue', 'resend'] as const)
    test(`${action} after ${status} before approval still requires plan review`, async (t) => {
      const f = fixture(t);
      const project = await f.workspace.createProject(f.directory);
      const conversation = f.workspace.createConversation(project.id);
      t.mock.method(f.controller, 'start', async (input: RunInput) => {
        const run = f.complete(input);
        run.status = 'failed';
        run.error = 'Synthetic planner failure';
        f.controller.store.saveRun(run);
        return run;
      });
      const submitted = await f.workspace.send(conversation.id, {
        ...base,
        content: 'Format src/utils.ts.',
        provider: 'codex',
        planFirst: true,
        permissionMode: 'workspace-write',
      });
      await dispatch(f.workspace);
      await until(() => state(f.workspace, submitted.workflow.id).status === 'blocked');
      const parent = state(f.workspace, submitted.workflow.id);
      assert.equal(parent.plan.length, 0);
      await f.workspace.close();
      // A crash during planning leaves this durable state for startup recovery.
      if (status === 'planning') {
        parent.status = 'planning';
        parent.phase = 'plan';
        f.workspace.store.save('workflow', parent.id, conversation.id, parent);
      }
      const restarted = new Workspace(f.controller, {
        autoTick: false,
        retrieveMemory: (store, input) => retrieveLocalMemory(store, input, { inline: true }),
      });
      f.closeFirst.push(() => restarted.close());
      assert.equal(state(restarted, parent.id).status, status === 'planning' ? 'interrupted' : 'blocked');
      t.mock.method(f.controller, 'start', async (input: RunInput) => {
        const run = f.complete(input);
        run.output = JSON.stringify({ steps: reviewSteps });
        f.controller.store.saveRun(run);
        return run;
      });
      const child =
        action === 'continue'
          ? await restarted.continue(parent.id, '继续')
          : await restarted.resendMessage(conversation.id, parent.userMessageId);
      assert.equal(child.workflow.input.planFirst, true);
      await dispatch(restarted);
      await until(() => state(restarted, child.workflow.id).planReview === 'pending');
      assert.ok(f.starts.every((input) => !input.stepId && input.permissionMode === 'read-only'));
    });

for (const boundary of ['untrusted', 'side-chat'] as const)
  test(`planFirst cannot turn a ${boundary} reply into a build`, async (t) => {
    const f = fixture(t);
    const project = await f.workspace.createProject(f.directory);
    const main = f.workspace.createConversation(project.id);
    const conversation = boundary === 'side-chat' ? f.workspace.createConversation(project.id) : main;
    if (boundary === 'side-chat') {
      conversation.sideChat = {
        parentConversationId: main.id,
        context: '',
        selection: { provider: 'codex', executionPolicy: 'cli-only' },
      };
      f.workspace.store.save('conversation', conversation.id, project.id, conversation);
    }
    for (let round = 0; round < 2; round++) {
      const submitted = await f.workspace.send(conversation.id, {
        ...base,
        provider: 'codex',
        planFirst: true,
        queue: true,
        ...(boundary === 'untrusted' && round === 0 ? { untrustedContent: true } : {}),
      });
      assert.equal(submitted.workflow.input.planFirst, undefined);
      assert.equal(submitted.workflow.input.mode, 'chat');
      assert.equal(submitted.workflow.input.permissionMode, 'read-only');
      await dispatch(f.workspace);
      await until(() => state(f.workspace, submitted.workflow.id).status === 'completed');
      assert.equal(state(f.workspace, submitted.workflow.id).planReview, undefined);
    }
    assert.equal(f.starts.length, 2);
    assert.ok(f.starts.every((input) => input.stepId === 'reply' && input.permissionMode === 'read-only'));
    if (boundary === 'untrusted') assert.ok(f.starts.every((input) => input.untrustedContent));
  });

test('stable queue order is deadline, priority, then creation time', () => {
  const item = (id: string, schedule?: TaskSchedule, createdAt = epoch): Workflow =>
    ({ id, input: { ...base, schedule }, createdAt: new Date(createdAt).toISOString() }) as Workflow;
  const items = [
    item('normal'),
    item('high', { priority: 'high' }),
    item('later', { deadlineAt: new Date(epoch + 120000).toISOString() }),
    item('soon', { deadlineAt: new Date(epoch + 60000).toISOString() }),
    item('same-deadline-high', { deadlineAt: new Date(epoch + 60000).toISOString(), priority: 'high' }),
    item('normal-new', undefined, epoch + 1),
  ];
  assert.deepEqual(
    items.sort(compareQueuedWorkflows).map((w) => w.id),
    ['same-deadline-high', 'soon', 'later', 'high', 'normal', 'normal-new'],
  );
});

test('messages persist before launch and queued messages in one project execute by schedule', async (t) => {
  const f = fixture(t),
    project = await f.workspace.createProject(f.directory),
    conversation = f.workspace.createConversation(project.id);
  const normal = await f.workspace.send(conversation.id, { ...base, content: 'NORMAL_ONLY' });
  const high = await f.workspace.send(conversation.id, {
    ...base,
    content: 'HIGH_ONLY',
    schedule: { priority: 'high' },
  });
  const deadline = await f.workspace.send(conversation.id, {
    ...base,
    content: 'DEADLINE_ONLY',
    schedule: { deadlineAt: new Date(epoch + 600000).toISOString() },
  });
  assert.equal(f.starts.length, 0);
  assert.equal(f.workspace.store.messages(conversation.id).length, 3);
  assert.ok(f.workspace.store.queuedWorkflows().every((w) => w.status === 'queued' && !w.startedAt));
  for (let i = 0; i < 3; i++) await dispatch(f.workspace);
  assert.deepEqual(
    f.starts.map((input) => input.workflowId),
    [deadline.workflow.id, high.workflow.id, normal.workflow.id],
  );
  for (const entry of [normal, high, deadline]) assert.equal(state(f.workspace, entry.workflow.id).status, 'completed');
  const normalRun = f.starts.find((input) => input.workflowId === normal.workflow.id)!;
  assert.ok(
    !normalRun.prompt.includes('HIGH_ONLY') && !normalRun.prompt.includes('DEADLINE_ONLY'),
    'later queued requests must not become earlier task instructions',
  );
});

test('notBefore is durable, does not rebroadcast unchanged waits, and can be edited or cancelled', async (t) => {
  const f = fixture(t),
    project = await f.workspace.createProject(f.directory),
    conversation = f.workspace.createConversation(project.id);
  const submitted = await f.workspace.send(conversation.id, {
    ...base,
    schedule: {
      notBefore: new Date(epoch + 3600000).toISOString(),
      deadlineAt: new Date(epoch + 120000).toISOString(),
      estimatedMinutes: 10,
    },
  });
  await dispatch(f.workspace);
  const saved = state(f.workspace, submitted.workflow.id);
  assert.equal(saved.status, 'waiting-resource');
  assert.equal(saved.startedAt, undefined);
  assert.equal(saved.scheduling?.deadlineRisk, true);
  let broadcasts = 0;
  const observer = () => {
    broadcasts++;
  };
  f.controller.on('state', observer);
  await dispatch(f.workspace);
  assert.equal(broadcasts, 0);
  f.controller.off('state', observer);
  f.workspace.updateSchedule(saved.id, { priority: 'high' });
  await dispatch(f.workspace);
  assert.equal(state(f.workspace, saved.id).status, 'completed');
  assert.throws(() => f.workspace.updateSchedule(saved.id, {}), /尚未开始/);
  const cancelled = await f.workspace.send(conversation.id, {
    ...base,
    schedule: { notBefore: new Date(epoch + 3600000).toISOString() },
  });
  f.workspace.cancel(cancelled.workflow.id);
  f.advance(7200000);
  await dispatch(f.workspace);
  assert.equal(state(f.workspace, cancelled.workflow.id).status, 'cancelled');
  assert.equal(f.starts.length, 1);
});

test('capacity waits survive beyond two minutes and start when the slot becomes available', async (t) => {
  const f = fixture(t),
    project = await f.workspace.createProject(f.directory),
    conversation = f.workspace.createConversation(project.id);
  f.controller.updateSettings({ maxConcurrentRuns: 1 });
  const occupied = { id: 'occupied', status: 'running' } as RunRecord;
  f.controller.active.set(occupied.id, { run: occupied, abort: new AbortController(), project: 'different-project' });
  const submitted = await f.workspace.send(conversation.id, base);
  await dispatch(f.workspace);
  f.advance(10 * 60000);
  await dispatch(f.workspace);
  assert.equal(state(f.workspace, submitted.workflow.id).status, 'waiting-resource');
  assert.equal(f.starts.length, 0);
  f.controller.active.delete(occupied.id);
  await dispatch(f.workspace);
  assert.equal(state(f.workspace, submitted.workflow.id).status, 'completed');
  assert.equal(f.starts.length, 1);
});

test('quota rejection before launch stays unstarted, honours retry time, and retries after a refresh wake', async (t) => {
  const f = fixture(t),
    project = await f.workspace.createProject(f.directory),
    conversation = f.workspace.createConversation(project.id);
  let attempts = 0,
    available = false;
  t.mock.method(f.controller, 'start', async (input: RunInput) => {
    attempts++;
    if (!available) throw unavailable('quota', new Date(epoch + 3600000).toISOString());
    return f.complete(input);
  });
  const submitted = await f.workspace.send(conversation.id, base);
  await dispatch(f.workspace);
  const waiting = state(f.workspace, submitted.workflow.id);
  assert.equal(waiting.status, 'waiting-resource');
  assert.equal(waiting.startedAt, undefined);
  assert.deepEqual(waiting.runIds, []);
  assert.equal(f.workspace.store.messages(conversation.id).length, 1);
  f.advance(10 * 60000);
  await dispatch(f.workspace);
  assert.equal(attempts, 1);
  available = true;
  f.controller.emit('resources-refreshed');
  await dispatch(f.workspace);
  assert.equal(state(f.workspace, submitted.workflow.id).status, 'completed');
  assert.equal(attempts, 2);
});

test('configuration failures block instead of automatically retrying forever', async (t) => {
  const f = fixture(t),
    project = await f.workspace.createProject(f.directory),
    conversation = f.workspace.createConversation(project.id);
  let attempts = 0;
  t.mock.method(f.controller, 'start', async () => {
    attempts++;
    throw unavailable('unavailable');
  });
  const submitted = await f.workspace.send(conversation.id, base);
  await dispatch(f.workspace);
  f.advance(100000);
  await dispatch(f.workspace);
  assert.equal(state(f.workspace, submitted.workflow.id).status, 'blocked');
  assert.equal(attempts, 1);
});

test('refresh during a launch and ordinary broadcasts do not create a self-waking retry loop', async (t) => {
  const f = fixture(t, { autoTick: true, retryMs: 60000 }),
    project = await f.workspace.createProject(f.directory),
    conversation = f.workspace.createConversation(project.id);
  let attempts = 0,
    available = false;
  t.mock.method(f.controller, 'start', async (input: RunInput, _leaseId?: string, signal?: AbortSignal) => {
    attempts++;
    assert.ok(signal instanceof AbortSignal);
    await immediate();
    // Controller.start can refresh before routing; its notification happens while this launch is active.
    f.controller.emit('resources-refreshed');
    if (!available) throw unavailable('refresh', new Date(epoch + 3600000).toISOString());
    return f.complete(input);
  });
  const submitted = await f.workspace.send(conversation.id, base);
  await settle();
  await settle();
  assert.equal(attempts, 1);
  assert.equal(state(f.workspace, submitted.workflow.id).status, 'waiting-resource');
  for (let i = 0; i < 5; i++) f.controller.broadcast();
  await settle();
  assert.equal(attempts, 1);
  available = true;
  f.controller.emit('resources-refreshed');
  await settle();
  await settle();
  assert.equal(attempts, 2);
  assert.equal(state(f.workspace, submitted.workflow.id).status, 'completed');
});

test('shutdown preserves unstarted queued work for the next instance', async (t) => {
  const f = fixture(t),
    project = await f.workspace.createProject(f.directory),
    conversation = f.workspace.createConversation(project.id);
  const submitted = await f.workspace.send(conversation.id, base);
  for (const [event, listeners] of f.controllerListeners)
    assert.equal(f.controller.listenerCount(event), listeners.length + 1, `${event}: one workspace listener`);
  await f.workspace.close();
  assert.equal(state(f.workspace, submitted.workflow.id).status, 'queued');
  assert.equal(f.starts.length, 0);
  for (const [event, listeners] of f.controllerListeners)
    assert.deepEqual(f.controller.listeners(event), listeners, `${event}: workspace removed its listener`);
  const resumed = new Workspace(f.controller, {
    now: f.now,
    autoTick: false,
    retrieveMemory: (store, input) => retrieveLocalMemory(store, input, { inline: true }),
  });
  try {
    for (const [event, listeners] of f.controllerListeners)
      assert.equal(
        f.controller.listenerCount(event),
        listeners.length + 1,
        `${event}: one replacement workspace listener`,
      );
    await dispatch(resumed);
    assert.equal(state(resumed, submitted.workflow.id).status, 'completed');
    assert.equal(f.starts.length, 1);
  } finally {
    await resumed.close();
    for (const [event, listeners] of f.controllerListeners)
      assert.deepEqual(
        f.controller.listeners(event),
        listeners,
        `${event}: replacement workspace removed its listener`,
      );
  }
});

test('concurrent repeated continue creates one durable successor and never revives its parent', async (t) => {
  const f = fixture(t),
    project = await f.workspace.createProject(f.directory),
    conversation = f.workspace.createConversation(project.id);
  const submitted = await f.workspace.send(conversation.id, base);
  const original = state(f.workspace, submitted.workflow.id);
  original.status = 'blocked';
  f.workspace.store.save('workflow', original.id, conversation.id, original);
  // Importing before enqueue is asynchronous. Simultaneous continuation requests must still deduplicate
  // after that await, instead of all passing the initial successor lookup together.
  conversation.grokHistory = { syncedAt: original.updatedAt, sessions: 1, messages: 1 };
  f.workspace.store.save('conversation', conversation.id, project.id, conversation);
  const responses = await Promise.all(Array.from({ length: 12 }, () => f.workspace.continue(original.id)));
  const successor = responses[0]!.workflow;
  assert.ok(
    responses.every(
      (response) => response.workflow.id === successor.id && response.message.id === successor.userMessageId,
    ),
  );
  assert.equal(f.workspace.store.childWorkflows(original.id).length, 1);
  assert.equal(f.workspace.store.messages(conversation.id).filter((message) => message.role === 'user').length, 2);
  await dispatch(f.workspace);
  assert.equal(state(f.workspace, successor.id).status, 'completed');
  const reused = await f.workspace.continue(original.id, 'A new prompt must not replay the old continuation');
  assert.equal(reused.workflow.id, successor.id);
  assert.equal(reused.workflow.status, 'completed');
  assert.ok('reused' in reused && reused.reused);
  assert.match('notice' in reused ? reused.notice : '', /新消息/);
  assert.equal(f.starts.length, 1);
  assert.equal(f.workspace.store.childWorkflows(original.id).length, 1);
});

test('blocked continuation is returned as-is and only its own continue extends the successor chain', async (t) => {
  const f = fixture(t),
    project = await f.workspace.createProject(f.directory),
    conversation = f.workspace.createConversation(project.id);
  const submitted = await f.workspace.send(conversation.id, base),
    original = state(f.workspace, submitted.workflow.id);
  original.status = 'interrupted';
  f.workspace.store.save('workflow', original.id, conversation.id, original);
  const first = await f.workspace.continue(original.id),
    child = state(f.workspace, first.workflow.id);
  child.status = 'blocked';
  f.workspace.store.save('workflow', child.id, conversation.id, child);
  const duplicate = await f.workspace.continue(original.id);
  assert.equal(duplicate.workflow.id, child.id);
  assert.equal(duplicate.workflow.status, 'blocked');
  const [second, secondDuplicate] = await Promise.all([f.workspace.continue(child.id), f.workspace.continue(child.id)]);
  assert.equal(second.workflow.id, secondDuplicate.workflow.id);
  assert.equal((await f.workspace.continue(original.id)).workflow.id, second.workflow.id);
  assert.equal(f.workspace.store.childWorkflows(original.id).length, 1);
  assert.equal(f.workspace.store.childWorkflows(child.id).length, 1);
  assert.equal(f.starts.length, 0);
});

test('started workflows waiting for a later step retain their lease and shutdown as interrupted', async (t) => {
  const f = fixture(t),
    project = await f.workspace.createProject(f.directory),
    conversation = f.workspace.createConversation(project.id);
  let attempts = 0;
  t.mock.method(f.controller, 'start', async (input: RunInput) => {
    attempts++;
    if (attempts > 1) throw unavailable('quota', new Date(epoch + 3600000).toISOString());
    const run = f.complete(input);
    run.output = JSON.stringify({
      steps: [{ id: 'implement', title: 'Implement', instruction: 'Implement the requested change', kind: 'general' }],
    });
    f.controller.store.saveRun(run);
    return run;
  });
  // A change request, so the planner runs first; a request that changes nothing would go straight to one step.
  const active = await f.workspace.send(conversation.id, {
    ...base,
    content: 'Implement the requested change',
    mode: 'build',
    permissionMode: 'workspace-write',
  });
  await dispatch(f.workspace);
  assert.equal(state(f.workspace, active.workflow.id).status, 'waiting-resource');
  assert.ok(state(f.workspace, active.workflow.id).startedAt);
  assert.equal(state(f.workspace, active.workflow.id).runIds.length, 1);
  assert.throws(() => f.controller.reserveProject(project.path, 'competing'), /已有执行/);
  const queued = await f.workspace.send(conversation.id, base);
  await dispatch(f.workspace);
  await f.workspace.close();
  assert.equal(state(f.workspace, active.workflow.id).status, 'interrupted');
  assert.ok(['queued', 'waiting-resource'].includes(state(f.workspace, queued.workflow.id).status));
  assert.equal(attempts, 3, 'only the active workflow retries once after the new message wakes the queue');
});

test('unknown or stale quota waits back off from 30 seconds to 5 minutes instead of retrying every second', async (t) => {
  const f = fixture(t),
    project = await f.workspace.createProject(f.directory),
    conversation = f.workspace.createConversation(project.id);
  let attempts = 0,
    available = false;
  t.mock.method(f.controller, 'start', async (input: RunInput) => {
    attempts++;
    if (!available) throw unavailable('refresh');
    return f.complete(input);
  });
  const submitted = await f.workspace.send(conversation.id, base);
  const waits: number[] = [];
  for (let expected = 1; expected <= 6; expected++) {
    await dispatch(f.workspace);
    for (let i = 0; i < 20 && attempts < expected; i++) await settle();
    assert.equal(attempts, expected);
    const wait = Date.parse(state(f.workspace, submitted.workflow.id).scheduling!.nextAttemptAt!) - f.now();
    waits.push(wait);
    f.advance(wait - 1);
    await dispatch(f.workspace);
    assert.equal(attempts, expected, 'no retry before the wait ends');
    f.advance(1);
  }
  assert.deepEqual(waits, [30000, 60000, 120000, 240000, 300000, 300000]);
  available = true;
  await dispatch(f.workspace);
  for (let i = 0; i < 20 && state(f.workspace, submitted.workflow.id).status !== 'completed'; i++) await settle();
  assert.equal(state(f.workspace, submitted.workflow.id).status, 'completed');
});

test('a queued retry rediscovers the same runtime at most every 30 seconds', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'studio-task-queue-'));
  let clock = epoch;
  const controller = new Controller(directory, join(directory, 'data'), { now: () => clock });
  clearInterval(controller.timer);
  t.after(async () => {
    await controller.close();
    const cleanup = resolve(directory);
    assert.ok(cleanup.startsWith(resolve(tmpdir()) + sep) && basename(cleanup).startsWith('studio-task-queue-'));
    rmSync(cleanup, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  controller.targets = [
    { id: 'grok-a', provider: 'grok', label: 'Grok A', command: 'fixture-only', environment: 'native', enabled: true },
  ];
  controller.snapshots = [
    {
      id: 'grok-a',
      provider: 'grok',
      label: 'Grok A',
      environment: 'native',
      installed: true,
      status: 'ready',
      // This test covers refresh throttling before login is verified, not B's limited subscription attempt.
      authMode: 'unknown',
      models: [{ id: 'grok-model', label: 'Grok model', efforts: ['medium'] }],
      quota: { status: 'unknown', source: 'fixture', observedAt: null, windows: [] },
      capabilities: { execute: true, resume: true, cancel: true, approvals: true },
      refreshedAt: new Date(epoch).toISOString(),
    },
  ];
  const refreshed: Array<string[] | undefined> = [];
  t.mock.method(controller, 'refresh', async (options: { runtimeIds?: string[] } = {}) => {
    refreshed.push(options.runtimeIds);
  });
  const input: RunInput = { prompt: 'Explain this project', projectPath: directory, kind: 'general' };
  const attempt = () =>
    assert.rejects(
      controller.start(input),
      (error) => error instanceof RouteUnavailableError && error.kind === 'refresh',
    );
  await attempt();
  await attempt();
  assert.deepEqual(refreshed, [['grok-a']], 'quota still unknown after a fresh read: no second discovery');
  clock += 29_999;
  await attempt();
  assert.equal(refreshed.length, 1);
  clock += 1;
  await attempt();
  assert.deepEqual(refreshed, [['grok-a'], ['grok-a']]);
});

for (const pressure of ['cpu', 'memory'] as const) {
  test(pressure + ' pressure auto-queues a top-level run with one reason, then starts after recovery', async (t) => {
    const f = fixture(t);
    const project = await f.workspace.createProject(f.directory);
    const conversation = f.workspace.createConversation(project.id);
    let busy = true;
    t.mock.method(f.controller, 'machineReading', () => ({
      totalBytes: 16 * 1024 ** 3,
      cpus: 8,
      availableMemoryBytes: (pressure === 'memory' && busy ? 1.6 : 8) * 1024 ** 3,
      cpuPercent: pressure === 'cpu' && busy ? 92 : 20,
    }));
    f.controller.active.set('occupied', {
      run: { id: 'occupied', status: 'running' } as RunRecord,
      abort: new AbortController(),
      project: 'other',
    });
    t.after(() => f.controller.active.delete('occupied'));
    const submitted = await f.workspace.send(conversation.id, base);
    await dispatch(f.workspace);
    const waiting = state(f.workspace, submitted.workflow.id);
    assert.equal(waiting.status, 'waiting-resource');
    assert.equal(waiting.machineLoadChoice, undefined);
    assert.equal(waiting.scheduling?.reason, pressure === 'cpu' ? machineLoadReasons.cpu : machineLoadReasons.memory);
    assert.equal(f.starts.length, 0);
    busy = false;
    f.advance(3000);
    await dispatch(f.workspace);
    assert.equal(f.starts.length, 1);
    assert.equal(state(f.workspace, submitted.workflow.id).status, 'completed');
    f.controller.active.delete('occupied');
  });
}

for (const occupied of [false, true]) {
  test('composer starts through CPU pressure without a prompt, occupied=' + occupied, async (t) => {
    const f = fixture(t);
    const project = await f.workspace.createProject(f.directory);
    const conversation = f.workspace.createConversation(project.id);
    t.mock.method(f.controller, 'machineReading', () => ({
      totalBytes: 16 * 1024 ** 3,
      cpus: 8,
      availableMemoryBytes: 8 * 1024 ** 3,
      cpuPercent: 92,
    }));
    if (occupied)
      f.controller.active.set('occupied', {
        run: { status: 'running' } as RunRecord,
        abort: new AbortController(),
        project: 'other',
        parked: false,
      });
    try {
      const submitted = await f.workspace.send(conversation.id, base, undefined, undefined, {
        incomingUserMessage: true,
      });
      await dispatch(f.workspace);
      assert.equal(f.starts.length, 1);
      assert.equal(f.starts[0].bypassMachineLoad, true);
      assert.equal(state(f.workspace, submitted.workflow.id).status, 'completed');
      assert.notEqual(state(f.workspace, submitted.workflow.id).machineLoadChoice, 'pending');
    } finally {
      f.controller.active.delete('occupied');
    }
  });
}

for (const initialCpu of [20, 92]) {
  for (const losesMemory of [false, true]) {
    test(`composer rechecks load after preparation: CPU ${initialCpu}, memory drops ${losesMemory}`, async (t) => {
      const f = fixture(t);
      let cpuPercent = initialCpu;
      let availableMemoryBytes = 8 * 1024 ** 3;
      t.mock.method(f.controller, 'machineReading', () => ({
        totalBytes: 16 * 1024 ** 3,
        cpus: 8,
        cpuPercent,
        availableMemoryBytes,
      }));
      let prepares = 0;
      t.mock.method(f.controller, 'start', async (...args: Parameters<Controller['start']>) => {
        if (++prepares === 1) {
          await immediate();
          cpuPercent = 99;
          if (losesMemory) availableMemoryBytes = 1024 ** 3;
        }
        args[3]?.();
        const run = f.complete(args[0]);
        args[4]?.(run);
        return run;
      });
      const project = await f.workspace.createProject(f.directory);
      const conversation = f.workspace.createConversation(project.id);
      const submitted = await f.workspace.send(conversation.id, base, undefined, undefined, {
        incomingUserMessage: true,
      });
      await dispatch(f.workspace);
      assert.equal(prepares, 1);
      if (losesMemory) {
        const waiting = state(f.workspace, submitted.workflow.id);
        assert.equal(waiting.machineLoadChoice, 'wait');
        assert.equal(waiting.status, 'waiting-resource');
        assert.equal(waiting.runIds.length, 0);
        assert.equal(waiting.startedAt, undefined);
        assert.equal(f.starts.length, 0);
        availableMemoryBytes = 8 * 1024 ** 3;
        cpuPercent = 20;
        await dispatch(f.workspace);
      }
      assert.equal(f.starts.length, 1);
      assert.equal(f.starts[0].bypassMachineLoad, !losesMemory);
      assert.equal(state(f.workspace, submitted.workflow.id).status, 'completed');
    });
  }
}

for (const cap of ['machine', 'setting'] as const) {
  test('composer CPU bypass still honors the ' + cap + ' limit', async (t) => {
    const f = fixture(t);
    t.mock.method(f.controller, 'machineReading', () => ({
      totalBytes: 16 * 1024 ** 3,
      cpus: 8,
      cpuPercent: 99,
      availableMemoryBytes: 8 * 1024 ** 3,
    }));
    if (cap === 'setting') f.controller.settings.maxConcurrentRuns = 1;
    const count = cap === 'setting' ? 1 : localRunLimit({ totalBytes: 16 * 1024 ** 3, cpus: 8 }).limit;
    for (let i = 0; i < count; i++)
      f.controller.active.set('occupied-' + i, {
        run: { status: 'running' } as RunRecord,
        abort: new AbortController(),
        project: 'other',
        parked: false,
      });
    try {
      const project = await f.workspace.createProject(f.directory);
      const conversation = f.workspace.createConversation(project.id);
      const submitted = await f.workspace.send(conversation.id, base, undefined, undefined, {
        incomingUserMessage: true,
      });
      await dispatch(f.workspace);
      assert.equal(f.starts.length, 0);
      assert.equal(state(f.workspace, submitted.workflow.id).status, 'waiting-resource');
      assert.notEqual(state(f.workspace, submitted.workflow.id).machineLoadChoice, 'pending');
      f.controller.active.delete('occupied-0');
      await dispatch(f.workspace);
      assert.equal(f.starts.length, 1);
      assert.equal(f.starts[0].bypassMachineLoad, true);
    } finally {
      for (let i = 0; i < count; i++) f.controller.active.delete('occupied-' + i);
    }
  });
}

for (const legacyChoice of ['pending', 'once'] as const) {
  test('saved ' + legacyChoice + ' load state resumes quietly and cannot bypass low memory', async (t) => {
    const f = fixture(t);
    let availableMemoryBytes = 1024 ** 3;
    t.mock.method(f.controller, 'machineReading', () => ({
      totalBytes: 16 * 1024 ** 3,
      cpus: 8,
      cpuPercent: 20,
      availableMemoryBytes,
    }));
    const project = await f.workspace.createProject(f.directory);
    const conversation = f.workspace.createConversation(project.id);
    const submitted = await f.workspace.send(conversation.id, base, undefined, undefined, {
      incomingUserMessage: true,
    });
    const saved = state(f.workspace, submitted.workflow.id);
    saved.machineLoadChoice = legacyChoice;
    f.workspace.store.save('workflow', saved.id, saved.conversationId, saved);
    await dispatch(f.workspace);
    assert.equal(f.starts.length, 0);
    assert.equal(state(f.workspace, saved.id).machineLoadChoice, 'wait');
    availableMemoryBytes = 8 * 1024 ** 3;
    await dispatch(f.workspace);
    assert.equal(f.starts.length, 1);
    assert.equal(f.starts[0].bypassMachineLoad, false);
  });
}

test('an unattended idle machine starts one run even under CPU and memory pressure', async (t) => {
  const f = fixture(t);
  t.mock.method(f.controller, 'machineReading', () => ({
    totalBytes: 16 * 1024 ** 3,
    cpus: 8,
    availableMemoryBytes: 1024 ** 3,
    cpuPercent: 99,
  }));
  const project = await f.workspace.createProject(f.directory);
  const conversation = f.workspace.createConversation(project.id);
  const submitted = await f.workspace.send(conversation.id, base);
  await dispatch(f.workspace);
  assert.equal(f.starts.length, 1);
  assert.equal(state(f.workspace, submitted.workflow.id).status, 'completed');
});

for (const runtimeId of ['api-fixture', 'claude-native', 'codex-native'])
  test('ordinary greeting bypasses CPU pressure: ' + runtimeId, async (t) => {
    const f = fixture(t);
    t.mock.method(f.controller, 'machineReading', () => ({
      totalBytes: 32 * 1024 ** 3,
      cpus: 8,
      cpuPercent: 92,
      availableMemoryBytes: 3 * 1024 ** 3,
      sampledAt: Date.now(),
    }));
    const project = await f.workspace.createProject(f.directory);
    const conversation = f.workspace.createConversation(project.id);
    const submitted = await f.workspace.send(
      conversation.id,
      {
        ...base,
        content: '你好',
        runtimeId,
        model: 'model-fixture',
        effort: 'low',
        executionPolicy: runtimeId === 'api-fixture' ? 'api-only' : 'cli-first',
      },
      undefined,
      undefined,
      { incomingUserMessage: true },
    );
    await dispatch(f.workspace);
    assert.equal(f.starts.length, 1);
    assert.equal(f.starts[0]!.bypassMachineLoad, true);
    assert.equal(f.starts[0]!.runtimeId, runtimeId);
    assert.equal(f.starts[0]!.model, 'model-fixture');
    assert.equal(f.starts[0]!.effort, 'low');
    assert.equal(f.starts[0]!.permissionMode, 'read-only');
    assert.equal(f.starts[0]!.latencySensitiveChat, true);
    assert.equal(f.starts[0]!.selfContainedChat, undefined);
    const observations = state(f.workspace, submitted.workflow.id).machineLoadObservations!;
    assert.ok(observations.some((value) => value.idleChatAdmitted && value.cpuBusy && !value.memoryBusy));
    assert.ok(observations.every((value) => !!value.sourceSampledAt && value.sampleFresh));
  });

for (const runtimeId of ['api-fixture', 'claude-native', 'codex-native']) {
  for (const permissionMode of ['read-only', 'workspace-write'] as const) {
    test(`foreground news conversation starts at moderate memory pressure without changing ${runtimeId}/${permissionMode}`, async (t) => {
      const f = fixture(t);
      t.mock.method(f.controller, 'machineReading', () => ({
        totalBytes: 16 * 1024 ** 3,
        cpus: 8,
        cpuPercent: 37.56,
        availableMemoryBytes: 1_864_527_872,
        sampledAt: Date.now(),
      }));
      const project = await f.workspace.createProject(f.directory);
      const conversation = f.workspace.createConversation(project.id);
      const submitted = await f.workspace.send(
        conversation.id,
        {
          ...base,
          content: '海外有没有类似的倒卖球鞋受罚或封店的新闻？',
          runtimeId,
          model: 'model-fixture',
          effort: 'low',
          permissionMode,
          ...(permissionMode === 'workspace-write' ? { explicitWrite: true } : {}),
          ...(runtimeId === 'api-fixture' ? { quotes: [{ text: '之前讨论过公开新闻中的相关案例。' }] } : {}),
          executionPolicy: runtimeId === 'api-fixture' ? 'api-only' : 'cli-first',
        },
        undefined,
        undefined,
        { incomingUserMessage: true },
      );
      await dispatch(f.workspace);
      assert.equal(f.starts.length, 1);
      const started = f.starts[0]!;
      assert.equal(started.bypassMachineLoad, false);
      assert.equal(started.runtimeId, runtimeId);
      assert.equal(started.model, 'model-fixture');
      assert.equal(started.effort, 'low');
      assert.equal(started.permissionMode, permissionMode);
      assert.ok(
        state(f.workspace, submitted.workflow.id).machineLoadObservations?.some(
          (sample) => sample.idleChatAdmitted && sample.memoryBusy,
        ),
      );
    });
  }
}

for (const scenario of [
  'memory',
  'stale',
  'unknown',
  'wait',
  'unattended-human',
  'build',
  'review',
  'background',
] as const) {
  test('foreground admission cannot evade the load guard: ' + scenario, async (t) => {
    const f = fixture(t);
    t.mock.method(f.controller, 'machineReading', () => ({
      totalBytes: 32 * 1024 ** 3,
      cpus: 8,
      cpuPercent: 92,
      availableMemoryBytes: (scenario === 'memory' ? 1.5 : 1.74) * 1024 ** 3,
      ...(scenario === 'unknown' ? {} : { sampledAt: Date.now() - (scenario === 'stale' ? 4000 : 0) }),
    }));
    const project = await f.workspace.createProject(f.directory);
    const conversation = f.workspace.createConversation(project.id);
    const submitted = await f.workspace.send(
      conversation.id,
      {
        ...base,
        content: '海外有没有类似的倒卖球鞋受罚或封店的新闻？',
        ...(scenario === 'build' ? { mode: 'build' as const } : {}),
        ...(scenario === 'review' ? { review: true } : {}),
        ...(scenario === 'background' ? { backgroundTrigger: { kind: 'peer' as const, id: 'synthetic' } } : {}),
      },
      undefined,
      undefined,
      scenario === 'wait'
        ? { unattended: true }
        : scenario === 'unattended-human'
          ? { unattended: true, incomingUserMessage: true }
          : { incomingUserMessage: true },
    );
    await dispatch(f.workspace);
    assert.equal(f.starts.length, 0);
    const workflow = state(f.workspace, submitted.workflow.id);
    assert.equal(workflow.status, 'waiting-resource');
    assert.ok(!workflow.machineLoadObservations?.some((value) => value.idleChatAdmitted));
    if (scenario === 'wait' || scenario === 'unattended-human') assert.equal(workflow.machineLoadChoice, 'wait');
  });
}

test('quiet memory waits persist changed resource evidence without a status transition', async (t) => {
  const f = fixture(t);
  let cpuPercent = 92;
  let availableMemoryBytes = 1.5 * 1024 ** 3;
  t.mock.method(f.controller, 'machineReading', () => ({
    totalBytes: 32 * 1024 ** 3,
    cpus: 8,
    cpuPercent,
    availableMemoryBytes,
    sampledAt: Date.now(),
  }));
  const project = await f.workspace.createProject(f.directory);
  const conversation = f.workspace.createConversation(project.id);
  const submitted = await f.workspace.send(conversation.id, base, undefined, undefined, {
    incomingUserMessage: true,
  });
  await dispatch(f.workspace);
  const before = state(f.workspace, submitted.workflow.id);
  assert.equal(before.machineLoadChoice, 'wait');
  assert.equal(before.machineLoadObservations?.at(-1)?.cpuBusy, true);
  cpuPercent = 20;
  availableMemoryBytes = 1.5 * 1024 ** 3;
  await dispatch(f.workspace);
  const after = state(f.workspace, submitted.workflow.id);
  assert.equal(after.machineLoadChoice, 'wait');
  assert.equal(after.status, before.status);
  assert.equal(after.scheduling?.reason, machineLoadReasons.memory);
  assert.equal(after.machineLoadObservations?.at(-1)?.cpuBusy, false);
  assert.equal(after.machineLoadObservations?.at(-1)?.memoryBusy, true);
  assert.equal(after.machineLoadObservations?.at(-1)?.availableMemoryBytes, availableMemoryBytes);
  assert.ok(after.machineLoadObservations?.at(-1)?.sourceSampledAt);
  assert.equal(f.starts.length, 0);
});

test('two foreground news chats cannot both take the moderate-memory slot while the first is preparing', async (t) => {
  const f = fixture(t);
  let availableMemoryBytes = 1_864_527_872;
  t.mock.method(f.controller, 'machineReading', () => ({
    totalBytes: 32 * 1024 ** 3,
    cpus: 8,
    cpuPercent: 37.56,
    availableMemoryBytes,
    sampledAt: Date.now(),
  }));
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  let launches = 0;
  t.mock.method(f.controller, 'start', async (...args: Parameters<Controller['start']>) => {
    if (++launches === 1) await ready;
    args[3]?.(); // Recheck after preparation, immediately before synchronous run creation.
    const run = f.complete(args[0]);
    args[4]?.(run);
    return run;
  });
  const project = await f.workspace.createProject(f.directory);
  const firstConversation = f.workspace.createConversation(project.id);
  const secondConversation = f.workspace.createConversation(project.id);
  const input = { ...base, content: '海外有没有类似的倒卖球鞋受罚或封店的新闻？' };
  const first = await f.workspace.send(firstConversation.id, input, undefined, undefined, {
    incomingUserMessage: true,
  });
  try {
    await dispatch(f.workspace);
    assert.equal(launches, 1);
    const second = await f.workspace.send(secondConversation.id, input, undefined, undefined, {
      incomingUserMessage: true,
    });
    await dispatch(f.workspace);
    assert.equal(launches, 1, 'another pending start consumes the single idle allowance');
    const waiting = state(f.workspace, second.workflow.id);
    assert.equal(waiting.status, 'waiting-resource');
    assert.equal(waiting.machineLoadObservations?.at(-1)?.pendingStarts, 1);
    assert.equal(waiting.machineLoadObservations?.at(-1)?.idleChatAdmitted, false);
    release();
    await until(() => state(f.workspace, first.workflow.id).status === 'completed');
    availableMemoryBytes = 3 * 1024 ** 3;
    await dispatch(f.workspace);
    assert.equal(launches, 2);
    assert.equal(f.starts.length, 2);
    assert.ok(f.starts.every((value) => !value.bypassMachineLoad));
  } finally {
    release();
  }
});

test('foreground news chat rechecks critical memory after preparation before creating any run', async (t) => {
  const f = fixture(t);
  let availableMemoryBytes = 1_864_527_872;
  t.mock.method(f.controller, 'machineReading', () => ({
    totalBytes: 32 * 1024 ** 3,
    cpus: 8,
    cpuPercent: 37.56,
    availableMemoryBytes,
    sampledAt: Date.now(),
  }));
  let checks = 0;
  t.mock.method(f.controller, 'start', async (...args: Parameters<Controller['start']>) => {
    if (++checks === 1) {
      await immediate();
      availableMemoryBytes = 1.5 * 1024 ** 3;
    }
    args[3]?.(); // The real Controller invokes this after its last preparation await.
    const run = f.complete(args[0]);
    args[4]?.(run);
    return run;
  });
  const project = await f.workspace.createProject(f.directory);
  const conversation = f.workspace.createConversation(project.id);
  const submitted = await f.workspace.send(
    conversation.id,
    {
      ...base,
      content: '海外有没有类似的倒卖球鞋受罚或封店的新闻？',
    },
    undefined,
    undefined,
    { incomingUserMessage: true },
  );
  await dispatch(f.workspace);
  assert.equal(checks, 1);
  assert.equal(f.starts.length, 0);
  const waiting = state(f.workspace, submitted.workflow.id);
  assert.equal(waiting.status, 'waiting-resource');
  assert.equal(waiting.runIds.length, 0);
  assert.equal(waiting.machineLoadChoice, 'wait');
  assert.equal(waiting.machineLoadObservations?.at(-1)?.availableMemoryBytes, availableMemoryBytes);
  assert.equal(waiting.machineLoadObservations?.at(-1)?.idleChatAdmitted, false);
  assert.ok(waiting.machineLoadObservations?.some((value) => value.idleChatAdmitted));
  availableMemoryBytes = 3 * 1024 ** 3;
  await dispatch(f.workspace);
  assert.equal(f.starts.length, 1);
  assert.equal(f.starts[0]!.bypassMachineLoad, false);
});

test('a quiet memory wait remains queued at moderate pressure until normal capacity recovers', async (t) => {
  const f = fixture(t);
  let availableMemoryBytes = 1.5 * 1024 ** 3;
  t.mock.method(f.controller, 'machineReading', () => ({
    totalBytes: 16 * 1024 ** 3,
    cpus: 8,
    cpuPercent: 37.56,
    availableMemoryBytes,
    sampledAt: Date.now(),
  }));
  const project = await f.workspace.createProject(f.directory);
  const conversation = f.workspace.createConversation(project.id);
  const submitted = await f.workspace.send(
    conversation.id,
    { ...base, content: '海外有没有类似的倒卖球鞋受罚或封店的新闻？' },
    undefined,
    undefined,
    { incomingUserMessage: true },
  );
  await dispatch(f.workspace);
  assert.equal(state(f.workspace, submitted.workflow.id).machineLoadChoice, 'wait');
  availableMemoryBytes = 1_864_527_872;
  await dispatch(f.workspace);
  assert.equal(f.starts.length, 0);
  assert.equal(state(f.workspace, submitted.workflow.id).machineLoadChoice, 'wait');
  availableMemoryBytes = 3 * 1024 ** 3;
  await dispatch(f.workspace);
  assert.equal(f.starts.length, 1);
});

test('scheduled composer task waits for its time and then auto-queues by load without asking', async (t) => {
  const f = fixture(t);
  let cpuPercent = 92;
  t.mock.method(f.controller, 'machineReading', () => ({
    totalBytes: 16 * 1024 ** 3,
    cpus: 8,
    availableMemoryBytes: 8 * 1024 ** 3,
    cpuPercent,
  }));
  const project = await f.workspace.createProject(f.directory);
  const conversation = f.workspace.createConversation(project.id);
  const submitted = await f.workspace.send(
    conversation.id,
    { ...base, schedule: { notBefore: new Date(epoch + 60000).toISOString() } },
    undefined,
    undefined,
    { incomingUserMessage: true },
  );
  f.controller.active.set('occupied', {
    run: { status: 'running' } as RunRecord,
    abort: new AbortController(),
    project: 'other',
  });
  try {
    await dispatch(f.workspace);
    assert.equal(f.starts.length, 0);
    assert.equal(state(f.workspace, submitted.workflow.id).machineLoadChoice, undefined);
    f.advance(60000);
    await dispatch(f.workspace);
    assert.equal(f.starts.length, 0);
    assert.equal(state(f.workspace, submitted.workflow.id).scheduling?.reason, machineLoadReasons.cpu);
    cpuPercent = 20;
    await dispatch(f.workspace);
    assert.equal(f.starts.length, 1);
  } finally {
    f.controller.active.delete('occupied');
  }
});

test('composer memory pressure waits quietly and the existing timer starts it after recovery', async (t) => {
  const f = fixture(t, { autoTick: true, retryMs: 20 });
  let availableMemoryBytes = 1.6 * 1024 ** 3;
  t.mock.method(f.controller, 'machineReading', () => ({
    totalBytes: 16 * 1024 ** 3,
    cpus: 8,
    availableMemoryBytes,
    cpuPercent: 20,
  }));
  const project = await f.workspace.createProject(f.directory);
  const conversation = f.workspace.createConversation(project.id);
  const submitted = await f.workspace.send(conversation.id, base, undefined, undefined, { incomingUserMessage: true });
  const until = async (check: () => boolean) => {
    const end = Date.now() + 20_000;
    while (!check()) {
      assert.ok(Date.now() < end, 'timer-driven queue should advance');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  await until(() => state(f.workspace, submitted.workflow.id).machineLoadChoice === 'wait');
  assert.equal(state(f.workspace, submitted.workflow.id).scheduling?.reason, machineLoadReasons.memory);
  await until(() => state(f.workspace, submitted.workflow.id).status === 'waiting-resource');
  assert.equal(f.starts.length, 0);
  availableMemoryBytes = 8 * 1024 ** 3;
  await until(() => state(f.workspace, submitted.workflow.id).status === 'completed');
  assert.equal(f.starts.length, 1, 'no manual tick or resource event required');
});

test('a quiet memory wait automatically runs after recovery before a later message', async (t) => {
  const f = fixture(t);
  const project = await f.workspace.createProject(f.directory);
  const conversation = f.workspace.createConversation(project.id);
  let availableMemoryBytes = 1024 ** 3;
  t.mock.method(f.controller, 'machineReading', () => ({
    totalBytes: 16 * 1024 ** 3,
    cpus: 8,
    cpuPercent: 20,
    availableMemoryBytes,
  }));
  const first = await f.workspace.send(conversation.id, base, undefined, undefined, { incomingUserMessage: true });
  await dispatch(f.workspace);
  assert.equal(state(f.workspace, first.workflow.id).machineLoadChoice, 'wait');
  f.advance(1000);
  const second = await f.workspace.send(conversation.id, base, undefined, undefined, { incomingUserMessage: true });
  await dispatch(f.workspace);
  assert.equal(f.starts.length, 0);
  availableMemoryBytes = 8 * 1024 ** 3;
  await dispatch(f.workspace);
  assert.equal(f.starts[0]?.workflowId, first.workflow.id);
  await dispatch(f.workspace);
  assert.deepEqual(
    f.starts.map((run) => run.workflowId),
    [first.workflow.id, second.workflow.id],
  );
});

test('live load changes within one pressure band do not publish waiting tasks again', async (t) => {
  const f = fixture(t);
  const project = await f.workspace.createProject(f.directory);
  const conversation = f.workspace.createConversation(project.id);
  let cpuPercent = 90;
  t.mock.method(f.controller, 'machineReading', () => ({ totalBytes: 16 * 1024 ** 3, cpus: 8, cpuPercent }));
  const submitted = await f.workspace.send(conversation.id, base, undefined, undefined, { unattended: true });
  await dispatch(f.workspace);
  const previous = state(f.workspace, submitted.workflow.id);
  const broadcast = t.mock.method(f.controller, 'broadcast', () => {});
  f.advance(3000);
  cpuPercent = 98;
  await dispatch(f.workspace);
  assert.equal(broadcast.mock.callCount(), 0);
  assert.equal(state(f.workspace, submitted.workflow.id).updatedAt, previous.updatedAt);
});

test('an empty queue with no waiters does not start a busy breadcrumb', async (t) => {
  const f = fixture(t);
  const begin = t.mock.method(backendActivity, 'begin');
  await f.workspace.tickQueue();
  assert.equal(begin.mock.callCount(), 0);
});

test('launch status is committed with FULL before starting an executor', async (t) => {
  const f = fixture(t);
  const project = await f.workspace.createProject(f.directory);
  const conversation = f.workspace.createConversation(project.id);
  const submitted = await f.workspace.send(conversation.id, base);
  const save = f.workspace.store.save.bind(f.workspace.store);
  let sawFull = false;
  t.mock.method(f.workspace.store, 'save', (...args: Parameters<typeof save>) => {
    if (args[0] === 'workflow' && (args[3] as Workflow).status === 'running' && !(args[3] as Workflow).runIds.length) {
      sawFull ||= f.controller.store.db.prepare('PRAGMA synchronous').get()!.synchronous === 2;
    }
    return save(...args);
  });
  await dispatch(f.workspace);
  assert.ok(sawFull);
  assert.equal(state(f.workspace, submitted.workflow.id).status, 'completed');
  assert.equal(f.controller.store.db.prepare('PRAGMA synchronous').get()!.synchronous, 1);
});
