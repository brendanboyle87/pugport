import { currentLocale } from './i18n';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Activity, ArrowUp, ChevronRight, ChevronUp, GitBranch, RefreshCw, X } from 'lucide-react';
import type {
  AppState,
  Conversation,
  ConversationMessage,
  RunRecord,
  RuntimeTarget,
  Workflow,
  Project,
} from '../shared/types';
import { delegationRoleLabels } from '../shared/delegation';
import {
  swarmAgents,
  swarmRoot,
  swarmTimeSaved,
  taskListProgress,
  taskListStateLabels,
  type SwarmMessage,
  type TaskListItem,
  type TaskListState,
} from '../shared/swarm';
import type { Api, Notice } from './Workspace';
import type { WorkflowExecutionRecord } from './execution-records';
import { DelegationProgress, shownAgentLabel } from './DelegationProgress';
import { renderMarkdown } from './markdown';
import { canCancelWorkflow, workflowDisplayStatus } from './queue-utils';
import { TrajectoryDetailDialog } from './Trajectory';
import { Avatar } from './avatar';
import { SideSheet } from './SideSheet';
import { useUiUpdateBlocker } from './ui-update-guard';
import { CreateChildDialog } from './CreateChildDialog';
import { ChildWorkspaceStatus } from './ChildWorkspaceStatus';
import { shownMentionName } from './Mentions';
import { shownName, translateInterfaceText, withNames } from './i18n';

function canShowSwarmMemberPanel(
  project?: Pick<Project, 'id' | 'scope' | 'removedAt'>,
  conversation?: Pick<Conversation, 'projectId' | 'deletedAt' | 'closedAt'>,
) {
  return !!(
    project &&
    conversation &&
    project.id === conversation.projectId &&
    project.scope !== 'chat' &&
    !project.removedAt &&
    !conversation.deletedAt &&
    !conversation.closedAt
  );
}

export type SwarmMemberView = {
  id: string;
  workflow: Workflow;
  workflowIds: string[];
  parentId?: string;
  depth: number;
  /** Role and executor are ready to show as written (translate="no"): PugPort's own names are already translated. */
  role: string;
  task: string;
  executor: string;
  status: string;
  run?: RunRecord;
};
export type SwarmCommunication = {
  id: string;
  from: string;
  to: string;
  text: string;
  at: string;
  status?: string;
  runId: string;
};
export type SwarmDelivery = { ok: true; delivery: 'delivered' | 'queued'; workflowId: string };
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const activeStatuses = [
  'queued',
  'waiting-resource',
  'planning',
  'running',
  'waiting-confirmation',
  'waiting-approval',
];
/** How a member is doing, in four states the eye can tell apart at a glance. */
function memberState(member: SwarmMemberView): 'running' | 'waiting' | 'done' | 'stopped' {
  const status = member.workflow.status;
  if (['planning', 'running', 'waiting-approval'].includes(status)) return 'running';
  if (activeStatuses.includes(status)) return 'waiting';
  if (status === 'completed') return 'done';
  return 'stopped';
}
/** Things a person might hand a swarm, to show what the mode is for; clicking one fills the composer. */
export const swarmExamples = [
  '把这个项目按模块分给几个成员分别审查代码质量，最后汇总成一份问题清单。',
  '让三个成员分别调研同一个问题的不同方案，互相比较后给我推荐一个。',
  '先派一个成员列出要改的文件，再按文件分给几个成员同时修改，最后派一个成员整体检查。',
];

/** Display-only excerpt; the original remains in the disclosure and the full-record dialog. */
export function swarmContentPreview(text: string) {
  const compact = text.replace(/\s+/g, ' ').trim();
  return compact.length > 160 ? `${compact.slice(0, 160)}…` : compact;
}
type ReadingPosition = { top: number; messageId?: string; offset?: number };

/** What a member is called: a role, account or device someone named stays as written; PugPort's own names translate. */
function memberRole(task: Workflow) {
  if (task.agentPreset) return shownMentionName({ kind: 'role', ...task.agentPreset });
  if (task.delegation?.agent) return shownAgentLabel(task.delegation.agent);
  return translateInterfaceText(task.delegation ? delegationRoleLabels[task.delegation.role] : '主 agent');
}

export function swarmMembers(workflows: Workflow[], runs: RunRecord[], targets: RuntimeTarget[]): SwarmMemberView[] {
  const tasks = new Map(workflows.filter((task) => !task.deletedAt).map((task) => [task.id, task]));
  const retained = [...tasks.values()];
  const roots = new Set(retained.map((task) => swarmRoot(task.id, retained)).filter((id): id is string => !!id));
  const agents = [...roots].flatMap((id) => swarmAgents(id, retained));
  const byRun = new Map(runs.map((run) => [run.id, run]));
  const members = agents.map(({ id, workflow, workflowIds, parentId, depth }) => {
    const history = workflowIds.map((taskId) => tasks.get(taskId)!);
    const original = tasks.get(id)!;
    const run = history
      .flatMap((task) => task.runIds.map((runId) => byRun.get(runId)))
      .filter((value): value is RunRecord => !!value && !value.visualAssistant)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id))
      .at(-1);
    const actual = run?.effectiveModel ?? run?.route;
    const label =
      run &&
      shownName(
        run.account?.label ?? targets.find((target) => target.id === run.route.runtimeId)?.label ?? run.route.runtimeId,
      );
    return {
      id,
      workflow,
      workflowIds,
      parentId,
      depth,
      role: memberRole(original),
      task: original.input.intentText ?? original.input.content,
      executor: run
        ? [label, actual?.model, actual?.effort].filter(Boolean).join(' · ')
        : translateInterfaceText(history.some((task) => task.runIds.length) ? '执行配置尚未读取' : '执行器尚未启动'),
      status: workflowDisplayStatus(workflow, runs).label,
      run,
    } satisfies SwarmMemberView;
  });
  const byId = new Map(members.map((member) => [member.id, member]));
  const ordered: SwarmMemberView[] = [],
    visited = new Set<string>();
  const visit = (member: SwarmMemberView) => {
    if (visited.has(member.id)) return;
    visited.add(member.id);
    ordered.push(member);
    members.filter((child) => child.parentId === member.id).forEach(visit);
  };
  members
    .filter((member) => !member.parentId || !byId.has(member.parentId))
    .sort((a, b) => {
      const active = (member: SwarmMemberView) => activeStatuses.includes(member.workflow.status);
      return (
        Number(active(b)) - Number(active(a)) ||
        b.workflow.createdAt.localeCompare(a.workflow.createdAt) ||
        a.id.localeCompare(b.id)
      );
    })
    .forEach(visit);
  members.forEach(visit);
  return ordered;
}

