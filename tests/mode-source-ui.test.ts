import assert from 'node:assert/strict';
import test from 'node:test';
import { findNode, nextTurn, text, uiBundle, uiHarness } from './helpers/ui-harness.ts';

const panelCode = await uiBundle('src/ui/ModeSourcePanel.tsx');
const storeCode = await uiBundle('src/ui/StorePage.tsx');
const config = { enabled: true, repository: 'fixture/private-mods', ref: 'main', catalogPath: 'catalog.json' };
const revision = 'a'.repeat(40),
  nextRevision = 'b'.repeat(40);
const mode = {
  id: 'fixture.remote',
  version: '1.0.0',
  title: 'Remote fixture',
  description: 'Synthetic remote metadata',
  author: 'Fixture',
  category: 'Writing',
  compatible: true,
};
const ready = { config, status: 'ready', catalog: [mode], revision, checkedAt: '2026-10-24T12:00:00.000Z' };
const { compatible: _compatible, ...manifestMetadata } = mode;
const manifest = { schemaVersion: 1, ...manifestMetadata, view: { fields: [], actions: [] } };
const empty = { config: null, status: 'unconfigured', catalog: [] };
const button = (tree: unknown, label: string) => {
  const value = findNode(
    tree,
    (node) => node.type === 'button' && (text(node).trim() === label || node.props['aria-label'] === label),
  );
  assert.ok(value, 'Missing button: ' + label);
  return value;
};
const form = (tree: unknown) => findNode(tree, (node) => node.type === 'form')!;
const input = (tree: unknown, placeholder: string) =>
  findNode(tree, (node) => node.type === 'input' && node.props.placeholder === placeholder)!;
function deferred<T>() {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((done) => {
      resolve = done;
    }),
    resolve,
  };
}

test('source publishes cached metadata before a bounded background refresh and refresh never installs', async () => {
  const h = uiHarness(panelCode),
    refreshed = deferred<unknown>(),
    calls: any[] = [],
    published: any[] = [],
    busy: boolean[] = [];
  const props = {
    api: async (path: string, body: unknown, method: string) => {
      calls.push({ path, body, method });
      return method === 'GET' ? ready : refreshed.promise;
    },
    onSource: (value: unknown) => published.push(value),
    onBusyChange: (value: boolean) => busy.push(value),
  };
  h.render('ModeSourcePanel', props);
  await nextTurn();
  assert.equal(published.length, 1);
  assert.equal(published[0].revision, revision);
  assert.deepEqual(
    calls.map((c) => [c.path, c.method]),
    [
      ['/api/modes/source', 'GET'],
      ['/api/modes/source/refresh', 'POST'],
    ],
  );
  assert.deepEqual(JSON.parse(JSON.stringify(calls[1].body)), {});
  refreshed.resolve({ ...ready, revision: nextRevision, catalog: [] });
  await nextTurn();
  assert.equal(published[1].revision, nextRevision);
  assert.deepEqual(busy, [true, false]);
  assert.match(text(h.render('ModeSourcePanel', props)), /0 个 Mods/);
  h.unmount();
});

