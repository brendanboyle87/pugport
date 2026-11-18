import { idleMachineReading } from './helpers/machine-reading.ts';
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { Controller } from '../src/server/controller.ts';
import { Workspace } from '../src/server/workspace.ts';
import { GrokHistorySyncWorker } from '../src/server/grok-history-worker-client.ts';
import type { MessageInput, RunInput, RunRecord, Workflow } from '../src/shared/types.ts';

const input: MessageInput = {
  content: 'Synthetic current question',
  mode: 'chat',
  permissionMode: 'read-only',
  executionPolicy: 'cli-first',
};
function fixture(t: TestContext) {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'comborunner-workflow-lifecycle-')));
  const previousMemory = process.env.COMBORUNNER_MEMORY_DIR;
  process.env.COMBORUNNER_MEMORY_DIR = join(directory, 'memory');
  const controller = new Controller(directory, join(directory, 'data'));
  clearInterval(controller.timer);
  t.mock.method(controller, 'machineReading', idleMachineReading);
  controller.settings.decisionMode = 'auto';
  const workspace = new Workspace(controller, { autoTick: false });
  const calls: RunInput[] = [];
  const complete = (request: RunInput): RunRecord => {
    calls.push(request);
    const run: RunRecord = {
      id: randomUUID(),
      prompt: request.prompt,
      projectPath: request.projectPath,
      kind: request.kind,
      status: 'completed',
      route: { runtimeId: 'fixture', model: 'fixture', kind: request.kind, reasons: [], warnings: [] },
      startedAt: new Date().toISOString(),
      output: 'Synthetic answer',
      events: [],
      workflowId: request.workflowId,
      stepId: request.stepId,
      permissionMode: request.permissionMode,
    };
    controller.store.saveRun(run);
    return run;
  };
  t.mock.method(controller, 'start', async (request: RunInput) => complete(request));
  t.after(async () => {
    await workspace.close();
    await controller.close();
    const absolute = resolve(directory);
    assert.ok(absolute.startsWith(realpathSync.native(tmpdir()) + sep));
    assert.ok(basename(absolute).startsWith('comborunner-workflow-lifecycle-'));
    rmSync(absolute, { recursive: true, force: true });
    if (previousMemory === undefined) delete process.env.COMBORUNNER_MEMORY_DIR;
    else process.env.COMBORUNNER_MEMORY_DIR = previousMemory;
  });
  return { workspace, controller, directory, calls, complete };
}
const saved = (workspace: Workspace, id: string) => workspace.store.get<Workflow>('workflow', id)!;
test('ordinary chats require collaboration to create or resume user-visible children while ordinary API chat still runs', async (t) => {
  const f = fixture(t);
  const project = await f.workspace.createProject(f.directory);
  const conversation = f.workspace.createConversation(project.id);
  const first = await f.workspace.send(conversation.id, input);
  block(f.workspace, first.workflow);
  const child = await f.workspace.delegate(first.workflow.id, 'scout', 'Read the project', 'legacy-child');
  block(f.workspace, child.workflow);
  const queuedChild = await f.workspace.delegate(first.workflow.id, 'scout', 'Waiting child', 'queued-child');
  project.scope = 'chat';
  f.workspace.store.save('project', project.id, project.id, project);
  assert.match(f.workspace.delegationParent(conversation.id).reason ?? '', /请先开启.*协作/);
  await assert.rejects(f.workspace.delegate(first.workflow.id, 'scout', 'New child', 'new-child'), /请先开启.*协作/);
  await assert.rejects(
    f.workspace.delegateToAgent(first.workflow.id, { provider: 'codex', label: 'Codex' }, 'Read'),
    /请先开启.*协作/,
  );
  await assert.rejects(
    f.workspace.delegateBatch(first.workflow.id, [
      { id: 'part', dependsOn: [], agent: { provider: 'codex', label: 'Codex' }, task: 'Read', options: {} },
    ]),
    /请先开启.*协作/,
  );
  await assert.rejects(
    f.workspace.send(conversation.id, input, undefined, {
      parentId: first.workflow.id,
      role: 'scout',
      requestId: 'direct',
    }),
    /请先开启.*协作/,
  );
  await assert.rejects(f.workspace.continue(child.workflow.id), /请先开启.*协作/);
  await assert.rejects(f.workspace.send(conversation.id, { ...input, swarm: true }), /请先开启.*协作/);
  assert.equal(
    f.workspace.swarmSnapshot(conversation.id).workflows.some((value) => value.id === child.workflow.id),
    true,
  );
  assert.ok(f.workspace.archiveWorkflow(child.workflow.id, true).archivedAt, 'legacy children remain manageable');
  assert.equal(f.workspace.archiveWorkflow(child.workflow.id, false).archivedAt, undefined);
  block(f.workspace, first.workflow);
  const other = f.workspace.createConversation(project.id);
  const ordinary = await f.workspace.send(other.id, { ...input, executionPolicy: 'api-only' });
  await f.workspace.tickQueue();
  await until(() => saved(f.workspace, ordinary.workflow.id).status === 'completed');
  assert.equal(f.calls.length, 1);
  assert.equal(saved(f.workspace, queuedChild.workflow.id).status, 'blocked');
  assert.match(saved(f.workspace, queuedChild.workflow.id).error ?? '', /请先开启.*协作/);
  assert.equal(saved(f.workspace, ordinary.workflow.id).input.swarm, false);
  const review = await f.workspace.delegate(first.workflow.id, 'reviewer', 'Internal review', 'auto-review', {
    review: { round: 1 },
  });
  assert.equal(review.workflow.delegation?.review?.round, 1, 'host review internals retain their existing path');
  f.workspace.cancel(review.workflow.id);
  delete project.scope;
  f.workspace.store.save('project', project.id, project.id, project);
  assert.ok(f.workspace.delegationParent(conversation.id).workflow, 'legacy projects without scope remain eligible');
  project.removedAt = new Date().toISOString();
  f.workspace.store.save('project', project.id, project.id, project);
  await assert.rejects(
    f.workspace.delegate(first.workflow.id, 'scout', 'Removed project', 'removed'),
    /请先开启.*协作/,
  );
});

