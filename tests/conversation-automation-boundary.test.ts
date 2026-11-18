import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import {
  ConversationAutomation,
  type ConversationActor,
  type ConversationJob,
  type PullObservation,
} from '../src/server/conversation-automation.ts';
import { WorkspaceStore } from '../src/server/workspace-store.ts';
import { LaneWorkspaceValidationError } from '../src/server/managed-worktrees.ts';
import { callConversationWork } from '../src/server/conversation-work-tools.ts';
import { Workspace } from '../src/server/workspace.ts';
import type { Conversation, MessageInput, Project, Workflow } from '../src/shared/types.ts';

const openPull = (checks: Partial<PullObservation['checks']> = {}): PullObservation => ({
  state: 'OPEN',
  draft: false,
  headSha: 'baseline',
  url: 'https://example.test/pull/1',
  reviewDecision: '',
  reviewRequests: 0,
  checks: { passed: 0, failed: 0, pending: 0, failing: [], ...checks },
});

function fixture(t: TestContext, pull: () => Promise<PullObservation> = async () => openPull()) {
  const db = new DatabaseSync(':memory:');
  const store = new WorkspaceStore(db, { recoverInterrupted: false });
  let now = Date.parse('2026-10-25T12:00:00Z');
  const stamp = () => new Date(now).toISOString();
  const project = {
    id: randomUUID(),
    path: process.cwd(),
    name: 'Boundary fixture',
    createdAt: stamp(),
    updatedAt: stamp(),
  } as Project;
  store.save('project', project.id, project.id, project);
  const conversation = (projectId = project.id) => {
    const value = {
      id: randomUUID(),
      projectId,
      title: 'Synthetic conversation',
      createdAt: stamp(),
      updatedAt: stamp(),
    } as Conversation;
    store.save('conversation', value.id, projectId, value);
    return value;
  };
  const source = conversation(),
    peer = conversation();
  const workflow = {
    id: randomUUID(),
    conversationId: source.id,
    projectId: project.id,
    status: 'completed',
    input: { permissionMode: 'read-only' },
    createdAt: stamp(),
    updatedAt: stamp(),
    runIds: [],
  } as unknown as Workflow;
  store.save('workflow', workflow.id, source.id, workflow);
  const requests: Array<{ conversationId: string; input: MessageInput; options: unknown }> = [];
  let failPrepare = false;
  let heldValidation: Promise<void> | undefined;
  let heldPreparation: Promise<void> | undefined;
  const workspace = {
    store,
    controller: { broadcast() {}, activeRunFor: () => undefined },
    memberResult: (_workflow: Workflow, text: string) => text,
    createConversation: (_projectId: string, title: string) => {
      const value = conversation();
      value.title = title;
      return value;
    },
    validateLaneWorkspace: async () => {
      if (heldValidation) await heldValidation;
    },
    prepareLaneWorkspace: async (conversationId: string) => {
      if (failPrepare) {
        failPrepare = false;
        throw new Error('Synthetic preparation interruption');
      }
      if (heldPreparation) await heldPreparation;
      return store.get<Conversation>('conversation', conversationId)!;
    },
    send: async (
      conversationId: string,
      input: MessageInput,
      _parent: unknown,
      _delegation: unknown,
      options: unknown,
    ) => {
      requests.push({ conversationId, input, options });
      const accepted = {
        id: randomUUID(),
        conversationId,
        projectId: project.id,
        input,
        status: 'completed',
        createdAt: stamp(),
        updatedAt: stamp(),
        runIds: [],
      } as unknown as Workflow;
      store.save('workflow', accepted.id, conversationId, accepted);
      return { workflow: accepted };
    },
  } as unknown as Workspace;
  const work = new ConversationAutomation(workspace, { now: () => now, pull });
  t.after(async () => {
    await work.close();
    db.close();
  });
  const actor: ConversationActor = {
    conversationId: source.id,
    workflowId: workflow.id,
    source: 'agent',
    write: false,
  };
  return {
    work,
    workspace,
    actor,
    store,
    source,
    peer,
    workflow,
    project,
    requests,
    advance: () => {
      now += 60000;
    },
    restart: () => {
      const restarted = new ConversationAutomation(workspace, { now: () => now, pull });
      t.after(() => restarted.close());
      return restarted;
    },
    failNextPrepare: () => {
      failPrepare = true;
    },
    holdValidation: () => {
      let release!: (error?: Error) => void;
      heldValidation = new Promise<void>((resolve, reject) => {
        release = (error) => (error ? reject(error) : resolve());
      });
      return release;
    },
    holdPrepare: () => {
      let release!: () => void;
      heldPreparation = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
    cancel: () => {
      workflow.status = 'cancelled';
      store.save('workflow', workflow.id, source.id, workflow);
    },
  };
}

test('a cancelled sender cannot wake a peer with its undelivered agent mail', async (t) => {
  const f = fixture(t);
  await f.work.message(f.actor, {
    requestId: randomUUID(),
    toConversationId: f.peer.id,
    text: 'Synthetic result.',
    wake: true,
  });
  f.cancel();
  await f.work.tick();
  assert.equal(f.requests.length, 0, 'cancelled source must revoke its pending automatic wake');
});

test('ordinary chats require explicit collaboration opt-in before an agent can create a persistent lane', async (t) => {
  const f = fixture(t);
  f.project.scope = 'chat';
  f.store.save('project', f.project.id, f.project.id, f.project);
  const request = { requestId: randomUUID(), title: 'Opt-in lane' };
  await assert.rejects(callConversationWork(f.work, f.actor, 'create_lane', request), /开启协作/);
  assert.equal(f.store.conversations(f.project.id).filter((item) => item.lane).length, 0);
  assert.equal(f.store.get('lane-request', request.requestId), undefined);
  f.work.settings(f.source.id, { collaborationEnabled: true, childWorkspaceMode: 'branch' });
  const lane = (await callConversationWork(f.work, f.actor, 'create_lane', request)) as Conversation;
  assert.equal(lane.lane?.parentConversationId, f.source.id);
  assert.equal(lane.projectId, f.project.id);
});

test('a lane created with a plan_id records it and adds the item its coordinator’s list lacks', async (t) => {
  const f = fixture(t);
  f.workflow.taskList = { items: [{ id: 'read', title: 'Read the code', kind: 'read' }], updatedAt: '2026-10-25' };
  f.store.save('workflow', f.workflow.id, f.source.id, f.workflow);
  Object.assign(f.workspace, {
    active: new Map(),
    now: () => '2026-10-25T12:00:00.000Z',
    publish: (workflow: Workflow) => f.store.save('workflow', workflow.id, workflow.conversationId, workflow),
    linkPlanItem: Workspace.prototype.linkPlanItem,
    taskListOwner: (Workspace.prototype as unknown as { taskListOwner: unknown }).taskListOwner,
  });
  const lane = (await callConversationWork(f.work, f.actor, 'create_lane', {
    requestId: randomUUID(),
    title: 'Fix the router',
    plan_id: 'router',
  })) as Conversation;
  assert.equal(lane.lane?.planItem, 'router');
  assert.deepEqual(f.store.get<Workflow>('workflow', f.workflow.id)!.taskList!.items, [
    { id: 'read', title: 'Read the code', kind: 'read' },
    { id: 'router', title: 'Fix the router', kind: 'read' },
  ]);
  assert.equal(f.work.list(f.source.id).lanes[0]?.planItem, 'router');
  await assert.rejects(
    callConversationWork(f.work, f.actor, 'create_lane', { requestId: randomUUID(), title: 'x', plan_id: 'has space' }),
  );
});

test('revoking ordinary collaboration while a lane prepares prevents its initial task from starting', async (t) => {
  const f = fixture(t);
  f.project.scope = 'chat';
  f.store.save('project', f.project.id, f.project.id, f.project);
  f.work.settings(f.source.id, { collaborationEnabled: true, childWorkspaceMode: 'branch' });
  const release = f.holdPrepare();
  const pending = callConversationWork(f.work, f.actor, 'create_lane', {
    requestId: randomUUID(),
    title: 'Pending lane',
    prompt: 'Read the status.',
  });
  f.work.settings(f.source.id, { collaborationEnabled: false, childWorkspaceMode: 'branch' });
  release();
  await assert.rejects(pending, /协作已关闭/);
  assert.equal(f.requests.length, 0);
});

test('a read-only agent cannot resume a paused writable job, but explicit human resume retains its authorized write mode', async (t) => {
  const f = fixture(t);
  const job = f.work.create(
    { conversationId: f.source.id, source: 'human', write: true },
    {
      requestId: randomUUID(),
      name: 'Authorized writing job',
      prompt: 'Update the synthetic file.',
      write: true,
      schedule: { type: 'interval', minutes: 1 },
    },
  );
  f.work.setEnabled(f.source.id, job.id, false);
  await assert.rejects(
    callConversationWork(f.work, f.actor, 'pause_scheduled_work', { jobId: job.id, enabled: true }),
    /只读任务不能恢复/,
  );
  assert.equal(f.store.get<ConversationJob>('conversation-job', job.id)?.enabled, false);
  f.work.setEnabled(f.source.id, job.id, true);
  f.advance();
  await f.work.tick();
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0]!.input.permissionMode, 'workspace-write');
  assert.equal(f.requests[0]!.input.explicitWrite, true);
});

