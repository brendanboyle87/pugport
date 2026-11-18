import { GitHubConnection } from './GitHubConnection';
import { useCallback, useEffect, useRef, useState } from 'react';
import { desktopBridge } from './desktop';
import { Loader2, MoreHorizontal, PackagePlus, RefreshCw, Settings2, Trash2 } from 'lucide-react';
import type { CatalogEntry, ExtensionInstallOptions, ExtensionPreview, ExtensionView } from '../shared/extensions';
import type { Settings } from '../shared/types';
import type { TerminalPathInfo } from '../server/platform/terminal-path';
import type { Api, Notice } from './Workspace';
import { SettingsGroup, SettingsRow } from './SettingsRow';
import { SettingsHeaderAction } from './SettingsShell';
import { useMenuKeys } from './use-menu-keys';
import { useDismiss } from './use-dismiss';
import { confirmDialog } from './confirm-dialog';
import { withNames } from './i18n';
import { MediaWorkflowDialog } from './MediaWorkflows';
import { InOverlayLayer, SideSheet } from './SideSheet';
import { ContextMenu, type MenuItem } from './DesktopFeatures';
import { WebSearchSettings } from './WebSearchSettings';
import { SlackGateway } from './SlackGateway';
import { AgentConnect } from './AgentConnect';
import { ExternalAgentsCard } from './ExternalAgents';
import {
  discoveryEntries,
  ExtensionCatalog,
  localComponentReady,
  localComponents,
  useLocalComponents,
} from './ExtensionCatalog';

type Notify = (notice: Notice) => void;
type View = ExtensionView & { checking?: boolean };
type Choice = ExtensionPreview & {
  selected: Set<string>;
  fills: Record<string, Record<string, string>>;
  options: ExtensionInstallOptions;
};
const message = (error: unknown) => (error instanceof Error ? error.message : '操作失败');

/**
 * Skills and tools, installed once for every executor. Anything new is shown first (what it is, where it
 * comes from, what will run) and installed only after the user picks it.
 */