test('child archive, restore and delete affect only its settled logical subtree and retain audit history', async (t) => {
  const f = fixture(t);
  const project = await f.workspace.createProject(f.directory);
  const conversation = f.workspace.createConversation(project.id);
  const first = await f.workspace.send(conversation.id, input);
  block(f.workspace, first.workflow);
  const make = (id: string, parentId: string, previous?: string) => {
    const workflow: Workflow = {
      ...first.workflow,
      id,
      status: 'completed',
      parentWorkflowId: previous,
      delegation: { parentId, role: 'scout', requestId: previous ?? id },
      runIds: [],
    };
    f.workspace.store.save('workflow', id, conversation.id, workflow);
    return workflow;
  };
  const child = make('child', first.workflow.id);
  const next = make('child-next', first.workflow.id, child.id);
  make('grandchild', next.id);
  make('sibling', first.workflow.id);
  const foreign = { ...make('foreign', child.id), conversationId: 'foreign-conversation' };
  f.workspace.store.save('workflow', foreign.id, foreign.conversationId, foreign);
  const wrongProject = { ...make('wrong-project', child.id), projectId: 'foreign-project' };
  f.workspace.store.save('workflow', wrongProject.id, conversation.id, wrongProject);
  const run = f.complete({
    prompt: 'Retained child audit',
    projectPath: f.directory,
    kind: 'general',
    workflowId: child.id,
  });
  child.runIds = [run.id];
  child.executionWorkspaceId = 'retained-worktree';
  f.workspace.store.save('workflow', child.id, conversation.id, child);
  const host = f.workspace as unknown as {
    managedWorktrees: { apply: () => Promise<unknown> };
    pendingWorkspaceDeliveries: Set<string>;
  };
  let writes = 0;
  t.mock.method(host.managedWorktrees, 'apply', async () => {
    writes++;
    throw new Error('Unexpected parent write');
  });
  host.pendingWorkspaceDeliveries.add(child.id);
  const parentBefore = saved(f.workspace, first.workflow.id);
  const messagesBefore = f.workspace.conversation(conversation.id).messages;
  assert.throws(() => f.workspace.archiveWorkflow(first.workflow.id, true), /只能归档或恢复子任务/);
  const archived = f.workspace.archiveWorkflow(next.id, true);
  assert.ok(archived.archivedAt);
  assert.ok(!host.pendingWorkspaceDeliveries.has(child.id));
  await assert.rejects(f.workspace.deliverWorkspace(child.id, true), /先恢复/);
  assert.ok((await f.workspace.deliverWorkspace(child.id)).archivedAt);
  await f.workspace.tickQueue();
  assert.equal(writes, 0, 'archived deliveries cannot change the parent');
  for (const id of [child.id, next.id, 'grandchild']) assert.ok(saved(f.workspace, id).archivedAt);
  for (const id of [first.workflow.id, 'sibling', 'foreign', 'wrong-project'])
    assert.equal(saved(f.workspace, id).archivedAt, undefined);
  const revision = f.workspace.conversation(conversation.id).conversation.workflowHistoryRevision;
  f.workspace.archiveWorkflow(next.id, true);
  assert.equal(f.workspace.conversation(conversation.id).conversation.workflowHistoryRevision, revision);
  assert.ok(!f.workspace.state().workflows?.some((item) => item.id === next.id));
  assert.ok(
    f.workspace.swarmSnapshot(conversation.id).workflows.some((item) => item.id === next.id && item.archivedAt),
  );
  await assert.rejects(f.workspace.continue(next.id), /先恢复/);
  await assert.rejects(f.workspace.sendSwarmMessage(next.id, 'Continue work'), /先恢复/);
  await assert.rejects(f.workspace.messageSwarmAgent('sibling', next.id, 'Peer request', run.id), /先恢复/);
  assert.equal(f.workspace.store.list('swarm-message').length, 0, 'archive rejection creates no queued wake-up');
  f.workspace.archiveWorkflow(next.id, false);
  for (const id of [child.id, next.id, 'grandchild']) assert.equal(saved(f.workspace, id).archivedAt, undefined);
  f.workspace.deleteWorkflow(next.id);
  for (const id of [child.id, next.id, 'grandchild']) assert.ok(saved(f.workspace, id).deletedAt);
  for (const id of [first.workflow.id, 'sibling', 'foreign', 'wrong-project'])
    assert.equal(saved(f.workspace, id).deletedAt, undefined);
  assert.deepEqual(saved(f.workspace, first.workflow.id), parentBefore);
  assert.deepEqual(f.workspace.conversation(conversation.id).messages, messagesBefore);
  assert.equal(f.workspace.conversation(conversation.id).conversation.deletedAt, undefined);
  assert.equal(saved(f.workspace, child.id).executionWorkspaceId, 'retained-worktree');
  assert.equal(f.controller.store.run(run.id)?.output, 'Synthetic answer');
  const malformed = { ...make('malformed', first.workflow.id), parentWorkflowId: first.workflow.id };
  f.workspace.store.save('workflow', malformed.id, conversation.id, malformed);
  assert.throws(() => f.workspace.archiveWorkflow(malformed.id, true), /子任务关系无效/);
  assert.throws(() => f.workspace.deleteWorkflow(malformed.id), /子任务关系无效/);
  malformed.parentWorkflowId = 'sibling';
  f.workspace.store.save('workflow', malformed.id, conversation.id, malformed);
  assert.throws(() => f.workspace.archiveWorkflow(malformed.id, true), /子任务关系无效/);
  assert.throws(() => f.workspace.deleteWorkflow(malformed.id), /子任务关系无效/);
  assert.deepEqual(saved(f.workspace, first.workflow.id), parentBefore);
});