test('a PR monitor rechecks source authorization after its asynchronous observation', async (t) => {
  let release!: (value: PullObservation) => void;
  let calls = 0;
  const f = fixture(t, async () =>
    ++calls === 1
      ? openPull()
      : new Promise((resolve) => {
          release = resolve;
        }),
  );
  f.work.create(f.actor, {
    requestId: randomUUID(),
    name: 'Synthetic checks',
    prompt: 'Read only.',
    schedule: { type: 'interval', minutes: 1 },
    pullRequest: { repository: 'synthetic/repository', number: 1 },
  });
  f.advance();
  await f.work.tick();
  f.advance();
  const pending = f.work.tick();
  await Promise.resolve();
  f.cancel();
  release(openPull({ passed: 1 }));
  await pending;
  assert.equal(f.requests.length, 0, 'source cancellation while gh is running must prevent dispatch');
});

test('closing a monitor during observation cannot start a new workflow', async (t) => {
  let release!: (value: PullObservation) => void;
  let calls = 0;
  const f = fixture(t, async () =>
    ++calls === 1
      ? openPull()
      : new Promise((resolve) => {
          release = resolve;
        }),
  );
  f.work.create(f.actor, {
    requestId: randomUUID(),
    name: 'Synthetic checks',
    prompt: 'Read only.',
    schedule: { type: 'interval', minutes: 1 },
    pullRequest: { repository: 'synthetic/repository', number: 1 },
  });
  f.advance();
  await f.work.tick();
  f.advance();
  const pending = f.work.tick();
  await Promise.resolve();
  const closing = f.work.close();
  release(openPull({ passed: 1 }));
  await Promise.all([pending, closing]);
  assert.equal(f.requests.length, 0, 'close revokes starting new paid work immediately');
});

