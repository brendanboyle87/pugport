import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { settingsCategories, settingsCategory } from '../src/ui/settings-categories.ts';
import { findNode, nextTurn, text, uiBundle, uiHarness } from './helpers/ui-harness.ts';

const studio = await uiBundle('src/ui/Studio.tsx', true);

test('startup applies saved accent before renderer mounts and falls back for unknown accents', () => {
  const script = readFileSync('src/ui/index.html', 'utf8').match(/<script>([\s\S]*?)<\/script>/)![1]!;
  for (const saved of ['blue', 'violet', 'teal', 'pink', 'invalid', null]) {
    const root = { dataset: {} as Record<string, string>, style: {} };
    runInNewContext(script, {
      document: { documentElement: root },
      localStorage: { getItem: (key: string) => (key === 'pugport-accent' ? saved : 'dark') },
      matchMedia: () => ({ matches: false }),
    });
    assert.equal(root.dataset.accent, saved === 'invalid' || saved === null ? 'blue' : saved);
    assert.equal(root.dataset.theme, 'dark');
  }
});

test('deep links focus the row unless it has an explicit safe field', async () => {
  const code = await uiBundle('src/ui/SettingsShell.tsx');
  for (const safeField of [false, true]) {
    let focused = '';
    const doc = { activeElement: null as unknown };
    const field = {
      getClientRects: () => [1],
      closest: () => null,
      focus: () => {
        focused = 'field';
        doc.activeElement = field;
      },
    };
    const row = {
      dataset: { settingsItem: 'synthetic' },
      tagName: 'SECTION',
      parentElement: null,
      getClientRects: () => [1],
      closest: () => null,
      querySelectorAll: () => [],
      querySelector: (selector: string) =>
        safeField && selector === '[data-settings-focus]:not(:disabled)' ? field : null,
      scrollIntoView() {},
      focus: () => {
        focused = 'row';
        doc.activeElement = row;
      },
      classList: { add() {}, remove() {}, contains: () => false },
    };
    const h = uiHarness(code, {
      document: doc,
      MutationObserver: class {
        disconnect() {}
        observe() {}
      },
    });
    const props = { category: 'general', onCategory() {}, children: null, target: undefined as unknown };
    const tree = h.render('SettingsShell', props);
    findNode(tree, (node) => node.props.className === 'settings-content')!.props.ref.current = {
      querySelectorAll: () => [row],
    };
    props.target = { id: 'synthetic', request: 1 };
    h.render('SettingsShell', props);
    assert.equal(focused, safeField ? 'field' : 'row');
    h.unmount();
  }
  const markers = readdirSync('src/ui').filter(
    (file) => file.endsWith('.tsx') && /\bdata-settings-focus(?:\s|=)/.test(readFileSync(`src/ui/${file}`, 'utf8')),
  );
  assert.deepEqual(markers, ['ExternalAgents.tsx']);
});

test('deep links retry after hidden changes instead of completing on a hidden field', async () => {
  let hidden = true;
  let clicks = 0;
  let disconnected = false;
  let retry!: () => void;
  let observed: any;
  const doc = { activeElement: null as unknown };
  const control = {
    getClientRects: () => (hidden ? [] : [1]),
    closest: () => (hidden ? {} : null),
    focus: () => {
      if (!hidden) doc.activeElement = control;
    },
  };
  const row = {
    dataset: { settingsItem: 'grok-bot' },
    classList: { contains: () => true, add() {}, remove() {} },
    parentElement: null,
    querySelectorAll: () => [],
    querySelector: (selector: string) =>
      selector.startsWith(':scope') ? (hidden ? { click: () => clicks++ } : null) : control,
    scrollIntoView() {},
    focus: () => {
      doc.activeElement = row;
    },
  };
  const h = uiHarness(await uiBundle('src/ui/SettingsShell.tsx'), {
    document: doc,
    MutationObserver: class {
      constructor(callback: () => void) {
        retry = callback;
      }
      observe(_root: unknown, options: unknown) {
        observed = options;
      }
      disconnect() {
        disconnected = true;
      }
    },
  });
  const props = { category: 'general', onCategory() {}, target: undefined as unknown, children: null };
  const tree = h.render('SettingsShell', props);
  findNode(tree, (node) => node.props.className === 'settings-content')!.props.ref.current = {
    querySelectorAll: () => [row],
  };
  props.target = { id: 'grok-bot', request: 1 };
  h.render('SettingsShell', props);
  assert.equal(clicks, 1);
  assert.equal(doc.activeElement, row, 'fall back to the row while details are hidden');
  assert.equal(disconnected, false);
  assert.equal(observed.attributes, true);
  assert.deepEqual(Array.from(observed.attributeFilter), ['hidden']);
  hidden = false;
  retry();
  assert.equal(doc.activeElement, control);
  assert.equal(disconnected, true);
  h.unmount();
});