test('active descendants, background work, steering and host delivery prevent child lifecycle changes', async (t) => {
  const f = fixture(t);
  const project = await f.workspace.createProject(f.directory);
  const conversation = f.workspace.createConversation(project.id);
  const first = await f.workspace.send(conversation.id, input);
  block(f.workspace, first.workflow);
  const child = await f.workspace.delegate(first.workflow.id, 'scout', 'Read', 'child');
  block(f.workspace, child.workflow);
  const grand = await f.workspace.delegate(child.workflow.id, 'scout', 'Nested read', 'grand');
  assert.throws(() => f.workspace.archiveWorkflow(child.workflow.id, true), /先结束或取消/);
  assert.throws(() => f.workspace.deleteWorkflow(child.workflow.id), /子任务/);
  f.workspace.cancel(grand.workflow.id);
  const blocked = saved(f.workspace, grand.workflow.id);
  blocked.waitingOn = { kind: 'media-analysis', jobId: 'retained-job', done: 1, total: 2 };
  f.workspace.store.save('workflow', blocked.id, conversation.id, blocked);
  assert.throws(() => f.workspace.archiveWorkflow(child.workflow.id, true), /先结束或取消/);
  assert.throws(() => f.workspace.deleteWorkflow(child.workflow.id), /子任务/);
  delete blocked.waitingOn;
  f.workspace.store.save('workflow', blocked.id, conversation.id, blocked);
  const host = f.workspace as unknown as {
    deliveryOperations: Map<string, Promise<Workflow>>;
    queuedSteers: Map<string, Promise<unknown>>;
  };
  host.deliveryOperations.set(grand.workflow.id, Promise.resolve(blocked));
  assert.throws(() => f.workspace.archiveWorkflow(child.workflow.id, true), /文件正在交付/);
  assert.throws(() => f.workspace.deleteWorkflow(child.workflow.id), /文件正在交付/);
  host.deliveryOperations.clear();
  host.queuedSteers.set(grand.workflow.id, Promise.resolve());
  assert.throws(() => f.workspace.archiveWorkflow(child.workflow.id, true), /插话正在投递/);
  assert.throws(() => f.workspace.deleteWorkflow(child.workflow.id), /插话正在投递/);
  host.queuedSteers.clear();
  assert.equal(saved(f.workspace, child.workflow.id).archivedAt, undefined);
  assert.equal(saved(f.workspace, child.workflow.id).deletedAt, undefined);
});
function block(workspace: Workspace, workflow: Workflow, status: 'blocked' | 'failed' | 'interrupted' = 'blocked') {
  workflow.status = status;
  workflow.error = 'Synthetic attachment capability blocker';
  workspace.store.save('workflow', workflow.id, workflow.conversationId, workflow);
}
async function until(predicate: () => boolean) {
  for (let index = 0; index < 200; index++) {
    if (predicate()) return;
    await new Promise((done) => setTimeout(done, 10));
  }
  assert.fail('Synthetic workflow did not settle');
}

