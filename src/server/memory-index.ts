import MiniSearch from 'minisearch';
import { createHash } from 'node:crypto';
import type { MemoryIndexRow, MemorySearchHit, WorkspaceStore } from './workspace-store.ts';

type MemoryScope = { conversationId: string; userMessageId: string };
type Chunk = { id: string; text: string; paths: string; source: MemoryIndexRow; offset: number };
type Anchor = { rowid: number; createdAt: string };

/** MiniSearch's tokenizer is Unicode-aware here; Han bigrams preserve short Chinese subjects such as "迅雷". */
export function tokenizeMemory(text: string): string[] {
  const tokens: string[] = [];
  for (const word of text.toLowerCase().match(/[a-z0-9][a-z0-9_.-]{1,63}|[\p{Script=Han}]{2,}/gu) ?? []) {
    if (/\p{Script=Han}/u.test(word)) {
      if (word.length <= 8) tokens.push(word);
      for (let index = 0; index + 1 < word.length; index++) tokens.push(word.slice(index, index + 2));
    } else if (!/^\d+(?:[_.-]\d+)*$/.test(word) && !/^[a-f0-9]{16,}$/i.test(word)) tokens.push(word);
  }
  // Repeated tool tables/path prefixes add no subject information; cap per-chunk vocabulary instead of indexing
  // millions of duplicate identifiers. BM25 still weights matching terms and independent evidence chunks.
  return [...new Set(tokens)].slice(0, 512);
}

/** A private in-memory inverted index, owned by the persistent archive worker. It never persists outside SQLite. */
export class ProjectMemoryIndex {
  private index = new MiniSearch<Chunk>({
    fields: ['text', 'paths'],
    tokenize: tokenizeMemory,
    processTerm: (term) => term,
    searchOptions: { combineWith: 'OR', boost: { paths: 2 }, prefix: false, fuzzy: false },
  });
  private rows = new Map<string, MemoryIndexRow>();
  private chunks = new Map<string, Chunk>();
  private ids = new Map<string, string[]>();
  private conversations = new Set<string>();
  private sideConversations = new Set<string>();
  private updatedSince = '';
  private afterRowid = 0;
  private databaseRevision = '';
  private ready = false;
  private closed = false;
  private warming?: Promise<void>;

  constructor(
    private store: WorkspaceStore,
    private projectId: string,
  ) {}

