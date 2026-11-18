import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { findNode, nextTurn, text, uiBundle, uiHarness } from './helpers/ui-harness.ts';

let code: string;
before(async () => {
  code = await uiBundle('tests/helpers/managed-child-ui-fixture.ts');
});
const stamp = '2026-10-25T12:00:00Z';
const parent: any = {
  id: 'parent/one',
  conversationId: 'chat',
  projectId: 'project',
  input: { permissionMode: 'workspace-write' },
};
const profile = {
  id: 'a287c93b-32ec-4d1e-b905-7ab19777cf02',
  name: '项目审查',
  rules: { version: 2, text: '', rules: [], unparsed: [], updatedAt: stamp },
};
const event = { preventDefault() {} };

test('a retained task trace never offers a second child creation entry', () => {
  const h = uiHarness(code);
  const workflow = { ...parent, status: 'completed', runIds: [], plan: [], createdAt: stamp, updatedAt: stamp };
  const props: any = {
    workflow,
    state: {
      projects: [{ id: 'project' }],
      conversations: [{ id: 'chat', projectId: 'project' }],
      workflows: [workflow],
      runs: [],
      targets: [],
      runtimes: [],
      settings: {},
    },
    api: async () => {
      throw Error('Reading the trace must not create children');
    },
    notify() {},
    onInspect() {},
  };
  const render = () => h.render('WorkflowTrace', props);
  for (const projects of [
    [{ id: 'project' }],
    [{ id: 'project', scope: 'chat' }],
    [{ id: 'project', removedAt: stamp }],
    [],
  ]) {
    props.state.projects = projects;
    assert.equal(
      findNode(render(), (node) => node.type?.name === 'CreateChildDialog'),
      undefined,
    );
    assert.equal(
      findNode(render(), (node) => node.type === 'button' && text(node).includes('审查或委派')),
      undefined,
    );
  }
  h.unmount();
});

test('manual child creation preserves draft and request identity on failure, blocks duplicate submits and validates acknowledgement', async () => {
  const h = uiHarness(code),
    calls: any[] = [],
    notices: any[] = [],
    created: any[] = [];
  let finish!: (value: any) => void,
    fail = true,
    closes = 0;
  const props = {
    parent,
    api: async (path: string, body: any) => {
      calls.push({ path, body });
      if (fail) throw Error('Synthetic creation failure');
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
    notify: (notice: any) => notices.push(notice),
    onClose: () => closes++,
    onCreated: (workflow: any) => created.push(workflow),
  };
  const render = () => h.render('CreateChildDialog', props);
  const input = () => findNode(render(), (n) => n.props['aria-label'] === '子代理任务')!;
  const submit = () => findNode(render(), (n) => n.type === 'form')!.props.onSubmit(event);
  assert.equal(h.exports.uiUpdateBlocked(), false);
  input().props.onChange({ target: { value: 'Implement the scoped synthetic change' } });
  render();
  assert.equal(h.exports.uiUpdateBlocked(), true);
  submit();
  await nextTurn();
  assert.match(text(render()), /Synthetic creation failure/);
  assert.equal(input().props.value, 'Implement the scoped synthetic change');
  assert.equal(closes, 0);
  fail = false;
  submit();
  submit();
  await nextTurn();
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.requestId, calls[1].body.requestId);
  assert.equal(calls[1].path, '/api/workflows/parent%2Fone/delegate');
  assert.deepEqual(Object.keys(calls[1].body).sort(), ['requestId', 'role', 'task']);
  findNode(render(), (n) => n.type === 'dialog')!.props.onCancel(event);
  assert.equal(closes, 0, 'pending creation cannot close and lose its request identity');
  finish({ workflow: { id: 'wrong', conversationId: 'another-chat', delegation: { parentId: parent.id } } });
  await nextTurn();
  assert.match(text(render()), /尚未确认子任务记录/);
  assert.equal(created.length, 0);
  input().props.onChange({ target: { value: 'Changed task after explicit correction' } });
  submit();
  await nextTurn();
  assert.notEqual(calls[2].body.requestId, calls[1].body.requestId);
  finish({ workflow: { id: 'child', conversationId: 'chat', delegation: { parentId: parent.id } } });
  await nextTurn();
  assert.equal(created[0].id, 'child');
  assert.equal(closes, 1);
  assert.match(notices[0].message, /进展和改动交付会分别显示/);
  h.unmount();
  assert.equal(h.exports.uiUpdateBlocked(), false);
});

