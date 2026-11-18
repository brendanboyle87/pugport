import assert from 'node:assert/strict';
import test from 'node:test';
import { findNode, nextTurn, text, uiBundle, uiHarness } from './helpers/ui-harness.ts';

const code = await uiBundle('src/ui/Extensions.tsx');

const button = (tree: unknown, label: string) => {
  const found = findNode(
    tree,
    (node) => node.type === 'button' && (text(node) === label || node.props['aria-label'] === label),
  );
  assert.ok(found, `Missing button ${label}`);
  return found;
};
const rowMenu = (h: ReturnType<typeof uiHarness>, props: any) => {
  button(h.render('InstalledRow', props), `更多操作：${props.item.name}`).props.onClick({
    currentTarget: { getBoundingClientRect: () => ({ left: 48, bottom: 96 }) },
    clientX: 999,
    clientY: 999,
  });
  const menu = findNode(h.render('InstalledRow', props), (node) => node.type?.name === 'ContextMenu')!;
  assert.equal(menu.props.x, 48);
  assert.equal(menu.props.y, 96);
  return menu;
};
const editRow = (h: ReturnType<typeof uiHarness>, props: any) => {
  const menu = rowMenu(h, props);
  menu.props.onClose();
  menu.props.items.find((item: any) => item.label === '改名称和设置…').onSelect();
  const sheet = findNode(h.render('InstalledRow', props), (node) => node.type?.name === 'SideSheet');
  assert.equal(sheet?.props.label, props.item.name);
};

test('extensions show a safe load error returned with an empty list', async () => {
  const h = uiHarness(code);
  const props = {
    api: async (path: string) => {
      if (path === '/api/app-info') return { tools: {} };
      if (path === '/api/tool-installations') return { installations: [] };
      return { items: [], catalog: [], error: '无法读取工具配置或凭据，原文件未修改。' };
    },
    notify() {},
  };
  let tree = h.render('ExtensionsPage', props);
  findNode(tree, (node) => node.props.role === 'tab' && text(node).startsWith('已安装'))?.props.onClick();
  await nextTurn();
  tree = h.render('ExtensionsPage', props);
  assert.match(text(tree), /无法读取工具配置或凭据/);
  assert.doesNotMatch(text(tree), /添加第一个连接/);
  h.unmount();
});

test('extensions distinguish failed loads from an empty collection and can retry', async () => {
  let fail = true;
  const props = {
    section: 'connections',
    api: async (path: string) => {
      if (path === '/api/app-info') return { tools: {} };
      if (path === '/api/tool-installations') return { installations: [] };
      if (fail) throw new Error('offline');
      return { items: [], catalog: [] };
    },
    notify() {},
  };
  const h = uiHarness(code);
  let tree = h.render('ExtensionsPage', props);
  findNode(tree, (node) => node.props.role === 'tab' && text(node).startsWith('已安装'))?.props.onClick();
  tree = h.render('ExtensionsPage', props);
  assert.match(text(tree), /正在加载扩展/);
  assert.doesNotMatch(text(tree), /添加第一个连接/);
  await nextTurn();
  tree = h.render('ExtensionsPage', props);
  assert.match(text(tree), /暂时无法加载扩展/);
  assert.doesNotMatch(text(tree), /添加第一个连接/);
  fail = false;
  await button(tree, '重试').props.onClick();
  await nextTurn();
  tree = h.render('ExtensionsPage', props);
  assert.match(text(tree), /添加第一个连接/);
  assert.doesNotMatch(text(tree), /暂时无法加载扩展/);
  h.unmount();
});