test('a normal later message is a history follow-up without replaying or locking the old request', async (t) => {
  const f = fixture(t),
    project = await f.workspace.createProject(f.directory);
  const conversation = f.workspace.createConversation(project.id);
  const first = await f.workspace.send(conversation.id, {
    ...input,
    mode: 'build',
    permissionMode: 'workspace-write',
    content: 'Synthetic earlier write request',
  });
  block(f.workspace, first.workflow);
  const next = await f.workspace.send(conversation.id, input);
  const old = saved(f.workspace, first.workflow.id);
  assert.equal(old.status, 'blocked');
  assert.equal(old.error, first.workflow.error);
  assert.equal(old.followUp?.workflowId, next.workflow.id);
  assert.equal(old.followUp?.kind, 'message');
  assert.equal(next.workflow.parentWorkflowId, undefined);
  assert.equal(next.workflow.input.permissionMode, 'read-only');
  assert.equal(next.workflow.input.content, input.content);
  const continued = await f.workspace.continue(first.workflow.id);
  assert.notEqual(continued.workflow.id, next.workflow.id);
  assert.equal(continued.workflow.parentWorkflowId, first.workflow.id);
  assert.equal(continued.workflow.input.permissionMode, 'workspace-write');
  assert.equal(f.workspace.store.messages(conversation.id).length, 3);
  f.workspace.cancel(continued.workflow.id);
  await f.workspace.tickQueue();
  await until(() => saved(f.workspace, next.workflow.id).status === 'completed');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0]?.permissionMode, 'read-only');
});

