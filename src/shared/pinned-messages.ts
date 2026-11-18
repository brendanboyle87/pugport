import type { BackgroundTask, ConversationMessage, ConversationMessagePin, Workflow } from './types.ts';

export type PinnedMessageStatus = {
  source: 'auto' | 'manual' | 'unknown';
  status: 'todo' | 'waiting' | 'done' | 'running' | 'paused' | 'blocked' | 'failed' | 'cancelled' | 'unknown';
  label: string;
  tone: 'neutral' | 'active' | 'warning' | 'success' | 'error';
  workflowId?: string;
  backgroundTask?: BackgroundTask;
  detail?: string;
};

/** Only canonical IDs link a message to work. Matching message text never grants task ownership. */
export function pinnedMessageWorkflow(
  message: ConversationMessage,
  workflows: readonly Workflow[],
): Workflow | undefined {
  const local = workflows.filter((workflow) => workflow.conversationId === message.conversationId);
  return (
    (message.workflowId ? local.find((workflow) => workflow.id === message.workflowId) : undefined) ??
    local.find((workflow) => workflow.userMessageId === message.id || workflow.finalMessageId === message.id)
  );
}

/** Pure local state projection. This never polls providers or submits an agent task. */
export function pinnedMessageStatus(
  pin: ConversationMessagePin,
  message: ConversationMessage | undefined,
  workflows: readonly Workflow[],
  backgroundTasks: readonly BackgroundTask[] = [],
): PinnedMessageStatus {
  if (!message || message.id !== pin.messageId)
    return { source: 'unknown', status: 'unknown', label: '原消息不可用', tone: 'neutral' };
  let workflow = pinnedMessageWorkflow(message, workflows);
  const tracking = pin.tracking ?? (workflow || message.workflowId ? 'task' : 'follow-up');
  if (tracking === 'follow-up') {
    const status = pin.followUpStatus ?? 'todo';
    return {
      source: 'manual',
      status,
      label: { todo: '待跟进', waiting: '等待确认', done: '已完成' }[status],
      tone: status === 'done' ? 'success' : status === 'waiting' ? 'warning' : 'neutral',
      ...(workflow ? { workflowId: workflow.id } : {}),
    };
  }
  if (!workflow) return { source: 'unknown', status: 'unknown', label: '任务状态待确认', tone: 'neutral' };
  const visited = new Set<string>();
  // Explicit continuations retain the original task's intent. A different new message does not.
  while (workflow.followUp?.kind === 'continue') {
    if (visited.has(workflow.id) || visited.size >= 20)
      return {
        source: 'unknown',
        status: 'unknown',
        label: '续接状态待确认',
        tone: 'neutral',
        workflowId: workflow.id,
      };
    visited.add(workflow.id);
    const next = workflows.find(
      (value) => value.id === workflow!.followUp!.workflowId && value.conversationId === message.conversationId,
    );
    if (!next)
      return {
        source: 'unknown',
        status: 'unknown',
        label: '续接状态待确认',
        tone: 'neutral',
        workflowId: workflow.id,
      };
    workflow = next;
  }
  const identity = { source: 'auto' as const, workflowId: workflow.id };
  if (workflow.deletedAt) return { ...identity, status: 'unknown', label: '任务已移除', tone: 'neutral' };
  if (workflow.waitingOn && !['completed', 'cancelled', 'failed'].includes(workflow.status)) {
    const backgroundTask = backgroundTasks.find(
      (task) => task.id === workflow!.waitingOn!.jobId && task.conversationId === message.conversationId,
    );
    if (!backgroundTask)
      return { ...identity, source: 'unknown', status: 'unknown', label: '本地任务状态待确认', tone: 'neutral' };
    return {
      ...identity,
      status: backgroundTask.state === 'paused' ? 'paused' : 'running',
      label: backgroundTask.state === 'paused' ? '本地任务已暂停' : '本地处理中',
      tone: backgroundTask.state === 'paused' ? 'warning' : 'active',
      backgroundTask,
      detail: backgroundTask.steps?.find((step) => step.state === 'running')?.label ?? backgroundTask.title,
    };
  }
  switch (workflow.status) {
    case 'queued':
      return { ...identity, status: 'todo', label: '等待执行', tone: 'neutral' };
    case 'waiting-resource':
      return {
        ...identity,
        status: 'waiting',
        label: '等待资源',
        tone: 'warning',
        detail: workflow.scheduling?.reason,
      };
    case 'waiting-confirmation':
    case 'waiting-approval':
      return { ...identity, status: 'waiting', label: '等待确认', tone: 'warning' };
    case 'planning':
    case 'running':
      return { ...identity, status: 'running', label: '处理中', tone: 'active' };
    case 'completed':
      return { ...identity, status: 'done', label: '已完成', tone: 'success' };
    case 'cancelled':
      return { ...identity, status: 'cancelled', label: '已取消', tone: 'neutral' };
    case 'interrupted':
      return { ...identity, status: 'paused', label: '已暂停', tone: 'warning' };
    case 'failed':
      return { ...identity, status: 'failed', label: '失败', tone: 'error', detail: workflow.error };
    case 'blocked':
      return {
        ...identity,
        status: workflow.stopped ? 'paused' : 'blocked',
        label: workflow.stopped ? '已暂停' : '需要处理',
        tone: 'warning',
        detail: workflow.error,
      };
  }
}