export function ExtensionsPage({
  api,
  notify,
  defaultFolder,
  section,
  externalCallers,
}: {
  api: Api;
  notify: Notify;
  defaultFolder?: string;
  section: 'skills' | 'connections' | 'components';
  externalCallers?: Settings['externalCallers'];
}) {
  const [items, setItems] = useState<View[]>();
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [input, setInput] = useState('');
  const [choice, setChoice] = useState<Choice>();
  const [busy, setBusy] = useState<string>();
  const [loadError, setLoadError] = useState('');
  const [workflowsOpen, setWorkflowsOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const addRef = useRef<HTMLDivElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  useMenuKeys(menuOpen, menuRef, () => setMenuOpen(false));
  useDismiss(menuOpen, addRef, () => setMenuOpen(false));
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const sequence = useRef(0);
  const previewSequence = useRef(0);
  const local = useLocalComponents(api, notify);

  const load = useCallback(async () => {
    const current = ++sequence.current;
    try {
      const data = await api<{ items: View[]; catalog: CatalogEntry[]; error?: string }>(
        '/api/extensions',
        undefined,
        'GET',
      );
      if (current !== sequence.current) return;
      setItems(data.error ? undefined : data.items);
      setCatalog(data.catalog);
      setLoadError(data.error ?? '');
    } catch (error) {
      if (current === sequence.current) setLoadError(message(error));
      throw error;
    }
  }, [api]);
  useEffect(() => {
    void load().catch(() => undefined);
    return () => {
      sequence.current++;
    };
  }, [load]);
  useEffect(() => {
    if (adding) inputRef.current?.focus();
  }, [adding]);
  useEffect(() => {
    previewSequence.current++;
    setMenuOpen(false);
    setAdding(false);
    setChoice(undefined);
    return () => {
      previewSequence.current++;
    };
  }, [section]);
  // A tool being checked (first start can download it) is shown live until it settles.
  const checking = items?.some((item) => item.kind === 'mcp' && item.checking);
  useEffect(() => {
    if (!checking) return;
    const timer = setInterval(() => void load().catch(() => undefined), 1500);
    return () => clearInterval(timer);
  }, [checking, load]);

  const run = async (key: string, work: () => Promise<void>) => {
    setBusy(key);
    try {
      await work();
    } catch (error) {
      notify({ tone: 'error', message: message(error) });
    } finally {
      setBusy(undefined);
    }
  };
  const closeAdding = () => {
    previewSequence.current++;
    setAdding(false);
    setChoice(undefined);
    addButton.current?.focus();
  };
  const open = (preview: ExtensionPreview, request: number) => {
    if (request !== previewSequence.current) return;
    // A short list starts ticked; a long one (e.g. everything another app has) lets the user pick.
    const fresh = preview.drafts.filter((draft) => !draft.installed);
    const selected = new Set(
      preview.drafts.length <= 5 ? (fresh.length ? fresh : preview.drafts).map((draft) => draft.key) : [],
    );
    setChoice({ ...preview, selected, fills: {}, options: {} });
    setAdding(true);
  };
  const previewInput = () => {
    const request = ++previewSequence.current;
    return run('preview', async () => open(await api<ExtensionPreview>('/api/extensions/preview', { input }), request));
  };
  const previewImports = () => {
    const request = ++previewSequence.current;
    return run('imports', async () =>
      open(await api<ExtensionPreview>('/api/extensions/preview', { imports: true }), request),
    );
  };
  const install = (current: Choice) =>
    run('install', async () => {
      const keys = [...current.selected];
      const body = {
        token: current.token,
        keys,
        fills: current.fills,
        options: current.options,
      };
      if (
        current.drafts.some(
          (draft) => keys.includes(draft.key) && draft.kind === 'mcp' && !/^https?:\/\//i.test(draft.detail ?? ''),
        )
      ) {
        const change = desktopBridge()?.changePermission;
        if (!change) throw new Error('请在桌面应用中修改权限。');
        if (!(await change({ kind: 'extension-command', action: 'install', ...body }))) return;
      } else await api('/api/extensions/install', body);
      setChoice(undefined);
      setInput('');
      setAdding(false);
      await load();
      notify({ tone: 'success', message: `已安装 ${keys.length} 项，将用于支持扩展的新任务。` });
    });
  const installCatalog = (entry: CatalogEntry) => {
    const request = ++previewSequence.current;
    return run(`catalog-${entry.id}`, async () => {
      const preview = await api<ExtensionPreview>('/api/extensions/preview', { catalog: entry.id });
      // Nothing to fill in: install right away; otherwise ask for the missing settings first.
      if (preview.drafts.some((draft) => draft.kind === 'mcp' || draft.needs?.length)) return open(preview, request);
      await api('/api/extensions/install', {
        token: preview.token,
        keys: preview.drafts.map((draft) => draft.key),
      });
      await load();
      notify({ tone: 'success', message: '已安装“{0}”。', names: [entry.title] });
    });
  };
  const toggle = (item: View, enabled: boolean) =>
    run(item.id, async () => {
      await api(`/api/extensions/${item.id}`, { enabled }, 'PATCH');
      await load();
    });
  const check = (item: View) =>
    run(item.id, async () => {
      try {
        const { tools } = await api<{ tools: unknown[] }>(`/api/extensions/${item.id}/check`, {});
        notify({ tone: 'success', message: '“{0}”可用，提供 {1} 个功能。', names: [item.name, String(tools.length)] });
      } finally {
        await load();
      }
    });
  const remove = (item: View) =>
    run(item.id, async () => {
      const skill = item.kind === 'skill';
      const managed = skill && item.managed;
      if (
        !(await confirmDialog({
          title: managed ? '删除技能「{0}」？' : skill ? '从 PugPort 移除「{0}」？' : '移除「{0}」？',
          names: [item.name],
          summary: managed
            ? '会从 PugPort 删除它的文件夹；用过它的对话保留历史。'
            : skill
              ? '原文件夹留在原处。'
              : undefined,
          action: managed ? '删除' : '移除',
          tone: 'danger',
        }))
      )
        return;
      await api(`/api/extensions/${item.id}`, undefined, 'DELETE');
      await load();
    });

  const skills = items?.filter((item) => item.kind === 'skill') ?? [];
  const tools = items?.filter((item) => item.kind === 'mcp') ?? [];
  const installedNames = new Set(items?.map((item) => `${item.kind}:${item.name.toLowerCase()}`));
  const recommendations = discoveryEntries(catalog).filter(
    (entry) => entry.catalog && !installedNames.has(`${entry.catalog.kind}:${entry.catalog.id}`),
  );
  return (
    <>
      {section !== 'components' && (
        <SettingsHeaderAction>
          <div className="heading-actions settings-add" ref={addRef}>
            <button
              ref={addButton}
              type="button"
              className="button secondary"
              disabled={!!busy}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-controls="extensions-add-menu"
              onClick={() => setMenuOpen((open) => !open)}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault();
                  setMenuOpen(true);
                }
              }}
            >
              添加 ▾
            </button>
            {menuOpen && (
              <div
                id="extensions-add-menu"
                className="settings-add-menu"
                role="menu"
                aria-label="添加扩展"
                ref={menuRef}
              >
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    setAdding(true);
                  }}
                >
                  {section === 'skills' ? '从链接或文件夹添加…' : '添加 MCP 工具…'}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    setAdding(true);
                    void previewImports();
                  }}
                >
                  从其他 AI 应用导入…
                </button>
              </div>
            )}
          </div>
        </SettingsHeaderAction>
      )}
      {loadError && (
        <div className="ext-load-error" role="alert">
          <span>
            {items ? '连接列表刷新失败，以下为上次加载的内容。' : '暂时无法加载扩展。'} {loadError}
          </span>
          <button
            type="button"
            className="button secondary tiny"
            disabled={!!busy}
            onClick={() => void run('reload', load)}
          >
            重试
          </button>
        </div>
      )}
      {!items && !loadError && (
        <p className="ext-loading" role="status">
          <Loader2 size={16} className="spinning" />
          正在加载扩展…
        </p>
      )}
      {adding && (
        <SideSheet title="添加扩展" label="添加扩展" onClose={closeAdding}>
          {!choice && busy === 'imports' && (
            <p className="ext-loading" role="status">
              <Loader2 size={16} className="spinning" />
              正在加载扩展…
            </p>
          )}
          {!choice && busy !== 'imports' && (
            <section className="ext-install">
              <label htmlFor="extension-input">安装新扩展</label>
              <textarea
                ref={inputRef}
                id="extension-input"
                rows={3}
                value={input}
                placeholder="https://github.com/…"
                aria-describedby="extension-input-help"
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && input.trim()) void previewInput();
                }}
              />
              <p id="extension-input-help" className="ext-section-note">
                可以是 GitHub 链接、.zip 或文件夹路径，也可以是工具的配置 JSON、启动命令或远程地址。
              </p>
              <div className="ext-install-actions">
                <span>先显示会安装什么，确认后才安装。</span>
                <button
                  className="button primary"
                  disabled={!!busy || !input.trim()}
                  onClick={() => void previewInput()}
                >
                  {busy === 'preview' ? <Loader2 size={13} className="spinning" /> : <PackagePlus size={13} />}
                  查看
                </button>
              </div>
            </section>
          )}
          {choice && (
            <ExtensionChoice
              choice={choice}
              busy={busy === 'install'}
              onChange={setChoice}
              onInstall={() => void install(choice)}
              onCancel={closeAdding}
            />
          )}
        </SideSheet>
      )}

      {section === 'connections' && (
        <SettingsGroup title="外部服务">
          <GitHubConnection api={api} notify={notify} />
          <WebSearchSettings api={api} notify={notify} />
          <SlackGateway api={api} notify={notify} />
        </SettingsGroup>
      )}

      {items && (
        <>
          {section === 'skills' && (
            <>
              <SettingsGroup title="已安装">
                {skills.map((item) => (
                  <InstalledRow key={item.id} item={item} busy={busy === item.id} onToggle={toggle} onRemove={remove} />
                ))}
                {!skills.length && <p className="settings-empty">还没有技能。可以从链接或文件夹添加。</p>}
              </SettingsGroup>
              {recommendations.some((entry) => entry.kind === 'skill') && (
                <SettingsGroup title="推荐">
                  <ExtensionCatalog
                    entries={recommendations.filter((entry) => entry.kind === 'skill')}
                    local={local}
                    installed={installedNames}
                    busy={busy}
                    onInstall={(entry) => void installCatalog(entry)}
                  />
                </SettingsGroup>
              )}
            </>
          )}
          {section === 'connections' && (
            <SettingsGroup title="MCP 工具">
              {tools.map((item) => (
                <InstalledRow
                  key={item.id}
                  item={item}
                  busy={busy === item.id}
                  onToggle={toggle}
                  onRemove={remove}
                  onCheck={check}
                  onSave={async (name, values) => {
                    if (item.kind === 'mcp' && item.transport === 'stdio' && Object.keys(values).length) {
                      const change = desktopBridge()?.changePermission;
                      if (!change) throw new Error('请在桌面应用中修改权限。');
                      if (!(await change({ kind: 'extension-command', action: 'configure', id: item.id, values })))
                        return false;
                      values = {};
                    }
                    // Keep entered settings on a failed write; clear secrets once the server confirms the write.
                    await api(
                      `/api/extensions/${item.id}`,
                      { name, ...(Object.keys(values).length ? { values } : {}) },
                      'PATCH',
                    );
                    try {
                      await load();
                      notify({ tone: 'success', message: '连接设置已保存。' });
                    } catch {
                      notify({ tone: 'error', message: '连接设置已保存，但列表刷新失败，请重试刷新。' });
                    }
                  }}
                  notify={notify}
                />
              ))}
              {!tools.length && <p className="settings-empty">添加第一个连接或工具</p>}
              {recommendations.some((entry) => entry.kind === 'mcp') && (
                <div className="settings-recommended">推荐</div>
              )}
              <ExtensionCatalog
                entries={recommendations.filter((entry) => entry.kind === 'mcp')}
                local={local}
                installed={installedNames}
                busy={busy}
                onInstall={(entry) => void installCatalog(entry)}
              />
              <p className="resource-footnote">
                支持情况取决于执行器和任务权限；PugPort 只在任务用到时才连接这些服务。
              </p>
            </SettingsGroup>
          )}
        </>
      )}

      {section === 'connections' && (
        <>
          <SettingsGroup title="在别处使用 PugPort">
            <AgentConnect api={api} notify={notify} externalCallers={externalCallers} />
            <TerminalCommand api={api} notify={notify} />
          </SettingsGroup>
          <ExternalAgentsCard api={api} notify={notify} />
        </>
      )}
      {(section === 'connections' || section === 'components') && (
        <SettingsGroup title="本机能力" description="在这台电脑上运行，按需下载组件。">
          <ExtensionCatalog
            entries={[...localComponents].sort(
              (a, b) =>
                Number(!!b.tool && localComponentReady(b.tool, local.info)) -
                Number(!!a.tool && localComponentReady(a.tool, local.info)),
            )}
            local={local}
            installed={installedNames}
            onInstall={() => undefined}
          />
          <SettingsRow
            title="整理照片和视频"
            description="找出重复或几乎一样的图片和视频。"
            control={
              <button type="button" className="button secondary tiny" onClick={() => setWorkflowsOpen(true)}>
                管理本地流程
              </button>
            }
          />
        </SettingsGroup>
      )}
      {workflowsOpen && (
        <MediaWorkflowDialog
          api={api}
          notify={notify}
          defaultFolder={defaultFolder}
          onClose={() => setWorkflowsOpen(false)}
        />
      )}
    </>
  );
}

