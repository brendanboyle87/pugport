import { connectorsEnabled } from '../shared/connectors';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  Check,
  CalendarDays,
  ChevronDown,
  ContactRound,
  Copy,
  ExternalLink,
  FileText,
  Loader2,
  ListTodo,
  Mail,
  MoreHorizontal,
  Pencil,
  Plug,
  Plus,
  RefreshCw,
  Settings2,
  Trash2,
  X,
} from 'lucide-react';
import type {
  ConnectorAccount,
  ConnectorCapability,
  ConnectorProvider,
  ConnectorProviderConfigView,
} from '../shared/connectors';
import type { Api, Notice } from './Workspace';
import { withNames } from './i18n';

type Notify = (notice: Notice) => void;
type ConnectorData = { accounts: ConnectorAccount[]; providers: ConnectorProviderConfigView[]; redirectUri?: string };
const providerName = (provider: ConnectorProvider) => (provider === 'google' ? 'Google' : 'Microsoft');
const capabilityGroups: {
  label: string;
  icon: typeof Mail;
  items: { value: ConnectorCapability; label: string; description: string; access: 'read' | 'write' }[];
}[] = [
  {
    label: '邮件',
    icon: Mail,
    items: [
      { value: 'mail_read', label: '读取邮件', description: '搜索和阅读 Gmail 或 Outlook 邮件。', access: 'read' },
      {
        value: 'mail_draft',
        label: '创建邮件草稿',
        description: '写入草稿，由你到邮箱中检查和发送。',
        access: 'write',
      },
      {
        value: 'mail_manage',
        label: '整理邮件',
        description: '管理标签或文件夹、标记已读、归档和移入回收站。',
        access: 'write',
      },
    ],
  },
  {
    label: '云盘、文档、表格和演示',
    icon: FileText,
    items: [
      {
        value: 'files_read',
        label: '读取云盘和文档',
        description: '搜索云盘文件，读取支持的文档正文和文件信息。',
        access: 'read',
      },
      { value: 'files_write', label: '管理云盘文件', description: '创建、更新和移动文件及文件夹。', access: 'write' },
      {
        value: 'documents_write',
        label: '编辑文档',
        description: '创建文档和编辑正文；Word 支持基础文本操作。',
        access: 'write',
      },
      {
        value: 'sheets_read',
        label: '读取表格',
        description: '读取 Google Sheets 或 Excel 工作簿中的表格数据。',
        access: 'read',
      },
      { value: 'sheets_write', label: '编辑表格', description: '创建表格和写入单元格数据。', access: 'write' },
      {
        value: 'slides_read',
        label: '读取演示文稿',
        description: '读取 Google Slides 或 PowerPoint 中的文本。',
        access: 'read',
      },
      {
        value: 'slides_write',
        label: '编辑演示文稿',
        description: '创建演示文稿和编辑文本；PPTX 支持基础文本操作。',
        access: 'write',
      },
    ],
  },
  {
    label: '日历',
    icon: CalendarDays,
    items: [
      { value: 'calendar_read', label: '读取日历', description: '查看日历和日程。', access: 'read' },
      { value: 'calendar_write', label: '编辑日程', description: '创建、修改和删除日程。', access: 'write' },
    ],
  },
  {
    label: '待办',
    icon: ListTodo,
    items: [
      {
        value: 'tasks_read',
        label: '读取待办',
        description: '查看 Google Tasks 或 Microsoft To Do 清单和任务。',
        access: 'read',
      },
      { value: 'tasks_write', label: '编辑待办', description: '创建、修改、完成和删除待办任务。', access: 'write' },
    ],
  },
  {
    label: '联系人',
    icon: ContactRound,
    items: [
      { value: 'contacts_read', label: '读取联系人', description: '搜索和查看联系人资料。', access: 'read' },
      { value: 'contacts_write', label: '编辑联系人', description: '创建、修改和删除联系人。', access: 'write' },
    ],
  },
];
const capabilities = capabilityGroups.flatMap((group) => group.items);
const capabilityName = (value: ConnectorCapability) =>
  capabilities.find((item) => item.value === value)?.label ?? value;
const accountServices = (account: ConnectorAccount) =>
  [
    { label: '邮件', values: ['mail_read', 'mail_draft', 'mail_manage'] },
    { label: '云盘', values: ['files_read', 'files_write'] },
    { label: '文档', values: ['files_read', 'documents_write'] },
    { label: '表格', values: ['sheets_read', 'sheets_write'] },
    { label: '演示', values: ['slides_read', 'slides_write'] },
    { label: '日历', values: ['calendar_read', 'calendar_write'] },
    { label: '待办', values: ['tasks_read', 'tasks_write'] },
    { label: '联系人', values: ['contacts_read', 'contacts_write'] },
  ]
    .filter((service) => service.values.some((value) => account.capabilities.includes(value as ConnectorCapability)))
    .map((service) => service.label);