test('read-only parent stays read-only in manual child wording and role request', async () => {
  const h = uiHarness(code),
    calls: any[] = [];
  const props = {
    parent: { ...parent, input: { permissionMode: 'read-only' } },
    initialRole: 'worker',
    api: async (_path: string, body: any) => {
      calls.push(body);
      return { workflow: { id: 'child', conversationId: 'chat', delegation: { parentId: parent.id } } };
    },
    notify() {},
    onClose() {},
  };
  const render = () => h.render('CreateChildDialog', props);
  assert.match(text(render()), /此子代理只读/);
  findNode(render(), (n) => n.props['aria-label'] === '子代理任务')!.props.onChange({
    target: { value: 'Inspect only' },
  });
  findNode(render(), (n) => n.type === 'form')!.props.onSubmit(event);
  await nextTurn();
  assert.equal(calls[0].role, 'worker');
  assert.equal(calls[0].permissionMode, undefined);
  h.unmount();
});

test('project default persists only the chosen project, protects dirty state and retains failed edits', async () => {
  const h = uiHarness(code),
    calls: any[] = [],
    notices: any[] = [];
  let fail = true,
    finish!: (value: any) => void;
  const props: any = {
    project: { id: 'project/one', routingProfileId: undefined },
    notify: (n: any) => notices.push(n),
    api: async (path: string, body: any, method: string) => {
      calls.push({ path, body, method });
      if (method === 'GET')
        return path.endsWith('/local-memory')
          ? { exportEnabled: true, cliEnabled: false, files: [], warnings: [] }
          : path.endsWith('/memory')
            ? { content: '', revision: 1 }
            : { profiles: [profile] };
      if (fail) throw Error('Synthetic project failure');
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  };
  const render = () => h.render('MemoryEditor', props);
  const select = () => findNode(render(), (n) => n.type?.name === 'ProjectRoutingDefault')!;
  const save = () =>
    findNode(render(), (n) => n.type === 'button' && text(n).endsWith('保存记忆与设置'))!.props.onClick();
  render();
  await nextTurn();
  select().props.onChange(profile.id);
  render();
  assert.equal(h.exports.uiUpdateBlocked(), true);
  save();
  await nextTurn();
  assert.match(notices.at(-1).message, /Synthetic project failure/);
  assert.equal(select().props.selected, profile.id);
  fail = false;
  save();
  save();
  await nextTurn();
  assert.equal(calls.filter((c) => c.method === 'PATCH').length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))), {
    path: '/api/projects/project%2Fone/routing-profile',
    body: { profileId: profile.id },
    method: 'PATCH',
  });
  finish({ ...props.project, routingProfileId: profile.id });
  await nextTurn();
  render();
  assert.equal(h.exports.uiUpdateBlocked(), false);
  assert.match(notices.at(-1).message, /项目记忆已保存/);
  select().props.onChange('');
  save();
  await nextTurn();
  assert.equal(calls.at(-1).body.profileId, null);
  finish(props.project);
  await nextTurn();
  h.unmount();
});