const stamp = '2026-10-14T12:00:00Z';
const state = {
  projects: [{ id: 'p', name: 'Synthetic', path: '/synthetic', createdAt: stamp, updatedAt: stamp }],
  conversations: [{ id: 'c', projectId: 'p', title: 'Synthetic', createdAt: stamp, updatedAt: stamp }],
  workflows: [],
  runs: [],
  targets: [],
  runtimes: [],
  approvals: [],
  plugins: [],
  app: { version: 'synthetic' },
  settings: {},
};

test('General Appearance synchronizes zoom, accent and theme, including other windows', async () => {
  const saved = new Map<string, string>();
  const listeners = new Set<(event: { key: string | null }) => void>();
  let zoomChanged: ((value: number) => void) | undefined;
  let zoom = 1.1;
  const themes: string[] = [];
  const root = { dataset: {} as Record<string, string>, style: {} };
  const h = uiHarness(studio, {
    __backend: { state, api: async () => ({}), reload: async () => {} },
    document: { documentElement: root, hasFocus: () => true },
    localStorage: {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => saved.set(key, value),
    },
    window: {
      addEventListener: (name: string, listener: any) => {
        if (name === 'storage') listeners.add(listener);
      },
      removeEventListener: (name: string, listener: any) => {
        if (name === 'storage') listeners.delete(listener);
      },
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
      comboRunnerDesktop: {
        pickDirectory: async () => null,
        getZoom: async () => zoom,
        setZoom: async (value: number) => {
          zoom = value;
          zoomChanged?.(value);
          return value;
        },
        onZoomChanged: (listener: (value: number) => void) => {
          zoomChanged = listener;
          return () => {
            zoomChanged = undefined;
          };
        },
        setTheme: async (theme: string) => {
          themes.push(theme);
        },
      },
    },
  });
  const render = () => h.render('default');
  findNode(render(), (node) => node.type === 'button' && text(node) === '设置')!.props.onClick();
  findNode(render(), (node) => node.type?.name === 'SettingsShell')!.props.onCategory('general');
  await nextTurn();
  const group = (label: string) => findNode(render(), (node) => node.props['aria-label'] === label)!;
  assert.equal(text(group('界面大小')), '80%90%100%110%125%150%');
  assert.equal(findNode(group('界面大小'), (node) => node.props['aria-checked'] === true)!.props.children[0], 110);
  await findNode(group('界面大小'), (node) => node.props.children?.[0] === 125)!.props.onClick();
  assert.equal(zoom, 1.25);
  zoomChanged!(0.9);
  assert.equal(findNode(group('界面大小'), (node) => node.props['aria-checked'] === true)!.props.children[0], 90);
  assert.equal(group('强调色').props.children.length, 4);
  for (const [name, value] of [
    ['紫色', 'violet'],
    ['青色', 'teal'],
    ['粉色', 'pink'],
    ['蓝色', 'blue'],
  ]) {
    findNode(group('强调色'), (node) => node.props['aria-label'] === name)!.props.onClick();
    render();
    assert.equal(root.dataset.accent, value);
    assert.equal(saved.get('pugport-accent'), value);
  }
  findNode(group('主题'), (node) => text(node) === '深色')!.props.onClick();
  render();
  assert.equal(themes.at(-1), 'dark');
  assert.equal(root.dataset.theme, 'dark');
  saved.set('agent-studio-theme', 'light');
  saved.set('pugport-accent', 'pink');
  for (const key of ['agent-studio-theme', 'pugport-accent']) for (const listener of listeners) listener({ key });
  render();
  assert.equal(root.dataset.theme, 'light');
  assert.equal(root.dataset.accent, 'pink');
  h.unmount();
  assert.equal(zoomChanged, undefined);
  assert.equal(listeners.size, 0);
});