test('MCP preview defaults to adding an instance, replacement requires explicit selection', () => {
  const h = uiHarness(code);
  let choice: any = {
    token: 'preview',
    drafts: [
      {
        key: 'mcp:0',
        kind: 'mcp',
        name: 'Mail',
        origin: 'fixture',
        description: '',
        installed: true,
        existingId: 'existing-mail',
      },
    ],
    selected: new Set(['mcp:0']),
    fills: {},
    options: {},
  };
  const props = () => ({
    choice,
    busy: false,
    onChange: (next: unknown) => {
      choice = next;
    },
    onInstall() {},
    onCancel() {},
  });
  let tree = h.render('ExtensionChoice', props());
  const mode = findNode(tree, (n) => n.type === 'select');
  assert.equal(mode?.props.value, 'add');
  assert.doesNotMatch(text(tree), /已安装，会更新/);
  mode?.props.onChange({ target: { value: 'replace' } });
  assert.equal(choice.options['mcp:0'].replaceId, 'existing-mail');
  tree = h.render('ExtensionChoice', props());
  findNode(tree, (n) => n.type === 'select')?.props.onChange({ target: { value: 'add' } });
  assert.equal(choice.options['mcp:0'].replaceId, undefined);
  h.unmount();
});

test('stdio installation uses the desktop channel and cancellation keeps the preview', async () => {
  for (const allow of [false, true]) {
    const changes: any[] = [],
      http: string[] = [];
    const h = uiHarness(code, {
      window: {
        addEventListener() {},
        removeEventListener() {},
        comboRunnerDesktop: {
          pickDirectory() {},
          async changePermission(change: unknown) {
            changes.push(JSON.parse(JSON.stringify(change)));
            return allow;
          },
        },
      },
    });
    const props = {
      section: 'connections',
      notify() {},
      api: async (path: string) => {
        http.push(path);
        if (path === '/api/app-info') return { tools: {} };
        if (path === '/api/tool-installations') return { installations: [] };
        if (path === '/api/extensions/preview')
          return {
            token: 'synthetic',
            drafts: [
              {
                key: 'mcp:0',
                kind: 'mcp',
                name: 'Synthetic',
                detail: 'synthetic-command one',
                origin: 'synthetic',
                description: '',
              },
            ],
          };
        return { items: [], catalog: [] };
      },
    };
    h.render('ExtensionsPage', props);
    await nextTurn();
    findNode(
      h.render('ExtensionsPage', props),
      (node) => node.type?.name === 'ExtensionCatalog' && 'busy' in node.props,
    )!.props.onInstall({
      id: 'synthetic',
    });
    await nextTurn();
    findNode(h.render('ExtensionsPage', props), (node) => node.type?.name === 'ExtensionChoice')!.props.onInstall();
    await nextTurn();
    assert.deepEqual(changes, [
      { kind: 'extension-command', action: 'install', token: 'synthetic', keys: ['mcp:0'], fills: {}, options: {} },
    ]);
    assert.equal(http.includes('/api/extensions/install'), false);
    assert.equal(
      !!findNode(h.render('ExtensionsPage', props), (node) => node.type?.name === 'ExtensionChoice'),
      !allow,
    );
    h.unmount();
  }
});

test('cancelled desktop connection save keeps entered values for retry', async () => {
  const h = uiHarness(code);
  const props = {
    item: {
      kind: 'mcp',
      id: 'synthetic',
      name: 'Synthetic',
      transport: 'stdio',
      command: 'synthetic',
      source: 'synthetic',
      enabled: true,
      env: { SYNTHETIC: true },
    },
    busy: false,
    onToggle() {},
    onRemove() {},
    onSave: async () => false,
  };
  editRow(h, props);
  findNode(
    h.render('InstalledRow', props),
    (node) => node.type === 'input' && node.props.type === 'password',
  )!.props.onChange({ target: { value: 'synthetic-value' } });
  button(h.render('InstalledRow', props), '保存连接').props.onClick();
  await nextTurn();
  assert.equal(
    findNode(h.render('InstalledRow', props), (node) => node.type === 'input' && node.props.type === 'password')!.props
      .value,
    'synthetic-value',
  );
  h.unmount();
});