test('lane results reach the coordinator before a slow PR poll', async (t) => {
  let release!: (value: PullObservation) => void;
  let calls = 0;
  const f = fixture(t, async () =>
    ++calls === 1
      ? openPull()
      : new Promise((resolve) => {
          release = resolve;
        }),
  );
  f.work.create(f.actor, {
    requestId: randomUUID(),
    name: 'Synthetic checks',
    prompt: 'Read only.',
    schedule: { type: 'interval', minutes: 1 },
    pullRequest: { repository: 'synthetic/repository', number: 1 },
  });
  f.advance();
  await f.work.tick();
  const lane = f.store.get<Conversation>('conversation', f.peer.id)!;
  lane.lane = { parentConversationId: f.source.id, sourceWorkflowId: f.workflow.id };
  f.store.save('conversation', lane.id, f.project.id, lane);
  const root = { ...f.workflow, id: randomUUID(), conversationId: lane.id };
  f.store.save('workflow', root.id, lane.id, root);
  f.advance();
  const pending = f.work.tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.store.list('conversation-mail', f.source.id).length, 1);
  assert.ok(f.store.get('lane-result', root.id));
  release(openPull());
  await pending;
});

test('create_lane records the issue it is given or the one its branch names', async (t) => {
  const f = fixture(t);
  const create = (args: Record<string, unknown>) =>
    callConversationWork(f.work, f.actor, 'create_lane', {
      requestId: randomUUID(),
      title: 'Issue lane',
      ...args,
    }) as Promise<Conversation>;
  assert.equal((await create({ issue: 123 })).lane?.github?.issue, 123);
  assert.equal((await create({ branch: 'alex/45-fix' })).lane?.github?.issue, 45);
  assert.equal((await create({ branch: 'alice/fix-thing' })).lane?.github, undefined);
  await assert.rejects(create({ issue: 0 }));
});

test('retrying an interrupted lane creation accepts its initial prompt once', async (t) => {
  const f = fixture(t);
  const request = {
    requestId: randomUUID(),
    title: 'Synthetic lane',
    prompt: 'Read the synthetic status.',
    base: 'origin/develop',
    branch: 'alice/x',
  };
  f.failNextPrepare();
  await assert.rejects(f.work.createLane(f.actor, request), /Synthetic preparation interruption/);
  const saved = f.store.conversations(f.project.id).find((item) => item.lane)!;
  assert.equal(saved.lane?.base, request.base);
  assert.equal(saved.lane?.branch, request.branch);
  const lane = await f.restart().createLane(f.actor, request);
  assert.equal(lane.id, saved.id);
  assert.equal(lane.lane?.base, request.base);
  assert.equal(lane.lane?.branch, request.branch);
  assert.equal(f.requests.length, 1, 'successful retry must enqueue the initial lane prompt');
  assert.equal(f.requests[0].conversationId, lane.id);
  assert.equal(f.requests[0].input.content, request.prompt);
});

