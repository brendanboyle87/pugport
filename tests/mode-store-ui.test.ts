import assert from 'node:assert/strict';
import test from 'node:test';
import { findNode, nextTurn, text, uiBundle, uiHarness } from './helpers/ui-harness.ts';

const storeCode = await uiBundle('src/ui/StorePage.tsx');
const menuCode = await uiBundle('src/ui/mods/ModToolbarButton.tsx');
const studioCode = await uiBundle('src/ui/Studio.tsx', true);
const mode = {
  schemaVersion: 1,
  id: 'fixture.mode',
  version: '1.0.0',
  title: '合成模式',
  description: '离线测试模式。',
  author: 'Fixture',
  category: '写作',
  compatible: true,
};
const catalog = { catalog: [mode], installed: [] as { modeId: string; version: string }[] };

test('source refresh updates the open detail, installed tab and search, then installs the selected revision', async () => {
  const h = uiHarness(storeCode);
  const calls: { path: string; body: unknown }[] = [];
  const newest = { ...mode, version: '1.0.12', title: 'Latest release' };
  const props = {
    api: async (path: string, body: unknown) => {
      calls.push({ path, body });
      return { catalog: [mode], installed: [{ modeId: mode.id, version: mode.version }] };
    },
    notify() {},
  };
  h.render('StorePage', props);
  await nextTurn();
  let tree = h.render('StorePage', props);
  findNode(tree, (node) => node.props.className === 'store-cover-button')!.props.onClick();
  tree = h.render('StorePage', props);
  const panel = findNode(tree, (node) => node.type?.name === 'ModeSourcePanel')!;
  panel.props.onSource({
    config: { enabled: true, repository: 'fixture/mods' },
    revision: 'new-revision',
    catalog: [newest],
  });
  tree = h.render('StorePage', props);
  const detail = findNode(tree, (node) => node.type?.name === 'ModeDetail')!;
  assert.equal(detail.props.mode.version, '1.0.12');
  assert.equal(detail.props.updateFrom, '1.0.0');
  assert.equal(detail.props.installed, true);
  assert.equal(button(tree, '更新').props.disabled, false);
  const tab = findNode(tree, (node) => node.props.role === 'tab' && text(node).includes('已加载'))!;
  assert.match(text(tab), /1/);
  tab.props.onClick();
  tree = h.render('StorePage', props);
  assert.ok(button(tree, '更新'));
  findNode(tree, (node) => node.type === 'input' && node.props.type === 'search')!.props.onChange({
    target: { value: '1.0.12' },
  });
  tree = h.render('StorePage', props);
  assert.match(text(tree), /Latest release/);
  button(tree, '更新').props.onClick();
  await nextTurn();
  assert.deepEqual(JSON.parse(JSON.stringify(calls.find((call) => call.path === '/api/modes/source/install')?.body)), {
    id: mode.id,
    version: '1.0.12',
    revision: 'new-revision',
  });
  h.unmount();
});

test('a package failure stays on its own card and details copy the raw diagnostic only on request', async () => {
  const raw = '[{"code":"invalid_type","path":["private-fixture"]}]';
  const h = uiHarness(storeCode);
  const other = { ...mode, id: 'fixture.other', title: 'Other', description: 'Untouched description' };
  const props = {
    api: async (_path: string, _body: unknown, method: string) => {
      if (method === 'GET') return { catalog: [mode, other], installed: [] };
      throw Object.assign(new Error(raw), { status: 400 });
    },
    notify() {},
  };
  h.render('StorePage', props);
  await nextTurn();
  // Load the broken card itself: card order follows the platform's locale collation.
  const brokenCard = findNode(
    h.render('StorePage', props),
    (node) => node.type === 'article' && text(node).includes(mode.title),
  );
  button(brokenCard, '加载').props.onClick();
  await nextTurn();
  const tree = h.render('StorePage', props);
  assert.match(text(tree), /这个 Mod 的文件有问题/);
  assert.match(text(tree), /Untouched description/);
  assert.doesNotMatch(text(tree), /private-fixture|invalid_type/);
  assert.equal(
    findNode(tree, (node) => node.props.className === 'store-error'),
    undefined,
  );
  const failedCard = findNode(
    tree,
    (node) => node.type === 'article' && !!findNode(node, (child) => child.props.role === 'alert'),
  )!;
  findNode(failedCard, (node) => node.props.className === 'store-cover-button')!.props.onClick();
  const detail = findNode(h.render('StorePage', props), (node) => node.type?.name === 'ModeDetail')!;
  assert.equal(detail.props.error.detail, raw);
  h.unmount();

  const copied: string[] = [];
  const callbacks: (() => void)[] = [];
  const copy = uiHarness(storeCode, {
    navigator: {
      clipboard: {
        writeText: async (value: string) => {
          copied.push(value);
        },
      },
    },
    setTimeout: (callback: () => void) => (callbacks.push(callback), callbacks.length),
    clearTimeout() {},
  });
  const copyProps = { detail: raw };
  assert.equal(copied.length, 0);
  button(copy.render('CopyModDetails', copyProps), '复制详情').props.onClick();
  await nextTurn();
  assert.deepEqual(copied, [raw]);
  assert.ok(button(copy.render('CopyModDetails', copyProps), '已复制'));
  callbacks.at(-1)!();
  assert.ok(button(copy.render('CopyModDetails', copyProps), '复制详情'));
  copy.unmount();
});

