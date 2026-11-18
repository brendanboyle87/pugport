import type { Workflow } from './types.ts';

/** `active` is the most members of one task computing at once; each account's own share is decided by quota. */
export const swarmLimits = { children: 60, depth: 4, active: 16, messagesPerDirection: 40, messages: 10000 } as const;
/** Ordinary chats get a smaller family budget; opening the member tree does not enable swarm mode. */
export const managedAgentLimits = { ...swarmLimits, children: 12, active: 3 } as const;

export function delegationLimits(workflowId: string, workflows: readonly Workflow[]) {
  return swarmFamily(workflowId, workflows).some((workflow) => workflow.input.swarm) ? swarmLimits : managedAgentLimits;
}

/** The coordinator's task list: what it plans to hand out, written before it delegates. */
export type TaskListItem = {
  id: string;
  title: string;
  /** Reads only (research, reading, review) or changes files. */
  kind: 'read' | 'write';
  /** Who the coordinator means to give it to, in its own words. */
  assignee?: string;
  /** The coordinator finished this item itself; items handed out take their state from the member instead. */
  done?: boolean;
};
export type TaskList = { items: TaskListItem[]; updatedAt: string };
export type TaskListState = 'queued' | 'running' | 'done' | 'failed';
export const taskListStateLabels: Record<TaskListState, string> = {
  queued: '排队',
  running: '进行中',
  done: '完成',
  failed: '失败',
};
export const taskListLimits = { items: 30, title: 200, assignee: 60 } as const;

/** Checks a list sent by an executor; anything malformed is refused with a plain reason rather than repaired. */
export function normalizeTaskList(value: unknown): TaskListItem[] {
  if (!Array.isArray(value) || !value.length) throw new Error('请用 items 给出至少一项任务。');
  if (value.length > taskListLimits.items) throw new Error(`任务清单最多 ${taskListLimits.items} 项。`);
  const seen = new Set<string>();
  return value.map((raw, index) => {
    const item = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    const title = typeof item.title === 'string' ? item.title.replace(/\s+/g, ' ').trim() : '';
    if (!/^[\w.-]{1,40}$/.test(id))
      throw new Error(`第 ${index + 1} 项的 id 只能用字母、数字、点、横线和下划线，最多 40 个字符。`);
    if (seen.has(id)) throw new Error(`任务清单里有两项都叫 ${id}。`);
    seen.add(id);
    if (!title || title.length > taskListLimits.title)
      throw new Error(`第 ${index + 1} 项需要标题，最多 ${taskListLimits.title} 字。`);
    if (item.kind !== 'read' && item.kind !== 'write')
      throw new Error(`第 ${index + 1} 项的 kind 要写 read 或 write。`);
    const assignee = typeof item.assignee === 'string' ? item.assignee.trim().slice(0, taskListLimits.assignee) : '';
    return {
      id,
      title,
      kind: item.kind,
      ...(assignee ? { assignee } : {}),
      ...(item.done === true ? { done: true } : {}),
    };
  });
}

const workflowState = (workflow: Workflow): TaskListState =>
  workflow.status === 'completed'
    ? 'done'
    : ['planning', 'running', 'waiting-approval'].includes(workflow.status)
      ? 'running'
      : ['queued', 'waiting-resource', 'waiting-confirmation'].includes(workflow.status)
        ? 'queued'
        : 'failed';

/**
 * Each item's state comes from the latest member working on it (linked by the plan_id it was delegated with), never
 * from the coordinator's say-so; only an item nobody was given can be marked done by the coordinator itself. A work
 * lane links its newest root task through `planItem`.
 */
export function taskListProgress<M extends { workflow: Workflow; planItem?: string }>(
  items: readonly TaskListItem[],
  members: readonly M[],
): Array<TaskListItem & { state: TaskListState; member?: M }> {
  return items.map((item) => {
    const member = members
      .filter((value) => (value.planItem ?? value.workflow.delegation?.planItem) === item.id)
      .sort((a, b) => a.workflow.createdAt.localeCompare(b.workflow.createdAt))
      .at(-1);
    const state = member ? workflowState(member.workflow) : item.done ? 'done' : 'queued';
    return { ...item, state, ...(member ? { member } : {}) };
  });
}

/**
 * What running members side by side saved: their run time added up against the wall-clock span of that work. Only
 * members that did not hand work on count, so a member's wait for its own helpers is not counted twice.
 */
export function swarmTimeSaved(
  runs: ReadonlyArray<{ startedAt: string; endedAt?: string }>,
): { savedMs: number; totalMs: number; spanMs: number } | undefined {
  const spans = runs.map((run) => [Date.parse(run.startedAt), Date.parse(run.endedAt ?? '')] as const);
  if (spans.length < 2 || spans.some(([start, end]) => !Number.isFinite(start) || !Number.isFinite(end) || end < start))
    return undefined;
  const totalMs = spans.reduce((sum, [start, end]) => sum + end - start, 0);
  const spanMs = Math.max(...spans.map(([, end]) => end)) - Math.min(...spans.map(([start]) => start));
  return { savedMs: Math.max(0, totalMs - spanMs), totalMs, spanMs };
}

