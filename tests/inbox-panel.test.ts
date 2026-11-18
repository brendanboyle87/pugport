import assert from 'node:assert/strict';
import test from 'node:test';
import type { InboxAction, InboxNotice, InboxSummary } from '../src/shared/inbox.ts';
import { findNode, text, uiBundle, uiHarness } from './helpers/ui-harness.ts';

const bundle = uiBundle('src/ui/InboxPanel.tsx');
const sample = (action: InboxAction = { kind: 'sign-in', runtimeId: 'synthetic/account' }): InboxNotice => ({
  id: 'synthetic/notice',
  kind: 'executor-login',
  key: 'synthetic/account',
  severity: 'action',
  title: 'Synthetic needs a sign-in',
  body: 'Synthetic text, never a live account.',
  action,
  createdAt: '2026-10-27T08:00:00Z',
  updatedAt: '2026-10-27T08:00:00Z',
  count: 3,
});
async function fixture(
  notices: InboxNotice[] = [],
  targets: Array<{ id: string; accountId?: string }> = [{ id: 'synthetic/account', accountId: 'managed' }],
) {
  const h = uiHarness(await bundle);
  const calls: Array<{ path: string; body: unknown }> = [];
  const reportCalls: string[] = [];
  const pages: string[] = [];
  const runs: string[] = [];
  const projects: string[] = [];
  const messages: Array<{ tone: string; message: string }> = [];
  let reloads = 0;
  let fail = false;
  const props = {
    targets,
    summary: {
      unread: notices.filter((n) => !n.readAt).length,
      attention: notices.filter((n) => n.severity === 'action').length,
      open: notices,
    } as InboxSummary,
    api: async (path: string, body: unknown): Promise<unknown> => {
      if (path === '/api/problem-reports/inbox') {
        reportCalls.push(path);
        return { reports: [] };
      }
      calls.push({ path, body });
      if (fail) throw new Error('Synthetic API failure');
      return {};
    },
    reload: async () => {
      reloads++;
    },
    notify: (message: { tone: string; message: string }) => messages.push(message),
    openPage: (page: string) => pages.push(page),
    onRun: (id: string) => runs.push(id),
    onProjectRules: (id: string) => projects.push(id),
  };
  const render = () => h.render('InboxButton', props);
  const button = (label: string) =>
    findNode(
      render(),
      (node) =>
        node.type === 'button' &&
        (node.props['aria-label'] === label || (label === '信箱' && node.props['aria-label']?.startsWith('信箱，'))),
    )!;
  const open = async () => {
    await button('信箱').props.onClick();
    return render();
  };
  return {
    h,
    props,
    calls,
    reportCalls,
    pages,
    runs,
    projects,
    messages,
    render,
    button,
    open,
    reloads: () => reloads,
    fail: (value: boolean) => {
      fail = value;
    },
  };
}

test('Batch C rule action opens the matching project memory before dismissing the reminder', async () => {
  const f = await fixture([
    { ...sample({ kind: 'open-project-rules', projectId: 'synthetic/project' }), kind: 'rule-added', severity: 'info' },
  ]);
  await f.open();
  const api = f.props.api;
  f.props.api = async (path, body) => {
    assert.deepEqual(f.projects, ['synthetic/project']);
    return api(path, body);
  };
  const action = findNode(f.render(), (node) => node.type === 'button' && text(node) === '查看项目规则');
  assert.ok(action);
  await action.props.onClick();
  assert.equal(f.calls[1]?.path, '/api/inbox/synthetic%2Fnotice/dismiss');
  assert.equal(f.reloads(), 2);
  assert.equal(
    findNode(f.render(), (node) => node.props.role === 'dialog'),
    undefined,
  );
  f.h.unmount();
});