const accountWrites = (account: ConnectorAccount) =>
  capabilities.some((item) => item.access === 'write' && account.capabilities.includes(item.value));
const accountInitial = (account: ConnectorAccount) =>
  Array.from((account.displayName || account.alias || account.email).trim())[0]?.toUpperCase() ?? '?';
const failure = (error: unknown) => (error instanceof Error ? error.message : '连接器操作失败，请重试。');
export const connectorAliasKey = (value: string) => value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
export function suggestedConnectorAlias(provider: ConnectorProvider, accounts: ConnectorAccount[]) {
  const used = new Set(accounts.map((account) => connectorAliasKey(account.alias)));
  let suffix = 1;
  while (used.has(connectorAliasKey(`${providerName(provider)} ${suffix}`))) suffix++;
  return `${providerName(provider)} ${suffix}`;
}

export function connectorAuthorizationUrl(raw: string, provider: ConnectorProvider) {
  const url = new URL(raw);
  const expected = provider === 'google' ? 'accounts.google.com' : 'login.microsoftonline.com';
  if (
    url.protocol !== 'https:' ||
    url.hostname !== expected ||
    url.username ||
    url.password ||
    (url.port && url.port !== '443')
  )
    throw new Error('授权地址无效，请重新连接。');
  return url.href;
}

