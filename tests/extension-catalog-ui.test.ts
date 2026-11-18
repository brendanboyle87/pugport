import assert from 'node:assert/strict';
import test from 'node:test';
import { extensionCatalog } from '../src/shared/extensions.ts';
import { findNode, nextTurn, text, uiBundle, uiHarness, type UiNode } from './helpers/ui-harness.ts';

const code = await uiBundle('tests/helpers/extension-catalog-fixture.ts');
const pageCode = await uiBundle('src/ui/Extensions.tsx');

test('local voice component is presented as video transcription', () => {
  const h = uiHarness(code);
  const entry = h.exports.localComponents.find((entry: { id: string }) => entry.id === 'local-voice');
  assert.equal(entry.tool, 'voice');
  assert.equal(entry.title, '视频转写');
  assert.doesNotMatch(`${entry.title} ${entry.description} ${entry.detail}`, /语音输入/);
  h.unmount();
});

test('browser recommendation preserves its source description and browser privacy note', () => {
  const h = uiHarness(code);
  const entry = h.exports
    .discoveryEntries(extensionCatalog)
    .find((entry: { id: string }) => entry.id === 'extension-browser');
  assert.equal(entry.description, extensionCatalog.find((entry) => entry.id === 'browser')!.description);
  assert.match(entry.description, /让 AI 打开网页/);
  assert.match(entry.description, /使用独立的临时浏览器资料，不碰你的浏览器登录状态/);
  h.unmount();
});

const nodes = (tree: unknown, predicate: (node: UiNode) => boolean): UiNode[] => {
  if (Array.isArray(tree)) return tree.flatMap((node) => nodes(node, predicate));
  if (!tree || typeof tree !== 'object') return [];
  const node = tree as UiNode;
  return [...(predicate(node) ? [node] : []), ...nodes(node.props?.children, predicate)];
};
const button = (tree: unknown, name: string) => {
  const found = findNode(
    tree,
    (node) => node.type === 'button' && (node.props['aria-label'] === name || text(node) === name),
  );
  assert.ok(found, name);
  return found;
};
const local = (extra = {}) => ({
  info: {
    tools: {
      voice: false,
      images: { model: false },
      memory: { model: false },
      everything: 'missing',
      markitdown: false,
    },
  },
  installations: [],
  error: '',
  starting: undefined,
  load: async () => {},
  start: async () => {},
  remove: async () => {},
  removing: undefined,
  ...extra,
});
const job = (status = 'running') => ({
  id: 'job',
  tool: 'voice',
  status,
  phase: 'downloading',
  message: '正在下载语音组件，可离开此页。',
  startedAt: '2026-10-06T00:00:00Z',
  updatedAt: '2026-10-06T00:00:00Z',
});

test('ongoing or interrupted component tasks restore correctly without invented progress', () => {
  const h = uiHarness(code);
  const started: string[] = [];
  const props = {
    entries: h.exports.localComponents,
    local: local({ installations: [job()], start: async (tool: string) => started.push(tool) }),
    installed: new Set(),
    onConnect() {},
    onInstall() {},
  };
  let tree = h.render('ExtensionCatalog', props);
  assert.match(text(tree), /正在下载语音组件/);
  assert.equal(button(tree, '安装 视频转写').props.disabled, true);
  assert.doesNotMatch(text(tree), /%/);
  props.local = local({ installations: [job('interrupted')], start: async (tool: string) => started.push(tool) });
  tree = h.render('ExtensionCatalog', props);
  assert.match(text(tree), /安装中断|重试安装/);
  assert.equal(button(tree, '安装 视频转写').props.disabled, false);
  button(tree, '安装 视频转写').props.onClick();
  assert.deepEqual(started, ['voice']);
  h.unmount();
});

test('unreadable component state disables downloads', () => {
  const h = uiHarness(code);
  const tree = h.render('ExtensionCatalog', {
    entries: h.exports.discoveryEntries([]),
    local: local({ info: undefined, error: 'offline' }),
    installed: new Set(),
    onConnect() {},
    onInstall() {},
  });
  assert.match(text(tree), /本地组件状态读取失败/);
  assert.equal(button(tree, '安装 视频转写').props.disabled, true);
  h.unmount();
});

test('local install startup returns after queuing, keeps polling task state, and never uses the long-wait legacy endpoint', async () => {
  const h = uiHarness(code);
  const calls: Array<{ path: string; body: unknown }> = [];
  let queued = false;
  const api = async (path: string, body: unknown) => {
    calls.push({ path, body });
    if (path === '/api/app-info') return local().info;
    if (body) {
      queued = true;
      return { installation: job() };
    }
    return { installations: queued ? [job()] : [] };
  };
  // The harness can render an exported hook directly; it returns its current state.
  h.exports.LocalFixture = () => h.exports.useLocalComponents(api, () => {});
  h.render('LocalFixture');
  await nextTurn();
  let state: any = h.render('LocalFixture');
  await state.start('voice');
  state = h.render('LocalFixture');
  assert.equal(state.installations[0].status, 'running');
  assert.equal(state.starting, undefined);
  assert.equal(calls.filter((call) => call.body).length, 1);
  assert.equal(calls.find((call) => call.body)!.path, '/api/tool-installations');
  await state.start('voice');
  assert.equal(calls.filter((call) => call.body).length, 1);
  h.unmount();
});