export type SwarmMessage = {
  id: string;
  rootWorkflowId: string;
  fromWorkflowId?: string;
  fromRunId?: string;
  source: 'human' | 'agent';
  toWorkflowId: string;
  text: string;
  createdAt: string;
  status: 'queued' | 'delivered';
  deliveredAt?: string;
  toRunId?: string;
  resumedWorkflowId?: string;
};

export type SwarmAgent = {
  id: string;
  workflowIds: string[];
  workflow: Workflow;
  parentId?: string;
  depth: number;
};

/** Computing members, including the root; waiting/parked callers free a slot for nested work. */
export function swarmActiveCount(
  workflowId: string,
  workflows: readonly Workflow[],
  executions: readonly { workflowId?: string; executing?: boolean; parked?: boolean; pendingStart?: boolean }[],
  includeRoot = true,
) {
  const family = new Set(
    swarmFamily(workflowId, workflows)
      .filter((workflow) => includeRoot || workflow.delegation)
      .map((workflow) => workflow.id),
  );
  return new Set(
    executions
      .filter(
        (entry) =>
          entry.workflowId &&
          family.has(entry.workflowId) &&
          (entry.pendingStart || (entry.executing && !entry.parked)),
      )
      .map((entry) => entry.workflowId),
  ).size;
}

const samePlace = (a: Workflow, b: Workflow) => a.projectId === b.projectId && a.conversationId === b.conversationId;

/** A continuation is another run of the same agent, rather than another child. Invalid chains fail closed. */
export function swarmAgentId(workflowId: string, workflows: readonly Workflow[]): string | undefined {
  return agentId(workflowId, new Map(workflows.map((workflow) => [workflow.id, workflow])));
}

function agentId(workflowId: string, index: ReadonlyMap<string, Workflow>): string | undefined {
  let current = index.get(workflowId);
  if (!current) return undefined;
  const visited = new Set<string>();
  while (current.parentWorkflowId) {
    if (visited.has(current.id)) return undefined;
    visited.add(current.id);
    const parent = index.get(current.parentWorkflowId);
    if (!parent || !samePlace(current, parent)) return undefined;
    current = parent;
  }
  return current.id;
}

function lineage(workflowId: string, index: ReadonlyMap<string, Workflow>): string[] | undefined {
  const start = index.get(workflowId);
  if (!start) return undefined;
  let currentId = agentId(workflowId, index);
  const result: string[] = [];
  while (currentId) {
    if (result.includes(currentId)) return undefined;
    const agent = index.get(currentId);
    if (!agent || !samePlace(start, agent)) return undefined;
    result.push(currentId);
    if (!agent.delegation) return result;
    currentId = agentId(agent.delegation.parentId, index);
  }
  return undefined;
}

export function swarmRoot(workflowId: string, workflows: readonly Workflow[]): string | undefined {
  return lineage(workflowId, new Map(workflows.map((workflow) => [workflow.id, workflow])))?.at(-1);
}

export function swarmDepth(workflowId: string, workflows: readonly Workflow[]): number | undefined {
  const ancestors = lineage(workflowId, new Map(workflows.map((workflow) => [workflow.id, workflow])));
  return ancestors ? ancestors.length - 1 : undefined;
}

export function swarmFamily(workflowId: string, workflows: readonly Workflow[]): Workflow[] {
  const index = new Map(workflows.map((workflow) => [workflow.id, workflow]));
  const root = lineage(workflowId, index)?.at(-1);
  return root ? workflows.filter((workflow) => lineage(workflow.id, index)?.at(-1) === root) : [];
}

/** Latest continuation per agent, with every historical workflow id retained for diagnostics. */
export function swarmAgents(workflowId: string, workflows: readonly Workflow[]): SwarmAgent[] {
  const family = swarmFamily(workflowId, workflows);
  const index = new Map(family.map((workflow) => [workflow.id, workflow]));
  const groups = new Map<string, Workflow[]>();
  for (const workflow of family) {
    const id = agentId(workflow.id, index)!;
    groups.set(id, [...(groups.get(id) ?? []), workflow]);
  }
  return [...groups].map(([id, records]) => {
    const continued = new Set(records.map((workflow) => workflow.parentWorkflowId).filter(Boolean));
    const workflow = records
      .filter((record) => !continued.has(record.id))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0]!;
    return {
      id,
      workflowIds: records.map((record) => record.id),
      workflow,
      ...(workflow.delegation ? { parentId: agentId(workflow.delegation.parentId, index) } : {}),
      depth: lineage(id, index)!.length - 1,
    };
  });
}
