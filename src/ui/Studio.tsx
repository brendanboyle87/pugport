import { ProblemReporter } from './ProblemReport';
import { saveSettings } from './settings-permissions';
import type { Settings } from '../shared/types';
import { useRadioKeys } from './use-radio-keys';
import { InboxButton } from './InboxPanel';
import { NeedsYou } from './NeedsYou';
import { CursorImportDialog } from './CursorImportDialog';
import { ClaudeHistoryImport } from './ClaudeHistoryImport';
import { IncognitoLabel } from './IncognitoLabel';
import { exportConversation } from './conversation-export';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { noticeResolved } from './notice-lifecycle';
import { useUiUpdateBlocker } from './ui-update-guard';
import { executionModel } from '../shared/execution-model';
import { listedRemovedProjects } from '../shared/removed-projects';
import { SearchDialog } from './SearchDialog';
import { ConversationArchive, archiveConversation, restoreConversation } from './ConversationArchive';
import { confirmDialog } from './confirm-dialog';
import type { ConversationSearchResult } from '../shared/search';
import {
  executionRecordGroups,
  executionRecordRows,
  executionUserInput,
  executionWorkflowRuns,
} from './execution-records';
import { activityLabel, localActivity } from '../shared/background-activity';
import {
  Activity,
  VenetianMask,
  AlertCircle,
  AppWindow,
  Archive,
  Columns2,
  Copy,
  Download,
  Keyboard,
  Mail,
  MailOpen,
  Pin,
  PinOff,
  PanelLeftClose,
  PanelLeftOpen,
  ArrowUpRight,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FolderOpen,
  GitBranch,
  ListTodo,
  Loader2,
  Menu,
  MoreHorizontal,
  MessageSquare,
  Pencil,
  Trash2,
  Monitor,
  Moon,
  Plus,
  Search,
  Blocks,
  ShieldCheck,
  Settings as SettingsIcon,
  Sun,
  X,
} from 'lucide-react';
import type { AppState, Conversation, Project, RunRecord } from '../shared/types';
import { canAttachMod } from '../shared/conversation-modes';
import { canUseConversationCollaboration } from '../shared/conversation-collaboration';
import type { ReactNode } from 'react';
import type { ModeCatalogEntry } from '../shared/conversation-modes';
import { ModBadge } from './mods/ModBadge';
import { removeConversationMod } from './mod-removal';
import { openModConversation } from './mod-open';
import { friendlyModError } from './mod-errors';
import { catalogResponse } from './conversation-mode-session';
import {
  ApprovalCard,
  EmptyState,
  HandoffModal,
  RunOutput,
  SettingsPage,
  StatusPill,
  dateLabel,
  readableError,
  useBackend,
} from './App';
import { ConversationWorkspace, MemoryDialog, ProjectDialog, type Api, type Notice } from './Workspace';
import { ComposerSession, hasDraftContent } from './composer-session';
import {
  ConversationCreationGate,
  createSidebarConversation,
  createdConversationSelection,
  conversationsWithCreated,
  isCreatedConversationPending,
} from './conversation-creation';
import { accentLabels, useAccent, themeLabels, useTheme, type Theme, type Accent } from './theme';
import { zoomPresets } from '../shared/appearance';
import {
  changeLocale,
  applyInterfaceLocale,
  currentLocale,
  shownTitle,
  translateInterfaceText,
  withNames,
} from './i18n';
import { type ExternalAgentId } from '../shared/external-agents';
import { Avatar } from './avatar';
import { locales } from '../shared/i18n';
import { UsagePage } from './UsagePage';
import { ScheduledTasks } from './ScheduledTasks';
import { ExtensionsHome, readExtensionsTab, type ExtensionsTab } from './ExtensionsHome';
import { SettingsGroup, SettingsRow } from './SettingsRow';
import { SettingsShell } from './SettingsShell';
import {
  AccountSettings,
  AccountSyncPill,
  AccountWelcomeContext,
  accountMergeTarget,
  accountMergeWaiting,
  useAccount,
} from './AccountSettings';
import {
  settingsCategories,
  settingsCategory as restoreSettingsCategory,
  type SettingsCategory,
} from './settings-categories';
import { DevicesCard } from './Devices';
import { ChatFolders, FolderMoveDialog } from './ConversationFolders';
import { ConnectAccounts, ExecutorsPage } from './Executors';
import { hasUsableAccount } from '../shared/runtime-readiness';
import { SplitView, conversationDragType, dropIntoPanes, maxPanes } from './SplitView';
import {
  CommandPalette,
  ContextMenu,
  ShortcutHelp,
  taskShown,
  useFinishNotifications,
  useShortcuts,
  useUnread,
  type MenuItem,
  type PaletteEntry,
} from './DesktopFeatures';
import { TaskQueue } from './TaskQueue';
import { backendStateNotice, crashNotice, desktopBridge } from './desktop';
import { AppUpdateNotice } from './AppUpdateNotice';
import { StartChecklistAccountsContext, StartChecklistVisibilityContext } from './StartChecklist';
import { Logo } from './Logo';
import { hasSideChatDrafts, mainConversations } from './side-chat';
import {
  activityFilters,
  sidebarActivity,
  matchesActivity,
  sidebarConversationOrder,
  sidebarScope,
  nextNeedingMe,
  type ActivityFilter,
} from './sidebar-activity';
import { leaveSwarm } from './swarm-switch';
import { isActiveWorkflow } from './queue-utils';
import { ActivityDot } from './ActivityDot';
import { defaultRequestMethod } from './backend-session';
import {
  confirmProjectRemoval,
  projectManagementItems,
  MissingProjectFolder,
  RemovedProjectsSheet,
} from './ProjectManagement';

type Page =
  'workspace' | 'queue' | 'runs' | 'routines' | 'resources' | 'spend' | 'integrations' | 'settings' | 'extensions';
const updatePageKey = 'pugport-ui-page';
const pages: Record<Page, string> = {
  workspace: '工作区',
  queue: '任务队列',
  runs: '执行记录',
  routines: '定时任务',
  resources: '用量',
  spend: '消耗',
  integrations: '连接',
  settings: '设置',
  extensions: '扩展',
};
/** Three places in the sidebar; related pages share one and switch with tabs at the top. */
const navGroups = [
  { id: 'queue', label: '任务列表', pages: ['routines', 'queue', 'runs'] },
  { id: 'resources', label: '用量与连接', pages: ['resources', 'spend', 'integrations'] },
  { id: 'settings', label: '设置', pages: ['settings'] },
] as const satisfies readonly { id: Page; label: string; pages: readonly Page[] }[];
const taskTabs = [
  ['routines', '定时任务'],
  ['queue', '任务队列'],
  ['runs', '执行记录'],
] as const;
const usageTabs = [
  ['resources', '额度', 'Quota'],
  ['spend', '消耗', 'Spend'],
  ['integrations', '连接', 'Connections'],
] as const;
const pageTabs: Partial<Record<Page, readonly (readonly [Page, string, string?])[]>> = {
  queue: taskTabs,
  runs: taskTabs,
  routines: taskTabs,
  resources: usageTabs,
  spend: usageTabs,
  integrations: usageTabs,
};
export function NoticeToast({
  notice,
  onClose,
  state,
}: {
  notice: Notice;
  onClose: () => void;
  state?: Pick<AppState, 'runs'> | null;
}) {
  const firstSnapshot = useRef({ notice, runs: state?.runs });
  if (firstSnapshot.current.notice !== notice) firstSnapshot.current = { notice, runs: state?.runs };
  useEffect(() => {
    // A server rejection can arrive before the client sees the run that caused it.
    if (state?.runs !== firstSnapshot.current.runs && noticeResolved(notice, state)) onClose();
  }, [notice, state, onClose]);
  return (
    <div className={`notice notice-${notice.tone}`} role={notice.tone === 'error' ? 'alert' : 'status'}>
      {notice.tone === 'success' ? <CheckCircle2 size={17} /> : <AlertCircle size={17} />}
      <span translate={notice.names ? 'no' : undefined}>
        {notice.names ? withNames(notice.message, notice.names) : notice.message}
      </span>
      {[notice.action, notice.secondaryAction]
        .filter((action) => !!action)
        .map((action, index) => (
          <button
            key={index}
            type="button"
            className="archive-text-button"
            onClick={() => {
              onClose();
              void action.run();
            }}
          >
            {action.label}
          </button>
        ))}
      <button className="icon-button" aria-label="关闭提示" onClick={onClose}>
        <X size={15} />
      </button>
    </div>
  );
}

function stored(key: string) {
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}
function saveSelection(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* Local storage may be disabled. */
  }
}

/** A conversation popped out into its own window: `?view=conversation&id=…`. */
const soloId = (() => {
  if (typeof location === 'undefined') return '';
  const params = new URLSearchParams(location.search);
  return params.get('view') === 'conversation' ? (params.get('id') ?? '') : '';
})();
const copyText = (text: string) => void navigator.clipboard?.writeText(text).catch(() => undefined);

export type RunInspectionState =
  | { id: string; status: 'loading' }
  | { id: string; status: 'ready'; run: RunRecord }
  | { id: string; status: 'failed'; error: string };

/** Read a record omitted from the bounded broadcast; cancellation only discards its response. */
export function requestRunInspection(api: Api, id: string, onChange: (state: RunInspectionState) => void) {
  let current = true;
  onChange({ id, status: 'loading' });
  const promise = (async () => {
    try {
      const run = await api<RunRecord>(`/api/runs/${encodeURIComponent(id)}`, undefined, 'GET');
      if (run.id !== id) throw new Error('返回的执行记录与所选记录不一致。');
      if (current) onChange({ id, status: 'ready', run });
    } catch (error) {
      if (current) onChange({ id, status: 'failed', error: readableError(error) });
    }
  })();
  return {
    promise,
    cancel: () => {
      current = false;
    },
  };
}

export function RunInspectionFallback({
  id,
  state,
  onRetry,
}: {
  id: string;
  state?: RunInspectionState;
  onRetry: () => void;
}) {
  const failure = state?.id === id && state.status === 'failed' ? state : undefined;
  return (
    <section className="panel output-panel">
      {id ? (
        failure ? (
          <div className="connection-error" role="alert">
            <AlertCircle size={16} />
            <span>执行记录加载失败：{failure.error}</span>
            <button type="button" onClick={onRetry}>
              重试
            </button>
          </div>
        ) : (
          <div className="output-waiting" role="status">
            <Loader2 size={17} className="spinning" />
            <span>正在加载所选执行记录…</span>
          </div>
        )
      ) : (
        <EmptyState title="选择一条执行记录" detail="从记录列表中选择任务，查看输出、事件与验收结果。" />
      )}
    </section>
  );
}

