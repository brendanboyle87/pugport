import assert from 'node:assert/strict';
import { before, test, type TestContext } from 'node:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { Controller } from '../src/server/controller.ts';
import { Workspace } from '../src/server/workspace.ts';
import { conversationTimeline } from '../src/ui/conversation-timeline.ts';
import type { Conversation, ConversationMessage, Workflow } from '../src/shared/types.ts';
import { findNode, nextTurn, uiBundle, uiHarness } from './helpers/ui-harness.ts';

let code: string;
before(async () => {
  code = await uiBundle('src/ui/Workspace.tsx');
});
const stamp = '2026-10-01T12:00:00.000Z';
const conversation = (id: string): Conversation => ({
  id,
  projectId: 'project',
  title: id,
  createdAt: stamp,
  updatedAt: stamp,
});
const task = (id: string, conversationId = 'main', parentId?: string): Workflow => ({
  id,
  conversationId,
  projectId: 'project',
  userMessageId: `user-${id}`,
  finalMessageId: `reply-${id}`,
  input: { content: `Fixture ${id}`, mode: 'chat', permissionMode: 'read-only', executionPolicy: 'cli-first' },
  status: 'completed',
  phase: 'summarize',
  plan: [],
  runIds: [],
  memoryRevision: 0,
  memoryExcerpt: '',
  createdAt: stamp,
  updatedAt: stamp,
  ...(parentId ? { delegation: { parentId, role: 'scout' as const, requestId: id } } : {}),
});
function fixture(t: TestContext) {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'comborunner-conversation-history-')));
  const previousMemory = process.env.COMBORUNNER_MEMORY_DIR;
  process.env.COMBORUNNER_MEMORY_DIR = join(directory, 'memory');
  const controller = new Controller(directory, join(directory, 'data'));
  clearInterval(controller.timer);
  const workspace = new Workspace(controller, { autoTick: false });
  t.mock.method(controller, 'start', async () => {
    throw new Error('This fixture must never invoke a model');
  });
  workspace.store.save('project', 'project', '', {
    id: 'project',
    name: 'Fixture',
    path: directory,
    createdAt: stamp,
    updatedAt: stamp,
  });
  for (const id of ['main', 'other']) workspace.store.save('conversation', id, 'project', conversation(id));
  t.after(async () => {
    await workspace.close();
    await controller.close();
    const absolute = resolve(directory);
    assert.ok(absolute.startsWith(realpathSync.native(tmpdir()) + sep));
    assert.ok(basename(absolute).startsWith('comborunner-conversation-history-'));
    rmSync(absolute, { recursive: true, force: true });
    if (previousMemory === undefined) delete process.env.COMBORUNNER_MEMORY_DIR;
    else process.env.COMBORUNNER_MEMORY_DIR = previousMemory;
  });
  const save = (workflow: Workflow, withMessages = true) => {
    for (const role of withMessages ? (['user', 'assistant'] as const) : []) {
      const id = role === 'user' ? workflow.userMessageId : workflow.finalMessageId!;
      workspace.store.save('message', id, workflow.conversationId, {
        id,
        conversationId: workflow.conversationId,
        workflowId: workflow.id,
        role,
        content: `Fixture ${id}`,
        createdAt: stamp,
      });
    }
    workspace.store.save('workflow', workflow.id, workflow.conversationId, workflow);
  };
  return { workspace, save };
}
function mount(workspace: Workspace, api: any) {
  const harness = uiHarness(code);
  const props: any = {
    state: {
      app: { name: 'Fixture', version: 'test', platform: 'win32', dataDir: 'fixture' },
      targets: [],
      runtimes: [],
      runs: [],
      approvals: [],
      plugins: [],
      settings: { toolApprovalMode: 'auto' },
      ...workspace.state(),
    },
    conversation: workspace.conversation('main').conversation,
    api,
    notify() {},
    onConversation() {},
    onAddProject() {},
    onMemory() {},
    onInspect() {},
  };
  const render = () => harness.render('ConversationWorkspace', props);
  const refresh = () => {
    props.state = { ...props.state, ...workspace.state() };
    props.conversation = workspace.conversation(props.conversation.id).conversation;
    return render();
  };
  const history = () => {
    const node = findNode(
      render(),
      (node) => node.props?.messages && node.props?.workflows && node.props?.onShowEarlier,
    );
    assert.ok(node);
    return node.props;
  };
  const rail = () => {
    const node = findNode(render(), (node) => node.props?.scrollRef && Array.isArray(node.props?.messages));
    assert.ok(node);
    return node.props.messages as ConversationMessage[];
  };
  return { harness, props, render, refresh, history, rail };
}

