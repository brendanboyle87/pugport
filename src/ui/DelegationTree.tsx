import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { Archive, ChevronRight, MoreHorizontal, Trash2 } from 'lucide-react';
import type { AppState, Conversation, Workflow } from '../shared/types';
import type { Api, Notice } from './Workspace';
import { swarmMembers, SwarmWorkspace, type SwarmMemberView } from './SwarmWorkspace';
import { isActiveWorkflow, isExecutingWorkflow, isWaitingWorkflow } from './queue-utils';
import { useUiUpdateBlocker } from './ui-update-guard';
import { canUseConversationCollaboration } from '../shared/conversation-collaboration';
import { ContextMenu, type MenuItem } from './DesktopFeatures';
import { confirmDialog } from './confirm-dialog';

const pageSize = 60;
const emptyWorkflows: Workflow[] = [];

function mergeRecords(retained: Workflow[], incoming: Workflow[]) {
  const records = new Map(retained.map((workflow) => [workflow.id, workflow]));
  for (const workflow of incoming) {
    const previous = records.get(workflow.id);
    if (
      previous?.deletedAt ||
      (previous && previous.updatedAt > workflow.updatedAt) ||
      (previous?.archivedAt && previous.updatedAt === workflow.updatedAt && !workflow.archivedAt)
    )
      continue;
    records.set(workflow.id, workflow);
  }
  return [...records.values()];
}

