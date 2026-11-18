import { buildSpendOverview } from '../src/server/spend-ledger.ts';
import { spendFixture } from './helpers/spend-fixture.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findNode, nextTurn, uiBundle, uiHarness, type UiNode } from './helpers/ui-harness.ts';

const studioBundle = uiBundle('src/ui/Studio.tsx', true);
const usageBundle = uiBundle('src/ui/UsagePage.tsx');
const settingsBundle = uiBundle('src/ui/AppSettings.tsx');
const appBundle = uiBundle('src/ui/App.tsx');

function text(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  return node && typeof node === 'object' ? text((node as UiNode).props?.children) : '';
}
const button = (tree: unknown, label: string) =>
  findNode(tree, (node) => node.type === 'button' && text(node) === label)!;
const stamp = '2026-10-04T12:00:00Z';
const state = {
  projects: [{ id: 'p', name: 'Project', path: 'C:/Fixture' }],
  conversations: [],
  workflows: [],
  runs: [{ id: 'run-a', status: 'completed', prompt: 'Fixture run', route: { model: 'fixture' }, startedAt: stamp }],
  runtimes: [],
  targets: [],
  app: { version: 'test' },
  settings: { maxQuotaAgeSeconds: 120 },
  approvals: [],
};

test('usage navigation has one tab level and restores the old consumption selection', async () => {
  for (const selection of ['["usage","compact","","","all","task"]', 'invalid']) {
    const saved = new Map([
      ['pugport-ui-page', 'resources'],
      ['pugport-usage-selection', selection],
    ]);
    const h = uiHarness(await studioBundle, {
      __backend: { state, api: async () => ({}), reload: async () => {}, connection: 'connected' },
      sessionStorage: {
        getItem: (key: string) => saved.get(key),
        setItem: (key: string, value: string) => saved.set(key, value),
      },
    });
    const render = () => h.render('default');
    const usage = () => findNode(render(), (node) => node.type?.name === 'UsagePage');
    assert.equal(usage()!.props.view, selection === 'invalid' ? 'quota' : 'usage');
    for (const [label, view] of [
      ['额度', 'quota'],
      ['消耗', 'usage'],
    ]) {
      button(render(), label).props.onClick();
      assert.equal(usage()!.props.view, view);
    }
    button(render(), '连接').props.onClick();
    assert.equal(usage(), undefined);
    button(render(), '任务列表').props.onClick();
    button(render(), '执行记录').props.onClick();
    assert.equal(button(render(), '返回对话'), undefined);
    h.unmount();
  }
});

test('opening a scheduled run keeps its archived conversation available to the workspace', async () => {
  const archived = { id: 'archived', projectId: 'p', title: 'Archived', archivedAt: stamp };
  const h = uiHarness(await studioBundle, {
    __backend: { state, api: async () => ({}), reload: async () => {}, connection: 'connected' },
  });
  const render = () => h.render('default');
  button(render(), '任务列表').props.onClick();
  await findNode(render(), (node) => node.type?.name === 'ScheduledTasks')!.props.onConversation(archived);
  const split = findNode(render(), (node) => node.type?.name === 'SplitView')!;
  const pane = split.props.children('archived', 0);
  assert.equal(pane.props.conversation?.id, 'archived');
  h.unmount();
});

