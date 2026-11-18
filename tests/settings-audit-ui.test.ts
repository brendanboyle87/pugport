import assert from 'node:assert/strict';
import test from 'node:test';
import { builtinMediaWorkflows } from '../src/shared/media-workflows.ts';
import { findNode, nextTurn, uiBundle, uiHarness, type UiNode } from './helpers/ui-harness.ts';

const code = uiBundle('tests/helpers/confirmation-fixture.ts');
const text = (node: unknown): string => {
  if (Array.isArray(node)) return node.map(text).join('');
  if (node && typeof node === 'object') return text((node as UiNode).props?.children);
  return typeof node === 'string' || typeof node === 'number' ? String(node) : '';
};
const button = (tree: unknown, label: string) => {
  const node = findNode(tree, (node) => node.type === 'button' && text(node) === label);
  assert.ok(node, label);
  return node;
};

test('external agents: initial error, retry, polling failure preserves rows and poll success clears error', async () => {
  let poll = () => {};
  const h = uiHarness(await code, {
    Error,
    setInterval: (fn: () => void, ms: number) => {
      assert.equal(ms, 5000);
      poll = fn;
      return 1;
    },
  });
  let failed = true;
  const props = {
    notify() {},
    api: async () => {
      if (failed) throw new Error('Synthetic offline');
      return {
        agents: [{ id: 'muse', name: 'Synthetic Muse', kind: 'web', enabled: false }],
      };
    },
  };
  const render = () => h.render('ExternalAgentsCard', props);
  render();
  await nextTurn();
  assert.match(text(render()), /读不到外部智能体：Synthetic offline/);
  failed = false;
  button(render(), '重试').props.onClick();
  await nextTurn();
  assert.match(text(render()), /Synthetic Muse/);
  for (const label of ['Synthetic Muse 网址', 'Synthetic Muse 用量页面']) {
    const input = findNode(render(), (node) => node.props['aria-label'] === label)!;
    assert.equal(input.props.type, 'url');
    assert.equal(input.props.spellCheck, false);
  }
  assert.equal(
    findNode(render(), (node) => node.props.role === 'alert'),
    undefined,
  );
  failed = true;
  poll();
  await nextTurn();
  assert.match(text(render()), /Synthetic offline/);
  assert.match(text(render()), /Synthetic Muse/);
  failed = false;
  poll();
  await nextTurn();
  assert.match(text(render()), /Synthetic Muse/);
  assert.equal(
    findNode(render(), (node) => node.props.role === 'alert'),
    undefined,
  );
  h.unmount();
});

test('deleting a media workflow waits for confirmation; cancel keeps it', async () => {
  const h = uiHarness(await code);
  const entry = { ...builtinMediaWorkflows[0]!, id: 'synthetic', builtin: false };
  let items = [entry];
  const deletes: string[] = [];
  const props = {
    notify() {},
    api: async (path: string, _body: unknown, method: string) => {
      if (method === 'DELETE') {
        deletes.push(path);
        items = [];
        return {};
      }
      return { items };
    },
  };
  const render = () => h.render('MediaWorkflows', props);
  render();
  await nextTurn();
  findNode(render(), (node) => node.type === 'select')!.props.onChange({ target: { value: entry.id } });
  button(render(), '删除流程').props.onClick();
  const store = h.exports.confirmationStore;
  assert.equal(store.snapshot().options.tone, 'danger');
  assert.deepEqual(deletes, []);
  store.resolve(store.snapshot().id, false);
  await nextTurn();
  assert.ok(button(render(), '删除流程'));
  assert.deepEqual(deletes, []);
  button(render(), '删除流程').props.onClick();
  store.resolve(store.snapshot().id, true);
  await nextTurn();
  assert.deepEqual(deletes, ['/api/media-workflows/synthetic']);
  h.unmount();
});

test('Slack pairing dates use the selected app locale', async () => {
  const stamp = '2026-10-15T12:00:00Z';
  const dates: string[] = [];
  for (const locale of ['en', 'zh-TW']) {
    const h = uiHarness(await code, { localStorage: { getItem: () => locale } });
    const props = {
      notify() {},
      api: async () => ({ enabled: true, status: 'connected', users: [{ id: 'synthetic', pairedAt: stamp }] }),
    };
    h.render('SlackGateway', props);
    await nextTurn();
    button(h.render('SlackGateway', props), '开始设置').props.onClick();
    const tree = h.render('SlackGateway', props);
    const expected = new Date(stamp).toLocaleDateString(locale);
    assert.ok(text(tree).includes(expected + ' 配对'));
    dates.push(expected);
    h.unmount();
  }
  assert.notEqual(dates[0], dates[1]);
});

test('skills empty state opens the Extensions Skills tab', async () => {
  const calls: unknown[][] = [];
  const h = uiHarness(await code, {
    CustomEvent: class {
      constructor(
        public type: string,
        public options: any,
      ) {}
    },
    window: { dispatchEvent: (event: any) => calls.push([event.type, event.options.detail]) },
  });
  const props = {
    tab: 'skills',
    conversation: { id: 'synthetic' },
    api: async () => ({ items: [] }),
    notify() {},
    onOpenSettings: (...args: unknown[]) => calls.push(args),
  };
  h.render('SkillsTab', props);
  await nextTurn();
  button(h.render('SkillsTab', props), '安装 Skills').props.onClick();
  assert.deepEqual(calls, [['pugport:open-extensions', 'skills']]);
  const fallback = h.render('SkillsTab', { ...props, onOpenSettings: undefined });
  assert.match(text(fallback), /安装后即可按需调用。/);
  h.unmount();
});

test('semantic memory catalog title describes recall', async () => {
  const h = uiHarness(await uiBundle('src/ui/ExtensionCatalog.tsx'));
  const tree = h.render('ExtensionCatalog', {
    entries: h.exports.localComponents,
    local: { installations: [], info: { tools: {} } },
    installed: new Set(),
  });
  assert.ok(findNode(tree, (node) => node.type?.name === 'SettingsRow' && node.props.title === '按意思想起旧对话'));
  assert.equal(
    findNode(tree, (node) => /按意思搜索历史/.test(node.props.title ?? '')),
    undefined,
  );
  h.unmount();
});