test('source configuration replaces pending requests, ignores old responses and reuses host GitHub login', async () => {
  const h = uiHarness(panelCode),
    oldRefresh = deferred<unknown>(),
    calls: any[] = [],
    published: any[] = [];
  const replacement = { ...config, repository: 'fixture/new-source', ref: 'release/v1' };
  const props = {
    api: async (path: string, body: any, method: string, signal?: AbortSignal) => {
      calls.push({ path, body, method, signal });
      if (method === 'GET') return ready;
      if (method === 'PUT') return { config: replacement, status: 'unconfigured', catalog: [] };
      return body.force ? { ...ready, config: replacement, revision: nextRevision } : oldRefresh.promise;
    },
    onSource: (value: unknown) => published.push(value),
    onBusyChange() {},
  };
  h.render('ModeSourcePanel', props);
  await nextTurn();
  button(h.render('ModeSourcePanel', props), '设置来源').props.onClick();
  let tree = h.render('ModeSourcePanel', props);
  input(tree, 'owner/repository').props.onChange({ target: { value: replacement.repository } });
  input(tree, 'main').props.onChange({ target: { value: replacement.ref } });
  tree = h.render('ModeSourcePanel', props);
  form(tree).props.onSubmit({ preventDefault() {} });
  await nextTurn();
  const saved = calls.find((c) => c.method === 'PUT');
  assert.deepEqual(JSON.parse(JSON.stringify(saved.body)), replacement);
  assert.equal(calls[1].signal.aborted, true);
  assert.equal(calls.filter((c) => c.path === '/api/modes/source/refresh' && c.body.force === true).length, 1);
  oldRefresh.resolve(ready);
  await nextTurn();
  assert.equal(published.at(-1).config.repository, replacement.repository);
  assert.equal(published.at(-1).revision, nextRevision);
  assert.equal(
    calls.some((c) => /install|login/.test(c.path)),
    false,
  );
  button(h.render('ModeSourcePanel', props), '设置来源').props.onClick();
  assert.doesNotMatch(text(h.render('ModeSourcePanel', props)), /输入.*Token|输入.*Key/);
  h.unmount();
});

test('manual refresh is single flight, uses force and keeps safe cached errors readable', async () => {
  const h = uiHarness(panelCode),
    manual = deferred<unknown>(),
    calls: any[] = [],
    published: any[] = [];
  const props = {
    api: async (path: string, body: any, method: string) => {
      calls.push({ path, body, method });
      return method === 'GET' || !body.force ? ready : manual.promise;
    },
    onSource: (value: unknown) => published.push(value),
    onBusyChange() {},
  };
  h.render('ModeSourcePanel', props);
  await nextTurn();
  assert.equal(
    findNode(h.render('ModeSourcePanel', props), (node) => node.type === 'button' && text(node).trim() === '刷新来源'),
    undefined,
  );
  button(h.render('ModeSourcePanel', props), '设置来源').props.onClick();
  const action = button(h.render('ModeSourcePanel', props), '刷新来源');
  action.props.onClick();
  action.props.onClick();
  assert.equal(calls.filter((c) => c.body?.force).length, 1);
  manual.resolve({ ...ready, status: 'error', error: 'GitHub 登录需要此私有仓库的读取权限。' });
  await nextTurn();
  assert.equal(published.at(-1).catalog[0].id, mode.id);
  assert.match(text(h.render('ModeSourcePanel', props)), /没能完成，请重试/);
  h.unmount();
});

test('source rejects malformed responses and ignores late results after leaving', async () => {
  for (const leave of [false, true]) {
    const h = uiHarness(panelCode),
      response = deferred<unknown>(),
      published: unknown[] = [];
    const props = {
      api: async () => response.promise,
      onSource: (value: unknown) => published.push(value),
      onBusyChange() {},
    };
    h.render('ModeSourcePanel', props);
    if (leave) h.unmount();
    response.resolve(leave ? ready : { ...ready, revision: 'not-a-commit' });
    await nextTurn();
    assert.equal(published.length, 0);
    if (!leave) {
      assert.match(text(h.render('ModeSourcePanel', props)), /没能完成，请重试/);
      h.unmount();
    }
  }
});

test('a source request timeout releases the gate without accepting a late response', async () => {
  const response = deferred<unknown>(),
    published: unknown[] = [],
    busy: boolean[] = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const h = uiHarness(panelCode, {
    setTimeout: (fn: () => void, ms: number) => (timers.push({ fn, ms }), timers.length),
    clearTimeout() {},
  });
  const props = {
    api: async () => response.promise,
    onSource: (value: unknown) => published.push(value),
    onBusyChange: (value: boolean) => busy.push(value),
  };
  h.render('ModeSourcePanel', props);
  const timer = timers.find((item) => item.ms === 20000);
  assert.ok(timer);
  timer.fn();
  await nextTurn();
  assert.deepEqual(busy, [true, false]);
  assert.match(text(h.render('ModeSourcePanel', props)), /连不上 Mod 来源/);
  response.resolve(ready);
  await nextTurn();
  assert.equal(published.length, 0);
  h.unmount();
});