test('history inspection clears an old search and its empty pane asks for a record selection', async () => {
  const backend = { state, api: async () => ({}), reload: async () => {}, connection: 'connected' };
  const harness = uiHarness(await studioBundle, { __backend: backend });
  let tree = harness.render('default');
  // Run records sit under 任务, one tab over from the queue.
  button(tree, '任务列表').props.onClick();
  tree = harness.render('default');
  button(tree, '执行记录').props.onClick();
  tree = harness.render('default');
  assert.equal(findNode(tree, (node) => node.type?.name === 'EmptyState')?.props.title, '选择一条执行记录');
  const search = () => findNode(tree, (node) => node.props['aria-label'] === '搜索执行记录')!;
  search().props.onChange({ target: { value: 'does-not-match' } });
  tree = harness.render('default');
  assert.match(text(tree), /暂无匹配记录/);
  button(tree, '用量与连接').props.onClick();
  tree = harness.render('default');
  button(tree, '额度').props.onClick();
  tree = harness.render('default');
  findNode(tree, (node) => node.type?.name === 'UsagePage')!.props.onInspect('run-a');
  tree = harness.render('default');
  assert.equal(search().props.value, '');
  assert.equal(findNode(tree, (node) => node.type?.name === 'RunOutput')?.props.run.id, 'run-a');
  const selectedRow = findNode(tree, (node) => node.props.className === 'run-record-item selected')!;
  assert.ok(selectedRow);
  assert.equal(selectedRow.props.children.length, 3, 'one row contains the user text, status and time');
  assert.equal(selectedRow.props.children[0].type, 'span');
  assert.equal(selectedRow.props.children[1].type.name, 'StatusPill');
  assert.equal(selectedRow.props.children[2].type, 'time');
  assert.equal(
    findNode(selectedRow, (node) => node.type === 'code'),
    undefined,
  );
  const list = findNode(tree, (node) => node.props['aria-label'] === '执行记录列表')!;
  assert.equal(
    findNode(list, (node) => node.props['aria-label'] === '搜索执行记录'),
    undefined,
    'search stays outside the horizontal record strip on narrow windows',
  );
  harness.unmount();
});

test('category navigation resets content and settings restores the selected category', async () => {
  const h = uiHarness(await studioBundle, {
    __backend: { state, api: async () => ({}), reload: async () => {}, connection: 'connected' },
  });
  const scroll = { scrollTop: 1400 };
  findNode(h.render('default'), (node) => node.props.id === 'main-content')!.props.ref.current = scroll;
  button(h.render('default'), '设置').props.onClick();
  let tree = h.render('default');
  assert.equal(scroll.scrollTop, 0);
  const shell = () => findNode(tree, (node) => node.type?.name === 'SettingsShell')!;
  shell().props.onCategory('advanced');
  tree = h.render('default');
  assert.equal(shell().props.category, 'advanced');
  assert.equal(findNode(tree, (node) => node.type?.name === 'SettingsPage')!.props.category, 'advanced');
  button(tree, '用量与连接').props.onClick();
  tree = h.render('default');
  assert.equal(shell(), undefined);
  button(tree, '设置').props.onClick();
  tree = h.render('default');
  assert.equal(shell().props.category, 'advanced');
  h.unmount();
});

const editableSettings = {
  ...state.settings,
  designProvider: 'claude',
  architectureProvider: 'codex',
  routineProvider: 'codex',
  notifyOnFinish: 'background',
  defaultProjectPath: 'C:/Fixture',
  reservePercent: 10,
  refreshSeconds: 60,
  preferCli: true,
  unknownQuotaPolicy: 'manual-only',
  maxConcurrentRuns: 1,
};

test('personal instructions count characters and save only that field on blur or category unmount', async () => {
  const writes: any[] = [];
  const props = {
    category: 'personal',
    state: { ...state, settings: { ...editableSettings } },
    api: async (...args: any[]) => {
      writes.push(args);
    },
    reload: async () => {},
    notify() {},
  };
  const h = uiHarness(await appBundle);
  const render = () => h.render('SettingsPage', props);
  const field = () => findNode(render(), (node) => node.props.id === 'global-instructions')!;
  field().props.onChange({ target: { value: 'First line\nSecond line' } });
  assert.doesNotMatch(text(render()), /22 \/ 4000/);
  assert.equal(writes.length, 0);
  field().props.onBlur();
  await nextTurn();
  assert.deepEqual(JSON.parse(JSON.stringify(writes[0])), [
    '/api/settings',
    { globalInstructions: 'First line\nSecond line' },
    'PATCH',
  ]);
  field().props.onChange({ target: { value: 'x'.repeat(3500) } });
  assert.equal(
    findNode(render(), (node) => node.props.id === 'global-instructions-count'),
    undefined,
  );
  field().props.onChange({ target: { value: 'x'.repeat(3501) } });
  assert.match(text(render()), /3501 \/ 4000/);
  field().props.onChange({ target: { value: '' } });
  h.unmount();
  await nextTurn();
  assert.equal(writes.at(-1)[1].globalInstructions, '');
});

