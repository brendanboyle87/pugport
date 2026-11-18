import type { ConversationMessage, RunRecord, Workflow } from '../shared/types';
import { isActiveWorkflow, isExecutingWorkflow, workflowContinuation } from './queue-utils';
import { isMessageQueueItem } from './message-queue';
import { verificationLimitedChecks } from '../shared/verification-limited.ts';
import { replyAttempts, selectedReplyAttempt } from './reply-attempts';

export type DelegationTimelineRow = {
  kind: 'delegation-group';
  id: string;
  parent?: Workflow;
  children: Array<{ workflow: Workflow; messages: ConversationMessage[]; sequence?: number; historical?: boolean }>;
  stage?: SteeringStage;
  live?: true;
};

/** Live rows include tasks awaiting their saved reply, kept below every main message. */
export type ConversationTimelineRow =
  | { kind: 'message'; message: ConversationMessage }
  | { kind: 'workflow'; workflow: Workflow; live?: true; stage?: SteeringStage }
  | { kind: 'steering-stage'; stage: SteeringStage }
  | DelegationTimelineRow;

export type SteeringStage = { id: string; workflowId: string; number: number; at: string; messageId: string };

const keyOf = (conversationId: string, workflowId: string) => `${conversationId}:${workflowId}`;

/** Every attempt that was continued: once Continue creates the next task, the earlier one lives only in the trace. */
export function continuedPredecessors(workflows: Workflow[]): Set<string> {
  const live = new Map(
    workflows
      .filter((workflow) => !workflow.deletedAt)
      .map((workflow) => [keyOf(workflow.conversationId, workflow.id), workflow] as const),
  );
  // Hide an attempt when a later loaded attempt exists in its chain; the latest one stays. A cycle hides nothing.
  const continuedLater = (workflow: Workflow): boolean => {
    const seen = new Set<string>();
    for (let current = workflow; ;) {
      if (seen.has(current.id)) return false;
      seen.add(current.id);
      const next = workflowContinuation(current);
      const successor = next && live.get(keyOf(current.conversationId, next.workflowId));
      if (!successor) return current !== workflow;
      current = successor;
    }
  };
  return new Set(
    workflows.filter((workflow) => !workflow.deletedAt && continuedLater(workflow)).map((workflow) => workflow.id),
  );
}

/** Live upserts can arrive newest-first in the same millisecond; the saved reply pointer owns source placement. */
function attachSearchReceipts(messages: ConversationMessage[]) {
  const byId = new Map(messages.map((message) => [message.id, message]));
  const owners = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const message of messages) {
    if (message.role !== 'user' || !message.webSearch?.replyId) continue;
    const source = byId.get(message.webSearch.replyId);
    if (
      source?.role !== 'assistant' ||
      source.conversationId !== message.conversationId ||
      !source.webSearch ||
      source.webSearch.query !== message.webSearch.query
    )
      continue;
    if (owners.has(source.id)) {
      owners.delete(source.id);
      ambiguous.add(source.id);
    } else if (!ambiguous.has(source.id)) owners.set(source.id, message.id);
  }
  if (!owners.size) return messages;
  const sources = new Map([...owners].map(([id, owner]) => [owner, byId.get(id)!]));
  return messages.flatMap((message) =>
    owners.has(message.id) ? [] : [message, ...(sources.has(message.id) ? [sources.get(message.id)!] : [])],
  );
}

