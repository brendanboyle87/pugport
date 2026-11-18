import assert from 'node:assert/strict';
import test from 'node:test';
import { connectorCapabilities } from '../src/shared/connectors.ts';
import { findNode, nextTurn, uiBundle, uiHarness, type UiNode } from './helpers/ui-harness.ts';

const code = await uiBundle('src/ui/Connectors.tsx');
const panelCode = await uiBundle('src/ui/ConversationPanel.tsx');
const text = (node: unknown): string => {
  if (Array.isArray(node)) return node.map(text).join('');
  if (node && typeof node === 'object') return text((node as UiNode).props?.children);
  return typeof node === 'string' || typeof node === 'number' ? String(node) : '';
};
const button = (tree: unknown, label: string) => {
  const found = findNode(
    tree,
    (node) => node.type === 'button' && (text(node) === label || node.props['aria-label'] === label),
  );
  assert.ok(found, `Missing button ${label}`);
  return found;
};
const field = (tree: unknown, label: string) => {
  const found = findNode(tree, (node) => node.type === 'label' && text(node).startsWith(label));
  assert.ok(found, `Missing field ${label}`);
  const input = findNode(found, (node) => node.type === 'input');
  assert.ok(input, `Missing input ${label}`);
  return input;
};
const nodes = (tree: unknown, check: (node: UiNode) => boolean): UiNode[] => {
  if (Array.isArray(tree)) return tree.flatMap((child) => nodes(child, check));
  if (!tree || typeof tree !== 'object') return [];
  const node = tree as UiNode;
  return [...(check(node) ? [node] : []), ...nodes(node.props?.children, check)];
};
const account = (id: string, email: string, extra = {}) => ({
  id,
  email,
  alias: '我的 Gmail',
  provider: 'google',
  displayName: email,
  capabilities: ['mail_read'],
  status: 'connected',
  enabled: true,
  connectedAt: '2026-10-05T00:00:00Z',
  updatedAt: '2026-10-05T00:00:00Z',
  ...extra,
});
const data = (accounts: any[] = [], configured = true) => ({
  accounts,
  providers: [
    {
      provider: 'google',
      clientId: 'fixture-client',
      hasClientSecret: configured,
      configured,
      tenant: '',
      redirectUri: 'http://localhost:4317/api/connectors/oauth/callback',
    },
    {
      provider: 'microsoft',
      clientId: '',
      hasClientSecret: false,
      configured: false,
      tenant: 'common',
      redirectUri: 'http://localhost:4317/api/connectors/oauth/callback',
    },
  ],
});

test('discovery opens the requested provider with a unique alias without starting OAuth', async () => {
  const h = uiHarness(code);
  const calls: string[] = [];
  const props = {
    api: async (path: string) => {
      calls.push(path);
      return data([account('known', 'fixture@example.test', { provider: 'microsoft', alias: 'Microsoft 1' })]);
    },
    notify() {},
    connectRequest: { provider: 'microsoft', key: 1 },
  };
  h.render('ConnectorsPage', props);
  await nextTurn();
  const tree = h.render('ConnectorsPage', props);
  assert.equal(field(tree, '账号名称').props.value, 'Microsoft 2');
  assert.equal(button(tree, '连接 Microsoft').props.disabled, true);
  assert.ok(calls.every((path) => path === '/api/connectors'));
  h.unmount();
});