for (const failureAt of ['write', 'reload']) {
  test(`immediate settings ${failureAt} failure reports whether the value was saved`, async () => {
    const notices: any[] = [];
    const props = {
      state: { ...state, settings: { ...editableSettings } },
      api: async () => {
        if (failureAt === 'write') throw Error('write unavailable');
      },
      reload: async () => {
        throw Error('refresh unavailable');
      },
      notify: (notice: any) => notices.push(notice),
    };
    const h = uiHarness(await appBundle, { Error });
    const field = () =>
      findNode(h.render('SettingsPage', props), (node) => node.props['aria-label'] === '任务完成通知')!;
    field().props.onChange({ target: { value: 'always' } });
    await nextTurn();
    assert.equal(field().props.value, failureAt === 'write' ? 'background' : 'always');
    assert.equal(notices.at(-1).tone, 'error');
    assert.match(
      notices.at(-1).message,
      failureAt === 'write' ? /write unavailable/ : /设置已保存，但刷新失败.*refresh unavailable/,
    );
    assert.equal(button(h.render('SettingsPage', props), '保存设置'), undefined);
    h.unmount();
  });
}

test('usage spend clears old-scope rows, retries failures, and ignores obsolete responses', async () => {
  const requests: Array<{ path: string; resolve: (value: unknown) => void; reject: (error: Error) => void }> = [];
  const response = (taskId: string) => {
    const data = buildSpendOverview(spendFixture());
    data.insights.tasks[0]!.taskId = taskId;
    return data;
  };
  const props = {
    state,
    onInspect() {},
    api: async (path: string) => new Promise((resolve, reject) => requests.push({ path, resolve, reject })),
  };
  const harness = uiHarness(await uiBundle('src/ui/UsageSpend.tsx'), {
    requestAnimationFrame: (callback: () => void) => callback(),
  });
  let tree = harness.render('UsageSpend', props);
  await nextTurn();
  assert.equal(requests[0]!.path, '/api/usage/spend?range=7d&kind=all&billing=all');
  requests[0]!.resolve(response('old-project'));
  await nextTurn();
  tree = harness.render('UsageSpend', props);
  const taskTable = () => findNode(tree, (node) => node.type?.name === 'SpendLedger');
  assert.equal(taskTable()!.props.data.insights.tasks[0].taskId, 'old-project');
  const filter = (value: string) => {
    findNode(tree, (node) => node.props['aria-label'] === '用量项目范围')!.props.onChange({ target: { value } });
    tree = harness.render('UsageSpend', props);
  };
  filter('C:/Second');
  await nextTurn();
  tree = harness.render('UsageSpend', props);
  assert.equal(taskTable(), undefined, 'old rows must not appear under the new scope while loading');
  assert.equal(new URL(requests[1]!.path, 'http://fixture.test').searchParams.get('project'), 'C:/Second');
  requests[1]!.reject(Error('insights unavailable'));
  await nextTurn();
  tree = harness.render('UsageSpend', props);
  assert.match(text(findNode(tree, (node) => node.props.role === 'alert')), /insights unavailable/);
  assert.equal(taskTable(), undefined);
  button(tree, '重试').props.onClick();
  tree = harness.render('UsageSpend', props);
  requests[2]!.resolve(response('second-project'));
  await nextTurn();
  tree = harness.render('UsageSpend', props);
  assert.equal(taskTable()!.props.data.insights.tasks[0].taskId, 'second-project');
  filter('C:/Third');
  filter('C:/Fourth');
  requests[4]!.resolve(response('fourth-project'));
  requests[3]!.resolve(response('obsolete-third-project'));
  await nextTurn();
  tree = harness.render('UsageSpend', props);
  assert.equal(taskTable()!.props.data.insights.tasks[0].taskId, 'fourth-project');
  taskTable()!.props.onDay('synthetic-account', '2026-11-03');
  tree = harness.render('UsageSpend', props);
  assert.equal(taskTable(), undefined, 'opening another account day also clears the old overview');
  assert.equal(new URL(requests[5]!.path, 'http://fixture.test').searchParams.get('account'), 'synthetic-account');
  harness.unmount();
});

