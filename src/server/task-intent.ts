import type { ConversationMessage, RunRecord, Workflow } from '../shared/types.ts';
import { quotedContent, quotedIntent } from '../shared/quotes.ts';
import { inspectActionIntent } from './one-for-all-policy.ts';

type IntentSources = {
  workflow(id: string): Workflow | undefined;
  run(id: string): RunRecord | undefined;
  messages: readonly ConversationMessage[];
};
const quotePreamble = quotedContent('', [{ text: 'x' }]).split('\n\n')[0]!;
const steerPrefix = '\n\n用户中途补充：\n';
const writableChoice = (workflow: Workflow) =>
  workflow.originalIntent?.permissionMode === 'workspace-write' &&
  ['auto', 'build'].includes(workflow.originalIntent.mode);
const forbidden = (text: string) =>
  inspectActionIntent(text).prohibitsWrite ||
  /^(?:请|先|暂时)?(?:停止|停下|暂停)(?:任务|操作|执行|工作)?[。！!\s]*$|^(?:please\s+)?stop(?:\s+(?:the\s+)?(?:task|execution|work))?[.!\s]*$/iu.test(
    text.trim(),
  );
const rendered = (message: ConversationMessage) => quotedContent(message.content, message.quotes ?? []);
const defaultContinue = (parent: Workflow) =>
  `继续原任务：${parent.input.content}\n已有步骤状态：\n${parent.plan.map((step) => `${step.title}: ${step.status}`).join('\n')}\n先检查已有产物，接着完成未完成的工作，避免重复外部操作。`;

/** Repair only a proven legacy quote downgrade for a new user-requested Continue; audit records stay untouched. */
export function recoverLegacyQuoteIntent(old: Workflow, sources: IntentSources): string | undefined {
  if (
    old.originalIntent?.mode !== 'build' ||
    !writableChoice(old) ||
    old.input.permissionMode !== 'read-only' ||
    !old.input.intentText?.includes(quotePreamble)
  )
    return;
  const chain: Workflow[] = [],
    seen = new Set<string>();
  for (let item: Workflow | undefined = old; item;) {
    if (
      chain.length >= 32 ||
      seen.has(item.id) ||
      item.conversationId !== old.conversationId ||
      item.projectId !== old.projectId ||
      item.stopped ||
      item.deletedAt ||
      item.delegation ||
      item.pendingSteer ||
      item.status === 'cancelled' ||
      !writableChoice(item)
    )
      return;
    chain.unshift(item);
    seen.add(item.id);
    if (!item.parentWorkflowId) break;
    item = sources.workflow(item.parentWorkflowId);
    if (!item) return;
  }
  const runs = old.runIds.map((id) => sources.run(id));
  const last = runs.at(-1);
  if (
    runs.some((run) => !run || run.workflowId !== old.id) ||
    !last ||
    !last.endedAt ||
    !Number.isFinite(Date.parse(last.endedAt)) ||
    last.permissionMode !== 'read-only' ||
    !['completed', 'failed', 'interrupted'].includes(last.status)
  )
    return;
  const messages = sources.messages.filter((message) => message.conversationId === old.conversationId);
  const byId = new Map(messages.map((message) => [message.id, message]));
  if (byId.size !== messages.length) return;
  const root = byId.get(chain[0]!.userMessageId);
  if (!root || !Number.isFinite(Date.parse(root.createdAt))) return;
  const additions = new Map<string, ConversationMessage[]>();
  for (const message of messages.filter((value) => value.role === 'user')) {
    if (!Number.isFinite(Date.parse(message.createdAt))) return;
    const run = message.steering ? sources.run(message.steering.runId) : undefined;
    // An older queued message may be reordered and delivered after this task starts.
    if (Date.parse(message.createdAt) < Date.parse(root.createdAt) && !seen.has(run?.workflowId ?? '')) continue;
    const generated = chain.some((item, index) => index > 0 && item.userMessageId === message.id);
    if (!generated && forbidden(quotedIntent(message.content, message.quotes))) return;
    if (message.steering) {
      const target = run?.workflowId ? sources.workflow(run.workflowId) : undefined;
      if (
        !run ||
        !target ||
        target.conversationId !== old.conversationId ||
        target.projectId !== old.projectId ||
        !target.runIds.includes(run.id) ||
        message.steering.status !== 'accepted'
      )
        return;
      if (!seen.has(target.id)) continue;
      if (message.workflowId !== target.id) {
        const queued = message.workflowId ? sources.workflow(message.workflowId) : undefined;
        if (
          !queued ||
          !writableChoice(queued) ||
          queued.userMessageId !== message.id ||
          queued.stopped ||
          queued.deletedAt ||
          queued.delegation ||
          queued.parentWorkflowId ||
          queued.pendingSteer ||
          queued.conversationId !== old.conversationId ||
          queued.projectId !== old.projectId ||
          queued.followUp?.kind !== 'message' ||
          queued.followUp.workflowId !== target.id ||
          queued.input.content !== rendered(message)
        )
          return;
      }
      additions.set(target.id, [...(additions.get(target.id) ?? []), message]);
    } else if (message.workflowId && !seen.has(message.workflowId)) {
      const other = sources.workflow(message.workflowId);
      if (
        !other ||
        other.conversationId !== old.conversationId ||
        other.projectId !== old.projectId ||
        other.stopped ||
        !writableChoice(other)
      )
        return;
    }
  }
  const intents: string[] = [];
  let witnessedQuote = false;
  for (const [index, item] of chain.entries()) {
    const message = byId.get(item.userMessageId);
    if (
      !message ||
      message.role !== 'user' ||
      message.workflowId !== item.id ||
      message.steering ||
      message.importedFrom
    )
      return;
    const base = index ? defaultContinue(chain[index - 1]!) : rendered(message);
    if (index && (message.quotes?.length || message.content !== base)) return;
    if (!item.input.content.startsWith(base)) return;
    if (!index) {
      intents.push(quotedIntent(message.content, message.quotes));
      witnessedQuote ||= !!message.quotes?.length;
    }
    let remaining = item.input.content.slice(base.length);
    const pending = [...(additions.get(item.id) ?? [])];
    while (remaining) {
      const matches = pending.filter((entry) => {
        const part = steerPrefix + rendered(entry);
        return remaining === part || remaining.startsWith(part + steerPrefix);
      });
      if (matches.length !== 1) return;
      const entry = matches[0]!;
      remaining = remaining.slice((steerPrefix + rendered(entry)).length);
      pending.splice(pending.indexOf(entry), 1);
      intents.push(quotedIntent(entry.content, entry.quotes));
      witnessedQuote ||= !!entry.quotes?.length;
    }
    if (pending.length) return;
  }
  const intent = intents.filter(Boolean).join('\n\n');
  return witnessedQuote && intent.trim() && !forbidden(intent) ? intent : undefined;
}