test('service cards group independent accounts and summarize their enabled permissions', async () => {
  const h = uiHarness(code);
  const props = {
    api: async () =>
      data([
        account('g-work', 'work@example.test', {
          alias: '工作 Gmail',
          capabilities: ['mail_read', 'files_read', 'sheets_write'],
        }),
        account('m-school', 'school@example.test', { provider: 'microsoft', alias: '学校 Outlook', enabled: false }),
        account('g-personal', 'personal@example.test', { alias: '个人 Gmail' }),
      ]),
    notify() {},
  };
  h.render('ConnectorsPage', props);
  await nextTurn();
  const tree = h.render('ConnectorsPage', props);
  const groups = nodes(tree, (node) => node.props.className === 'connector-provider-card');
  assert.equal(groups.length, 2);
  const google = groups.find((node) => node.props['aria-label'] === 'Google 连接账号')!;
  const microsoft = groups.find((node) => node.props['aria-label'] === 'Microsoft 连接账号')!;
  assert.equal(nodes(google, (node) => node.type === 'article').length, 2);
  assert.equal(nodes(microsoft, (node) => node.type === 'article').length, 1);
  assert.match(text(google), /工作 Gmail.*work@example\.test.*含写入权限.*个人 Gmail.*personal@example\.test.*只读/);
  assert.doesNotMatch(text(google), /school@example/);
  assert.match(text(microsoft), /学校 Outlook.*已停用/);
  assert.equal(
    nodes(tree, (node) => node.type === 'details' && node.props.className === 'connector-account-menu').length,
    3,
  );
  assert.equal(
    nodes(tree, (node) => node.type === 'summary' && String(node.props['aria-label']).startsWith('管理 ')).length,
    3,
  );
  h.unmount();
});

test('adding another account from a service card chooses its provider and a unique name without granting permissions', async () => {
  const h = uiHarness(code);
  const calls: string[] = [];
  const props = {
    api: async (path: string) => {
      calls.push(path);
      return data([
        account('g-one', 'g@example.test', { alias: 'Google 1' }),
        account('m-one', 'm@example.test', { provider: 'microsoft', alias: 'Ｍｉｃｒｏｓｏｆｔ  1' }),
      ]);
    },
    notify() {},
  };
  h.render('ConnectorsPage', props);
  await nextTurn();
  let tree = h.render('ConnectorsPage', props);
  button(tree, '连接另一个 Microsoft 账号').props.onClick();
  tree = h.render('ConnectorsPage', props);
  assert.equal(field(tree, '账号名称').props.value, 'Microsoft 2');
  assert.ok(
    findNode(
      tree,
      (node) =>
        node.type === 'label' &&
        text(node).includes('Microsoft') &&
        !!findNode(node, (input) => input.type === 'input' && input.props.type === 'radio' && input.props.checked),
    ),
  );
  assert.equal(button(tree, '连接 Microsoft').props.disabled, true, 'provider setup stays required');
  assert.equal(field(tree, '读取邮件').props.checked, true);
  assert.equal(field(tree, '编辑表格').props.checked, false);
  button(tree, '连接另一个 Google 账号').props.onClick();
  tree = h.render('ConnectorsPage', props);
  assert.equal(field(tree, '账号名称').props.value, 'Google 2');
  assert.equal(button(tree, '连接 Google').props.disabled, false);
  assert.ok(
    calls.every((path) => path === '/api/connectors'),
    'opening an account form never starts OAuth',
  );
  h.unmount();
});

test('continuing after an existing Microsoft account reconnect keeps the provider of that account', async () => {
  const h = uiHarness(code);
  let accounts = [
    {
      ...account('school', 'school@example.test', { provider: 'microsoft', alias: '学校' }),
      authorizationRevision: 'before',
    },
  ];
  const props = {
    api: async (path: string) =>
      path.endsWith('/connect')
        ? {
            authorizationUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?state=fixture',
            expiresAt: 'later',
          }
        : data(accounts),
    notify() {},
  };
  h.render('ConnectorsPage', props);
  await nextTurn();
  let tree = h.render('ConnectorsPage', props);
  button(tree, '重新授权').props.onClick();
  await nextTurn();
  tree = h.render('ConnectorsPage', props);
  accounts = [{ ...accounts[0]!, authorizationRevision: 'after' }];
  button(tree, '刷新连接器').props.onClick();
  await nextTurn();
  tree = h.render('ConnectorsPage', props);
  assert.match(text(tree), /已连接“学校”/);
  button(tree, '继续添加账号').props.onClick();
  tree = h.render('ConnectorsPage', props);
  assert.equal(field(tree, '账号名称').props.value, 'Microsoft 1');
  assert.ok(button(tree, '连接 Microsoft'));
  h.unmount();
});