test('blocked, failed and interrupted tasks can be cancelled and deleted while messages and run records remain', async (t) => {
  for (const status of ['blocked', 'failed', 'interrupted'] as const)
    await t.test(status, async (t) => {
      const f = fixture(t),
        project = await f.workspace.createProject(f.directory);
      const conversation = f.workspace.createConversation(project.id);
      const first = await f.workspace.send(conversation.id, input);
      block(f.workspace, first.workflow, status);
      const run = f.complete({
        prompt: 'Synthetic old output',
        projectPath: f.directory,
        kind: 'general',
        workflowId: first.workflow.id,
      });
      first.workflow.runIds = [run.id];
      f.workspace.store.save('workflow', first.workflow.id, conversation.id, first.workflow);
      f.workspace.cancel(first.workflow.id);
      assert.equal(saved(f.workspace, first.workflow.id).status, 'cancelled');
      assert.match(saved(f.workspace, first.workflow.id).error!, /此前阻碍/);
      await assert.rejects(f.workspace.continue(first.workflow.id), /已取消/);
      f.workspace.deleteWorkflow(first.workflow.id);
      f.workspace.deleteWorkflow(first.workflow.id);
      assert.ok(saved(f.workspace, first.workflow.id).deletedAt);
      assert.equal(f.workspace.state().workflows?.length, 0);
      const retained = f.workspace.conversation(conversation.id).workflows;
      assert.equal(retained.length, 1);
      assert.ok(retained[0]!.deletedAt, 'conversation history retains metadata while task controls are removed');
      assert.equal(f.workspace.store.messages(conversation.id).length, 1);
      assert.equal(f.controller.store.run(run.id)?.output, 'Synthetic answer');
      await assert.rejects(f.workspace.continue(first.workflow.id), /已删除/);
    });
});

test('deleting a queued task requires cancelling it first and never dispatches it', async (t) => {
  const f = fixture(t),
    project = await f.workspace.createProject(f.directory);
  const conversation = f.workspace.createConversation(project.id);
  const value = await f.workspace.send(conversation.id, input);
  assert.throws(() => f.workspace.deleteWorkflow(value.workflow.id), /先停止或取消/);
  f.workspace.cancel(value.workflow.id);
  f.workspace.deleteWorkflow(value.workflow.id);
  await f.workspace.tickQueue();
  assert.equal(f.calls.length, 0);
});

test('invalid new attachments do not resolve a blocker and other conversations or delegations do not take it over', async (t) => {
  const f = fixture(t),
    project = await f.workspace.createProject(f.directory);
  const conversation = f.workspace.createConversation(project.id);
  const first = await f.workspace.send(conversation.id, input);
  block(f.workspace, first.workflow);
  await assert.rejects(f.workspace.send(conversation.id, { ...input, attachmentIds: [randomUUID()] }), /附件/);
  const other = f.workspace.createConversation(project.id);
  await f.workspace.send(other.id, input);
  const delegate = await f.workspace.send(conversation.id, input, undefined, {
    parentId: first.workflow.id,
    role: 'scout',
    requestId: randomUUID(),
  });
  assert.equal(saved(f.workspace, first.workflow.id).followUp, undefined);
  block(f.workspace, delegate.workflow);
  const next = await f.workspace.send(conversation.id, input);
  assert.equal(saved(f.workspace, first.workflow.id).followUp?.workflowId, next.workflow.id);
  assert.equal(saved(f.workspace, delegate.workflow.id).followUp, undefined);
});