test('connection settings can replace filled credentials and preserve fields omitted by the user', async () => {
  const h = uiHarness(code);
  const calls: any[] = [];
  const props = {
    item: {
      kind: 'mcp',
      id: 'mail',
      name: 'Personal',
      transport: 'http',
      url: 'https://example.invalid',
      source: 'MCP',
      enabled: true,
      headers: { Authorization: true, Other: true },
    },
    busy: false,
    onToggle() {},
    onRemove() {},
    onSave: async (...args: unknown[]) => {
      calls.push(args);
    },
    notify() {},
  };
  let tree = h.render('InstalledRow', props);
  editRow(h, props);
  tree = h.render('InstalledRow', props);
  const secret = findNode(tree, (n) => n.type === 'input' && n.props.type === 'password');
  assert.equal(secret?.props.value, '');
  assert.match(secret?.props.placeholder, /输入新值以替换/);
  secret?.props.onChange({ target: { value: 'fixture-new-value' } });
  tree = h.render('InstalledRow', props);
  button(tree, '保存连接').props.onClick();
  await nextTurn();
  assert.equal(calls[0][0], 'Personal');
  assert.equal(calls[0][1].Authorization, 'fixture-new-value');
  assert.equal(Object.keys(calls[0][1]).length, 1);
  tree = h.render('InstalledRow', props);
  assert.equal(
    findNode(tree, (n) => n.type === 'input' && n.props.type === 'password'),
    undefined,
  );
  editRow(h, props);
  tree = h.render('InstalledRow', props);
  assert.equal(findNode(tree, (n) => n.type === 'input' && n.props.type === 'password')?.props.value, '');
  h.unmount();
});

test('failed settings save retains the draft and makes the failure visible', async () => {
  const h = uiHarness(code, { Error });
  const notices: any[] = [];
  const props = {
    item: { kind: 'mcp', id: 'mail', name: 'Personal', transport: 'http', enabled: true, source: 'MCP', headers: {} },
    busy: false,
    onToggle() {},
    onRemove() {},
    onSave: async () => {
      throw new Error('duplicate name');
    },
    notify: (n: unknown) => notices.push(n),
  };
  let tree = h.render('InstalledRow', props);
  editRow(h, props);
  tree = h.render('InstalledRow', props);
  findNode(tree, (n) => n.type === 'input' && n.props['aria-label'] === 'Personal 连接名称')?.props.onChange({
    target: { value: 'School' },
  });
  tree = h.render('InstalledRow', props);
  button(tree, '保存连接').props.onClick();
  await nextTurn();
  tree = h.render('InstalledRow', props);
  assert.equal(
    findNode(tree, (n) => n.type === 'input' && n.props['aria-label'] === 'Personal 连接名称')?.props.value,
    'School',
  );
  assert.equal(notices[0].message, 'duplicate name');
  assert.equal(button(tree, '保存连接').props.disabled, false);
  h.unmount();
});

test('installed row menus match the extension kind and leave details free of duplicate actions', () => {
  for (const [item, labels] of [
    [
      { kind: 'mcp', id: 'tool', name: 'Tool', enabled: true, headers: { Token: false } },
      ['改名称和设置…', '重新检查', 'separator', '移除…'],
    ],
    [{ kind: 'skill', id: 'managed', name: 'Managed', enabled: true, managed: true }, ['删除…']],
    [{ kind: 'skill', id: 'imported', name: 'Imported', enabled: true, managed: false }, ['从 PugPort 移除…']],
  ] as const) {
    const h = uiHarness(code);
    const removed: unknown[] = [];
    const checked: unknown[] = [];
    const props = {
      item: { ...item, description: 'A complete description.' },
      busy: false,
      onToggle() {},
      onRemove: (value: unknown) => removed.push(value),
      onCheck: (value: unknown) => checked.push(value),
      onSave: async () => {},
    };
    const tree = h.render('InstalledRow', props);
    const row = findNode(tree, (node) => node.type?.name === 'SettingsRow')!;
    assert.equal(row.props.defaultExpanded, undefined);
    assert.match(text(row.props.children), /A complete description\./);
    assert.doesNotMatch(text(row.props.children), /卸载…|改名称和设置|重新检查/);
    const menu = rowMenu(h, props);
    assert.deepEqual(
      Array.from(menu.props.items, (entry: any) => (entry === 'separator' ? entry : entry.label)),
      [...labels],
    );
    const remove = menu.props.items.at(-1);
    assert.equal(remove.danger, true);
    remove.onSelect();
    assert.equal(removed[0], props.item);
    if (item.kind === 'mcp') {
      menu.props.items[1].onSelect();
      assert.equal(checked[0], props.item);
      button(h.render('InstalledRow', props), '补充设置').props.onClick();
      assert.ok(findNode(h.render('InstalledRow', props), (node) => node.type?.name === 'SideSheet'));
    }
    h.unmount();
  }
});

