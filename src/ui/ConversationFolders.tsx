import { useEffect, useRef, useState, type ReactNode, type KeyboardEvent } from 'react';
import { ChevronDown, ChevronRight, Tag, Tags, Loader2, MoreHorizontal, Sparkles } from 'lucide-react';
import type { AppState, Conversation } from '../shared/types';
import type { ClassificationJob, ConversationFolder } from '../shared/conversation-folders';
import type { Api, Notice } from './Workspace';
import { conversationDragType } from './SplitView';
import { ContextMenu } from './DesktopFeatures';
import { shownTitle, withNames } from './i18n';

type Common = { api: Api; reload: () => Promise<unknown>; notify: (notice: Notice) => void };
// Not `instanceof Error`: an error made in another realm (a test harness, a pop-out window) still has a message.
const errorText = (error: unknown) =>
  typeof (error as { message?: unknown } | null)?.message === 'string'
    ? (error as { message: string }).message
    : String(error);
// A new key: ids saved by the old preview dialog must not look like a running organize after an update.
const classificationKey = 'pugport-chat-organize-running';
try {
  localStorage.removeItem('pugport-chat-classification-job');
} catch {}
const lastClassificationKey = 'pugport-chat-classification-last-applied';
function savedClassification(key: string): string | undefined {
  try {
    const id = localStorage.getItem(key);
    return id && /^[\w-]{1,100}$/.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}
function rememberClassification(key: string, id?: string) {
  try {
    if (id) localStorage.setItem(key, id);
    else localStorage.removeItem(key);
  } catch {}
}

/** Translate each count separately so omitted zero counts and English singulars remain natural. */
function organizedMessage(job: ClassificationJob) {
  return [
    job.changed && withNames(job.changed === 1 ? '已整理 1 个对话' : '已整理 {0} 个对话', [String(job.changed)]),
    job.renamed && withNames('已重命名 {0} 个', [String(job.renamed)]),
    job.createdFolders &&
      withNames(job.createdFolders === 1 ? '新建 1 个分类' : '新建 {0} 个分类', [String(job.createdFolders)]),
  ]
    .filter(Boolean)
    .join(' · ');
}

function useChatOrganizer({ api, reload, notify }: Common, total: number) {
  const [job, setJob] = useState<ClassificationJob>();
  const [resumeId, setResumeId] = useState(() => savedClassification(classificationKey));
  const [lastJob, setLastJob] = useState<ClassificationJob>();
  const [submitting, setSubmitting] = useState(false);
  const current = useRef<ClassificationJob | undefined>(undefined);
  const pending = useRef(false),
    mounted = useRef(true),
    generation = useRef(0);
  const stopAfterStart = useRef(false),
    reported = useRef(new Set<string>()),
    lastError = useRef('');
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, []);
  function runningNotice(count = current.current?.total ?? total) {
    notify({
      tone: 'info',
      message: count === 1 ? '正在整理 1 个对话…' : '正在整理 {0} 个对话…',
      names: [String(count)],
      action: { label: '停止', run: () => cancel() },
    });
  }
  function accept(next: ClassificationJob, showRunning = false) {
    current.current = next;
    setJob(next);
    setResumeId(undefined);
    lastError.current = '';
    if (next.status === 'running') {
      rememberClassification(classificationKey, next.id);
      if (showRunning) runningNotice(next.total);
      return;
    }
    const resultKey = `${next.id}:${next.status}`;
    if (reported.current.has(resultKey)) return;
    reported.current.add(resultKey);
    if (next.status === 'applied') {
      // Only a job that changed something becomes "the last organize" that undo targets.
      if (next.changed) {
        setLastJob(next);
        rememberClassification(lastClassificationKey, next.id);
      }
      notify(
        next.changed
          ? {
              tone: 'success',
              message: organizedMessage(next),
              names: [],
              action: { label: '撤销', run: () => undo(next.id) },
            }
          : { tone: 'info', message: '对话已经很整齐了。' },
      );
      void reload().catch((error) => notify({ tone: 'error', message: errorText(error) }));
    } else if (next.status === 'failed') {
      notify({ tone: 'error', message: next.error || '分类失败，请重试。' });
    } else if (next.status === 'cancelled') {
      notify({ tone: 'info', message: '已停止整理。' });
    } else if (next.status === 'undone') {
      setLastJob(undefined);
      rememberClassification(lastClassificationKey);
      notify({ tone: 'success', message: '已撤销本次整理，保留之后的手动调整。' });
      void reload().catch((error) => notify({ tone: 'error', message: errorText(error) }));
    }
    // A completed job is remembered only for undo, never replayed as a result toast on reload.
    rememberClassification(classificationKey);
  }
  async function restoreLastJob() {
    const id = savedClassification(lastClassificationKey);
    if (!id || lastJob?.id === id) return;
    try {
      const value = await api<ClassificationJob>(
        `/api/conversation-folders/jobs/${encodeURIComponent(id)}`,
        undefined,
        'GET',
      );
      if (!mounted.current || savedClassification(lastClassificationKey) !== id) return;
      if (value.status === 'applied') setLastJob(value);
      else rememberClassification(lastClassificationKey);
    } catch {
      /* Keep the undo id and retry when its menu is opened. */
    }
  }
  useEffect(() => {
    void restoreLastJob();
  }, [api]);
  useEffect(() => {
    const id = resumeId ?? (job?.status === 'running' ? job.id : undefined);
    if (!id) return;
    let disposed = false,
      inFlight = false;
    const poll = async () => {
      if (inFlight || pending.current) return;
      inFlight = true;
      const request = generation.current;
      try {
        const next = await api<ClassificationJob>(
          `/api/conversation-folders/jobs/${encodeURIComponent(id)}`,
          undefined,
          'GET',
        );
        if (!disposed && mounted.current && request === generation.current) accept(next, !!resumeId);
      } catch (error) {
        if (!disposed && mounted.current && request === generation.current) {
          const message = errorText(error);
          if (message !== lastError.current) notify({ tone: 'error', message });
          lastError.current = message;
          if (/不存在|404/.test(message)) {
            rememberClassification(classificationKey);
            setResumeId(undefined);
            setJob(undefined);
            current.current = undefined;
          }
        }
      } finally {
        inFlight = false;
      }
    };
    if (resumeId) void poll();
    const timer = setInterval(() => void poll(), 1500);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [resumeId, job?.id, job?.status, api]);
  async function mutate(path: string) {
    if (pending.current) return;
    pending.current = true;
    const request = ++generation.current;
    try {
      const next = await api<ClassificationJob>(path, {});
      if (mounted.current && request === generation.current) accept(next);
    } catch (error) {
      if (mounted.current && request === generation.current) notify({ tone: 'error', message: errorText(error) });
    } finally {
      pending.current = false;
    }
  }
  async function cancel() {
    if (pending.current) {
      stopAfterStart.current = true;
      return;
    }
    const id = current.current?.status === 'running' ? current.current.id : resumeId;
    if (id) await mutate(`/api/conversation-folders/jobs/${encodeURIComponent(id)}/cancel`);
  }
  async function undo(id: string) {
    // Not `resumeId`: a result toast made right after a reload holds a stale render's value.
    if (pending.current || current.current?.status === 'running') return;
    await mutate(`/api/conversation-folders/jobs/${encodeURIComponent(id)}/undo`);
  }
  async function start(includeFiled = false) {
    if (pending.current || resumeId || current.current?.status === 'running') {
      runningNotice();
      return;
    }
    pending.current = true;
    stopAfterStart.current = false;
    setSubmitting(true);
    const request = ++generation.current;
    try {
      const next = await api<ClassificationJob>(
        '/api/conversation-folders/classify',
        includeFiled ? { includeFiled: true } : {},
      );
      if (mounted.current && request === generation.current) accept(next, true);
    } catch (error) {
      if (mounted.current && request === generation.current) {
        notify({ tone: 'error', message: errorText(error) });
      }
    } finally {
      pending.current = false;
      if (mounted.current && request === generation.current) {
        setSubmitting(false);
        if (stopAfterStart.current) void cancel();
      }
    }
  }
  return { running: submitting || !!resumeId || job?.status === 'running', start, lastJob, undo, restoreLastJob };
}
/** Keep keyboard navigation in these small dialogs; Escape has the same meaning as their close button. */
function dialogKeys(event: KeyboardEvent<HTMLElement>, close: () => void, busy: boolean) {
  if (event.key === 'Escape') {
    event.stopPropagation();
    if (!busy) close();
    return;
  }
  if (event.key !== 'Tab') return;
  const items = [
    ...event.currentTarget.querySelectorAll<HTMLElement>(
      'button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex="0"]',
    ),
  ];
  const first = items[0],
    last = items[items.length - 1];
  if (!first || !last) return;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

export function ChatFolders({
  chats,
  state,
  row,
  api,
  reload,
  notify,
  onVisibleOrder,
  filtering = false,
  selectedId,
  onHeadingMenu,
}: Common & {
  chats: Conversation[];
  state: AppState;
  row: (chat: Conversation, icon?: boolean) => ReactNode;
  onVisibleOrder: (ids: string[]) => void;
  filtering?: boolean;
  selectedId?: string;
  onHeadingMenu?: (event: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  const folders = [...(state.conversationFolders ?? [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const [collapsed, setCollapsed] = useState<string[]>(() => {
    try {
      const value = JSON.parse(localStorage.getItem('pugport-chat-folders-collapsed') ?? '[]');
      return Array.isArray(value) ? value.filter((v) => typeof v === 'string') : [];
    } catch {
      return [];
    }
  });
  const [editing, setEditing] = useState<ConversationFolder | 'new'>();
  const [deleting, setDeleting] = useState<ConversationFolder>();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const organizer = useChatOrganizer({ api, reload, notify }, chats.length);
  const [organizeMenu, setOrganizeMenu] = useState<{ x: number; y: number }>();
  const [menu, setMenu] = useState<{ x: number; y: number; folder: ConversationFolder }>();
  const [dragTarget, setDragTarget] = useState<string>();
  const unfiled = chats.filter((c) => !c.pinnedAt && !folders.some((f) => f.id === c.folderId));
  const inFolder = (id: string) => chats.filter((c) => !c.pinnedAt && c.folderId === id);
  const selectedFolder = chats.find((item) => item.id === selectedId && !item.pinnedAt)?.folderId;
  useEffect(() => {
    if (selectedFolder) setCollapsed((old) => old.filter((id) => id !== selectedFolder));
  }, [selectedId, selectedFolder]);
  const isCollapsed = (id: string) => collapsed.includes(id);
  const visible = [...folders.flatMap((f) => (isCollapsed(f.id) ? [] : inFolder(f.id))), ...unfiled].map((c) => c.id);
  const visibleKey = visible.join(',');
  useEffect(() => {
    onVisibleOrder(visible);
  }, [visibleKey]);
  function toggle(id: string) {
    setCollapsed((old) => {
      const next = old.includes(id) ? old.filter((v) => v !== id) : [...old, id];
      try {
        localStorage.setItem('pugport-chat-folders-collapsed', JSON.stringify(next));
      } catch {}
      return next;
    });
  }
  async function action(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      await reload();
      setEditing(undefined);
      setDeleting(undefined);
    } catch (error) {
      notify({ tone: 'error', message: errorText(error) });
    } finally {
      setBusy(false);
    }
  }
  function dropProps(id = '') {
    return {
      onDragOver: (event: React.DragEvent) => {
        if (event.dataTransfer.types.includes(conversationDragType)) {
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
          setDragTarget(id);
        }
      },
      onDragLeave: (event: React.DragEvent) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragTarget(undefined);
      },
      onDrop: (event: React.DragEvent) => {
        const chatId = event.dataTransfer.getData(conversationDragType);
        if (!chatId) return;
        event.preventDefault();
        event.stopPropagation();
        setDragTarget(undefined);
        if (!chats.some((c) => c.id === chatId)) {
          notify({ tone: 'error', message: '这里只整理普通对话，项目对话保留在项目内。' });
          return;
        }
        void action(() => api(`/api/conversations/${chatId}/folder`, { folderId: id || null }, 'PATCH'));
      },
    };
  }
  return (
    <div className="general-conversations chat-folders">
      {(!filtering || chats.some((item) => !item.pinnedAt)) && (
        <div className="project-heading">
          <span>对话</span>
          <div className="folder-heading-actions">
            {onHeadingMenu && (
              <button
                type="button"
                className="icon-button"
                title="对话列表操作"
                aria-label="对话列表操作"
                aria-haspopup="menu"
                onClick={onHeadingMenu}
              >
                <MoreHorizontal size={14} />
              </button>
            )}
            <button
              className="icon-button"
              title="整理对话"
              aria-label="整理对话"
              onClick={(event) => {
                if (event.shiftKey) {
                  void organizer.restoreLastJob();
                  setOrganizeMenu({ x: event.clientX, y: event.clientY });
                } else void organizer.start();
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                void organizer.restoreLastJob();
                setOrganizeMenu({ x: event.clientX, y: event.clientY });
              }}
            >
              {organizer.running ? <Loader2 size={14} className="spinning" /> : <Sparkles size={14} />}
            </button>
            <button
              className="icon-button"
              title="新建分类"
              aria-label="新建对话分类"
              onClick={() => {
                setName('');
                setEditing('new');
              }}
            >
              <Tags size={15} />
            </button>
          </div>
        </div>
      )}
      {folders
        .filter((folder) => !filtering || inFolder(folder.id).length)
        .map((folder) => (
          <section
            key={folder.id}
            className={`chat-folder ${dragTarget === folder.id ? 'drag-over' : ''}`}
            {...dropProps(folder.id)}
          >
            <div className="chat-folder-heading">
              <button
                className="chat-folder-toggle"
                aria-expanded={!isCollapsed(folder.id)}
                onClick={() => toggle(folder.id)}
              >
                {isCollapsed(folder.id) ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                <Tag size={14} className="chat-category-icon" />
                <span translate="no">{folder.name}</span>
                <small>{chats.filter((c) => c.folderId === folder.id).length}</small>
              </button>
              <button
                className="icon-button"
                aria-label={withNames('分类 {0} 的操作', [folder.name])}
                data-names
                onClick={(e) => setMenu({ x: e.clientX, y: e.clientY, folder })}
              >
                <MoreHorizontal size={14} />
              </button>
            </div>
            {!isCollapsed(folder.id) && (
              <div className="chat-folder-rows">
                {inFolder(folder.id).map((c) => row(c))}
                {!inFolder(folder.id).length && (
                  <small className="folder-empty">
                    {chats.some((c) => c.folderId === folder.id && c.pinnedAt)
                      ? '该分类的对话已显示在置顶区'
                      : '拖入对话即可分类'}
                  </small>
                )}
              </div>
            )}
          </section>
        ))}
      {(!filtering || unfiled.length > 0) && (
        <section className={`unfiled-chats ${dragTarget === '' ? 'drag-over' : ''}`} {...dropProps()}>
          {!!folders.length && (
            <div className="unfiled-label">
              未分类 <small>{unfiled.length}</small>
            </div>
          )}
          {unfiled.map((c) => row(c, true))}
          {!unfiled.length && (
            <small className="folder-empty">{folders.length ? '可拖到这里取消分类' : '新对话会出现在这里'}</small>
          )}
        </section>
      )}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(undefined)}
          items={[
            {
              label: '重命名分类',
              onSelect: () => {
                setName(menu.folder.name);
                setEditing(menu.folder);
              },
            },
            { label: '删除分类，保留对话', danger: true, onSelect: () => setDeleting(menu.folder) },
          ]}
        />
      )}
      {organizeMenu && (
        <ContextMenu
          x={organizeMenu.x}
          y={organizeMenu.y}
          onClose={() => setOrganizeMenu(undefined)}
          items={[
            { label: '也整理已分类的对话', onSelect: () => void organizer.start(true) },
            {
              label: '撤销上次整理',
              disabled: organizer.running || organizer.lastJob?.status !== 'applied',
              onSelect: () => {
                if (organizer.lastJob) void organizer.undo(organizer.lastJob.id);
              },
            },
          ]}
        />
      )}
      {(editing || deleting) && (
        <div className="modal-backdrop">
          <form
            className="modal folder-dialog"
            role="dialog"
            aria-modal="true"
            onKeyDown={(event) =>
              dialogKeys(
                event,
                () => {
                  setEditing(undefined);
                  setDeleting(undefined);
                },
                busy,
              )
            }
            aria-label={deleting ? '删除分类' : editing === 'new' ? '新建分类' : '重命名分类'}
            onSubmit={(event) => {
              event.preventDefault();
              if (busy) return;
              void action(() =>
                deleting
                  ? api(`/api/conversation-folders/${deleting.id}`, {}, 'DELETE')
                  : editing === 'new'
                    ? api('/api/conversation-folders', { name })
                    : api(`/api/conversation-folders/${editing!.id}`, { name }, 'PATCH'),
              );
            }}
          >
            <h3>{deleting ? '删除分类' : editing === 'new' ? '新建分类' : '重命名分类'}</h3>
            {deleting ? (
              <p translate="no">
                {withNames('删除「{0}」后，对话将回到未分类，内容和置顶状态都会保留。', [deleting.name])}
              </p>
            ) : (
              <label>
                分类名称
                <input
                  autoFocus
                  value={name}
                  maxLength={60}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="例如：学习、生活、工作"
                />
              </label>
            )}
            <div className="modal-actions">
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => {
                  setEditing(undefined);
                  setDeleting(undefined);
                }}
              >
                取消
              </button>
              <button disabled={busy || (!deleting && !name.trim())}>
                {busy ? <Loader2 size={14} className="spinning" /> : deleting ? '删除分类' : '保存'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

export function FolderMoveDialog({
  chat,
  folders,
  api,
  reload,
  notify,
  onClose,
}: Common & { chat: Conversation; folders: ConversationFolder[]; onClose: () => void }) {
  const [value, setValue] = useState(chat.folderId ?? '');
  const [busy, setBusy] = useState(false);
  return (
    <div className="modal-backdrop">
      <form
        className="modal folder-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="移动到分类"
        onKeyDown={(event) => dialogKeys(event, onClose, busy)}
        onSubmit={async (e) => {
          e.preventDefault();
          if (busy) return;
          setBusy(true);
          try {
            await api(`/api/conversations/${chat.id}/folder`, { folderId: value || null }, 'PATCH');
            await reload();
            onClose();
          } catch (error) {
            notify({ tone: 'error', message: errorText(error) });
          } finally {
            setBusy(false);
          }
        }}
      >
        <h3>移动到分类</h3>
        <p className="folder-move-title" translate="no">
          {shownTitle(chat.title)}
        </p>
        <label>
          分类
          <select autoFocus value={value} onChange={(e) => setValue(e.target.value)}>
            <option value="">未分类</option>
            {folders.map((f) => (
              <option key={f.id} value={f.id} translate="no">
                {f.name}
              </option>
            ))}
          </select>
        </label>
        {!folders.length && <p>先用侧栏“对话”旁的标签按钮新建分类。</p>}
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button disabled={busy}>移动</button>
        </div>
      </form>
    </div>
  );
}