test('legacy repair uses user-message order and does not change historical sorting times', async (t) => {
  const f = fixture(t),
    project = await f.workspace.createProject(f.directory);
  const conversation = f.workspace.createConversation(project.id);
  const first = await f.workspace.send(conversation.id, input);
  const stray = f.workspace.store.addMessage(conversation.id, 'user', 'Synthetic steering note', first.workflow.id);
  stray.steering = { runId: 'fixture', status: 'accepted' };
  f.workspace.store.save('message', stray.id, conversation.id, stray);
  const next = await f.workspace.send(conversation.id, input);
  block(f.workspace, first.workflow);
  first.workflow.updatedAt = '2099-01-01T00:00:00.000Z';
  f.workspace.store.save('workflow', first.workflow.id, conversation.id, first.workflow);
  const before = f.controller.store.db
    .prepare("SELECT updated_at FROM workspace_records WHERE kind='workflow' AND id=?")
    .get(first.workflow.id);
  await f.workspace.close();
  const reopened = new Workspace(f.controller, { autoTick: false });
  try {
    await reopened.startupMaintenanceDone;
    assert.equal(saved(reopened, first.workflow.id).followUp?.workflowId, next.workflow.id);
    assert.equal(saved(reopened, first.workflow.id).updatedAt, first.workflow.updatedAt);
    const after = f.controller.store.db
      .prepare("SELECT updated_at FROM workspace_records WHERE kind='workflow' AND id=?")
      .get(first.workflow.id);
    assert.deepEqual(after, before);
    assert.equal(f.calls.length, 0);
  } finally {
    await reopened.close();
  }
});

test('a task that blocks after its next message was enqueued is linked at terminal publication', async (t) => {
  const f = fixture(t),
    project = await f.workspace.createProject(f.directory);
  const conversation = f.workspace.createConversation(project.id);
  let release!: () => void,
    started = false,
    launches = 0;
  t.mock.method(f.controller, 'start', async (request: RunInput) => {
    if (++launches === 1) {
      started = true;
      await new Promise<void>((done) => {
        release = done;
      });
      throw new Error('Synthetic first task blocker');
    }
    return f.complete(request);
  });
  const first = await f.workspace.send(conversation.id, input);
  const ticking = f.workspace.tickQueue();
  await until(() => started);
  const next = await f.workspace.send(conversation.id, input);
  release();
  await ticking;
  await until(() => saved(f.workspace, first.workflow.id).status === 'blocked');
  assert.equal(saved(f.workspace, first.workflow.id).followUp?.workflowId, next.workflow.id);
});

test('sending never waits for the native Grok history import, and a continuation still takes over only once', async (t) => {
  const f = fixture(t),
    project = await f.workspace.createProject(f.directory);
  const conversation = f.workspace.createConversation(project.id);
  const first = await f.workspace.send(conversation.id, input);
  block(f.workspace, first.workflow);
  conversation.grokHistory = { syncedAt: first.workflow.createdAt, sessions: 1, messages: 1 };
  f.workspace.store.save('conversation', conversation.id, project.id, conversation);
  const releases: (() => void)[] = [];
  t.mock.method(
    GrokHistorySyncWorker.prototype,
    'execute',
    async () =>
      new Promise<never>((done) => {
        releases.push(() => done(undefined as never));
      }),
  );
  // The import never finishes here; both requests return anyway.
  const continued = await f.workspace.continue(first.workflow.id);
  const normal = await f.workspace.send(conversation.id, input);
  assert.ok(releases.length >= 1, 'the import still runs, in the background');
  assert.notEqual(normal.workflow.id, continued.workflow.id);
  assert.equal(saved(f.workspace, first.workflow.id).followUp?.workflowId, continued.workflow.id);
  // Asking to continue again returns the same takeover instead of a second one.
  assert.equal((await f.workspace.continue(first.workflow.id)).workflow.id, continued.workflow.id);
  for (const release of releases) release();
});

test('missing or deleted true continuation records never trigger an old request again', async (t) => {
  const f = fixture(t),
    project = await f.workspace.createProject(f.directory);
  const conversation = f.workspace.createConversation(project.id);
  const first = await f.workspace.send(conversation.id, input);
  block(f.workspace, first.workflow);
  first.workflow.followUp = { workflowId: randomUUID(), kind: 'continue', at: first.workflow.createdAt };
  f.workspace.store.save('workflow', first.workflow.id, conversation.id, first.workflow);
  await assert.rejects(f.workspace.continue(first.workflow.id), /记录缺失/);
  delete first.workflow.followUp;
  f.workspace.store.save('workflow', first.workflow.id, conversation.id, first.workflow);
  const next = await f.workspace.continue(first.workflow.id);
  f.workspace.cancel(next.workflow.id);
  f.workspace.deleteWorkflow(next.workflow.id);
  await assert.rejects(f.workspace.continue(first.workflow.id), /已删除/);
  assert.equal(f.calls.length, 0);
});