test('loaded cards open once with the exact version and recover from failed navigation', async () => {
  const h = uiHarness(storeCode);
  const pending = deferred<void>();
  const opens: unknown[] = [];
  let fail = true;
  const props = {
    api: async () => ({ ...catalog, installed: [{ modeId: mode.id, version: mode.version }] }),
    notify() {},
    onOpenMod: async (value: unknown) => {
      opens.push(value);
      if (fail) throw new Error('Raw internal navigation error');
      await pending.promise;
    },
  };
  h.render('StorePage', props);
  await nextTurn();
  button(h.render('StorePage', props), '打开').props.onClick();
  await nextTurn();
  assert.match(text(h.render('StorePage', props)), /没能打开这个 Mod，请重试/);
  assert.doesNotMatch(text(h.render('StorePage', props)), /Raw internal/);
  fail = false;
  const trigger = button(h.render('StorePage', props), '打开');
  trigger.props.onClick();
  trigger.props.onClick();
  assert.deepEqual(structuredClone(opens), [
    { id: mode.id, version: mode.version, title: mode.title },
    { id: mode.id, version: mode.version, title: mode.title },
  ]);
  assert.equal(button(h.render('StorePage', props), '打开').props.disabled, true);
  pending.resolve();
  await nextTurn();
  assert.equal(button(h.render('StorePage', props), '打开').props.disabled, false);
  h.unmount();
});

test('card art is independent from the wide detail cover and legacy cards use the cover', () => {
  const h = uiHarness(`${storeCode}\nmodule.exports.Cover = ModeCover;`);
  const cover = { src: 'data:image/png;base64,cover', alt: 'A wide reading room' };
  const card = { src: 'data:image/png;base64,card', alt: 'A close-up notebook' };
  for (const detail of [false, true]) {
    const image = h.render('Cover', { mode: { ...mode, cover, card }, detail });
    assert.equal(image.props.src, detail ? cover.src : card.src);
    assert.equal(image.props.alt, detail ? cover.alt : card.alt);
    assert.equal(image.props.width / image.props.height, detail ? 16 / 9 : 4 / 3);
  }
  // Without card art the whole 16:9 cover shows over a blurred copy instead of being cropped to 4:3.
  const [backdrop, wide] = h.render('Cover', { mode: { ...mode, cover } }).props.children;
  assert.equal(backdrop.props['aria-hidden'], 'true');
  assert.equal(wide.props.src, cover.src);
  assert.equal(wide.props.alt, cover.alt);
  assert.equal(wide.props.width / wide.props.height, 16 / 9);
  h.unmount();
});

test('an invalid exported icon produces a friendly retry state, never validation JSON', async () => {
  const h = uiHarness(storeCode);
  const props = {
    api: async (path: string) =>
      path === '/api/modes'
        ? catalog
        : {
            schemaVersion: 1,
            id: mode.id,
            version: mode.version,
            title: mode.title,
            description: mode.description,
            icon: 'book',
            view: { fields: [], actions: [] },
          },
    notify() {},
  };
  h.render('StorePage', props);
  await nextTurn();
  button(h.render('StorePage', props), `查看「${mode.title}」详情`).props.onClick();
  h.render('StorePage', props);
  await nextTurn();
  const detail = findNode(h.render('StorePage', props), (node) => node.type?.name === 'ModeDetail')!;
  assert.equal(detail.props.readmeError, '这个 Mod 的文件有问题，暂时不能加载。等作者更新后再试。');
  h.unmount();
});

