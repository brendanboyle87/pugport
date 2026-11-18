import assert from 'node:assert/strict';
import test from 'node:test';
import type { Conversation, Project, Workflow } from '../src/shared/types.ts';
import type { Api } from '../src/ui/Workspace.tsx';
import { findNode, nextTurn, text, uiBundle, uiHarness } from './helpers/ui-harness.ts';

const stamp = '2026-10-28T12:00:00Z';
const conversation: Conversation = {
  id: 'fixture-chat',
  projectId: 'fixture-project',
  title: 'Fixture chat',
  createdAt: stamp,
  updatedAt: stamp,
};
const project: Project = {
  id: conversation.projectId,
  name: 'Fixture project',
  path: 'C:/Fixture',
  scope: 'project',
  createdAt: stamp,
  updatedAt: stamp,
};
const parent = { id: 'fixture-parent', conversationId: conversation.id } as Workflow;
const bundle = uiBundle('src/ui/ConversationWorkPanel.tsx');

function completed(id: string, createdAt = stamp, patch: Partial<Workflow> = {}): Workflow {
  return {
    id,
    conversationId: conversation.id,
    projectId: project.id,
    userMessageId: `${id}-message`,
    input: {
      content: `User request for ${id}`,
      mode: 'chat',
      permissionMode: 'read-only',
      executionPolicy: 'cli-first',
    },
    status: 'completed',
    phase: 'summarize',
    runIds: [],
    plan: [],
    memoryRevision: 0,
    memoryExcerpt: '',
    createdAt,
    updatedAt: createdAt,
    ...patch,
  };
}

test('a plain chat can opt in to collaboration from its closed subagents section', async () => {
  const calls: Array<{ path: string; body: unknown; method?: string }> = [];
  const api: Api = async <T>(path: string, body?: unknown, method?: string) => {
    calls.push({ path, body, method });
    return (
      path.endsWith('/settings')
        ? { ...conversation, ...(body as object) }
        : path.endsWith('/peers')
          ? []
          : { jobs: [], messages: [] }
    ) as T;
  };
  const harness = uiHarness(await bundle);
  const props = {
    conversation: { ...conversation, collaborationEnabled: false } as Conversation,
    project: { ...project, scope: 'chat' as const },
    api,
    reload: async () => {},
    notify() {},
    onClose() {},
    onConversation(saved: Conversation) {
      props.conversation = saved;
    },
  };
  try {
    let tree = harness.render('ConversationWorkPanel', props);
    const advanced = findNode(
      tree,
      (node) =>
        node.type === 'details' &&
        text(findNode(node, (child) => child.type === 'summary')).startsWith('子代理与工作线'),
    );
    assert.ok(advanced);
    assert.equal(advanced.props.open, undefined);
    const checkbox = findNode(advanced, (node) => node.type === 'input' && node.props.type === 'checkbox')!;
    assert.equal(checkbox.props.checked, false);
    assert.equal(checkbox.props.disabled, false);
    assert.equal(
      findNode(advanced, (node) => node.type === 'button' && text(node) === '新建子代理')?.props.disabled,
      true,
    );
    checkbox.props.onChange({ target: { checked: true } });
    await nextTurn();
    tree = harness.render('ConversationWorkPanel', props);
    assert.equal(
      findNode(tree, (node) => node.type === 'input' && node.props.type === 'checkbox')?.props.checked,
      true,
    );
    assert.equal(
      findNode(tree, (node) => node.type === 'button' && text(node) === '新建子代理')?.props.disabled,
      false,
    );
    assert.deepEqual(structuredClone(calls.filter((call) => call.method === 'PATCH')), [
      {
        path: '/api/conversations/fixture-chat/work/settings',
        body: { collaborationEnabled: true, childWorkspaceMode: 'snapshot' },
        method: 'PATCH',
      },
    ]);
  } finally {
    harness.unmount();
  }
});

test('an opted-in plain chat can open the child dialog with reviewer selected for its completed task', async () => {
  const task = completed('latest');
  const harness = uiHarness(await bundle);
  const props = {
    conversation: { ...conversation, collaborationEnabled: true },
    project: { ...project, scope: 'chat' as const },
    workflows: [task],
    api: (async <T>(path: string) => (path.endsWith('/peers') ? [] : { jobs: [], messages: [] }) as T) as Api,
    reload: async () => {},
    notify() {},
    onConversation() {},
    onClose() {},
  };
  try {
    let tree = harness.render('ConversationWorkPanel', props);
    const create = findNode(tree, (node) => node.type === 'button' && text(node) === '新建子代理')!;
    assert.equal(create.props.disabled, false);
    create.props.onClick();
    await nextTurn();
    tree = harness.render('ConversationWorkPanel', props);
    const dialog = findNode(tree, (node) => node.type?.name === 'CreateChildDialog');
    assert.equal(dialog?.props.parent.id, task.id);
    assert.equal(dialog?.props.initialRole, 'reviewer');
  } finally {
    harness.unmount();
  }
});