test('cancel and delete handle delegated cards while leaving independent later tasks intact', async (t) => {
  const f = fixture(t),
    project = await f.workspace.createProject(f.directory);
  const conversation = f.workspace.createConversation(project.id);
  const first = await f.workspace.send(conversation.id, input);
  block(f.workspace, first.workflow);
  const child = await f.workspace.send(conversation.id, input, undefined, {
    parentId: first.workflow.id,
    role: 'scout',
    requestId: randomUUID(),
  });
  assert.throws(() => f.workspace.deleteWorkflow(first.workflow.id), /子任务/);
  f.workspace.cancel(first.workflow.id);
  f.workspace.cancel(first.workflow.id);
  assert.equal(saved(f.workspace, child.workflow.id).status, 'cancelled');
  const next = await f.workspace.send(conversation.id, input);
  const mainContinuation = {
    ...next.workflow,
    id: 'retained-main-continuation',
    status: 'completed' as const,
    parentWorkflowId: first.workflow.id,
  };
  f.workspace.store.save('workflow', mainContinuation.id, conversation.id, mainContinuation);
  f.workspace.deleteWorkflow(first.workflow.id);
  assert.ok(saved(f.workspace, child.workflow.id).deletedAt);
  assert.equal(saved(f.workspace, next.workflow.id).deletedAt, undefined);
  assert.equal(saved(f.workspace, mainContinuation.id).deletedAt, undefined);
  assert.deepEqual(
    f.workspace
      .state()
      .workflows?.map((value) => value.id)
      .sort(),
    [next.workflow.id, mainContinuation.id].sort(),
  );
  assert.equal(f.workspace.store.messages(conversation.id).length, 3);
});

test('automatic child archive protects pending work and runs after restart', async (t) => {
  const f = fixture(t);
  const project = await f.workspace.createProject(f.directory);
  const conversation = f.workspace.createConversation(project.id);
  const root = (await f.workspace.send(conversation.id, input)).workflow;
  root.status = 'completed';
  f.workspace.store.save('workflow', root.id, conversation.id, root);
  const child = (id: string, extra: Partial<Workflow> = {}) => {
    const value: Workflow = {
      ...structuredClone(root),
      id,
      delegation: { parentId: root.id, requestId: id, role: 'worker' },
      ...extra,
    };
    f.workspace.store.save('workflow', id, conversation.id, value);
    return value;
  };
  child('manual-parent');
  const manual = child('manual-descendant', {
    delegation: { parentId: 'manual-parent', requestId: 'manual', role: 'scout' },
  });
  f.workspace.archiveWorkflow(manual.id, true);
  child('good');
  child('cancelled', { status: 'cancelled', userCancelled: true });
  child('unmarked-cancel', { status: 'cancelled' });
  child('failed', { status: 'failed' });
  child('waiting', { waitingOn: { kind: 'media-analysis', jobId: 'job', done: 0, total: 1 } });
  child('undelivered', { executionWorkspaceId: 'tree' });
  child('branch', {
    executionWorkspaceId: 'branch',
    executionWorkspace: { mode: 'branch', state: 'ready' } as unknown as Workflow['executionWorkspace'],
  });
  child('delivered', {
    executionWorkspaceId: 'tree',
    executionDeliveryWorkflowId: 'delivered',
    executionWorkspace: {
      delivery: { status: 'applied', changedPaths: [], at: root.createdAt },
    } as unknown as Workflow['executionWorkspace'],
  });
  const ancestor = child('ancestor');
  child('failed-descendant', {
    status: 'failed',
    delegation: { parentId: ancestor.id, requestId: 'nested', role: 'worker' },
  });
  child('running', { status: 'running' });
  child('follow', { followUp: { kind: 'continue', workflowId: 'later', at: root.createdAt } });
  const sweep = () => (f.workspace as any).archiveSettledDelegations(root.id);
  root.status = 'running';
  f.workspace.store.save('workflow', root.id, conversation.id, root);
  sweep();
  assert.equal(saved(f.workspace, 'good').archivedAt, undefined);
  root.status = 'completed';
  f.workspace.store.save('workflow', root.id, conversation.id, root);
  (f.workspace as any).active.set(root.id, { workflow: root });
  sweep();
  assert.equal(saved(f.workspace, 'good').archivedAt, undefined);
  (f.workspace as any).active.delete(root.id);
  conversation.swarm = true;
  f.workspace.store.save('conversation', conversation.id, project.id, conversation);
  sweep();
  assert.equal(saved(f.workspace, 'good').archivedAt, undefined);
  conversation.swarm = false;
  f.workspace.store.save('conversation', conversation.id, project.id, conversation);
  sweep();
  assert.ok(saved(f.workspace, 'good').archivedAt);
  assert.equal(saved(f.workspace, manual.id).archivedBy, 'user');
  await assert.rejects(f.workspace.continue(manual.id), /\u5f52\u6863/);
  assert.ok(saved(f.workspace, 'cancelled').archivedAt);
  assert.ok(saved(f.workspace, 'delivered').archivedAt);
  for (const id of [
    'failed',
    'waiting',
    'undelivered',
    'branch',
    'ancestor',
    'failed-descendant',
    'running',
    'follow',
    'unmarked-cancel',
  ])
    assert.equal(saved(f.workspace, id).archivedAt, undefined, id);
  child('startup');
  const reopened = new Workspace(f.controller, { autoTick: false });
  await reopened.startupMaintenanceDone;
  assert.ok(saved(reopened, 'startup').archivedAt);
  await reopened.close();
});