test('skill and MCP removal confirms the actual file effect and only deletes after confirmation', async () => {
  const confirmationCode = await uiBundle('tests/helpers/confirmation-fixture.ts');
  for (const [kind, managed, title, summary, action] of [
    ['skill', true, '删除技能「{0}」？', '会从 PugPort 删除它的文件夹；用过它的对话保留历史。', '删除'],
    ['skill', false, '从 PugPort 移除「{0}」？', '原文件夹留在原处。', '移除'],
    ['mcp', false, '移除「{0}」？', undefined, '移除'],
  ] as const) {
    const h = uiHarness(confirmationCode);
    const calls: { path: string; method?: string }[] = [];
    const item = { kind, managed, name: 'Fixture', id: 'fixture', enabled: true };
    const props = {
      section: kind === 'skill' ? 'skills' : 'connections',
      notify() {},
      api: async (path: string, _body: unknown, method?: string) => {
        calls.push({ path, method });
        if (path === '/api/app-info') return { tools: {} };
        if (path === '/api/tool-installations') return { installations: [] };
        return { items: [item], catalog: [] };
      },
    };
    h.render('ExtensionsPage', props);
    await nextTurn();
    const row = findNode(h.render('ExtensionsPage', props), (node) => node.type?.name === 'InstalledRow')!;
    for (const answer of [false, true]) {
      const pending = row.props.onRemove(item);
      const store = h.exports.confirmationStore;
      const request = store.snapshot();
      assert.equal(request.options.title, title);
      assert.equal(request.options.summary, summary);
      assert.equal(request.options.action, action);
      assert.equal(request.options.tone, 'danger');
      assert.deepEqual(Array.from(request.options.names), ['Fixture']);
      assert.equal(calls.filter((call) => call.method === 'DELETE').length, 0);
      store.resolve(request.id, answer);
      await pending;
      assert.equal(calls.filter((call) => call.method === 'DELETE').length, answer ? 1 : 0);
    }
    assert.equal(calls.find((call) => call.method === 'DELETE')?.path, '/api/extensions/fixture');
    h.unmount();
  }
});