test('an obsolete connector refresh cannot overwrite the newest account list', async () => {
  const pending: Array<(value: unknown) => void> = [];
  let onFocus: (() => void) | undefined;
  const h = uiHarness(code, {
    window: {
      addEventListener: (name: string, listener: () => void) => {
        if (name === 'focus') onFocus = listener;
      },
      removeEventListener() {},
    },
  });
  const props = { api: () => new Promise((resolve) => pending.push(resolve)), notify() {} };
  h.render('ConnectorsPage', props);
  onFocus!();
  pending[1]!(data([account('new', 'new@example.test', { alias: '最新工作账号' })]));
  await nextTurn();
  let tree = h.render('ConnectorsPage', props);
  assert.match(text(tree), /最新工作账号/);
  pending[0]!(data([account('old', 'old@example.test', { alias: '过期账号' })]));
  await nextTurn();
  tree = h.render('ConnectorsPage', props);
  assert.match(text(tree), /最新工作账号/);
  assert.doesNotMatch(text(tree), /过期账号/);
  h.unmount();
});

test('missing OAuth configuration appears before account fields and opens the matching settings without losing the draft', async () => {
  const h = uiHarness(code);
  const calls: string[] = [];
  const props = {
    api: async (path: string) => {
      calls.push(path);
      return data([], false);
    },
    notify() {},
    connectRequest: { provider: 'microsoft', key: 2 },
  };
  h.render('ConnectorsPage', props);
  await nextTurn();
  let tree = h.render('ConnectorsPage', props);
  const setupNotes = nodes(tree, (node) => node.props.className === 'connector-setup-note');
  assert.equal(setupNotes.length, 1, 'only one setup warning is shown');
  assert.match(text(setupNotes[0]), /首次连接 Microsoft/);
  const form = findNode(tree, (node) => node.props.className === 'connector-form')!;
  assert.ok(text(form).indexOf('首次连接 Microsoft') < text(form).indexOf('账号名称'));
  field(tree, '账号名称').props.onChange({ target: { value: '学校材料' } });
  field(tree, '读取云盘和文档').props.onChange({ target: { checked: true } });
  tree = h.render('ConnectorsPage', props);
  const callout = findNode(tree, (node) => node.props.className === 'connector-setup-note')!;
  button(callout, '授权设置').props.onClick();
  tree = h.render('ConnectorsPage', props);
  const settings = findNode(tree, (node) => node.type?.name === 'ProviderSettings')!;
  assert.equal(settings.props.provider, 'microsoft');
  assert.equal(field(tree, '账号名称').props.value, '学校材料');
  assert.equal(field(tree, '读取云盘和文档').props.checked, true);
  settings.props.onClose();
  tree = h.render('ConnectorsPage', props);
  assert.equal(field(tree, '账号名称').props.value, '学校材料');
  assert.equal(button(tree, '连接 Microsoft').props.disabled, true);
  assert.ok(calls.every((path) => path === '/api/connectors'));
  h.unmount();
});

test('connector setup requires configured OAuth, explicit alias and at least one permission', async () => {
  const h = uiHarness(code);
  const calls: unknown[] = [];
  const props = {
    api: async (...args: unknown[]) => {
      calls.push(args);
      return data([], false);
    },
    notify() {},
  };
  let tree = h.render('ConnectorsPage', props);
  await nextTurn();
  tree = h.render('ConnectorsPage', props);
  button(tree, '添加账号').props.onClick();
  tree = h.render('ConnectorsPage', props);
  assert.match(text(tree), /需要先配置应用的 OAuth 客户端/);
  assert.equal(button(tree, '连接 Google').props.disabled, true);
  assert.equal(field(tree, '读取邮件').props.checked, true);
  assert.equal(field(tree, '创建邮件草稿').props.checked, false);
  assert.equal(field(tree, '读取云盘和文档').props.checked, false);
  const checkboxes = nodes(tree, (node) => node.type === 'input' && node.props.type === 'checkbox');
  assert.equal(checkboxes.length, connectorCapabilities.length);
  assert.equal(checkboxes.filter((node) => node.props.checked).length, 1, 'new write permissions stay unchecked');
  assert.doesNotMatch(text(tree), /发送邮件权限/);
  assert.equal(
    calls.filter((call) => (call as unknown[])[2] !== 'GET').length,
    0,
    'opening setup does not start authorization or modify anything',
  );
  h.unmount();
});