test('discovery has four portable components, truthful history text and no retired entries', () => {
  const h = uiHarness(code);
  const props = { entries: h.exports.discoveryEntries([]), local: local(), installed: new Set(), onInstall() {} };
  let tree = h.render('ExtensionCatalog', props);
  assert.equal(nodes(tree, (node) => node.type?.name === 'SettingsRow').length, 4);
  assert.match(text(tree), /让 AI 自动找到相关的旧对话/);
  assert.match(text(tree), /搜索框仍按关键词搜索/);
  assert.doesNotMatch(text(tree), /连接器|Google Workspace|Microsoft 365|EmbeddingGemma|全盘文件搜索/);
  assert.equal(
    findNode(tree, (node) => node.type === 'input'),
    undefined,
  );
  assert.equal(h.exports.localComponentReady('memory-search', { tools: { memory: { model: true } } }), true);
  h.unmount();
});

test('skills keep their installed and recommended rows separate from connections and components', async () => {
  const h = uiHarness(pageCode);
  const props = {
    section: 'skills',
    notify() {},
    api: async (path: string) =>
      path === '/api/app-info'
        ? local().info
        : path === '/api/tool-installations'
          ? { installations: [] }
          : { items: [], catalog: [] },
  };
  h.render('ExtensionsPage', props);
  await nextTurn();
  const tree = h.render('ExtensionsPage', props);
  assert.equal(
    findNode(tree, (node) => node.props.role === 'tab'),
    undefined,
  );
  assert.ok(findNode(tree, (node) => node.type?.name === 'SettingsGroup' && node.props.title === '已安装'));
  assert.match(text(tree), /还没有技能。可以从链接或文件夹添加。/);
  assert.equal(
    findNode(tree, (node) =>
      ['AgentConnect', 'ExternalAgentsCard', 'DevicesCard', 'SlackGateway'].includes(node.type?.name),
    ),
    undefined,
  );
  assert.doesNotMatch(text(tree), /已连接账号|连接工作账号|Pi\/API 暂未接入/);
  h.unmount();
});

test('an empty inline recommendation list does not ask for a hidden search or category filter', () => {
  const h = uiHarness(code);
  const tree = h.render('ExtensionCatalog', {
    entries: [],
    local: local(),
    installed: new Set(),
    onInstall() {},
  });
  assert.equal(
    findNode(tree, (node) => node.type === 'input' || node.props['aria-label'] === '筛选扩展类型'),
    undefined,
  );
  assert.doesNotMatch(text(tree), /换个关键词或分类/);
  h.unmount();
});

test('installed local components show a status and no install control', () => {
  const h = uiHarness(code);
  const tree = h.render('ExtensionCatalog', {
    entries: [h.exports.localComponents[0]],
    local: local({ info: { tools: { voice: true } } }),
    installed: new Set(),
    onInstall() {},
  });
  const row = findNode(tree, (node) => node.type?.name === 'SettingsRow')!;
  assert.equal(row.props.status, '已安装');
  assert.equal(row.props.control, false);
  assert.ok(button(row.props.children, '卸载…'));
  h.unmount();
});

test('uninstall confirms once, supports cancellation, deletes and refreshes detected status', async () => {
  const h = uiHarness(code);
  const calls: { path: string; method: string }[] = [];
  const notices: any[] = [];
  let ready = true;
  const api = async (path: string, _body: unknown, method: string) => {
    calls.push({ path, method });
    if (method === 'DELETE') {
      ready = false;
      return { removed: true };
    }
    if (path === '/api/app-info') return { tools: { voice: ready } };
    return { installations: [{ ...job('completed'), message: '组件已安装并验证。' }] };
  };
  h.exports.LocalFixture = () => h.exports.useLocalComponents(api, (notice: unknown) => notices.push(notice));
  h.render('LocalFixture');
  await nextTurn();
  let state: any = h.render('LocalFixture');
  const entry = h.exports.localComponents[0];
  for (const answer of [false, true]) {
    const pending = state.remove(entry);
    await state.remove(entry);
    const dialog = h.exports.confirmationStore.snapshot();
    assert.equal(dialog.options.title, '卸载「{0}」？');
    assert.equal(dialog.options.summary, '会删除下载的组件文件。之后需要时可以重新安装。');
    assert.equal(dialog.options.action, '卸载');
    assert.equal(dialog.options.tone, 'danger');
    assert.deepEqual(Array.from(dialog.options.names), ['视频转写']);
    assert.equal(calls.filter((call) => call.method === 'DELETE').length, 0);
    h.exports.confirmationStore.resolve(dialog.id, answer);
    await pending;
    assert.equal(h.exports.confirmationStore.snapshot(), undefined);
    state = h.render('LocalFixture');
  }
  assert.deepEqual(
    calls.filter((call) => call.method === 'DELETE'),
    [{ path: '/api/tool-installations/voice', method: 'DELETE' }],
  );
  assert.equal(calls.at(-2)?.path, '/api/app-info');
  assert.equal(state.info.tools.voice, false);
  assert.equal(state.removing, undefined);
  assert.equal(notices.at(-1).message, '已卸载「{0}」。');
  const tree = h.render('ExtensionCatalog', { entries: [entry], local: state, installed: new Set(), onInstall() {} });
  assert.equal(button(tree, '安装 视频转写').props.disabled, false);
  assert.doesNotMatch(text(tree), /组件已安装并验证。/);
  h.unmount();
});