test('adding extensions uses a sheet, clears its choice on close and follows the active section', async () => {
  const h = uiHarness(code);
  const props = {
    section: 'skills',
    notify() {},
    api: async (path: string) =>
      path === '/api/app-info'
        ? { tools: {} }
        : path === '/api/tool-installations'
          ? { installations: [] }
          : path === '/api/extensions/preview'
            ? { token: 'preview', drafts: [{ key: 'skill:0', kind: 'skill', name: 'Fixture' }] }
            : { items: [], catalog: [] },
  };
  h.render('ExtensionsPage', props);
  await nextTurn();
  button(h.render('ExtensionsPage', props), '添加 ▾').props.onClick();
  button(h.render('ExtensionsPage', props), '从链接或文件夹添加…').props.onClick();
  let tree = h.render('ExtensionsPage', props);
  const sheet = findNode(tree, (node) => node.type?.name === 'SideSheet')!;
  assert.equal(sheet.props.title, '添加扩展');
  assert.ok(findNode(sheet, (node) => node.type === 'textarea'));
  assert.doesNotMatch(text(sheet.props.children), /收起/);
  sheet.props.onClose();
  button(h.render('ExtensionsPage', props), '添加 ▾').props.onClick();
  button(h.render('ExtensionsPage', props), '从其他 AI 应用导入…').props.onClick();
  await nextTurn();
  tree = h.render('ExtensionsPage', props);
  // Cancel on the import results closes the sheet instead of falling back to the link form.
  findNode(tree, (node) => node.type?.name === 'ExtensionChoice')!.props.onCancel();
  assert.equal(
    findNode(h.render('ExtensionsPage', props), (node) => node.type?.name === 'SideSheet'),
    undefined,
  );
  tree = h.render('ExtensionsPage', { ...props, section: 'connections' });
  button(tree, '添加 ▾').props.onClick();
  button(h.render('ExtensionsPage', { ...props, section: 'connections' }), '添加 MCP 工具…');
  tree = h.render('ExtensionsPage', { ...props, section: 'components' });
  assert.equal(
    findNode(tree, (node) => node.type?.name === 'SettingsHeaderAction'),
    undefined,
  );
  h.unmount();
});

test('late previews cannot reopen an add sheet after closing or changing section', async () => {
  for (const source of ['input', 'imports', 'catalog']) {
    for (const dismiss of ['close', 'section', 'unmount']) {
      if (source === 'catalog' && dismiss === 'close') continue;
      const h = uiHarness(code);
      let resolvePreview!: (value: unknown) => void;
      const writes: string[] = [];
      const props = {
        section: 'connections',
        notify() {},
        api: async (path: string, _body: unknown, method?: string) => {
          if (path === '/api/app-info') return { tools: {} };
          if (path === '/api/tool-installations') return { installations: [] };
          if (path === '/api/extensions/preview')
            return new Promise((resolve) => {
              resolvePreview = resolve;
            });
          if (method !== 'GET') writes.push(path);
          return { items: [], catalog: [] };
        },
      };
      h.render('ExtensionsPage', props);
      await nextTurn();
      if (source === 'catalog') {
        findNode(h.render('ExtensionsPage', props), (node) => node.type?.name === 'ExtensionCatalog')!.props.onInstall({
          id: 'fixture',
        });
      } else {
        button(h.render('ExtensionsPage', props), '添加 ▾').props.onClick();
        if (source === 'imports') {
          button(h.render('ExtensionsPage', props), '从其他 AI 应用导入…').props.onClick();
          // While the scan runs the sheet says so, instead of showing the link form.
          const sheet = findNode(h.render('ExtensionsPage', props), (node) => node.type?.name === 'SideSheet')!;
          assert.match(text(sheet.props.children), /正在加载扩展/);
          assert.equal(
            findNode(sheet, (node) => node.type === 'textarea'),
            undefined,
          );
        } else {
          button(h.render('ExtensionsPage', props), '添加 MCP 工具…').props.onClick();
          findNode(h.render('ExtensionsPage', props), (node) => node.type === 'textarea')!.props.onChange({
            target: { value: 'https://example.invalid/fixture' },
          });
          button(h.render('ExtensionsPage', props), '查看').props.onClick();
        }
      }
      if (dismiss === 'close') {
        findNode(h.render('ExtensionsPage', props), (node) => node.type?.name === 'SideSheet')!.props.onClose();
      } else if (dismiss === 'section') {
        props.section = 'components';
        h.render('ExtensionsPage', props);
      } else h.unmount();
      resolvePreview({ token: 'late', drafts: [{ key: 'mcp:0', kind: 'mcp', name: 'Late' }] });
      await nextTurn();
      const tree = h.render('ExtensionsPage', props);
      assert.equal(
        findNode(tree, (node) => node.type?.name === 'ExtensionChoice'),
        undefined,
        `${source}: ${dismiss}`,
      );
      if (dismiss !== 'unmount')
        assert.equal(
          findNode(tree, (node) => node.type?.name === 'SideSheet'),
          undefined,
          `${source}: ${dismiss}`,
        );
      assert.deepEqual(writes, []);
      h.unmount();
    }
  }
});

