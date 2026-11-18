import assert from 'node:assert/strict';
import test from 'node:test';
import { findNode, nextTurn, text, uiBundle, uiHarness } from './helpers/ui-harness.ts';

const homeCode = await uiBundle('src/ui/ExtensionsHome.tsx');
const extensionsCode = await uiBundle('src/ui/Extensions.tsx');
const studioCode = await uiBundle('src/ui/Studio.tsx', true);
const button = (tree: unknown, label: string) =>
  findNode(tree, (node) => node.type === 'button' && text(node) === label)!;
const props = { api: async () => ({ items: [], catalog: [], tools: {}, installations: [] }), notify() {} };

test('tabs remember the last selection, explicit selection wins, and arrow keys wrap', () => {
  const saved = new Map([['pugport-extensions-tab', 'skills']]);
  const h = uiHarness(homeCode, {
    localStorage: {
      getItem: (key: string) => saved.get(key),
      setItem: (key: string, value: string) => saved.set(key, value),
    },
  });
  const render = () => h.render('ExtensionsHome', props);
  const selected = () => findNode(render(), (node) => node.props.role === 'tab' && node.props['aria-selected'])!;
  assert.equal(text(selected()), '技能');
  button(render(), '连接与服务').props.onClick();
  render();
  assert.equal(saved.get('pugport-extensions-tab'), 'connections');
  assert.equal(findNode(render(), (node) => node.type?.name === 'ExtensionsPage')!.props.section, 'connections');
  const buttons = ['Mods', '技能', '连接与服务'].map((label) => button(render(), label));
  let focused = -1;
  buttons.forEach(
    (node, index) =>
      ((node as any).focus = () => {
        focused = index;
      }),
  );
  findNode(render(), (node) => node.props.role === 'tablist')!.props.onKeyDown({
    key: 'ArrowRight',
    target: buttons[2],
    currentTarget: { querySelectorAll: () => buttons },
    preventDefault() {},
  });
  assert.equal(focused, 0);
  assert.equal(text(selected()), 'Mods');
  h.unmount();
  h.remount();
  assert.equal(
    text(
      findNode(
        h.render('ExtensionsHome', { ...props, tab: 'components' }),
        (node) => node.props.role === 'tab' && node.props['aria-selected'],
      ),
    ),
    '连接与服务',
  );
  assert.equal(saved.get('pugport-extensions-tab'), 'connections');
  h.unmount();
  h.remount();
  assert.equal(text(selected()), '连接与服务');
  h.unmount();
});

test('storage denial keeps navigation usable', () => {
  const h = uiHarness(homeCode, {
    localStorage: {
      getItem() {
        throw Error('denied');
      },
      setItem() {
        throw Error('denied');
      },
    },
  });
  button(h.render('ExtensionsHome', props), '技能').props.onClick();
  assert.equal(
    findNode(h.render('ExtensionsHome', props), (node) => node.type?.name === 'ExtensionsPage')!.props.section,
    'skills',
  );
  h.unmount();
});

for (const section of ['skills', 'connections', 'components'])
  test(section + ' only exposes its Add actions', async () => {
    const h = uiHarness(extensionsCode);
    const p = { ...props, section };
    h.render('ExtensionsPage', p);
    await nextTurn();
    let tree = h.render('ExtensionsPage', p);
    const add = button(tree, '添加 ▾');
    assert.equal(!!add, section !== 'components');
    if (add) {
      add.props.onClick();
      tree = h.render('ExtensionsPage', p);
      assert.ok(button(tree, section === 'skills' ? '从链接或文件夹添加…' : '添加 MCP 工具…'));
      assert.ok(button(tree, '从其他 AI 应用导入…'));
      button(tree, section === 'skills' ? '从链接或文件夹添加…' : '添加 MCP 工具…').props.onClick();
      const sheet = findNode(h.render('ExtensionsPage', p), (node) => node.type?.name === 'SideSheet')!;
      assert.equal(sheet.props.title, '添加扩展');
      sheet.props.onClose();
      assert.equal(
        findNode(h.render('ExtensionsPage', p), (node) => node.type?.name === 'SideSheet'),
        undefined,
      );
    }
    h.unmount();
  });