const cjkText = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/u;
export const PIN_SUMMARY_TITLE_MAX = { cjk: 16, latin: 48 } as const;
export const PIN_SUMMARY_DESCRIPTION_MAX = { cjk: 40, latin: 90 } as const;

const clip = (text: string, max: number) => {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  // Latin text breaks at a word boundary when one is near the limit.
  const cut = chars.slice(0, max - 1).join('');
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
};

/** Plain words from one Markdown line: no markers, links keep their text, code keeps its content. */
const plainLine = (line: string) =>
  line
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|~~|`)/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Local stand-in for a model summary: the first Markdown heading, otherwise the first sentence, trimmed to a card
 * title; the description is the text that follows. Never calls a model, so incognito chats use only this.
 */
export function pinSummaryExtract(content: string): { title: string; description: string } {
  const lines = content
    .replace(/```[\s\S]*?(```|$)/g, '\n')
    .split(/\r?\n/)
    .map((line) => ({ heading: /^\s{0,3}#{1,6}\s+\S/.test(line), text: plainLine(line) }))
    .filter((line) => line.text && !/^[-*_=|:\s]+$/.test(line.text));
  const text = lines.map((line) => line.text).join(' ');
  const cjk = cjkText.test(text);
  const heading = lines.find((line) => line.heading)?.text;
  const sentence = /^(.+?(?:[。！？]|[.!?](?=\s|$)))/u.exec(text)?.[1] ?? lines[0]?.text ?? '';
  const lead = heading ?? sentence;
  const rest = (heading ? text.replace(heading, '') : text.slice(sentence.length)).trim();
  const titleMax = cjk ? PIN_SUMMARY_TITLE_MAX.cjk : PIN_SUMMARY_TITLE_MAX.latin;
  const descriptionMax = cjk ? PIN_SUMMARY_DESCRIPTION_MAX.cjk : PIN_SUMMARY_DESCRIPTION_MAX.latin;
  const title = clip(lead.replace(/[。.:：]$/u, ''), titleMax);
  // A first sentence too long for the title continues in the description instead of disappearing.
  const description = clip(Array.from(lead).length > titleMax && !heading ? text : rest, descriptionMax);
  return { title, description };
}

export type PinnedMessageCard = { title: string; description: string; pending: boolean };

/** Card text for a pin: the saved summary, or the extract with a pending note until the background summary lands. */
export function pinnedMessageCard(
  pin: ConversationMessagePin,
  message: ConversationMessage | undefined,
  incognito = false,
): PinnedMessageCard {
  if (pin.summary?.title) return { title: pin.summary.title, description: pin.summary.description, pending: false };
  const extract = pinSummaryExtract(message?.content ?? '');
  if (incognito || !message) return { ...extract, pending: false };
  return { title: extract.title, description: '正在总结…', pending: true };
}

/** Full cards fit in the gutter up to this many pins; more become compact one-line rows. */
export const PIN_RAIL_FULL_LIMIT = 5;
/** The rail needs this much free space left of the message column. */
export const PIN_RAIL_MIN_GUTTER = 220;
export const PIN_RAIL_CARD_WIDTH = 200;

/** Where pins show: the left-gutter rail on wide layouts, otherwise the bar above the history. */
export function pinRailLayout(gutter: number, count: number) {
  const rail = count > 0 && gutter >= PIN_RAIL_MIN_GUTTER;
  return {
    rail,
    compact: rail && count > PIN_RAIL_FULL_LIMIT,
    width: Math.min(PIN_RAIL_CARD_WIDTH, Math.max(0, Math.floor(gutter - 32))),
  };
}

/** Newest pin first; the saved order is never changed. */
export function pinsNewestFirst(pins: readonly ConversationMessagePin[]): ConversationMessagePin[] {
  return [...pins].sort((a, b) => b.pinnedAt.localeCompare(a.pinnedAt));
}

export function pinAgeLabel(at: string | undefined, now = Date.now()): string {
  const minutes = Math.floor((now - Date.parse(at ?? '')) / 60_000);
  if (!Number.isFinite(minutes)) return '';
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} 小时前`;
  return `${Math.floor(minutes / (24 * 60))} 天前`;
}