export function ConnectorsPage({
  api,
  notify,
  connectRequest,
}: {
  api: Api;
  notify: Notify;
  connectRequest?: { provider: ConnectorProvider; key: number };
}) {
  const [data, setData] = useState<ConnectorData>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [adding, setAdding] = useState(false);
  const [editingAccountId, setEditingAccountId] = useState<string>();
  const [provider, setProvider] = useState<ConnectorProvider>('google');
  const [alias, setAlias] = useState('');
  const [aliasEdited, setAliasEdited] = useState(false);
  const [completedAlias, setCompletedAlias] = useState<string>();
  const [completedProvider, setCompletedProvider] = useState<ConnectorProvider>('google');
  const [permissions, setPermissions] = useState<ConnectorCapability[]>(['mail_read']);
  const [settings, setSettings] = useState<ConnectorProvider>();
  const [rename, setRename] = useState<{ id: string; alias: string }>();
  const [removing, setRemoving] = useState<string>();
  const [authorization, setAuthorization] = useState<{
    url: string;
    provider: ConnectorProvider;
    alias: string;
    capabilities: ConnectorCapability[];
    accountId?: string;
    previousAuthorizationRevision?: string;
    knownIds: string[];
    expiresAt: string;
  }>();
  const uid = useId();
  const pageRef = useRef<HTMLElement>(null);
  const aliasRef = useRef<HTMLInputElement>(null);
  const sequence = useRef(0);
  const handledRequest = useRef<number | undefined>(undefined);
  const load = useCallback(async () => {
    const current = ++sequence.current;
    try {
      const next = await api<ConnectorData>('/api/connectors', undefined, 'GET');
      if (current !== sequence.current) return;
      setData(next);
      setError('');
    } catch (reason) {
      if (current !== sequence.current) return;
      setError(failure(reason));
      throw reason;
    }
  }, [api]);
  useEffect(() => {
    const refresh = () => void load().catch(() => undefined);
    refresh();
    window.addEventListener('focus', refresh);
    return () => {
      sequence.current++;
      window.removeEventListener('focus', refresh);
    };
  }, [load]);
  useEffect(() => {
    const closeMenus = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest('.connector-account-menu')) return;
      pageRef.current
        ?.querySelectorAll('.connector-account-menu[open]')
        .forEach((menu) => menu.removeAttribute('open'));
    };
    window.addEventListener('pointerdown', closeMenus);
    return () => window.removeEventListener('pointerdown', closeMenus);
  }, []);
  useEffect(() => {
    if (!adding) return;
    aliasRef.current?.closest('form')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    aliasRef.current?.focus({ preventScroll: true });
  }, [adding]);
  useEffect(() => {
    if (!connectRequest || !data || handledRequest.current === connectRequest.key) return;
    handledRequest.current = connectRequest.key;
    setProvider(connectRequest.provider);
    setAdding(true);
    setEditingAccountId(undefined);
    setAlias(suggestedConnectorAlias(connectRequest.provider, data.accounts));
    setAliasEdited(false);
    setCompletedAlias(undefined);
    setPermissions(['mail_read']);
    setAuthorization(undefined);
  }, [connectRequest, data]);
  useEffect(() => {
    if (!authorization || !data) return;
    const connected = data.accounts.find(
      (account) =>
        account.provider === authorization.provider &&
        account.status === 'connected' &&
        (authorization.accountId
          ? account.id === authorization.accountId &&
            !!account.authorizationRevision &&
            account.authorizationRevision !== authorization.previousAuthorizationRevision
          : !authorization.knownIds.includes(account.id) &&
            connectorAliasKey(account.alias) === connectorAliasKey(authorization.alias)),
    );
    if (!connected) return;
    setAuthorization(undefined);
    setAdding(false);
    setEditingAccountId(undefined);
    setCompletedAlias(connected.alias);
    setCompletedProvider(connected.provider);
  }, [data, authorization]);
  useEffect(() => {
    if (!authorization) return;
    const expires = Date.parse(authorization.expiresAt);
    if (!Number.isFinite(expires)) return;
    const timer = setTimeout(
      () => {
        setAuthorization(undefined);
        setError('授权链接已过期，请重新连接。');
      },
      // A delay past setTimeout's 32-bit limit would fire at once and expire a valid link.
      Math.min(2 ** 31 - 1, Math.max(0, expires - Date.now())),
    );
    return () => clearTimeout(timer);
  }, [authorization]);
  const run = async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    setError('');
    try {
      await action();
    } catch (reason) {
      const message = failure(reason);
      setError(message);
      notify({ tone: 'error', message });
    } finally {
      setBusy('');
    }
  };
  const connect = (account?: ConnectorAccount) =>
    run(account?.id ?? 'connect', async () => {
      setAuthorization(undefined);
      setCompletedAlias(undefined);
      const chosen = account?.provider ?? provider;
      const accountId = account?.id ?? editingAccountId;
      const requestedAlias = account?.alias ?? alias.trim();
      if (!requestedAlias || !(account?.capabilities ?? permissions).length)
        throw new Error('请填写账号名称并选择至少一项权限。');
      if (
        data?.accounts.some(
          (item) => item.id !== accountId && connectorAliasKey(item.alias) === connectorAliasKey(requestedAlias),
        )
      )
        throw new Error('已有同名连接器，请换一个账号名称。');
      const { authorizationUrl, expiresAt } = await api<{ authorizationUrl: string; expiresAt: string }>(
        '/api/connectors/connect',
        {
          provider: chosen,
          alias: requestedAlias,
          capabilities: account?.capabilities ?? permissions,
          ...(account?.id || editingAccountId ? { accountId: account?.id ?? editingAccountId } : {}),
        },
      );
      setAuthorization({
        url: connectorAuthorizationUrl(authorizationUrl, chosen),
        provider: chosen,
        alias: account?.alias ?? alias.trim(),
        capabilities: account?.capabilities ?? [...permissions],
        accountId,
        previousAuthorizationRevision: data?.accounts.find((item) => item.id === accountId)?.authorizationRevision,
        knownIds: data?.accounts.map((item) => item.id) ?? [],
        expiresAt,
      });
    });
  const addAccount = (chosen: ConnectorProvider = provider) => {
    setProvider(chosen);
    setAdding(true);
    setEditingAccountId(undefined);
    setAlias(suggestedConnectorAlias(chosen, data?.accounts ?? []));
    setAliasEdited(false);
    setCompletedAlias(undefined);
    setPermissions(['mail_read']);
    setAuthorization(undefined);
  };
  const configured = data?.providers.find((item) => item.provider === provider)?.configured;
  const duplicateAlias = !!data?.accounts.some(
    (item) => item.id !== editingAccountId && connectorAliasKey(item.alias) === connectorAliasKey(alias),
  );
  const renameDuplicate =
    !!rename &&
    !!data?.accounts.some(
      (item) => item.id !== rename.id && connectorAliasKey(item.alias) === connectorAliasKey(rename.alias),
    );

  return (
    <section className="connectors-page" aria-label="连接器账号" ref={pageRef}>
      <div className="connectors-heading">
        <div>
          <h2>连接器</h2>
          <p>
            连接邮件、云盘、文档、表格、演示、日历、待办和联系人。一个服务可以连接多个账号，分别命名；在对话中选择要使用的账号。
          </p>
        </div>
        <div className="connector-actions">
          <button type="button" className="button quiet" onClick={() => setSettings(settings ? undefined : provider)}>
            <Settings2 size={14} />
            授权设置
          </button>
          <button
            type="button"
            className="button secondary"
            disabled={!!busy}
            onClick={() => void run('refresh', load)}
            aria-label="刷新连接器"
          >
            <RefreshCw size={14} className={busy === 'refresh' ? 'spinning' : ''} />
          </button>
          <button type="button" className="button primary" disabled={!!busy} onClick={() => addAccount()}>
            <Plus size={14} />
            添加账号
          </button>
        </div>
      </div>
      {error && (
        <div className="connector-error" role="alert">
          {error}
          <span>学校或公司账号若要求管理员批准，请联系管理员授权此应用。</span>
        </div>
      )}
      {!data && !error && (
        <p className="connector-note" role="status">
          <Loader2 size={14} className="spinning" />
          正在加载连接器…
        </p>
      )}
      {completedAlias && (
        <div className="connector-authorization" role="status">
          <div>
            <strong translate="no">{withNames('已连接“{0}”', [completedAlias])}</strong>
            <p>可以继续添加其他账号，然后在对话中按名称选择。</p>
          </div>
          <button type="button" className="button secondary" onClick={() => addAccount(completedProvider)}>
            <Plus size={14} />
            继续添加账号
          </button>
        </div>
      )}
      {settings && data && (
        <ProviderSettings
          key={settings}
          provider={settings}
          data={data}
          api={api}
          notify={notify}
          onClose={() => setSettings(undefined)}
          onSaved={load}
          onProvider={setSettings}
        />
      )}
      {adding && (
        <form
          className="connector-form"
          onSubmit={(event) => {
            event.preventDefault();
            void connect();
          }}
        >
          <div className="connector-form-heading">
            <h3>{editingAccountId ? '调整账号权限' : '添加连接账号'}</h3>
            <button className="icon-button" type="button" aria-label="关闭添加账号" onClick={() => setAdding(false)}>
              <X size={16} />
            </button>
          </div>
          <fieldset className="connector-provider-options">
            <legend>选择服务</legend>
            {(['google', 'microsoft'] as const).map((item) => (
              <label key={item} className={provider === item ? 'selected' : ''}>
                <input
                  type="radio"
                  name={`${uid}-provider`}
                  checked={provider === item}
                  disabled={!!editingAccountId || !!busy}
                  onChange={() => {
                    setProvider(item);
                    if (!aliasEdited) setAlias(suggestedConnectorAlias(item, data?.accounts ?? []));
                    setAuthorization(undefined);
                  }}
                />
                <Mail size={18} />
                <span>
                  <strong>{providerName(item)}</strong>
                  <small>{item === 'google' ? 'Gmail · Google Workspace' : 'Outlook · Microsoft 365'}</small>
                </span>
              </label>
            ))}
          </fieldset>
          {data && !configured && (
            <div className="connector-setup-note" role="note">
              <Settings2 size={16} />
              <span>
                首次连接 {providerName(provider)}，需要先配置应用的 OAuth 客户端，再登录账号授权。同一服务只需配置一次。
              </span>
              <button type="button" className="button secondary tiny" onClick={() => setSettings(provider)}>
                授权设置
              </button>
            </div>
          )}
          <label className="connector-field" htmlFor={`${uid}-alias`}>
            账号名称
            <input
              id={`${uid}-alias`}
              ref={aliasRef}
              value={alias}
              maxLength={80}
              required
              placeholder="例如：工作邮箱、学校邮箱、个人文档"
              disabled={!!busy}
              aria-invalid={duplicateAlias || undefined}
              aria-describedby={duplicateAlias ? `${uid}-alias-error` : undefined}
              onChange={(event) => {
                setAlias(event.target.value);
                setAliasEdited(true);
                setAuthorization(undefined);
              }}
            />
            {duplicateAlias && (
              <small className="connector-alias-error" id={`${uid}-alias-error`}>
                已有同名连接器，请换一个账号名称。
              </small>
            )}
          </label>
          <div className="connector-permission-groups" role="group" aria-label="允许 PugPort 做什么">
            {capabilityGroups.map((group) => (
              <fieldset className="connector-permissions" key={group.label}>
                <legend>
                  <group.icon size={14} />
                  {group.label}
                </legend>
                {group.items.map((item) => (
                  <label key={item.value}>
                    <input
                      type="checkbox"
                      checked={permissions.includes(item.value)}
                      disabled={!!busy}
                      onChange={(event) => {
                        setAuthorization(undefined);
                        setPermissions((values) =>
                          event.target.checked
                            ? [...values, item.value]
                            : values.filter((value) => value !== item.value),
                        );
                      }}
                    />
                    <span>
                      <strong>
                        {item.label}
                        <span className={`connector-permission-access ${item.access}`}>
                          {item.access === 'read' ? '只读' : '写入'}
                        </span>
                      </strong>
                      <small>{item.description}</small>
                    </span>
                  </label>
                ))}
              </fieldset>
            ))}
          </div>
          <p className="connector-note">
            现有账号保留原有权限，不会自动增加。调整权限后需要重新授权；每次写入都会先展示操作预览，确认后执行。
          </p>
          <p className="connector-note">
            服务商授权页面的权限范围可能比这里的功能划分更宽；PugPort 仍只开放你勾选的功能。
          </p>
          <p className="connector-note">编辑现有内容时，请同时选择对应的读取权限，便于先查看原内容和核对修改。</p>
          {provider === 'microsoft' && (
            <>
              <p className="connector-note">
                Microsoft 的 Excel 范围读取也要求 Files.ReadWrite 授权；只勾选“读取表格”时，PugPort 仍只开放读取工具。
              </p>
              <p className="connector-note">
                Excel 工作簿接口仅支持企业 OneDrive / SharePoint 中的文件，不支持个人 OneDrive。Word 和 PPTX
                提供基础文本编辑，不是完整富文本或版式编辑器。
              </p>
            </>
          )}
          {(permissions.includes('mail_draft') || permissions.includes('mail_manage')) && (
            <p className="connector-note">
              {provider === 'google'
                ? 'Google 的草稿和邮件管理授权范围也包含发送能力；PugPort 不提供发送邮件功能。'
                : 'Microsoft 的草稿和邮件管理授权使用邮件读写权限；PugPort 不申请发送邮件权限。'}
            </p>
          )}
          <div className="connector-form-footer">
            <span>新连接不会自动共享给所有对话。</span>
            <button
              type="submit"
              className="button primary"
              disabled={!!busy || !configured || !alias.trim() || !permissions.length || duplicateAlias}
            >
              {busy === 'connect' ? <Loader2 size={14} className="spinning" /> : <Plug size={14} />}连接{' '}
              {providerName(provider)}
            </button>
          </div>
        </form>
      )}
      {authorization && (
        <div className="connector-authorization" role="status">
          <div>
            <strong translate="no">{withNames('为“{0}”完成授权', [authorization.alias])}</strong>
            <p>在浏览器中选择账号并核对权限，完成后回到这里刷新。</p>
            <p>可选择其他账号，无需退出已连接账号。</p>
            <p>{authorization.capabilities.map(capabilityName).join(' · ')}</p>
          </div>
          <a className="button primary" href={authorization.url} target="_blank" rel="noopener noreferrer">
            打开 {providerName(authorization.provider)} 授权
            <ExternalLink size={14} />
          </a>
          <button
            type="button"
            className="icon-button"
            aria-label="关闭授权提示"
            onClick={() => setAuthorization(undefined)}
          >
            <X size={16} />
          </button>
        </div>
      )}
      {data && (
        <div className="connector-provider-list">
          {(['google', 'microsoft'] as const).map((service) => {
            const accounts = data.accounts.filter((account) => account.provider === service);
            const serviceConfigured = data.providers.find((item) => item.provider === service)?.configured;
            return (
              <section
                className="connector-provider-card"
                key={service}
                aria-label={`${providerName(service)} 连接账号`}
              >
                <header className="connector-service-heading">
                  <span className={`connector-service-icon ${service}`} aria-hidden="true">
                    {service === 'google' ? (
                      <span>G</span>
                    ) : (
                      <>
                        <i />
                        <i />
                        <i />
                        <i />
                      </>
                    )}
                  </span>
                  <div>
                    <h3>{service === 'google' ? 'Google Workspace' : 'Microsoft 365'}</h3>
                    <p>
                      {service === 'google'
                        ? 'Gmail · Drive · Docs · Sheets · Slides'
                        : 'Outlook · OneDrive · Word · Excel · PowerPoint'}
                    </p>
                  </div>
                  {!serviceConfigured && (
                    <button
                      type="button"
                      className="button quiet tiny"
                      disabled={!!busy}
                      onClick={() => setSettings(service)}
                      aria-label={`配置 ${providerName(service)} 授权`}
                    >
                      <Settings2 size={13} />
                      授权设置
                    </button>
                  )}
                </header>
                <div className="connector-service-subheading">
                  <strong>已添加账号</strong>
                  <span>{accounts.length}</span>
                </div>
                <div className="connector-account-list">
                  {accounts.map((account) => (
                    <article className="connector-account" key={account.id}>
                      <div className={`connector-account-icon ${service}`} aria-hidden="true">
                        {accountInitial(account)}
                      </div>
                      <div className="connector-account-body">
                        {rename?.id === account.id ? (
                          <form
                            className="connector-rename"
                            onSubmit={(event) => {
                              event.preventDefault();
                              if (renameDuplicate) return;
                              void run(account.id, async () => {
                                await api(
                                  `/api/connectors/${encodeURIComponent(account.id)}`,
                                  { alias: rename.alias.trim() },
                                  'PATCH',
                                );
                                setRename(undefined);
                                await load();
                              });
                            }}
                          >
                            <input
                              value={rename.alias}
                              aria-label="新的账号名称"
                              maxLength={80}
                              autoFocus
                              aria-invalid={renameDuplicate || undefined}
                              onChange={(event) => setRename({ id: account.id, alias: event.target.value })}
                            />
                            <button
                              type="submit"
                              className="button secondary tiny"
                              disabled={!!busy || !rename.alias.trim() || renameDuplicate}
                            >
                              <Check size={13} />
                              保存
                            </button>
                            {renameDuplicate && (
                              <small className="connector-alias-error">已有同名连接器，请换一个账号名称。</small>
                            )}
                            <button
                              type="button"
                              className="icon-button"
                              aria-label="取消改名"
                              onClick={() => setRename(undefined)}
                            >
                              <X size={14} />
                            </button>
                          </form>
                        ) : (
                          <div className="connector-account-title">
                            <strong translate="no">{account.alias}</strong>
                            <span
                              className={`connector-status ${account.status === 'connected' && account.enabled ? 'connected' : ''}`}
                            >
                              {!account.enabled ? '已停用' : account.status === 'connected' ? '已连接' : '需要重新授权'}
                            </span>
                          </div>
                        )}
                        <p className="connector-account-identity" translate="no">
                          {account.email || account.displayName}
                        </p>
                        <div
                          className="connector-account-access"
                          title={account.capabilities.map(capabilityName).join(' · ')}
                        >
                          <span>{accountServices(account).join(' · ')}</span>
                          <small>{accountWrites(account) ? '含写入权限' : '只读'}</small>
                        </div>
                        {removing === account.id && (
                          <div className="connector-remove">
                            <p translate="no">
                              {withNames(
                                '断开“{0}”并删除本机保存的凭据？邮箱和云文件会保留，日历、待办和联系人也不会删除。',
                                [account.alias],
                              )}
                            </p>
                            <button
                              type="button"
                              className="button secondary tiny"
                              disabled={!!busy}
                              onClick={() =>
                                void run(account.id, async () => {
                                  await api(`/api/connectors/${encodeURIComponent(account.id)}`, undefined, 'DELETE');
                                  setRemoving(undefined);
                                  await load();
                                })
                              }
                            >
                              断开连接
                            </button>
                            <button type="button" className="button quiet tiny" onClick={() => setRemoving(undefined)}>
                              保留
                            </button>
                          </div>
                        )}
                      </div>
                      <details
                        className="connector-account-menu"
                        name={`${uid}-account-menu`}
                        onKeyDown={(event) => {
                          if (event.key !== 'Escape') return;
                          event.preventDefault();
                          event.currentTarget.removeAttribute('open');
                          event.currentTarget.querySelector('summary')?.focus();
                        }}
                      >
                        <summary
                          className="icon-button"
                          aria-label={withNames('管理 {0}', [account.alias])}
                          title={withNames('管理 {0}', [account.alias])}
                          data-names
                        >
                          <MoreHorizontal size={18} />
                        </summary>
                        <div className="connector-account-actions">
                          <label className="connector-enable">
                            <input
                              type="checkbox"
                              checked={account.enabled}
                              disabled={!!busy}
                              aria-label={withNames('启用 {0}', [account.alias])}
                              data-names
                              onChange={(event) =>
                                void run(account.id, async () => {
                                  await api(
                                    `/api/connectors/${encodeURIComponent(account.id)}`,
                                    { enabled: event.target.checked },
                                    'PATCH',
                                  );
                                  await load();
                                })
                              }
                            />
                            启用
                          </label>
                          <button
                            type="button"
                            className="button quiet tiny"
                            disabled={!!busy}
                            aria-label={withNames('调整 {0} 的权限', [account.alias])}
                            data-names
                            onClick={() => {
                              setEditingAccountId(account.id);
                              setProvider(account.provider);
                              setAlias(account.alias);
                              setAliasEdited(true);
                              setPermissions([...account.capabilities]);
                              setAdding(true);
                              setAuthorization(undefined);
                              pageRef.current
                                ?.querySelectorAll('.connector-account-menu[open]')
                                .forEach((menu) => menu.removeAttribute('open'));
                            }}
                          >
                            <Settings2 size={12} />
                            权限
                          </button>
                          <button
                            type="button"
                            className="button secondary tiny"
                            disabled={!!busy}
                            onClick={() => void connect(account)}
                          >
                            <RefreshCw size={12} />
                            重新授权
                          </button>
                          <button
                            type="button"
                            className="button quiet tiny"
                            aria-label={withNames('重命名 {0}', [account.alias])}
                            data-names
                            disabled={!!busy}
                            onClick={() => {
                              setRename({ id: account.id, alias: account.alias });
                              pageRef.current
                                ?.querySelectorAll('.connector-account-menu[open]')
                                .forEach((menu) => menu.removeAttribute('open'));
                            }}
                          >
                            <Pencil size={14} />
                            重命名
                          </button>
                          <button
                            type="button"
                            className="button quiet tiny connector-disconnect"
                            aria-label={withNames('断开 {0}', [account.alias])}
                            data-names
                            disabled={!!busy}
                            onClick={() => {
                              setRemoving(account.id);
                              pageRef.current
                                ?.querySelectorAll('.connector-account-menu[open]')
                                .forEach((menu) => menu.removeAttribute('open'));
                            }}
                          >
                            <Trash2 size={14} />
                            断开连接
                          </button>
                        </div>
                      </details>
                    </article>
                  ))}
                  <button
                    type="button"
                    className="connector-add-account"
                    disabled={!!busy}
                    onClick={() => addAccount(service)}
                    aria-label={`连接另一个 ${providerName(service)} 账号`}
                  >
                    <span aria-hidden="true">
                      <Plus size={18} />
                    </span>
                    {accounts.length ? '连接另一个账号' : '连接账号'}
                  </button>
                </div>
                {!accounts.length && (
                  <p className="connector-service-empty">
                    {serviceConfigured
                      ? '分别连接工作、个人或学校账号，按名称在对话中调用。'
                      : '首次连接需要配置授权；同一服务只需配置一次。'}
                  </p>
                )}
              </section>
            );
          })}
        </div>
      )}
      <p className="connector-storage-note">
        凭据仅保存在本机，使用当前用户文件权限保护。关闭连接后，新任务不能再使用它。
      </p>
    </section>
  );
}