test('concurrent lane requests with the same request ID share a single preflight', async (t) => {
  const f = fixture(t);
  const request = { requestId: randomUUID(), title: 'Concurrent lane', base: 'HEAD', branch: 'synthetic/lane' };
  const validation = t.mock.method(f.workspace, 'validateLaneWorkspace');
  const release = f.holdValidation();
  const first = f.work.createLane(f.actor, request);
  const second = f.work.createLane(f.actor, request);
  release();
  const created = await first;
  assert.equal((await second).id, created.id);
  assert.equal(validation.mock.callCount(), 1);
  assert.equal(f.store.conversations(f.project.id).filter((item) => item.lane).length, 1);
  assert.equal(f.store.get<{ conversationId: string }>('lane-request', request.requestId)?.conversationId, created.id);
});

test('a same-request retry waits for rollback even through another automation instance', async (t) => {
  const f = fixture(t);
  const request = { requestId: randomUUID(), title: 'Rollback race' };
  const failure = new LaneWorkspaceValidationError('Branch already exists');
  let entered!: () => void;
  const discarding = new Promise<void>((done) => {
    entered = done;
  });
  let release!: () => void;
  const held = new Promise<void>((done) => {
    release = done;
  });
  const attempted: string[] = [];
  const prepare = t.mock.method(f.workspace, 'prepareLaneWorkspace', async (id: string) => {
    attempted.push(id);
    throw failure;
  });
  f.workspace.discardFailedLaneWorkspace = async (id: string) => {
    entered();
    await held;
    f.store.deleteConversation(id);
    return true;
  };
  const first = assert.rejects(f.work.createLane(f.actor, request), failure);
  await discarding;
  const second = assert.rejects(f.restart().createLane(f.actor, request), failure);
  await new Promise<void>((done) => setImmediate(done));
  assert.equal(prepare.mock.callCount(), 1, 'retry must wait until the first request has finished rollback');
  release();
  await Promise.all([first, second]);
  assert.equal(new Set(attempted).size, 2, 'the retry must not prepare the deleted lane');
  assert.equal(f.store.conversations(f.project.id).filter((value) => value.lane).length, 0);
  assert.equal(f.store.get('lane-request', request.requestId), undefined);
  assert.ok(attempted.every((id) => f.store.get<Conversation>('conversation', id)?.deletedAt));
});

test('restart reuses a durably accepted wake older than the ordinary five minute message window', async (t) => {
  const f = fixture(t);
  const job = f.work.create(f.actor, {
    requestId: randomUUID(),
    name: 'Durable wake',
    prompt: 'Read the synthetic status.',
    schedule: { type: 'interval', minutes: 1 },
  });
  const eventId = randomUUID();
  const message = f.store.addMessage(f.source.id, 'user', job.prompt, f.workflow.id);
  message.clientMessageId = eventId;
  f.store.save('message', message.id, f.source.id, message);
  job.pending = { id: eventId, content: job.prompt };
  f.store.save('conversation-job', job.id, f.source.id, job);
  for (let i = 0; i < 10; i++) f.advance();
  await f.restart().tick();
  assert.equal(f.requests.length, 0, 'accepted durable event must not be sent twice after a restart');
  assert.equal(f.store.get<ConversationJob>('conversation-job', job.id)?.lastWorkflowId, f.workflow.id);
});

test('restart resumes an orphan durable message without adding a second user message', async (t) => {
  const f = fixture(t);
  const job = f.work.create(f.actor, {
    requestId: randomUUID(),
    name: 'Interrupted enqueue',
    prompt: 'Read the synthetic status.',
    schedule: { type: 'interval', minutes: 1 },
  });
  const eventId = randomUUID();
  const message = f.store.addMessage(f.source.id, 'user', job.prompt);
  message.clientMessageId = eventId;
  f.store.save('message', message.id, f.source.id, message);
  job.pending = { id: eventId, content: job.prompt };
  f.store.save('conversation-job', job.id, f.source.id, job);
  for (let i = 0; i < 10; i++) f.advance();
  await f.restart().tick();
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.requests[0].options, { unattended: true, existingUserMessageId: message.id });
});

test('a source conversation moved to another project cannot dispatch a stale job', async (t) => {
  const f = fixture(t);
  f.work.create(f.actor, {
    requestId: randomUUID(),
    name: 'Bound job',
    prompt: 'Read only.',
    schedule: { type: 'interval', minutes: 1 },
  });
  const otherProject = { ...f.project, id: randomUUID() };
  f.store.save('project', otherProject.id, otherProject.id, otherProject);
  f.source.projectId = otherProject.id;
  f.store.save('conversation', f.source.id, otherProject.id, f.source);
  f.advance();
  await f.work.tick();
  assert.equal(f.requests.length, 0);
});

test('a project purge tombstone prevents old mail from waking a peer', async (t) => {
  const f = fixture(t);
  await f.work.message(f.actor, {
    requestId: randomUUID(),
    toConversationId: f.peer.id,
    text: 'Synthetic result.',
    wake: true,
  });
  f.store.save('project-purge', f.project.id, f.project.id, { startedAt: '2026-10-25T12:00:01Z' });
  await f.work.tick();
  assert.equal(f.requests.length, 0);
});

