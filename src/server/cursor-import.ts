import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, posix, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { cursorUserFolder, cursorDatabaseText } from './cursor-usage.ts';
import { attachmentLimits } from './attachments.ts';
import type { Workspace } from './workspace.ts';
import type { Conversation, ConversationMessage, Project } from '../shared/types.ts';
import type { CursorChat, CursorChatList } from '../shared/cursor-import.ts';

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const importing = new Set<string>();
const failure = (reason: string) => new Error(`读不到这条 Cursor 对话：${reason}`);

function date(value: unknown): string | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return;
  const time = new Date(value);
  return Number.isFinite(time.getTime()) ? time.toISOString() : undefined;
}

function cursorPath(path: string, platform: NodeJS.Platform): string {
  // Cursor can retain an alias while PugPort stores the project's physical path.
  // Synthetic paths for another OS must retain that OS's lexical rules.
  if (platform === process.platform) {
    try {
      path = realpathSync.native(path);
    } catch {
      // Missing/offline projects can still match their recorded spelling.
    }
  }
  const normalized = (platform === 'win32' ? win32 : posix)
    .normalize(path)
    .replace(platform === 'win32' ? /[\\/]+$/ : /\/+$/, '');
  return platform === 'linux' ? normalized : normalized.toLowerCase();
}

function readJson(
  db: DatabaseSync,
  table: 'ItemTable' | 'cursorDiskKV',
  key: string,
): Record<string, unknown> | undefined {
  const row = db.prepare(`SELECT value FROM ${table} WHERE key = ?`).get(key);
  return row ? object(JSON.parse(cursorDatabaseText(row.value))) : undefined;
}

/** Only workspace indexes are read here. Opening the global database requires choosing a chat. */
export function listCursorChats(
  folder: string,
  root = cursorUserFolder(),
  platform: NodeJS.Platform = process.platform,
): CursorChatList {
  if (!existsSync(root)) return { installed: false, chats: [] };
  const storage = join(root, 'workspaceStorage');
  const chats = new Map<string, CursorChat>();
  let matched = false;
  let readable = false;
  try {
    if (!existsSync(storage)) return { installed: true, chats: [] };
    for (const entry of readdirSync(storage, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        const directory = join(storage, entry.name);
        const metadata = join(directory, 'workspace.json');
        if (!existsSync(metadata)) continue;
        const workspace = object(JSON.parse(readFileSync(metadata, 'utf8')));
        if (typeof workspace.folder !== 'string' || !workspace.folder.startsWith('file:')) continue;
        const path = fileURLToPath(workspace.folder, { windows: platform === 'win32' });
        if (cursorPath(path, platform) !== cursorPath(folder, platform)) continue;
        matched = true;
        const db = new DatabaseSync(join(directory, 'state.vscdb'), { readOnly: true, timeout: 3000 });
        try {
          const data = readJson(db, 'ItemTable', 'composer.composerData');
          const composers = data ? data.allComposers : [];
          if (!Array.isArray(composers)) throw Error();
          readable = true;
          for (const value of composers) {
            const item = object(value);
            if (typeof item.composerId !== 'string' || !item.composerId) continue;
            const updatedAt = date(item.lastUpdatedAt) ?? date(item.createdAt);
            const name = typeof item.name === 'string' ? item.name.trim() : '';
            const chat: CursorChat = {
              composerId: item.composerId,
              name: name || `Cursor chat ${(updatedAt ?? new Date().toISOString()).slice(0, 10)}`,
              updatedAt,
            };
            const previous = chats.get(chat.composerId);
            if (!previous || (chat.updatedAt ?? '') > (previous.updatedAt ?? '')) chats.set(chat.composerId, chat);
          }
        } finally {
          db.close();
        }
      } catch {
        continue;
      }
    }
    if (matched && !readable) throw Error();
    return {
      installed: true,
      chats: [...chats.values()].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')),
    };
  } catch {
    // Never expose SQLite/JSON diagnostics: they can contain private record values.
    throw failure('workspace index unreadable');
  }
}