test('detail alone describes declared access, including legacy compose, without granting or loading anything', async () => {
  const cases = [
    {
      permissions: ['chat:read', 'composer:draft'],
      expected: '可以读取这个对话的消息，并在输入框里填写草稿；不会代你发送。',
    },
    { permissions: ['chat:read'], expected: '可以读取这个对话的消息；不会填写草稿或代你发送。' },
    { permissions: ['composer:draft'], expected: '可以在输入框里填写草稿；不会读取消息或代你发送。' },
    { permissions: [], expected: '不会读取消息、填写草稿或代你发送。' },
    { legacy: true, permissions: ['composer:draft'], expected: '可以在输入框里填写草稿；不会读取消息或代你发送。' },
  ];
  for (const item of cases) {
    const h = uiHarness(storeCode);
    const entry = {
      ...mode,
      schemaVersion: item.legacy ? 1 : 2,
      permissions: item.legacy ? undefined : item.permissions,
    };
    const manifest = item.legacy
      ? { ...entry, view: { fields: [], actions: [{ id: 'draft', label: 'Draft', type: 'compose', prompt: 'Notes' }] } }
      : entry;
    const { compatible: _compatible, permissions: _permissions, ...legacyManifest } = manifest;
    const calls: string[] = [];
    const props = {
      api: async (path: string, _body: unknown, method: string) => {
        assert.equal(method, 'GET');
        calls.push(path);
        if (path === '/api/modes') return { catalog: [entry], installed: [] };
        if (path === '/api/modes/source') return { config: null, status: 'unconfigured', catalog: [] };
        return item.legacy ? legacyManifest : { ...legacyManifest, permissions: item.permissions };
      },
      notify() {
        assert.fail('browsing access must not mutate anything');
      },
    };
    h.render('StorePage', props);
    await nextTurn();
    const cards = h.render('StorePage', props);
    assert.doesNotMatch(text(cards), /不会代你发送|不会读取消息/);
    button(cards, `查看「${mode.title}」详情`).props.onClick();
    h.render('StorePage', props);
    await nextTurn();
    const detail = findNode(h.render('StorePage', props), (node) => node.type?.name === 'ModeDetail')!;
    assert.deepEqual(structuredClone(detail.props.permissions), item.permissions);
    h.remount();
    h.exports.Detail = detail.type;
    const content = h.render('Detail', detail.props);
    const access = findNode(content, (node) => node.props.className === 'store-detail-note store-detail-access');
    assert.equal(text(access), item.expected);
    assert.equal(calls.filter((path) => path.endsWith('/export')).length, 1);
    h.unmount();
  }
});
const button = (tree: unknown, label: string) => {
  const found = findNode(
    tree,
    (node) => node.type === 'button' && (text(node).trim() === label || node.props['aria-label'] === label),
  );
  assert.ok(found, `Missing button: ${label}`);
  return found;
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('empty catalogue is honest and a failed load stays retryable', async () => {
  const h = uiHarness(storeCode);
  let failing = true;
  const props = {
    api: async () => {
      if (failing) throw new Error('offline');
      return { catalog: [], installed: [] };
    },
    notify() {},
    onUseMode: async () => {},
  };
  h.render('StorePage', props);
  await nextTurn();
  let tree = h.render('StorePage', props);
  assert.match(text(tree), /暂时读不到 Mods 列表/);
  assert.doesNotMatch(text(tree), /这里还没有 Mods/);
  failing = false;
  await button(tree, '重试').props.onClick();
  await nextTurn();
  tree = h.render('StorePage', props);
  assert.match(text(tree), /这里还没有 Mods/);
  assert.doesNotMatch(text(tree), /学习模式|获取并使用/);
  h.unmount();
});

test('one managed load is single flight and never applies to the selected conversation', async () => {
  for (const leave of [false, true]) {
    const h = uiHarness(storeCode);
    const install = deferred<typeof catalog>();
    let posts = 0;
    const used: string[] = [];
    const props = {
      api: async (_path: string, _body: unknown, method: string) =>
        method === 'GET' ? catalog : (posts++, install.promise),
      notify() {},
      targetConversationId: 'original',
      onUseMode: async (id: string) => {
        used.push(id);
      },
    };
    h.render('StorePage', props);
    await nextTurn();
    const tree = h.render('StorePage', props);
    button(tree, '加载').props.onClick();
    button(tree, '加载').props.onClick();
    assert.equal(posts, 1);
    if (leave) h.unmount();
    install.resolve({ ...catalog, installed: [{ modeId: mode.id, version: mode.version }] });
    await nextTurn();
    assert.deepEqual(used, []);
    if (!leave) {
      assert.equal(button(h.render('StorePage', props), '打开').props.disabled, true);
      h.unmount();
    }
  }
});

test('a failed managed load stays retryable without applying a conversation', async () => {
  const h = uiHarness(storeCode);
  let installs = 0,
    uses = 0;
  const props = {
    api: async (_path: string, _body: unknown, method: string) =>
      method === 'GET'
        ? catalog
        : ++installs === 1
          ? Promise.reject(new Error('Synthetic load failed'))
          : { ...catalog, installed: [{ modeId: mode.id, version: mode.version }] },
    notify() {},
    targetConversationId: 'original',
    onUseMode: async () => {
      if (++uses === 1) throw new Error('apply failed');
    },
  };
  h.render('StorePage', props);
  await nextTurn();
  button(h.render('StorePage', props), '加载').props.onClick();
  await nextTurn();
  assert.match(text(h.render('StorePage', props)), /没能完成，请重试/);
  button(h.render('StorePage', props), '加载').props.onClick();
  await nextTurn();
  assert.equal(installs, 2);
  assert.equal(uses, 0);
  assert.equal(button(h.render('StorePage', props), '打开').props.disabled, true);
  h.unmount();
});

test('a loaded Mod opens explicitly and keeps uninstall inside details', async () => {
  const h = uiHarness(storeCode);
  let uses = 0;
  const props = {
    api: async () => ({ ...catalog, installed: [{ modeId: mode.id, version: mode.version }] }),
    notify() {},
    onUseMode: async () => {
      uses++;
    },
  };
  h.render('StorePage', props);
  await nextTurn();
  const tree = h.render('StorePage', props);
  assert.equal(button(tree, '打开').props.disabled, true);
  assert.equal(
    findNode(tree, (node) => node.type === 'button' && /^(使用|下载|安装并使用)$/.test(text(node).trim())),
    undefined,
  );
  assert.equal(uses, 0);
  h.unmount();
});

function studioFixture(api: (path: string, body?: unknown, method?: string) => Promise<unknown>) {
  const stamp = '2026-10-23T12:00:00Z';
  const conversation = { id: 'original', projectId: 'project', title: 'Original', createdAt: stamp, updatedAt: stamp };
  const state = {
    app: { version: 'fixture' },
    projects: [{ id: 'project', name: 'Fixture', path: 'C:/Fixture' }],
    conversations: [conversation],
    conversationMessages: [],
    workflows: [],
    runs: [],
    runtimes: [],
    targets: [],
    approvals: [],
    plugins: [],
    refreshing: false,
    settings: { maxQuotaAgeSeconds: 120 },
  };
  const h = uiHarness(studioCode, {
    __backend: { state, api, reload: async () => {}, connection: 'connected' },
    localStorage: { getItem: (key: string) => (key === 'agent-studio-conversation' ? 'original' : null), setItem() {} },
  });
  const store = () =>
    findNode(h.render('default'), (node) => node.type?.name === 'ExtensionsHome' && node.props.tab === 'mods')!;
  return { h, conversation, store, state };
}

test('sidebar Store has no conversation target or apply callback and creates no conversation', async () => {
  const writes: string[] = [];
  const f = studioFixture(async (path, _body, method) => {
    if (method !== 'GET') writes.push(path);
    return { conversation: f.conversation };
  });
  button(f.h.render('default'), '扩展').props.onClick();
  assert.equal(f.store().props.targetConversationId, undefined);
  assert.equal(f.store().props.onUseMode, undefined);
  assert.deepEqual(writes, []);
  f.h.unmount();
});

test('opening Store from a conversation never binds it and other navigation stays available', async () => {
  const writes: string[] = [];
  const f = studioFixture(async (path, _body, method) => {
    if (method !== 'GET') writes.push(path);
    if (path === '/api/conversations') throw new Error('must not create');
    return { conversation: f.conversation };
  });
  const split = findNode(f.h.render('default'), (node) => node.type?.name === 'SplitView')!;
  split.props.children('original', 0).props.onOpenModeStore('original');
  assert.equal(f.store().props.targetConversationId, undefined);
  assert.equal(f.store().props.onUseMode, undefined);
  button(f.h.render('default'), '任务列表').props.onClick();
  assert.deepEqual(writes, []);
  assert.equal(f.store(), undefined);
  assert.ok(findNode(f.h.render('default'), (node) => node.type?.name === 'ScheduledTasks'));
  f.h.unmount();
});

test('Extensions keeps tab navigation separate from settings', () => {
  const f = studioFixture(async () => ({}));
  const split = findNode(f.h.render('default'), (node) => node.type?.name === 'SplitView')!;
  button(f.h.render('default'), '扩展').props.onClick();
  const home = () => findNode(f.h.render('default'), (node) => node.type?.name === 'ExtensionsHome')!;
  home().props.onTab('skills');
  assert.equal(home().props.tab, 'skills');
  button(f.h.render('default'), '设置').props.onClick();
  assert.equal(
    findNode(f.h.render('default'), (node) => node.type?.name === 'SettingsShell')!.props.category,
    'general',
  );
  button(f.h.render('default'), '扩展').props.onClick();
  assert.equal(home().props.tab, 'skills');
  split.props.children('original', 0).props.onOpenModeStore();
  assert.ok(f.store());
  f.h.unmount();
});

test('Mods Store starts at Discover without extension management', () => {
  const h = uiHarness(storeCode);
  const props = { api: async () => catalog, notify() {}, onUseMode: async () => {} };
  const selected = (tree: unknown) =>
    text(findNode(tree, (node) => node.props.role === 'tab' && node.props['aria-selected'])!);
  const tree = h.render('StorePage', props);
  assert.equal(selected(tree), '发现');
  assert.equal(
    findNode(tree, (node) => node.type?.name === 'ExtensionsPage'),
    undefined,
  );
  h.unmount();
});

test('manifest import only sends parsed declarations and never installs or uses a conversation', async () => {
  const h = uiHarness(storeCode);
  const calls: any[] = [];
  let uses = 0;
  const props = {
    api: async (path: string, body?: unknown, method?: string) => {
      calls.push({ path, body, method });
      return catalog;
    },
    notify() {},
    onUseMode: async () => {
      uses++;
    },
  };
  h.render('StorePage', props);
  await nextTurn();
  button(h.render('StorePage', props), '导入 Mod').props.onClick();
  let tree = h.render('StorePage', props);
  const manifest = {
    schemaVersion: 1,
    id: 'fixture.mode',
    version: '1.0.0',
    title: 'Fixture',
    description: 'Fixture',
    view: { fields: [], actions: [] },
  };
  findNode(tree, (node) => node.type === 'textarea')!.props.onChange({ target: { value: '{not-json' } });
  button(h.render('StorePage', props), '导入清单').props.onClick();
  await nextTurn();
  assert.equal(calls.length, 1);
  tree = h.render('StorePage', props);
  findNode(tree, (node) => node.type === 'textarea')!.props.onChange({ target: { value: JSON.stringify(manifest) } });
  button(h.render('StorePage', props), '导入清单').props.onClick();
  await nextTurn();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].path, '/api/modes/import');
  assert.deepEqual(JSON.parse(JSON.stringify(calls[1].body)), { manifest });
  assert.equal(uses, 0);
  h.unmount();
});