test('background sources cannot create or reactivate recurring work', async (t) => {
  const f = fixture(t);
  const request = {
    requestId: randomUUID(),
    name: 'Foreground interval',
    prompt: 'Read only.',
    schedule: { type: 'interval' as const, minutes: 1 },
  };
  const job = f.work.create(f.actor, request);
  f.work.setEnabled(f.source.id, job.id, false);
  f.workflow.input.backgroundTrigger = { kind: 'peer', id: randomUUID() };
  f.store.save('workflow', f.workflow.id, f.source.id, f.workflow);
  assert.throws(() => f.work.create(f.actor, { ...request, requestId: randomUUID() }), /后台唤醒/);
  await assert.rejects(
    callConversationWork(f.work, f.actor, 'pause_scheduled_work', { jobId: job.id, enabled: true }),
    /后台唤醒/,
  );
  await assert.rejects(
    f.work.createLane(f.actor, { requestId: randomUUID(), title: 'Forbidden recursive lane' }),
    /后台唤醒/,
  );
});

function delegatedFixture(t: TestContext) {
  const f = fixture(t);
  const child: Workflow = {
    ...f.workflow,
    id: randomUUID(),
    input: { ...f.workflow.input, permissionMode: 'workspace-write' },
    delegation: { parentId: f.workflow.id, requestId: randomUUID(), role: 'worker', scope: ['src/synthetic.ts'] },
  };
  f.store.save('workflow', child.id, f.source.id, child);
  return { ...f, childActor: { ...f.actor, workflowId: child.id, write: true } };
}

const delegatedWorkError = {
  message: '子任务不能创建或恢复定时、监控或工作线；请交给主协调任务安排。',
};
const syntheticJob = () => ({
  requestId: randomUUID(),
  name: 'Synthetic scheduled work',
  prompt: 'Read the synthetic status.',
  schedule: { type: 'interval' as const, minutes: 1 },
});

for (const origin of ['external', 'caller', 'device'] as const) {
  for (const tool of ['schedule_work', 'watch_pull_request'] as const) {
    test(`${origin} dispatch cannot create or resume ${tool}, but a user-message task can`, async (t) => {
      const f = fixture(t);
      f.workflow.input.permissionOrigin = { mode: 'read-only', source: 'user' };
      f.store.save('workflow', f.workflow.id, f.source.id, f.workflow);
      const request = syntheticJob();
      const args =
        tool === 'schedule_work'
          ? request
          : {
              requestId: request.requestId,
              name: request.name,
              prompt: request.prompt,
              repository: 'synthetic/repo',
              number: 1,
            };
      const job = (await callConversationWork(f.work, f.actor, tool, args)) as ConversationJob;
      await callConversationWork(f.work, f.actor, 'pause_scheduled_work', { jobId: job.id, enabled: false });
      await callConversationWork(f.work, f.actor, 'pause_scheduled_work', { jobId: job.id, enabled: true });
      f.workflow.input.permissionOrigin = { mode: 'read-only', source: origin };
      f.store.save('workflow', f.workflow.id, f.source.id, f.workflow);
      await callConversationWork(f.work, f.actor, 'pause_scheduled_work', { jobId: job.id, enabled: false });
      await assert.rejects(
        callConversationWork(f.work, f.actor, tool, { ...args, requestId: randomUUID() }),
        /外部派来的任务不能创建或恢复/,
      );
      await assert.rejects(
        callConversationWork(f.work, f.actor, 'pause_scheduled_work', { jobId: job.id, enabled: true }),
        /外部派来的任务不能创建或恢复/,
      );
      assert.throws(() => f.work.setEnabled(f.source.id, job.id, true, f.actor), /外部派来的任务不能创建或恢复/);
      assert.equal(f.work.list(f.source.id).jobs.length, 1);
      assert.equal(f.store.get<ConversationJob>('conversation-job', job.id)?.enabled, false);
      assert.equal(f.requests.length, 0);
    });
  }

  test(`${origin} dispatch cannot create or recover a lane, but a user-message task can`, async (t) => {
    const f = fixture(t);
    f.workflow.input.permissionOrigin = { mode: 'read-only', source: 'user' };
    f.store.save('workflow', f.workflow.id, f.source.id, f.workflow);
    const request = { requestId: randomUUID(), title: 'Foreground lane', prompt: 'Read the synthetic status.' };
    const lane = (await callConversationWork(f.work, f.actor, 'create_lane', request)) as Conversation;
    assert.equal(((await callConversationWork(f.work, f.actor, 'create_lane', request)) as Conversation).id, lane.id);
    const interrupted = { ...request, requestId: randomUUID(), title: 'Interrupted lane' };
    f.failNextPrepare();
    await assert.rejects(callConversationWork(f.work, f.actor, 'create_lane', interrupted), /Synthetic preparation/);
    const accepted = f.requests.length;
    f.workflow.input.permissionOrigin = { mode: 'read-only', source: origin };
    f.store.save('workflow', f.workflow.id, f.source.id, f.workflow);
    for (const args of [request, interrupted, { ...request, requestId: randomUUID() }])
      await assert.rejects(callConversationWork(f.work, f.actor, 'create_lane', args), /外部派来的任务不能创建或恢复/);
    assert.equal(f.store.conversations(f.project.id).filter((item) => item.lane).length, 2);
    assert.equal(f.requests.length, accepted);
  });
}

