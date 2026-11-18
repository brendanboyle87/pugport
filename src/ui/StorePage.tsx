import { useCallback, useEffect, useRef, useState } from 'react';
import { ExternalLink, Loader2, Mic, Plus, Search, X } from 'lucide-react';
import type { ConversationModesView, ModLocalBuild } from '../shared/conversation-modes';
import { LocalBuildRow } from './LocalBuildRow';
import type { Conversation } from '../shared/types';
import {
  modManifestSchema,
  modPermissionsToApprove,
  normalizeModManifest,
  MOD_PACKAGE_MAX_BYTES,
  type ModManifest,
  type ModPermission,
} from '../shared/mods-manifest';
import { ModeIcon } from './mods/mod-icons';
import { ModResources, SavedModResources } from './ModResources';
import type { Api, Notice } from './Workspace';
import { confirmDialog } from './confirm-dialog';
import { saveSettings } from './settings-permissions';
import { ModeSourcePanel } from './ModeSourcePanel';
import type { ModeSourceView } from '../shared/mode-source';
import { renderMarkdown } from './markdown';
import fallbackCover from './assets/mod-cover.png';
import fallbackCard from './assets/mod-card.png';
import { friendlyModError, type FriendlyModError } from './mod-errors';
import { withNames } from './i18n';

import { selectStoreModes, type StoreMode as Mode } from '../shared/store-modes';
import { modPermissionText } from '../shared/mod-permission-copy';

function categoryLabel(category: string) {
  const labels: Record<string, string> = {
    productivity: '效率',
    writing: '写作',
    development: '开发',
    finance: '财务',
    utilities: '工具',
  };
  return labels[category.toLowerCase()] ?? category;
}
const approvalText = modPermissionText;