/** One lazy, conversation-scoped view of the recorded delegation graph. */
export function DelegationTree({
  conversation,
  liveWorkflows = emptyWorkflows,
  state,
  active,
  api,
  reload,
  notify,
  onActivate,
  onInspect,
}: {
  conversation: Conversation;
  liveWorkflows?: Workflow[];
  state: AppState;
  active: boolean;
  api: Api;
  reload: () => Promise<unknown>;
  notify: (notice: Notice) => void;
  onActivate: () => Promise<boolean>;
  onInspect: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [saved, setSaved] = useState<Workflow[]>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const [limit, setLimit] = useState(pageSize);
  const [branches, setBranches] = useState<Set<string>>(() => new Set());
  const [selected, setSelected] = useState<string>();
  const [detailOpened, setDetailOpened] = useState(false);
  const [focused, setFocused] = useState<string>();
  const [showArchived, setShowArchived] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; member: SwarmMemberView }>();
  const [changing, setChanging] = useState(false);
  const actionPending = useRef(false);
  const treeContainer = useRef<HTMLDivElement>(null);
  const tree = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const mounted = useRef(true);
  const drafts = useRef<Record<string, string>>({});
  useUiUpdateBlocker(() => Object.values(drafts.current).some((draft) => Boolean(draft.trim())), 'member-message');
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!active) setSelected(undefined);
  }, [active]);
  const eligible =
    canUseConversationCollaboration(
      state.projects?.find((project) => project.id === conversation.projectId),
      conversation,
    ) &&
    (!conversation.incognito || active);
  const liveIdentity = liveWorkflows
    .map(
      (workflow) =>
        `${workflow.id}:${workflow.status}:${workflow.runIds.length}:${workflow.deletedAt ?? ''}:${workflow.archivedAt ?? ''}`,
    )
    .join('|');
  const records = useMemo(() => mergeRecords(saved ?? [], liveWorkflows), [saved, liveWorkflows]);
  const hasActive = records.some(
    (workflow) => workflow.delegation && !workflow.archivedAt && ['running', 'planning'].includes(workflow.status),
  );
  useEffect(() => {
    if (!expanded) return;
    const dismiss = (event: globalThis.MouseEvent) => {
      if (!treeContainer.current?.contains(event.target as Node)) setExpanded(false);
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        setExpanded(false);
        toggle.current?.focus();
      }
    };
    document.addEventListener('mousedown', dismiss);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', dismiss);
      document.removeEventListener('keydown', escape);
    };
  }, [expanded]);
  useEffect(() => {
    if (!expanded || !eligible) return;
    const abort = new AbortController();
    let pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      setLoading(true);
      try {
        const result = await api<{ workflows: Workflow[] }>(
          `/api/conversations/${encodeURIComponent(conversation.id)}/swarm`,
          undefined,
          'GET',
          abort.signal,
        );
        if (!abort.signal.aborted) {
          setSaved((current) =>
            mergeRecords(
              current ?? [],
              result.workflows.filter(
                (workflow) =>
                  workflow.conversationId === conversation.id && workflow.projectId === conversation.projectId,
              ),
            ),
          );
          setError(undefined);
        }
      } catch (cause) {
        if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        pending = false;
        if (!abort.signal.aborted) setLoading(false);
      }
    };
    void refresh();
    const timer = hasActive ? setInterval(() => void refresh(), 15000) : undefined;
    return () => {
      abort.abort();
      if (timer) clearInterval(timer);
    };
  }, [
    api,
    conversation.id,
    conversation.projectId,
    conversation.workflowHistoryRevision,
    expanded,
    eligible,
    liveIdentity,
    hasActive,
    revision,
  ]);
  const allMembers = useMemo(
    () => swarmMembers(records, state.runs, state.targets).filter((member) => member.parentId),
    [records, state.runs, state.targets],
  );
  const priority = (member: SwarmMemberView) =>
    isExecutingWorkflow(member.workflow) && member.workflow.status !== 'waiting-approval'
      ? 0
      : isWaitingWorkflow(member.workflow) || member.workflow.status === 'waiting-approval' || member.workflow.waitingOn
        ? 1
        : 2;
  const members = allMembers.filter((member) => !member.workflow.archivedAt).sort((a, b) => priority(a) - priority(b));
  const archived = allMembers.filter((member) => member.workflow.archivedAt);
  const archivedCount = saved
    ? allMembers.filter((member) => member.workflow.archivedAt).length
    : Math.max(
        conversation.archivedDelegationCount ?? 0,
        allMembers.filter((member) => member.workflow.archivedAt).length,
      );
  const activeCount = allMembers.filter((member) => !member.workflow.archivedAt).length;
  const count = saved ? activeCount : Math.max(conversation.delegationCount ?? 0, activeCount);
  const shown = [...members.slice(0, limit), ...(showArchived ? archived.slice(0, limit) : [])];
  const ids = new Set(shown.map((member) => member.id));
  const children = new Map<string | undefined, SwarmMemberView[]>();
  for (const member of shown) {
    const parent =
      member.parentId &&
      ids.has(member.parentId) &&
      shown.some(
        (candidate) =>
          candidate.id === member.parentId &&
          Boolean(candidate.workflow.archivedAt) === Boolean(member.workflow.archivedAt),
      )
        ? member.parentId
        : undefined;
    children.set(parent, [...(children.get(parent) ?? []), member]);
  }
  const visible = new Set<string>();
  const visit = (parent?: string) => {
    for (const member of children.get(parent) ?? []) {
      visible.add(member.id);
      if (branches.has(member.id)) visit(member.id);
    }
  };
  visit();
  const focusable = focused && visible.has(focused) ? focused : children.get(undefined)?.[0]?.id;
  const open = async (id: string) => {
    if (await onActivate()) {
      if (mounted.current) {
        setDetailOpened(true);
        setSelected(id);
      }
    }
  };
  const close = () => {
    setSelected(undefined);
    requestAnimationFrame(() => {
      const row = [...(tree.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [])].find(
        (item) => item.dataset.memberId === selected,
      );
      (row ?? toggle.current)?.focus();
    });
  };
  const changeBranch = (id: string, open?: boolean) =>
    setBranches((current) => {
      const next = new Set(current);
      if (open ?? !next.has(id)) next.add(id);
      else next.delete(id);
      return next;
    });
  const subtree = (member: SwarmMemberView) => {
    const descendants = new Set([member.id]);
    for (let pass = 0; pass < allMembers.length; pass++) {
      let added = false;
      for (const candidate of allMembers) {
        if (candidate.parentId && descendants.has(candidate.parentId) && !descendants.has(candidate.id)) {
          descendants.add(candidate.id);
          added = true;
        }
      }
      if (!added) break;
    }
    return descendants;
  };
  const unsettled = (member: SwarmMemberView) => {
    const descendants = subtree(member);
    return allMembers.some(
      (candidate) =>
        descendants.has(candidate.id) &&
        (isActiveWorkflow(candidate.workflow) ||
          candidate.workflow.pendingSteer ||
          candidate.workflow.waitingOn ||
          candidate.workflow.executionWorkspace?.delivery?.status === 'applying'),
    );
  };
  const changeMember = async (member: SwarmMemberView, action: 'archive' | 'restore' | 'delete') => {
    if (!member.parentId || actionPending.current || unsettled(member)) return;
    actionPending.current = true;
    setChanging(true);
    try {
      if (
        action === 'delete' &&
        !(await confirmDialog({
          title: '删除这个子代理？',
          summary: `仅隐藏「${member.role}」及其子代理。父对话、其他子代理、执行记录和工作目录都会保留。`,
          action: '删除子代理',
          tone: 'danger',
        }))
      )
        return;
      if (!mounted.current) return;
      const path = `/api/workflows/${encodeURIComponent(member.workflow.id)}`;
      let updated: Workflow | undefined;
      if (action === 'delete') {
        const result = await api<{ ok: boolean }>(path, undefined, 'DELETE');
        if (result.ok !== true) throw Error('服务器尚未确认删除子代理，请刷新核对。');
      } else {
        const result = await api<{ workflow: Workflow }>(`${path}/archive`, { archived: action === 'archive' });
        if (
          result.workflow?.id !== member.workflow.id ||
          result.workflow.conversationId !== conversation.id ||
          !result.workflow.delegation ||
          Boolean(result.workflow.archivedAt) !== (action === 'archive')
        )
          throw Error('服务器尚未确认子代理归档状态，请刷新核对。');
        updated = result.workflow;
      }
      if (!mounted.current) return;
      const affected = subtree(member);
      const attempts = new Set(allMembers.filter((item) => affected.has(item.id)).flatMap((item) => item.workflowIds));
      const at = updated?.updatedAt ?? new Date().toISOString();
      setSaved(
        records.map((workflow) =>
          attempts.has(workflow.id)
            ? {
                ...workflow,
                updatedAt: at,
                ...(action === 'delete' ? { deletedAt: at } : { archivedAt: updated?.archivedAt }),
              }
            : workflow,
        ),
      );
      setSelected(undefined);
      setRevision((value) => value + 1);
      await reload();
    } catch (cause) {
      if (mounted.current) notify({ tone: 'error', message: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      actionPending.current = false;
      if (mounted.current) setChanging(false);
    }
  };
  const menuItems = (member: SwarmMemberView): MenuItem[] => {
    const disabled = changing || unsettled(member);
    return [
      { label: '打开子代理', onSelect: () => void open(member.id) },
      {
        label: member.workflow.archivedAt ? '恢复子代理' : '归档子代理',
        icon: <Archive size={14} />,
        disabled,
        onSelect: () => void changeMember(member, member.workflow.archivedAt ? 'restore' : 'archive'),
      },
      {
        label: '删除子代理',
        icon: <Trash2 size={14} />,
        disabled,
        danger: true,
        onSelect: () => void changeMember(member, 'delete'),
      },
      ...(disabled && !changing ? [{ label: '请先结束此子代理及其后代任务', disabled: true, onSelect: () => {} }] : []),
    ];
  };
  const openMenu = (event: MouseEvent<HTMLElement>, member: SwarmMemberView) => {
    event.preventDefault();
    event.stopPropagation();
    const bounds = event.currentTarget.getBoundingClientRect();
    setMenu({
      x: event.type === 'contextmenu' ? event.clientX : bounds.right,
      y: event.type === 'contextmenu' ? event.clientY : bounds.bottom,
      member,
    });
  };
  const keys = (event: KeyboardEvent<HTMLDivElement>, member: SwarmMemberView) => {
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault();
      event.stopPropagation();
      const bounds = event.currentTarget.getBoundingClientRect();
      setMenu({ x: bounds.left, y: bounds.bottom, member });
      return;
    }
    const rows = [...(tree.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [])];
    const at = rows.indexOf(event.currentTarget);
    const hasChildren = children.has(member.id);
    let target: HTMLElement | undefined;
    if (event.key === 'ArrowDown') target = rows[Math.min(at + 1, rows.length - 1)];
    else if (event.key === 'ArrowUp') target = rows[Math.max(at - 1, 0)];
    else if (event.key === 'Home') target = rows[0];
    else if (event.key === 'End') target = rows.at(-1);
    else if (event.key === 'ArrowRight' && hasChildren) {
      if (!branches.has(member.id)) changeBranch(member.id, true);
      else target = rows[at + 1];
    } else if (event.key === 'ArrowLeft') {
      if (branches.has(member.id)) changeBranch(member.id, false);
      else target = rows.find((row) => row.dataset.memberId === member.parentId);
    } else if (event.key === 'Enter' || event.key === ' ') void open(member.id);
    else return;
    event.preventDefault();
    event.stopPropagation();
    target?.focus();
  };
  const rows = (parent?: string, level = 1, archivedRoot = false) =>
    children
      .get(parent)
      ?.filter((member) => parent || Boolean(member.workflow.archivedAt) === archivedRoot)
      .map((member) => {
        const nested = children.get(member.id);
        return (
          <div role="none" key={member.id}>
            <div
              role="treeitem"
              aria-level={level}
              aria-expanded={nested ? branches.has(member.id) : undefined}
              aria-selected={selected === member.id}
              tabIndex={focusable === member.id ? 0 : -1}
              data-member-id={member.id}
              className={`delegation-tree-row ${selected === member.id ? 'selected' : ''}`}
              style={{ paddingInlineStart: `${(level - 1) * 12}px` }}
              onFocus={() => setFocused(member.id)}
              onKeyDown={(event) => keys(event, member)}
              onContextMenu={(event) => openMenu(event, member)}
            >
              {nested ? (
                <button
                  type="button"
                  tabIndex={-1}
                  className="delegation-branch-toggle"
                  aria-label={`${branches.has(member.id) ? '收起' : '展开'} ${member.role} 的子代理`}
                  onClick={() => changeBranch(member.id)}
                >
                  <ChevronRight size={11} aria-hidden="true" className={branches.has(member.id) ? 'expanded' : ''} />
                </button>
              ) : (
                <span className="delegation-branch-spacer" />
              )}
              <button
                type="button"
                tabIndex={-1}
                className="delegation-member-link"
                title={`${member.role}\n${member.task}\n${member.status}`}
                onClick={() => void open(member.id)}
              >
                <span className="delegation-member-name" translate="no">
                  {member.role}
                </span>
                <span className="delegation-member-status" data-status={member.workflow.status}>
                  {member.status}
                </span>
              </button>
              <button
                type="button"
                tabIndex={-1}
                className="delegation-member-more"
                aria-label={`${member.role} 的子代理操作`}
                title="子代理操作"
                onClick={(event) => openMenu(event, member)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
                }}
              >
                <MoreHorizontal size={13} aria-hidden="true" />
              </button>
            </div>
            {nested && branches.has(member.id) && <div role="group">{rows(member.id, level + 1)}</div>}
          </div>
        );
      });
  // Nothing to show until the conversation has delegated something: no empty chip or panel.
  if (!eligible || (!count && !archivedCount && !hasActive)) return null;
  return (
    <div ref={treeContainer} className="conversation-delegation-tree">
      <button
        ref={toggle}
        type="button"
        className="delegation-tree-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        {hasActive && <span className="delegation-running-dot" aria-label="运行中" />}
        <span>子代理</span>
        {count > 0 && <span className="delegation-tree-count">{count}</span>}
      </button>
      {expanded && (
        <div className="delegation-tree-popover">
          {loading && !saved && !members.length && <p role="status">正在读取子代理…</p>}
          {error && (
            <p role="alert">
              {error}{' '}
              <button type="button" className="inline-link" onClick={() => setRevision((value) => value + 1)}>
                重试
              </button>
            </p>
          )}
          <div ref={tree} role="tree" aria-label={`${conversation.title} 的子代理`}>
            {rows()}
            {members.length > limit && (
              <button
                type="button"
                className="delegation-tree-more"
                onClick={() => setLimit((value) => value + pageSize)}
              >
                显示更多子代理
              </button>
            )}
            {archivedCount > 0 && (
              <button
                type="button"
                className="delegation-tree-more"
                aria-expanded={showArchived}
                onClick={() => {
                  setShowArchived((value) => !value);
                  setLimit(pageSize);
                }}
              >
                {`已归档 (${archivedCount})`}
              </button>
            )}
            {showArchived && rows(undefined, 1, true)}
            {showArchived && archived.length > limit && (
              <button
                type="button"
                className="delegation-tree-more"
                onClick={() => setLimit((value) => value + pageSize)}
              >
                显示更多子代理
              </button>
            )}
          </div>
        </div>
      )}
      {menu &&
        createPortal(
          <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.member)} onClose={() => setMenu(undefined)} />,
          document.body,
        )}
      {detailOpened &&
        createPortal(
          <div className="delegation-detail">
            <SwarmWorkspace
              state={state}
              conversation={conversation}
              api={api}
              reload={reload}
              notify={notify}
              selectedMemberId={active ? selected : undefined}
              onSelectMember={(id) => (id ? setSelected(id) : close())}
              draftSession={drafts}
              onInspect={(id) => {
                close();
                onInspect(id);
              }}
            />
          </div>,
          document.body,
        )}
    </div>
  );
}