test('full conversation metadata survives the 200-task window and child/parent deletion through Workspace', async (t) => {
  const { workspace, save } = fixture(t);
  for (const workflow of [task('parent'), task('alpha', 'main', 'parent'), task('beta', 'main', 'parent')])
    save(workflow);
  // Legacy child requests/results rely on canonical workflow pointers, not workflowId or content guesses.
  for (const id of ['user-beta', 'reply-beta']) {
    const legacy = workspace.store.get<ConversationMessage>('message', id)!;
    delete legacy.workflowId;
    workspace.store.save('message', id, 'main', legacy);
  }
  workspace.store.save('message', 'steer-child', 'main', {
    id: 'steer-child',
    conversationId: 'main',
    workflowId: 'alpha',
    role: 'user',
    content: 'Fixture human correction',
    steering: { runId: 'fixture-run', status: 'accepted' },
    createdAt: stamp,
  });
  workspace.store.db.prepare("UPDATE workspace_records SET updated_at='2020-01-01' WHERE kind='workflow'").run();
  for (let i = 0; i < 205; i++) save(task(`recent-${i}`), false);
  save(task('foreign', 'other'));
  assert.equal(workspace.state().workflows?.length, 200, 'global queue/history remains bounded');
  assert.ok(!workspace.state().workflows?.some((workflow) => workflow.id === 'alpha'));
  const detail = workspace.conversation('main');
  assert.equal(detail.workflows.length, 208);
  assert.ok(detail.workflows.every((workflow) => workflow.conversationId === 'main'));
  assert.deepEqual(
    workspace.conversation('other').workflows.map((workflow) => workflow.id),
    ['foreign'],
  );
  let requests = 0;
  const presentationRequests: string[][] = [];
  const view = mount(workspace, async (path: string) => {
    const url = new URL(path, 'http://synthetic');
    if (url.pathname.endsWith('/presentations')) {
      presentationRequests.push(url.searchParams.get('workflows')!.split(','));
      return { presentations: {} };
    }
    requests++;
    return workspace.conversation(decodeURIComponent(path.split('/').at(-1)!));
  });
  t.after(() => view.harness.unmount());
  view.render();
  await nextTurn();
  const group = () => {
    const history = view.history();
    return conversationTimeline(history.messages, history.workflows).find((row) => row.kind === 'delegation-group');
  };
  assert.equal(view.history().workflows.length, 208);
  assert.equal(group()?.children.length, 2);
  const mainMessages = ['user-parent', 'reply-parent', 'steer-child'];
  assert.deepEqual(
    Array.from(view.rail(), (message) => message.id),
    mainMessages,
    'rail receives main messages and human steering, excluding canonical and legacy child messages',
  );
  const childReplies = () => group()?.children.flatMap(({ messages }) => messages.map((message) => message.id));
  const retained = childReplies();
  await nextTurn();
  const previousPresentationRequests = presentationRequests.length;

  const live = { ...task('recent-204'), status: 'running' as const, updatedAt: '2026-10-02T12:00:00.000Z' };
  view.props.state = { ...view.props.state, workflows: [live] };
  view.props.conversation = { ...view.props.conversation, updatedAt: live.updatedAt };
  assert.equal(view.history().workflows.find((workflow: Workflow) => workflow.id === live.id).status, 'running');
  await nextTurn();
  assert.equal(requests, 1, 'normal workflow updates do not reload the whole conversation');
  assert.deepEqual(
    presentationRequests.slice(previousPresentationRequests),
    [['recent-204']],
    'only the changed visible workflow is requested; unchanged failed projections are not retried',
  );

  workspace.deleteWorkflow('alpha');
  view.refresh();
  await nextTurn();
  assert.equal(requests, 2);
  assert.equal(view.props.conversation.workflowHistoryRevision, 1);
  assert.ok(group()?.children.find(({ workflow }) => workflow.id === 'alpha')?.workflow.deletedAt);
  assert.deepEqual(childReplies(), retained);
  assert.deepEqual(
    Array.from(view.rail(), (message) => message.id),
    mainMessages,
    'deleted child messages stay off the rail',
  );

  workspace.deleteWorkflow('parent');
  view.refresh();
  await nextTurn();
  assert.equal(requests, 3);
  assert.equal(view.props.conversation.workflowHistoryRevision, 2);
  assert.ok(group()?.parent?.deletedAt);
  assert.ok(group()?.children.every(({ workflow }) => workflow.deletedAt));
  assert.deepEqual(childReplies(), retained);
  assert.deepEqual(
    Array.from(view.rail(), (message) => message.id),
    mainMessages,
    'deleted parent metadata still identifies folded children',
  );
  assert.equal(workspace.conversation('other').conversation.workflowHistoryRevision, undefined);
  assert.equal(workspace.conversation('main').messages.length, detail.messages.length);
  workspace.deleteWorkflow('parent');
  assert.equal(
    workspace.conversation('main').conversation.workflowHistoryRevision,
    2,
    'repeated removal is idempotent',
  );
  // A delayed bounded snapshot cannot recreate controls deleted by the full history response.
  view.props.state = { ...view.props.state, workflows: [task('parent'), task('alpha', 'main', 'parent')] };
  assert.ok(view.history().workflows.find((workflow: Workflow) => workflow.id === 'parent').deletedAt);
});