export function StorePage({
  api,
  notify,
  target,
  onOpenMod,
  onOpenConversation,
}: {
  api: Api;
  notify: (notice: Notice) => void;
  target?: { id: string; request: number };
  onOpenMod?: (mode: { id: string; version: string; title: string }) => Promise<void> | void;
  /** Opens a Mods author chat: Create a Mod and Edit in chat. */
  onOpenConversation?: (conversation: Conversation) => Promise<void> | void;
}) {
  const [tab, setTab] = useState<'discover' | 'installed'>('discover');
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [data, setData] = useState<ConversationModesView>();
  const [source, setSource] = useState<ModeSourceView>();
  const [sourceBusy, setSourceBusy] = useState(false);
  const sourceIdentity = JSON.stringify([source?.config, source?.revision]);
  const latestSource = useRef(sourceIdentity);
  latestSource.current = sourceIdentity;
  const acceptSource = useCallback((value: ModeSourceView) => {
    latestSource.current = JSON.stringify([value.config, value.revision]);
    setSource(value);
  }, []);
  const [error, setError] = useState<FriendlyModError>();
  const [cardErrors, setCardErrors] = useState<Record<string, FriendlyModError | undefined>>({});
  const clearCardError = (mode: Mode) =>
    setCardErrors((previous) => ({ ...previous, [`${mode.id}@${mode.version}`]: undefined }));
  const failCard = (mode: Mode, failure: unknown, context?: 'source' | 'open') =>
    setCardErrors((previous) => ({ ...previous, [`${mode.id}@${mode.version}`]: friendlyModError(failure, context) }));
  const [busy, setBusy] = useState(false);
  const [busyModKey, setBusyModKey] = useState<string>();
  const [detail, setDetail] = useState<Mode>();
  const selections = selectStoreModes(data, source);
  useEffect(() => {
    // Local previews can discover updates; remote previews keep the revision they first displayed.
    if (detail && !detail.sourceRevision) {
      const latest = selectStoreModes(data, source).get(detail.id)?.mode;
      if (latest) setDetail(latest);
    }
  }, [data, source, detail]);
  const updateAvailable = (mode: Mode) => !!selections.get(mode.id)?.updateAvailable;
  const updateCount = [...selections.values()].filter((item) => item.updateAvailable).length;
  const openedTarget = useRef<typeof target>(undefined);
  useEffect(() => {
    if (!target || !data || openedTarget.current === target) return;
    const selection = selectStoreModes(data, source).get(target.id);
    const mode = selection?.installation && selection.mode;
    if (mode) {
      openedTarget.current = target;
      setDetail(mode);
    }
  }, [data, source, target]);
  const [importOpen, setImportOpen] = useState(false);
  const [manifestText, setManifestText] = useState('');
  const fileSequence = useRef(0);
  const mounted = useRef(false);
  const operation = useRef(false);
  const sequence = useRef(0);
  const load = useCallback(async () => {
    const current = ++sequence.current;
    try {
      const value = await api<ConversationModesView>('/api/modes', undefined, 'GET');
      if (mounted.current && current === sequence.current) {
        setData(value);
        setError(undefined);
      }
    } catch (failure) {
      if (mounted.current && current === sequence.current) setError(friendlyModError(failure, 'list'));
    }
  }, [api]);
  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
      sequence.current++;
    };
  }, [load]);
  // Mods with voice use GPT Live when an OpenAI API card can pay for it; the user may keep voice on this computer.
  const [voice, setVoice] = useState<{ setting: 'gpt-live' | 'local'; available: boolean }>();
  const voiceMod = !!detail?.permissions?.includes('voice:session');
  useEffect(() => {
    if (!voiceMod) return;
    void api<{ setting: 'gpt-live' | 'local'; available: boolean }>('/api/voice/live/status', undefined, 'GET')
      .then((value) => mounted.current && setVoice(value))
      .catch(() => undefined);
  }, [api, voiceMod]);
  const chooseVoice = async (setting: 'gpt-live' | 'local') => {
    const previous = voice;
    setVoice((value) => value && { ...value, setting });
    try {
      await saveSettings(api, { modVoiceProvider: previous?.setting }, { modVoiceProvider: setting });
    } catch (failure) {
      if (!mounted.current) return;
      setVoice(previous);
      notify({ tone: 'error', message: friendlyModError(failure).text });
    }
  };
  const installed = (mode: Mode) => !!selections.get(mode.id)?.installation;
  const local = (mode: Mode) => !!data?.catalog.some((entry) => entry.id === mode.id && entry.version === mode.version);
  const remote = (mode: Mode) => !!mode.sourceRevision && !local(mode);
  const sourceRevision = (mode: Mode) => {
    if (!remote(mode)) return undefined;
    if (sourceBusy) throw new Error('正在更新来源，请稍后重试。');
    if (
      !source?.config?.enabled ||
      source.revision !== mode.sourceRevision ||
      source.config.repository !== mode.sourceRepository
    )
      throw new Error('来源已更新，请重新打开这个 Mod。');
    return mode.sourceRevision;
  };
  const importManifest = async () => {
    if (operation.current) return;
    operation.current = true;
    setBusy(true);
    setError(undefined);
    try {
      if (new Blob([manifestText]).size > MOD_PACKAGE_MAX_BYTES)
        throw Object.assign(new Error('模式清单不能超过 1 MiB。'), { status: 400 });
      const manifest: unknown = JSON.parse(manifestText);
      const value = await api<ConversationModesView>('/api/modes/import', { manifest });
      if (!mounted.current) return;
      sequence.current++;
      setData(value);
      setManifestText('');
      setImportOpen(false);
      notify({ tone: 'success', message: '已导入清单，可查看详情后加载。' });
    } catch (failure) {
      if (mounted.current)
        setError(
          friendlyModError(failure instanceof SyntaxError ? { message: failure.message, status: 400 } : failure),
        );
    } finally {
      operation.current = false;
      if (mounted.current) {
        setBusy(false);
        setBusyModKey(undefined);
      }
    }
  };
  const install = async (mode: Mode) => {
    if (operation.current) return;
    operation.current = true;
    setBusy(true);
    setBusyModKey(`${mode.id}@${mode.version}`);
    clearCardError(mode);
    try {
      if (!mode.compatible) throw { compatible: false, message: 'hostVersion is incompatible' };
      const revision = sourceRevision(mode);
      const identity = sourceIdentity;
      // Asked once here; chats on an older version then move to this one without asking again.
      const previous = data?.installed.find((item) => item.modeId === mode.id);
      const previousEntry =
        previous && data?.catalog.find((item) => item.id === mode.id && item.version === previous.version);
      const approve =
        previous?.version === mode.version
          ? []
          : modPermissionsToApprove(
              mode.permissions ?? [],
              previous && {
                permissions: previousEntry?.permissions ?? [],
                approved: previous.approvedPermissions ?? [],
              },
            );
      if (
        approve.length &&
        !(await confirmDialog({
          title: previous ? '更新「{0}」需要新的权限' : '允许「{0}」使用这些权限？',
          names: [mode.title],
          points: approve.map((item) => approvalText[item] ?? item),
          summary: previous ? '同意后，已在用这个 Mod 的对话都会换到新版本。' : undefined,
          action: '允许并加载',
        }))
      )
        return;
      const approved = approve.length ? { approvedPermissions: approve } : {};
      const value = await api<ConversationModesView>(
        revision ? '/api/modes/source/install' : `/api/modes/${encodeURIComponent(mode.id)}/install`,
        revision
          ? { id: mode.id, version: mode.version, revision, ...approved }
          : { version: mode.version, ...approved },
      );
      if (!mounted.current || (revision && latestSource.current !== identity)) return;
      sequence.current++;
      setData(value);
      notify({
        tone: 'success',
        message: previous ? '已更新，用这个 Mod 的对话会换到新版本。' : 'Mod 已加载。',
      });
    } catch (failure) {
      if (mounted.current) failCard(mode, failure, remote(mode) ? 'source' : undefined);
    } finally {
      operation.current = false;
      if (mounted.current) {
        setBusy(false);
        setBusyModKey(undefined);
      }
    }
  };
  const open = async (mode: Mode) => {
    if (operation.current || !onOpenMod) return;
    operation.current = true;
    setBusy(true);
    setBusyModKey(`${mode.id}@${mode.version}`);
    clearCardError(mode);
    try {
      await onOpenMod({ id: mode.id, version: mode.version, title: mode.title });
      if (mounted.current) setDetail(undefined);
    } catch (failure) {
      if (mounted.current) failCard(mode, failure, 'open');
    } finally {
      operation.current = false;
      if (mounted.current) {
        setBusy(false);
        setBusyModKey(undefined);
      }
    }
  };
  /** Store actions that open or touch a Mods author chat; failures show on the card like other Mod errors. */
  const authorAction = async (key: string, action: () => Promise<void>, mode?: Mode) => {
    if (operation.current) return;
    operation.current = true;
    setBusy(true);
    setBusyModKey(key);
    if (mode) clearCardError(mode);
    try {
      await action();
    } catch (failure) {
      if (!mounted.current) return;
      if (mode) failCard(mode, failure);
      else setError(friendlyModError(failure));
    } finally {
      operation.current = false;
      if (mounted.current) {
        setBusy(false);
        setBusyModKey(undefined);
      }
    }
  };
  // Like DSH's "let the agent create a plugin": a new chat in Mods author mode, no message sent.
  const createMod = () =>
    authorAction('create', async () => {
      const conversation = await api<Conversation>('/api/conversations', { title: '新 Mod' });
      const authored = await api<Conversation>(
        `/api/conversations/${encodeURIComponent(conversation.id)}`,
        { workMode: 'mods-author' },
        'PATCH',
      );
      await onOpenConversation?.(authored);
    });
  const editInChat = (mode: Mode, build: ModLocalBuild) =>
    authorAction(
      `${mode.id}@${mode.version}`,
      async () => {
        await onOpenConversation?.(
          await api<Conversation>(`/api/mod-workspaces/${encodeURIComponent(build.workspaceId)}/edit`, {}),
        );
      },
      mode,
    );
  // A Mod that came as JSON: PugPort unpacks it into a new Mods author chat's folder.
  const editImported = (mode: Mode) =>
    authorAction(
      `${mode.id}@${mode.version}`,
      async () => {
        await onOpenConversation?.(
          await api<Conversation>('/api/mod-workspaces/from-mod', { modeId: mode.id, version: mode.version }),
        );
        if (mounted.current) setDetail(undefined);
      },
      mode,
    );
  const revealBuild = (mode: Mode, build: ModLocalBuild) =>
    authorAction(
      `${mode.id}@${mode.version}`,
      async () => {
        await api(`/api/mod-workspaces/${encodeURIComponent(build.workspaceId)}/reveal`, {});
      },
      mode,
    );
  const exportJson = (mode: Mode) =>
    authorAction(
      `${mode.id}@${mode.version}`,
      async () => {
        const manifest = await api<ModManifest>(
          `/api/modes/${encodeURIComponent(mode.id)}/versions/${encodeURIComponent(mode.version)}/export`,
          undefined,
          'GET',
        );
        const url = URL.createObjectURL(new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' }));
        try {
          const anchor = document.createElement('a');
          anchor.href = url;
          anchor.download = `${mode.id}-${mode.version}.json`;
          anchor.click();
        } finally {
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        }
      },
      mode,
    );
  const detailRevision = detail && remote(detail) ? detail.sourceRevision : undefined;
  const detailKey =
    detail && JSON.stringify([detail.id, detail.version, detailRevision, detailRevision && sourceIdentity]);
  const [readme, setReadme] = useState<{
    key?: string;
    text?: string;
    permissions?: Mode['permissions'];
    error?: string;
  }>({});
  const [detailRetry, setDetailRetry] = useState(0);
  useEffect(() => {
    if (!detail || !detailKey) return;
    let current = true;
    const controller = new AbortController();
    const identity = sourceIdentity;
    setReadme({});
    void (async () => {
      try {
        const revision = sourceRevision(detail);
        const path = revision
          ? `/api/modes/source/${encodeURIComponent(detail.id)}/versions/${encodeURIComponent(detail.version)}/export?revision=${encodeURIComponent(revision)}`
          : `/api/modes/${encodeURIComponent(detail.id)}/versions/${encodeURIComponent(detail.version)}/export`;
        const value = modManifestSchema.parse(await api<ModManifest>(path, undefined, 'GET', controller.signal));
        if (value.id !== detail.id || value.version !== detail.version) throw new Error('返回的 Mod 版本不匹配。');
        if (current && (!revision || latestSource.current === identity))
          setReadme({
            key: detailKey,
            text: value.readme ?? '',
            permissions: normalizeModManifest(value).permissions ?? [],
          });
      } catch (failure) {
        console.warn('Could not load Mod description', failure);
        if (current)
          setReadme({ key: detailKey, error: friendlyModError(failure, detailRevision ? 'source' : undefined).text });
      }
    })();
    return () => {
      current = false;
      controller.abort();
    };
  }, [api, detailKey, detailRetry, !!detailRevision && sourceBusy]);
  const uninstall = async (mode: Mode) => {
    if (operation.current) return;
    operation.current = true;
    clearCardError(mode);
    try {
      if (
        !(await confirmDialog({
          title: '卸载「{0}」？',
          names: [mode.title],
          summary: '已有对话中的内容会保留。',
          action: '卸载',
          tone: 'danger',
        }))
      )
        return;
      if (!mounted.current) return;
      setBusy(true);
      setBusyModKey(`${mode.id}@${mode.version}`);
      const value = await api<ConversationModesView>(
        `/api/modes/${encodeURIComponent(mode.id)}/install`,
        undefined,
        'DELETE',
      );
      if (mounted.current) {
        sequence.current++;
        setData(value);
        setDetail(undefined);
        setError(undefined);
      }
    } catch (failure) {
      if (mounted.current) failCard(mode, failure);
    } finally {
      operation.current = false;
      if (mounted.current) {
        setBusy(false);
        setBusyModKey(undefined);
      }
    }
  };
  const catalog = new Map([...selections].map(([id, selection]) => [id, selection.mode]));
  const categories = [
    ...new Set([...catalog.values()].flatMap((mode) => (mode.category ? [mode.category] : []))),
  ].sort();
  const activeCategory = categories.includes(category) ? category : '';
  const query = search.trim().toLocaleLowerCase();
  const visible =
    [...catalog.values()].filter(
      (mode) =>
        (tab === 'discover' || installed(mode)) &&
        (!activeCategory || activeCategory === mode.category) &&
        (!query ||
          [
            mode.id,
            mode.title,
            mode.description,
            mode.author,
            mode.version,
            mode.category,
            mode.category && categoryLabel(mode.category),
          ].some((value) => value?.toLocaleLowerCase().includes(query))),
    ) ?? [];
  visible.sort(
    (a, b) =>
      categoryLabel(a.category ?? '').localeCompare(categoryLabel(b.category ?? '')) || a.title.localeCompare(b.title),
  );
  return (
    <div className="mode-store">
      <div className="store-toolbar">
        <label className="store-search">
          <Search size={18} aria-hidden="true" />
          <input
            type="search"
            aria-label="搜索 Mods"
            placeholder="搜索名称、作者或关键词"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        {onOpenConversation && (
          <button type="button" className="button primary" disabled={busy} onClick={() => void createMod()}>
            {busy && busyModKey === 'create' ? <Loader2 size={14} className="spinning" /> : <Plus size={15} />}
            创建 Mod
          </button>
        )}
        <button
          type="button"
          className="button secondary"
          disabled={busy}
          onClick={() => setImportOpen((value) => !value)}
        >
          导入 Mod
        </button>
      </div>
      <div className="store-filter-row">
        <div className="store-tabs" role="tablist" aria-label="Mods">
          {(['discover', 'installed'] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={tab === value}
              tabIndex={tab === value ? 0 : -1}
              onClick={() => setTab(value)}
              onKeyDown={(event) => {
                if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                  event.preventDefault();
                  setTab(value === 'discover' ? 'installed' : 'discover');
                  (
                    event.currentTarget.parentElement?.querySelectorAll('button')[value === 'discover' ? 1 : 0] as
                      HTMLButtonElement | undefined
                  )?.focus();
                }
              }}
            >
              {value === 'discover' ? '发现' : '已加载'}
              {value === 'installed' && updateCount > 0 && <span className="plan-badge">{updateCount}</span>}
            </button>
          ))}
        </div>
        {categories.length > 0 && (
          <div className="store-categories" role="group" aria-label="分类">
            {['', ...categories].map((value) => (
              <button key={value} type="button" aria-pressed={category === value} onClick={() => setCategory(value)}>
                {value ? categoryLabel(value) : '全部'}
              </button>
            ))}
          </div>
        )}
        <ModeSourcePanel api={api} onSource={acceptSource} onBusyChange={setSourceBusy} />
      </div>
      {data && <SavedModResources api={api} notify={notify} modes={data} />}
      {error && (
        <div className="store-error" role="alert">
          <span>{error.text}</span>
          <CopyModDetails detail={error.detail} />
          <button type="button" className="button secondary" disabled={busy} onClick={() => void load()}>
            重试
          </button>
        </div>
      )}
      {importOpen && (
        <section className="store-import" aria-label="导入 Mod">
          <label htmlFor="mode-manifest">模式清单 JSON</label>
          <p>清单只导入这台电脑，不会上传到云端。只接受声明式界面和输入操作，不运行代码，不会自动安装或调用模型。</p>
          <textarea
            id="mode-manifest"
            rows={7}
            value={manifestText}
            maxLength={MOD_PACKAGE_MAX_BYTES}
            disabled={busy}
            spellCheck={false}
            onChange={(event) => {
              fileSequence.current++;
              setManifestText(event.target.value);
            }}
          />
          <div className="store-import-actions">
            <label className="store-file">
              从 JSON 文件读取
              <input
                type="file"
                accept=".json,application/json"
                disabled={busy}
                onChange={async (event) => {
                  const file = event.target.files?.[0];
                  if (!file) return;
                  const current = ++fileSequence.current;
                  try {
                    if (file.size > MOD_PACKAGE_MAX_BYTES) throw new Error('模式清单不能超过 1 MiB。');
                    const content = await file.text();
                    if (mounted.current && current === fileSequence.current) setManifestText(content);
                  } catch (failure) {
                    if (mounted.current && current === fileSequence.current) setError(friendlyModError(failure));
                  }
                  event.target.value = '';
                }}
              />
            </label>
            <button
              type="button"
              className="button primary"
              disabled={busy || !manifestText.trim()}
              onClick={() => void importManifest()}
            >
              导入清单
            </button>
          </div>
        </section>
      )}
      {!data && !error && (
        <p role="status">
          <Loader2 className="spinning" size={16} />
          正在加载模式…
        </p>
      )}
      {(data || catalog.size > 0) && (
        <section className="store-section" aria-label="对话模式">
          {!visible.length && (
            <p className="store-empty">
              {query || category
                ? '没有找到匹配的 Mods。试试其他关键词或分类。'
                : tab === 'discover'
                  ? '这里还没有 Mods。导入本机 JSON 清单即可开始。'
                  : '还没有加载 Mods。在“发现”中选择或导入 Mod。'}
            </p>
          )}
          <div className="store-card-grid store-modes">
            {visible.map((mode) => (
              <article className="store-card store-mode-card" key={`${mode.id}:${mode.version}`}>
                <button
                  type="button"
                  className="store-cover-button"
                  aria-label={withNames('查看「{0}」详情', [mode.title])}
                  aria-haspopup="dialog"
                  onClick={() => setDetail(mode)}
                >
                  <ModeCover mode={mode} />
                </button>
                <div className="store-mode-copy">
                  <div className="store-mode-title">
                    <ModeIcon mode={mode} size={16} />
                    <h4>
                      <button type="button" aria-haspopup="dialog" onClick={() => setDetail(mode)}>
                        {mode.title}
                      </button>
                    </h4>
                    {selections.get(mode.id)?.localBuild && (
                      <span className="store-local-tag" title="在这台电脑上从 Mod 工作文件夹构建">
                        本地构建
                      </span>
                    )}
                  </div>
                  <p
                    className="store-mode-description"
                    role={cardErrors[`${mode.id}@${mode.version}`] ? 'alert' : undefined}
                  >
                    {cardErrors[`${mode.id}@${mode.version}`]?.text ?? mode.description}
                  </p>
                </div>
                <div className="store-card-actions">
                  <small>{mode.author || '作者未提供'}</small>
                  {updateAvailable(mode) && <span className="plan-badge">有更新</span>}
                  <button
                    type="button"
                    className={updateAvailable(mode) ? 'button tiny primary' : 'button tiny'}
                    disabled={
                      busy || (remote(mode) && sourceBusy) || (installed(mode) && !updateAvailable(mode) && !onOpenMod)
                    }
                    onClick={() => void (installed(mode) && !updateAvailable(mode) ? open(mode) : install(mode))}
                  >
                    {busy && busyModKey === `${mode.id}@${mode.version}` && <Loader2 size={14} className="spinning" />}
                    {updateAvailable(mode) ? '更新' : installed(mode) ? '打开' : '加载'}
                  </button>
                </div>
                {tab === 'installed' && selections.get(mode.id)?.localBuild && (
                  <LocalBuildRow
                    mode={mode}
                    build={selections.get(mode.id)!.localBuild!}
                    disabled={busy}
                    onEdit={onOpenConversation ? (build) => void editInChat(mode, build) : undefined}
                    onReveal={(build) => void revealBuild(mode, build)}
                    onExport={() => void exportJson(mode)}
                  />
                )}
              </article>
            ))}
          </div>
        </section>
      )}
      {detail && (
        <ModeDetail
          api={api}
          notify={notify}
          mode={detail}
          installed={installed(detail)}
          updateFrom={updateAvailable(detail) ? selections.get(detail.id)?.installation?.version : undefined}
          busy={busy && busyModKey === `${detail.id}@${detail.version}`}
          disabled={busy || (remote(detail) && sourceBusy)}
          error={cardErrors[`${detail.id}@${detail.version}`]}
          onClose={() => setDetail(undefined)}
          onLoad={() => void install(detail)}
          onOpen={onOpenMod ? () => void open(detail) : undefined}
          onUninstall={() => void uninstall(detail)}
          onEditInChat={
            onOpenConversation && installed(detail) && detail.schemaVersion === 2
              ? () => {
                  const build = selections.get(detail.id)?.localBuild;
                  void (build ? editInChat(detail, build) : editImported(detail));
                }
              : undefined
          }
          readme={readme.key === detailKey ? readme.text : undefined}
          readmeError={readme.key === detailKey ? readme.error : undefined}
          permissions={
            readme.key === detailKey && readme.permissions
              ? readme.permissions
              : detail.schemaVersion === 2
                ? (detail.permissions ?? [])
                : undefined
          }
          onRetry={() => setDetailRetry((value) => value + 1)}
          voice={voiceMod && voice?.available ? { setting: voice.setting, choose: chooseVoice } : undefined}
        />
      )}
    </div>
  );
}