test('automatic archives restore on continuation and ancestry use; manual archives still require restore', async (t) => {
  const f = fixture(t);
  const project = await f.workspace.createProject(f.directory);
  const conversation = f.workspace.createConversation(project.id);
  const root = (await f.workspace.send(conversation.id, input)).workflow;
  block(f.workspace, root);
  const child = (await f.workspace.delegate(root.id, 'scout', 'Read project', 'auto-child')).workflow;
  child.status = 'completed';
  f.workspace.store.save('workflow', child.id, conversation.id, child);
  (f.workspace as any).archiveSettledDelegations(root.id);
  assert.equal(saved(f.workspace, child.id).archivedBy, 'auto');
  const next = await f.workspace.continue(child.id, 'Continue reading');
  assert.equal(saved(f.workspace, child.id).archivedAt, undefined);
  assert.equal(saved(f.workspace, child.id).archivedBy, undefined);
  assert.equal(next.workflow.parentWorkflowId, child.id);
  block(f.workspace, next.workflow);
  f.workspace.archiveWorkflow(next.workflow.id, true);
  await assert.rejects(f.workspace.continue(next.workflow.id), /\u5f52\u6863/);
  assert.equal(saved(f.workspace, next.workflow.id).archivedBy, 'user');

  const ancestor = (await f.workspace.delegate(root.id, 'scout', 'Read again', 'ancestor')).workflow;
  block(f.workspace, ancestor);
  const descendant = (await f.workspace.delegate(ancestor.id, 'scout', 'Read nested', 'descendant')).workflow;
  for (const workflow of [ancestor, descendant]) {
    workflow.status = 'completed';
    f.workspace.store.save('workflow', workflow.id, conversation.id, workflow);
  }
  (f.workspace as any).archiveSettledDelegations(root.id);
  assert.equal(saved(f.workspace, ancestor.id).archivedBy, 'auto');
  const nested = await f.workspace.delegate(descendant.id, 'scout', 'Read last', 'nested');
  assert.equal(nested.workflow.delegation?.parentId, descendant.id);
  assert.equal(saved(f.workspace, ancestor.id).archivedAt, undefined);
  assert.equal(saved(f.workspace, descendant.id).archivedAt, undefined);
});