test('late history responses cannot undo a newer deletion revision or leak another conversation', async (t) => {
  const { workspace, save } = fixture(t);
  save(task('parent'));
  save(task('child', 'main', 'parent'));
  save(task('foreign', 'other'));
  const pending: Array<{ snapshot: ReturnType<Workspace['conversation']>; resolve: (value: unknown) => void }> = [];
  const view = mount(
    workspace,
    (path: string) =>
      new Promise((resolve) => {
        pending.push({ snapshot: workspace.conversation(path.split('/').at(-1)!), resolve });
      }),
  );
  t.after(() => view.harness.unmount());
  view.render();
  workspace.deleteWorkflow('parent');
  view.refresh();
  assert.equal(pending.length, 2);
  pending[1]!.resolve(pending[1]!.snapshot);
  await nextTurn();
  assert.ok(view.history().workflows.every((workflow: Workflow) => workflow.deletedAt));
  pending[0]!.resolve(pending[0]!.snapshot);
  await nextTurn();
  assert.ok(view.history().workflows.every((workflow: Workflow) => workflow.deletedAt));
  view.props.conversation = workspace.conversation('other').conversation;
  view.render();
  pending[2]!.resolve(pending[2]!.snapshot);
  await nextTurn();
  assert.deepEqual(
    Array.from(view.history().workflows, (workflow: Workflow) => workflow.id),
    ['foreign'],
  );
});

test('startup archive leaves newly created siblings and descendants untouched', async (t) => {
  const { workspace, save } = fixture(t);
  save(task('parent'));
  save(task('old-child', 'main', 'parent'));
  await workspace.close();
  const reopened = new Workspace(workspace.controller, { autoTick: false });
  try {
    save(task('new-sibling', 'main', 'parent'));
    save(task('new-descendant', 'main', 'old-child'));
    await reopened.startupMaintenanceDone;
    for (const id of ['old-child', 'new-sibling', 'new-descendant'])
      assert.equal(reopened.store.get<Workflow>('workflow', id)?.archivedAt, undefined, id);
  } finally {
    await reopened.close();
  }
});