test('loading from the selected project Store writes only the managed install endpoint', async () => {
  const writes: string[] = [];
  const f = studioFixture(async (path, _body, method) => {
    assert.notEqual(path, '/api/conversations');
    if (method !== 'GET') writes.push(path);
    return path === '/api/modes' ? catalog : { ...catalog, installed: [{ modeId: mode.id, version: mode.version }] };
  });
  const split = findNode(f.h.render('default'), (node) => node.type?.name === 'SplitView')!;
  split.props.children('original', 0).props.onOpenModeStore('original');
  const store = uiHarness(storeCode);
  const props = f.store().props;
  store.render('StorePage', props);
  await nextTurn();
  button(store.render('StorePage', props), '加载').props.onClick();
  await nextTurn();
  assert.deepEqual(writes, [`/api/modes/${mode.id}/install`]);
  assert.ok(f.store());
  store.unmount();
  f.h.unmount();
});

test('Mods search and real category filters stay local and include author and version', async () => {
  const h = uiHarness(storeCode);
  let calls = 0;
  const props = {
    api: async () => (
      calls++,
      {
        catalog: [
          mode,
          { ...mode, id: 'fixture.other', title: '另一模式', author: 'Other', category: '开发', version: '2.0.0' },
          { ...mode, id: 'fixture.third', title: '第三模式', category: 'productivity' },
        ],
        installed: [],
      }
    ),
    notify() {},
    onUseMode: async () => {},
  };
  h.render('StorePage', props);
  await nextTurn();
  const grouped = h.render('StorePage', props);
  assert.ok(button(grouped, '效率'));
  const grid = findNode(grouped, (node) => node.props.className === 'store-card-grid store-modes')!;
  assert.ok(grid);
  assert.equal(
    findNode(grouped, (node) => node.props.className === 'store-mode-group'),
    undefined,
  );
  const cards = grid.props.children.flat();
  assert.deepEqual(
    structuredClone(cards.map((card: unknown) => text(findNode(card, (node) => node.type === 'h4')))),
    [
      { category: '写作', title: '合成模式' },
      { category: '开发', title: '另一模式' },
      { category: '效率', title: '第三模式' },
    ]
      .sort((a, b) => a.category.localeCompare(b.category))
      .map((item) => item.title),
  );
  const search = (value: string) => {
    findNode(
      h.render('StorePage', props),
      (node) => node.type === 'input' && node.props.type === 'search',
    )!.props.onChange({ target: { value } });
    return h.render('StorePage', props);
  };
  assert.doesNotMatch(text(search('Other')), /合成模式/);
  assert.match(text(search('2.0.0')), /另一模式/);
  assert.match(text(search('开发')), /另一模式/);
  search('');
  button(h.render('StorePage', props), '写作').props.onClick();
  assert.doesNotMatch(text(h.render('StorePage', props)), /另一模式/);
  assert.match(text(search('missing')), /没有找到匹配的 Mods/);
  assert.equal(calls, 1);
  h.unmount();
});

