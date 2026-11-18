import type { Express } from 'express';
import type { Conversation, Project } from '../shared/types.ts';
import type { WorkspaceStore } from './workspace-store.ts';
import { messageAuthor } from './message-author.ts';

function exportFileName(title: string, date: string, format: 'md' | 'json') {
  let name = title
    .replace(/[\/\\:*?"<>|\u0000-\u001f\u007f-\u009f]/g, '')
    .trim()
    .replace(/[. ]+$/g, '');
  if (!name) name = 'conversation';
  if (/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:[. ]|$)/i.test(name)) name = `_${name}`;
  // Leave room for the date, and never split a Unicode surrogate pair.
  name = name.slice(0, 69).replace(/[\ud800-\udbff]$/, '');
  return `${name}-${date}.${format}`;
}

export function conversationExportRoutes(
  app: Express,
  store: WorkspaceStore,
  label: (runtimeId: string) => string | undefined,
) {
  app.get('/api/conversations/:id/export', (req, res) => {
    const format = req.query.format;
    if (format !== 'md' && format !== 'json') {
      res.status(400).json({ error: 'Invalid export format' });
      return;
    }
    const conversation = store.get<Conversation>('conversation', req.params.id);
    if (!conversation || conversation.deletedAt) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }
    const owner = store.get<Project>('project', conversation.projectId);
    const project = owner?.scope !== 'chat' ? (owner?.name ?? '') : '';
    const exportDate = new Date();
    const exportedAt = exportDate.toISOString();
    const messages = store
      .allMessages(conversation.id)
      .filter((message) => !message.replacedBy && !message.systemNotice)
      .map((message) => ({
        id: message.id,
        role: message.role,
        author: messageAuthor(message, label, false),
        createdAt: message.createdAt,
        content: message.content,
        quotes: (message.quotes ?? []).map(({ text, note, messageId, markup }) => ({
          text,
          note,
          messageId,
          // Crop attachment ids stay private like every other attachment id.
          ...(markup ? { markup: { ...markup, crops: undefined } } : {}),
        })),
        attachments: (message.attachments ?? []).map(({ name, size, mimeType }) => ({ name, size, mimeType })),
      }));
    const { id, title, createdAt, updatedAt } = conversation;
    const content =
      format === 'json'
        ? JSON.stringify(
            {
              exportedAt,
              app: 'PugPort',
              version: 1,
              conversation: { id, title, project, createdAt, updatedAt },
              messages,
            },
            null,
            2,
          )
        : [
            `# ${title}`,
            [project, new Date(createdAt).toLocaleString(), new Date(updatedAt).toLocaleString()]
              .filter(Boolean)
              .join(' · '),
            ...messages.flatMap((message) => [
              `### ${message.author} · ${new Date(message.createdAt).toLocaleString()}`,
              message.content + ((message.content.match(/^```/gm)?.length ?? 0) % 2 ? '\n```' : ''),
              ...message.quotes.map((quote) =>
                [
                  quote.text
                    .split(/\r\n|\r|\n/)
                    .map((line) => `> ${line}`)
                    .join('\n'),
                  quote.note,
                ]
                  .filter(Boolean)
                  .join('\n\n'),
              ),
              ...(message.attachments.length
                ? [message.attachments.map((file) => `- ${file.name} (${file.size} B)`).join('\n')]
                : []),
            ]),
          ].join('\n\n');
    res.json({
      fileName: exportFileName(title, exportDate.toLocaleDateString('sv-SE'), format),
      mimeType: format === 'json' ? 'application/json' : 'text/markdown',
      content: content + '\n',
    });
  });
}