for (const tool of ['schedule_work', 'watch_pull_request'] as const) {
  test(`a delegated write child cannot create ${tool}`, async (t) => {
    const f = delegatedFixture(t);
    const request = syntheticJob();
    const args =
      tool === 'schedule_work'
        ? { ...request, write: true }
        : {
            requestId: request.requestId,
            name: request.name,
            prompt: request.prompt,
            repository: 'synthetic/repo',
            number: 1,
          };
    await assert.rejects(callConversationWork(f.work, f.childActor, tool, args), delegatedWorkError);
    assert.equal(f.work.list(f.source.id).jobs.length, 0);
    assert.equal(f.requests.length, 0);
  });
}

test('a delegated write child cannot create a lane', async (t) => {
  const f = delegatedFixture(t);
  const request = { requestId: randomUUID(), title: 'Synthetic child lane', write: true };
  await assert.rejects(callConversationWork(f.work, f.childActor, 'create_lane', request), delegatedWorkError);
  assert.equal(f.store.conversations(f.project.id).filter((item) => item.lane).length, 0);
  assert.equal(f.store.get('lane-request', request.requestId), undefined);
  assert.equal(f.requests.length, 0);
});

test('a delegated write child cannot re-enable a paused job', async (t) => {
  const f = delegatedFixture(t);
  const job = f.work.create(
    { conversationId: f.source.id, source: 'human', write: true },
    { ...syntheticJob(), write: true },
  );
  f.work.setEnabled(f.source.id, job.id, false);
  await assert.rejects(
    callConversationWork(f.work, f.childActor, 'pause_scheduled_work', { jobId: job.id, enabled: true }),
    delegatedWorkError,
  );
  assert.equal(f.store.get<ConversationJob>('conversation-job', job.id)?.enabled, false);
});

test('a delegated write child can still pause and delete jobs', async (t) => {
  const f = delegatedFixture(t);
  const job = f.work.create(f.actor, syntheticJob());
  await callConversationWork(f.work, f.childActor, 'pause_scheduled_work', { jobId: job.id, enabled: false });
  assert.equal(f.store.get<ConversationJob>('conversation-job', job.id)?.enabled, false);
  assert.deepEqual(await callConversationWork(f.work, f.childActor, 'delete_scheduled_work', { jobId: job.id }), {
    ok: true,
  });
  assert.equal(f.store.get('conversation-job', job.id), undefined);
});

for (const source of ['agent', 'human'] as const) {
  test(`a non-delegated ${source} can still create a scheduled job`, async (t) => {
    const f = fixture(t);
    const actor: ConversationActor =
      source === 'agent' ? f.actor : { conversationId: f.source.id, source, write: true };
    const job = (await callConversationWork(f.work, actor, 'schedule_work', syntheticJob())) as ConversationJob;
    assert.equal(job.enabled, true);
    assert.equal(f.store.get<ConversationJob>('conversation-job', job.id)?.id, job.id);
  });
}

test('background replies are stored without another wake and remain idempotent on retry', async (t) => {
  const f = fixture(t);
  f.workflow.input.backgroundTrigger = { kind: 'peer', id: randomUUID() };
  f.store.save('workflow', f.workflow.id, f.source.id, f.workflow);
  const request = {
    requestId: randomUUID(),
    toConversationId: f.peer.id,
    text: 'Synthetic acknowledgement.',
    wake: true,
  };
  const first = await f.work.message(f.actor, request);
  assert.equal(first.wake, false);
  assert.equal((await f.work.message(f.actor, request)).id, first.id);
  await f.work.tick();
  assert.equal(f.requests.length, 0);
});

test('a completed initial lane prompt wakes its coordinator once', async (t) => {
  const f = fixture(t);
  await f.work.createLane(f.actor, {
    requestId: randomUUID(),
    title: 'Synthetic lane',
    prompt: 'Read the synthetic status.',
  });
  assert.equal(f.requests.length, 1);
  await f.work.tick();
  assert.equal(f.requests.length, 2, 'the initial lane is foreground work whose result wakes its parent');
  assert.equal(f.requests[1].conversationId, f.source.id);
  await f.work.tick();
  assert.equal(f.requests.length, 2, 'the same lane result cannot repeatedly wake its coordinator');
});

