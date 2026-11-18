import { createHash, randomUUID } from 'node:crypto';
import type { Conversation, ConversationMessage, Project } from '../shared/types.ts';
import { safeToolEventText } from '../shared/tool-event-data.ts';
import type { Workspace } from './workspace.ts';

export const claudeHistoryLimits = Object.freeze({
  bytes: 10 * 1024 * 1024,
  depth: 32,
  records: 10000,
  conversations: 100,
});
type Source = 'claude' | 'claude-code';
type Turn = { role: 'user' | 'assistant'; content: string; createdAt?: string; messageId?: string };
type Chat = { id: string; title: string; messages: Turn[] };
export type ClaudeHistoryInput = { name: string; text: string };
export type ClaudeHistoryPreview = {
  fingerprint: string;
  source: Source;
  conversations: { id: string; title: string; messageCount: number; createdAt?: string; updatedAt?: string }[];
  skippedRecords: number;
};
export type ClaudeHistoryImportInput = ClaudeHistoryInput & { fingerprint: string; conversationId: string };
export type ClaudeHistoryImportResult = { conversation: Conversation; reused: boolean; importedMessages: number };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const fail = (reason: string) => new Error(`无法导入 Claude 历史：${reason}`);
const row = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const identifier = (value: unknown) => (typeof value === 'string' && /^[\w.-]{1,200}$/.test(value) ? value : undefined);
function date(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value)) return;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : undefined;
}
function title(value: unknown, fallback: string) {
  return typeof value === 'string'
    ? safeToolEventText(value)
        .replace(/[\x00-\x1f\x7f]/g, ' ')
        .trim()
        .slice(0, 240) || fallback
    : fallback;
}
/** Check nesting before JSON.parse; errors never include source snippets or parser diagnostics. */
function parse(text: string): unknown {
  let depth = 0,
    quoted = false,
    escaped = false;
  for (const character of text) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === '[' || character === '{') {
      if (++depth > claudeHistoryLimits.depth) throw fail('记录嵌套过深');
    } else if (character === ']' || character === '}') depth--;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw fail('文件不是有效的 JSON 或 JSONL');
  }
  const pending = [value];
  let nodes = 0;
  while (pending.length) {
    if (++nodes > 100000) throw fail('文件包含过多字段');
    const item = pending.pop();
    const children = Array.isArray(item) ? item : item && typeof item === 'object' ? Object.values(item) : [];
    if (nodes + pending.length + children.length > 100000) throw fail('文件包含过多字段');
    for (const child of children) pending.push(child);
  }
  return value;
}
function textContent(value: unknown): string {
  const text =
    typeof value === 'string'
      ? value
      : Array.isArray(value)
        ? value
            .filter((block) => row(block).type === 'text' && typeof row(block).text === 'string')
            .map((block) => row(block).text)
            .join('\n')
        : '';
  if (text.length > 1024 * 1024) throw fail('单条消息过大');
  return safeToolEventText(text).trim();
}
function read(input: ClaudeHistoryInput): { preview: ClaudeHistoryPreview; chats: Chat[] } {
  if (
    !input ||
    typeof input.name !== 'string' ||
    input.name.length > 255 ||
    !/\.(?:json|jsonl)$/i.test(input.name) ||
    typeof input.text !== 'string'
  )
    throw fail('请选择导出的 JSON 或 JSONL 文件');
  if (!input.text.trim() || Buffer.byteLength(input.text, 'utf8') > claudeHistoryLimits.bytes)
    throw fail('文件为空或超过 10 MiB');
  const fingerprint = hash(input.text);
  const text = input.text.replace(/^\uFEFF/, '').trim();
  let records = 0,
    skippedRecords = 0;
  const count = () => {
    if (++records > claudeHistoryLimits.records) throw fail('记录数量超过上限');
  };
  const chats: Chat[] = [];
  let source: Source;
  if (/\.jsonl$/i.test(input.name)) {
    source = 'claude-code';
    const groups = new Map<string, Chat>();
    const seen = new Map<string, string>();
    const lines = text.split(/\r?\n/).filter((line) => line.trim());
    if (lines.length > claudeHistoryLimits.records) throw fail('记录数量超过上限');
    for (const line of lines) {
      count();
      const item = row(parse(line));
      const message = row(item.message);
      if ((item.type !== 'user' && item.type !== 'assistant') || message.role !== item.type || item.isMeta === true) {
        skippedRecords++;
        continue;
      }
      const content = textContent(message.content);
      if (!content) {
        skippedRecords++;
        continue;
      }
      const session = identifier(item.sessionId) ?? 'export';
      const turn: Turn = {
        role: item.type,
        content,
        createdAt: date(item.timestamp),
        messageId: identifier(item.uuid),
      };
      if (turn.messageId) {
        const key = `${session}:${turn.messageId}`,
          signature = JSON.stringify(turn);
        if (seen.has(key)) {
          if (seen.get(key) !== signature) throw fail('相同消息标识对应不同内容');
          skippedRecords++;
          continue;
        }
        seen.set(key, signature);
      }
      let chat = groups.get(session);
      if (!chat) {
        if (groups.size >= claudeHistoryLimits.conversations) throw fail('对话数量超过上限');
        chat = { id: session, title: `Claude Code ${groups.size + 1}`, messages: [] };
        groups.set(session, chat);
        chats.push(chat);
      }
      chat.messages.push(turn);
    }
  } else {
    source = 'claude';
    const parsed = parse(text);
    const values = Array.isArray(parsed)
      ? parsed
      : Array.isArray(row(parsed).conversations)
        ? (row(parsed).conversations as unknown[])
        : [parsed];
    if (values.length > claudeHistoryLimits.conversations) throw fail('对话数量超过上限');
    const seen = new Set<string>();
    for (const value of values) {
      const item = row(value);
      if (!Array.isArray(item.chat_messages)) throw fail('不支持此导出格式');
      const id = identifier(item.uuid) ?? `conversation-${chats.length + 1}`;
      if (seen.has(id)) throw fail('对话标识重复');
      seen.add(id);
      const chat: Chat = { id, title: title(item.name, `Claude ${chats.length + 1}`), messages: [] };
      for (const value of item.chat_messages) {
        count();
        const message = row(value);
        if (message.sender !== 'human' && message.sender !== 'assistant') {
          skippedRecords++;
          continue;
        }
        const content = textContent(message.content) || textContent(message.text);
        if (!content) {
          skippedRecords++;
          continue;
        }
        chat.messages.push({
          role: message.sender === 'human' ? 'user' : 'assistant',
          content,
          createdAt: date(message.created_at),
          messageId: identifier(message.uuid),
        });
      }
      if (chat.messages.length) chats.push(chat);
    }
  }
  if (!chats.length) throw fail('没有可导入的用户或助手文字');
  return {
    chats,
    preview: {
      fingerprint,
      source,
      skippedRecords,
      conversations: chats.map((chat) => ({
        id: chat.id,
        title: chat.title,
        messageCount: chat.messages.length,
        createdAt: chat.messages.find((message) => message.createdAt)?.createdAt,
        updatedAt: [...chat.messages].reverse().find((message) => message.createdAt)?.createdAt,
      })),
    },
  };
}
export function previewClaudeHistory(input: ClaudeHistoryInput): ClaudeHistoryPreview {
  return read(input).preview;
}