export type SwarmPlanRow = Pick<TaskListItem, 'id' | 'title' | 'kind'> & { state: TaskListState; who?: string };
export type SwarmPlanView = { scope: string; rows: SwarmPlanRow[]; done: number };

/** The current swarm: the first root in the member order (an active one, else the newest). */
const currentRoot = (members: SwarmMemberView[]) => members.find((member) => !member.parentId);

/**
 * The coordinator's task list for the current swarm, each item with the state and executor of the member working on
 * it. The list lives on the coordinator's newest task that has one, so a continuation keeps showing it.
 */
export function swarmPlan(workflows: Workflow[], members: SwarmMemberView[]): SwarmPlanView | undefined {
  const root = currentRoot(members);
  if (!root) return undefined;
  const owner = workflows
    .filter((task) => root.workflowIds.includes(task.id) && task.taskList?.items.length)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .at(-1);
  if (!owner?.taskList) return undefined;
  const linked = members.filter((member) => member.parentId === root.id);
  const rows = taskListProgress(owner.taskList.items, linked).map(({ id, title, kind, state, member, assignee }) => {
    const account = member?.run ? member.executor.split(' · ')[0] : undefined;
    return {
      id,
      title,
      kind,
      state,
      // The coordinator names who it means to give an item to as written in the participant list.
      ...(account || member || assignee
        ? {
            who:
              account ??
              member?.role ??
              (assignee === '自动选择' ? translateInterfaceText(assignee) : shownName(assignee!)),
          }
        : {}),
    };
  });
  return {
    scope: JSON.stringify([owner.projectId, owner.conversationId, root.id, owner.id]),
    rows,
    done: rows.filter((row) => row.state === 'done').length,
  };
}

/**
 * An ordinary chat's task list: on its newest root task that has one, with items linked to that task's delegated
 * members and to the newest root task of each work lane created for an item.
 */
export function conversationPlan(
  workflows: Workflow[],
  conversations: Conversation[],
  conversationId: string,
): SwarmPlanView | undefined {
  const newest = (list: Workflow[]) => list.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
  const roots = (id: string) =>
    workflows.filter((task) => task.conversationId === id && !task.delegation && !task.deletedAt);
  const owner = newest(roots(conversationId).filter((task) => task.taskList?.items.length));
  if (!owner?.taskList) return undefined;
  const members: Array<{ workflow: Workflow; planItem?: string }> = workflows
    .filter((task) => task.delegation?.parentId === owner.id && !task.deletedAt)
    .map((workflow) => ({ workflow }));
  for (const lane of conversations) {
    if (lane.deletedAt) continue;
    const workflow = lane.lane?.parentConversationId === conversationId && lane.lane.planItem && newest(roots(lane.id));
    if (workflow) members.push({ workflow, planItem: lane.lane!.planItem });
  }
  const rows = taskListProgress(owner.taskList.items, members).map(({ id, title, kind, state, member, assignee }) => {
    const who = member?.workflow.delegation?.agent?.label ?? assignee;
    return { id, title, kind, state, ...(who ? { who } : {}) };
  });
  return {
    scope: JSON.stringify([owner.projectId, conversationId, owner.id]),
    rows,
    done: rows.filter((row) => row.state === 'done').length,
  };
}

/** Members' run time added up against the wall-clock span of their work, once the swarm has finished. */
export function swarmSavedTime(members: SwarmMemberView[], runs: RunRecord[]) {
  const root = currentRoot(members);
  if (!root || activeStatuses.includes(root.workflow.status)) return undefined;
  const family = new Set<string>([root.id]);
  for (let grew = true; grew;) {
    grew = false;
    for (const member of members)
      if (member.parentId && family.has(member.parentId) && !family.has(member.id)) {
        family.add(member.id);
        grew = true;
      }
  }
  // A member that handed work on mostly waited for its helpers; counting it too would count that time twice.
  const leaves = members.filter(
    (member) => member.parentId && family.has(member.id) && !members.some((other) => other.parentId === member.id),
  );
  const ids = new Set(leaves.flatMap((member) => member.workflowIds));
  return swarmTimeSaved(runs.filter((run) => run.workflowId && ids.has(run.workflowId) && !run.visualAssistant));
}

/**
 * "并行省了约 12 分钟", "并行省了约 1 小时 5 分钟": each a whole sentence, so the English window translates it in one
 * piece. Under a minute is not worth showing.
 */
export function savedTimeText(ms: number): string | undefined {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return undefined;
  const hours = Math.floor(minutes / 60);
  if (!hours) return `并行省了约 ${minutes} 分钟`;
  return minutes % 60 ? `并行省了约 ${hours} 小时 ${minutes % 60} 分钟` : `并行省了约 ${hours} 小时`;
}

/** Only typed, recorded communication can create a message edge; prose and tool names cannot. */
export function swarmCommunications(
  members: SwarmMemberView[],
  runs: RunRecord[],
  persistent: SwarmMessage[] = [],
): SwarmCommunication[] {
  const byWorkflow = new Map(members.flatMap((member) => member.workflowIds.map((id) => [id, member.id] as const)));
  const byRun = new Map(runs.map((run) => [run.id, run]));
  const observed = new Map<string, SwarmCommunication>();
  for (const run of runs)
    for (const event of run.events) {
      if (event.type === 'reasoning' || event.data?.kind !== 'communication') continue;
      const detail = event.data.detail;
      if (!detail || typeof detail !== 'object' || Array.isArray(detail)) continue;
      const data = detail as Record<string, unknown>;
      const fromWorkflow =
        typeof data.fromWorkflowId === 'string'
          ? data.fromWorkflowId
          : typeof data.fromRunId === 'string'
            ? byRun.get(data.fromRunId)?.workflowId
            : run.workflowId;
      const toWorkflow =
        typeof data.toWorkflowId === 'string'
          ? data.toWorkflowId
          : typeof data.toRunId === 'string'
            ? byRun.get(data.toRunId)?.workflowId
            : undefined;
      const from = fromWorkflow && byWorkflow.get(fromWorkflow),
        to = toWorkflow && byWorkflow.get(toWorkflow);
      if (!from || !to || from === to) continue;
      const id = typeof data.messageId === 'string' ? data.messageId : `${from}:${to}:${event.at}:${event.seq ?? ''}`;
      observed.set(id, {
        id,
        from,
        to,
        at: event.at,
        runId: run.id,
        text: typeof data.text === 'string' ? data.text : (event.text ?? ''),
        status: typeof data.status === 'string' ? data.status : undefined,
      });
    }
  for (const message of persistent) {
    const from = message.fromWorkflowId && byWorkflow.get(message.fromWorkflowId),
      to = byWorkflow.get(message.toWorkflowId);
    if (message.source !== 'agent' || !from || !to || from === to) continue;
    observed.set(message.id, {
      id: message.id,
      from,
      to,
      text: message.text,
      at: message.createdAt,
      status: message.status,
      runId: message.fromRunId ?? '',
    });
  }
  return [...observed.values()].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
}