test('uninstall failures refresh readiness and legacy copies remain installed', async () => {
  for (const message of [
    '此组件在 /synthetic/portable/voice，由旧版便携副本安装，PugPort 不会删除它。',
    '组件已停用，但有些文件没能删除：/synthetic/memory-search（EBUSY）。退出 PugPort 后可以手动删除这个文件夹。',
  ]) {
    const legacy = message.includes('旧版便携副本');
    const h = uiHarness(code, { Error });
    const notices: any[] = [];
    let reads = 0;
    const api = async (path: string, _body: unknown, method: string) => {
      if (method === 'DELETE') {
        throw Error(message);
      }
      if (path === '/api/app-info') {
        reads++;
        return { tools: { voice: reads === 1 || legacy } };
      }
      return { installations: [] };
    };
    h.exports.LocalFixture = () => h.exports.useLocalComponents(api, (notice: unknown) => notices.push(notice));
    h.render('LocalFixture');
    await nextTurn();
    let state: any = h.render('LocalFixture');
    const pending = state.remove(h.exports.localComponents[0]);
    const dialog = h.exports.confirmationStore.snapshot();
    h.exports.confirmationStore.resolve(dialog.id, true);
    await pending;
    state = h.render('LocalFixture');
    assert.equal(state.info.tools.voice, legacy);
    assert.equal(reads, 2);
    assert.equal(notices.at(-1).tone, 'error');
    assert.equal(notices.at(-1).message, message);
    h.unmount();
  }
});

test('English uninstall confirmation translates the component name', async () => {
  const h = uiHarness(code, {
    localStorage: { getItem: () => 'en' },
    Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 },
    document: { documentElement: {}, body: { nodeType: 0 }, title: '' },
    MutationObserver: class {
      observe() {}
    },
  });
  await h.exports.startInterfaceLanguage();
  h.exports.LocalFixture = () =>
    h.exports.useLocalComponents(
      async () => ({ installations: [] }),
      () => {},
    );
  const state: any = h.render('LocalFixture');
  const pending = state.remove(h.exports.localComponents[0]);
  const dialog = h.exports.confirmationStore.snapshot();
  assert.deepEqual(Array.from(dialog.options.names), ['Video transcription']);
  h.exports.confirmationStore.resolve(dialog.id, false);
  await pending;
  h.unmount();
});

test('installed skills and local components precede recommendations', async () => {
  const h = uiHarness(pageCode);
  const props = {
    section: 'skills',
    notify() {},
    api: async (path: string) =>
      path === '/api/app-info'
        ? { tools: { images: { model: true } } }
        : path === '/api/tool-installations'
          ? { installations: [] }
          : {
              items: [{ id: 'installed', kind: 'skill', name: 'Installed', enabled: true }],
              catalog: [{ id: 'recommended', kind: 'skill', title: 'Recommended' }],
            },
  };
  h.render('ExtensionsPage', props);
  await nextTurn();
  let tree = h.render('ExtensionsPage', props);
  const skills = findNode(tree, (node) => node.type?.name === 'SettingsGroup' && node.props.title === '已安装')!;
  const list = nodes(tree, (node) => ['InstalledRow', 'ExtensionCatalog'].includes(node.type?.name));
  assert.deepEqual(
    list.map((node) => node.type.name),
    ['InstalledRow', 'ExtensionCatalog'],
  );
  assert.equal(list[0]!.props.item.id, 'installed');
  assert.equal(list[1]!.props.entries[0].catalog.id, 'recommended');
  assert.ok(findNode(skills, (node) => node.type?.name === 'InstalledRow'));
  assert.ok(findNode(tree, (node) => node.type?.name === 'SettingsGroup' && node.props.title === '推荐'));
  tree = h.render('ExtensionsPage', { ...props, section: 'components' });
  const catalogs = nodes(tree, (node) => node.type?.name === 'ExtensionCatalog');
  assert.equal(catalogs[0]!.props.entries[0].id, 'local-images');
  assert.equal(
    findNode(tree, (node) => node.type?.name === 'InstalledRow'),
    undefined,
  );
  h.unmount();
});