test('loading stores the Mod locally with a short success message', async () => {
  const h = uiHarness(storeCode),
    notices: any[] = [],
    calls: string[] = [];
  const props = {
    api: async (path: string) => {
      calls.push(path);
      return path === '/api/modes' ? catalog : { ...catalog, installed: [{ modeId: mode.id, version: mode.version }] };
    },
    notify: (notice: unknown) => notices.push(notice),
    onUseMode: async () => assert.fail('no project target'),
  };
  h.render('StorePage', props);
  await nextTurn();
  button(h.render('StorePage', props), '加载').props.onClick();
  await nextTurn();
  assert.deepEqual(calls, ['/api/modes', `/api/modes/${mode.id}/install`]);
  assert.equal(notices[0]?.message, 'Mod 已加载。');
  assert.equal(button(h.render('StorePage', props), '打开').props.disabled, true);
  h.unmount();
});

test('legacy target props cannot make a managed load apply to either chat', async () => {
  const h = uiHarness(storeCode),
    install = deferred<any>(),
    uses: string[] = [];
  const props = {
    api: async (path: string) => (path === '/api/modes' ? catalog : install.promise),
    notify() {},
    targetConversationId: 'original',
    onUseMode: async () => {
      uses.push(props.targetConversationId);
    },
  };
  h.render('StorePage', props);
  await nextTurn();
  button(h.render('StorePage', props), '加载').props.onClick();
  props.targetConversationId = 'other';
  h.render('StorePage', props);
  install.resolve({ ...catalog, installed: [{ modeId: mode.id, version: mode.version }] });
  await nextTurn();
  assert.deepEqual(uses, []);
  h.unmount();
});