const sourcePanel = (tree: unknown) => findNode(tree, (node) => node.type?.name === 'ModeSourcePanel')!;
const card = (tree: unknown, title: string) =>
  findNode(tree, (node) => node.type === 'article' && text(node).includes(title))!;
test('Store merges by immutable version, prefers local content and loads remote once without using it', async () => {
  const h = uiHarness(storeCode),
    calls: any[] = [],
    used: string[] = [];
  const local = { ...mode, id: 'fixture.local', title: 'Local immutable fixture' };
  const props = {
    api: async (path: string, body: unknown, method: string) => {
      calls.push({ path, body, method });
      if (path === '/api/modes') return { catalog: [local], installed: [] };
      assert.equal(path, '/api/modes/source/install');
      return { catalog: [local, mode], installed: [{ modeId: mode.id, version: mode.version }] };
    },
    notify() {},
    targetConversationId: 'project-chat',
    onUseMode: async (id: string) => {
      used.push(id);
    },
  };
  h.render('StorePage', props);
  await nextTurn();
  sourcePanel(h.render('StorePage', props)).props.onSource({
    ...ready,
    catalog: [mode, { ...local, title: 'Remote collision must not replace local' }],
  });
  let tree = h.render('StorePage', props);
  assert.ok(card(tree, local.title));
  assert.doesNotMatch(text(tree), /Remote collision/);
  assert.equal(calls.length, 1);
  assert.deepEqual(used, []);
  const action = button(card(tree, mode.title), '加载');
  action.props.onClick();
  action.props.onClick();
  await nextTurn();
  assert.deepEqual(JSON.parse(JSON.stringify(calls[1])), {
    path: '/api/modes/source/install',
    body: { id: mode.id, version: mode.version, revision },
  });
  assert.deepEqual(used, []);
  assert.equal(calls.length, 2);
  assert.equal(button(card(h.render('StorePage', props), mode.title), '打开').props.disabled, true);
  h.unmount();
});

test('remote details use a pinned revision without installing and stale responses cannot overwrite a new source', async () => {
  const response = deferred<unknown>(),
    calls: string[] = [],
    downloads: string[] = [];
  const link = {
    href: '',
    download: '',
    click() {
      downloads.push(link.download);
    },
  };
  const h = uiHarness(storeCode, {
    URL: { createObjectURL: () => 'blob:fixture', revokeObjectURL() {} },
    document: { createElement: () => link },
  });
  const props = {
    api: async (path: string) => {
      calls.push(path);
      return path === '/api/modes' ? { catalog: [], installed: [] } : response.promise;
    },
    notify() {},
    onUseMode: async () => assert.fail('must not apply'),
  };
  h.render('StorePage', props);
  await nextTurn();
  sourcePanel(h.render('StorePage', props)).props.onSource(ready);
  let tree = h.render('StorePage', props);
  button(card(tree, mode.title), `查看「${mode.title}」详情`).props.onClick();
  tree = h.render('StorePage', props);
  assert.equal(calls[1], `/api/modes/source/${mode.id}/versions/${mode.version}/export?revision=${revision}`);
  sourcePanel(tree).props.onSource({
    ...ready,
    config: { ...config, repository: 'fixture/changed' },
    catalog: [],
    revision: nextRevision,
  });
  h.render('StorePage', props);
  response.resolve({ ...manifest, readme: 'Stale remote README' });
  await nextTurn();
  assert.deepEqual(downloads, []);
  const detail = findNode(h.render('StorePage', props), (node) => node.type?.name === 'ModeDetail')!;
  assert.match(detail.props.readmeError, /来源已更新/);
  assert.equal(detail.props.readme, undefined);
  assert.equal(
    calls.some((path) => path.endsWith('/install')),
    false,
  );
  h.unmount();
});