test('a settled lane root is reported once even when a newer lane root is already running', async (t) => {
  const f = fixture(t);
  const lane = await f.work.createLane(f.actor, { requestId: randomUUID(), title: 'Persistent lane' });
  const completed = { ...f.workflow, id: randomUUID(), conversationId: lane.id, createdAt: '2026-10-25T12:00:01Z' };
  const final = f.store.addMessage(lane.id, 'assistant', 'Completed result A.', completed.id);
  completed.finalMessageId = final.id;
  f.store.save('workflow', completed.id, lane.id, completed);
  const newer = {
    ...completed,
    id: randomUUID(),
    status: 'running' as const,
    finalMessageId: undefined,
    createdAt: '2026-10-25T12:00:02Z',
  };
  f.store.save('workflow', newer.id, lane.id, newer);
  f.workflow.status = 'running';
  f.store.save('workflow', f.workflow.id, f.source.id, f.workflow);
  await f.work.tick();
  const mail = f.work.list(f.source.id).messages;
  assert.equal(mail.length, 1);
  assert.match(mail[0]!.text, /Completed result A/);
  assert.equal(mail[0]!.deliveredAt, undefined, 'busy coordinator keeps the durable result pending');
  assert.ok(f.store.get('lane-result', completed.id));
  assert.equal(f.store.get('lane-result', newer.id), undefined);
  assert.equal(f.requests.length, 0);
  f.workflow.status = 'completed';
  f.store.save('workflow', f.workflow.id, f.source.id, f.workflow);
  await f.work.tick();
  await f.work.tick();
  assert.equal(f.requests.length, 1);
  assert.match(f.requests[0]!.input.content, /Completed result A/);
  assert.equal(f.work.list(f.source.id).messages.length, 1);
});