export function cursorTranscript(chat: CursorChat, folder: string, root = cursorUserFolder()): Buffer {
  const turns: { type: number; texts: string[]; tools: string[] }[] = [];
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(join(root, 'globalStorage', 'state.vscdb'), { readOnly: true, timeout: 3000 });
    const data = readJson(db, 'cursorDiskKV', `composerData:${chat.composerId}`) ?? {};
    const headers = data.fullConversationHeadersOnly;
    const inline = data.conversation;
    const bubbles = Array.isArray(headers) && headers.length ? headers : inline;
    if (!Array.isArray(bubbles) || !bubbles.length) throw Error();
    for (const value of bubbles) {
      const header = object(value);
      let bubble = header;
      if (bubbles === headers) {
        if (typeof header.bubbleId !== 'string' || !header.bubbleId) throw Error();
        const record = readJson(db, 'cursorDiskKV', `bubbleId:${chat.composerId}:${header.bubbleId}`);
        if (!record) continue;
        bubble = record;
      }
      if (bubble.type !== 1 && bubble.type !== 2) continue;
      const text = typeof bubble.text === 'string' ? bubble.text.trim() : '';
      const tool = object(bubble.toolFormerData).name;
      const toolName = typeof tool === 'string' ? tool.trim() : '';
      if (!text && !toolName) continue;
      let turn = turns.at(-1);
      if (bubble.type !== 2 || turn?.type !== 2) {
        turn = { type: bubble.type, texts: [], tools: [] };
        turns.push(turn);
      }
      if (text) turn!.texts.push(text);
      if (toolName) turn!.tools.push(toolName);
    }
    if (!turns.length) throw Error();
  } catch {
    throw failure('database unreadable, unsupported format or empty chat');
  } finally {
    db?.close();
  }
  const singleLine = (text: string) => text.replace(/[\r\n]+/g, ' ');
  const escape = (text: string) => singleLine(text).replace(/[\\`*_<>\[\]]/g, '\\$&');
  const body = turns
    .map((turn) => {
      let text = turn.texts.join('\n\n');
      if ((text.match(/```/g)?.length ?? 0) % 2) text += '\n```';
      if (turn.tools.length) text += `${text ? '\n\n' : ''}*${turn.tools.map(escape).join(', ')}*`;
      return `### ${turn.type === 1 ? 'You' : 'Cursor'}\n\n${text}`;
    })
    .join('\n\n');
  const buffer = Buffer.from(
    `# ${escape(chat.name)}\n\nImported from Cursor · ${new Date().toISOString().slice(0, 10)} · ${singleLine(folder)}\n\n${body}\n`,
  );
  if (buffer.length > attachmentLimits.fileBytes) throw failure('attachment exceeds 50 MB');
  return buffer;
}

export function cursorImportedConversations(workspace: Workspace, projectId: string): Map<string, Conversation> {
  const found = new Map<string, Conversation>();
  const rows = workspace.store.db
    .prepare(
      `
    SELECT c.value, json_extract(m.value, '$.importedFrom.composerId') AS composerId
    FROM workspace_records c JOIN workspace_records m ON m.kind='message' AND m.owner=c.id
    WHERE c.kind='conversation' AND c.owner=?
      AND json_extract(c.value, '$.deletedAt') IS NULL
      AND json_extract(c.value, '$.archivedAt') IS NULL
      AND json_extract(c.value, '$.closedAt') IS NULL
      AND json_extract(m.value, '$.importedFrom.provider')='cursor'
  `,
    )
    .all(projectId) as { value: string; composerId: string }[];
  for (const row of rows) {
    found.set(row.composerId, JSON.parse(row.value) as Conversation);
  }
  return found;
}

export async function importCursorChat(
  workspace: Workspace,
  projectId: string,
  composerId: string,
  publish: () => void,
  root = cursorUserFolder(),
) {
  if (importing.has(composerId)) throw new Error('正在导入，请稍候');
  importing.add(composerId);
  let conversation: Conversation | undefined;
  try {
    const existing = cursorImportedConversations(workspace, projectId).get(composerId);
    if (existing) return existing;
    const project = workspace.store.get<Project>('project', projectId);
    if (!project || project.removedAt) throw failure('project not found');
    const chat = listCursorChats(project.path, root).chats.find((item) => item.composerId === composerId);
    if (!chat) throw failure('chat not found in project');
    const buffer = cursorTranscript(chat, project.path, root);
    const name =
      Array.from(chat.name.replace(/[\\/\x00-\x1f\x7f]/g, '_'))
        .slice(0, 197)
        .join('') + '.md';
    conversation = workspace.createConversation(projectId, chat.name, false, false);
    const attachment = await workspace.attachments.saveStream(
      conversation.id,
      { name, mimeType: 'text/markdown' },
      Readable.from(buffer),
    );
    const message: ConversationMessage = {
      id: randomUUID(),
      conversationId: conversation.id,
      role: 'user',
      content: `Imported from Cursor: ${chat.name}`,
      createdAt: new Date().toISOString(),
      attachments: [attachment],
      importedFrom: { provider: 'cursor', composerId },
    };
    workspace.store.save('message', message.id, conversation.id, message);
    publish();
    return conversation;
  } catch (error) {
    if (conversation) {
      conversation.deletedAt = new Date().toISOString();
      workspace.store.save('conversation', conversation.id, projectId, conversation);
      throw failure('attachment or conversation save failed');
    }
    throw error;
  } finally {
    importing.delete(composerId);
  }
}