test('source failures preserve local cards and an old remote detail cannot silently use a new revision', async () => {
  const h = uiHarness(storeCode),
    calls: string[] = [];
  const local = { ...mode, id: 'fixture.local', title: 'Local remains available' };
  const props = {
    api: async (path: string) => {
      calls.push(path);
      return path === '/api/modes' ? { catalog: [local], installed: [] } : manifest;
    },
    notify() {},
    onUseMode: async () => {},
  };
  h.render('StorePage', props);
  await nextTurn();
  sourcePanel(h.render('StorePage', props)).props.onSource(ready);
  let tree = h.render('StorePage', props);
  button(card(tree, mode.title), `查看「${mode.title}」详情`).props.onClick();
  tree = h.render('StorePage', props);
  sourcePanel(tree).props.onSource({ ...ready, revision: nextRevision, status: 'error', error: 'Synthetic offline' });
  tree = h.render('StorePage', props);
  assert.ok(card(tree, local.title));
  findNode(tree, (node) => node.type?.name === 'ModeDetail')!.props.onLoad();
  await nextTurn();
  assert.deepEqual(calls, [
    '/api/modes',
    `/api/modes/source/${mode.id}/versions/${mode.version}/export?revision=${revision}`,
  ]);
  assert.match(text(h.render('StorePage', props)), /来源已更新/);
  h.unmount();
});

test('remote details stay pinned while cards advance and reopening explicitly selects the new revision', async () => {
  const h = uiHarness(storeCode),
    calls: string[] = [];
  const newer = { ...mode, version: '1.0.1', title: 'New remote release' };
  const props = {
    api: async (path: string) => {
      calls.push(path);
      if (path === '/api/modes') return { catalog: [], installed: [] };
      return { ...manifest, ...(path.includes('/1.0.1/') ? { version: newer.version } : {}) };
    },
    notify() {},
  };
  h.render('StorePage', props);
  await nextTurn();
  sourcePanel(h.render('StorePage', props)).props.onSource(ready);
  button(card(h.render('StorePage', props), mode.title), `查看「${mode.title}」详情`).props.onClick();
  let tree = h.render('StorePage', props);
  sourcePanel(tree).props.onSource({ ...ready, revision: nextRevision, catalog: [newer] });
  tree = h.render('StorePage', props);
  const detail = findNode(tree, (node) => node.type?.name === 'ModeDetail')!;
  assert.equal(detail.props.mode.version, mode.version);
  assert.equal(detail.props.mode.sourceRevision, revision);
  assert.match(detail.props.readmeError, /来源已更新/);
  assert.ok(card(tree, newer.title));
  detail.props.onLoad();
  await nextTurn();
  assert.equal(calls.length, 2);
  detail.props.onClose();
  button(card(h.render('StorePage', props), newer.title), `查看「${newer.title}」详情`).props.onClick();
  tree = h.render('StorePage', props);
  assert.equal(findNode(tree, (node) => node.type?.name === 'ModeDetail')!.props.mode.version, newer.version);
  assert.equal(calls.at(-1), `/api/modes/source/${mode.id}/versions/${newer.version}/export?revision=${nextRevision}`);
  h.unmount();
});

test('changing a source during managed loading cannot publish its late result even before render', async () => {
  const h = uiHarness(storeCode),
    install = deferred<any>(),
    calls: any[] = [],
    used: string[] = [];
  const props = {
    api: async (path: string, body: unknown) => {
      calls.push({ path, body });
      return path === '/api/modes' ? { catalog: [], installed: [] } : install.promise;
    },
    notify() {},
    targetConversationId: 'project-chat',
    onUseMode: async (id: string) => {
      used.push(id);
    },
  };
  h.render('StorePage', props);
  await nextTurn();
  sourcePanel(h.render('StorePage', props)).props.onSource(ready);
  const tree = h.render('StorePage', props);
  button(card(tree, mode.title), '加载').props.onClick();
  sourcePanel(tree).props.onSource({
    ...ready,
    config: { ...config, repository: 'fixture/other-private' },
    revision: nextRevision,
    catalog: [],
  });
  install.resolve({ catalog: [mode], installed: [{ modeId: mode.id, version: mode.version }] });
  await nextTurn();
  assert.deepEqual(used, []);
  assert.equal(card(h.render('StorePage', props), mode.title), undefined);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].body.revision, revision);
  h.unmount();
});