test('Batch C Studio connects the rule action to the selected project memory and shows lane scope in the tooltip', async () => {
  const stamp = '2026-10-28T12:00:00Z';
  const projects = ['first', 'second'].map((id) => ({
    id,
    name: id,
    path: `C:/synthetic/${id}`,
    createdAt: stamp,
    updatedAt: stamp,
  }));
  const parent = { id: 'parent', projectId: 'first', title: 'Parent', createdAt: stamp, updatedAt: stamp };
  const lane = {
    ...parent,
    id: 'lane',
    title: 'Lane',
    lane: { parentConversationId: parent.id, sourceWorkflowId: 'synthetic', files: ['src/ui'] },
  };
  const state = {
    projects,
    conversations: [parent, lane],
    workflows: [],
    runs: [],
    runtimes: [],
    targets: [],
    app: { version: 'test' },
    settings: { maxQuotaAgeSeconds: 120 },
    approvals: [],
  };
  const h = uiHarness(await uiBundle('src/ui/Studio.tsx', true), {
    __backend: { state, api: async () => ({}), reload: async () => {}, connection: 'connected' },
  });
  try {
    const render = () => h.render('default');
    const laneButton = findNode(
      render(),
      (node) =>
        node.type === 'button' && node.props.className?.includes('conversation-link') && text(node).includes('Lane'),
    );
    assert.ok(laneButton);
    assert.match(laneButton.props.title, /范围：src\/ui/);
    const inbox = findNode(render(), (node) => node.type?.name === 'InboxButton')!;
    await inbox.props.onProjectRules('second');
    const memory = findNode(render(), (node) => node.type?.name === 'MemoryDialog');
    assert.ok(memory);
    assert.equal(memory.props.project.id, 'second');
  } finally {
    h.unmount();
  }
});

test('incompatibility body renders three paragraphs and expandable raw details', async () => {
  const f = await fixture([
    {
      ...sample(),
      kind: 'executor-incompatible',
      body: 'First paragraph\n\nSecond paragraph\n\nThird paragraph',
      details: 'error: synthetic raw line',
    },
  ]);
  const tree = await f.open();
  const content = findNode(tree, (node) => node.props.className === 'inbox-content')!;
  const paragraphs = (content.props.children as unknown[]).flat(Infinity).filter((node: any) => node?.type === 'p');
  assert.deepEqual(Array.from(paragraphs, text), ['First paragraph', 'Second paragraph', 'Third paragraph']);
  const details = findNode(content, (node) => node.type === 'details')!;
  assert.ok(details);
  assert.equal(details.props.translate, undefined);
  assert.equal(text(findNode(details, (node) => node.type === 'summary')), '原始报错');
  const pre = findNode(details, (node) => node.type === 'pre')!;
  assert.equal(pre.props.translate, undefined);
  assert.equal(text(pre), 'error: synthetic raw line');
  f.h.unmount();
});

test('empty inbox opens a dialog, marks read once and closes without another request', async () => {
  const f = await fixture();
  assert.equal(f.button('信箱').props['aria-expanded'], false);
  assert.equal(
    findNode(f.render(), (node) => node.props.className === 'nav-count'),
    undefined,
  );
  const tree = await f.open();
  assert.equal(findNode(tree, (node) => node.props.role === 'dialog')?.props['aria-modal'], 'true');
  assert.match(text(tree), /一切正常/);
  assert.match(text(tree), /需要你登录、换密钥或更新时/);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.reportCalls, ['/api/problem-reports/inbox']);
  assert.equal(f.calls[0]!.path, '/api/inbox/read');
  assert.deepEqual(Object.keys(f.calls[0]!.body as object), []);
  assert.equal(f.reloads(), 1);
  f.button('关闭信箱').props.onClick();
  assert.equal(
    findNode(f.render(), (node) => node.props.role === 'dialog'),
    undefined,
  );
  assert.equal(f.calls.length, 1);
  f.h.unmount();
});

test('unread action badge, verbatim body and dismiss use the supplied notice identity', async () => {
  const f = await fixture([{ ...sample(), bodyVerbatim: true }]);
  assert.match(f.button('信箱').props.className, /needs-action/);
  assert.equal(text(findNode(f.render(), (node) => node.props.className === 'nav-count')), '1');
  const tree = await f.open();
  assert.match(text(tree), /登录/);
  assert.match(text(tree), /×3/);
  assert.equal(findNode(tree, (node) => node.type === 'p')?.props.translate, 'no');
  await f.button('关闭提醒').props.onClick();
  assert.equal(f.calls.at(-1)!.path, '/api/inbox/synthetic%2Fnotice/dismiss');
  assert.deepEqual(Object.keys(f.calls.at(-1)!.body as object), []);
  assert.equal(f.reloads(), 2);
  f.props.summary = { unread: 0, attention: 0, open: [] };
  assert.match(text(f.render()), /一切正常/);
  assert.equal(
    findNode(f.render(), (node) => node.props.className === 'nav-count'),
    undefined,
  );
  f.h.unmount();
});

