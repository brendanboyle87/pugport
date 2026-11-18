import { z } from 'zod';
import type { BridgeCatalogTool } from '../shared/bridge-catalog.ts';
import type { Conversation, ConversationMessage, Project, RunRecord, Workflow } from '../shared/types.ts';
import type { Controller } from './controller.ts';
import type { Workspace } from './workspace.ts';
import { serverRole } from './node/role.ts';

type Caller = { run: RunRecord; child: boolean; write: boolean; signal: AbortSignal };
const activeStates = ['queued', 'waiting-resource', 'waiting-confirmation', 'planning', 'running', 'waiting-approval'];
const localOrigins = new Set(['user', 'text', 'role']);
const listSchema = z
  .object({
    query: z.string().max(200).optional(),
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(100).default(20),
  })
  .strict();
const manageSchema = z
  .object({ action: z.enum(['archive', 'delete']), conversation_ids: z.array(z.string().uuid()).min(1).max(20) })
  .strict();

export const conversationManagementTools: BridgeCatalogTool[] = [
  {
    name: 'list_conversations',
    description:
      'List PugPort sidebar conversations/tasks across projects: IDs, titles, UTC creation/activity times, project names, archive state and active task counts only; never message content. Returns the local time zone. Use exact timestamps to resolve a user date range; do not assume that “two days” means 48 hours. 分页读取侧边栏对话任务元数据。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', maxLength: 200 },
        offset: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'manage_conversations',
    description:
      'Archive or soft-delete an exact batch of PugPort conversation IDs after the user approves the full list in PugPort. Never cancels tasks; current, active, deleted and incognito conversations are refused. Delete is recoverable through PugPort’s existing deleted-conversations window. 按明确ID清单归档或软删除侧边栏对话，必须等待用户确认。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['archive', 'delete'] },
        conversation_ids: {
          type: 'array',
          items: { type: 'string', format: 'uuid' },
          minItems: 1,
          maxItems: 20,
          uniqueItems: true,
        },
      },
      required: ['action', 'conversation_ids'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
];

/** Local human ownership is checked again after approval, never inferred from the model's prompt. */
function owner(workspace: Workspace, caller: Caller): string | undefined {
  if (
    serverRole() !== 'desktop' ||
    caller.child ||
    caller.signal.aborted ||
    !caller.run.workflowId ||
    caller.run.toolless ||
    caller.run.textOnly
  )
    return;
  const workflow = workspace.store.get<Workflow>('workflow', caller.run.workflowId);
  if (
    !workflow ||
    workflow.delegation ||
    workflow.deletedAt ||
    workflow.stopped ||
    !['running', 'waiting-approval'].includes(workflow.status) ||
    !workflow.runIds?.includes(caller.run.id) ||
    workflow.input?.untrustedContent ||
    workflow.input?.deviceId ||
    workflow.remoteProgress
  )
    return;
  if (
    [workflow.input.permissionOrigin, caller.run.permissionOrigin].some(
      (origin) => origin && !localOrigins.has(origin.source),
    )
  )
    return;
  const conversation = workspace.store.get<Conversation>('conversation', workflow.conversationId);
  const message = workspace.store.get<ConversationMessage>('message', workflow.userMessageId);
  if (
    !conversation ||
    conversation.deletedAt ||
    conversation.closedAt ||
    conversation.incognito ||
    conversation.untrustedContent ||
    workspace.store.get('external-conversation', conversation.id)
  )
    return;
  if (
    !message ||
    message.role !== 'user' ||
    message.conversationId !== conversation.id ||
    message.workflowId !== workflow.id ||
    message.externalRequest ||
    message.externalAgent ||
    message.device ||
    message.importedFrom ||
    message.untrustedContent ||
    message.combinedFrom
  )
    return;
  return conversation.id;
}

export function availableConversationTools(workspace: Workspace, caller: Caller): BridgeCatalogTool[] {
  return owner(workspace, caller)
    ? conversationManagementTools.filter((tool) => caller.write || tool.annotations?.readOnlyHint)
    : [];
}