/** Keep the main conversation's saved order; collect delegated work beside its parent's task card. */
export function conversationTimeline(
  messages: ConversationMessage[],
  workflows: Workflow[],
  runs: readonly RunRecord[] = [],
  selectedAttempts: Readonly<Record<string, string>> = {},
): ConversationTimelineRow[] {
  const completedContinuations = continuedPredecessors(workflows);
  const attempts = replyAttempts(workflows);
  const hiddenAttempts = new Set(
    [...attempts].filter(([id, group]) => id !== selectedReplyAttempt(group, selectedAttempts).id).map(([id]) => id),
  );
  const supersededAttempts = new Set(
    workflows.filter((workflow) => workflow.supersededBy).map((workflow) => workflow.id),
  );
  const finalOwners = new Map(
    workflows.filter((item) => item.finalMessageId).map((item) => [item.finalMessageId!, item.id]),
  );
  messages = messages.filter((message) => {
    if (message.role === 'user') return true;
    const ownerId = message.workflowId ?? finalOwners.get(message.id) ?? '';
    return (
      !hiddenAttempts.has(ownerId) &&
      !((message.systemNotice || message.replyIdentity?.kind === 'system') && supersededAttempts.has(ownerId))
    );
  });
  messages = attachSearchReceipts(messages);
  const byId = new Map<string, number>();
  const firstUsers = new Map<string, number>();
  const lastReplies = new Map<string, number>();
  messages.forEach((message, index) => {
    byId.set(message.id, index);
    if (!message.workflowId) return;
    const key = keyOf(message.conversationId, message.workflowId);
    if (message.role === 'user' && !message.steering && !firstUsers.has(key)) firstUsers.set(key, index);
    if (message.role === 'assistant') lastReplies.set(key, index);
  });
  const all = new Map(workflows.map((workflow) => [keyOf(workflow.conversationId, workflow.id), workflow]));
  const groups = new Map<string, DelegationTimelineRow>();
  const childGroups = new Map<string, DelegationTimelineRow>();
  const childMessages = new Map<string, ConversationMessage[]>();
  const firstChildMessage = new Map<string, number>();
  const groupedMessages = new Set<number>();
  // Resolve only explicit parent IDs, including when a parent is outside the loaded history. Invalid cycles
  // remain readable as orphan groups instead of looping or swallowing another task's messages.
  for (const child of all.values()) {
    if (!child.delegation) continue;
    let parentId = child.delegation.parentId;
    let parent: Workflow | undefined;
    const visited = new Set([child.id]);
    while (true) {
      if (visited.has(parentId)) {
        parent = undefined;
        parentId = `orphan:${child.id}`;
        break;
      }
      visited.add(parentId);
      parent = all.get(keyOf(child.conversationId, parentId));
      if (!parent?.delegation) break;
      parentId = parent.delegation.parentId;
    }
    const id = keyOf(child.conversationId, parentId);
    const group = groups.get(id) ?? { kind: 'delegation-group' as const, id, parent, children: [] };
    const ownMessages: ConversationMessage[] = [];
    group.children.push({ workflow: child, messages: ownMessages });
    groups.set(id, group);
    const childKey = keyOf(child.conversationId, child.id);
    childGroups.set(childKey, group);
    childMessages.set(childKey, ownMessages);
  }
  // Old messages can lack workflowId. Only validated canonical pointers may attach those to a child.
  const legacyOwners = new Map<string, Workflow>();
  for (const child of all.values()) {
    if (!child.delegation) continue;
    for (const [id, role] of [
      [child.userMessageId, 'user'],
      [child.finalMessageId, 'assistant'],
    ] as const) {
      const index = id ? byId.get(id) : undefined;
      const message = index === undefined ? undefined : messages[index];
      if (message && !message.workflowId && message.role === role && message.conversationId === child.conversationId)
        legacyOwners.set(message.id, child);
    }
  }
  messages.forEach((message, index) => {
    // A person's correction stays in the main conversation even when addressed to a delegated task.
    if (message.steering) return;
    const owner = message.workflowId
      ? all.get(keyOf(message.conversationId, message.workflowId))
      : legacyOwners.get(message.id);
    if (!owner?.delegation) return;
    const key = keyOf(owner.conversationId, owner.id);
    const group = childGroups.get(key)!;
    childMessages.get(key)!.push(message);
    groupedMessages.add(index);
    if (!firstChildMessage.has(group.id)) firstChildMessage.set(group.id, index);
  });
  for (const group of groups.values()) {
    group.children = group.children.filter(({ workflow, messages }) => !workflow.deletedAt || messages.length > 0);
    if (!group.children.length) {
      groups.delete(group.id);
      continue;
    }
    group.children.sort(
      (left, right) =>
        left.workflow.createdAt.localeCompare(right.workflow.createdAt) ||
        (byId.get(left.workflow.userMessageId) ?? Number.MAX_SAFE_INTEGER) -
          (byId.get(right.workflow.userMessageId) ?? Number.MAX_SAFE_INTEGER) ||
        left.workflow.id.localeCompare(right.workflow.id),
    );
  }

  const before = new Map<number, ConversationTimelineRow[]>();
  const after = new Map<number, ConversationTimelineRow[]>();
  const tail: { workflow: Workflow; origin: number }[] = [];
  const placedGroups = new Set<string>();
  const add = (slots: Map<number, ConversationTimelineRow[]>, index: number, row: ConversationTimelineRow) => {
    const entries = slots.get(index) ?? [];
    entries.push(row);
    slots.set(index, entries);
  };
  const taskRows = (workflow: Workflow, hasFinalReply: boolean, live?: true): ConversationTimelineRow[] => {
    const group = groups.get(keyOf(workflow.conversationId, workflow.id));
    if (group) placedGroups.add(group.id);
    const finishedPlainChat =
      hasFinalReply &&
      workflow.runIds.length === 0 &&
      workflow.status === 'completed' &&
      workflow.input.mode === 'chat' &&
      !workflow.delegation &&
      !workflow.review &&
      !verificationLimitedChecks(workflow, runs).length &&
      !runs.some(
        (run) =>
          workflow.runIds.includes(run.id) &&
          (!run.workflowId || run.workflowId === workflow.id) &&
          run.taskOutcome?.claims?.length,
      );
    return [
      ...(group ? [{ ...group, ...(live ? { live } : {}) }] : []),
      ...(finishedPlainChat || completedContinuations.has(workflow.id)
        ? []
        : [{ kind: 'workflow' as const, workflow, ...(live ? { live } : {}) }]),
    ];
  };
  for (const workflow of all.values()) {
    if (workflow.deletedAt || workflow.delegation || hiddenAttempts.has(workflow.id)) continue;
    if (isMessageQueueItem(workflow) && !['pending', 'wait'].includes(workflow.machineLoadChoice ?? '')) continue;
    const key = keyOf(workflow.conversationId, workflow.id);
    let origin = byId.get(workflow.userMessageId);
    const user = origin === undefined ? undefined : messages[origin];
    if (
      !user ||
      user.role !== 'user' ||
      user.conversationId !== workflow.conversationId ||
      (user.workflowId &&
        user.workflowId !== workflow.id &&
        (!attempts.has(workflow.id) || attempts.get(user.workflowId) !== attempts.get(workflow.id)))
    )
      origin = firstUsers.get(key);
    let final = workflow.finalMessageId ? byId.get(workflow.finalMessageId) : undefined;
    const reply = final === undefined ? undefined : messages[final];
    const hasFinalReply =
      reply?.role === 'assistant' &&
      reply.conversationId === workflow.conversationId &&
      (!reply.workflowId || reply.workflowId === workflow.id);
    if (!hasFinalReply) final = lastReplies.get(key);
    if (origin === undefined) {
      // A history page may contain the answer without its earlier user message.
      if (workflow.status === 'completed' && workflow.runIds.length && final !== undefined)
        for (const row of taskRows(workflow, hasFinalReply)) add(before, final, row);
      continue;
    }
    if (messages[origin]!.steering && !(workflow.attempt && workflow.userMessageId === messages[origin]!.id)) continue;
    // Completion can arrive before the saved reply; keep the mounted stream (and its untrimmed cache) until then.
    const awaitingReply = workflow.status === 'completed' && workflow.input.mode === 'chat' && !hasFinalReply;
    if ((isActiveWorkflow(workflow) || awaitingReply) && !hasFinalReply) tail.push({ workflow, origin });
    else if (final !== undefined && final > origin)
      for (const row of taskRows(workflow, hasFinalReply)) add(before, final, row);
    else for (const row of taskRows(workflow, hasFinalReply)) add(after, origin, row);
  }
  tail.sort(
    (left, right) =>
      Number(isExecutingWorkflow(right.workflow)) - Number(isExecutingWorkflow(left.workflow)) ||
      left.origin - right.origin,
  );
  const liveRows = tail.flatMap(({ workflow }) => taskRows(workflow, false, true));
  for (const group of groups.values()) {
    if (placedGroups.has(group.id)) continue;
    const first = firstChildMessage.get(group.id);
    const active =
      (!!group.parent && isActiveWorkflow(group.parent)) ||
      group.children.some(({ workflow }) => isActiveWorkflow(workflow));
    // An earlier page may omit the parent's user message or even all parent metadata. Do not drop the
    // child replies on this page, and keep active orphan groups below main messages like other live work.
    if (
      active &&
      (first !== undefined ||
        messages.some((message) => message.conversationId === group.children[0]!.workflow.conversationId))
    )
      liveRows.push({ ...group, live: true });
    else if (first !== undefined) add(before, first, group);
  }
  const rows: ConversationTimelineRow[] = [];
  messages.forEach((message, index) => {
    rows.push(...(before.get(index) ?? []));
    // A coordinator's answer that a combined answer replaced is read in the swarm panel, not twice here.
    if (!groupedMessages.has(index) && !message.replacedBy) rows.push({ kind: 'message', message });
    rows.push(...(after.get(index) ?? []));
  });
  rows.push(...liveRows);
  return stageTimeline(rows, messages, workflows, runs);
}