test('read action notices and unread warnings do not use the action accent', async () => {
  for (const notice of [
    { ...sample(), readAt: '2026-10-27T08:01:00Z' },
    { ...sample(), severity: 'warning' as const },
  ]) {
    const f = await fixture([notice]);
    assert.doesNotMatch(f.button('信箱').props.className, /needs-action/);
    f.h.unmount();
  }
});

test('semantic actions map to current pages, a run or the existing safe API callbacks', async () => {
  const actions: Array<{ action: InboxAction; label: string; page?: string; endpoint?: string; run?: string }> = [
    {
      action: { kind: 'sign-in', runtimeId: 'synthetic/account' },
      label: '登录',
      endpoint: '/api/accounts/synthetic%2Faccount/login',
    },
    { action: { kind: 'replace-key', runtimeId: 'synthetic' }, label: '更换密钥', page: 'integrations' },
    { action: { kind: 'update-cli', runtimeId: 'synthetic' }, label: '更新 CLI', page: 'integrations' },
    { action: { kind: 'open-usage', runtimeId: 'synthetic' }, label: '用量与连接', page: 'integrations' },
    { action: { kind: 'view-run', runId: 'synthetic-run' }, label: '查看运行记录', run: 'synthetic-run' },
    { action: { kind: 'refresh' }, label: '刷新', endpoint: '/api/refresh' },
  ];
  for (const expected of actions) {
    const f = await fixture([sample(expected.action)]);
    await f.open();
    const action = findNode(f.render(), (node) => node.type === 'button' && text(node) === expected.label)!;
    assert.ok(action, expected.label);
    await action.props.onClick();
    assert.equal(f.pages[0], expected.page);
    assert.equal(f.runs[0], expected.run);
    assert.equal(f.calls[1]?.path, expected.endpoint);
    assert.equal(
      findNode(f.render(), (node) => node.props.role === 'dialog'),
      undefined,
    );
    f.h.unmount();
  }
});

test('failed dismiss keeps the panel and notice, shows an error and permits retry', async () => {
  const f = await fixture([sample()]);
  await f.open();
  f.fail(true);
  await f.button('关闭提醒').props.onClick();
  assert.match(text(f.render()), /Synthetic needs a sign-in/);
  assert.match(f.messages[0]?.message ?? '', /Synthetic API failure/);
  assert.equal(f.messages[0]?.tone, 'error');
  assert.equal(f.button('关闭提醒').props.disabled, false);
  assert.equal(f.reloads(), 1);
  f.fail(false);
  await f.button('关闭提醒').props.onClick();
  assert.equal(f.reloads(), 2);
  f.h.unmount();
});

test('repeated dismiss clicks share one in-flight request', async () => {
  const f = await fixture([sample()]);
  await f.open();
  let requests = 0;
  let release!: () => void;
  f.props.api = async () => {
    requests++;
    await new Promise<void>((done) => {
      release = done;
    });
    return {};
  };
  const click = f.button('关闭提醒').props.onClick;
  const first = click();
  const second = click();
  assert.equal(requests, 1);
  assert.equal(f.button('关闭提醒').props.disabled, true);
  release();
  await Promise.all([first, second]);
  assert.equal(f.button('关闭提醒').props.disabled, false);
  f.h.unmount();
});

for (const scenario of [
  { name: 'managed', targets: [{ id: 'synthetic/account', accountId: 'managed' }], login: true },
  { name: 'default native', targets: [{ id: 'synthetic/account' }], login: false },
  { name: 'removed or unknown', targets: [{ id: 'other', accountId: 'managed' }], login: false },
]) {
  test(`sign-in handles ${scenario.name} accounts without creating an account`, async () => {
    const f = await fixture([sample()], scenario.targets);
    await f.open();
    const action = findNode(f.render(), (node) => node.type === 'button' && text(node) === '登录')!;
    await action.props.onClick();
    assert.equal(f.calls.length, scenario.login ? 2 : 1);
    assert.equal(f.calls[1]?.path, scenario.login ? '/api/accounts/synthetic%2Faccount/login' : undefined);
    assert.equal(f.pages[0], scenario.login ? undefined : 'integrations');
    assert.equal(f.messages.length, scenario.login ? 1 : 0);
    assert.equal(
      findNode(f.render(), (node) => node.props.role === 'dialog'),
      undefined,
    );
    f.h.unmount();
  });
}