test('a recommended skill with nothing to fill in still installs after switching tabs', async () => {
  const h = uiHarness(code);
  let resolvePreview!: (value: unknown) => void;
  const writes: string[] = [];
  const props = {
    section: 'connections',
    notify() {},
    api: async (path: string, _body: unknown, method?: string) => {
      if (path === '/api/app-info') return { tools: {} };
      if (path === '/api/tool-installations') return { installations: [] };
      if (path === '/api/extensions/preview')
        return new Promise((resolve) => {
          resolvePreview = resolve;
        });
      if (method !== 'GET') writes.push(path);
      return { items: [], catalog: [] };
    },
  };
  h.render('ExtensionsPage', props);
  await nextTurn();
  findNode(h.render('ExtensionsPage', props), (node) => node.type?.name === 'ExtensionCatalog')!.props.onInstall({
    id: 'fixture',
    title: 'Fixture',
  });
  props.section = 'skills';
  h.render('ExtensionsPage', props);
  resolvePreview({ token: 'late', drafts: [{ key: 'skill:0', kind: 'skill', name: 'Fixture' }] });
  await nextTurn();
  assert.deepEqual(writes, ['/api/extensions/install']);
  assert.equal(
    findNode(h.render('ExtensionsPage', props), (node) => node.type?.name === 'SideSheet'),
    undefined,
  );
  h.unmount();
});

test('optional reverse-direction tool connections use one explanation and neutral status', async () => {
  const h = uiHarness(await uiBundle('src/ui/AgentConnect.tsx'));
  const props = {
    api: async () => ({
      tools: [
        {
          id: 'codex',
          name: 'Codex',
          detected: true,
          state: 'absent',
          method: 'copy',
          manual: '{}',
          configPath: 'fixture',
          server: 'pugport',
        },
      ],
      snippet: '{}',
    }),
    notify() {},
  };
  h.render('AgentConnect', props);
  await nextTurn();
  const tree = h.render('AgentConnect', props);
  assert.equal(findNode(tree, (node) => node.type?.name === 'SettingsRow')!.props.title, '其他 AI 工具');
  assert.equal(
    text(findNode(tree, (node) => node.props.className === 'ext-section-note' && node.type === 'p')).trim(),
    '接入后，这些工具可以把任务交给 PugPort、查看 PugPort 的对话；PugPort 自己使用它们不需要这一步。',
  );
  assert.equal(text(findNode(tree, (node) => node.props.className === 'agent-connect-status')), '还没接入');
  assert.doesNotMatch(text(tree), /接入其他工具|接入只加一条/);
  h.unmount();
});

test('installed switches do not repeat state, while missing MCP settings expose setup', () => {
  const h = uiHarness(code);
  const props = {
    item: { id: 'synthetic', kind: 'mcp', name: 'Synthetic', enabled: true, env: { KEY: true } },
    busy: false,
    onToggle() {},
    onRemove() {},
    onSave: async () => {},
  };
  let tree = h.render('InstalledRow', props);
  const row = () => findNode(tree, (node) => node.type?.name === 'SettingsRow')!;
  assert.equal(row().props.status, undefined);
  assert.ok(findNode(tree, (node) => node.type === 'input' && node.props.type === 'checkbox'));
  assert.ok(button(tree, '管理'));
  tree = h.render('InstalledRow', { ...props, item: { ...props.item, env: { KEY: false } } });
  assert.match(row().props.status, /还差 1 项设置/);
  assert.equal(
    findNode(tree, (node) => node.type === 'input' && node.props.type === 'checkbox'),
    undefined,
  );
  button(tree, '开始设置').props.onClick();
  assert.ok(findNode(h.render('InstalledRow', props), (node) => node.type?.name === 'SideSheet'));
  h.unmount();
});