test('browser General Appearance hides desktop zoom', () => {
  const h = uiHarness(studio, { __backend: { state, api: async () => ({}), reload: async () => {} } });
  const render = () => h.render('default');
  findNode(render(), (node) => node.type === 'button' && text(node) === '设置')!.props.onClick();
  findNode(render(), (node) => node.type?.name === 'SettingsShell')!.props.onCategory('general');
  assert.equal(
    findNode(render(), (node) => node.props['aria-label'] === '界面大小'),
    undefined,
  );
  h.unmount();
});

test('category IDs and order are stable; only the current category supplies components', () => {
  assert.equal(settingsCategory('extensions'), 'general');
  assert.equal(settingsCategory('connect'), 'general');
  assert.equal(settingsCategory('data'), 'general');
  assert.deepEqual(
    settingsCategories.map((item) => item.id),
    ['general', 'account', 'personal', 'conversation', 'routing', 'devices', 'permissions', 'advanced'],
  );
  const h = uiHarness(studio, { __backend: { state, api: async () => ({}), reload: async () => {} } });
  const render = () => h.render('default');
  findNode(render(), (node) => node.type === 'button' && text(node) === '设置')!.props.onClick();
  const shell = () => findNode(render(), (node) => node.type?.name === 'SettingsShell')!;
  for (const category of settingsCategories) {
    shell().props.onCategory(category.id);
    const tree = render();
    const names = [
      'ExtensionsPage',
      'SlackGateway',
      'AgentConnect',
      'TerminalCommand',
      'ExternalAgentsCard',
      'DevicesCard',
    ];
    const expected = category.id === 'devices' ? ['DevicesCard'] : [];
    for (const name of names)
      assert.equal(
        !!findNode(tree, (node) => node.type?.name === name),
        expected.includes(name),
        `${category.id}: ${name}`,
      );
    const page = findNode(tree, (node) => node.type?.name === 'SettingsPage');
    assert.equal(page?.props.category, expected.length || category.id === 'account' ? undefined : category.id);
  }
  h.unmount();
});

for (const solo of [false, true]) {
  test(`Grok routine opens Connections at grok-bot${solo ? ' in the pop-out with a return control' : ''}`, () => {
    const h = uiHarness(studio, {
      location: { search: solo ? '?view=conversation&id=c' : '' },
      localStorage: {
        getItem: (key: string) =>
          key === 'agent-studio-conversation' ? 'c' : key === 'agent-studio-project' ? 'p' : null,
        setItem() {},
      },
      __backend: { state, api: async () => ({}), reload: async () => {} },
    });
    const tree = h.render('default');
    const workspace = solo
      ? findNode(tree, (node) => node.type?.name === 'ConversationWorkspace')!
      : findNode(tree, (node) => node.type?.name === 'SplitView')!.props.children('', 0);
    workspace.props.onManageConnectors('grok-bot');
    const opened = h.render('default');
    const shell = findNode(opened, (node) => node.type?.name === 'ExtensionsHome')!;
    assert.equal(shell.props.tab, 'connections');
    assert.equal(shell.props.target.id, 'grok-bot');
    shell.props.onTab('skills');
    assert.equal(
      findNode(h.render('default'), (node) => node.type?.name === 'ExtensionsHome')!.props.target,
      undefined,
    );
    if (solo) {
      findNode(opened, (node) => node.type === 'button' && node.props.children === '返回对话')!.props.onClick();
      assert.ok(findNode(h.render('default'), (node) => node.type?.name === 'ConversationWorkspace'));
    }
    h.unmount();
  });
}