test('only repeated notices show a count beside the relative time', async () => {
  for (const count of [1, 2]) {
    const f = await fixture([{ ...sample(), count }]);
    const tree = await f.open();
    const footer = findNode(tree, (node) => node.props.className === 'inbox-time')!;
    const time = findNode(footer, (node) => node.type === 'time')!;
    assert.equal(text(footer), text(time) + (count > 1 ? ` · ×${count}` : ''));
    f.h.unmount();
  }
});

test('rollback calls the guarded endpoint and keeps a failed notice available', async () => {
  for (const ok of [false, true]) {
    const f = await fixture([sample({ kind: 'rollback-cli', runtimeId: 'grok-synthetic' })]);
    await f.open();
    f.props.api = async (path, body) => {
      f.calls.push({ path, body });
      return { ok, reason: 'Synthetic rollback refused' };
    };
    const action = findNode(f.render(), (node) => node.type === 'button' && text(node) === '回滚')!;
    assert.ok(action);
    await action.props.onClick();
    assert.equal(f.calls.at(-1)?.path, '/api/inbox/rollback-cli');
    assert.equal((f.calls.at(-1)?.body as any).runtimeId, 'grok-synthetic');
    assert.equal(!!findNode(f.render(), (node) => node.props.role === 'dialog'), !ok);
    assert.equal(f.messages.at(-1)?.tone, ok ? 'success' : 'error');
    assert.equal(f.messages.at(-1)?.message, 'Synthetic rollback refused');
    f.h.unmount();
  }
});

test('GitHub card actions call the encoded desktop endpoints without opening another app', async () => {
  for (const kind of ['github-merge', 'github-run-suite'] as const) {
    const f = await fixture([{ ...sample({ kind, cardId: 'synthetic/card' }), kind: 'github-card' }]);
    const tree = await f.open();
    const expected = kind === 'github-merge' ? '合并' : '跑全量测试';
    const action = findNode(tree, (node) => node.type === 'button' && text(node) === expected)!;
    assert.ok(action);
    await action.props.onClick();
    assert.equal(
      f.calls[1].path,
      `/api/maintainer/cards/synthetic%2Fcard/${kind === 'github-merge' ? 'merge' : 'run-suite'}`,
    );
    assert.deepEqual(Object.keys(f.calls[1].body as object), []);
    assert.equal(f.pages.length, 0);
    assert.equal(f.runs.length, 0);
    f.h.unmount();
  }
});

test('GitHub external cards use the matching source, safe link and approval route', async () => {
  const notice: InboxNotice = {
    ...sample(),
    kind: 'external-request',
    externalRequest: {
      eventId: 'synthetic/github',
      source: 'github',
      senderName: 'Synthetic',
      scopeLabel: 'synthetic/repo#1',
      status: 'pending',
      suggestAlways: false,
      permalink: 'https://github.com/synthetic/repo/issues/1',
    },
  };
  const h = uiHarness(await bundle);
  const props = { notice, busy: false, decide: () => {}, onWorkflow: () => {} };
  let tree = h.render('ExternalRequestCard', props);
  assert.equal(findNode(tree, (n) => n.type === 'a')?.props.href, notice.externalRequest!.permalink);
  assert.match(text(tree), /在 GitHub 打开/);
  assert.ok(findNode(tree, (n) => n.props['aria-label'] === 'GitHub'));
  notice.externalRequest!.permalink = 'https://github.com.evil.test/synthetic';
  tree = h.render('ExternalRequestCard', props);
  assert.equal(
    findNode(tree, (n) => n.type === 'a'),
    undefined,
  );
  h.unmount();
  const f = await fixture([notice]);
  await f.open();
  const card = findNode(f.render(), (n) => n.type?.name === 'ExternalRequestCard');
  assert.ok(card);
  await card.props.decide('approve');
  assert.ok(f.calls.some((c) => c.path === '/api/github/requests/synthetic%2Fgithub/resolve'));
  f.h.unmount();
});