test('a Connections target lands and highlights its row after the row loads', () => {
  const document = { activeElement: null as unknown };
  let landed = 0;
  let retry = () => {};
  let rows: unknown[] = [];
  const classes = new Set<string>();
  const row = {
    dataset: { settingsItem: 'slack' },
    parentElement: null,
    tagName: 'DIV',
    querySelectorAll: () => [],
    querySelector: () => null,
    scrollIntoView() {
      landed++;
    },
    focus() {
      document.activeElement = row;
    },
    getClientRects: () => [1],
    closest: () => null,
    classList: {
      contains: () => false,
      add: (name: string) => classes.add(name),
      remove: (name: string) => classes.delete(name),
    },
  };
  const h = uiHarness(homeCode, {
    document,
    MutationObserver: class {
      constructor(callback: () => void) {
        retry = callback;
      }
      observe() {}
      disconnect() {}
    },
  });
  const p = { ...props, tab: 'connections', target: undefined as unknown };
  const tree = h.render('ExtensionsHome', p);
  findNode(tree, (node) => node.props.id === 'extensions-body')!.props.ref.current = { querySelectorAll: () => rows };
  p.target = { id: 'slack', request: 1 };
  h.render('ExtensionsHome', p);
  rows = [row];
  retry();
  assert.equal(landed, 1);
  assert.equal(document.activeElement, row);
  assert.ok(classes.has('is-target'));
  h.unmount();
  assert.equal(classes.has('is-target'), false);
});

test('Studio events default to Connections, carry Skills, and a stable Mods callback opens Store without its old h1', async () => {
  const listeners = new Map<string, (event: any) => void>();
  const state = {
    projects: [],
    conversations: [],
    workflows: [],
    runs: [],
    runtimes: [],
    targets: [],
    approvals: [],
    settings: {},
    app: { version: 'test' },
  };
  const h = uiHarness(studioCode, {
    __backend: { state, api: props.api, reload: async () => {}, connection: 'connected' },
    window: {
      addEventListener: (name: string, handler: any) => listeners.set(name, handler),
      removeEventListener() {},
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    },
  });
  const render = () => h.render('default');
  const workspace = () => findNode(render(), (node) => node.type?.name === 'SplitView')!.props.children('', 0);
  const open = workspace().props.onOpenModeStore;
  assert.equal(workspace().props.onOpenModeStore, open);
  listeners.get('pugport:open-extensions')!({});
  assert.equal(findNode(render(), (node) => node.type?.name === 'ExtensionsHome')!.props.tab, 'connections');
  listeners.get('pugport:open-extensions')!({ detail: 'skills' });
  assert.equal(findNode(render(), (node) => node.type?.name === 'ExtensionsHome')!.props.tab, 'skills');
  open();
  const home = findNode(render(), (node) => node.type?.name === 'ExtensionsHome')!;
  assert.equal(home.props.tab, 'mods');
  const hh = uiHarness(homeCode);
  const store = findNode(hh.render('ExtensionsHome', home.props), (node) => node.type?.name === 'StorePage')!;
  assert.ok(store);
  const sh = uiHarness(await uiBundle('src/ui/StorePage.tsx'));
  assert.equal(
    findNode(sh.render('StorePage', store.props), (node) => node.type === 'h1' && text(node) === 'Mods Store'),
    undefined,
  );
  sh.unmount();
  hh.unmount();
  h.unmount();
});

test('legacy saved Components selects Connections and local capabilities sit at its bottom', async () => {
  const h = uiHarness(homeCode, { localStorage: { getItem: () => 'components', setItem() {} } });
  const home = h.render('ExtensionsHome', props);
  assert.equal(
    findNode(home, (node) => node.props.role === 'tab' && node.props['aria-selected'])!.props.children,
    '连接与服务',
  );
  assert.equal(
    findNode(home, (node) => node.props.id === 'extensions-tab-components'),
    undefined,
  );
  const page = uiHarness(extensionsCode);
  page.render('ExtensionsPage', { ...props, section: 'connections' });
  await nextTurn();
  const tree = page.render('ExtensionsPage', { ...props, section: 'connections' });
  const group = findNode(tree, (node) => node.props.title === '本机能力')!;
  assert.ok(findNode(group, (node) => node.type?.name === 'ExtensionCatalog'));
  assert.ok(findNode(group, (node) => node.props.title === '整理照片和视频'));
  assert.doesNotMatch(text(tree), /下载与安装状态由本机服务保存/);
  h.unmount();
  page.unmount();
});