/** Persisted installation status; no process PATH guesses. */
export function TerminalCommand({ api, notify }: { api: Api; notify: Notify }) {
  const [info, setInfo] = useState<TerminalPathInfo>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);
  const [retry, setRetry] = useState<'GET' | 'POST' | 'DELETE'>('GET');
  const [added, setAdded] = useState(false);
  const sequence = useRef(0);
  const run = useCallback(
    async (method: 'GET' | 'POST' | 'DELETE') => {
      const current = ++sequence.current;
      setBusy(true);
      setRetry(method);
      try {
        const value = await api<TerminalPathInfo>('/api/external/terminal-command', undefined, method);
        if (!value?.folder || typeof value.folder !== 'string') throw new Error('读不到终端命令的位置。');
        if (current === sequence.current) {
          setInfo(value);
          setAdded(method === 'POST' && value.installed);
          setError('');
        }
      } catch (error) {
        if (current === sequence.current) setError(message(error));
      } finally {
        if (current === sequence.current) setBusy(false);
      }
    },
    [api],
  );
  useEffect(() => {
    void run('GET');
    return () => {
      sequence.current++;
    };
  }, [run]);
  return (
    <SettingsRow
      title="终端"
      description={
        <>
          从终端把任务交给 PugPort。
          {error && (
            <div className="inline-error" role="alert">
              {error}
            </div>
          )}
        </>
      }
      status={info?.installed ? '已加入' : undefined}
      tone={info?.installed ? 'live' : undefined}
      control={
        error ? (
          <button type="button" className="button secondary tiny" disabled={busy} onClick={() => void run(retry)}>
            重试
          </button>
        ) : info?.automatic === false ? (
          <button
            type="button"
            className="button secondary tiny"
            disabled={busy}
            onClick={() =>
              void navigator.clipboard.writeText(info.manualLine!).then(
                () => notify({ tone: 'success', message: '命令已复制。' }),
                () => notify({ tone: 'error', message: '无法复制，请手动选择并复制命令。' }),
              )
            }
          >
            复制命令
          </button>
        ) : !info?.installed ? (
          <button type="button" className="button secondary tiny" disabled={busy} onClick={() => void run('POST')}>
            {busy && <Loader2 size={13} className="spinning" />}
            {!info && busy ? '正在检查…' : '加入 PATH'}
          </button>
        ) : undefined
      }
    >
      <p className="ext-section-note">在任意终端输入 pugport 和它对话，或用 pugport ask 交一件事。</p>
      {added && <p className="ext-section-note">新开一个终端窗口后可用（已打开的 VS Code 需要重启）</p>}
      {info?.automatic === false && (
        <p className="ext-section-note">
          {info.manualLine?.startsWith('fish_add_path ')
            ? '复制命令，在终端里运行。'
            : '把下面这一行加到 shell 的配置文件里'}
        </p>
      )}
      <p className="ext-section-note" style={{ margin: 0, overflowWrap: 'anywhere' }}>
        {info?.folder}
      </p>
      {info?.installed && (
        <button type="button" className="button secondary tiny" disabled={busy} onClick={() => void run('DELETE')}>
          从 PATH 移除
        </button>
      )}
      {info?.manualLine && (
        <label className="field">
          <span>加入 PATH 的命令</span>
          <input
            readOnly
            value={info.manualLine}
            aria-label="加入 PATH 的命令"
            onFocus={(event) => event.currentTarget.select()}
          />
        </label>
      )}
    </SettingsRow>
  );
}