test('project routing ignores a previous project save response while the next project is being edited', async () => {
  const h = uiHarness(code),
    pending: Array<(value: any) => void> = [],
    notices: any[] = [];
  const props: any = {
    project: { id: 'first' },
    notify: (notice: any) => notices.push(notice),
    api: async (path: string, _body: any, method: string) =>
      method === 'GET'
        ? path.endsWith('/local-memory')
          ? { exportEnabled: true, cliEnabled: false, files: [], warnings: [] }
          : path.endsWith('/memory')
            ? { content: '', revision: 1 }
            : { profiles: [profile] }
        : new Promise((resolve) => pending.push(resolve)),
  };
  const render = () => h.render('MemoryEditor', props);
  const edit = () => findNode(render(), (n) => n.type?.name === 'ProjectRoutingDefault')!.props.onChange(profile.id);
  const save = () =>
    findNode(render(), (n) => n.type === 'button' && text(n).endsWith('保存记忆与设置'))!.props.onClick();
  render();
  await nextTurn();
  edit();
  save();
  await nextTurn();
  props.project = { id: 'second' };
  render();
  await nextTurn();
  edit();
  save();
  await nextTurn();
  pending[0]({ id: 'first', routingProfileId: profile.id });
  await nextTurn();
  assert.equal(findNode(render(), (n) => n.type?.name === 'ProjectRoutingDefault')!.props.disabled, true);
  assert.equal(notices.length, 0);
  assert.equal(h.exports.uiUpdateBlocked(), true);
  pending[1]({ id: 'second', routingProfileId: profile.id });
  await nextTurn();
  render();
  assert.equal(h.exports.uiUpdateBlocked(), false);
  assert.equal(notices.length, 1);
  h.unmount();
});

test('member completion never implies delivery and inherited or stopped members cannot deliver', () => {
  const h = uiHarness(code);
  const workspace = { id: 'tree', state: 'ready', directory: 'C:/Synthetic/tree', branch: 'child/synthetic' };
  const workflow: any = { ...parent, status: 'completed', executionWorkspaceId: 'tree', executionWorkspace: workspace };
  let deliveries = 0;
  const render = (value = workflow) =>
    h.render('ChildWorkspaceStatus', { workflow: value, onDeliver: () => deliveries++, onContinue() {} });
  assert.match(text(render()), /子任务已结束；改动尚未交付/);
  findNode(render(), (n) => n.type === 'button' && text(n) === '交付改动')!.props.onClick();
  assert.equal(deliveries, 1);
  for (const status of ['applying', 'applied', 'unchanged', 'conflict', 'blocked', 'recovery-required']) {
    const tree = render({
      ...workflow,
      executionDeliveryWorkflowId: workflow.id,
      executionWorkspace: {
        ...workspace,
        delivery: { status, changedPaths: ['src/fixture.ts'], reason: 'Synthetic receipt' },
      },
    });
    const retry = findNode(tree, (n) => n.type === 'button' && text(n) === '重新尝试交付');
    assert.equal(Boolean(retry), ['conflict', 'blocked', 'recovery-required'].includes(status));
    assert.match(text(tree), /Synthetic receipt/);
    if (status === 'conflict') assert.match(text(tree), /交付冲突，改动仍保留/);
  }
  for (const status of ['applied', 'unchanged']) {
    for (const executionDeliveryWorkflowId of [undefined, 'earlier-attempt']) {
      const tree = render({
        ...workflow,
        executionDeliveryWorkflowId,
        executionWorkspace: {
          ...workspace,
          delivery: { status, changedPaths: ['old-attempt.ts'], reason: 'Previous attempt receipt' },
        },
      });
      assert.match(text(tree), /子任务已结束；改动尚未交付/);
      assert.doesNotMatch(text(tree), /Previous attempt receipt|old-attempt.ts|改动已交付|没有需要交付的改动/);
      assert.ok(findNode(tree, (n) => n.type === 'button' && text(n) === '交付改动'));
    }
  }
  const unstampedConflict = render({
    ...workflow,
    executionWorkspace: {
      ...workspace,
      delivery: { status: 'conflict', changedPaths: [], reason: 'Retained diagnosis' },
    },
  });
  assert.match(text(unstampedConflict), /交付冲突，改动仍保留.*Retained diagnosis/);
  const inherited = render({ ...workflow, inheritedExecutionWorkspace: true });
  assert.match(text(inherited), /沿用父任务工作目录（只读）/);
  assert.equal(
    findNode(inherited, (n) => n.type === 'button'),
    undefined,
  );
  for (const status of ['running', 'failed', 'cancelled', 'interrupted']) {
    const tree = render({
      ...workflow,
      status,
      recovery: { reason: 'Host condition failed.', recoveryCondition: 'Restore the original checkout.' },
    });
    assert.equal(
      findNode(tree, (n) => n.type === 'button' && /交付/.test(text(n))),
      undefined,
    );
    assert.match(text(tree), /Restore the original checkout/);
  }
  h.unmount();
});