for (const component of ['SettingsFolder']) {
  test(`${component} exposes a retry after status failure and never offers installation before status is known`, async () => {
    const requests: Array<{ resolve: (value: unknown) => void; reject: (error: Error) => void }> = [];
    const props = {
      kind: 'data',
      notify() {},
      api: async (path: string) =>
        path === '/api/app-info'
          ? new Promise((resolve, reject) => requests.push({ resolve, reject }))
          : { polish: null },
    };
    const harness = uiHarness(await settingsBundle, { Error });
    let tree = harness.render(component, props);
    const status = () => {
      const node = findNode(tree, (item) => item.type?.name === 'AppInfoStatus')!;
      return node.type(node.props);
    };
    assert.match(text(status()), /正在读取本机状态/);
    assert.equal(button(tree, '安装'), undefined);
    requests[0]!.reject(Error('local service unavailable'));
    await nextTurn();
    tree = harness.render(component, props);
    assert.match(text(status()), /状态读取失败.*local service unavailable/);
    assert.equal(button(tree, '安装'), undefined);
    button(status(), '重试').props.onClick();
    tree = harness.render(component, props);
    assert.match(text(status()), /正在读取本机状态/);
    requests[1]!.resolve({
      paths: { dataDir: 'C:/Fixture/data', memoryDir: 'C:/Fixture/memory' },
      tools: {
        ripgrep: true,
        markitdown: false,
        everything: 'ready',
        voice: true,
        images: { model: true, analyzed: 0 },
        memory: { model: true, passages: 0 },
      },
    });
    await nextTurn();
    tree = harness.render(component, props);
    assert.equal(status(), null);
    assert.match(text(tree), /C:\/Fixture\/data/);
    harness.unmount();
  });
}

test('Store plus existing footer items, settings archives, and scheduled-first shared task tabs', async () => {
  const active = { ...state, runs: [{ ...state.runs[0], status: 'running' }] };
  const h = uiHarness(await studioBundle, {
    __backend: { state: active, api: async () => ({}), reload: async () => {}, connection: 'connected' },
  });
  const render = () => h.render('default');
  const footer = () => findNode(render(), (node) => node.props.className === 'sidebar-tools')!;
  assert.equal(text(footer()), '扩展任务列表1用量与连接设置');
  button(footer(), '任务列表1').props.onClick();
  assert.ok(findNode(render(), (node) => node.type?.name === 'ScheduledTasks'));
  const tabs = () => findNode(render(), (node) => node.props.className === 'page-tabs')!;
  assert.equal(text(tabs()), '定时任务任务队列1执行记录');
  for (const label of ['任务队列1', '执行记录', '定时任务']) {
    button(tabs(), label).props.onClick();
    assert.equal(text(tabs()), '定时任务任务队列1执行记录');
  }
  button(footer(), '设置').props.onClick();
  findNode(render(), (node) => node.type?.name === 'SettingsShell')!.props.onCategory('conversation');
  const history = () => findNode(render(), (node) => node.props.id === 'settings-conversations')!;
  assert.deepEqual(
    ['管理已归档', '管理最近删除', '管理已移除的项目'].map(
      (label) => findNode(history(), (node) => node.props['aria-label'] === label)?.type,
    ),
    ['button', 'button', 'button'],
  );
  assert.equal(
    findNode(history(), (node) => node.type?.name === 'RemovedProjectsSheet'),
    undefined,
  );
  findNode(render(), (node) => node.props['aria-label'] === '管理已移除的项目')!.props.onClick();
  assert.equal(
    findNode(render(), (node) => node.type?.name === 'RemovedProjectsSheet')?.type?.name,
    'RemovedProjectsSheet',
  );
  findNode(render(), (node) => node.type?.name === 'RemovedProjectsSheet')!.props.onClose();
  assert.equal(
    findNode(render(), (node) => node.type?.name === 'RemovedProjectsSheet'),
    undefined,
  );
  for (const [label, kind] of [
    ['管理已归档', 'archived'],
    ['管理最近删除', 'deleted'],
  ]) {
    findNode(render(), (node) => node.props['aria-label'] === label)!.props.onClick();
    const panel = findNode(render(), (node) => node.type?.name === 'ConversationArchive')!;
    assert.equal(panel.props.kind, kind);
    panel.props.onClose();
  }
  h.unmount();
});