export function ExtensionChoice({
  choice,
  busy,
  onChange,
  onInstall,
  onCancel,
}: {
  choice: Choice;
  busy: boolean;
  onChange: (next: Choice) => void;
  onInstall: () => void;
  onCancel: () => void;
}) {
  const pick = (key: string, on: boolean) => {
    const selected = new Set(choice.selected);
    if (on) selected.add(key);
    else selected.delete(key);
    onChange({ ...choice, selected });
  };
  const fill = (key: string, name: string, value: string) =>
    onChange({ ...choice, fills: { ...choice.fills, [key]: { ...choice.fills[key], [name]: value } } });
  const option = (key: string, value: ExtensionInstallOptions[string]) =>
    onChange({ ...choice, options: { ...choice.options, [key]: value } });
  const missing = choice.drafts.some(
    (draft) =>
      choice.selected.has(draft.key) &&
      (draft.needs?.some((name) => !choice.fills[draft.key]?.[name]?.trim()) ||
        (choice.options[draft.key]?.name !== undefined && !choice.options[draft.key].name?.trim())),
  );
  const tools = choice.drafts.some((draft) => draft.kind === 'mcp' && choice.selected.has(draft.key));
  return (
    <section className="ext-choice" aria-label="确认要安装的扩展">
      <header>
        <strong>找到 {choice.drafts.length} 项</strong>
        {choice.drafts.length > 5 && (
          <span>
            <button
              type="button"
              className="button quiet tiny"
              onClick={() => onChange({ ...choice, selected: new Set(choice.drafts.map((draft) => draft.key)) })}
            >
              全选
            </button>
            <button
              type="button"
              className="button quiet tiny"
              onClick={() => onChange({ ...choice, selected: new Set() })}
            >
              全不选
            </button>
          </span>
        )}
      </header>
      {choice.notes?.map((note) => (
        <p key={note} className="ext-note">
          {note}
        </p>
      ))}
      <ul>
        {choice.drafts.map((draft) => (
          <li key={draft.key} className={choice.selected.has(draft.key) ? 'selected' : ''}>
            <label>
              <input
                type="checkbox"
                checked={choice.selected.has(draft.key)}
                disabled={busy}
                onChange={(event) => pick(draft.key, event.target.checked)}
              />
              <span className="ext-draft">
                <span className="ext-draft-title">
                  <strong translate="no">{draft.name}</strong>
                  <span className="exec-tag">{draft.kind === 'skill' ? '技能' : '工具'}</span>
                  <small>{draft.origin}</small>
                  {draft.installed && draft.kind === 'skill' && <small className="ext-update">已安装，会更新</small>}
                  {draft.license && <small>许可：{draft.license}</small>}
                </span>
                {draft.description && <span className="ext-description">{draft.description}</span>}
                {draft.detail && <code>{draft.detail}</code>}
              </span>
            </label>
            {draft.kind === 'mcp' && choice.selected.has(draft.key) && (
              <div className="ext-instance-fields">
                {draft.existingId && (
                  <label>
                    <span>添加方式</span>
                    <select
                      aria-label={withNames('{0} 添加方式', [draft.name])}
                      data-names
                      disabled={busy}
                      value={choice.options[draft.key]?.replaceId ? 'replace' : 'add'}
                      onChange={(event) =>
                        option(draft.key, {
                          ...choice.options[draft.key],
                          replaceId: event.target.value === 'replace' ? draft.existingId : undefined,
                        })
                      }
                    >
                      <option value="add">新增独立连接（保留已有连接）</option>
                      <option value="replace">更新已有连接</option>
                    </select>
                  </label>
                )}
                <label>
                  <span>连接名称</span>
                  <input
                    aria-label={withNames('{0} 连接名称', [draft.name])}
                    maxLength={80}
                    disabled={busy}
                    placeholder={draft.name}
                    data-names
                    value={choice.options[draft.key]?.name ?? ''}
                    onChange={(event) => {
                      const name = event.target.value;
                      option(draft.key, { ...choice.options[draft.key], name: name || undefined });
                    }}
                  />
                  <small>例如：个人 Gmail、学校 Outlook。留空时自动命名。</small>
                </label>
                {choice.options[draft.key]?.replaceId && (
                  <p className="ext-note">将更新此预览中已有的连接配置；其他连接不受影响。</p>
                )}
              </div>
            )}
            {draft.needs?.length && choice.selected.has(draft.key) ? (
              <div className="ext-needs">
                {draft.needs.map((name) => (
                  <label key={name}>
                    <span>{name}</span>
                    <input
                      type="password"
                      autoComplete="off"
                      disabled={busy}
                      placeholder="需要填写"
                      value={choice.fills[draft.key]?.[name] ?? ''}
                      onChange={(event) => fill(draft.key, name, event.target.value)}
                    />
                  </label>
                ))}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      {tools && (
        <p className="ext-note">本地工具会运行上面的命令；远程工具会连接上面的地址。请核对来源和各连接使用的账号。</p>
      )}
      <footer>
        <button type="button" className="button quiet" disabled={busy} onClick={onCancel}>
          取消
        </button>
        <button
          type="button"
          className="button primary"
          disabled={busy || !choice.selected.size || missing}
          title={missing ? '请先填写需要的设置' : undefined}
          onClick={onInstall}
        >
          {busy && <Loader2 size={13} className="spinning" />}
          安装所选（{choice.selected.size}）
        </button>
      </footer>
    </section>
  );
}

export function InstalledRow({
  item,
  busy,
  onToggle,
  onRemove,
  onCheck,
  onSave,
  notify,
}: {
  item: View;
  busy: boolean;
  onToggle: (item: View, enabled: boolean) => void;
  onRemove: (item: View) => void;
  onCheck?: (item: View) => void;
  onSave?: (name: string, values: Record<string, string>) => Promise<void | boolean>;
  notify?: Notify;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(item.name);
  const [saving, setSaving] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number }>();
  const savingRef = useRef(false);
  // Keyboard users come back to the … button after its menu, a confirmation or the settings sheet closes.
  const more = useRef<HTMLButtonElement>(null);
  const fields = item.kind === 'mcp' ? Object.entries({ ...item.env, ...item.headers }) : [];
  const unset =
    item.kind === 'mcp'
      ? Object.entries({ ...item.env, ...item.headers })
          .filter(([, filled]) => !filled)
          .map(([name]) => name)
      : [];
  const status = unset.length
    ? `还差 ${unset.length} 项设置`
    : item.kind === 'mcp' && item.checking
      ? '正在检查…'
      : item.kind === 'mcp' && item.error
        ? '检查失败'
        : undefined;
  const startEditing = () => {
    setName(item.name);
    setValues({});
    setEditing(true);
  };
  const stopEditing = () => {
    setEditing(false);
    setValues({});
    more.current?.focus();
  };
  const save = async () => {
    if (!onSave || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      if (
        (await onSave(name.trim(), Object.fromEntries(Object.entries(values).filter(([, value]) => value.trim())))) ===
        false
      )
        return;
      setValues({});
      setEditing(false);
    } catch (error) {
      notify?.({ tone: 'error', message: message(error) });
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  const actions: MenuItem[] = [
    ...(item.kind === 'mcp'
      ? [
          {
            label: '改名称和设置…',
            icon: <Settings2 size={15} />,
            disabled: busy || saving || !onSave,
            onSelect: startEditing,
          },
          {
            label: '重新检查',
            icon: <RefreshCw size={14} />,
            disabled: busy || saving || item.checking || !onCheck,
            onSelect: () => onCheck?.(item),
          },
          'separator' as const,
        ]
      : []),
    {
      label: item.kind === 'skill' ? (item.managed ? '删除…' : '从 PugPort 移除…') : '移除…',
      icon: <Trash2 size={14} />,
      danger: true,
      disabled: busy || saving,
      onSelect: () => onRemove(item),
    },
  ];
  return (
    <>
      <SettingsRow
        title={<span translate="no">{item.name}</span>}
        itemId={item.id}
        className={`ext-row ${item.enabled ? '' : 'off'}`}
        description={item.description}
        status={status}
        tone={
          unset.length ? 'warning' : item.kind === 'mcp' && item.error ? 'danger' : item.enabled ? 'live' : undefined
        }
        control={
          <>
            {unset.length ? (
              <button
                type="button"
                className="button quiet tiny"
                disabled={busy || saving || !onSave}
                onClick={startEditing}
              >
                开始设置
              </button>
            ) : (
              <label className="switch" title={item.enabled ? '停用' : '启用'}>
                <input
                  type="checkbox"
                  checked={item.enabled}
                  disabled={busy || saving}
                  aria-label={withNames(item.enabled ? '停用 {0}' : '启用 {0}', [item.name])}
                  data-names
                  onChange={(event) => onToggle(item, event.target.checked)}
                />
                <span />
              </label>
            )}
            {item.kind === 'mcp' && !unset.length && (
              <button
                type="button"
                className="button quiet tiny"
                disabled={busy || saving || !onSave}
                onClick={startEditing}
              >
                管理
              </button>
            )}
            <button
              ref={more}
              type="button"
              className="icon-button ext-more"
              aria-label={withNames('更多操作：{0}', [item.name])}
              data-names
              aria-haspopup="menu"
              aria-expanded={!!menu}
              disabled={busy || saving}
              onClick={(event) => {
                const box = event.currentTarget.getBoundingClientRect();
                setMenu({ x: box.left, y: box.bottom });
              }}
            >
              <MoreHorizontal size={16} />
            </button>
            {menu && (
              <InOverlayLayer>
                <ContextMenu
                  {...menu}
                  items={actions}
                  onClose={() => {
                    setMenu(undefined);
                    more.current?.focus();
                  }}
                />
              </InOverlayLayer>
            )}
          </>
        }
      >
        {item.description && <p>{item.description}</p>}
        <p className="ext-source">
          {item.kind === 'skill'
            ? item.managed
              ? `来源：${item.source}`
              : `使用原位置：${item.path}`
            : item.transport === 'http'
              ? item.url
              : [item.command, ...(item.args ?? [])].join(' ')}
        </p>
        {item.kind === 'mcp' && item.tools && (
          <p>
            {item.tools.length} 个功能{item.tools.some((tool) => !tool.readOnly) ? '' : '（声明为只读）'}
          </p>
        )}
        {item.kind === 'mcp' && item.error && (
          <p className="inline-error" role="alert">
            {item.error}
          </p>
        )}
        {unset.length > 0 && !editing && onSave && (
          <div className="ext-missing">
            <span>需要补充 {unset.length} 项连接设置</span>
            <button type="button" className="button secondary tiny" disabled={busy} onClick={startEditing}>
              补充设置
            </button>
          </div>
        )}
      </SettingsRow>
      {editing && onSave && (
        <SideSheet
          title={<span translate="no">{item.name}</span>}
          label={item.name}
          names
          onClose={() => {
            if (!saving) stopEditing();
          }}
        >
          <div className="ext-configure">
            <label className="field">
              <span>连接名称</span>
              <input
                aria-label={withNames('{0} 连接名称', [item.name])}
                data-names
                maxLength={80}
                value={name}
                disabled={saving}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <p className="ext-section-note">名称用于区分连接，不会改变登录账号。已有密钥不回显；留空会保留原值。</p>
            <div className="ext-needs ext-row-needs">
              {fields.map(([key, filled]) => (
                <label key={key}>
                  <span>{key}</span>
                  <input
                    type="password"
                    autoComplete="off"
                    disabled={saving}
                    placeholder={filled ? '已保存，输入新值以替换' : '需要填写'}
                    value={values[key] ?? ''}
                    onChange={(event) => setValues({ ...values, [key]: event.target.value })}
                  />
                </label>
              ))}
            </div>
            <div className="ext-configure-actions">
              <button type="button" className="button quiet tiny" disabled={saving} onClick={stopEditing}>
                取消
              </button>
              <button
                type="button"
                className="button secondary tiny"
                disabled={busy || saving || !name.trim() || unset.some((key) => !values[key]?.trim())}
                onClick={() => void save()}
              >
                {saving && <Loader2 size={12} className="spinning" />}保存连接
              </button>
            </div>
          </div>
        </SideSheet>
      )}
    </>
  );
}