function ModeDetail({
  api,
  notify,
  mode,
  installed,
  updateFrom,
  busy,
  disabled,
  error,
  onClose,
  onLoad,
  onOpen,
  onUninstall,
  onEditInChat,
  readme,
  readmeError,
  permissions,
  onRetry,
  voice,
}: {
  api: Api;
  notify: (notice: Notice) => void;
  mode: Mode;
  installed: boolean;
  updateFrom?: string;
  busy: boolean;
  disabled: boolean;
  error?: FriendlyModError;
  onClose: () => void;
  onLoad: () => void;
  onOpen?: () => void;
  onUninstall: () => void;
  /** Opens a Mods author chat for this Mod: its Local build folder, or a new one unpacked from the JSON. */
  onEditInChat?: () => void;
  readme?: string;
  readmeError?: string;
  permissions?: Mode['permissions'];
  onRetry: () => void;
  /** Shared by every Mod with voice: GPT Live on the OpenAI card, or this computer. */
  voice?: { setting: 'gpt-live' | 'local'; choose(setting: 'gpt-live' | 'local'): void };
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const element = dialog.current;
    element?.showModal();
    return () => {
      element?.close();
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return (
    <dialog className="store-drawer" ref={dialog} onCancel={onClose} aria-label={mode.title}>
      <button type="button" className="icon-button store-detail-close" aria-label="关闭详情" onClick={onClose}>
        <X size={16} />
      </button>
      <ModeCover mode={mode} detail />
      <div className="store-drawer-heading">
        <ModeIcon mode={mode} size={24} />
        <div className="store-detail-title">
          <h2 translate="no">{mode.title}</h2>
          <p>{mode.description}</p>
        </div>
        <button
          type="button"
          className="button primary"
          disabled={disabled || (installed && !updateFrom && !onOpen)}
          onClick={installed && !updateFrom ? onOpen : onLoad}
          autoFocus
        >
          {busy && <Loader2 className="spinning" size={14} />}
          {updateFrom ? withNames('更新到 {0}', [mode.version]) : installed ? '打开' : '加载'}
        </button>
      </div>
      {error && (
        <div className="store-detail-error" role="alert">
          <span>{error.text}</span>
          <CopyModDetails detail={error.detail} />
        </div>
      )}
      <div className="store-detail-layout">
        <section className="store-detail-description" aria-label="Mod 说明">
          {readmeError ? (
            <div className="store-detail-load-error" role="alert">
              <p>说明暂时读不到</p>
              <button type="button" className="button secondary" onClick={onRetry}>
                重试
              </button>
            </div>
          ) : readme === undefined ? (
            <p className="store-detail-loading" role="status">
              <Loader2 size={14} className="spinning" />
              正在读取说明…
            </p>
          ) : readme ? (
            <div className="store-readme">{renderMarkdown(readme)}</div>
          ) : null}
        </section>
        <aside className="store-detail-sidebar">
          <dl>
            <dt>发布者</dt>
            <dd>{mode.author ?? '作者未提供'}</dd>
            <dt>版本</dt>
            <dd>{mode.version}</dd>
            <dt>分类</dt>
            <dd>{mode.category ? categoryLabel(mode.category) : '其他 Mods'}</dd>
            <dt>来源</dt>
            <dd>{mode.sourceRepository ? `GitHub · ${mode.sourceRepository}` : '本机'}</dd>
          </dl>
          {permissions && (
            <p className="store-detail-note store-detail-access">
              {permissions.includes('chat:read')
                ? permissions.includes('composer:draft')
                  ? '可以读取这个对话的消息，并在输入框里填写草稿；不会代你发送。'
                  : '可以读取这个对话的消息；不会填写草稿或代你发送。'
                : permissions.includes('composer:draft')
                  ? '可以在输入框里填写草稿；不会读取消息或代你发送。'
                  : '不会读取消息、填写草稿或代你发送。'}
              {permissions.includes('model:run') && <> {approvalText['model:run']}</>}
              {permissions.includes('voice:session') && <> {approvalText['voice:session']}</>}
              {permissions.includes('connections:read') && <> {approvalText['connections:read']}</>}
              {permissions.includes('data:store') && <> {approvalText['data:store']}</>}
            </p>
          )}
          {voice && (
            <label className="store-voice">
              <Mic size={15} aria-hidden="true" />
              <span>Mod 语音</span>
              <select
                value={voice.setting}
                onChange={(event) => voice.choose(event.target.value === 'local' ? 'local' : 'gpt-live')}
              >
                <option value="gpt-live">GPT Live</option>
                <option value="local">本机</option>
              </select>
            </label>
          )}
          {mode.homepage && (
            <a className="store-detail-website" href={mode.homepage} target="_blank" rel="noopener noreferrer">
              介绍网页 <ExternalLink size={14} />
            </a>
          )}
          {installed &&
            mode.permissions?.some(
              (permission) => permission === 'connections:read' || permission === 'data:store',
            ) && (
              <ModResources
                key={mode.id}
                api={api}
                notify={notify}
                modId={mode.id}
                title={mode.title}
                permissions={mode.permissions}
              />
            )}
          {updateFrom && (
            <p className="store-detail-note">{withNames('有可用更新：{0} → {1}', [updateFrom, mode.version])}</p>
          )}
          {onEditInChat && (
            <button type="button" className="store-detail-edit" disabled={disabled} onClick={onEditInChat}>
              在对话中编辑
            </button>
          )}
          {installed && (
            <button type="button" className="store-detail-uninstall" disabled={disabled} onClick={onUninstall}>
              卸载
            </button>
          )}
        </aside>
      </div>
    </dialog>
  );
}

function ModeCover({ mode, detail = false }: { mode: Mode; detail?: boolean }) {
  const art = detail ? mode.cover : (mode.card ?? mode.cover);
  const fallback = detail ? fallbackCover : fallbackCard;
  // A 16:9 cover in the 4:3 grid is shown whole over a blurred copy, so no Mod loses the edges of its art.
  const wide = !detail && !mode.card && !!mode.cover;
  const image = (
    <img
      className={wide ? 'store-mode-cover store-mode-cover-wide' : 'store-mode-cover'}
      src={art?.src ?? fallback}
      alt={art?.alt ?? `${mode.title} Mod 封面`}
      width={detail || wide ? 960 : 480}
      height={detail || wide ? 540 : 360}
      loading={detail ? 'eager' : 'lazy'}
      decoding="async"
      onError={(event) => {
        if (event.currentTarget.dataset.fallback !== 'true') {
          event.currentTarget.dataset.fallback = 'true';
          event.currentTarget.src = fallback;
        }
      }}
    />
  );
  if (!wide) return image;
  return (
    <span className="store-mode-cover-frame">
      <img className="store-mode-cover-backdrop" src={art!.src} alt="" aria-hidden="true" decoding="async" />
      {image}
    </span>
  );
}

export function CopyModDetails({ detail }: { detail: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <button
      type="button"
      className="store-copy-details"
      onClick={() => {
        void navigator.clipboard
          .writeText(detail)
          .then(() => setCopied(true))
          .catch(() => undefined);
      }}
    >
      {copied ? '已复制' : '复制详情'}
    </button>
  );
}