test('connector callback stays stable across Studio renders and opens Connections', async () => {
  const h = uiHarness(await studioBundle, {
    __backend: { state, api: async () => ({}), reload: async () => {}, connection: 'connected' },
  });
  const workspace = () =>
    findNode(h.render('default'), (node) => node.type?.name === 'SplitView')!.props.children('', 0);
  const callback = workspace().props.onManageConnectors;
  assert.equal(workspace().props.onManageConnectors, callback);
  callback();
  const tree = h.render('default');
  assert.equal(button(tree, '扩展').props['aria-current'], 'page');
  assert.equal(findNode(tree, (node) => node.type?.name === 'ExtensionsHome')!.props.tab, 'connections');
  h.unmount();
});

test('Chats history has three counted rows, keeps purge retries and preserves full removed project state', async () => {
  const removedProjects = [
    { id: 'hidden', name: 'Hidden', path: 'C:/Synthetic/hidden', removedAt: '2026-10-26T00:00:00Z' },
    { id: 'retry', name: 'Retry', path: 'C:/Synthetic/retry', removedAt: '2026-10-26T00:00:00Z', purgePending: true },
    { id: 'new', name: 'New', path: 'C:/Synthetic/new', removedAt: '2026-10-27T01:00:00Z' },
  ];
  let fail = false;
  const backend = {
    state: {
      ...state,
      removedProjects,
      settings: { ...state.settings, removedProjectsClearedAt: '2026-10-27T00:00:00Z' },
    },
    api: async (path: string) => {
      if (path === '/api/conversation-history') {
        if (fail) throw Error('Synthetic offline');
        return { archived: 7, deleted: 3 };
      }
      return {};
    },
    reload: async () => {},
    connection: 'connected',
  };
  const h = uiHarness(await studioBundle, { __backend: backend });
  const render = () => h.render('default');
  const group = () => findNode(render(), (node) => node.props.id === 'settings-conversations')!;
  const row = (title: string) =>
    findNode(group(), (node) => node.type?.name === 'SettingsRow' && node.props.title === title)!;
  try {
    button(render(), '设置').props.onClick();
    findNode(render(), (node) => node.type?.name === 'SettingsShell')!.props.onCategory('conversation');
    render();
    await nextTurn();
    assert.deepEqual(
      ['已归档', '最近删除', '已移除的项目'].map((title) => row(title).props.status),
      ['7 个对话', '3 个对话', '2 个项目'],
    );
    const rows = group().props.children.flat();
    assert.equal(rows.length, 3);
    assert.ok(rows.every((node: UiNode) => node.type.name === 'SettingsRow'));
    assert.equal(
      findNode(group(), (node) => node.type?.name === 'RemovedProjects'),
      undefined,
    );
    findNode(group(), (node) => node.props['aria-label'] === '管理已移除的项目')!.props.onClick();
    const sheet = findNode(render(), (node) => node.type?.name === 'RemovedProjectsSheet')!;
    assert.equal(
      JSON.stringify(sheet.props.projects.map((project: any) => project.id)),
      JSON.stringify(['retry', 'new']),
    );
    assert.equal(
      backend.state.removedProjects,
      removedProjects,
      'Settings filtering never replaces the full state list',
    );
    assert.equal(backend.state.removedProjects.length, 3);
    sheet.props.onClose();

    fail = true;
    findNode(group(), (node) => node.props['aria-label'] === '管理已归档')!.props.onClick();
    render();
    await nextTurn();
    assert.equal(row('已归档').props.status, '数量暂不可用');
    assert.equal(row('最近删除').props.status, '数量暂不可用');
    assert.equal(row('已移除的项目').props.status, '2 个项目');
    fail = false;
    findNode(render(), (node) => node.type?.name === 'ConversationArchive')!.props.onClose();
    render();
    await nextTurn();
    assert.equal(row('已归档').props.status, '7 个对话');
  } finally {
    h.unmount();
  }
});