  get isReady() {
    return this.ready;
  }
  private revision() {
    // data_version observes writes by the app connection; total_changes also covers in-memory unit fixtures.
    const dataVersion = this.store.db.prepare('PRAGMA data_version').get()!.data_version;
    const totalChanges = this.store.db.prepare('SELECT total_changes() AS count').get()!.count;
    return `${dataVersion}:${totalChanges}`;
  }
  private updateRow(row: MemoryIndexRow) {
    this.updatedSince = row.updatedAt > this.updatedSince ? row.updatedAt : this.updatedSince;
    this.afterRowid = Math.max(this.afterRowid, row.rowid);
    const previous = this.rows.get(row.messageId);
    if (previous?.content === row.content) {
      // History consolidation can move unchanged text to another conversation. Refresh all scope/time metadata
      // without rebuilding token postings, otherwise chunks still point at a deleted import-only shell.
      for (const id of this.ids.get(row.messageId) ?? []) {
        const chunk = this.chunks.get(id);
        if (chunk) chunk.source = row;
      }
      this.rows.set(row.messageId, row);
      return;
    }
    const oldIds = this.ids.get(row.messageId) ?? [];
    for (const id of oldIds) {
      this.index.discard(id);
      this.chunks.delete(id);
    }
    const ids: string[] = [];
    // Chunking retains evidence in the middle of long tool outputs instead of taking only a head/tail.
    for (let offset = 0; offset < row.content.length; offset += 3000) {
      const text = row.content.slice(offset, offset + 3200);
      const id = `${row.messageId}:${offset}`;
      const paths = (text.match(/[A-Za-z]:[\\/][^\s"'`<>|]{1,512}|(?:\/[^\s/]+){2,}/g) ?? [])
        .map((path) => path.split(/[\\/]/).slice(-2).join(' '))
        .join('\n');
      const chunk: Chunk = { id, text, paths, source: row, offset };
      this.index.add(chunk);
      this.chunks.set(id, chunk);
      ids.push(id);
    }
    this.ids.set(row.messageId, ids);
    this.rows.set(row.messageId, row);
  }
  private finish(revision: string) {
    const live = new Map(
      this.store.memoryIndexMembership(this.projectId).map((row) => [row.messageId, row.conversationId]),
    );
    for (const [messageId, row] of this.rows) {
      const owner = live.get(messageId);
      if (!owner) {
        for (const id of this.ids.get(messageId) ?? []) {
          this.index.discard(id);
          this.chunks.delete(id);
        }
        this.ids.delete(messageId);
        this.rows.delete(messageId);
      } else if (owner !== row.conversationId) {
        const refreshed = { ...row, conversationId: owner };
        this.rows.set(messageId, refreshed);
        for (const id of this.ids.get(messageId) ?? []) {
          const chunk = this.chunks.get(id);
          if (chunk) chunk.source = refreshed;
        }
      }
    }
    const conversations = this.store.conversations(this.projectId);
    this.conversations = new Set(conversations.map((row) => row.id));
    // Classification can change without editing message text. Refresh it when
    // reconciling ownership so a warm index does not expose side-chat evidence.
    this.sideConversations = new Set(conversations.filter((row) => row.sideChat).map((row) => row.id));
    this.databaseRevision = revision;
    this.ready = true;
  }
  synchronize() {
    const revision = this.revision();
    if (revision === this.databaseRevision) return;
    const updates = this.store.iterateMemoryIndexRows(this.projectId, this.updatedSince, this.afterRowid);
    for (const row of updates) this.updateRow(row);
    this.finish(revision);
  }
  /** Cold requests use direct evidence; background indexing yields between records so later requests never wait. */
  warm(): Promise<void> {
    if (this.closed || !this.store.db.isOpen) return Promise.resolve();
    if (this.warming) return this.warming;
    if (this.ready) return Promise.resolve();
    this.warming = (async () => {
      if (this.closed || !this.store.db.isOpen) return;
      const revision = this.revision();
      const updates = this.store.iterateMemoryIndexRows(this.projectId, this.updatedSince, this.afterRowid);
      for (const row of updates) {
        if (this.closed || !this.store.db.isOpen) return;
        this.updateRow(row);
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (this.closed || !this.store.db.isOpen) return;
      }
      if (this.closed || !this.store.db.isOpen) return;
      this.finish(revision);
    })().finally(() => {
      this.warming = undefined;
    });
    return this.warming;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.warming?.catch(() => {});
  }

  private anchor(scope: MemoryScope): Anchor | undefined {
    if (!this.store.memoryEnabled(scope.conversationId)) return;
    return this.store.db
      .prepare(
        "SELECT rowid,json_extract(value,'$.createdAt') AS createdAt FROM workspace_records WHERE kind='message' AND id=? AND owner=?",
      )
      .get(scope.userMessageId, scope.conversationId) as Anchor | undefined;
  }
  private eligible(row: MemoryIndexRow, scope: MemoryScope, anchor: Anchor) {
    if (!this.conversations.has(row.conversationId)) return false;
    if (row.conversationId === scope.conversationId)
      return row.rowid < anchor.rowid || (row.imported === 1 && row.createdAt <= anchor.createdAt);
    if (this.sideConversations.has(row.conversationId)) return false;
    return row.createdAt <= anchor.createdAt;
  }

  search(scope: MemoryScope, terms: string[], limit = 6): MemorySearchHit[] {
    this.synchronize();
    const anchor = this.anchor(scope);
    if (!anchor || !terms.length) return [];
    const seen = new Set<string>();
    const results = this.index.search(terms.join(' '), {
      filter: (result) => {
        const chunk = this.chunks.get(String(result.id));
        return !!chunk && this.eligible(chunk.source, scope, anchor);
      },
    });
    return results
      .sort((a, b) => {
        const left = this.chunks.get(String(a.id))!.source;
        const right = this.chunks.get(String(b.id))!.source;
        const leftScore = a.score * (left.conversationId === scope.conversationId ? 1.1 : 1);
        const rightScore = b.score * (right.conversationId === scope.conversationId ? 1.1 : 1);
        return rightScore - leftScore || right.createdAt.localeCompare(left.createdAt) || right.rowid - left.rowid;
      })
      .flatMap((result) => {
        const chunk = this.chunks.get(String(result.id))!;
        if (seen.has(chunk.source.messageId) || seen.size >= limit) return [];
        seen.add(chunk.source.messageId);
        const match =
          terms.map((term) => chunk.text.toLowerCase().indexOf(term.toLowerCase())).find((position) => position >= 0) ??
          0;
        const start = Math.max(0, match - 360);
        return [
          {
            messageId: chunk.source.messageId,
            conversationId: chunk.source.conversationId,
            role: chunk.source.role,
            createdAt: chunk.source.createdAt,
            excerpt: chunk.text.slice(start, start + 1800),
            sourceOffset: chunk.offset + start,
            score: result.score,
          },
        ];
      });
  }

  /** Messages found by meaning, kept only when this conversation may see them, with an excerpt around the passage. */
  semanticHits(
    scope: MemoryScope,
    candidates: Array<{ messageId: string; offset: number; score: number; sourceHash?: string }>,
    limit = 6,
  ): MemorySearchHit[] {
    this.synchronize();
    const anchor = this.anchor(scope);
    if (!anchor) return [];
    const hits: MemorySearchHit[] = [];
    for (const candidate of candidates) {
      if (hits.length >= limit) break;
      const row = this.rows.get(candidate.messageId);
      if (!row || row.messageId === scope.userMessageId || !this.eligible(row, scope, anchor)) continue;
      // A vector from an earlier edit must not select unrelated text at the same offset.
      // Older BGE candidates do not carry a fingerprint and retain their existing visibility checks.
      if (
        candidate.sourceHash !== undefined &&
        createHash('sha256').update(row.content).digest('hex') !== candidate.sourceHash
      )
        continue;
      const start = Math.max(0, candidate.offset - 200);
      hits.push({
        messageId: row.messageId,
        conversationId: row.conversationId,
        role: row.role,
        createdAt: row.createdAt,
        excerpt: row.content.slice(start, start + 1800),
        sourceOffset: start,
        score: candidate.score,
      });
    }
    return hits;
  }

  pathSources(scope: MemoryScope): MemorySearchHit[] {
    this.synchronize();
    const anchor = this.anchor(scope);
    if (!anchor) return [];
    return [...this.rows.values()]
      .filter((row) => this.eligible(row, scope, anchor) && /[A-Za-z]:[\\/]| \/[^\s]/.test(row.content))
      .sort((a, b) => b.rowid - a.rowid)
      .slice(0, 384)
      .map((row) => ({
        messageId: row.messageId,
        conversationId: row.conversationId,
        role: row.role,
        createdAt: row.createdAt,
        excerpt: row.content.slice(0, 40000),
        sourceOffset: 0,
        score: 0,
      }));
  }
}

const registry = new WeakMap<WorkspaceStore, Map<string, ProjectMemoryIndex>>();
export function projectMemoryIndex(store: WorkspaceStore, projectId: string): ProjectMemoryIndex {
  let projects = registry.get(store);
  if (!projects) {
    projects = new Map();
    registry.set(store, projects);
  }
  let index = projects.get(projectId);
  if (!index) {
    index = new ProjectMemoryIndex(store, projectId);
    projects.set(projectId, index);
    if (projects.size > 4) projects.delete(projects.keys().next().value!);
  } else {
    projects.delete(projectId);
    projects.set(projectId, index);
  }
  return index;
}

export async function closeProjectMemoryIndexes(store: WorkspaceStore): Promise<void> {
  const projects = registry.get(store);
  if (!projects) return;
  registry.delete(store);
  await Promise.allSettled([...projects.values()].map((index) => index.close()));
}