export function ProviderSettings({
  provider,
  data,
  api,
  notify,
  onSaved,
  onClose,
  onProvider,
}: {
  provider: ConnectorProvider;
  data: ConnectorData;
  api: Api;
  notify: Notify;
  onSaved: () => Promise<void>;
  onClose: () => void;
  onProvider: (provider: ConnectorProvider) => void;
}) {
  const config = data.providers.find((item) => item.provider === provider);
  const [clientId, setClientId] = useState(config?.clientId ?? '');
  const [clientSecret, setClientSecret] = useState('');
  const [tenant, setTenant] = useState(config?.tenant ?? 'common');
  const [busy, setBusy] = useState(false);
  const redirectUri = config?.redirectUri ?? data.redirectUri ?? '';
  const save = async () => {
    setBusy(true);
    try {
      await api(
        `/api/connectors/providers/${provider}`,
        {
          clientId: clientId.trim(),
          ...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {}),
          ...(provider === 'microsoft' ? { tenant: tenant.trim() || 'common' } : {}),
        },
        'PUT',
      );
      setClientSecret('');
      await onSaved();
      notify({ tone: 'success', message: '授权设置已保存，可以连接账号了。' });
      onClose();
    } catch (reason) {
      notify({ tone: 'error', message: failure(reason) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="connector-form connector-settings"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="connector-form-heading">
        <h3>服务授权设置</h3>
        <button type="button" className="icon-button" aria-label="关闭授权设置" onClick={onClose}>
          <X size={16} />
        </button>
      </div>
      <label className="connector-field">
        服务
        <select value={provider} onChange={(event) => onProvider(event.target.value as ConnectorProvider)}>
          <option value="google">Google</option>
          <option value="microsoft">Microsoft</option>
        </select>
      </label>
      <p className="connector-note">
        {provider === 'google'
          ? '在 Google Cloud 创建 Web 应用 OAuth 客户端。按需要启用 Gmail、Drive、Docs、Sheets、Slides、Calendar、Tasks 和 People API。把下方地址加入授权重定向 URI，测试模式需把要连接的账号加入测试用户。'
          : '在 Microsoft Entra 注册应用，将下方重定向 URI 配置在“移动和桌面应用”（公共客户端）平台，不使用 Web 应用平台，也不需要 Client secret。要支持个人及多个学校或公司账号，请选择相应的多租户账号类型。'}
      </p>
      <label className="connector-field">
        Client ID
        <input autoComplete="off" value={clientId} required onChange={(event) => setClientId(event.target.value)} />
      </label>
      {provider === 'google' && (
        <label className="connector-field">
          Client secret
          <input
            type="password"
            autoComplete="new-password"
            value={clientSecret}
            required={!config?.hasClientSecret}
            placeholder={config?.hasClientSecret ? '已保存，留空保留' : '输入 OAuth 客户端密钥'}
            onChange={(event) => setClientSecret(event.target.value)}
          />
        </label>
      )}
      {provider === 'microsoft' && (
        <label className="connector-field">
          Tenant
          <input value={tenant} placeholder="common" onChange={(event) => setTenant(event.target.value)} />
          <small>通常使用 common；组织专用应用填写管理员提供的租户 ID。</small>
        </label>
      )}
      <label className="connector-field">
        重定向 URI
        <div className="connector-copy">
          <input readOnly value={redirectUri} aria-label="重定向 URI" />
          <button
            type="button"
            className="button secondary"
            disabled={!redirectUri}
            aria-label="复制重定向 URI"
            onClick={() =>
              void navigator.clipboard
                .writeText(redirectUri)
                .then(() => notify({ tone: 'success', message: '重定向 URI 已复制。' }))
                .catch(() => notify({ tone: 'error', message: '无法复制，请手动选择并复制重定向 URI。' }))
            }
          >
            <Copy size={14} />
          </button>
        </div>
      </label>
      <div className="connector-form-footer">
        <a
          href={
            provider === 'google'
              ? 'https://developers.google.com/identity/protocols/oauth2/web-server'
              : 'https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app'
          }
          target="_blank"
          rel="noopener noreferrer"
        >
          查看官方配置说明
          <ExternalLink size={12} />
        </a>
        <button
          type="submit"
          className="button primary"
          disabled={
            busy || !clientId.trim() || (provider === 'google' && !config?.hasClientSecret && !clientSecret.trim())
          }
        >
          {busy && <Loader2 size={14} className="spinning" />}保存授权设置
        </button>
      </div>
    </form>
  );
}

export function ConnectorPicker({
  api,
  value,
  onChange,
  disabled,
  onManage,
  inline,
}: {
  api: Api;
  value: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
  onManage?: () => void;
  inline?: boolean;
}) {
  const [data, setData] = useState<ConnectorData>();
  const [error, setError] = useState(false);
  const [open, setOpen] = useState(false);
  const id = useId();
  const load = useCallback(() => {
    setError(false);
    void api<ConnectorData>('/api/connectors', undefined, 'GET')
      .then(setData)
      .catch(() => setError(true));
  }, [api]);
  useEffect(() => {
    if (open || inline) load();
  }, [open, inline, load]);
  const selected = new Set(value);
  const unknown = data ? value.filter((item) => !data.accounts.some((account) => account.id === item)) : [];
  return (
    <div
      className={`connector-picker${inline ? ' inline' : ''}`}
      onKeyDown={(event) => {
        if (!inline && event.key === 'Escape') {
          event.stopPropagation();
          setOpen(false);
        }
      }}
    >
      {!inline && (
        <button
          type="button"
          className="button quiet tiny"
          aria-expanded={open}
          aria-controls={`${id}-connectors`}
          disabled={disabled}
          onClick={() => setOpen(!open)}
        >
          <Plug size={14} />
          连接器{value.length > 0 && <span className="connector-picker-count">{value.length}</span>}
          <ChevronDown size={12} />
        </button>
      )}
      {(open || inline) && (
        <div className="connector-picker-popover" id={`${id}-connectors`}>
          <div className="connector-picker-title">
            <strong>此对话可使用的账号</strong>
            {!inline && (
              <button type="button" className="icon-button" aria-label="关闭连接器选择" onClick={() => setOpen(false)}>
                <X size={14} />
              </button>
            )}
          </div>
          <p>仅共享你选中的账号。</p>
          {error ? (
            <div role="alert">
              连接器加载失败。
              <button type="button" className="button quiet tiny" onClick={load}>
                重试
              </button>
            </div>
          ) : !data ? (
            <p role="status">正在加载…</p>
          ) : (
            <>
              {data.accounts.map((account) => {
                const unavailable = !account.enabled || account.status !== 'connected';
                return (
                  <label className="connector-picker-option" key={account.id}>
                    <input
                      type="checkbox"
                      checked={selected.has(account.id)}
                      disabled={disabled || (unavailable && !selected.has(account.id))}
                      onChange={(event) =>
                        onChange(
                          event.target.checked
                            ? [...new Set([...value, account.id])]
                            : value.filter((item) => item !== account.id),
                        )
                      }
                    />
                    <span>
                      <strong translate="no">{account.alias}</strong>
                      <small>
                        <span translate="no">{account.email || account.displayName}</span> ·{' '}
                        {providerName(account.provider)}
                      </small>
                      <small>
                        {unavailable
                          ? !account.enabled
                            ? '已停用，暂时不可使用'
                            : '需要重新授权'
                          : account.capabilities.map(capabilityName).join(' · ')}
                      </small>
                    </span>
                  </label>
                );
              })}
              {unknown.map((item) => (
                <label className="connector-picker-option" key={item}>
                  <input
                    type="checkbox"
                    checked
                    disabled={disabled}
                    onChange={() => onChange(value.filter((value) => value !== item))}
                  />
                  <span>
                    <strong>已移除的连接</strong>
                    <small>取消勾选可从此对话移除。</small>
                  </span>
                </label>
              ))}
              {!data.accounts.length && <p>还没有连接账号。先在“扩展 → 连接与服务”中添加。</p>}
            </>
          )}
          {connectorsEnabled && onManage && (
            <button
              type="button"
              className="button secondary tiny"
              onClick={() => {
                setOpen(false);
                onManage();
              }}
            >
              <Settings2 size={12} />
              管理连接器
            </button>
          )}
        </div>
      )}
    </div>
  );
}