test('a lane without input content sends its result and writes a handover', async (t) => {
  const f = fixture(t);
  const dataDir = mkdtempSync(join(tmpdir(), 'pugport-handover-boundary-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  (f.workspace.controller as unknown as { dataDir: string }).dataDir = dataDir;
  const lane = await f.work.createLane(f.actor, { requestId: randomUUID(), title: 'Synthetic lane' });
  const completed = { ...f.workflow, id: randomUUID(), conversationId: lane.id };
  const final = f.store.addMessage(lane.id, 'assistant', 'Synthetic result.', completed.id);
  completed.finalMessageId = final.id;
  f.store.save('workflow', completed.id, lane.id, completed);
  await f.work.tick();
  const mail = f.work.list(f.source.id).messages;
  assert.equal(mail.length, 1);
  assert.match(mail[0]!.text, /Synthetic result\./);
  const path = join(dataDir, 'member-results', lane.id, 'handover.md');
  assert.ok(existsSync(path));
  assert.match(readFileSync(path, 'utf8'), /工作线交接单/);
  assert.equal(f.store.get<{ handoverPath: string }>('lane-result', completed.id)?.handoverPath, path);
});

test('a handover failure does not block the result mail or settlement record', async (t) => {
  const f = fixture(t);
  const dataDir = mkdtempSync(join(tmpdir(), 'pugport-handover-failure-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const controller = f.workspace.controller as unknown as { dataDir: string; store: { run: () => never } };
  controller.dataDir = dataDir;
  controller.store = {
    run: () => {
      throw Error('Synthetic audit read failure');
    },
  };
  const lane = await f.work.createLane(f.actor, { requestId: randomUUID(), title: 'Synthetic lane' });
  const completed = { ...f.workflow, id: randomUUID(), conversationId: lane.id, runIds: [randomUUID()] };
  const final = f.store.addMessage(lane.id, 'assistant', 'Synthetic result.', completed.id);
  completed.finalMessageId = final.id;
  f.store.save('workflow', completed.id, lane.id, completed);
  await f.work.tick();
  assert.equal(f.work.list(f.source.id).messages.length, 1);
  assert.ok(f.store.get('lane-result', completed.id));
  assert.equal(existsSync(join(dataDir, 'member-results', lane.id, 'handover.md')), false);
});

test('settlement without a data directory skips handover preparation', async (t) => {
  const f = fixture(t);
  let readRuns = 0;
  (f.workspace.controller as unknown as { store: { run: () => never } }).store = {
    run: () => {
      readRuns++;
      throw Error('Unexpected audit read');
    },
  };
  const lane = await f.work.createLane(f.actor, { requestId: randomUUID(), title: 'Synthetic lane' });
  const completed = { ...f.workflow, id: randomUUID(), conversationId: lane.id, runIds: [randomUUID()] };
  f.store.save('workflow', completed.id, lane.id, completed);
  await f.work.tick();
  assert.equal(readRuns, 0);
  assert.equal(f.work.list(f.source.id).messages.length, 1);
  assert.ok(f.store.get('lane-result', completed.id));
});

for (const state of ['running-root', 'background-media-wait'] as const) {
  test(`newer completed children cannot make ${state} look idle to scheduled work or peer mail`, async (t) => {
    const f = fixture(t);
    f.work.create(f.actor, {
      requestId: randomUUID(),
      name: 'Idle-only wake',
      prompt: 'Read the status.',
      schedule: { type: 'interval', minutes: 1 },
    });
    await f.work.message(
      { conversationId: f.peer.id, source: 'human', write: false },
      { requestId: randomUUID(), toConversationId: f.source.id, text: 'Pending peer information.', wake: true },
    );
    f.workflow.status = state === 'running-root' ? 'running' : 'blocked';
    if (state === 'background-media-wait')
      f.workflow.waitingOn = { kind: 'media-analysis', jobId: randomUUID(), done: 0, total: 1 };
    f.store.save('workflow', f.workflow.id, f.source.id, f.workflow);
    const child = {
      ...f.workflow,
      id: randomUUID(),
      status: 'completed' as const,
      waitingOn: undefined,
      createdAt: '2026-10-25T12:00:01Z',
      delegation: { parentId: f.workflow.id, requestId: randomUUID() },
    };
    f.store.save('workflow', child.id, f.source.id, child);
    f.advance();
    await f.work.tick();
    assert.equal(f.requests.length, 0);
    assert.equal(f.work.list(f.source.id).messages[0]!.deliveredAt, undefined);
    assert.ok(f.work.list(f.source.id).jobs[0]!.pending);
    f.workflow.status = 'completed';
    delete f.workflow.waitingOn;
    f.store.save('workflow', f.workflow.id, f.source.id, f.workflow);
    await f.work.tick();
    assert.equal(f.requests.length, 2, 'both durable items dispatch only after the real root is idle');
  });
}

test('cancelling a coordinator during lane preparation prevents its initial task from starting', async (t) => {
  const f = fixture(t);
  const release = f.holdPrepare();
  const creation = f.work.createLane(f.actor, {
    requestId: randomUUID(),
    title: 'Synthetic lane',
    prompt: 'Read the synthetic status.',
  });
  await Promise.resolve();
  f.cancel();
  release();
  await assert.rejects(creation, /授权|停止|取消/);
  assert.equal(f.requests.length, 0);
});

test('disabled history cannot hide the active-job ceiling during creation or resume', (t) => {
  const f = fixture(t);
  const request = {
    requestId: randomUUID(),
    name: 'Bounded interval',
    prompt: 'Read only.',
    schedule: { type: 'interval' as const, minutes: 1 },
  };
  const paused = f.work.create(f.actor, request);
  f.work.setEnabled(f.source.id, paused.id, false);
  for (let i = 0; i < 20; i++) {
    const active = { ...paused, id: randomUUID(), requestId: randomUUID(), enabled: true };
    f.store.save('conversation-job', active.id, f.source.id, active);
    f.store.db
      .prepare("UPDATE workspace_records SET updated_at='2020-01-01T00:00:00Z' WHERE kind='conversation-job' AND id=?")
      .run(active.id);
  }
  for (let i = 0; i < 201; i++) {
    const historic = { ...paused, id: randomUUID(), requestId: randomUUID(), enabled: false };
    f.store.save('conversation-job', historic.id, f.source.id, historic);
  }
  assert.throws(() => f.work.create(f.actor, { ...request, requestId: randomUUID() }), /上限/);
  assert.throws(() => f.work.setEnabled(f.source.id, paused.id, true), /上限/);
});

test('job creation keeps its request idempotency after the job leaves the recent-history page', (t) => {
  const f = fixture(t);
  const request = {
    requestId: randomUUID(),
    name: 'Durable request',
    prompt: 'Read only.',
    schedule: { type: 'interval' as const, minutes: 1 },
  };
  const original = f.work.create(f.actor, request);
  f.work.setEnabled(f.source.id, original.id, false);
  f.store.db
    .prepare("UPDATE workspace_records SET updated_at='2020-01-01T00:00:00Z' WHERE kind='conversation-job' AND id=?")
    .run(original.id);
  for (let i = 0; i < 201; i++) {
    const historic = { ...original, id: randomUUID(), requestId: randomUUID(), enabled: false };
    f.store.save('conversation-job', historic.id, f.source.id, historic);
  }
  assert.equal(
    f.work.create(f.actor, request).id,
    original.id,
    'retry cannot create another recurring job just because history was paginated',
  );
});