test('sidebar Store does not use a standalone, deleted, closed or removed project chat', async () => {
  for (const unavailable of ['standalone', 'deleted', 'closed', 'removed']) {
    const writes: string[] = [];
    const f = studioFixture(async (path, _body, method) => {
      if (method !== 'GET') writes.push(path);
      return {};
    });
    const p: any = f.state.projects[0],
      c: any = f.conversation;
    if (unavailable === 'standalone') p.scope = 'chat';
    if (unavailable === 'deleted') c.deletedAt = '2026-10-25T00:00:00Z';
    if (unavailable === 'closed') c.closedAt = '2026-10-25T00:00:00Z';
    if (unavailable === 'removed') p.removedAt = '2026-10-25T00:00:00Z';
    button(f.h.render('default'), '扩展').props.onClick();
    assert.equal(f.store().props.targetConversationId, undefined);
    assert.equal(f.store().props.onUseMode, undefined);
    assert.deepEqual(writes, []);
    f.h.unmount();
  }
});

test('details read only the selected manifest, show loading and ignore aborted results after close', async () => {
  const h = uiHarness(storeCode),
    exported = deferred<any>(),
    calls: any[] = [];
  const props = {
    api: async (path: string, _body: unknown, method: string, signal?: AbortSignal) => {
      calls.push({ path, method, signal });
      return path === '/api/modes' ? catalog : exported.promise;
    },
    notify() {},
    onUseMode: async () => assert.fail('browsing must not apply'),
  };
  h.render('StorePage', props);
  await nextTurn();
  button(h.render('StorePage', props), `查看「${mode.title}」详情`).props.onClick();
  let tree = h.render('StorePage', props);
  let detail = findNode(tree, (node) => node.type?.name === 'ModeDetail')!;
  assert.equal(detail.props.readme, undefined);
  assert.deepEqual(
    calls.map((c) => c.path),
    ['/api/modes', `/api/modes/${mode.id}/versions/${mode.version}/export`],
  );
  detail.props.onClose();
  h.render('StorePage', props);
  assert.equal(calls[1].signal.aborted, true);
  exported.resolve({
    schemaVersion: 1,
    id: mode.id,
    version: mode.version,
    title: mode.title,
    description: mode.description,
    readme: '# Do not reopen',
    view: { fields: [], actions: [] },
  });
  await nextTurn();
  assert.equal(
    findNode(h.render('StorePage', props), (node) => node.type?.name === 'ModeDetail'),
    undefined,
  );
  h.unmount();
});