/** Synchronous transaction makes repeated requests idempotent. No source files, sessions or tools are opened. */
export function importClaudeHistory(
  workspace: Pick<Workspace, 'store'>,
  projectId: string,
  input: ClaudeHistoryImportInput,
  publish: () => void,
): ClaudeHistoryImportResult {
  const { chats, preview } = read(input);
  if (input.fingerprint !== preview.fingerprint) throw fail('文件已改变，请重新预览');
  const chat = chats.find((item) => item.id === input.conversationId);
  if (!chat) throw fail('所选对话不存在');
  const receiptId = hash(JSON.stringify([projectId, preview.source, preview.fingerprint, chat.id]));
  let result: ClaudeHistoryImportResult;
  try {
    result = workspace.store.transaction(() => {
      const project = workspace.store.get<Project>('project', projectId);
      if (!project || project.removedAt || workspace.store.get('project-purge', projectId))
        throw fail('项目不存在或已移除');
      if (
        project.scope === 'chat' &&
        workspace.store
          .list<Conversation>('conversation', projectId, Number.MAX_SAFE_INTEGER)
          .some((conversation) => conversation.incognito)
      )
        throw fail('隐身对话不能导入持久历史');
      const receipt = workspace.store.get<{ conversationId: string; importedMessages: number }>(
        'claude-history-import',
        receiptId,
      );
      if (receipt) {
        const conversation = workspace.store.get<Conversation>('conversation', receipt.conversationId);
        if (
          !conversation ||
          conversation.projectId !== projectId ||
          conversation.deletedAt ||
          conversation.archivedAt ||
          conversation.closedAt
        )
          throw fail('此前已导入，请先在历史中恢复该对话');
        return { conversation, reused: true, importedMessages: receipt.importedMessages };
      }
      const now = new Date().toISOString();
      const conversation: Conversation = {
        id: randomUUID(),
        projectId,
        title: chat.title,
        createdAt: now,
        updatedAt: now,
        untrustedContent: true,
        memory: 'off',
      };
      workspace.store.save('conversation', conversation.id, projectId, conversation);
      let displayTime = chat.messages.find((message) => message.createdAt)?.createdAt ?? now;
      for (const [sourceIndex, turn] of chat.messages.entries()) {
        if (turn.createdAt && turn.createdAt > displayTime) displayTime = turn.createdAt;
        const message: ConversationMessage = {
          id: randomUUID(),
          conversationId: conversation.id,
          role: turn.role,
          content: turn.content,
          createdAt: displayTime,
          untrustedContent: true,
          importedFrom: {
            provider: 'claude',
            source: preview.source,
            fingerprint: preview.fingerprint,
            conversationId: chat.id,
            ...(turn.messageId ? { messageId: turn.messageId } : {}),
            ...(turn.createdAt ? { sourceCreatedAt: turn.createdAt } : {}),
            sourceIndex,
            timestampKind: turn.createdAt === displayTime ? 'source' : 'imported',
          },
        };
        workspace.store.save('message', message.id, conversation.id, message);
      }
      workspace.store.save('claude-history-import', receiptId, projectId, {
        conversationId: conversation.id,
        importedMessages: chat.messages.length,
        fingerprint: preview.fingerprint,
        source: preview.source,
        importedAt: now,
      });
      return { conversation, reused: false, importedMessages: chat.messages.length };
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('无法导入 Claude 历史：')) throw error;
    throw fail('保存失败，未创建部分对话');
  }
  // A lost notification must not roll back a durable import or create a duplicate on retry.
  try {
    publish();
  } catch {
    /* The next state read finds the complete transaction. */
  }
  return result;
}