/** A receipt divides subsequent activity, not the user's saved message order or a child's assignment number. */
function stageTimeline(
  rows: ConversationTimelineRow[],
  messages: ConversationMessage[],
  workflows: Workflow[],
  runs: readonly RunRecord[],
): ConversationTimelineRow[] {
  const sourceIndex = new Map(messages.map((message, index) => [message.id, index]));
  const owners = new Map(workflows.map((workflow) => [keyOf(workflow.conversationId, workflow.id), workflow]));
  const runsById = new Map<string, RunRecord>();
  for (const run of runs) if (!runsById.has(run.id)) runsById.set(run.id, run);
  const targetsByRun = new Map<string, Workflow>();
  for (const workflow of workflows)
    for (const id of workflow.runIds) {
      const key = keyOf(workflow.conversationId, id);
      const owner = runsById.get(id)?.workflowId;
      if (!targetsByRun.has(key) && (!owner || owner === workflow.id)) targetsByRun.set(key, workflow);
    }
  const times = new Map<string, number>();
  const timestamp = (value: string) => {
    if (!times.has(value)) times.set(value, Date.parse(value));
    return times.get(value)!;
  };
  const rootOf = (workflow: Workflow): Workflow | undefined => {
    const visited = new Set<string>();
    while (workflow.delegation) {
      if (visited.has(workflow.id)) return;
      visited.add(workflow.id);
      const parent = owners.get(keyOf(workflow.conversationId, workflow.delegation.parentId));
      if (!parent) return;
      workflow = parent;
    }
    return workflow;
  };
  const stages = new Map<string, SteeringStage[]>();
  for (const message of messages) {
    if (message.role !== 'user' || message.steering?.status !== 'accepted') continue;
    // A queued message still owns the cancelled queue workflow, so resolve the delivery target through its run.
    const target = targetsByRun.get(keyOf(message.conversationId, message.steering.runId));
    const parent = target && rootOf(target);
    const at = message.steering.acceptedAt ?? message.createdAt;
    if (!parent || !Number.isFinite(timestamp(at))) continue;
    const key = keyOf(parent.conversationId, parent.id);
    const list = stages.get(key) ?? [];
    list.push({ id: `steer:${message.id}`, workflowId: parent.id, number: 0, at, messageId: message.id });
    stages.set(key, list);
  }
  for (const list of stages.values()) {
    list.sort(
      (a, b) => timestamp(a.at) - timestamp(b.at) || sourceIndex.get(a.messageId)! - sourceIndex.get(b.messageId)!,
    );
    list.forEach((stage, index) => {
      stage.number = index + 2;
    });
  }
  const splitGroups = new Set(
    rows
      .filter((row): row is DelegationTimelineRow => row.kind === 'delegation-group')
      .filter((group) => {
        if (stages.has(group.id)) return true;
        // A child finishing after its parent's final reply belongs after that reply even without a new correction.
        const final = group.parent?.finalMessageId && sourceIndex.get(group.parent.finalMessageId);
        return (
          typeof final === 'number' &&
          group.children.some((child) => child.messages.some((message) => sourceIndex.get(message.id)! > final))
        );
      }),
  );
  const base = rows.filter((row) => row.kind !== 'delegation-group' || !splitGroups.has(row));
  const additions: Array<{ boundary: number; order: number; row: ConversationTimelineRow }> = [];
  // Prefixes preserve saved message order even when imported timestamps are out of order.
  const boundaries = new Array<number>(messages.length).fill(0);
  const parentTraces = new Map<Workflow, number>();
  base.forEach((row, index) => {
    if (row.kind === 'message') boundaries[sourceIndex.get(row.message.id)!] = index + 1;
    if (row.kind === 'workflow' && !parentTraces.has(row.workflow)) parentTraces.set(row.workflow, index);
  });
  for (let index = 1; index < boundaries.length; index++)
    boundaries[index] = Math.max(boundaries[index]!, boundaries[index - 1]!);
  const boundaryAfter = (index: number) => boundaries[index] ?? 0;
  const preceding = new Map<string, Array<{ at: number; index: number }>>();
  messages.forEach((message, index) => {
    if (owners.get(keyOf(message.conversationId, message.workflowId ?? ''))?.delegation) return;
    const at = timestamp(message.createdAt);
    if (!Number.isFinite(at)) return;
    const list = preceding.get(message.conversationId) ?? [];
    list.push({ at, index });
    preceding.set(message.conversationId, list);
  });
  for (const list of preceding.values()) {
    list.sort((a, b) => a.at - b.at);
    for (let index = 1; index < list.length; index++)
      list[index]!.index = Math.max(list[index]!.index, list[index - 1]!.index);
  }
  const receiptIndex = (stage: SteeringStage) => {
    const original = sourceIndex.get(stage.messageId)!;
    const list = preceding.get(messages[original]!.conversationId) ?? [];
    const at = timestamp(stage.at);
    let low = 0,
      high = list.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (list[middle]!.at < at) low = middle + 1;
      else high = middle;
    }
    return Math.max(original, list[low - 1]?.index ?? -1);
  };
  for (const list of stages.values()) {
    for (const stage of list)
      additions.push({
        boundary: boundaryAfter(receiptIndex(stage)),
        order: stage.number * 2 - 2,
        row: { kind: 'steering-stage', stage },
      });
  }
  for (const group of splitGroups) {
    const list = stages.get(group.id) ?? [];
    const phaseAt = (at: number, index = Infinity) => {
      if (!Number.isFinite(at)) return 0;
      let low = 0,
        high = list.length;
      while (low < high) {
        const middle = (low + high) >>> 1,
          stage = list[middle]!;
        const receipt = timestamp(stage.at);
        if (at > receipt || (at === receipt && index > sourceIndex.get(stage.messageId)!)) low = middle + 1;
        else high = middle;
      }
      return low;
    };
    const groups = new Map<number, DelegationTimelineRow>();
    group.children.forEach((child, index) => {
      const phases = new Map<number, ConversationMessage[]>();
      for (const message of child.messages) {
        const phase = phaseAt(timestamp(message.createdAt), sourceIndex.get(message.id)!);
        const ownMessages = phases.get(phase) ?? [];
        ownMessages.push(message);
        phases.set(phase, ownMessages);
      }
      const lastRun = child.workflow.runIds
        .map((id) => runsById.get(id))
        .filter(Boolean)
        .at(-1);
      const completedPhase = phaseAt(timestamp(lastRun?.endedAt ?? child.workflow.updatedAt));
      const current = isActiveWorkflow(child.workflow) ? list.length : Math.max(completedPhase, 0, ...phases.keys());
      if (!phases.has(current)) phases.set(current, []);
      for (const [phase, ownMessages] of phases) {
        const entry = groups.get(phase) ?? {
          ...group,
          id: `${group.id}:stage:${phase}`,
          children: [],
          stage: list[phase - 1],
          live: undefined,
        };
        entry.children.push({ ...child, messages: ownMessages, sequence: index + 1, historical: phase !== current });
        if (phase === current && isActiveWorkflow(child.workflow)) entry.live = true;
        groups.set(phase, entry);
      }
    });
    for (const [phase, entry] of groups) {
      const indices = entry.children.flatMap((child) => child.messages.map((message) => sourceIndex.get(message.id)!));
      const receipt = phase ? receiptIndex(list[phase - 1]!) : -1;
      let boundary = boundaryAfter(Math.max(receipt, ...indices));
      if (entry.live) {
        const parentTrace = group.parent && parentTraces.get(group.parent);
        boundary = Math.max(boundary, parentTrace ?? base.length);
      }
      additions.push({ boundary, order: phase * 2 + 1, row: entry });
    }
  }
  const additionsByBoundary = new Map<number, typeof additions>();
  for (const item of additions) {
    const list = additionsByBoundary.get(item.boundary) ?? [];
    list.push(item);
    additionsByBoundary.set(item.boundary, list);
  }
  for (const list of additionsByBoundary.values()) list.sort((a, b) => a.order - b.order);
  const result: ConversationTimelineRow[] = [];
  base.forEach((row, index) => {
    result.push(...(additionsByBoundary.get(index) ?? []).map((item) => item.row));
    if (row.kind === 'workflow')
      row = { ...row, stage: stages.get(keyOf(row.workflow.conversationId, row.workflow.id))?.at(-1) };
    if (row.kind === 'delegation-group')
      row = { ...row, children: row.children.map((child, i) => ({ ...child, sequence: i + 1 })) };
    result.push(row);
  });
  result.push(...(additionsByBoundary.get(base.length) ?? []).map((item) => item.row));
  return result;
}