/** Live rows update a running record while its archived events remain available. */
export function swarmRunRecords(archived: RunRecord[], live: RunRecord[]): RunRecord[] {
  const all = new Map(archived.map((run) => [run.id, run]));
  for (const run of live) {
    const saved = all.get(run.id);
    if (saved && !['queued', 'running', 'waiting-approval'].includes(saved.status)) continue;
    const events = new Map(
      (saved?.events ?? []).map((event) => [
        event.seq === undefined ? JSON.stringify(event) : String(event.seq),
        event,
      ]),
    );
    for (const event of run.events)
      events.set(event.seq === undefined ? JSON.stringify(event) : String(event.seq), event);
    all.set(run.id, {
      ...run,
      events: [...events.values()].sort((a, b) =>
        a.seq !== undefined && b.seq !== undefined ? a.seq - b.seq : a.at.localeCompare(b.at),
      ),
    });
  }
  return [...all.values()];
}

export function swarmMemberMessages(member: SwarmMemberView, messages: ConversationMessage[]) {
  const ids = new Set(member.workflowIds);
  return messages
    .filter((message) => !!message.workflowId && ids.has(message.workflowId))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

export async function sendSwarmMessage(api: Api, workflowId: string, text: string): Promise<SwarmDelivery> {
  if (!text.trim() || text.length > 8000) throw new Error('消息不能为空或超过 8000 字。');
  const reply = await api<SwarmDelivery>(
    `/api/workflows/${encodeURIComponent(workflowId)}/swarm-message`,
    { text },
    'POST',
  );
  if (reply.ok !== true || !['delivered', 'queued'].includes(reply.delivery) || !reply.workflowId)
    throw new Error('服务器尚未确认消息送达或入队；请保留原消息后重试。');
  return reply;
}

type HistoryItem =
  | { kind: 'message'; key: string; at: string; message: ConversationMessage }
  | { kind: 'member'; key: string; at: string; message: SwarmMessage }
  | { kind: 'peer'; key: string; at: string; message: SwarmCommunication };

/**
 * A member-to-member message as it appears inside the conversation, like a line in a group chat. `from` and `to` are
 * the members' names as shown (memberRole), ready for translate="no".
 */
export type SwarmChatLine = { id: string; at: string; from: string; to: string; text: string };

export function swarmChatLines(members: SwarmMemberView[], communications: SwarmCommunication[]): SwarmChatLine[] {
  const roleOf = (id: string) => members.find((member) => member.id === id)?.role ?? id;
  return communications.map((message) => ({
    id: message.id,
    at: message.at,
    from: roleOf(message.from),
    to: roleOf(message.to),
    text: message.text,
  }));
}

export function SwarmChatLineView({ line }: { line: SwarmChatLine }) {
  const time = new Date(line.at).toLocaleTimeString(currentLocale(), { hour: '2-digit', minute: '2-digit' });
  const who = (
    <span className="swarm-chat-who">
      <Avatar name={line.from} size={18} />
      {line.from}
      <span className="swarm-chat-arrow" aria-hidden="true">
        →
      </span>
      {line.to}
    </span>
  );
  if (line.text.length > 160 || line.text.split(/\r?\n/).length > 2)
    return (
      <details className="swarm-chat-line">
        <summary>
          {who}
          <span className="swarm-chat-text">{swarmContentPreview(line.text)}</span>
          <time dateTime={line.at}>{time}</time>
        </summary>
        <div className="swarm-chat-full">{renderMarkdown(line.text)}</div>
      </details>
    );
  return (
    <div className="swarm-chat-line">
      {who}
      <span className="swarm-chat-text">{line.text}</span>
      <time dateTime={line.at}>{time}</time>
    </div>
  );
}

const stateLabels = { running: '在干活', waiting: '等待中', done: '做完了', stopped: '已停止' } as const;

const hiddenPlanRowsKey = 'pugport-hidden-swarm-plan-rows';
const hiddenPlanRowsLimit = 500;
let hiddenPlanRows: string[] | undefined;
function readHiddenPlanRows(): string[] {
  if (hiddenPlanRows) return hiddenPlanRows;
  try {
    const value = localStorage.getItem(hiddenPlanRowsKey);
    const parsed: unknown = value && value.length <= 256_000 ? JSON.parse(value) : [];
    hiddenPlanRows = Array.isArray(parsed)
      ? [...new Set(parsed.filter((key): key is string => typeof key === 'string' && key.length <= 1024))].slice(
          -hiddenPlanRowsLimit,
        )
      : [];
  } catch {
    hiddenPlanRows = [];
  }
  return hiddenPlanRows;
}
function rememberHiddenPlanRows(rows: string[]) {
  hiddenPlanRows = [...new Set(rows)].slice(-hiddenPlanRowsLimit);
  try {
    localStorage.setItem(hiddenPlanRowsKey, JSON.stringify(hiddenPlanRows));
  } catch {
    // Keep the current device's choice in memory when storage is unavailable.
  }
  return hiddenPlanRows;
}
const canHidePlanRow = (row: SwarmPlanRow) => row.state === 'done' || row.state === 'failed';

const swarmDetailsKey = 'pugport-swarm-details';
let swarmDetails: Array<[string, boolean]> | undefined;
function readSwarmDetails(): Array<[string, boolean]> {
  if (swarmDetails) return swarmDetails;
  try {
    const value = localStorage.getItem(swarmDetailsKey);
    const parsed: unknown = value && value.length <= 128_000 ? JSON.parse(value) : [];
    swarmDetails = Array.isArray(parsed)
      ? parsed
          .filter(
            (entry): entry is [string, boolean] =>
              Array.isArray(entry) &&
              typeof entry[0] === 'string' &&
              entry[0].length <= 1024 &&
              typeof entry[1] === 'boolean',
          )
          .slice(-100)
      : [];
  } catch {
    swarmDetails = [];
  }
  return swarmDetails;
}
function rememberSwarmDetails(current: Array<[string, boolean]>, scope: string, expanded: boolean) {
  swarmDetails = [...current.filter(([key]) => key !== scope), [scope, expanded] as [string, boolean]].slice(-100);
  try {
    localStorage.setItem(swarmDetailsKey, JSON.stringify(swarmDetails));
  } catch {
    // Closing the details still works for this app session when device storage is unavailable.
  }
  return swarmDetails;
}

/** The task list above the group chat: one compact line per item, with who is on it. */
export function SwarmPlanPanel({ plan, saved }: { plan: SwarmPlanView; saved?: string }) {
  const [hidden, setHidden] = useState(readHiddenPlanRows);
  const rowKey = (row: SwarmPlanRow) => JSON.stringify([plan.scope, row.id]);
  const rows = plan.rows.filter((row) => !canHidePlanRow(row) || !hidden.includes(rowKey(row)));
  const hiddenCount = plan.rows.length - rows.length;
  useEffect(() => {
    const activeKeys = new Set(plan.rows.filter((row) => !canHidePlanRow(row)).map(rowKey));
    if (hidden.some((key) => activeKeys.has(key)))
      setHidden((current) => rememberHiddenPlanRows(current.filter((key) => !activeKeys.has(key))));
  }, [plan.scope, plan.rows, hidden]);
  const restore = hiddenCount > 0 && (
    <button
      type="button"
      className="inline-link swarm-plan-restore"
      onClick={() => {
        const keys = new Set(plan.rows.map(rowKey));
        setHidden((current) => rememberHiddenPlanRows(current.filter((key) => !keys.has(key))));
      }}
    >
      恢复已隐藏任务 <span>({hiddenCount})</span>
    </button>
  );
  if (!rows.length)
    return (
      <section className="swarm-plan swarm-plan-hidden" aria-label="任务清单">
        {restore}
      </section>
    );
  return (
    <section className="swarm-plan" aria-label="任务清单">
      <header>
        <strong>任务清单</strong>
        <span>
          {rows.filter((row) => row.state === 'done').length}/{rows.length} 完成
        </span>
        {saved && <span className="swarm-saved">{saved}</span>}
        {restore}
      </header>
      <ol>
        {rows.map((row) => (
          <li key={row.id} className={`swarm-plan-item ${row.state}`}>
            <span className="swarm-plan-state">{taskListStateLabels[row.state]}</span>
            <span className="swarm-plan-title" title={row.title} translate="no">
              {row.title}
            </span>
            <span className="swarm-plan-meta">
              {row.kind === 'write' ? '改文件' : '只读'}
              {row.who && (
                <>
                  {' · '}
                  <span translate="no">{row.who}</span>
                </>
              )}
            </span>
            {canHidePlanRow(row) && (
              <button
                type="button"
                className="icon-button tiny swarm-plan-hide"
                aria-label={`隐藏任务：${row.title}`}
                title="从任务清单隐藏，历史记录保留"
                onClick={() => setHidden((current) => rememberHiddenPlanRows([...current, rowKey(row)]))}
              >
                <X size={13} aria-hidden="true" />
              </button>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

/**
 * The swarm inside a normal conversation: a strip of member avatars under the title, and a side sheet for the
 * member you open, with its task, progress, what it said and heard, and a box to talk to it directly.
 */
export function SwarmWorkspaceView({
  members,
  selectedId,
  messages,
  communications,
  memberMessages = [],
  loading,
  error,
  sending,
  draft,
  delivery,
  state,
  onSelect,
  onRefresh,
  onDraft,
  onSend,
  onInspect,
  onExample,
  plan,
  saved,
  detailsOnly = false,
  onCancel,
  cancelling = false,
  onCreateChild,
  childDialog,
  onContinue,
  onDeliver,
  memberActionPending = false,
}: {
  members: SwarmMemberView[];
  communications: SwarmCommunication[];
  /** The coordinator's task list, shown above the group chat. */
  plan?: SwarmPlanView;
  /** How much time running members side by side saved, once the swarm finished ("并行省了约 12 分钟"). */
  saved?: string;
  selectedId?: string;
  messages: ConversationMessage[];
  memberMessages?: SwarmMessage[];
  loading: boolean;
  error?: string;
  sending: boolean;
  draft: string;
  delivery?: string;
  /** Live app state, for a member's progress while it works. */
  state?: AppState;
  /** Undefined closes the member sheet. */
  onSelect: (id?: string) => void;
  /** Re-reads the member records now instead of waiting for the next update. */
  onRefresh?: () => void;
  onDraft: (text: string) => void;
  onSend: () => void;
  onInspect: (runId: string) => void;
  /** Puts an example task into the conversation composer. */
  onExample?: (text: string) => void;
  detailsOnly?: boolean;
  onCancel?: () => void;
  cancelling?: boolean;
  onCreateChild?: () => void;
  childDialog?: ReactNode;
  onContinue?: () => void;
  onDeliver?: () => void;
  memberActionPending?: boolean;
}) {
  const selected = members.find((member) => member.id === selectedId);
  const [detailsPreferences, setDetailsPreferences] = useState(readSwarmDetails);
  const root = currentRoot(members);
  const detailsScope = root && JSON.stringify([root.workflow.projectId, root.workflow.conversationId, root.id]);
  const activeCount = members.filter((member) => activeStatuses.includes(member.workflow.status)).length;
  const detailsExpanded =
    !detailsScope || (detailsPreferences.find(([scope]) => scope === detailsScope)?.[1] ?? activeCount > 0);
  const setDetailsExpanded = (expanded: boolean) => {
    if (detailsScope) setDetailsPreferences((current) => rememberSwarmDetails(current, detailsScope, expanded));
  };
  const [detail, setDetail] = useState<{ title: ReactNode; text: string }>();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [updates, setUpdates] = useState<{ added: string[]; changed: string[] }>();
  const historyRef = useRef<HTMLDivElement>(null);
  const reading = useRef({
    memberId: undefined as string | undefined,
    ready: false,
    known: new Map<string, string>(),
    positions: new Map<string, ReadingPosition>(),
  });
  const selection = selected?.id;
  const working = members.filter((member) => memberState(member) === 'running').length;
  const roleOf = (id: string) => members.find((member) => member.id === id)?.role ?? id;
  const peer = selected
    ? communications.filter((message) => message.from === selected.id || message.to === selected.id)
    : [];
  const history: HistoryItem[] = [
    ...messages.map((message) => ({
      kind: 'message' as const,
      key: `message:${message.id}`,
      at: message.createdAt,
      message,
    })),
    ...memberMessages.map((message) => ({
      kind: 'member' as const,
      key: `member:${message.id}`,
      at: message.createdAt,
      message,
    })),
    ...peer.map((message) => ({ kind: 'peer' as const, key: `peer:${message.id}`, at: message.at, message })),
  ].sort((a, b) => a.at.localeCompare(b.at) || a.key.localeCompare(b.key));
  const saveReading = () => {
    const node = historyRef.current;
    if (!node || !selection) return;
    const top = node.getBoundingClientRect().top;
    const anchor = [...node.querySelectorAll<HTMLElement>('[data-swarm-message]')].find(
      (item) => item.getBoundingClientRect().bottom > top,
    );
    reading.current.positions.set(selection, {
      top: node.scrollTop,
      ...(anchor ? { messageId: anchor.dataset.swarmMessage, offset: anchor.getBoundingClientRect().top - top } : {}),
    });
  };
  const restoreReading = (position?: ReadingPosition) => {
    const node = historyRef.current;
    if (!node) return;
    const anchor =
      position?.messageId &&
      [...node.querySelectorAll<HTMLElement>('[data-swarm-message]')].find(
        (item) => item.dataset.swarmMessage === position.messageId,
      );
    const top =
      anchor && position?.offset !== undefined
        ? node.scrollTop + anchor.getBoundingClientRect().top - node.getBoundingClientRect().top - position.offset
        : (position?.top ?? 0);
    if (node.scrollTop !== top) node.scrollTop = top;
  };
  const historyIdentity = history
    .map(
      (item) =>
        `${item.key}\n${item.kind === 'message' ? item.message.content : `${item.message.status}\n${item.message.text}`}`,
    )
    .join('\u0000');
  useLayoutEffect(() => {
    const current = new Map(
      history.map(
        (item) =>
          [
            item.key,
            item.kind === 'message' ? item.message.content : `${item.message.status}\n${item.message.text}`,
          ] as const,
      ),
    );
    const previous = reading.current;
    if (previous.memberId !== selection) {
      previous.memberId = selection;
      previous.ready = !loading;
      previous.known = current;
      setUpdates(undefined);
      restoreReading(selection ? previous.positions.get(selection) : undefined);
      return;
    }
    const changed = previous.ready ? [...current].filter(([id, text]) => previous.known.get(id) !== text) : [];
    const addedIds = changed.filter(([id]) => !previous.known.has(id)).map(([id]) => id);
    const changedIds = changed.filter(([id]) => previous.known.has(id)).map(([id]) => id);
    previous.known = current;
    if (!loading) previous.ready = true;
    if (changed.length) {
      setUpdates((pending) => {
        const added = [...new Set([...(pending?.added ?? []), ...addedIds])];
        return {
          added,
          changed: [...new Set([...(pending?.changed ?? []), ...changedIds])].filter((id) => !added.includes(id)),
        };
      });
      if (selection) restoreReading(previous.positions.get(selection));
    }
  }, [selection, historyIdentity, loading]);
  const showUpdates = () => {
    const node = historyRef.current;
    const target =
      node &&
      [...node.querySelectorAll<HTMLElement>('[data-swarm-message]')].find(
        (item) => item.dataset.swarmMessage === (updates?.added[0] ?? updates?.changed[0]),
      );
    if (node && target) node.scrollTop += target.getBoundingClientRect().top - node.getBoundingClientRect().top;
    saveReading();
    setUpdates(undefined);
  };
  const body = (text: string, id: string) => {
    if (text.length <= 320 && text.split(/\r?\n/).length <= 6)
      return (
        <div className="swarm-complete-text" translate="no">
          {renderMarkdown(text)}
        </div>
      );
    return (
      <details
        className="swarm-message-content"
        open={expanded[id] ?? false}
        onToggle={(event) => {
          const open = event.currentTarget.open;
          setExpanded((current) => (current[id] === open ? current : { ...current, [id]: open }));
          saveReading();
        }}
      >
        <summary>
          <span className="swarm-message-preview" translate="no">
            {swarmContentPreview(text)}
          </span>
          <small>
            {expanded[id] ? '收起详情' : '展开详情'} · {text.length.toLocaleString()} 字
          </small>
        </summary>
        {expanded[id] && (
          <div className="swarm-complete-text" translate="no">
            {renderMarkdown(text)}
          </div>
        )}
      </details>
    );
  };
  const latestReply = messages.filter((message) => message.role === 'assistant').at(-1)?.id;
  const firstInput = messages.find((message) => message.role === 'user')?.id;
  const article = (item: HistoryItem) => {
    const { title, text, tone } =
      item.kind === 'message'
        ? {
            title:
              item.message.role === 'user'
                ? item.message.id === firstInput
                  ? '分到的任务'
                  : '用户消息'
                : item.message.id === latestReply
                  ? '成员答复 · 最新'
                  : '成员答复',
            text: item.message.content,
            tone: item.message.role,
          }
        : item.kind === 'member'
          ? {
              title: `你的留言 · ${item.message.status === 'queued' ? '已排队' : '已送达'}`,
              text: item.message.text,
              tone: 'user',
            }
          : item.message.to === selection
            ? { title: withNames('来自 {0}', [roleOf(item.message.from)]), text: item.message.text, tone: 'peer' }
            : {
                title: withNames('发给 {0}', [roleOf(item.message.to)]),
                text: item.message.text,
                tone: 'peer outgoing',
              };
    // A message between members names one of them; the other headings are interface text.
    const heading = item.kind === 'peer' ? <span translate="no">{title}</span> : title;
    return (
      <article key={item.key} data-swarm-message={item.key} className={`swarm-history-message ${tone}`}>
        <header>
          <strong>{heading}</strong>
          <time dateTime={item.at}>
            {new Date(item.at).toLocaleTimeString(currentLocale(), { hour: '2-digit', minute: '2-digit' })}
          </time>
          <button type="button" className="swarm-full-text" onClick={() => setDetail({ title: heading, text })}>
            查看全文
          </button>
        </header>
        {body(text, item.key)}
      </article>
    );
  };
  const recruits = selected ? members.filter((member) => member.parentId === selected.id) : [];
  return (
    <>
      {childDialog}
      {!detailsOnly &&
        (!detailsExpanded ? (
          <button
            type="button"
            className={`swarm-details-toggle${activeCount ? ' active' : ''}`}
            aria-expanded="false"
            aria-label="展开成员与任务"
            onClick={() => setDetailsExpanded(true)}
          >
            <ChevronRight size={13} aria-hidden="true" />
            <span>成员与任务</span>
            <span className="swarm-details-summary">
              {activeCount ? `${activeCount} 位进行中` : members.length === 1 ? '1 位成员' : `${members.length} 位成员`}
            </span>
            {error && (
              <span className="swarm-error" role="alert">
                {error}
              </span>
            )}
          </button>
        ) : (
          <>
            <div className="swarm-bar" role="toolbar" aria-label="蜂群成员">
              {detailsScope ? (
                <button
                  type="button"
                  className="swarm-details-toggle swarm-details-hide"
                  aria-label="收起成员与任务"
                  title="收起成员与任务"
                  aria-expanded="true"
                  onClick={() => setDetailsExpanded(false)}
                >
                  <ChevronUp size={13} aria-hidden="true" />
                  <span>成员与任务</span>
                </button>
              ) : (
                <GitBranch size={14} className="swarm-bar-icon" aria-hidden="true" />
              )}
              <span className="swarm-bar-summary">
                {members.length
                  ? // Pieces joined with " · ", so the English window translates each count on its own ("1 member").
                    [
                      members.length === 1 ? '1 位成员' : `${members.length} 位成员`,
                      working ? `${working} 位在干活` : '',
                      saved && !plan ? saved : '',
                    ]
                      .filter(Boolean)
                      .join(' · ')
                  : loading
                    ? '正在读取蜂群…'
                    : '蜂群已开'}
              </span>
              <div className="swarm-avatars">
                {members.map((member) => {
                  const now = memberState(member);
                  return (
                    <button
                      type="button"
                      key={member.id}
                      className={`swarm-avatar ${now} ${selected?.id === member.id ? 'selected' : ''}`}
                      aria-pressed={selected?.id === member.id}
                      aria-label={`${member.role} · ${translateInterfaceText(member.status)}`}
                      title={`${member.role} · ${translateInterfaceText(stateLabels[now])}\n${swarmContentPreview(member.task)}`}
                      data-names
                      onClick={() => onSelect(selected?.id === member.id ? undefined : member.id)}
                    >
                      <Avatar name={member.role} neutral={!member.parentId} />
                      <i className="swarm-avatar-dot" aria-hidden="true" />
                    </button>
                  );
                })}
              </div>
              {!members.length && !loading && (
                <span className="swarm-bar-hint">
                  给主 agent 布置任务，它会按需要拉成员进来。
                  {onExample && (
                    <button type="button" className="swarm-example" onClick={() => onExample(swarmExamples[0]!)}>
                      试一个例子
                    </button>
                  )}
                </span>
              )}
              {error && (
                <span className="swarm-error" role="alert">
                  {error}
                </span>
              )}
            </div>
            {plan && <SwarmPlanPanel plan={plan} saved={saved} />}
          </>
        ))}
      {detailsOnly && selectedId && !selected && (
        <SideSheet label="子代理详情" title="子代理详情" onClose={() => onSelect(undefined)}>
          <p role={error ? 'alert' : 'status'}>
            {error ?? (loading ? '正在读取成员对话…' : '这位成员已不在任务记录中。')}
          </p>
          {onRefresh && (
            <button type="button" className="button tiny quiet" onClick={onRefresh}>
              刷新
            </button>
          )}
        </SideSheet>
      )}
      {selected && (
        <SideSheet
          className="swarm-member-sheet"
          label={withNames('成员 {0}', [selected.role])}
          names
          leading={<Avatar name={selected.role} neutral={!selected.parentId} size={34} />}
          title={<span translate="no">{selected.role}</span>}
          subtitle={
            <>
              <span className={`swarm-state ${memberState(selected)}`}>{stateLabels[memberState(selected)]}</span>
              {' · '}
              <span translate="no">{selected.executor}</span>
            </>
          }
          actions={
            <>
              {onRefresh && (
                <button type="button" className="icon-button" aria-label="刷新蜂群" title="刷新" onClick={onRefresh}>
                  <RefreshCw size={14} />
                </button>
              )}
              {selected.run && (
                <button type="button" className="button tiny quiet" onClick={() => onInspect(selected.run!.id)}>
                  <Activity size={13} />
                  轨迹
                </button>
              )}
              {onCreateChild &&
                !selected.workflow.stopped &&
                !selected.workflow.archivedAt &&
                selected.workflow.status !== 'cancelled' &&
                !selected.workflow.deletedAt && (
                  <button
                    type="button"
                    className="icon-button"
                    aria-label="创建子代理"
                    title="创建子代理"
                    onClick={onCreateChild}
                  >
                    <GitBranch size={14} />
                  </button>
                )}
              {onCancel && canCancelWorkflow(selected.workflow) && (
                <button type="button" className="button tiny quiet" disabled={cancelling} onClick={onCancel}>
                  停止此成员
                </button>
              )}
            </>
          }
          onClose={() => onSelect(undefined)}
        >
          {error && (
            <p className="swarm-error" role="alert">
              {error}
            </p>
          )}
          {state && selected.workflow.delegation && (
            <DelegationProgress
              workflow={selected.workflow}
              state={state}
              sequence={members.filter((member) => member.parentId === selected.parentId).indexOf(selected) + 1}
              messages={messages}
            />
          )}
          <ChildWorkspaceStatus
            workflow={selected.workflow}
            onContinue={selected.workflow.archivedAt ? undefined : onContinue}
            onDeliver={selected.workflow.archivedAt ? undefined : onDeliver}
            pending={memberActionPending}
          />
          {recruits.length > 0 && (
            <p className="swarm-recruits">
              它拉了 {recruits.length} 位：
              {recruits.map((member) => (
                <button key={member.id} type="button" onClick={() => onSelect(member.id)}>
                  <Avatar name={member.role} size={18} />
                  <span translate="no">{member.role}</span>
                </button>
              ))}
            </p>
          )}
          <div className="swarm-member-history" aria-label="所选成员对话" ref={historyRef} onScroll={saveReading}>
            {history.map(article)}
            {!history.length && (
              <p className="quiet-text">
                {loading ? '正在读取成员对话…' : '它的答复、和其他成员互发的消息都会按时间出现在这里。'}
              </p>
            )}
          </div>
          {updates && (
            <button type="button" className="button tiny quiet swarm-new-content" onClick={showUpdates}>
              {[
                updates.added.length ? `${updates.added.length} 条新记录` : undefined,
                updates.changed.length ? `${updates.changed.length} 条记录更新` : undefined,
              ]
                .filter(Boolean)
                .join(' · ')}{' '}
              · 点击查看
            </button>
          )}
          {selected.workflow.archivedAt ? (
            <p role="status">此子代理已归档。请在子代理菜单中恢复后再继续。</p>
          ) : (
            <form
              className="swarm-member-composer"
              onSubmit={(event) => {
                event.preventDefault();
                if (!sending && draft.trim()) onSend();
              }}
            >
              <textarea
                aria-label={withNames('给 {0} 留言', [selected.role])}
                placeholder={withNames(
                  memberState(selected) === 'running'
                    ? '单独跟 {0} 说…它正在干活，会在当前任务里收到'
                    : '单独跟 {0} 说…它下次开始干活时会收到',
                  [selected.role],
                )}
                data-names
                value={draft}
                maxLength={8000}
                onChange={(event) => onDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    if (!sending && draft.trim()) onSend();
                  }
                }}
              />
              <button
                type="submit"
                className="send-button"
                disabled={sending || !draft.trim()}
                aria-label="发送成员消息"
              >
                <ArrowUp size={17} />
              </button>
              {delivery && <p role="status">{delivery}</p>}
            </form>
          )}
        </SideSheet>
      )}
      {detail && (
        <TrajectoryDetailDialog title={detail.title} text={detail.text} onClose={() => setDetail(undefined)} />
      )}
    </>
  );
}

export function SwarmWorkspace({
  state,
  conversation,
  api,
  reload,
  notify,
  onInspect,
  onLines,
  onExample,
  selectedMemberId,
  onSelectMember,
  draftSession,
}: {
  state: AppState;
  conversation: Conversation;
  api: Api;
  reload: () => Promise<unknown>;
  notify: (notice: Notice) => void;
  onInspect: (runId: string) => void;
  /** Member-to-member messages, for the conversation to show in line like a group chat. */
  onLines?: (lines: SwarmChatLine[]) => void;
  onExample?: (text: string) => void;
  /** A sidebar tree owns selection while the existing member sheet handles records and messages. */
  selectedMemberId?: string;
  onSelectMember?: (id?: string) => void;
  draftSession?: { current: Record<string, string> };
}) {
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [archivedRuns, setArchivedRuns] = useState<RunRecord[]>([]);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [memberMessages, setMemberMessages] = useState<SwarmMessage[]>([]);
  const [localSelectedId, setSelectedId] = useState<string>();
  const selectedId = onSelectMember ? selectedMemberId : localSelectedId;
  const projectAllowed = canShowSwarmMemberPanel(
    state.projects?.find((project) => project.id === conversation.projectId),
    conversation,
  );
  const visible = projectAllowed && (!onSelectMember || Boolean(selectedMemberId));
  const [loading, setLoading] = useState(true),
    [error, setError] = useState<string>();
  const [drafts, setDrafts] = useState<Record<string, string>>(() => draftSession?.current ?? {});
  useEffect(() => {
    if (draftSession) draftSession.current = drafts;
  }, [draftSession, drafts]);
  useUiUpdateBlocker(() => Object.values(drafts).some((draft) => Boolean(draft.trim())), 'member-message');
  const [cancelling, setCancelling] = useState(false);
  const [childParent, setChildParent] = useState<Workflow>();
  const [memberActionPending, setMemberActionPending] = useState(false);
  const memberActionRequest = useRef<symbol | undefined>(undefined);
  const [delivery, setDelivery] = useState<{ memberId: string; text: string }>(),
    [sending, setSending] = useState(false);
  const [revision, setRevision] = useState(0);
  const sendingRef = useRef<symbol | undefined>(undefined);
  const session = useRef(conversation.id);
  session.current = conversation.id;
  const runs = useMemo(() => swarmRunRecords(archivedRuns, state.runs), [archivedRuns, state.runs]);
  const members = useMemo(
    () =>
      swarmMembers(workflows, runs, state.targets).filter(
        (member) => !member.workflow.archivedAt || member.id === selectedId,
      ),
    [workflows, runs, state.targets, selectedId],
  );
  const plan = useMemo(() => swarmPlan(workflows, members), [workflows, members]);
  const saved = useMemo(() => {
    const figure = swarmSavedTime(members, runs);
    return figure && savedTimeText(figure.savedMs);
  }, [members, runs]);
  const selected = members.find((member) => member.id === selectedId);
  // Executors and replies come from the family record, read even before anyone is picked so the list can show them.
  const recordSource = selected ?? members.find((member) => !member.parentId);
  const recordWorkflowId = recordSource?.workflow.id;
  const recordConversationId = recordSource?.workflow.conversationId;
  const selectionKey = selected?.id;
  const treeIdentity = workflows.map((task) => task.id).join(',');
  const activityIdentity = workflows.map((task) => `${task.id}:${task.status}:${task.runIds.join(',')}`).join('|');
  // The live state stream says when this conversation's tasks change; the swarm record is re-read then rather
  // than on a short timer, so new members and finished ones show up as they happen.
  const liveIdentity = (state.workflows ?? [])
    .filter((task) => task.conversationId === conversation.id)
    .map((task) => `${task.id}:${task.status}:${task.runIds.length}`)
    .join('|');
  const communications = useMemo(
    () => swarmCommunications(members, runs, memberMessages),
    [members, runs, memberMessages],
  );
  const lines = useMemo(() => swarmChatLines(members, communications), [members, communications]);
  const linesIdentity = lines.map((line) => `${line.id}:${line.from}:${line.to}:${line.text.length}`).join('|');
  const report = useRef(onLines);
  report.current = onLines;
  useEffect(() => {
    report.current?.(lines);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the identity string covers every visible change
  }, [linesIdentity, conversation.id]);

  useEffect(() => {
    sendingRef.current = undefined;
    memberActionRequest.current = undefined;
    setMemberActionPending(false);
    setChildParent(undefined);
    setWorkflows([]);
    setArchivedRuns([]);
    setMessages([]);
    setMemberMessages([]);
    setSelectedId(undefined);
    setDrafts(draftSession?.current ?? {});
    setDelivery(undefined);
    setSending(false);
  }, [api, conversation.id]);
  useEffect(() => {
    if (!visible) return;
    let alive = true,
      pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try {
        const result = await api<{ workflows: Workflow[]; messages?: SwarmMessage[] }>(
          `/api/conversations/${encodeURIComponent(conversation.id)}/swarm`,
          undefined,
          'GET',
        );
        if (alive) {
          setWorkflows(result.workflows);
          setMemberMessages(result.messages ?? []);
          setError(undefined);
        }
      } catch (cause) {
        if (alive) setError(errorText(cause));
      } finally {
        pending = false;
        if (alive) setLoading(false);
      }
    };
    setLoading(true);
    void refresh();
    const timer = setInterval(() => void refresh(), 15000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [api, conversation.id, visible]);
  useEffect(() => {
    if (!visible || (!revision && !liveIdentity)) return;
    let alive = true;
    void api<{ workflows: Workflow[]; messages?: SwarmMessage[] }>(
      `/api/conversations/${encodeURIComponent(conversation.id)}/swarm`,
      undefined,
      'GET',
    )
      .then((result) => {
        if (alive) {
          setWorkflows(result.workflows);
          setMemberMessages(result.messages ?? []);
          setError(undefined);
        }
      })
      .catch((cause) => {
        if (alive) setError(errorText(cause));
      });
    return () => {
      alive = false;
    };
  }, [api, conversation.id, revision, liveIdentity, visible]);
  useEffect(() => {
    if (!visible || !recordWorkflowId || !recordConversationId) return;
    let alive = true,
      pending = false;
    const root = swarmRoot(recordWorkflowId, workflows);
    if (!root) return;
    setLoading(true);
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try {
        const [history, record] = await Promise.all([
          api<{ messages: ConversationMessage[] }>(
            `/api/conversations/${encodeURIComponent(recordConversationId)}`,
            undefined,
            'GET',
          ),
          api<WorkflowExecutionRecord>(`/api/workflows/${encodeURIComponent(root)}/execution-record`, undefined, 'GET'),
        ]);
        if (!alive) return;
        const allowed = new Set(workflows.map((task) => task.id));
        // Keep exact replies from the family archive alongside the full conversation history.
        setMessages([
          ...new Map(
            [...history.messages, ...(record.messages ?? [])].map((message) => [message.id, message]),
          ).values(),
        ]);
        setArchivedRuns((current) => {
          const merged = new Map(current.map((run) => [run.id, run]));
          for (const run of [...record.runs, ...record.relatedRuns])
            if (run.workflowId && allowed.has(run.workflowId)) merged.set(run.id, run);
          return [...merged.values()];
        });
        setError(undefined);
      } catch (cause) {
        if (alive) setError(errorText(cause));
      } finally {
        pending = false;
        if (alive) setLoading(false);
      }
    };
    void refresh();
    const liveFamily = workflows.some(
      (task) => swarmRoot(task.id, workflows) === root && activeStatuses.includes(task.status),
    );
    const timer = liveFamily ? setInterval(() => void refresh(), 5000) : undefined;
    return () => {
      alive = false;
      if (timer !== undefined) clearInterval(timer);
    };
  }, [api, conversation.id, recordWorkflowId, recordConversationId, treeIdentity, activityIdentity, revision, visible]);

  const send = async () => {
    if (!selected || sendingRef.current) return;
    const member = selected,
      text = drafts[member.id] ?? '',
      owner = conversation.id;
    const request = Symbol('swarm-message');
    sendingRef.current = request;
    setSending(true);
    setDelivery(undefined);
    try {
      const result = await sendSwarmMessage(api, member.workflow.id, text);
      if (session.current !== owner || sendingRef.current !== request) return;
      const label = result.delivery === 'delivered' ? '已送达所选成员。' : '消息已排队，成员下次执行时会接收。';
      setDrafts((current) => (current[member.id] === text ? { ...current, [member.id]: '' } : current));
      setDelivery({ memberId: member.id, text: label });
      notify({ tone: 'success', message: label });
      setRevision((value) => value + 1);
      try {
        await reload();
      } catch (refreshError) {
        if (session.current === owner && sendingRef.current === request)
          notify({ tone: 'error', message: `${label}工作台状态刷新失败：${errorText(refreshError)}` });
      }
    } catch (cause) {
      if (session.current === owner && sendingRef.current === request) {
        const message = errorText(cause);
        setDelivery({ memberId: member.id, text: message });
        notify({ tone: 'error', message });
      }
    } finally {
      if (sendingRef.current === request) {
        sendingRef.current = undefined;
        if (session.current === owner) setSending(false);
      }
    }
  };
  const cancel = async () => {
    if (!selected || cancelling) return;
    setCancelling(true);
    try {
      await api(`/api/workflows/${encodeURIComponent(selected.workflow.id)}/cancel`, {});
      setRevision((value) => value + 1);
      await reload();
    } catch (cause) {
      notify({ tone: 'error', message: errorText(cause) });
    } finally {
      setCancelling(false);
    }
  };
  const memberAction = async (action: 'continue' | 'delivery') => {
    if (!selected || memberActionRequest.current) return;
    const request = Symbol(action),
      owner = conversation.id,
      workflowId = selected.workflow.id;
    memberActionRequest.current = request;
    setMemberActionPending(true);
    try {
      const result = await api<{ workflow: Workflow }>(
        `/api/workflows/${encodeURIComponent(workflowId)}/${action}`,
        {},
      );
      if (session.current !== owner || memberActionRequest.current !== request) return;
      if (!result.workflow?.id || result.workflow.conversationId !== owner)
        throw Error('服务器尚未确认任务状态，请刷新核对。');
      setRevision((value) => value + 1);
      await reload();
    } catch (cause) {
      if (session.current === owner && memberActionRequest.current === request)
        notify({ tone: 'error', message: errorText(cause) });
    } finally {
      if (memberActionRequest.current === request) {
        memberActionRequest.current = undefined;
        if (session.current === owner) setMemberActionPending(false);
      }
    }
  };
  if (!projectAllowed) return null;
  return (
    <SwarmWorkspaceView
      childDialog={
        childParent?.conversationId === conversation.id && (
          <CreateChildDialog
            parent={childParent}
            api={api}
            notify={notify}
            onClose={() => setChildParent(undefined)}
            onCreated={(workflow) => {
              setRevision((value) => value + 1);
              if (onSelectMember) onSelectMember(workflow.id);
              else setSelectedId(workflow.id);
              void reload().catch((cause) =>
                notify({ tone: 'error', message: `子任务已创建，但列表刷新失败：${errorText(cause)}` }),
              );
            }}
          />
        )
      }
      members={members}
      communications={communications}
      plan={plan}
      saved={saved}
      selectedId={selectionKey}
      messages={selected ? swarmMemberMessages(selected, messages) : []}
      memberMessages={
        selected
          ? memberMessages.filter(
              (message) => message.source === 'human' && selected.workflowIds.includes(message.toWorkflowId),
            )
          : []
      }
      loading={loading}
      error={error}
      sending={sending}
      draft={selectionKey ? (drafts[selectionKey] ?? '') : ''}
      delivery={delivery && delivery.memberId === selectionKey ? delivery.text : undefined}
      state={{ ...state, runs }}
      onSelect={(id) => {
        if (onSelectMember) onSelectMember(id);
        else setSelectedId(id);
        setDelivery(undefined);
      }}
      onRefresh={() => setRevision((value) => value + 1)}
      onDraft={(text) => {
        if (selectionKey) setDrafts((current) => ({ ...current, [selectionKey]: text }));
      }}
      onSend={() => void send()}
      onInspect={onInspect}
      onExample={onExample}
      detailsOnly={Boolean(onSelectMember)}
      onCancel={onSelectMember ? () => void cancel() : undefined}
      onCreateChild={selected ? () => setChildParent(selected.workflow) : undefined}
      onContinue={selected ? () => void memberAction('continue') : undefined}
      onDeliver={selected ? () => void memberAction('delivery') : undefined}
      memberActionPending={memberActionPending}
      cancelling={cancelling}
    />
  );
}