test('selected permissions and alias are sent once; authorization only opens through an explicit link', async () => {
  const h = uiHarness(code);
  const calls: { path: string; body: any }[] = [];
  const props = {
    api: async (path: string, body: any) => {
      calls.push({ path, body });
      return path.endsWith('/connect')
        ? { authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=fixture', expiresAt: 'later' }
        : data();
    },
    notify() {},
  };
  h.render('ConnectorsPage', props);
  await nextTurn();
  let tree = h.render('ConnectorsPage', props);
  button(tree, '添加账号').props.onClick();
  tree = h.render('ConnectorsPage', props);
  field(tree, '账号名称').props.onChange({ target: { value: '  学校资料  ' } });
  field(tree, '读取云盘和文档').props.onChange({ target: { checked: true } });
  tree = h.render('ConnectorsPage', props);
  assert.equal(button(tree, '连接 Google').props.disabled, false);
  findNode(tree, (node) => node.type === 'form')?.props.onSubmit({ preventDefault() {} });
  await nextTurn();
  tree = h.render('ConnectorsPage', props);
  const request = calls.find((call) => call.path.endsWith('/connect'));
  assert.equal(request?.body.alias, '学校资料');
  assert.deepEqual([...request?.body.capabilities], ['mail_read', 'files_read']);
  const link = findNode(tree, (node) => node.type === 'a' && text(node).includes('打开 Google 授权'));
  assert.equal(link?.props.href, 'https://accounts.google.com/o/oauth2/v2/auth?state=fixture');
  assert.equal(link?.props.target, '_blank');
  assert.match(link?.props.rel, /noopener/);
  assert.equal(calls.filter((call) => call.path.endsWith('/connect')).length, 1);
  h.unmount();
});

test('permission groups expose every supported capability with explicit read or write access', async () => {
  const h = uiHarness(code);
  const calls: { path: string; body: any }[] = [];
  const props = {
    api: async (path: string, body: any) => {
      calls.push({ path, body });
      return path.endsWith('/connect')
        ? { authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=fixture', expiresAt: 'later' }
        : data();
    },
    notify() {},
  };
  h.render('ConnectorsPage', props);
  await nextTurn();
  let tree = h.render('ConnectorsPage', props);
  button(tree, '添加账号').props.onClick();
  tree = h.render('ConnectorsPage', props);
  const groups = nodes(tree, (node) => node.type === 'fieldset' && node.props.className === 'connector-permissions');
  assert.deepEqual(
    groups.map((node) => text(findNode(node, (child) => child.type === 'legend'))),
    ['邮件', '云盘、文档、表格和演示', '日历', '待办', '联系人'],
  );
  for (const group of groups) {
    for (const label of nodes(group, (node) => node.type === 'label')) {
      assert.match(text(label), /只读|写入/);
      const checkbox = findNode(label, (node) => node.type === 'input');
      assert.ok(checkbox);
      if (!checkbox.props.checked) checkbox.props.onChange({ target: { checked: true } });
    }
  }
  tree = h.render('ConnectorsPage', props);
  assert.match(text(tree), /每次写入都会先展示操作预览，确认后执行/);
  assert.match(text(tree), /PugPort 不提供发送邮件功能/);
  findNode(tree, (node) => node.type === 'form')?.props.onSubmit({ preventDefault() {} });
  await nextTurn();
  const payload = calls.find((call) => call.path.endsWith('/connect'))?.body;
  assert.deepEqual([...payload.capabilities].sort(), [...connectorCapabilities].sort());
  h.unmount();
});

test('existing accounts keep their permissions until their explicitly selected additions are reauthorized', async () => {
  const h = uiHarness(code);
  const calls: any[] = [];
  const existing = account('work', 'work@example.test', { capabilities: ['mail_read', 'files_read'] });
  const props = {
    api: async (...args: any[]) => {
      calls.push(args);
      return args[0].endsWith('/connect')
        ? { authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=fixture', expiresAt: 'later' }
        : data([existing]);
    },
    notify() {},
  };
  h.render('ConnectorsPage', props);
  await nextTurn();
  let tree = h.render('ConnectorsPage', props);
  button(tree, '调整 我的 Gmail 的权限').props.onClick();
  tree = h.render('ConnectorsPage', props);
  const groups = findNode(tree, (node) => node.props.className === 'connector-permission-groups');
  const selected = nodes(
    groups,
    (node) => node.type === 'label' && findNode(node, (child) => child.type === 'input')?.props.checked,
  );
  assert.equal(selected.length, 2);
  assert.equal(field(tree, '整理邮件').props.checked, false);
  assert.equal(field(tree, '编辑日程').props.checked, false);
  assert.match(text(tree), /现有账号保留原有权限，不会自动增加/);
  field(tree, '整理邮件').props.onChange({ target: { checked: true } });
  field(tree, '编辑日程').props.onChange({ target: { checked: true } });
  tree = h.render('ConnectorsPage', props);
  assert.equal(calls.filter((call) => call[2] !== 'GET').length, 0, 'checkboxes alone never change account grants');
  findNode(tree, (node) => node.type === 'form')?.props.onSubmit({ preventDefault() {} });
  await nextTurn();
  const request = calls.find((call) => call[0].endsWith('/connect'))?.[1];
  assert.equal(request.accountId, 'work');
  assert.deepEqual([...request.capabilities], ['mail_read', 'files_read', 'mail_manage', 'calendar_write']);
  assert.deepEqual(existing.capabilities, ['mail_read', 'files_read']);
  h.unmount();
});

test('provider guidance lists required Google APIs and Microsoft desktop OAuth and Office limits', async () => {
  const settings = uiHarness(code);
  const props = {
    provider: 'google',
    data: data(),
    api: async () => ({}),
    notify() {},
    onSaved: async () => {},
    onClose() {},
    onProvider() {},
  };
  let tree = settings.render('ProviderSettings', props);
  assert.match(text(tree), /Gmail、Drive、Docs、Sheets、Slides、Calendar、Tasks 和 People API/);
  settings.unmount();
  const microsoft = uiHarness(code);
  tree = microsoft.render('ProviderSettings', { ...props, provider: 'microsoft' });
  assert.match(text(tree), /移动和桌面应用/);
  assert.equal(
    findNode(tree, (node) => node.type === 'input' && node.props.type === 'password'),
    undefined,
  );
  microsoft.unmount();
  const page = uiHarness(code);
  const pageProps = { api: async () => data(), notify() {} };
  page.render('ConnectorsPage', pageProps);
  await nextTurn();
  tree = page.render('ConnectorsPage', pageProps);
  button(tree, '添加账号').props.onClick();
  tree = page.render('ConnectorsPage', pageProps);
  findNode(
    tree,
    (node) => node.type === 'input' && node.props.type === 'radio' && !node.props.checked,
  )?.props.onChange();
  tree = page.render('ConnectorsPage', pageProps);
  assert.match(text(tree), /Excel 工作簿接口仅支持企业 OneDrive \/ SharePoint/);
  assert.match(text(tree), /不支持个人 OneDrive/);
  assert.match(text(tree), /Word 和 PPTX 提供基础文本编辑/);
  assert.match(text(tree), /Excel 范围读取也要求 Files.ReadWrite 授权/);
  assert.match(text(tree), /只勾选“读取表格”时，PugPort 仍只开放读取工具/);
  assert.match(text(tree), /服务商授权页面的权限范围可能比这里的功能划分更宽/);
  page.unmount();
});

test('Microsoft Excel read selection does not grant local write tools despite the broader provider scope', async () => {
  const h = uiHarness(code);
  const calls: { path: string; body: any }[] = [];
  const fixture = data();
  fixture.providers[1]!.configured = true;
  const props = {
    api: async (path: string, body: any) => {
      calls.push({ path, body });
      return path.endsWith('/connect')
        ? {
            authorizationUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?state=fixture',
            expiresAt: 'later',
          }
        : fixture;
    },
    notify() {},
  };
  h.render('ConnectorsPage', props);
  await nextTurn();
  let tree = h.render('ConnectorsPage', props);
  button(tree, '添加账号').props.onClick();
  tree = h.render('ConnectorsPage', props);
  findNode(
    tree,
    (node) => node.type === 'input' && node.props.type === 'radio' && !node.props.checked,
  )?.props.onChange();
  tree = h.render('ConnectorsPage', props);
  field(tree, '读取邮件').props.onChange({ target: { checked: false } });
  field(tree, '读取表格').props.onChange({ target: { checked: true } });
  tree = h.render('ConnectorsPage', props);
  assert.equal(field(tree, '编辑表格').props.checked, false);
  assert.equal(field(tree, '管理云盘文件').props.checked, false);
  assert.equal(button(tree, '连接 Microsoft').props.disabled, false);
  findNode(tree, (node) => node.type === 'form')?.props.onSubmit({ preventDefault() {} });
  await nextTurn();
  const request = calls.find((call) => call.path.endsWith('/connect'))?.body;
  assert.equal(request.provider, 'microsoft');
  assert.deepEqual([...request.capabilities], ['sheets_read']);
  h.unmount();
});

test('provider settings never prefill secrets and omit blank secrets when saving existing settings', async () => {
  const h = uiHarness(code);
  const calls: any[] = [];
  const props = {
    provider: 'google',
    data: data(),
    api: async (...args: any[]) => {
      calls.push(args);
      return {};
    },
    notify() {},
    onSaved: async () => {},
    onClose() {},
    onProvider() {},
  };
  let tree = h.render('ProviderSettings', props);
  const secret = field(tree, 'Client secret');
  assert.equal(secret.props.type, 'password');
  assert.equal(secret.props.value, '');
  assert.equal(secret.props.required, false);
  findNode(tree, (node) => node.type === 'form')?.props.onSubmit({ preventDefault() {} });
  await nextTurn();
  assert.equal(calls[0][2], 'PUT');
  assert.equal(calls[0][1].clientId, 'fixture-client');
  assert.equal('clientSecret' in calls[0][1], false);
  tree = h.render('ProviderSettings', props);
  field(tree, 'Client secret').props.onChange({ target: { value: 'fixture-new-secret' } });
  tree = h.render('ProviderSettings', props);
  findNode(tree, (node) => node.type === 'form')?.props.onSubmit({ preventDefault() {} });
  await nextTurn();
  assert.equal(calls[1][1].clientSecret, 'fixture-new-secret');
  tree = h.render('ProviderSettings', props);
  assert.equal(field(tree, 'Client secret').props.value, '');
  h.unmount();
});

test('changing permissions reauthorizes the same account and invalidates older authorization links', async () => {
  const h = uiHarness(code);
  const calls: any[] = [];
  const props = {
    api: async (...args: any[]) => {
      calls.push(args);
      return args[0].endsWith('/connect')
        ? { authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=fixture', expiresAt: 'later' }
        : data([account('work', 'work@example.test')]);
    },
    notify() {},
  };
  h.render('ConnectorsPage', props);
  await nextTurn();
  let tree = h.render('ConnectorsPage', props);
  button(tree, '调整 我的 Gmail 的权限').props.onClick();
  tree = h.render('ConnectorsPage', props);
  assert.match(text(tree), /调整账号权限/);
  field(tree, '读取云盘和文档').props.onChange({ target: { checked: true } });
  tree = h.render('ConnectorsPage', props);
  findNode(tree, (node) => node.type === 'form')?.props.onSubmit({ preventDefault() {} });
  await nextTurn();
  tree = h.render('ConnectorsPage', props);
  const payload = calls.find((call) => call[0].endsWith('/connect'))?.[1];
  assert.equal(payload.accountId, 'work');
  assert.deepEqual([...payload.capabilities], ['mail_read', 'files_read']);
  assert.ok(findNode(tree, (node) => node.type === 'a' && text(node).includes('打开 Google 授权')));
  field(tree, '读取邮件').props.onChange({ target: { checked: false } });
  tree = h.render('ConnectorsPage', props);
  assert.equal(
    findNode(tree, (node) => node.type === 'a' && text(node).includes('打开 Google 授权')),
    undefined,
  );
  h.unmount();
});

test('same provider and alias remain independent accounts; unavailable accounts cannot become selected', async () => {
  const h = uiHarness(code);
  const values: string[][] = [];
  const props = {
    api: async () =>
      data([
        account('work', 'work@example.test'),
        account('personal', 'personal@example.test'),
        account('expired', 'old@example.test', { status: 'reauth_required' }),
      ]),
    value: [],
    onChange: (ids: string[]) => values.push(ids),
    inline: true,
  };
  h.render('ConnectorPicker', props);
  await nextTurn();
  const tree = h.render('ConnectorPicker', props);
  const row = (email: string) => findNode(tree, (node) => node.type === 'label' && text(node).includes(email));
  const work = findNode(row('work@example.test'), (node) => node.type === 'input');
  const personal = findNode(row('personal@example.test'), (node) => node.type === 'input');
  const expired = findNode(row('old@example.test'), (node) => node.type === 'input');
  assert.equal(work?.props.checked, false);
  assert.equal(personal?.props.checked, false);
  assert.equal(expired?.props.disabled, true);
  personal?.props.onChange({ target: { checked: true } });
  assert.deepEqual([...values[0]!], ['personal']);
  assert.equal(values.length, 1, 'no account is automatically granted on load');
  h.unmount();
});

test('connector accounts require an explicit disconnect confirmation and target the account id', async () => {
  const h = uiHarness(code);
  const calls: any[] = [];
  const props = {
    api: async (...args: any[]) => {
      calls.push(args);
      return data([account('account/one', 'first@example.test')]);
    },
    notify() {},
  };
  h.render('ConnectorsPage', props);
  await nextTurn();
  let tree = h.render('ConnectorsPage', props);
  button(tree, '断开 我的 Gmail').props.onClick();
  tree = h.render('ConnectorsPage', props);
  assert.match(text(tree), /邮箱和云文件会保留/);
  assert.equal(calls.filter((call) => call[2] !== 'GET').length, 0);
  button(tree, '断开连接').props.onClick();
  await nextTurn();
  const removal = calls.find((call) => call[2] === 'DELETE');
  assert.equal(removal?.[0], '/api/connectors/account%2Fone');
  h.unmount();
});

test('authorization links reject unexpected hosts, userinfo, non-HTTPS and misleading suffixes', () => {
  const h = uiHarness(code);
  const check = h.exports.connectorAuthorizationUrl;
  assert.equal(
    check('https://login.microsoftonline.com/common/oauth2/v2.0/authorize', 'microsoft'),
    'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
  );
  for (const url of [
    'https://accounts.google.com.bad.test/',
    'http://accounts.google.com/',
    'javascript:alert(1)',
    'https://user:pass@accounts.google.com/',
    'https://accounts.google.com:4000/',
  ])
    assert.throws(() => check(url, 'google'));
  assert.throws(() => check('https://accounts.google.com/', 'microsoft'));
});

test('aliases use unique normalized names, with automatic suggestions that preserve manual edits', async () => {
  const h = uiHarness(code);
  const existing = account('one', 'one@example.test', { alias: 'ＧＯＯＧＬＥ  1' });
  const props = { api: async () => data([existing]), notify() {} };
  h.render('ConnectorsPage', props);
  await nextTurn();
  let tree = h.render('ConnectorsPage', props);
  button(tree, '添加账号').props.onClick();
  tree = h.render('ConnectorsPage', props);
  assert.equal(field(tree, '账号名称').props.value, 'Google 2');
  findNode(
    tree,
    (node) => node.type === 'input' && node.props.type === 'radio' && node.props.checked === false,
  )?.props.onChange();
  tree = h.render('ConnectorsPage', props);
  assert.equal(field(tree, '账号名称').props.value, 'Microsoft 1');
  field(tree, '账号名称').props.onChange({ target: { value: '研究邮件' } });
  tree = h.render('ConnectorsPage', props);
  findNode(
    tree,
    (node) => node.type === 'input' && node.props.type === 'radio' && node.props.checked === false,
  )?.props.onChange();
  tree = h.render('ConnectorsPage', props);
  assert.equal(field(tree, '账号名称').props.value, '研究邮件');
  field(tree, '账号名称').props.onChange({ target: { value: '  google 1 ' } });
  tree = h.render('ConnectorsPage', props);
  assert.equal(button(tree, '连接 Google').props.disabled, true);
  assert.equal(field(tree, '账号名称').props['aria-invalid'], true);
  assert.match(text(tree), /已有同名连接器/);
  h.unmount();
});

test('returning from authorization clears the old link and allows adding another account without sign-out', async () => {
  const h = uiHarness(code);
  let accounts: any[] = [];
  const props = {
    api: async (path: string) =>
      path.endsWith('/connect')
        ? { authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=fixture', expiresAt: 'later' }
        : data(accounts),
    notify() {},
  };
  h.render('ConnectorsPage', props);
  await nextTurn();
  let tree = h.render('ConnectorsPage', props);
  button(tree, '添加账号').props.onClick();
  tree = h.render('ConnectorsPage', props);
  findNode(tree, (node) => node.type === 'form')?.props.onSubmit({ preventDefault() {} });
  await nextTurn();
  tree = h.render('ConnectorsPage', props);
  assert.match(text(tree), /可选择其他账号，无需退出已连接账号/);
  accounts = [account('one', 'one@example.test', { alias: 'Google 1' })];
  button(tree, '刷新连接器').props.onClick();
  await nextTurn();
  tree = h.render('ConnectorsPage', props);
  assert.match(text(tree), /已连接“Google 1”/);
  assert.equal(
    findNode(tree, (node) => node.type === 'a' && text(node).includes('打开 Google 授权')),
    undefined,
  );
  assert.equal(
    findNode(tree, (node) => node.type === 'form'),
    undefined,
  );
  button(tree, '继续添加账号').props.onClick();
  tree = h.render('ConnectorsPage', props);
  assert.equal(field(tree, '账号名称').props.value, 'Google 2');
  h.unmount();
});

test('editing account metadata never masquerades as completed reauthorization', async () => {
  const h = uiHarness(code);
  let accounts = [{ ...account('work', 'work@example.test'), authorizationRevision: 'original' }];
  const props = {
    api: async (path: string) =>
      path.endsWith('/connect')
        ? { authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=fixture', expiresAt: 'later' }
        : data(accounts),
    notify() {},
  };
  h.render('ConnectorsPage', props);
  await nextTurn();
  let tree = h.render('ConnectorsPage', props);
  button(tree, '重新授权').props.onClick();
  await nextTurn();
  tree = h.render('ConnectorsPage', props);
  accounts = [{ ...accounts[0]!, updatedAt: '2026-10-05T01:00:00Z' }];
  button(tree, '刷新连接器').props.onClick();
  await nextTurn();
  tree = h.render('ConnectorsPage', props);
  assert.ok(
    findNode(tree, (node) => node.type === 'a' && text(node).includes('打开 Google 授权')),
    'ordinary metadata updates must not complete OAuth',
  );
  accounts = [{ ...accounts[0]!, authorizationRevision: 'new-oauth-callback' }];
  button(tree, '刷新连接器').props.onClick();
  await nextTurn();
  tree = h.render('ConnectorsPage', props);
  assert.equal(
    findNode(tree, (node) => node.type === 'a' && text(node).includes('打开 Google 授权')),
    undefined,
  );
  assert.match(text(tree), /已连接“我的 Gmail”/);
  h.unmount();
});

test('conversation connector selection persists only after a successful save and never selects all by default', async () => {
  const h = uiHarness(panelCode, { Error });
  let failing = true;
  const calls: any[] = [],
    notices: any[] = [];
  const props = {
    conversation: { id: 'conversation/fixture' },
    api: async (...args: any[]) => {
      calls.push(args);
      if (failing) throw new Error('save failed');
      return {};
    },
    notify: (value: any) => notices.push(value),
  };
  let tree = h.render('ConversationConnectors', props);
  const picker = () =>
    findNode(tree, (node) => typeof node.type === 'function' && node.type.name === 'ConnectorPicker');
  assert.equal(picker()?.props.value.length, 0);
  picker()?.props.onChange(['work']);
  await nextTurn();
  tree = h.render('ConversationConnectors', props);
  assert.equal(picker()?.props.value.length, 0);
  assert.equal(notices[0].message, 'save failed');
  failing = false;
  picker()?.props.onChange(['work']);
  await nextTurn();
  tree = h.render('ConversationConnectors', props);
  assert.deepEqual([...picker()?.props.value], ['work']);
  assert.equal(calls[1][0], '/api/conversations/conversation%2Ffixture/connectors');
  assert.equal(calls[1][2], 'PATCH');
  assert.deepEqual([...calls[1][1].connectorIds], ['work']);
  h.unmount();
});