test('details can retry without installing, and importing counts UTF8 bytes rather than characters', async () => {
  const h = uiHarness(storeCode);
  let exports = 0,
    imports = 0;
  const props = {
    api: async (path: string) => {
      if (path === '/api/modes') return catalog;
      if (path === '/api/modes/import') {
        imports++;
        return catalog;
      }
      if (++exports === 1) throw new Error('Synthetic detail offline');
      return {
        schemaVersion: 1,
        id: mode.id,
        version: mode.version,
        title: mode.title,
        description: mode.description,
        readme: '# Readable guide\n\n**Evidence**',
        view: { fields: [], actions: [] },
      };
    },
    notify() {},
    onUseMode: async () => assert.fail('browse only'),
  };
  h.render('StorePage', props);
  await nextTurn();
  button(h.render('StorePage', props), `查看「${mode.title}」详情`).props.onClick();
  h.render('StorePage', props);
  await nextTurn();
  let detail = findNode(h.render('StorePage', props), (node) => node.type?.name === 'ModeDetail')!;
  assert.match(detail.props.readmeError, /没能完成，请重试/);
  const drawer = uiHarness(`${storeCode}\nmodule.exports.Detail = ModeDetail;`);
  const content = drawer.render('Detail', { ...detail.props, readmeError: 'Raw JSON validation error: synthetic' });
  assert.match(text(content), /说明暂时读不到/);
  assert.doesNotMatch(text(content), /Raw JSON|validation error/);
  assert.ok(button(content, '重试'));
  drawer.unmount();
  detail.props.onRetry();
  h.render('StorePage', props);
  await nextTurn();
  detail = findNode(h.render('StorePage', props), (node) => node.type?.name === 'ModeDetail')!;
  assert.match(detail.props.readme, /# Readable guide/);
  detail.props.onClose();
  button(h.render('StorePage', props), '导入 Mod').props.onClick();
  findNode(h.render('StorePage', props), (node) => node.type === 'textarea')!.props.onChange({
    target: { value: '中'.repeat(360000) },
  });
  button(h.render('StorePage', props), '导入清单').props.onClick();
  await nextTurn();
  assert.equal(imports, 0);
  assert.match(text(h.render('StorePage', props)), /这个 Mod 的文件有问题/);
  assert.doesNotMatch(text(h.render('StorePage', props)), /1 MiB/);
  h.unmount();
});

test('toolbar discovers loaded Mods while empty and lists all available names', () => {
  for (const count of [0, 1, 3, 4]) {
    const h = uiHarness(menuCode);
    let opens = 0;
    const selected: string[] = [];
    const installed = Array.from({ length: count }, (_, n) => ({
      ...mode,
      id: `fixture.mode${n}`,
      title: `Mode ${n}`,
    }));
    const props = {
      installed,
      hidden: false,
      hasSurface: false,
      onOpen: () => {
        opens++;
      },
      onSelect: (id: string) => selected.push(id),
      onToggle() {},
      onStore() {},
    };
    let tree = h.render('ModToolbarButton', props);
    assert.equal(opens, 1);
    if (!count) {
      assert.equal(tree, null);
      h.unmount();
      continue;
    }
    const trigger = button(tree, '添加 Mod');
    assert.equal(trigger.props['aria-haspopup'], 'menu');
    trigger.props.onKeyDown({ key: 'ArrowDown', preventDefault() {} });
    tree = h.render('ModToolbarButton', props);
    assert.equal(opens, 2);
    for (const entry of installed) assert.equal(button(tree, entry.title).props.role, 'menuitem');
    assert.equal(
      findNode(tree, (node) => node.type === 'button' && text(node) === '普通对话'),
      undefined,
    );
    button(tree, installed[0]!.title).props.onClick();
    assert.deepEqual(selected, [installed[0]!.id]);
    assert.equal(
      findNode(h.render('ModToolbarButton', props), (node) => node.props.role === 'menu'),
      undefined,
    );
    h.unmount();
  }
});

test('attached toolbar toggles show and hide without an attach or context menu', () => {
  const h = uiHarness(menuCode);
  let toggles = 0;
  const props = {
    installed: [mode],
    binding: { instanceId: 'instance', modeId: mode.id, version: mode.version },
    hidden: false,
    hasSurface: true,
    onSelect() {
      assert.fail('toggle must not attach');
    },
    onToggle: () => toggles++,
    onStore() {},
  };
  let tree = h.render('ModToolbarButton', props);
  const visible = button(tree, '隐藏 Mod');
  assert.equal(visible.props['aria-pressed'], true);
  assert.equal(visible.props['aria-haspopup'], undefined);
  visible.props.onClick();
  assert.equal(toggles, 1);
  props.hidden = true;
  tree = h.render('ModToolbarButton', props);
  const hidden = button(tree, '显示 Mod');
  assert.equal(hidden.props['aria-pressed'], false);
  hidden.props.onClick();
  assert.equal(toggles, 2);
  h.unmount();
});

test('an attached unloaded Mod remains controllable and a surface-less Mod opens a small menu', () => {
  const h = uiHarness(menuCode);
  let stores = 0;
  const props: any = {
    installed: [],
    binding: { instanceId: 'saved', modeId: mode.id, version: mode.version },
    hidden: true,
    hasSurface: true,
    onSelect() {},
    onToggle() {},
    onStore: () => stores++,
  };
  assert.equal(button(h.render('ModToolbarButton', props), '显示 Mod').props['aria-pressed'], false);
  props.hasSurface = false;
  button(h.render('ModToolbarButton', props), 'Mod 菜单').props.onClick();
  button(h.render('ModToolbarButton', props), '打开 Mods Store').props.onClick();
  assert.equal(stores, 1);
  props.binding = null;
  assert.equal(h.render('ModToolbarButton', props), null);
  h.unmount();
});

test('pending changes retain an accessible status while only active writes disable the toolbar', () => {
  const h = uiHarness(menuCode);
  const props: any = {
    installed: [mode],
    hidden: false,
    hasSurface: false,
    pendingBinding: { binding: null, afterWorkflowId: 'task', requestedAt: '' },
    onSelect() {},
    onToggle() {},
    onStore() {},
  };
  let tree = h.render('ModToolbarButton', props);
  assert.match(text(tree), /本轮结束后切换/);
  assert.ok(button(tree, '添加 Mod').props['aria-describedby']);
  assert.equal(!!button(tree, '添加 Mod').props.disabled, false);
  props.busy = true;
  tree = h.render('ModToolbarButton', props);
  assert.equal(button(tree, '添加 Mod').props.disabled, true);
  h.unmount();
});

test('catalog refresh return values never become toolbar effect cleanup', () => {
  for (const value of [1, Promise.resolve()]) {
    const h = uiHarness(menuCode);
    let opens = 0;
    const props = {
      installed: [],
      hidden: false,
      hasSurface: false,
      onOpen: () => {
        opens++;
        return value;
      },
      onSelect() {},
      onToggle() {},
      onStore() {},
    };
    h.render('ModToolbarButton', props);
    h.render('ModToolbarButton', props);
    assert.equal(opens, 1);
    assert.doesNotThrow(() => h.unmount());
  }
});

test('a failed Mod read appears in the menu and can be retried', () => {
  const h = uiHarness(menuCode);
  let retries = 0;
  const props = {
    installed: [],
    binding: { instanceId: 'instance', modeId: mode.id, version: mode.version },
    hidden: false,
    hasSurface: false,
    error: 'Synthetic failure',
    onRetry: () => retries++,
    onSelect() {},
    onToggle() {},
    onStore() {},
  };
  try {
    button(h.render('ModToolbarButton', props), 'Mod 菜单').props.onClick();
    const tree = h.render('ModToolbarButton', props);
    assert.equal(text(findNode(tree, (node) => node.props.role === 'alert')!), '没能完成，请重试。');
    button(tree, '重新读取').props.onClick();
    assert.equal(retries, 1);
  } finally {
    h.unmount();
  }
});