function activeTasks(workspace: Workspace, id: string): number {
  const row = workspace.store.db
    .prepare(
      `SELECT count(*) AS count FROM workspace_records WHERE kind='workflow' AND owner=? AND json_extract(value,'$.status') IN (${activeStates.map(() => '?').join(',')})`,
    )
    .get(id, ...activeStates) as { count: number };
  return row.count;
}

function metadata(workspace: Workspace, conversation: Conversation) {
  const project = workspace.store.get<Project>('project', conversation.projectId);
  return {
    id: conversation.id,
    title: conversation.title,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    project: { id: conversation.projectId, name: project?.name ?? '' },
    archived: !!conversation.archivedAt,
    activeTasks: activeTasks(workspace, conversation.id),
  };
}

export async function callConversationTool(
  workspace: Workspace,
  controller: Controller,
  caller: Caller,
  name: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
) {
  const ownerId = owner(workspace, caller);
  if (!ownerId) throw new Error('仅本机用户的顶层任务可以管理 PugPort 对话。');
  signal.throwIfAborted();
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (name === 'list_conversations') {
    const input = listSchema.parse(args);
    const query = input.query?.trim().toLocaleLowerCase();
    const list = workspace.store
      .conversations()
      .filter(
        (conversation) =>
          !conversation.incognito &&
          !conversation.sideChat &&
          (!query || conversation.title.toLocaleLowerCase().includes(query)),
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
    const page = list.slice(input.offset, input.offset + input.limit);
    return JSON.stringify({
      timeZone,
      now: new Date().toISOString(),
      conversations: page.map((conversation) => metadata(workspace, conversation)),
      total: list.length,
      ...(input.offset + page.length < list.length ? { nextOffset: input.offset + page.length } : {}),
    });
  }
  const input = manageSchema.parse(args);
  if (new Set(input.conversation_ids).size !== input.conversation_ids.length) throw new Error('对话 ID 不能重复。');
  const validate = () => {
    signal.throwIfAborted();
    if (
      owner(workspace, caller) !== ownerId ||
      !caller.write ||
      caller.run.permissionMode !== 'workspace-write' ||
      workspace.store.get<Workflow>('workflow', caller.run.workflowId!)?.input.permissionMode !== 'workspace-write'
    )
      throw new Error('本次任务没有对话管理写入权限。');
    return input.conversation_ids.map((id) => {
      const conversation = workspace.store.get<Conversation>('conversation', id);
      if (
        !conversation ||
        id === ownerId ||
        conversation.incognito ||
        conversation.deletedAt ||
        conversation.closedAt ||
        conversation.sideChat ||
        activeTasks(workspace, id)
      )
        throw new Error('不能管理当前、运行中、无痕、侧聊或已删除的对话。');
      return conversation;
    });
  };
  const before = validate();
  const preview = before.map((conversation) => metadata(workspace, conversation));
  const description = JSON.stringify({ action: input.action, timeZone, conversations: preview }, null, 2);
  if (description.length > 18000) throw new Error('清单太长，无法完整展示确认；请减少这一批的对话数量。');
  const approved = await controller.approve(
    caller.run,
    input.action === 'delete' ? 'PugPort · 删除对话' : 'PugPort · 归档对话',
    description,
    signal,
    { requireUser: true, timeoutMs: 120000 },
  );
  if (!approved) throw new Error('用户未批准对话管理，未修改任何对话。');
  workspace.store.transaction(() => {
    const current = validate();
    if (
      JSON.stringify(current) !== JSON.stringify(before) ||
      JSON.stringify(current.map((conversation) => metadata(workspace, conversation))) !== JSON.stringify(preview)
    )
      throw new Error('确认期间对话状态已变化，未修改任何对话；请重新读取清单。');
    for (const conversation of current) {
      if (input.action === 'delete') workspace.deleteConversation(conversation.id);
      else workspace.archiveConversation(conversation.id, true);
    }
  });
  return JSON.stringify({ action: input.action, conversationIds: input.conversation_ids, completed: true });
}