test('only settings-permissions writes the settings API anywhere in UI sources', () => {
  for (const file of readdirSync('src/ui').filter(
    (file) => /\.[jt]sx?$/.test(file) && file !== 'settings-permissions.ts',
  ))
    assert.doesNotMatch(readFileSync(`src/ui/${file}`, 'utf8'), /['"`]\/api\/settings['"`]/, file);
});

test('language changes protect hidden chat drafts, attachments, pending sends and closed side chats', () => {
  let reloads = 0;
  const saved = new Map<string, string>();
  const h = uiHarness(`${studio}\nmodule.exports.getSideChatSession = getSideChatSession;`, {
    location: { search: '', reload: () => reloads++ },
    localStorage: {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => saved.set(key, value),
    },
    __backend: { state, api: async () => ({}), reload: async () => {} },
  });
  const render = () => h.render('default');
  const workspace = findNode(render(), (node) => node.type?.name === 'SplitView')!.props.children('', 0);
  const session = workspace.props.composerSession;
  findNode(render(), (node) => node.type === 'button' && text(node) === '设置')!.props.onClick();
  findNode(render(), (node) => node.type?.name === 'SettingsShell')!.props.onCategory('general');
  const english = () =>
    findNode(render(), (node) => node.type === 'button' && node.props.children === 'English')!.props.onClick();
  const protectedReload = () => {
    english();
    assert.equal(reloads, 0);
    assert.equal(saved.has('comborunner.locale'), false);
  };
  session.changeDraft('hidden', (draft: any) => ({ ...draft, content: 'Keep me' }));
  protectedReload();
  session.changeDraft('hidden', (draft: any) => ({ ...draft, content: '', attachments: [{ id: 'file' }] }));
  protectedReload();
  session.changeDraft('hidden', (draft: any) => ({ ...draft, attachments: [] }));
  session.changePending(() => [{ id: 'pending', snapshot: { content: '', attachments: [] } }]);
  protectedReload();
  session.changePending(() => []);
  const side = h.exports.getSideChatSession(workspace.props.api, { requestId: 'side', parentConversationId: 'c' });
  side.setDraft('A closed side chat draft');
  protectedReload();
  side.setDraft('');
  english();
  assert.equal(reloads, 1);
  assert.equal(saved.get('comborunner.locale'), 'en');
  h.unmount();
});

test('settings use the platform trash name', async () => {
  const code = await uiBundle('src/ui/App.tsx');
  for (const [platform, label] of [
    ['darwin', '废纸篓'],
    ['win32', '回收站'],
  ]) {
    const h = uiHarness(code);
    const tree = h.render('SettingsPage', {
      state: { ...state, app: { platform } },
      category: 'permissions',
      api: async () => ({}),
      reload: async () => {},
      notify() {},
    });
    assert.ok(findNode(tree, (node) => node.props.children?.includes?.(`删除文件时直接移到${label}`)));
    h.unmount();
  }
});

test('each settings field belongs to its requested category', async () => {
  const code = await uiBundle('src/ui/App.tsx');
  const fields = {
    general: ['任务完成通知', 'keepAwake'],
    personal: ['global-instructions', 'MemoryDistillationSwitch', 'memory'],
    conversation: ['发送快捷键', '自动插话', '显示自动回复的执行器、模型和强度'],
    routing: ['ExecutorChecklist', 'RoutingProfilesSettings', '默认调度方式', 'reservePercent', 'autoUseResetCards'],
    permissions: ['工具确认方式', 'recycleWithoutAsking', 'SandboxSettings'],
    advanced: ['启用固定路由偏好', 'defaultProjectPath', 'refreshSeconds', 'maxQuotaAgeSeconds', 'maxConcurrentRuns'],
  };
  for (const [category, expected] of Object.entries(fields)) {
    const h = uiHarness(code);
    const tree = h.render('SettingsPage', {
      state,
      category,
      api: async () => ({}),
      reload: async () => {},
      notify() {},
    });
    const serialized = JSON.stringify(tree, (key, value) =>
      typeof value === 'function' ? (key === 'type' ? value.name : value.toString()) : value,
    );
    for (const field of expected) assert.ok(serialized.includes(field), `${category} is missing ${field}`);
    assert.doesNotMatch(serialized, /Jev|TypeSafe|settings-judgment/);
    if (category !== 'advanced') {
      assert.equal(
        findNode(tree, (node) => node.type === 'input' && String(node.props.onChange).includes('refreshSeconds')),
        undefined,
      );
    }
    h.unmount();
  }
});

for (const [component, file, errorText] of [
  ['AgentConnect', 'AgentConnect', '读不到连接列表：'],
  ['DevicesCard', 'Devices', '读不到设备列表：'],
]) {
  test(`${component} shows load errors and retries instead of showing an empty state`, async () => {
    let fail = true;
    const h = uiHarness(await uiBundle(`src/ui/${file}.tsx`), { Error });
    const props = {
      notify() {},
      api: async () => {
        if (fail) throw new Error('Synthetic offline');
        return { devices: [], tools: [], snippet: '', slackHost: null };
      },
    };
    h.render(component!, props);
    await nextTurn();
    const tree = h.render(component!, props);
    const alert = findNode(tree, (node) => node.props.role === 'alert');
    assert.ok(JSON.stringify(alert).includes(errorText!));
    assert.ok(JSON.stringify(alert).includes('Synthetic offline'));
    assert.equal(
      findNode(tree, (node) => node.type === 'p' && node.props.children === '还没有添加设备。'),
      undefined,
    );
    fail = false;
    findNode(tree, (node) => node.type === 'button' && node.props.children === '重试')!.props.onClick();
    await nextTurn();
    assert.equal(
      findNode(h.render(component!, props), (node) => node.props.role === 'alert'),
      undefined,
    );
    h.unmount();
  });
}

test('refresh is available only in the Usage and connections page header, not global controls or palette', async () => {
  const keys = new Set<(event: any) => void>();
  const calls: string[] = [];
  const h = uiHarness(studio, {
    __backend: {
      state,
      api: async (path: string) => {
        calls.push(path);
        return {};
      },
      reload: async () => {},
    },
    window: {
      addEventListener(name: string, listener: (event: any) => void) {
        if (name === 'keydown') keys.add(listener);
      },
      removeEventListener(name: string, listener: (event: any) => void) {
        if (name === 'keydown') keys.delete(listener);
      },
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    },
  });
  const render = () => h.render('default');
  const initial = render();
  assert.equal(
    findNode(initial, (node) => node.props['aria-label'] === '刷新执行器与额度'),
    undefined,
  );
  const sidebar = findNode(initial, (node) => node.props.className === 'sidebar-status')!;
  assert.equal(
    findNode(sidebar, (node) => node.props.className === 'icon-button sidebar-refresh'),
    undefined,
  );
  for (const listener of keys) listener({ ctrlKey: true, key: 'k', preventDefault() {} });
  const palette = findNode(render(), (node) => node.type?.name === 'CommandPalette')!;
  assert.ok(palette);
  assert.equal(
    palette.props.entries.some((entry: any) => entry.id === 'refresh'),
    false,
  );
  palette.props.onClose();
  findNode(render(), (node) => node.type === 'button' && text(node) === '用量与连接')!.props.onClick();
  const usage = findNode(render(), (node) => node.type?.name === 'UsagePage')!;
  const usageHarness = uiHarness(await uiBundle('src/ui/UsagePage.tsx'));
  const usageTree = usageHarness.render('UsagePage', usage.props);
  const heading = findNode(usageTree, (node) => node.props.className === 'management-heading')!;
  const refresh = findNode(heading, (node) => node.type === 'button' && text(node) === '刷新')!;
  assert.equal(refresh.props.disabled, false);
  refresh.props.onClick();
  await nextTurn();
  assert.equal(calls.filter((path) => path === '/api/refresh').length, 1);
  usageHarness.unmount();
  h.unmount();
});

test('Studio waits for ready setup and first pull before prefilling account preferences', async () => {
  const calls: Array<{ path: string; body: any }> = [];
  const view = {
    configured: true,
    auth: { phase: 'signed-in', email: 'synthetic@example.test' },
    sync: 'off',
    setup: 'merge',
    firstPullComplete: false,
    devices: [],
    missingProviders: [],
  };
  const backend = {
    state: { ...state, settings: {}, account: view },
    api: async (path: string, body: any) => {
      calls.push({ path, body });
      return path === '/api/account' ? backend.state.account : {};
    },
    reload: async () => {},
  };
  const h = uiHarness(studio, { __backend: backend });
  const render = () => h.render('default');
  render();
  await nextTurn();
  render();
  assert.equal(calls.filter((x) => x.path === '/api/settings').length, 0, 'merge must not seed defaults');
  backend.state.account = { ...view, setup: 'ready' };
  render();
  await nextTurn();
  render();
  assert.equal(
    calls.filter((x) => x.path === '/api/settings').length,
    0,
    'ready before first pull must not seed defaults',
  );
  backend.state.account = { ...view, setup: 'ready', firstPullComplete: true };
  render();
  await nextTurn();
  render();
  assert.equal(calls.filter((x) => x.path === '/api/settings').length, 1);
  h.unmount();
});