export default function Studio() {
  const { state, connection, error, api: backendApi, reload } = useBackend();
  const latestState = useRef(state);
  latestState.current = state;
  const [composerSession] = useState(() => new ComposerSession());
  const [shownChecklists, setShownChecklists] = useState<ReadonlySet<string>>(() => new Set());
  const checklistVisibility = useCallback((id: string, shown: boolean) => {
    setShownChecklists((current) => {
      if (current.has(id) === shown) return current;
      const next = new Set(current);
      if (shown) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  const [modSidebarTarget, setModSidebarTarget] = useState<HTMLDivElement | null>(null);
  useUiUpdateBlocker(
    () =>
      composerSession.hasUnsavedWork() ||
      Boolean(latestState.current?.conversations?.some((item) => item.incognito && !item.closedAt && !item.deletedAt)),
    'chat',
  );
  const emptyNewChat = useRef<
    { value: Conversation; projectId?: string; swarm: boolean; incognito: boolean } | undefined
  >(undefined);
  const newChatRequest = useRef(false);
  useEffect(() => {
    composerSession.activate();
    return () => composerSession.dispose();
  }, [composerSession]);
  useLayoutEffect(() => {
    composerSession.observeMessages(state?.conversationMessages ?? []);
  }, [composerSession, state?.conversationMessages]);
  const desktop = desktopBridge();
  // Extra panes beside the selected conversation (split view), and every pane's relative width.
  const [extraPanes, setExtraPanes] = useState<string[]>([]);
  const [adoptedDraftId, setAdoptedDraftId] = useState('');
  const [createdSelection, setCreatedSelection] = useState<Conversation>();
  const [openedArchived, setOpenedArchived] = useState<Conversation>();
  const [archiveList, setArchiveList] = useState<'archived' | 'deleted'>();
  const [removedProjectsOpen, setRemovedProjectsOpen] = useState(false);
  const [historyRevision, setHistoryRevision] = useState(0);
  const [historyCounts, setHistoryCounts] = useState<{ archived?: number; deleted?: number }>({});
  const [historyError, setHistoryError] = useState(false);
  useEffect(() => {
    if (createdSelection && state?.removedProjects?.some((project) => project.id === createdSelection.projectId))
      setCreatedSelection(undefined);
  }, [createdSelection, state?.removedProjects]);
  const api: Api = useCallback(
    // A fixed 'POST' default here sent every path-only read (task detail, problem reports, sandbox learning)
    // to the write route, undoing the backend helper's own default.
    async <T,>(path: string, body?: unknown, method = defaultRequestMethod(body), signal?: AbortSignal): Promise<T> => {
      const contentWrite =
        method !== 'GET' && /^\/api\/conversations\/([^/]+)\/(?:messages|mode|mode-actions)(?:\/|$)/.exec(path)?.[1];
      if (contentWrite === emptyNewChat.current?.value.id) emptyNewChat.current = undefined;
      const result = await backendApi<T>(path, body, method, signal);
      if (method === 'PATCH' && /^\/api\/conversations\/[^/]+$/.test(path)) {
        const updated = result as Conversation;
        setOpenedArchived((current) => (current?.id === updated.id ? updated : current));
        if (updated.archivedAt && body && typeof body === 'object' && (body as { archived?: boolean }).archived) {
          setCreatedSelection((current) => (current?.id === updated.id ? undefined : current));
          setConversationId((current) => (current === updated.id ? '' : current));
          setExtraPanes((current) => current.filter((id) => id !== updated.id));
        }
      }
      const id = method === 'PATCH' ? /^\/api\/conversations\/([^/]+)$/.exec(path)?.[1] : undefined;
      const swarm = body && typeof body === 'object' ? (body as { swarm?: unknown }).swarm : undefined;
      if (id && typeof swarm === 'boolean')
        setCreatedSelection((current) =>
          current?.id === id
            ? { ...current, ...((result as Conversation)?.id === id ? (result as Conversation) : {}), swarm }
            : current,
        );
      return result;
    },
    [backendApi],
  );
  useEffect(
    () =>
      desktop?.onConfirmation?.(async (options) => {
        if (!(await confirmDialog(options))) return false;
        try {
          for (const id of options.incognito ?? []) {
            await api('/api/conversations/' + id + '/close-incognito', {});
            closedIncognito.current.add(id);
          }
          return true;
        } catch (error) {
          notify({ tone: 'error', message: readableError(error) });
          return false;
        }
      }),
    [api],
  );
  const [paneSizes, setPaneSizes] = useState<number[]>([1]);
  const account = useAccount(api, !!state, state?.account);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] }>();
  const [removingMode, setRemovingMode] = useState(false);
  const modeRemovalRequest = useRef(false);
  const [palette, setPalette] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [onTop, setOnTop] = useState(false);
  const [editingConversation, setEditingConversation] = useState<Conversation>();
  const [editingProject, setEditingProject] = useState<Project>();
  const [cursorImportProject, setCursorImportProject] = useState<Project>();
  const [claudeImportProject, setClaudeImportProject] = useState<Project>();
  const [projectName, setProjectName] = useState('');
  const [savingProject, setSavingProject] = useState(false);
  const [movingProjects, setMovingProjects] = useState(new Set<string>());
  const [movingConversation, setMovingConversation] = useState<Conversation>();
  const [folderOrder, setFolderOrder] = useState<string[]>([]);
  const [editTitle, setEditTitle] = useState('');
  const [changingConversation, setChangingConversation] = useState(false);
  const conversationChangeRequest = useRef(false);
  const [page, setPage] = useState<Page>(() => {
    try {
      if (soloId) return 'workspace';
      const saved = sessionStorage.getItem(updatePageKey);
      if (saved === 'spend') return 'spend';
      if (saved === 'resources') {
        try {
          const selection = JSON.parse(sessionStorage.getItem('pugport-usage-selection') ?? 'null');
          if (Array.isArray(selection) && selection[0] === 'usage') return 'spend';
        } catch {
          // Older or invalid filters still open the quota page.
        }
        return 'resources';
      }
      return 'workspace';
    } catch {
      return 'workspace';
    }
  });
  useEffect(() => {
    if (soloId) return;
    try {
      sessionStorage.setItem(updatePageKey, page === 'resources' || page === 'spend' ? page : 'workspace');
    } catch {
      // A stale page marker must not authorize an update after navigation.
    }
  }, [page]);
  useUiUpdateBlocker(() => {
    if (page !== 'workspace' && page !== 'resources' && page !== 'spend') return true;
    if (soloId) return false;
    return sessionStorage.getItem(updatePageKey) !== page;
  }, 'settings');
  const [settingsCategory, setSettingsCategory] = useState<SettingsCategory>(() =>
    restoreSettingsCategory(stored('pugport-settings-category')),
  );
  useEffect(() => {
    if (account.view && !account.view.configured && settingsCategory === 'account') setSettingsCategory('general');
  }, [account.view?.configured, settingsCategory]);
  const [extensionsTab, setExtensionsTab] = useState<ExtensionsTab>(readExtensionsTab);
  const [extensionsTarget, setExtensionsTarget] = useState<{ id: string; request: number }>();
  const [settingsTarget, setSettingsTarget] = useState<{ id: string; request: number }>();
  useEffect(() => saveSelection('pugport-settings-category', settingsCategory), [settingsCategory]);
  useEffect(() => {
    if (page !== 'settings' || settingsCategory !== 'conversation') return;
    let cancelled = false;
    setHistoryCounts({});
    setHistoryError(false);
    void api<{ archived: number; deleted: number }>('/api/conversation-history', undefined, 'GET')
      .then((counts) => {
        if (!cancelled) setHistoryCounts({ archived: counts.archived, deleted: counts.deleted });
      })
      .catch(() => {
        if (!cancelled) setHistoryError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [api, page, settingsCategory, archiveList, historyRevision]);
  const [connecting, setConnecting] = useState(false);
  const mainRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (page !== 'workspace' && mainRef.current) mainRef.current.scrollTop = 0;
  }, [page, settingsCategory]);
  const [projectId, setProjectId] = useState(() => stored('agent-studio-project'));
  const [conversationId, setConversationId] = useState(() => soloId || stored('agent-studio-conversation'));
  const selectedConversation = useRef(conversationId);
  selectedConversation.current = conversationId;
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [activityFilter, setActivityFilter] = useState<ActivityFilter>(() => {
    const saved = stored('pugport-activity-filter');
    return activityFilters.find(([key]) => key === saved)?.[0] ?? 'all';
  });
  useEffect(() => saveSelection('pugport-activity-filter', activityFilter), [activityFilter]);
  const [selectedRunId, setSelectedRunId] = useState('');
  const [runScope, setRunScope] = useState<string>();
  const [selectedRunTab, setSelectedRunTab] = useState<'output' | 'trajectory'>('output');
  const [addProject, setAddProject] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => stored('pugport-sidebar-collapsed') === 'true');
  const sidebarToggleRef = useRef<HTMLButtonElement>(null);
  const sidebarRestoreRef = useRef<HTMLButtonElement>(null);
  const focusSidebarToggle = useRef(false);
  const toggleSidebar = () => {
    focusSidebarToggle.current = true;
    setSidebarCollapsed((value) => !value);
  };
  useLayoutEffect(() => {
    if (!focusSidebarToggle.current) return;
    focusSidebarToggle.current = false;
    (sidebarCollapsed ? sidebarRestoreRef : sidebarToggleRef).current?.focus();
  }, [sidebarCollapsed]);
  useEffect(() => saveSelection('pugport-sidebar-collapsed', String(sidebarCollapsed)), [sidebarCollapsed]);
  const [refreshing, setRefreshing] = useState(false);
  const [newPending, setNewPending] = useState(false);
  const creationGate = useRef(new ConversationCreationGate());
  const navigationVersion = useRef(0);
  useEffect(() => {
    creationGate.current.activate();
    return () => creationGate.current.dispose();
  }, []);
  const [search, setSearch] = useState('');
  const [historySearchOpen, setHistorySearchOpen] = useState(false);
  const [searchTarget, setSearchTarget] = useState<{ conversationId: string; messageId: string; requestId: number }>();
  const [notice, setNotice] = useState<Notice | null>(null);
  const [backendNotice, setBackendNotice] = useState<Notice | null>(null);
  const [previousCrash, setPreviousCrash] = useState<Notice | null>(null);
  const crashRequest = useRef<Promise<Notice | null>>(undefined);
  useEffect(
    () => desktop?.onBackendState?.((state) => setBackendNotice(backendStateNotice(state, desktop, setNotice))),
    [desktop],
  );
  useEffect(() => {
    if (!desktop?.takeCrashRecord) return;
    let active = true;
    // StrictMode repeats effect setup; consume the main-process record only once.
    crashRequest.current ??= desktop
      .takeCrashRecord()
      .then((record) => (record ? crashNotice(record, desktop, setNotice, () => setPreviousCrash(null)) : null))
      .catch(() => null);
    void crashRequest.current.then((notice) => {
      if (active) setPreviousCrash(notice);
    });
    return () => {
      active = false;
    };
  }, [desktop]);
  const visibleNotice = backendNotice ?? notice ?? previousCrash;
  const closeNotice = () => {
    if (visibleNotice?.onDismiss) {
      void visibleNotice.onDismiss().catch(() => setNotice({ tone: 'error', message: '无法关闭崩溃通知，请重试。' }));
      return;
    }
    const dismiss = backendNotice ? setBackendNotice : notice ? setNotice : setPreviousCrash;
    dismiss((current) => (current === visibleNotice ? null : current));
  };
  const [handoff, setHandoff] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [theme, setTheme] = useTheme();
  const [accent, setAccent] = useAccent();
  const [zoom, setZoom] = useState(1);
  useEffect(() => {
    let active = true;
    let changed = false;
    const unsubscribe = desktop?.onZoomChanged?.((value) => {
      changed = true;
      setZoom(value);
    });
    void desktop
      ?.getZoom?.()
      .then((value) => {
        if (active && !changed) setZoom(value);
      })
      .catch(console.warn);
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [desktop]);
  const [locale, setLocale] = useState(currentLocale);
  useEffect(() => {
    const changed = () => setLocale(currentLocale());
    window.addEventListener('pugport-locale-changed', changed);
    return () => window.removeEventListener('pugport-locale-changed', changed);
  }, []);
  const preferencesEnabled =
    account.view?.configured &&
    account.view.auth.phase === 'signed-in' &&
    account.view.setup === 'ready' &&
    account.view.firstPullComplete;
  const preferenceSeed = useRef('');
  useEffect(() => {
    if (!preferencesEnabled || !state) {
      preferenceSeed.current = '';
      return;
    }
    const settings = state.settings;
    if (settings.appearanceTheme) setTheme(settings.appearanceTheme);
    if (settings.appearanceAccent) setAccent(settings.appearanceAccent);
    if (settings.locale && settings.locale !== currentLocale()) void applyInterfaceLocale(settings.locale);
    const identity = account.view?.auth.email ?? '';
    if (preferenceSeed.current === identity) return;
    preferenceSeed.current = identity;
    const missing = {
      ...(!settings.appearanceTheme ? { appearanceTheme: theme } : {}),
      ...(!settings.appearanceAccent ? { appearanceAccent: accent } : {}),
      ...(!settings.locale ? { locale: currentLocale() } : {}),
    };
    if (Object.keys(missing).length)
      void saveSettings(api, state.settings, missing)
        .then(reload)
        .catch(() => {
          preferenceSeed.current = '';
        });
  }, [
    preferencesEnabled,
    account.view?.auth.email,
    state?.settings.appearanceTheme,
    state?.settings.appearanceAccent,
    state?.settings.locale,
  ]);
  function saveAppearance(patch: Partial<Pick<Settings, 'appearanceTheme' | 'appearanceAccent' | 'locale'>>) {
    if (preferencesEnabled)
      void saveSettings(api, state?.settings ?? {}, patch)
        .then(reload)
        .catch(() => notify({ tone: 'error', message: '偏好设置同步失败，请重试。' }));
  }
  const themeKeys = useRadioKeys(true);
  const languageKeys = useRadioKeys();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const notify = useCallback((value: Notice) => {
    setNotice(value);
    if (timer.current) clearTimeout(timer.current);
    if (value.tone !== 'error') timer.current = setTimeout(() => setNotice(null), 6500);
  }, []);
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 15000);
    return () => {
      clearInterval(tick);
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);
  // A pop-out window must not change which conversation the main window reopens.
  useEffect(() => {
    if (!soloId) saveSelection('agent-studio-project', projectId);
  }, [projectId]);
  useEffect(() => {
    if (!soloId) saveSelection('agent-studio-conversation', conversationId);
  }, [conversationId]);
  const allProjects = state?.projects ?? [];
  const projects = allProjects.filter((item) => item.scope !== 'chat');
  const listedConversations = state?.conversations ?? [];
  const previouslyListed = useRef(listedConversations);
  useEffect(() => {
    const previous = previouslyListed.current.find((item) => item.id === conversationId);
    previouslyListed.current = listedConversations;
    if (
      previous &&
      !listedConversations.some((item) => item.id === conversationId) &&
      !state?.removedProjects?.some((item) => item.id === previous.projectId)
    )
      void openConversationById(conversationId, undefined, true);
  }, [conversationId, listedConversations, state?.removedProjects]);
  useEffect(() => {
    if (
      openedArchived &&
      (listedConversations.some((item) => item.id === openedArchived.id) ||
        state?.removedProjects?.some((item) => item.id === openedArchived.projectId))
    )
      setOpenedArchived(undefined);
  }, [openedArchived, listedConversations, state?.removedProjects]);
  const conversations = conversationsWithCreated(listedConversations, createdSelection);
  useEffect(() => {
    if (
      createdSelection &&
      !isCreatedConversationPending(
        listedConversations.find((item) => item.id === createdSelection.id),
        createdSelection,
      )
    )
      setCreatedSelection(undefined);
  }, [createdSelection, listedConversations]);
  const conversation =
    createdConversationSelection(conversations, createdSelection, conversationId) ??
    (openedArchived?.id === conversationId ? openedArchived : undefined);
  // Earlier versions stored side-chat IDs as ordinary sidebar selections. Restore the owning main chat.
  useEffect(() => {
    const parentId = conversation?.sideChat?.parentConversationId;
    if (!parentId) return;
    const parent = conversations.find((item) => item.id === parentId && !item.sideChat);
    setConversationId(parent?.id ?? '');
    if (parent) setProjectId(parent.projectId);
  }, [conversationId, conversation?.sideChat?.parentConversationId, conversations]);
  const ordinaryConversations = mainConversations(conversations).filter(
    (item) => !item.lane || !conversations.some((parent) => parent.id === item.lane!.parentConversationId),
  );
  const sidebarList = sidebarScope(
    ordinaryConversations,
    projects,
    state?.workflows ?? [],
    state?.agentConversationIds ?? [],
    state?.settings.showAgentConversations === true,
    now,
  );
  const sidebarConversations = sidebarList.conversations;
  const sidebarProjects = sidebarList.projects;
  const [sidebarModes, setSidebarModes] = useState<readonly ModeCatalogEntry[]>([]);
  const boundModesKey = JSON.stringify(
    conversations
      .flatMap((item) => {
        if (!canAttachMod(item)) return [];
        return [item.modeBinding, item.pendingModeBinding?.binding].flatMap((binding) =>
          binding ? [`${binding.modeId}@${binding.version}`] : [],
        );
      })
      .sort(),
  );
  useEffect(() => {
    if (boundModesKey === '[]') return;
    let current = true;
    const abort = new AbortController();
    void api<unknown>('/api/modes', undefined, 'GET', abort.signal)
      .then((value) => {
        const parsed = catalogResponse.safeParse(value);
        if (current) setSidebarModes(parsed.success ? parsed.data.catalog : []);
      })
      .catch(() => {
        if (current) setSidebarModes([]);
      });
    return () => {
      current = false;
      abort.abort();
    };
  }, [api, boundModesKey]);
  const project = allProjects.find((item) => item.id === (conversation?.projectId ?? projectId));
  useEffect(() => {
    const remember = () => {
      if (state)
        void desktop
          ?.quickChatContext?.({
            id: page === 'workspace' ? (conversation?.id ?? '') : '',
            title: conversation?.title ?? '',
            composerSendKey: state.settings.composerSendKey ?? 'enter',
            project: project?.name ?? translateInterfaceText('日常对话'),
          })
          .catch(() => {});
    };
    remember();
    window.addEventListener('focus', remember);
    return () => window.removeEventListener('focus', remember);
  }, [conversation?.id, conversation?.title, project?.name, page, state?.settings.composerSendKey]);
  const generalConversations = sidebarConversations
    .filter(
      (item) =>
        allProjects.some((project) => project.id === item.projectId && project.scope === 'chat') ||
        (item.id === createdSelection?.id && !allProjects.some((project) => project.id === item.projectId)),
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const listedRun = state?.runs.find((run) => run.id === selectedRunId);
  const [runInspection, setRunInspection] = useState<RunInspectionState>();
  const [inspectionAttempt, setInspectionAttempt] = useState(0);
  const hasListedRun = Boolean(listedRun);
  const hasState = Boolean(state);
  useEffect(() => {
    if (!selectedRunId || hasListedRun || !hasState) return;
    const request = requestRunInspection(api, selectedRunId, setRunInspection);
    return request.cancel;
  }, [api, selectedRunId, hasListedRun, hasState, inspectionAttempt]);
  const selectedRun =
    listedRun ??
    (runInspection?.id === selectedRunId && runInspection.status === 'ready' ? runInspection.run : undefined);
  const selectedWorkflow = state?.workflows?.find((item) => item.id === selectedRun?.workflowId);
  const originalRunInput = (run: RunRecord) => {
    const workflow = state?.workflows?.find((item) => item.id === run.workflowId);
    const message = state?.conversationMessages?.find(
      (item) =>
        item.id === workflow?.userMessageId && item.role === 'user' && item.conversationId === workflow.conversationId,
    );
    return executionUserInput(run, message?.content);
  };
  const selectedFinalOutput = state?.conversationMessages?.find(
    (item) =>
      item.id === selectedWorkflow?.finalMessageId &&
      item.role === 'assistant' &&
      item.conversationId === selectedWorkflow.conversationId,
  )?.content;
  const activeCount =
    state?.runs.filter((run) => ['queued', 'running', 'waiting-approval'].includes(run.status)).length ?? 0;
  const executingCount = state?.runs.filter((run) => ['running', 'waiting-approval'].includes(run.status)).length ?? 0;
  const activity = { running: executingCount, ...localActivity(state?.backgroundTasks ?? []) };
  const activityText = activityLabel(activity, translateInterfaceText);
  useEffect(() => {
    document.title = !activity.running && !activity.localRunning ? 'PugPort' : `PugPort · ${activityText}`;
  }, [activityText]);
  const queueCount = state?.workflows?.filter(isActiveWorkflow).length ?? 0;
  const taskCount = Math.max(activeCount, queueCount);
  // The live state lists only open chats; an archived one is known only while it is open.
  const knownRunChat = (id: string) =>
    conversations.find((item) => item.id === id) ?? (openedArchived?.id === id ? openedArchived : undefined);
  const runGroups = executionRecordGroups(
    executionRecordRows(
      (selectedRun && !listedRun ? [...(state?.runs ?? []), selectedRun] : (state?.runs ?? [])).filter(
        (run) =>
          !runScope ||
          run.id === selectedRunId ||
          state?.workflows?.some((workflow) => workflow.id === run.workflowId && workflow.conversationId === runScope),
      ),
      state?.workflows,
      selectedRunId,
    ),
    runScope && selectedRun?.workflowId && !selectedWorkflow
      ? [...(state?.workflows ?? []), { id: selectedRun.workflowId, conversationId: runScope }]
      : (state?.workflows ?? []),
    (id) => Boolean(knownRunChat(id)),
  )
    .map((group) => {
      const chat = knownRunChat(group.conversationId);
      const title = chat?.title ?? (group.kind === 'archived' ? '已归档或已删除的对话' : '其他执行记录');
      const runs = group.runs.filter((run) =>
        `${title} ${originalRunInput(run) ?? ''} ${executionModel(run).model} ${run.projectPath}`
          .toLowerCase()
          .includes(search.toLowerCase()),
      );
      return { ...group, title, named: Boolean(chat), latest: group.runs[0]!, runs };
    })
    .filter((group) => group.runs.length);
  const selectedRecordRef = useRef<HTMLButtonElement>(null);
  // A jump from a conversation lands on its task even when that chat sits far down the list.
  useLayoutEffect(() => {
    if (page === 'runs') selectedRecordRef.current?.scrollIntoView({ block: 'nearest' });
  }, [page, selectedRunId, runScope, selectedRun?.id]);
  const paneIds = [
    conversation?.id ?? '',
    ...extraPanes.filter((id) => id !== conversationId && ordinaryConversations.some((item) => item.id === id)),
  ].slice(0, maxPanes);
  const splitConversation = paneIds.length > 1;
  const visibleIds = page === 'workspace' ? paneIds.filter(Boolean) : [];
  async function setPanes(next: string[]) {
    if (conversation?.incognito || next.some((id) => conversations.find((item) => item.id === id)?.incognito)) return;
    const [first = '', ...rest] = next;
    const target = conversations.find((item) => item.id === first);
    if (target && !(await leaveIncognito(target.id))) return;
    if (target) {
      setConversationId(target.id);
      setProjectId(target.projectId);
    }
    setExtraPanes(rest);
    if (next.length !== paneIds.length) setPaneSizes(next.map(() => 1));
    openPage('workspace');
  }
  const closePane = (index: number) => setPanes(paneIds.filter((_, at) => at !== index));
  const { unread, markUnread, markRead, markAllRead } = useUnread(ordinaryConversations, visibleIds);
  const sidebarState = sidebarActivity(sidebarConversations, state?.workflows ?? [], unread, now);
  const matchesFilter = (item: Conversation) =>
    matchesActivity(item.id, sidebarState.byId, activityFilter, conversationId);
  const filteredConversations = sidebarConversations.filter(matchesFilter);
  const filtering = activityFilter !== 'all';
  const fullSidebarOrder = sidebarConversationOrder(
    sidebarConversations,
    allProjects,
    state?.conversationFolders ?? [],
  );
  const pinned = sidebarConversations
    .filter((item) => item.pinnedAt && matchesFilter(item))
    .sort((a, b) => (b.pinnedAt ?? '').localeCompare(a.pinnedAt ?? ''));
  // Sidebar order, for Ctrl+1–9 and Ctrl+Tab.
  const sidebarOrder = fullSidebarOrder.filter(
    (item) =>
      matchesFilter(item) &&
      (item.pinnedAt ||
        (projects.some((project) => project.id === item.projectId)
          ? !collapsed.has(item.projectId)
          : folderOrder.includes(item.id))),
  );
  useFinishNotifications(
    state?.workflows,
    conversations,
    soloId ? 'never' : state?.settings.notifyOnFinish,
    state?.settings,
    // Run history shows only the selected task, so other tasks in that conversation still notify; unread marks
    // still wait for the chat itself.
    taskShown(page === 'runs' ? selectedWorkflow?.id : undefined, visibleIds),
    (id) => {
      const target = conversations.find((item) => item.id === id);
      if (target) selectConversation(target);
    },
  );
  const [traceRequest, setTraceRequest] = useState<{ runId: string; nonce: number }>();
  /** Run history → the run's chat with its Trace open on that run. */
  async function openRunTrace(run: RunRecord) {
    const conversationId =
      run.workflowId && state?.workflows?.find((item) => item.id === run.workflowId)?.conversationId;
    if (!conversationId) return;
    await openConversationById(conversationId);
    setTraceRequest({ runId: run.id, nonce: Date.now() });
  }
  async function openConversationById(id: string, runId?: string, retainSelection = false) {
    try {
      let target = conversations.find((item) => item.id === id);
      if (!target) {
        // Archived chats and quick chats may be absent from the live snapshot.
        ({ conversation: target } = await api<{ conversation: Conversation }>(
          `/api/conversations/${encodeURIComponent(id)}?recordOnly=1`,
          undefined,
          'GET',
        ));
        if (target.deletedAt) return;
        if (retainSelection) {
          // A late snapshot request must not navigate back after the owner changes chats or pages.
          if (selectedConversation.current === id && target.archivedAt) setOpenedArchived(target);
          return;
        }
        if (target.archivedAt) setOpenedArchived(target);
        else setCreatedSelection(target);
      }
      // Leaving an incognito chat can wait for confirmation; open the trajectory only after it.
      if ((await selectConversation(target)) && runId) inspectRun(runId, target.id);
    } catch (error) {
      if (!retainSelection) notify({ tone: 'error', message: readableError(error) });
    }
  }
  useEffect(
    () => desktop?.onSelectConversation?.((id, runId) => void openConversationById(id, runId)),
    [conversations],
  );
  function openSplit(item: Conversation) {
    if (item.incognito || conversation?.incognito) return;
    if (paneIds.includes(item.id)) return;
    if (!conversationId) return selectConversation(item);
    setPanes(dropIntoPanes(paneIds, item.id, { index: paneIds.length - 1, mode: 'after' }));
  }
  async function pinConversation(item: Conversation, value: boolean) {
    try {
      await api('/api/conversations/' + item.id, { pinned: value }, 'PATCH');
      await reload();
    } catch (failure) {
      notify({ tone: 'error', message: readableError(failure) });
    }
  }
  const openFolder = (projectId: string) =>
    void api('/api/open-folder', { kind: 'project', projectId }).catch((failure) =>
      notify({ tone: 'error', message: readableError(failure) }),
    );
  function conversationMenu(item: Conversation): MenuItem[] {
    const owner = allProjects.find((value) => value.id === item.projectId);
    const modItems: MenuItem[] =
      canAttachMod(item) && (item.modeBinding || item.pendingModeBinding?.binding)
        ? [
            {
              label: '从此对话移除 Mod',
              icon: <Trash2 size={14} />,
              disabled: removingMode || item.pendingModeBinding?.binding === null,
              onSelect: () => void removeConversationMode(item),
            },
          ]
        : [];
    if (item.incognito)
      return [
        ...modItems,
        {
          label: '删除',
          icon: <Trash2 size={14} />,
          danger: true,
          onSelect: () => void changeConversation(true, item),
        },
      ];
    return [
      ...(desktop?.openWindow
        ? [
            {
              label: '在新窗口打开',
              icon: <AppWindow size={14} />,
              shortcut: 'Ctrl+Shift+O',
              onSelect: () => void desktop.openWindow!(item.id),
            },
          ]
        : []),
      {
        label: '在分屏中打开',
        icon: <Columns2 size={14} />,
        shortcut: 'Ctrl+点击',
        disabled: item.id === conversationId,
        onSelect: () => openSplit(item),
      },
      'separator',
      item.pinnedAt
        ? { label: '取消置顶', icon: <PinOff size={14} />, onSelect: () => void pinConversation(item, false) }
        : { label: '置顶', icon: <Pin size={14} />, onSelect: () => void pinConversation(item, true) },
      ...modItems,
      ...(owner?.scope === 'chat'
        ? [{ label: '移动到分类', icon: <FolderOpen size={14} />, onSelect: () => setMovingConversation(item) }]
        : []),
      unread(item)
        ? { label: '标为已读', icon: <MailOpen size={14} />, onSelect: () => markRead(item) }
        : {
            label: '标为未读',
            icon: <Mail size={14} />,
            shortcut: 'Ctrl+Shift+U',
            onSelect: () => markUnread(item.id),
          },
      {
        label: '重命名',
        icon: <Pencil size={14} />,
        onSelect: () => {
          setEditingConversation(item);
          setEditTitle(item.title);
        },
      },
      // Swarm is an occasional mode, so it lives here rather than as a button on every screen.
      ...(item.swarm || canUseConversationCollaboration(owner, item)
        ? [
            {
              label: item.swarm ? '关闭蜂群模式' : '开启蜂群模式',
              icon: <GitBranch size={14} />,
              onSelect: () =>
                void (
                  item.swarm
                    ? leaveSwarm(api, item.id, state?.workflows)
                    : api(`/api/conversations/${item.id}`, { swarm: true }, 'PATCH').then(
                        () => '已开启蜂群模式：主 agent 会按需要招募成员，标题旁的「退出蜂群」可以随时关掉。',
                      )
                )
                  .then(async (message) => {
                    await reload();
                    notify({ tone: 'success', message });
                  })
                  .catch((error) => notify({ tone: 'error', message: readableError(error) })),
            },
          ]
        : []),
      'separator',
      {
        label: '导出',
        icon: <Download size={14} />,
        shortcut: '→',
        onSelect: (event) => {
          const box = event?.currentTarget.parentElement?.getBoundingClientRect();
          setMenu({
            x: box?.left ?? 4,
            y: box?.top ?? 4,
            items: (['md', 'json'] as const).map((format) => ({
              label: format === 'md' ? 'Markdown' : 'JSON',
              onSelect: () =>
                void exportConversation(api, notify, item.id, format).catch((error) =>
                  notify({ tone: 'error', message: readableError(error) }),
                ),
            })),
          });
        },
      },
      ...(owner && owner.scope !== 'chat'
        ? [{ label: '复制项目路径', icon: <Copy size={14} />, onSelect: () => copyText(owner.path) }]
        : []),
      { label: '复制链接', icon: <Copy size={14} />, onSelect: () => copyText(`pugport://conversation/${item.id}`) },
      ...(owner && owner.scope !== 'chat'
        ? [{ label: '在资源管理器中打开', icon: <FolderOpen size={14} />, onSelect: () => openFolder(owner.id) }]
        : []),
      'separator',
      {
        label: item.archivedAt ? '取消归档' : '归档',
        icon: <Archive size={14} />,
        onSelect: () => void archiveConversation(api, notify, item, !item.archivedAt),
      },
      'separator',
      { label: '删除', icon: <Trash2 size={14} />, danger: true, onSelect: () => void changeConversation(true, item) },
    ];
  }
  async function removeConversationMode(item: Conversation) {
    if (modeRemovalRequest.current) return;
    modeRemovalRequest.current = true;
    setRemovingMode(true);
    try {
      await removeConversationMod(api, item, notify, reload, () => creationGate.current.isMounted());
    } catch (failure) {
      if (creationGate.current.isMounted()) notify({ tone: 'error', message: friendlyModError(failure).text });
    } finally {
      modeRemovalRequest.current = false;
      if (creationGate.current.isMounted()) setRemovingMode(false);
    }
  }
  function projectMenu(item: Project): MenuItem[] {
    return [
      { label: '从 Cursor 导入对话…', icon: <Download size={14} />, onSelect: () => setCursorImportProject(item) },
      { label: '迁入 Claude 旧记录', icon: <Download size={14} />, onSelect: () => setClaudeImportProject(item) },
      { label: '归档全部对话', icon: <Archive size={14} />, onSelect: () => void archiveProject(item) },
      { label: '在资源管理器中打开', icon: <FolderOpen size={14} />, onSelect: () => openFolder(item.id) },
      { label: '复制路径', icon: <Copy size={14} />, onSelect: () => copyText(item.path) },
      'separator',
      ...projectManagementItems(
        () => {
          setProjectName(item.name);
          setEditingProject(item);
        },
        () => void removeProject(item),
      ),
    ];
  }
  async function archiveProject(item: Project) {
    const count = ordinaryConversations.filter((value) => value.projectId === item.id).length;
    if (
      !(await confirmDialog({
        title: '归档全部对话',
        summary: `将归档 ${count} 个对话，正在执行任务的对话会跳过。`,
        action: '归档',
      }))
    )
      return;
    try {
      const result = await api<{ archived: number; skipped: number }>(
        `/api/projects/${item.id}/archive-conversations`,
        {},
      );
      setCreatedSelection((current) => (current?.projectId === item.id ? undefined : current));
      await reload();
      notify({ tone: 'success', message: `已归档 ${result.archived} 个对话，跳过 ${result.skipped} 个。` });
    } catch (error) {
      notify({ tone: 'error', message: readableError(error) });
    }
  }
  async function moveToChats(item: Project) {
    if (movingProjects.has(item.id)) return;
    setMovingProjects((current) => new Set(current).add(item.id));
    try {
      await api('/api/projects/' + item.id + '/move-to-chats', {});
      await reload();
      notify({ tone: 'success', message: '已移到对话。' });
    } catch (failure) {
      notify({ tone: 'error', message: readableError(failure) });
    } finally {
      setMovingProjects((current) => {
        const next = new Set(current);
        next.delete(item.id);
        return next;
      });
    }
  }
  async function removeProject(item: Project) {
    if (!(await confirmProjectRemoval())) return;
    try {
      await api('/api/projects/' + item.id, {}, 'DELETE');
      const removedIds = new Set(conversations.filter((value) => value.projectId === item.id).map((value) => value.id));
      if (projectId === item.id) setProjectId('');
      if (removedIds.has(conversationId)) setConversationId('');
      if (createdSelection?.projectId === item.id) setCreatedSelection(undefined);
      setExtraPanes((panes) => panes.filter((id) => !removedIds.has(id)));
      await reload();
    } catch (failure) {
      notify({ tone: 'error', message: readableError(failure) });
    }
  }
  async function renameProject() {
    if (!editingProject || !projectName.trim()) return;
    setSavingProject(true);
    try {
      await api('/api/projects/' + editingProject.id, { name: projectName.trim() }, 'PATCH');
      setEditingProject(undefined);
      await reload();
    } catch (failure) {
      notify({ tone: 'error', message: readableError(failure) });
    } finally {
      setSavingProject(false);
    }
  }
  const showMenu = (event: React.MouseEvent, items: MenuItem[]) => {
    if (event.defaultPrevented) return;
    event.preventDefault();
    const box = event.type === 'click' && event.detail === 0 ? event.currentTarget.getBoundingClientRect() : undefined;
    setMenu({ x: box?.left ?? event.clientX, y: box?.bottom ?? event.clientY, items });
  };
  const chatHeadingMenu: MenuItem[] = [{ label: '全部标为已读', icon: <MailOpen size={14} />, onSelect: markAllRead }];
  const showMenuKey = (event: React.KeyboardEvent, items: MenuItem[]) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return;
    // Chromium on macOS does not synthesize contextmenu for Shift+F10.
    event.preventDefault();
    event.stopPropagation();
    const box = (event.target as HTMLElement).getBoundingClientRect();
    setMenu({ x: box.left, y: box.bottom, items });
  };
  const jump = (offset: number) => {
    if (!sidebarOrder.length) return;
    const index = sidebarOrder.findIndex((item) => item.id === conversationId);
    selectConversation(sidebarOrder[(index + offset + sidebarOrder.length) % sidebarOrder.length]!);
  };
  const jumpToNeedingMe = () => {
    const next = nextNeedingMe(fullSidebarOrder, sidebarState.byId, conversationId);
    if (!next) return;
    if (!next.pinnedAt)
      setCollapsed((previous) => {
        const expanded = new Set(previous);
        expanded.delete(next.projectId);
        return expanded;
      });
    selectConversation(next);
  };
  useShortcuts(
    soloId
      ? {
          'ctrl+/': () => setShortcutsOpen(true),
          'ctrl+shift+f': () => setHistorySearchOpen(true),
        }
      : {
          'ctrl+k': () => setPalette((value) => !value),
          'ctrl+b': toggleSidebar,
          'ctrl+shift+f': () => {
            setPalette(false);
            setHistorySearchOpen(true);
          },
          'ctrl+n': () => void newConversation(),
          'ctrl+shift+n': () => void newConversation(undefined, false, true),
          'ctrl+,': () => openSettings(settingsCategory),
          'ctrl+/': () => setShortcutsOpen(true),
          'ctrl+\\': () => splitConversation && closePane(paneIds.length - 1),
          'ctrl+tab': () => jump(1),
          'ctrl+shift+tab': () => jump(-1),
          'ctrl+shift+o': () => conversation && !conversation.incognito && void desktop?.openWindow?.(conversation.id),
          'ctrl+shift+u': () => conversation && markUnread(conversation.id),
          'ctrl+shift+j': jumpToNeedingMe,
          ...Object.fromEntries(
            [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [
              `ctrl+${n}`,
              () => sidebarOrder[n - 1] && selectConversation(sidebarOrder[n - 1]!),
            ]),
          ),
        },
  );
  const paletteEntries: PaletteEntry[] = [
    ...(desktop?.pinWindow
      ? [
          {
            id: 'pin-window',
            group: '操作',
            label: onTop ? '取消置顶窗口' : '窗口保持在最前',
            icon: onTop ? <PinOff size={14} /> : <Pin size={14} />,
            run: () =>
              void desktop.pinWindow!(!onTop)
                .then(setOnTop)
                .catch((error) => notify({ tone: 'error', message: readableError(error) })),
          },
        ]
      : []),
    {
      id: 'search-content',
      group: '操作',
      label: '搜索对话内容',
      icon: <Search size={14} />,
      shortcut: 'Ctrl+Shift+F',
      keywords: 'search history',
      run: () => setHistorySearchOpen(true),
    },
    {
      id: 'new',
      group: '操作',
      label: '新对话',
      icon: <Plus size={14} />,
      shortcut: 'Ctrl+N',
      run: () => void newConversation(),
    },
    {
      id: 'incognito',
      group: '操作',
      label: '新建隐身对话',
      icon: <VenetianMask size={14} />,
      shortcut: 'Ctrl+Shift+N',
      run: () => void newConversation(undefined, false, true),
    },
    ...projects.map((item) => ({
      id: `new-${item.id}`,
      group: '操作',
      label: `在 ${item.name} 中新建对话`,
      icon: <Plus size={14} />,
      run: () => void newConversation(item),
    })),
    ...(conversation && !conversation.incognito && desktop?.openWindow
      ? [
          {
            id: 'window',
            group: '操作',
            label: '在新窗口打开当前对话',
            icon: <AppWindow size={14} />,
            shortcut: 'Ctrl+Shift+O',
            run: () => void desktop.openWindow!(conversation.id),
          },
        ]
      : []),
    ...(splitConversation
      ? [
          {
            id: 'close-split',
            group: '操作',
            label: '关闭分屏',
            icon: <X size={14} />,
            shortcut: 'Ctrl+\\',
            run: () => closePane(paneIds.length - 1),
          },
        ]
      : []),
    {
      id: 'theme',
      group: '操作',
      label: `切换主题（当前：${themeLabels[theme]}）`,
      icon: theme === 'dark' ? <Moon size={14} /> : theme === 'light' ? <Sun size={14} /> : <Monitor size={14} />,
      run: () => setTheme(theme === 'light' ? 'dark' : theme === 'dark' ? 'system' : 'light'),
    },
    {
      id: 'shortcuts',
      group: '操作',
      label: '快捷键一览',
      icon: <Keyboard size={14} />,
      shortcut: 'Ctrl+/',
      run: () => setShortcutsOpen(true),
    },
    ...(Object.keys(pages) as Page[])
      .filter((id) => id !== 'workspace')
      .map((id) => ({
        id: `page-${id}`,
        group: '页面',
        label: id === 'integrations' && currentLocale() === 'en' ? 'Connections' : pages[id],
        icon: <ArrowUpRight size={14} />,
        shortcut: id === 'settings' ? 'Ctrl+,' : undefined,
        run: () =>
          id === 'settings' ? openSettings(settingsCategory) : id === 'extensions' ? openExtensions() : openPage(id),
      })),
    ...(
      [
        ['mods', '扩展：Mods'],
        ['skills', '扩展：技能'],
        ['connections', '扩展：连接与服务'],
        ['components', '扩展：组件'],
      ] as const
    ).map(([tab, label]) => ({
      id: 'extensions-' + tab,
      group: '页面',
      label,
      icon: <Blocks size={14} />,
      run: () => openExtensions(tab),
    })),
    ...settingsCategories.map((category) => ({
      id: `settings-${category.id}`,
      group: '设置',
      label: `设置：${category.name}`,
      icon: <SettingsIcon size={14} />,
      run: () => openSettings(category.id),
    })),
    ...[...sidebarConversations]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((item) => {
        const owner = allProjects.find((value) => value.id === item.projectId);
        return {
          id: `c-${item.id}`,
          group: '对话',
          label: item.title,
          detail: owner && owner.scope !== 'chat' ? owner.name : undefined,
          icon: <MessageSquare size={14} />,
          run: () => selectConversation(item),
        };
      }),
  ];
  const leavingIncognito = useRef<Promise<boolean> | undefined>(undefined);
  const closedIncognito = useRef(new Set<string>());
  const retainedIncognito = useRef<Conversation | undefined>(undefined);
  useEffect(() => {
    if (conversation?.incognito) retainedIncognito.current = conversation;
  }, [conversation]);
  function leaveIncognito(nextId?: string): boolean | Promise<boolean> {
    const current = conversation?.incognito ? conversation : retainedIncognito.current;
    if (!current || current.id === nextId || closedIncognito.current.has(current.id)) return true;
    if (leavingIncognito.current) return leavingIncognito.current;
    const id = current.id;
    leavingIncognito.current = (async () => {
      if (
        !(await confirmDialog({
          title: '离开隐身对话',
          summary: '离开后这个隐身对话会被永久删除',
          action: '离开并删除',
          tone: 'danger',
        }))
      )
        return false;
      try {
        await api('/api/conversations/' + id + '/close-incognito', {});
        closedIncognito.current.add(id);
        setCreatedSelection((value) => (value?.id === id ? undefined : value));
        return true;
      } catch (error) {
        notify({ tone: 'error', message: readableError(error) });
        return false;
      }
    })().finally(() => {
      leavingIncognito.current = undefined;
    });
    return leavingIncognito.current;
  }
  const openPage = useCallback(async (next: Page) => {
    navigationVersion.current++;
    creationGate.current.navigate();
    setRunScope(undefined);
    setPage(next);
    setMobileOpen(false);
  }, []);
  const openSettings = useCallback(
    (category: SettingsCategory, focusId?: string) => {
      setSettingsCategory(category);
      setSettingsTarget((previous) => (focusId ? { id: focusId, request: (previous?.request ?? 0) + 1 } : undefined));
      void openPage('settings');
    },
    [openPage],
  );
  // The merge step can arrive while the owner is still in the browser: keep the notice until it is merged.
  const mergeNotice = useRef<{ session?: string; notice?: Notice }>({});
  const accountView = account.view;
  const onAccountSettings = page === 'settings' && settingsCategory === 'account';
  useEffect(() => {
    if (soloId) return;
    const shown = mergeNotice.current;
    if (!accountMergeWaiting(accountView)) {
      const notice = shown.notice;
      if (notice) setNotice((current) => (current === notice ? null : current));
      shown.notice = undefined;
      return;
    }
    if (shown.session === accountView!.sessionId) return;
    shown.session = accountView!.sessionId;
    if (onAccountSettings) return;
    const notice: Notice = {
      tone: 'info',
      message: accountView!.merge!.accountChange
        ? '这台电脑曾同步到另一个账号。请确认是否合并本地数据。'
        : '同步正在等待你确认合并这台电脑的数据。',
      action: { label: '查看', run: () => openSettings('account', accountMergeTarget) },
    };
    shown.notice = notice;
    if (timer.current) clearTimeout(timer.current);
    setNotice(notice);
  }, [accountView, onAccountSettings, openSettings]);
  const openExtensions = useCallback(
    (tab?: ExtensionsTab, focusId?: string) => {
      if (tab) setExtensionsTab(tab);
      setExtensionsTarget((previous) => (focusId ? { id: focusId, request: (previous?.request ?? 0) + 1 } : undefined));
      void openPage('extensions');
    },
    [openPage],
  );
  const manageConnectors = useCallback(
    (focusId?: string) => openExtensions('connections', typeof focusId === 'string' ? focusId : undefined),
    [openExtensions],
  );
  const openModeStore = useCallback(() => openExtensions('mods'), [openExtensions]);
  async function openMod(mode: { id: string; version: string; title: string }) {
    if (!(await leaveIncognito())) return;
    const gate = creationGate.current;
    const ticket = gate.begin();
    if (!ticket) return;
    try {
      const target = await openModConversation(api, latestState.current?.conversations ?? [], mode, () =>
        gate.maySelect(ticket),
      );
      if (!target || !gate.maySelect(ticket)) return;
      setCreatedSelection(target);
      await selectConversation(target);
      await reload();
      requestAnimationFrame(() => {
        const row = [...document.querySelectorAll<HTMLElement>('.conversation-link')].find(
          (element) => element.dataset.conversationId === target.id,
        );
        row?.scrollIntoView({ block: 'nearest' });
      });
    } finally {
      gate.finish(ticket);
    }
  }
  /** Store › Create a Mod / Edit in chat: the server already made the Mods author chat; open it. */
  async function openAuthorChat(target: Conversation) {
    if (!(await leaveIncognito())) return;
    const gate = creationGate.current;
    const ticket = gate.begin();
    if (!ticket) return;
    try {
      if (!gate.maySelect(ticket)) return;
      setCreatedSelection(target);
      await selectConversation(target);
      await reload();
    } finally {
      gate.finish(ticket);
    }
  }
  function renderExtensions() {
    return (
      <ExtensionsHome
        api={api}
        notify={notify}
        tab={extensionsTab}
        onTab={(tab) => {
          setExtensionsTab(tab);
          setExtensionsTarget(undefined);
        }}
        target={extensionsTarget}
        defaultFolder={state?.settings.defaultProjectPath}
        externalCallers={state?.settings.externalCallers}
        onOpenMod={openMod}
        onOpenConversation={openAuthorChat}
      />
    );
  }
  async function selectConversation(value: Conversation) {
    const leaving = leaveIncognito(value.id);
    if (!(typeof leaving === 'boolean' ? leaving : await leaving)) return false;
    const target = value.sideChat
      ? conversations.find((item) => item.id === value.sideChat?.parentConversationId && !item.sideChat)
      : value;
    if (!target) return false;
    if (target.archivedAt) setOpenedArchived(target);
    setSearchTarget(undefined);
    if (target.incognito) setExtraPanes([]);
    selectedConversation.current = target.id;
    setConversationId(target.id);
    setProjectId(target.projectId);
    openPage('workspace');
    return true;
  }
  useEffect(() => {
    const extensions = (event: Event) =>
      openExtensions((event as CustomEvent<ExtensionsTab | undefined>).detail ?? 'connections');
    const select = (event: Event) => {
      const id = (event as CustomEvent<unknown>).detail;
      const target = typeof id === 'string' && conversations.find((item) => item.id === id);
      if (target) void selectConversation(target);
    };
    window.addEventListener('pugport:open-extensions', extensions);
    window.addEventListener('pugport:select-conversation', select);
    return () => {
      window.removeEventListener('pugport:open-extensions', extensions);
      window.removeEventListener('pugport:select-conversation', select);
    };
  }, [conversations, openExtensions]);
  async function openSearchResult(result: ConversationSearchResult) {
    // Read the durable conversation: a search hit can be outside the sidebar's live snapshot.
    const value = await api<{ conversation: Conversation }>(
      `/api/conversations/${encodeURIComponent(result.conversationId)}?recordOnly=1`,
      undefined,
      'GET',
    );
    if (!(await selectConversation(value.conversation))) return;
    if (!value.conversation.archivedAt) setCreatedSelection(value.conversation);
    setSearchTarget(
      result.messageId
        ? {
            conversationId: result.conversationId,
            messageId: result.messageId,
            requestId: Date.now(),
          }
        : undefined,
    );
  }
  async function selectProject(value: Project) {
    if (!(await leaveIncognito())) return;
    setProjectId(value.id);
    selectedConversation.current = '';
    setConversationId('');
    setCollapsed((previous) => {
      const next = new Set(previous);
      next.delete(value.id);
      return next;
    });
    openPage('workspace');
  }
  async function newConversation(
    inProject?: Project,
    swarm = false,
    incognito = false,
    externalAgentId?: ExternalAgentId,
  ) {
    if (newChatRequest.current) return;
    newChatRequest.current = true;
    try {
      const candidate = emptyNewChat.current;
      const isUntouched = (current: Conversation) =>
        current.projectId === candidate?.value.projectId &&
        Boolean(current.incognito) === incognito &&
        Boolean(current.swarm) === swarm &&
        !current.deletedAt &&
        !current.archivedAt &&
        !current.closedAt &&
        !current.removedWithProject &&
        !current.sideChat &&
        !current.grokHistory &&
        !current.workflowHistoryRevision &&
        !current.modeBinding &&
        !current.pendingModeBinding &&
        !current.defaultExternalAgentId &&
        !current.pinnedMessages?.length &&
        !current.untrustedContent;
      const freshDraft = () => {
        if (!candidate) return false;
        const snapshot = composerSession.getSnapshot();
        const scopes = new Set([`conversation:${candidate.value.id}`]);
        for (const [scope, draft] of Object.entries(snapshot.drafts))
          if (draft.createdConversation?.id === candidate.value.id) scopes.add(scope);
        const live = latestState.current;
        const current = live?.conversations?.find((item) => item.id === candidate.value.id);
        return (
          (!current || isUntouched(current)) &&
          !live?.removedProjects?.some((project) => project.id === candidate.value.projectId) &&
          !live?.projects?.find((project) => project.id === candidate.value.projectId)?.removedAt &&
          ![...scopes].some((scope) => {
            const draft = snapshot.drafts[scope];
            return draft && hasDraftContent(draft);
          }) &&
          !snapshot.pendingSends.some(
            (send) =>
              send.conversationId === candidate.value.id ||
              scopes.has(send.scope) ||
              send.snapshot.createdConversation?.id === candidate.value.id,
          ) &&
          !live?.conversationMessages?.some((message) => message.conversationId === candidate.value.id) &&
          !live?.workflows?.some((workflow) => workflow.conversationId === candidate.value.id)
        );
      };
      if (
        !externalAgentId &&
        candidate &&
        selectedConversation.current === candidate.value.id &&
        candidate.projectId === inProject?.id &&
        candidate.swarm === swarm &&
        candidate.incognito === incognito &&
        freshDraft()
      ) {
        const navigation = navigationVersion.current;
        const saved = await api<{ conversation: Conversation; messages: unknown[]; workflows: unknown[] }>(
          `/api/conversations/${encodeURIComponent(candidate.value.id)}`,
          undefined,
          'GET',
        );
        if (
          !creationGate.current.isMounted() ||
          navigationVersion.current !== navigation ||
          selectedConversation.current !== candidate.value.id
        )
          return;
        const current = saved.conversation;
        if (
          current?.id === candidate.value.id &&
          isUntouched(current) &&
          Array.isArray(saved.messages) &&
          !saved.messages.length &&
          Array.isArray(saved.workflows) &&
          !saved.workflows.length &&
          freshDraft() &&
          emptyNewChat.current === candidate
        ) {
          setCreatedSelection(current);
          await selectConversation(current);
          setTimeout(() => mainRef.current?.querySelector<HTMLElement>('#conversation-input')?.focus(), 0);
          return;
        }
        emptyNewChat.current = undefined;
      }
      if (!(await leaveIncognito())) return;
      let selection: Promise<boolean> | undefined;
      await createSidebarConversation(creationGate.current, {
        api,
        reload,
        projectId: inProject?.id,
        swarm,
        incognito,
        externalAgentId,
        onPending: setNewPending,
        onCreated: (result) => {
          setCreatedSelection(result);
          setCollapsed((previous) => {
            const next = new Set(previous);
            next.delete(result.projectId);
            return next;
          });
          selection = selectConversation(result).then((selected) => {
            if (selected)
              emptyNewChat.current = externalAgentId
                ? undefined
                : { value: result, projectId: inProject?.id, swarm, incognito };
            return selected;
          });
        },
        onError: (stage, failure) =>
          notify({
            tone: 'error',
            message:
              stage === 'swarm'
                ? `对话已创建，但蜂群模式切换失败：${readableError(failure)}`
                : stage === 'refresh'
                  ? `对话已创建，工作台刷新失败：${readableError(failure)}`
                  : readableError(failure),
          }),
      });
      await selection;
    } catch (failure) {
      if (creationGate.current.isMounted()) notify({ tone: 'error', message: readableError(failure) });
    } finally {
      newChatRequest.current = false;
    }
  }
  function conversationRow(item: Conversation, icon = false, ancestors = new Set<string>()): ReactNode {
    if (ancestors.has(item.id)) return null;
    const visited = new Set(ancestors).add(item.id);
    const selected = page === 'workspace' && paneIds.includes(item.id);
    const projectChildrenAllowed = canUseConversationCollaboration(
      allProjects.find((project) => project.id === item.projectId),
      item,
    );
    const hasMode = canAttachMod(item) && !!(item.modeBinding || item.pendingModeBinding?.binding);
    const binding = item.modeBinding ?? item.pendingModeBinding?.binding;
    const metadata = sidebarModes.find((mode) => mode.id === binding?.modeId && mode.version === binding.version);
    const title = shownTitle(item.title);
    const activity = sidebarState.byId.get(item.id);
    return (
      <div className="conversation-with-mode" key={item.id}>
        <div
          className="conversation-row"
          draggable={!item.incognito}
          onDragStart={(event) => {
            event.dataTransfer.setData(conversationDragType, item.id);
            event.dataTransfer.effectAllowed = 'copyMove';
            openPage('workspace');
          }}
          onContextMenu={(event) => showMenu(event, conversationMenu(item))}
          onKeyDown={(event) => showMenuKey(event, conversationMenu(item))}
        >
          <button
            title={
              (hasMode
                ? `${title} · ${metadata?.title ?? 'Mod'}`
                : withNames('{0}\n拖到右侧可分屏 · 更多操作见菜单', [title])) +
              (item.lane?.files ? `\n${withNames('范围：{0}', [item.lane.files.join(', ')])}` : '')
            }
            data-names
            data-conversation-id={item.id}
            className={`conversation-link ${selected ? 'selected' : ''} ${sidebarState.byId.get(item.id)?.unread ? 'unread' : ''}`}
            onClick={(event) => (event.ctrlKey || event.metaKey ? openSplit(item) : selectConversation(item))}
            onAuxClick={(event) => event.button === 1 && openSplit(item)}
          >
            {hasMode ? (
              <ModBadge mode={metadata} />
            ) : item.pinnedAt ? (
              <Pin size={12} />
            ) : item.swarm && projectChildrenAllowed ? (
              <GitBranch size={13} aria-label="蜂群" />
            ) : (
              icon && <MessageSquare size={13} />
            )}
            <span>{title}</span>
            {item.incognito && <IncognitoLabel />}
            {activity?.waiting || activity?.running ? (
              <ActivityDot activity={activity.waiting ? 'attention' : 'running'} />
            ) : activity?.unread ? (
              <span className="unread-dot" role="img" aria-label="有新内容" />
            ) : null}
          </button>
          {conversationActions(item)}
        </div>
        {conversations
          .filter((child) => child.lane?.parentConversationId === item.id)
          .map((child) => (
            <div className="conversation-lane-child" key={child.id}>
              {conversationRow(child, true, visited)}
            </div>
          ))}
      </div>
    );
  }
  function conversationActions(item: Conversation) {
    return (
      <span className="conversation-actions">
        <button
          className="icon-button"
          aria-label={withNames('对话 {0} 的更多操作', [shownTitle(item.title)])}
          title={translateInterfaceText('置顶、分类与更多操作')}
          data-names
          onClick={(event) => showMenu(event, conversationMenu(item))}
        >
          <MoreHorizontal size={14} />
        </button>
      </span>
    );
  }
  async function changeConversation(remove: boolean, item = editingConversation) {
    if (!item || conversationChangeRequest.current) return;
    conversationChangeRequest.current = true;
    try {
      if (
        remove &&
        !(await confirmDialog({
          tone: 'danger',
          title: '删除对话',
          summary: item.incognito
            ? '永久删除，不能撤销'
            : '从侧边栏移除这条对话。本地历史备份和项目文件保留。进行中的任务需要先结束。',
          action: '删除',
        }))
      )
        return;
      setChangingConversation(true);
      const changed = await api<{ deleted?: boolean }>(
        '/api/conversations/' + item.id,
        remove ? {} : { title: editTitle.trim() },
        remove ? 'DELETE' : 'PATCH',
      );
      if (remove && item.incognito) closedIncognito.current.add(item.id);
      if (remove) setConversationId((current) => (current === item.id ? '' : current));
      if (remove) {
        setCreatedSelection((current) => (current?.id === item.id ? undefined : current));
        setOpenedArchived((current) => (current?.id === item.id ? undefined : current));
        setExtraPanes((current) => current.filter((id) => id !== item.id));
        notify({
          tone: 'success',
          message: item.incognito && changed.deleted === false ? '隐身对话已关闭。' : '已删除',
          ...(item.incognito ? {} : { action: { label: '撤销', run: () => restoreConversation(api, notify, item) } }),
        });
      }
      setEditingConversation(undefined);
      await reload();
    } catch (failure) {
      notify({ tone: 'error', message: readableError(failure) });
    } finally {
      conversationChangeRequest.current = false;
      setChangingConversation(false);
    }
  }
  async function refresh() {
    setRefreshing(true);
    try {
      await api('/api/refresh', {});
      await reload();
    } catch (failure) {
      notify({ tone: 'error', message: readableError(failure) });
    } finally {
      setRefreshing(false);
    }
  }
  function inspectRun(id: string, conversationId?: string) {
    setSearch('');
    setSelectedRunId(id);
    setSelectedRunTab('trajectory');
    openPage('runs');
    setRunScope(conversationId);
  }
  function onRun(run: RunRecord) {
    setSearch('');
    setSelectedRunId(run.id);
    setSelectedRunTab('output');
    openPage('runs');
    void reload();
  }

  function renderSettings() {
    if (!state) return null;
    return (
      <SettingsShell
        accountConfigured={account.view?.configured}
        category={settingsCategory}
        onCategory={(category) => openSettings(category)}
        target={settingsTarget}
      >
        {settingsCategory === 'general' && (
          <>
            <SettingsGroup id="settings-appearance" title="外观">
              <SettingsRow
                title="主题"
                description="选择浅色、深色，或自动跟随系统。"
                control={
                  <div className="theme-options" role="radiogroup" aria-label="主题" onKeyDown={themeKeys}>
                    {(['system', 'light', 'dark'] as Theme[]).map((value) => (
                      <button
                        key={value}
                        className={theme === value ? 'selected' : ''}
                        type="button"
                        role="radio"
                        aria-checked={theme === value}
                        tabIndex={theme === value ? 0 : -1}
                        onClick={() => {
                          setTheme(value);
                          saveAppearance({ appearanceTheme: value });
                        }}
                      >
                        {value === 'system' ? (
                          <Monitor size={18} />
                        ) : value === 'light' ? (
                          <Sun size={18} />
                        ) : (
                          <Moon size={18} />
                        )}
                        <span>{themeLabels[value]}</span>
                      </button>
                    ))}
                  </div>
                }
              />
              {desktop?.getZoom && desktop.setZoom && (
                <SettingsRow
                  title="界面大小"
                  control={
                    <div
                      className="language-options appearance-size"
                      role="radiogroup"
                      aria-label="界面大小"
                      onKeyDown={languageKeys}
                    >
                      {zoomPresets.map((value) => (
                        <button
                          key={value}
                          type="button"
                          role="radio"
                          aria-checked={zoom === value}
                          tabIndex={zoom === value ? 0 : -1}
                          className={zoom === value ? 'selected' : ''}
                          onClick={() =>
                            // The main process broadcasts the new size to every window, this one included.
                            void desktop.setZoom!(value).catch((error) =>
                              notify({ tone: 'error', message: readableError(error) }),
                            )
                          }
                        >
                          {Math.round(value * 100)}%
                        </button>
                      ))}
                    </div>
                  }
                />
              )}
              <SettingsRow
                title="强调色"
                control={
                  <div className="accent-options" role="radiogroup" aria-label="强调色" onKeyDown={themeKeys}>
                    {(Object.keys(accentLabels) as Accent[]).map((value) => (
                      <button
                        key={value}
                        type="button"
                        role="radio"
                        data-accent={value}
                        aria-label={accentLabels[value]}
                        aria-checked={accent === value}
                        tabIndex={accent === value ? 0 : -1}
                        className="accent-swatch"
                        onClick={() => {
                          setAccent(value);
                          saveAppearance({ appearanceAccent: value });
                        }}
                      />
                    ))}
                  </div>
                }
              />
              {/* Language names are shown in their own language, so anyone can find theirs. */}
              <SettingsRow
                title="语言"
                control={
                  <div className="language-options" role="radiogroup" aria-label="界面语言" onKeyDown={languageKeys}>
                    {locales.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        role="radio"
                        translate="no"
                        aria-checked={locale === item.id}
                        tabIndex={locale === item.id ? 0 : -1}
                        className={locale === item.id ? 'selected' : ''}
                        onClick={() => {
                          if (locale === item.id) return;
                          if (composerSession.hasUnsavedWork() || hasSideChatDrafts(api)) {
                            notify({
                              tone: 'info',
                              message: '请先发送或清空主聊和侧聊中的草稿，等待发送完成后再切换语言。',
                            });
                            return;
                          }
                          if (preferencesEnabled) {
                            void saveSettings(api, state.settings, { locale: item.id })
                              .then(() => applyInterfaceLocale(item.id))
                              .then(reload)
                              .catch(() => notify({ tone: 'error', message: '偏好设置同步失败，请重试。' }));
                          } else changeLocale(item.id);
                        }}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                }
              />
            </SettingsGroup>
          </>
        )}
        {settingsCategory === 'account' ? (
          <AccountSettings
            view={account.view}
            action={account.action}
            busy={account.busy}
            state={state}
            api={api}
            reload={reload}
            notify={notify}
            onOpenAccounts={() => setConnecting(true)}
          />
        ) : settingsCategory === 'devices' ? (
          <DevicesCard api={api} notify={notify} />
        ) : (
          <SettingsPage category={settingsCategory} state={state} api={api} reload={reload} notify={notify} />
        )}
        {settingsCategory === 'conversation' && (
          <SettingsGroup id="settings-conversations" title="对话记录">
            {(
              [
                ['archived', '已归档', historyCounts.archived],
                ['deleted', '最近删除', historyCounts.deleted],
              ] as const
            ).map(([kind, label, count]) => (
              <SettingsRow
                key={kind}
                title={label}
                status={
                  historyError ? '数量暂不可用' : count === undefined ? '…' : withNames('{0} 个对话', [String(count)])
                }
                control={
                  <button
                    type="button"
                    className="button secondary tiny"
                    aria-label={`管理${label}`}
                    onClick={() => setArchiveList(kind)}
                  >
                    管理
                  </button>
                }
              />
            ))}
            <SettingsRow
              title="已移除的项目"
              status={withNames('{0} 个项目', [
                String(listedRemovedProjects(state?.removedProjects, state?.settings?.removedProjectsClearedAt).length),
              ])}
              control={
                <button
                  type="button"
                  className="button secondary tiny"
                  aria-label="管理已移除的项目"
                  onClick={() => setRemovedProjectsOpen(true)}
                >
                  管理
                </button>
              }
            />
          </SettingsGroup>
        )}
      </SettingsShell>
    );
  }

  if (soloId)
    return (
      <div className="solo-shell">
        <ProblemReporter
          api={api}
          state={state ?? undefined}
          notify={notify}
          currentConversationId={conversationId || undefined}
          currentTaskId={
            state?.workflows
              ?.filter((task) => task.conversationId === conversationId && !task.deletedAt && !task.delegation)
              .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]?.id
          }
        />
        <div className="mod-sidebar-slot mod-popout-sidebar" ref={setModSidebarTarget} />
        {(page === 'settings' || page === 'extensions') && (
          <header className="solo-bar">
            <button type="button" className="button quiet" onClick={() => openPage('workspace')}>
              返回对话
            </button>
            <strong>{pages[page]}</strong>
          </header>
        )}
        <main
          ref={mainRef}
          className={page === 'settings' || page === 'extensions' ? 'management-main' : 'workspace-main'}
        >
          {!state ? (
            <div className="loading-page">
              <Loader2 size={24} className="spinning" />
            </div>
          ) : page === 'settings' ? (
            renderSettings()
          ) : page === 'extensions' ? (
            renderExtensions()
          ) : conversation ? (
            <AccountWelcomeContext.Provider
              value={{
                view: account.view,
                dismissed: account.dismissed,
                onSkip: account.skip,
                onOpen: () => openSettings('account'),
              }}
            >
              <StartChecklistVisibilityContext.Provider value={checklistVisibility}>
                <StartChecklistAccountsContext.Provider value={() => setConnecting(true)}>
                  <ConversationWorkspace
                    composerSession={composerSession}
                    traceRequest={traceRequest}
                    state={state}
                    api={api}
                    reload={reload}
                    project={project}
                    conversation={conversation}
                    modSurfaces
                    modSidebarTarget={modSidebarTarget}
                    onRemoveMod={() => void removeConversationMode(conversation)}
                    removingMod={removingMode}
                    searchTarget={searchTarget?.conversationId === conversation.id ? searchTarget : undefined}
                    notify={notify}
                    onBeforeSend={async () => leaveIncognito()}
                    onConversation={(value) => {
                      setCreatedSelection(value);
                      selectConversation(value);
                    }}
                    onAddProject={() => undefined}
                    onMemory={() => setMemoryOpen(true)}
                    onManageConnectors={manageConnectors}
                    onOpenSettings={openSettings}
                    onOpenModeStore={openModeStore}
                    onModDetails={(modId) => openExtensions('mods', modId)}
                    onInspect={(id) => void desktop?.focusMain?.(conversation.id, id)}
                    paneActions={
                      <>
                        {desktop?.pinWindow && (
                          <button
                            className={`icon-button ${onTop ? 'active' : ''}`}
                            title={onTop ? '取消置顶窗口' : '窗口保持在最前'}
                            aria-pressed={onTop}
                            onClick={() => void desktop.pinWindow!(!onTop).then(setOnTop)}
                          >
                            {onTop ? <PinOff size={14} /> : <Pin size={14} />}
                          </button>
                        )}
                        {desktop?.focusMain && (
                          <button
                            className="icon-button"
                            title="在主窗口打开"
                            onClick={() => void desktop.focusMain!(conversation.id)}
                          >
                            <ArrowUpRight size={14} />
                          </button>
                        )}
                      </>
                    }
                  />
                </StartChecklistAccountsContext.Provider>
              </StartChecklistVisibilityContext.Provider>
            </AccountWelcomeContext.Provider>
          ) : (
            <div className="loading-page">
              <p>这条对话已被删除或归档。</p>
            </div>
          )}
        </main>
        {connecting && state && (
          <ConnectAccounts
            state={state}
            api={api}
            reload={reload}
            notify={notify}
            onClose={() => setConnecting(false)}
          />
        )}
        {historySearchOpen && (
          <SearchDialog api={api} onSelect={openSearchResult} onClose={() => setHistorySearchOpen(false)} />
        )}
        {shortcutsOpen && <ShortcutHelp onClose={() => setShortcutsOpen(false)} />}
        {visibleNotice && <NoticeToast notice={visibleNotice} state={state} onClose={closeNotice} />}
        <AppUpdateNotice update={state?.appUpdate} enabled={state?.settings.updateCheck !== false} />
        {memoryOpen && project && (
          <MemoryDialog project={project} api={api} notify={notify} onClose={() => setMemoryOpen(false)} />
        )}
      </div>
    );
  return (
    <div className="studio-shell">
      <ProblemReporter
        api={api}
        state={state ?? undefined}
        notify={notify}
        currentConversationId={conversationId || undefined}
        currentTaskId={
          state?.workflows
            ?.filter((task) => task.conversationId === conversationId && !task.deletedAt && !task.delegation)
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]?.id
        }
      />
      <a className="skip-link" href="#main-content">
        跳到主内容
      </a>
      {editingConversation && (
        <div className="modal-backdrop">
          <form
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label="重命名对话"
            onSubmit={(event) => {
              event.preventDefault();
              void changeConversation(false);
            }}
          >
            <h2>重命名对话</h2>
            <input
              autoFocus
              aria-label="对话名称"
              maxLength={150}
              value={editTitle}
              onChange={(event) => setEditTitle(event.target.value)}
            />
            <div className="modal-actions">
              <button
                className="button secondary"
                type="button"
                disabled={changingConversation}
                onClick={() => {
                  setEditingConversation(undefined);
                }}
              >
                取消
              </button>
              <button className="button primary" disabled={changingConversation || !editTitle.trim()} type="submit">
                保存
              </button>
            </div>
          </form>
        </div>
      )}
      {claudeImportProject && (
        <ClaudeHistoryImport
          project={claudeImportProject}
          api={api}
          onClose={() => setClaudeImportProject(undefined)}
          onOpen={async (id, imported) => {
            const target = conversations.find((item) => item.id === id) ?? imported;
            if (!target) return false;
            if (imported) await reload();
            const selected = await selectConversation(target);
            if (selected && imported) setCreatedSelection(imported);
            return selected;
          }}
        />
      )}
      {cursorImportProject && (
        <CursorImportDialog
          project={cursorImportProject}
          api={api}
          onClose={() => setCursorImportProject(undefined)}
          onOpen={async (id, imported) => {
            const conversation = conversations.find((item) => item.id === id) ?? imported;
            if (!conversation) return false;
            if (imported) await reload();
            return selectConversation(conversation);
          }}
        />
      )}
      {editingProject && (
        <div className="modal-backdrop">
          <form
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label="重命名项目"
            onSubmit={(event) => {
              event.preventDefault();
              void renameProject();
            }}
          >
            <h2>重命名项目</h2>
            <input
              autoFocus
              aria-label="项目名称"
              maxLength={120}
              value={projectName}
              onChange={(event) => setProjectName(event.target.value)}
            />
            <div className="modal-actions">
              <button type="button" disabled={savingProject} onClick={() => setEditingProject(undefined)}>
                取消
              </button>
              <button type="submit" disabled={savingProject || !projectName.trim()}>
                保存
              </button>
            </div>
          </form>
        </div>
      )}
      {mobileOpen && (
        <button className="sidebar-overlay" aria-label="关闭侧边栏" onClick={() => setMobileOpen(false)} />
      )}
      <aside
        className={`studio-sidebar ${mobileOpen ? 'mobile-open' : ''} ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}
      >
        <div className="sidebar-brand-row">
          <button className="studio-brand" onClick={() => openPage('workspace')} title={activityText}>
            <Logo size={36} running={executingCount > 0} local={activity.localRunning > 0} />
            <strong>PugPort</strong>
            {activity.localRunning > 0 && (
              <small
                className="brand-activity"
                title={[activity.localTitle, activity.localPhase].filter(Boolean).join(' · ')}
              >
                {activity.localTitle}
              </small>
            )}
          </button>
          <button
            className="icon-button sidebar-toggle"
            ref={sidebarToggleRef}
            aria-expanded={!sidebarCollapsed}
            aria-label="折叠侧边栏"
            title="折叠侧边栏"
            onClick={toggleSidebar}
          >
            <PanelLeftClose size={16} />
          </button>
        </div>
        <div className="new-conversation-row">
          <button
            className="new-conversation-button"
            disabled={!state || newPending}
            onClick={() => void newConversation()}
          >
            {newPending ? <Loader2 size={16} className="spinning" /> : <Plus size={16} />}新对话
          </button>
          <button
            className="icon-button"
            title="搜索对话"
            aria-label="搜索对话"
            onClick={() => setHistorySearchOpen(true)}
          >
            <Search size={17} />
          </button>
          <button
            className="icon-button"
            title="新建隐身对话"
            aria-label="新建隐身对话"
            disabled={!state || newPending}
            onClick={() => void newConversation(undefined, false, true)}
          >
            <VenetianMask size={17} />
          </button>
        </div>
        <div className="sidebar-activity-bar">
          <div className="sidebar-activity-filter sidebar-filters" role="group" aria-label="对话活动筛选">
            {activityFilters.map(([key, label]) => {
              const Icon = { all: MessageSquare, running: Activity, unread: Mail }[key];
              return (
                <button
                  key={key}
                  type="button"
                  aria-pressed={activityFilter === key}
                  aria-label={`${label} · ${sidebarState.counts[key]}`}
                  title={label}
                  onClick={() => setActivityFilter(key)}
                >
                  <Icon className="filter-icon" size={14} aria-hidden={true} focusable={false} />
                  <span className="filter-label">{label}</span>
                  {key !== 'all' && sidebarState.counts[key] > 0 && (
                    <span className="filter-count" aria-hidden={true}>
                      {sidebarState.counts[key]}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
        <div className="mod-sidebar-slot" ref={setModSidebarTarget} />
        <div className="sidebar-conversations">
          <NeedsYou
            now={now}
            conversations={conversations}
            workflows={state?.workflows ?? []}
            runs={state?.runs ?? []}
            api={api}
            notify={notify}
            onSelect={async (conversation, workflow) => {
              if (!(await selectConversation(conversation))) return;
              if (workflow.finalMessageId)
                setSearchTarget({
                  conversationId: conversation.id,
                  messageId: workflow.finalMessageId,
                  requestId: Date.now(),
                });
            }}
          />
          {filtering && !filteredConversations.length && <p className="sidebar-activity-empty">没有匹配的对话</p>}
          {state && (
            <div className="general-conversations pinned-conversations">
              <div className="project-heading">
                <span>已置顶</span>
              </div>
              {pinned.map((item) => conversationRow(item))}
            </div>
          )}
          {state && (
            <div
              className="sidebar-chat-section"
              onContextMenu={(event) => {
                if ((event.target as HTMLElement).closest('.chat-folders > .project-heading'))
                  showMenu(event, chatHeadingMenu);
              }}
              onKeyDown={(event) => {
                if ((event.target as HTMLElement).closest('.chat-folders > .project-heading'))
                  showMenuKey(event, chatHeadingMenu);
              }}
            >
              <ChatFolders
                chats={generalConversations.filter(matchesFilter)}
                filtering={filtering}
                selectedId={conversationId}
                state={state}
                row={conversationRow}
                api={api}
                reload={reload}
                notify={notify}
                onVisibleOrder={setFolderOrder}
                onHeadingMenu={(event) => showMenu(event, chatHeadingMenu)}
              />
            </div>
          )}
          {(!filtering ||
            filteredConversations.some(
              (item) => projects.some((project) => project.id === item.projectId) && !item.pinnedAt,
            )) && (
            <div className="project-heading">
              <span>项目列表</span>
              <button
                className="icon-button"
                aria-label="添加项目"
                onClick={() => setAddProject(true)}
                disabled={!state}
              >
                <Plus size={15} />
              </button>
            </div>
          )}
          <div className="project-list">
            {sidebarProjects.map((item) => {
              const items = sidebarConversations
                .filter((value) => value.projectId === item.id && !value.pinnedAt && matchesFilter(value))
                .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
              if (filtering && !items.length) return null;
              const isCollapsed = collapsed.has(item.id);
              return (
                <div className="sidebar-project" key={item.id}>
                  <div
                    className={`project-line ${project?.id === item.id ? 'current-project' : ''}`}
                    onContextMenu={(event) => showMenu(event, projectMenu(item))}
                    onKeyDown={(event) => showMenuKey(event, projectMenu(item))}
                  >
                    <button
                      className="project-collapse"
                      aria-label={withNames(isCollapsed ? '展开 {0}' : '收起 {0}', [item.name])}
                      data-names
                      aria-expanded={!isCollapsed}
                      onClick={() =>
                        setCollapsed((previous) => {
                          const next = new Set(previous);
                          if (next.has(item.id)) next.delete(item.id);
                          else next.add(item.id);
                          return next;
                        })
                      }
                    >
                      {isCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                    </button>
                    <button className="project-name" title={item.path} onClick={() => selectProject(item)}>
                      <FolderOpen size={15} />
                      <span>{item.name}</span>
                    </button>
                    <button
                      className="project-new icon-button"
                      aria-label={withNames('在 {0} 新建对话', [item.name])}
                      data-names
                      disabled={newPending}
                      onClick={() => void newConversation(item)}
                    >
                      <Plus size={14} />
                    </button>
                    <button
                      className="icon-button project-more"
                      aria-label={withNames('项目 {0} 的更多操作', [item.name])}
                      data-names
                      onClick={(event) => showMenu(event, projectMenu(item))}
                    >
                      <MoreHorizontal size={14} />
                    </button>
                  </div>
                  {item.folderMissing && (
                    <MissingProjectFolder
                      onRemove={() => void removeProject(item)}
                      onMoveToChats={
                        ordinaryConversations.some((chat) => chat.projectId === item.id)
                          ? () => moveToChats(item)
                          : undefined
                      }
                      movingToChats={movingProjects.has(item.id)}
                    />
                  )}
                  {!isCollapsed && (
                    <div className="project-conversations">
                      {items.map((item) => conversationRow(item))}
                      {!items.length && (
                        <button className="empty-conversation-link" onClick={() => void newConversation(item)}>
                          开始第一条对话
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
            {!filtering && !projects.length && (
              <button className="sidebar-add-project" onClick={() => setAddProject(true)} disabled={!state}>
                <FolderOpen size={18} />
                <span>添加你的第一个项目</span>
              </button>
            )}
          </div>
        </div>
        <nav className="sidebar-tools" aria-label="工作台导航">
          <button
            type="button"
            className={`nav-item sidebar-extensions ${page === 'extensions' ? 'active' : ''}`}
            aria-current={page === 'extensions' ? 'page' : undefined}
            onClick={() => openExtensions()}
          >
            <Blocks size={16} strokeWidth={1.6} />
            <span>扩展</span>
          </button>
          {navGroups.map((group) => {
            const Icon = { queue: ListTodo, resources: Activity, settings: SettingsIcon }[group.id];
            const current = (group.pages as readonly Page[]).includes(page);
            const count = group.id === 'queue' ? taskCount : 0;
            return (
              <button
                key={group.id}
                className={`nav-item ${current ? 'active' : ''}`}
                aria-current={current ? 'page' : undefined}
                onClick={() => (group.id === 'settings' ? openSettings(settingsCategory) : openPage(group.pages[0]))}
              >
                <Icon size={16} strokeWidth={1.6} />
                <span>{group.label}</span>
                {count > 0 && <span className="nav-count">{count}</span>}
              </button>
            );
          })}
        </nav>
        <div className="sidebar-status">
          <AccountSyncPill
            view={account.view}
            onOpen={() => openSettings('account', accountMergeWaiting(account.view) ? accountMergeTarget : undefined)}
          />
          <span
            className={`connection-dot ${connection}`}
            aria-hidden={connection !== 'connected'}
            role="img"
            aria-label={
              connection === 'connected' ? '已连接本地服务' : connection === 'reconnecting' ? '重新连接中' : '正在连接'
            }
          />
          {connection !== 'connected' && <span>{connection === 'reconnecting' ? '重新连接中' : '正在连接'}</span>}
          <InboxButton
            reportCount={state?.problemReportCount}
            reportSession={`${account.view?.auth.phase}:${account.view?.auth.email ?? ''}`}
            summary={state?.inbox}
            targets={state?.targets}
            api={api}
            reload={reload}
            notify={notify}
            openPage={openPage}
            onModDetails={(modId) => openExtensions('mods', modId)}
            onRun={inspectRun}
            onWorkflow={async (id) => {
              const workflow = state?.workflows?.find((item) => item.id === id);
              const conversation = state?.conversations?.find((item) => item.id === workflow?.conversationId);
              if (conversation) await selectConversation(conversation);
            }}
            onProjectRules={async (id) => {
              const project = allProjects.find((item) => item.id === id);
              if (!project) throw new Error('找不到这个项目。');
              if (!(await leaveIncognito())) throw new Error('已取消');
              setProjectId(project.id);
              setConversationId('');
              selectedConversation.current = '';
              openPage('workspace');
              setMemoryOpen(true);
            }}
          />
        </div>
      </aside>
      <div className="studio-main">
        {sidebarCollapsed && (
          <button
            className="icon-button sidebar-restore"
            ref={sidebarRestoreRef}
            aria-expanded={!sidebarCollapsed}
            aria-label="展开侧边栏"
            title="展开侧边栏"
            onClick={toggleSidebar}
          >
            <PanelLeftOpen size={18} />
            {!!state?.inbox?.unread && <span className="inbox-unread-dot" role="img" aria-label="信箱有未读提醒" />}
          </button>
        )}
        {/* Pages carry their own titles; this bar only appears on small screens for the sidebar toggle. */}
        <header className="studio-topbar">
          <div className="topbar-title">
            <button
              className="icon-button mobile-menu"
              onClick={() => setMobileOpen(!mobileOpen)}
              aria-label="切换侧边栏"
            >
              <Menu size={19} />
            </button>
            <span>
              {page === 'workspace'
                ? project?.scope === 'chat'
                  ? '对话'
                  : (project?.name ?? '对话')
                : page === 'integrations' && currentLocale() === 'en'
                  ? 'Connections'
                  : pages[page]}
            </span>
            {page === 'workspace' && project && project.scope !== 'chat' && (
              <small title={project.path}>{project.path}</small>
            )}
          </div>
        </header>
        <main
          ref={mainRef}
          id="main-content"
          className={page === 'workspace' ? 'workspace-main' : 'management-main'}
          tabIndex={-1}
        >
          {error && (
            <div className="connection-error" role="alert">
              <AlertCircle size={16} />
              <span>{error}</span>
              <button
                onClick={() =>
                  void reload().catch((failure) => notify({ tone: 'error', message: readableError(failure) }))
                }
              >
                重试
              </button>
            </div>
          )}
          {!state ? (
            <div className="loading-page">
              <Loader2 size={24} className="spinning" />
              <h1>正在连接工作台</h1>
              <p>读取项目与执行环境…</p>
            </div>
          ) : (
            <AccountWelcomeContext.Provider
              value={{
                view: account.view,
                dismissed: account.dismissed,
                onSkip: account.skip,
                onOpen: () => openSettings('account'),
              }}
            >
              <StartChecklistVisibilityContext.Provider value={checklistVisibility}>
                <StartChecklistAccountsContext.Provider value={() => setConnecting(true)}>
                  {page === 'workspace' && !hasUsableAccount(state) && shownChecklists.size === 0 && (
                    <div className="connection-error" role="status">
                      <span>
                        {state.refreshing ? '正在检查已有登录…' : '连接一个账号即可开始，已输入的消息会保留。'}
                      </span>
                      <button type="button" onClick={() => setConnecting(true)}>
                        连接账号
                      </button>
                    </div>
                  )}
                  {connecting && (
                    <ConnectAccounts
                      state={state}
                      api={api}
                      reload={reload}
                      notify={notify}
                      onClose={() => setConnecting(false)}
                    />
                  )}
                  {page === 'workspace' && (
                    <SplitView
                      ids={paneIds}
                      adoptedDraftId={adoptedDraftId}
                      sizes={paneSizes}
                      onSizes={setPaneSizes}
                      onDrop={(id, target) => {
                        if (!conversation?.incognito && !conversations.find((item) => item.id === id)?.incognito)
                          setPanes(dropIntoPanes(paneIds, id, target));
                      }}
                    >
                      {(id, index) => {
                        const item =
                          createdConversationSelection(conversations, createdSelection, id) ??
                          (openedArchived?.id === id ? openedArchived : undefined);
                        return (
                          <ConversationWorkspace
                            composerSession={composerSession}
                            state={state}
                            api={api}
                            reload={reload}
                            project={item ? allProjects.find((value) => value.id === item.projectId) : project}
                            conversation={item}
                            modSurfaces={paneIds.indexOf(id) === index}
                            modSidebarTarget={
                              id === conversationId && paneIds.indexOf(id) === index ? modSidebarTarget : null
                            }
                            onRemoveMod={() => item && void removeConversationMode(item)}
                            removingMod={removingMode}
                            searchTarget={
                              index === 0 && searchTarget?.conversationId === item?.id ? searchTarget : undefined
                            }
                            notify={notify}
                            onBeforeSend={async () => leaveIncognito()}
                            onConversation={(value) => {
                              if (!item) {
                                setAdoptedDraftId(value.id);
                                setCreatedSelection(value);
                              }
                              return index
                                ? setPanes(paneIds.map((pane, at) => (at === index ? value.id : pane)))
                                : selectConversation(value);
                            }}
                            onAddProject={() => setAddProject(true)}
                            onNewExternalChat={(agentId) => void newConversation(undefined, false, false, agentId)}
                            onMemory={() => setMemoryOpen(true)}
                            onManageConnectors={manageConnectors}
                            onOpenSettings={openSettings}
                            onOpenModeStore={openModeStore}
                            onModDetails={(modId) => openExtensions('mods', modId)}
                            onConversationMenu={item ? (event) => showMenu(event, conversationMenu(item)) : undefined}
                            onInspect={(id) => inspectRun(id, item?.id)}
                            paneActions={
                              item && (
                                <>
                                  {splitConversation && (
                                    <button
                                      className="icon-button"
                                      title={'关闭这一栏（Ctrl+\\ 关闭最右一栏）'}
                                      aria-label="关闭这一栏"
                                      onClick={() => closePane(index)}
                                    >
                                      <X size={15} />
                                    </button>
                                  )}
                                </>
                              )
                            }
                          />
                        );
                      }}
                    </SplitView>
                  )}
                  {page === 'extensions' && renderExtensions()}
                  {pageTabs[page] && (
                    <div
                      className="page-tabs"
                      role="tablist"
                      aria-label={navGroups.find((group) => (group.pages as readonly Page[]).includes(page))?.label}
                    >
                      {pageTabs[page]!.map(([id, label, english]) => (
                        <button
                          key={id}
                          type="button"
                          role="tab"
                          aria-selected={page === id}
                          className={page === id ? 'active' : ''}
                          onClick={() => openPage(id)}
                        >
                          {currentLocale() === 'en' && english ? english : label}
                          {id === 'queue' && taskCount > 0 && <span className="nav-count">{taskCount}</span>}
                        </button>
                      ))}
                    </div>
                  )}
                  {page === 'routines' && (
                    <ScheduledTasks api={api} state={state} notify={notify} onConversation={selectConversation} />
                  )}
                  {page === 'queue' && (
                    <TaskQueue
                      state={state}
                      api={api}
                      now={now}
                      notify={notify}
                      onConversation={openConversationById}
                      onInspect={inspectRun}
                    />
                  )}
                  {(page === 'resources' || page === 'spend') && (
                    <UsagePage
                      view={page === 'spend' ? 'usage' : 'quota'}
                      state={state}
                      api={api}
                      project={project}
                      now={now}
                      refreshing={refreshing}
                      refresh={refresh}
                      notify={notify}
                      onConversation={openConversationById}
                      onInspect={inspectRun}
                    />
                  )}
                  {page === 'runs' && (
                    <>
                      <div className="management-heading">
                        <div>
                          <h1>执行记录</h1>
                          <p>从用户原文打开任务，查看完整执行过程、工具记录与最终回复。</p>
                        </div>
                      </div>
                      <div className="run-record-layout">
                        <div className="run-record-browser">
                          {runScope && (
                            <button
                              type="button"
                              className="button tiny quiet run-record-back"
                              onClick={() => setRunScope(undefined)}
                            >
                              <ChevronLeft size={14} />
                              全部记录
                            </button>
                          )}
                          <label className="search-input">
                            <Search size={14} />
                            <input
                              aria-label="搜索执行记录"
                              value={search}
                              onChange={(event) => setSearch(event.target.value)}
                              placeholder="搜索记录…"
                            />
                          </label>
                          <section className="run-record-list" aria-label="执行记录列表">
                            {runGroups.map((group) => (
                              <section key={group.key} className="run-record-group">
                                <header>
                                  <h2 title={group.title} translate={group.named ? 'no' : undefined}>
                                    {group.title}
                                  </h2>
                                  <div>
                                    <StatusPill status={group.latest.status} />
                                    <time>{dateLabel(group.latest.startedAt)}</time>
                                  </div>
                                </header>
                                {group.runs.map((run) => {
                                  const selected =
                                    selectedRunId === run.id ||
                                    Boolean(run.workflowId && run.workflowId === selectedRun?.workflowId);
                                  const userText = originalRunInput(run);
                                  return (
                                    <button
                                      key={run.id}
                                      ref={selected ? selectedRecordRef : undefined}
                                      className={`run-record-item ${selected ? 'selected' : ''}`}
                                      onClick={() => {
                                        setSelectedRunId(run.id);
                                        setSelectedRunTab('trajectory');
                                      }}
                                    >
                                      <span title={userText} translate={userText === undefined ? undefined : 'no'}>
                                        {userText ?? '暂无用户原文'}
                                      </span>
                                      <StatusPill status={run.status} />
                                      <time>{dateLabel(run.startedAt)}</time>
                                    </button>
                                  );
                                })}
                              </section>
                            ))}
                            {!runGroups.length && <p className="quiet-text">暂无匹配记录</p>}
                          </section>
                        </div>
                        {selectedRun ? (
                          <RunOutput
                            run={selectedRun}
                            runtimes={state.runtimes}
                            targets={state.targets}
                            api={api}
                            notify={notify}
                            onHandoff={() => setHandoff(true)}
                            initialTab={selectedRunTab}
                            relatedRuns={state.runs}
                            workflowRuns={executionWorkflowRuns(selectedRun, state.runs)}
                            finalOutput={selectedFinalOutput}
                            onInspectRun={(id) => inspectRun(id, runScope)}
                            onTrace={
                              state.workflows?.some((item) => item.id === selectedRun.workflowId && item.conversationId)
                                ? () => void openRunTrace(selectedRun)
                                : undefined
                            }
                            userInput={originalRunInput(selectedRun)}
                          />
                        ) : selectedRunId ? (
                          <RunInspectionFallback
                            id={selectedRunId}
                            state={runInspection}
                            onRetry={() => setInspectionAttempt((value) => value + 1)}
                          />
                        ) : (
                          <section className="panel output-panel">
                            <EmptyState
                              title="选择一条执行记录"
                              detail="从记录列表中选择任务，查看输出、事件与验收结果。"
                            />
                          </section>
                        )}
                      </div>
                    </>
                  )}
                  {page === 'integrations' && (
                    <ExecutorsPage
                      state={state}
                      api={api}
                      reload={reload}
                      notify={notify}
                      refresh={refresh}
                      refreshing={refreshing || state.refreshing}
                    />
                  )}

                  {page === 'settings' && renderSettings()}
                </StartChecklistAccountsContext.Provider>
              </StartChecklistVisibilityContext.Provider>
            </AccountWelcomeContext.Provider>
          )}
        </main>
      </div>
      {menu && <ContextMenu {...menu} onClose={() => setMenu(undefined)} />}
      {palette && <CommandPalette entries={paletteEntries} onClose={() => setPalette(false)} />}
      {historySearchOpen && (
        <SearchDialog api={api} onSelect={openSearchResult} onClose={() => setHistorySearchOpen(false)} />
      )}
      {shortcutsOpen && <ShortcutHelp onClose={() => setShortcutsOpen(false)} />}
      {archiveList && (
        <ConversationArchive
          key={archiveList}
          kind={archiveList}
          api={api}
          notify={notify}
          projects={allProjects}
          onChanged={() => setHistoryRevision((value) => value + 1)}
          onClose={() => setArchiveList(undefined)}
        />
      )}
      {removedProjectsOpen && state && (
        <RemovedProjectsSheet
          projects={listedRemovedProjects(state.removedProjects, state.settings?.removedProjectsClearedAt)}
          api={api}
          reload={reload}
          notify={notify}
          onClose={() => setRemovedProjectsOpen(false)}
        />
      )}
      {visibleNotice && <NoticeToast notice={visibleNotice} state={state} onClose={closeNotice} />}
      <AppUpdateNotice update={state?.appUpdate} enabled={state?.settings.updateCheck !== false} />
      {state && state.approvals.length > 0 && (
        <div className="approval-stack">
          {state.approvals.map((approval) => {
            const workflow = state.workflows?.find((item) => item.runIds.includes(approval.runId));
            const chat = state.conversations?.find((item) => item.id === workflow?.conversationId);
            if (!chat || chat.sideChat)
              return <ApprovalCard key={approval.id} approval={approval} api={api} notify={notify} />;
            if (visibleIds.includes(chat.id)) return null;
            return (
              <div className="approval-notice" key={approval.id} data-conversation-id={chat.id}>
                <ShieldCheck size={15} aria-hidden="true" />
                <span>需要你的确认</span>
                <span className="approval-notice-chat" translate="no" title={chat.title}>
                  {chat.title}
                </span>
                <button type="button" className="button tiny quiet" onClick={() => void openConversationById(chat.id)}>
                  打开
                </button>
              </div>
            );
          })}
        </div>
      )}
      {state && addProject && (
        <ProjectDialog
          defaultPath={state.settings.defaultProjectPath}
          api={api}
          notify={notify}
          onClose={() => setAddProject(false)}
          onCreated={(value) => {
            void reload();
            selectProject(value);
          }}
        />
      )}
      {movingConversation && (
        <FolderMoveDialog
          chat={movingConversation}
          folders={state?.conversationFolders ?? []}
          api={api}
          reload={reload}
          notify={notify}
          onClose={() => setMovingConversation(undefined)}
        />
      )}
      {memoryOpen && project && (
        <MemoryDialog project={project} api={api} notify={notify} onClose={() => setMemoryOpen(false)} />
      )}
      {handoff && selectedRun && state && (
        <HandoffModal
          run={selectedRun}
          state={state}
          api={api}
          notify={notify}
          onClose={() => setHandoff(false)}
          onRun={onRun}
        />
      )}
    </div>
  );
}
