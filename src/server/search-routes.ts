import type { Express } from 'express';
import type { WorkspaceStore } from './workspace-store.ts';
import { searchSnippet, type ConversationSearchResult } from '../shared/search.ts';

export function searchConversations(store: WorkspaceStore, query: string, limit = 30): ConversationSearchResult[] {
  const q = query.trim().slice(0, 200);
  if (q.length < 2) return [];
  const count = Number.isFinite(limit) ? Math.max(1, Math.min(50, Math.floor(limit))) : 30;
  const pattern = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
  // The model index is project/turn scoped. User search instead reads durable records with a SQL result bound.
  // Title-only hits appear once (even for empty conversations), rather than once per message.
  const rows = store.db
    .prepare(
      `
    WITH live AS (
      SELECT c.id, json_extract(c.value,'$.title') AS title, json_extract(c.value,'$.createdAt') AS createdAt,
        json_extract(c.value,'$.archivedAt') AS archivedAt
      FROM workspace_records c JOIN workspace_records p ON p.kind='project' AND p.id=c.owner
      WHERE c.kind='conversation' AND COALESCE(json_extract(c.value,'$.incognito'),0)=0
        AND COALESCE(json_extract(c.value,'$.deletedAt'),'')=''
        AND json_extract(c.value,'$.sideChat') IS NULL
        AND COALESCE(json_extract(p.value,'$.removedAt'),'')=''
    ), hits AS (
      SELECT c.id AS conversationId,c.title,c.archivedAt,m.id AS messageId,
        json_extract(m.value,'$.content') AS text,json_extract(m.value,'$.createdAt') AS createdAt
      FROM workspace_records m JOIN live c ON c.id=m.owner
      WHERE m.kind='message' AND json_extract(m.value,'$.content') LIKE ? ESCAPE '\\'
      UNION ALL
      SELECT c.id,c.title,c.archivedAt,
        (SELECT m.id FROM workspace_records m WHERE m.kind='message' AND m.owner=c.id
          ORDER BY json_extract(m.value,'$.createdAt') DESC,m.id LIMIT 1),c.title,
        COALESCE((SELECT json_extract(m.value,'$.createdAt') FROM workspace_records m
          WHERE m.kind='message' AND m.owner=c.id ORDER BY json_extract(m.value,'$.createdAt') DESC,m.id LIMIT 1),c.createdAt)
      FROM live c WHERE c.title LIKE ? ESCAPE '\\'
        AND NOT EXISTS (SELECT 1 FROM workspace_records m WHERE m.kind='message' AND m.owner=c.id
          AND json_extract(m.value,'$.content') LIKE ? ESCAPE '\\')
    ) SELECT * FROM hits ORDER BY createdAt DESC,conversationId,messageId LIMIT ?
  `,
    )
    .all(pattern, pattern, pattern, count) as Array<Omit<ConversationSearchResult, 'snippet'> & { text: string }>;
  return rows.map(({ text, ...row }) => ({ ...row, snippet: searchSnippet(text, q) }));
}

export function searchRoutes(app: Express, store: WorkspaceStore) {
  app.get('/api/search', (req, res) => {
    if (
      typeof req.query.q !== 'string' ||
      req.query.q.length > 200 ||
      (req.query.limit !== undefined && (typeof req.query.limit !== 'string' || !/^\d+$/.test(req.query.limit)))
    ) {
      res.status(400).json({ error: 'Invalid search query' });
      return;
    }
    res.json(searchConversations(store, req.query.q, req.query.limit === undefined ? 30 : Number(req.query.limit)));
  });
}