test('the panel defaults to the latest completed top-level task and preserves the chosen older parent', async () => {
  const older = completed('older'),
    latest = completed('latest', '2026-10-28T13:00:00Z');
  const excluded = [
    completed('foreign', stamp, { conversationId: 'foreign' }),
    completed('child', stamp, { delegation: { parentId: latest.id, role: 'worker', requestId: 'fixture' } }),
    completed('follow-up', stamp, { parentWorkflowId: latest.id }),
    completed('removed', stamp, { deletedAt: stamp }),
    completed('active', '2026-10-28T14:00:00Z', { status: 'running' }),
  ];
  const calls: string[] = [];
  const api: Api = async <T>(path: string) => {
    calls.push(path);
    return (path.endsWith('/peers') ? [] : { jobs: [], messages: [] }) as T;
  };
  const harness = uiHarness(await bundle);
  const props = {
    conversation,
    project,
    workflows: [older, ...excluded, latest],
    api,
    reload: async () => {},
    notify() {},
    onConversation() {},
    onClose() {},
  };
  try {
    let tree = harness.render('ConversationWorkPanel', props);
    let select = findNode(tree, (node) => node.type === 'select' && node.props['aria-label'] === '父任务')!;
    assert.equal(select.props.value, latest.id);
    assert.match(text(select), /User request for older/);
    assert.match(text(select), /User request for latest/);
    assert.doesNotMatch(text(select), /foreign|child|follow-up|removed|active/);
    select.props.onChange({ target: { value: older.id } });
    tree = harness.render('ConversationWorkPanel', props);
    select = findNode(tree, (node) => node.type === 'select' && node.props['aria-label'] === '父任务')!;
    assert.equal(select.props.value, older.id);
    findNode(tree, (node) => node.type === 'button' && text(node) === '新建子代理')!.props.onClick();
    await nextTurn();
    tree = harness.render('ConversationWorkPanel', props);
    const dialog = findNode(tree, (node) => node.type?.name === 'CreateChildDialog')!;
    assert.equal(dialog.props.parent.id, older.id);
    assert.equal(dialog.props.initialRole, 'reviewer');
    assert.equal(
      calls.some((path) => path.endsWith('/delegation-parent')),
      false,
    );
  } finally {
    harness.unmount();
  }
});

test('the project work panel opens the existing child dialog with its verified parent', async () => {
  const calls: { path: string; method?: string }[] = [];
  const api: Api = async <T>(path: string, _body?: unknown, method?: string) => {
    calls.push({ path, method });
    return (
      path.endsWith('/delegation-parent')
        ? { workflow: parent }
        : path.endsWith('/peers')
          ? []
          : { jobs: [], messages: [] }
    ) as T;
  };
  const harness = uiHarness(await bundle);
  const props = { conversation, project, api, reload: async () => {}, notify() {}, onConversation() {}, onClose() {} };
  try {
    let tree = harness.render('ConversationWorkPanel', props);
    const create = findNode(tree, (node) => node.type === 'button' && text(node) === '新建子代理');
    assert.ok(create);
    assert.equal(create.props.disabled, false);
    create.props.onClick();
    await nextTurn();
    tree = harness.render('ConversationWorkPanel', props);
    assert.equal(findNode(tree, (node) => node.type?.name === 'CreateChildDialog')?.props.parent.id, parent.id);
    assert.deepEqual(
      calls.filter((call) => call.path.endsWith('/delegation-parent')),
      [{ path: '/api/conversations/fixture-chat/delegation-parent', method: 'GET' }],
    );
    assert.ok(
      calls.every((call) => call.method === 'GET'),
      'opening the dialog never submits a task',
    );
  } finally {
    harness.unmount();
  }
});

test('a parent from another chat stays rejected without opening the child dialog', async () => {
  const api: Api = async <T>(path: string) =>
    (path.endsWith('/delegation-parent')
      ? { workflow: { ...parent, conversationId: 'other-chat' } }
      : path.endsWith('/peers')
        ? []
        : { jobs: [], messages: [] }) as T;
  const harness = uiHarness(await bundle);
  const props = { conversation, project, api, reload: async () => {}, notify() {}, onConversation() {}, onClose() {} };
  try {
    let tree = harness.render('ConversationWorkPanel', props);
    findNode(tree, (node) => node.type === 'button' && text(node) === '新建子代理')!.props.onClick();
    await nextTurn();
    tree = harness.render('ConversationWorkPanel', props);
    assert.equal(
      findNode(tree, (node) => node.type?.name === 'CreateChildDialog'),
      undefined,
    );
    assert.match(text(findNode(tree, (node) => node.props.role === 'alert')), /当前对话尚无可派生的任务/);
  } finally {
    harness.unmount();
  }
});
