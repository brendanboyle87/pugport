import { isMainThread } from 'node:worker_threads';
import { track } from './memory-telemetry.ts';
import { StringDecoder } from 'node:string_decoder';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  openSync,
  readSync,
  writeSync,
  unlinkSync,
  rmdirSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Conversation, ConversationMessage, Project, RuntimeTarget } from '../shared/types.ts';
import { grokHistoryMessages, grokMessageContentHash } from './grok-history.ts';
import { WorkspaceStore } from './workspace-store.ts';
import { defaultGrokHome } from './native-accounts.ts';

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const normalized = (value: string) => (process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value));
const iso = (value: unknown, fallback: string) =>
  typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : fallback;
type ImportRecord = {
  conversationId: string;
  sessionId: string;
  source: string;
  archive: string;
  importedAt: string;
  files: Record<string, string>;
  fingerprint?: string;
  createdAt?: string;
  updatedAt?: string;
};
export type GrokHistoryArchive = {
  path: string;
  messages: number;
  createdAt: string;
  conversationId?: string;
  continuation?: {
    sessionId: string;
    updatedAt: string;
    lastUserRequest?: string;
    lastAssistantResponse?: string;
    planPath?: string;
  };
  sourceArchives?: string[];
};
export type GrokHistorySyncResult = {
  conversationId: string;
  sessions: number;
  addedMessages: number;
  retainedMessages: number;
  incompleteLines: number;
  changed: boolean;
  warnings: string[];
  deferredSessions?: number;
  skippedSessions?: number;
  sourceBytes?: number;
};
// Bump when source inventory or conversation projection semantics change.
const sourceCacheVersion = 2;
export const grokSyncByteBudget = 256 * 1024 * 1024;
type SourceCache = { version: number; fingerprint: string; result: GrokHistorySyncResult };
const sourceFiles = [
  'summary.json',
  'chat_history.jsonl',
  'events.jsonl',
  'updates.jsonl',
  'plan.json',
  'plan_mode.json',
  'last_recap_main_turn',
];
const segmentFolders = ['compaction', 'compaction_checkpoints'];

const isLive = (conversation?: Conversation) => !!conversation && !conversation.deletedAt;

function inside(directory: string, path: string) {
  const rel = relative(directory, path);
  return !!rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep);
}
function checkedSource(directory: string, path: string, required = false): string | undefined {
  if (!existsSync(path)) {
    if (required) throw Error('缺少 Grok 历史文件。');
    return;
  }
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile() || !inside(realpathSync.native(directory), realpathSync.native(path)))
    throw Error('历史来源包含链接或越界路径。');
  if (stat.size > 128 * 1024 * 1024) throw Error('历史文件超过本次同步上限。');
  return path;
}
function readSafe(directory: string, path: string, required = false): Buffer | undefined {
  const source = checkedSource(directory, path, required);
  return source ? readFileSync(source) : undefined;
}
function inventory(directory: string) {
  const files: Record<string, string> = {};
  const sizes: Record<string, number> = {};
  let bytes = 0;
  const digest = createHash('sha256');
  const add = (name: string, required = false) => {
    const path = join(directory, name);
    if (!existsSync(path)) {
      if (required) throw Error('missing');
      return;
    }
    const stat = lstatSync(path, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isFile() || !inside(realpathSync.native(directory), realpathSync.native(path)))
      throw Error('unsafe');
    if (stat.size > 128n * 1024n * 1024n) throw Error('oversized-file');
    files[name] = path;
    sizes[name] = Number(stat.size);
    bytes += Number(stat.size);
    digest.update(JSON.stringify([name, stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String)));
  };
  for (const name of sourceFiles) add(name, name === 'summary.json' || name === 'chat_history.jsonl');
  for (const folder of segmentFolders) {
    const path = join(directory, folder);
    if (!existsSync(path)) continue;
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw Error('unsafe');
    for (const name of readdirSync(path).sort())
      if (/^[a-zA-Z0-9_.-]+\.(?:md|json)$/i.test(name)) add(folder + '/' + name);
  }
  if (bytes > grokSyncByteBudget) throw Error('oversized-session');
  return { files, sizes, bytes, fingerprint: digest.digest('hex') };
}

/** Bounded raw IO, including archived files. Decode across chunk boundaries without splitting UTF-8. */
export function* grokFileLines(path: string): Generator<string> {
  const fd = openSync(path, 'r');
  const chunk = Buffer.allocUnsafe(64 * 1024);
  const decoder = new StringDecoder('utf8');
  let pieces: string[] = [];
  try {
    let size: number;
    while ((size = readSync(fd, chunk))) {
      const text = decoder.write(chunk.subarray(0, size));
      let at = 0,
        end: number;
      while ((end = text.indexOf('\n', at)) >= 0) {
        const part = text.slice(at, end);
        if (pieces.length) {
          pieces.push(part);
          yield pieces.join('');
          pieces = [];
        } else yield part;
        at = end + 1;
      }
      if (at < text.length) pieces.push(text.slice(at));
    }
    const last = decoder.end();
    if (last) pieces.push(last);
    if (pieces.length) yield pieces.join('');
  } finally {
    closeSync(fd);
  }
}

function removeCapture(directory: string, files: Record<string, string>) {
  // Only paths just created by this pass; never recursively traverse a directory or junction.
  for (const name of Object.keys(files)) unlinkSync(join(directory, name));
  for (const folder of segmentFolders) {
    try {
      rmdirSync(join(directory, folder));
    } catch {
      /* Absent or not empty. */
    }
  }
  rmdirSync(directory);
}
function archiveFile(source: string, destination: string, bytes: number) {
  mkdirSync(dirname(destination), { recursive: true });
  const input = openSync(source, 'r');
  const digest = createHash('sha256');
  try {
    const output = openSync(destination, 'wx');
    try {
      const chunk = Buffer.allocUnsafe(64 * 1024);
      let size: number;
      while (bytes > 0 && (size = readSync(input, chunk, 0, Math.min(bytes, chunk.length), null))) {
        bytes -= size;
        digest.update(chunk.subarray(0, size));
        for (let at = 0; at < size;) at += writeSync(output, chunk, at, size - at);
      }
    } finally {
      closeSync(output);
    }
  } finally {
    closeSync(input);
  }
  return digest.digest('hex');
}

/** Metadata only: unchanged sources need no JSON parsing, hashing of logs, or SQL projection rebuild. */
function sourceFingerprint(homes: string[], projectPath: string): string {
  const digest = createHash('sha256');
  const add = (name: string, value: unknown) => digest.update(JSON.stringify([name, value]) + '\n');
  add('algorithm', `grok-history-stat-and-projection-v${sourceCacheVersion}`);
  add('project', normalized(projectPath));
  for (const home of [...new Map(homes.map((value) => [normalized(value), resolve(value)])).values()].sort()) {
    add('home', normalized(home));
    const source = join(home, 'sessions', encodeURIComponent(projectPath));
    if (!existsSync(source)) {
      add('missing', source);
      continue;
    }
    const sourceStat = lstatSync(source);
    if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) throw Error('不支持链接的会话目录。');
    for (const entry of readdirSync(source, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) throw Error('不支持链接的会话。');
      if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/i.test(entry.name)) continue;
      const directory = join(source, entry.name);
      const directoryStat = lstatSync(directory);
      if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) throw Error('不支持链接的会话。');
      const canonical = realpathSync.native(directory);
      add('session', normalized(canonical));
      const addFile = (name: string, required = false) => {
        const path = join(directory, name);
        if (!existsSync(path)) {
          if (required) throw Error('缺少 Grok 历史文件。');
          add(name, null);
          return;
        }
        const stat = lstatSync(path, { bigint: true });
        if (stat.isSymbolicLink() || !stat.isFile() || !inside(canonical, realpathSync.native(path)))
          throw Error('历史来源包含链接或越界路径。');
        add(name, [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String));
      };
      for (const name of sourceFiles) addFile(name, name === 'summary.json' || name === 'chat_history.jsonl');
      for (const folder of segmentFolders) {
        const path = join(directory, folder);
        if (!existsSync(path)) {
          add(folder, null);
          continue;
        }
        const stat = lstatSync(path);
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw Error('不支持链接的历史分段目录。');
        add('folder', folder);
        for (const name of readdirSync(path).sort())
          if (/^[a-zA-Z0-9_.-]+\.(?:md|json)$/i.test(name)) addFile(folder + '/' + name);
      }
    }
  }
  return digest.digest('hex');
}

/** Share discovery with the standalone launcher so a first session in an isolated account is not skipped. */
export function grokHistoryHomes(store: WorkspaceStore, projectId: string): string[] {
  const configuredTargets = store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='config'").get()
    ? (store.db.prepare("SELECT value FROM config WHERE key='targets'").get() as { value: string } | undefined)
    : undefined;
  const targets: RuntimeTarget[] = configuredTargets ? JSON.parse(configuredTargets.value) : [];
  const imports = store.db
    .prepare("SELECT value FROM workspace_records WHERE kind='grok-import' AND owner=?")
    .all(projectId) as { value: string }[];
  return [
    defaultGrokHome(),
    ...targets
      .filter((target) => target.provider === 'grok' && target.environment === 'native' && target.accountHome)
      .map((target) => target.accountHome!),
    ...imports.map((row) => dirname(dirname(dirname((JSON.parse(row.value) as ImportRecord).source)))),
  ];
}

/** Local records only. This never executes a CLI, resumes a session, or edits native Grok data. */
function syncGrokHistoryNow(
  store: WorkspaceStore,
  dataDir: string,
  projectId: string,
  options: { grokHomes?: string[]; now?: string; force?: boolean } = {},
): GrokHistorySyncResult {
  const project = store.get<Project>('project', projectId);
  if (!project || project.removedAt || project.scope === 'chat') throw Error('请选择已有本地项目。');
  const busy = store.db
    .prepare(
      "SELECT 1 FROM workspace_records WHERE kind='workflow' AND json_extract(value,'$.projectId')=? AND json_extract(value,'$.status') IN ('queued','waiting-resource','planning','running','waiting-approval','waiting-confirmation') LIMIT 1",
    )
    .get(projectId);
  if (busy) throw Error('请等待或取消这个项目中未结束的任务，再同步历史。');
  const now = options.now ?? new Date().toISOString();
  const stamp = now.replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8);
  const imports = (
    store.db.prepare("SELECT id,value FROM workspace_records WHERE kind='grok-import' AND owner=?").all(projectId) as {
      id: string;
      value: string;
    }[]
  ).map((row) => ({ id: row.id, value: JSON.parse(row.value) as ImportRecord }));
  const oldArchive = store.get<GrokHistoryArchive>('history-archive', projectId);
  // An archive that points at a conversation which no longer exists (permanently emptied) counts as deleted too.
  if (oldArchive?.conversationId && !isLive(store.get<Conversation>('conversation', oldArchive.conversationId)))
    throw Error('合并历史已被删除；保留归档，但不会在后台自动恢复这个对话。');
  const conversations = store.conversations(projectId);
  const importIds = new Set(imports.map((row) => row.value.conversationId));
  const existingTarget =
    conversations.find((c) => c.id === oldArchive?.conversationId) ??
    conversations.filter((c) => importIds.has(c.id)).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
  const target: Conversation = existingTarget ?? {
    id: randomUUID(),
    projectId,
    title: 'Grok · 项目历史',
    createdAt: now,
    updatedAt: now,
  };
  for (const id of importIds)
    if (
      id !== target.id &&
      store.db.prepare("SELECT 1 FROM workspace_records WHERE kind='workflow' AND owner=? LIMIT 1").get(id)
    )
      throw Error('历史来源分属含有任务的多个对话，请分别同步，防止破坏任务和附件关联。');
  const homes = options.grokHomes ?? grokHistoryHomes(store, projectId);
  const fingerprint = sourceFingerprint(homes, project.path);
  const cache = store.get<SourceCache>('grok-source-cache', projectId);
  if (
    !options.force &&
    cache?.version === sourceCacheVersion &&
    cache?.fingerprint === fingerprint &&
    existingTarget?.grokHistory &&
    cache.result.conversationId === existingTarget.id
  ) {
    const count = store.db
      .prepare("SELECT COUNT(*) AS count FROM workspace_records WHERE kind='message' AND owner=?")
      .get(existingTarget.id) as { count: number };
    return {
      ...cache.result,
      retainedMessages: count.count,
      addedMessages: 0,
      changed: false,
      sourceBytes: 0,
      deferredSessions: 0,
    };
  }
  const rememberSource = (result: GrokHistorySyncResult) => {
    if (deferredSessions || skippedSessions) return;
    // A live terminal may write while we read. Never mark a mixed capture as current:
    // the next send must import again if any source changed during this pass.
    try {
      if (sourceFingerprint(homes, project.path) !== fingerprint) return;
      if (
        cache?.version === sourceCacheVersion &&
        cache.fingerprint === fingerprint &&
        cache.result.conversationId === result.conversationId
      )
        return;
      store.save('grok-source-cache', projectId, projectId, {
        version: sourceCacheVersion,
        fingerprint,
        result: { ...result, addedMessages: 0, changed: false },
      } satisfies SourceCache);
    } catch {
      // A disappearing/partially written source must be retried, not cached.
    }
  };
  const warnings: string[] = [];
  let sourceBytes = 0,
    deferredSessions = 0,
    skippedSessions = 0;
  const snapshots: {
    id: string;
    old?: ImportRecord;
    sessionId: string;
    source: string;
    files: Record<string, string>;
    fingerprint: string;
    bytes: number;
    sizes: Record<string, number>;
    excluded?: boolean;
    captured?: { archive: string; hashes: Record<string, string> };
    created: string;
    updated: string;
  }[] = [];
  // Sessions PugPort started itself are already in the conversation as its own messages (with the
  // wrapped prompt and retrieved context). Importing them again would duplicate them and feed the
  // injected context back into later retrieval. Earlier imports stay untouched.
  const ownSessions = new Set(
    (
      (store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='runs'").get()
        ? store.db
            .prepare(
              "SELECT json_extract(value,'$.nativeSessionId') AS id FROM runs WHERE json_extract(value,'$.nativeSessionId') IS NOT NULL",
            )
            .all()
        : []) as { id: unknown }[]
    )
      .map((row) => (typeof row.id === 'string' ? row.id.toLowerCase() : ''))
      .filter(Boolean),
  );
  for (const row of store.db.prepare("SELECT id FROM workspace_records WHERE kind='native-session-exclusion'").all())
    ownSessions.add(String(row.id).toLowerCase());
  for (const home of new Map(homes.map((value) => [normalized(value), resolve(value)])).values()) {
    const source = join(home, 'sessions', encodeURIComponent(project.path));
    if (!existsSync(source)) continue;
    if (lstatSync(source).isSymbolicLink() || !lstatSync(source).isDirectory()) throw Error('不支持链接的会话目录。');
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw Error('不支持链接的会话。');
      if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/i.test(entry.name)) continue;
      const folder = join(source, entry.name);
      if (
        ownSessions.has(entry.name.toLowerCase()) &&
        !imports.some((row) => normalized(row.value.source) === normalized(folder))
      )
        continue;
      if (entry.isSymbolicLink() || lstatSync(folder).isSymbolicLink()) throw Error('不支持链接的会话。');
      let captured: ReturnType<typeof inventory>;
      try {
        captured = inventory(folder);
      } catch (error) {
        skippedSessions++;
        const reason =
          error instanceof Error && ['oversized-file', 'oversized-session'].includes(error.message)
            ? error.message
            : 'unreadable-session';
        warnings.push('Grok session skipped: ' + reason);
        continue;
      }
      const { files, sizes, bytes, fingerprint: sessionFingerprint } = captured;
      const old = imports.find((row) => normalized(row.value.source) === normalized(folder));
      snapshots.push({
        id: old?.id ?? hash(home + '\0' + entry.name),
        old: old?.value,
        sessionId: entry.name,
        source: folder,
        files,
        sizes,
        bytes,
        fingerprint: sessionFingerprint,
        created: old?.value.createdAt ?? now,
        updated: old?.value.updatedAt ?? now,
      });
    }
  }
  if (!snapshots.length && !skippedSessions) throw Error('这个项目没有可读取的 Grok 原生会话。');
  if (!snapshots.length)
    return {
      conversationId: existingTarget?.id ?? '',
      sessions: 0,
      addedMessages: 0,
      retainedMessages: oldArchive?.messages ?? 0,
      incompleteLines: 0,
      changed: false,
      warnings,
      skippedSessions,
      deferredSessions,
      sourceBytes,
    };
  const deferred = new Set(store.get<{ ids: string[] }>('grok-deferred-sessions', projectId)?.ids ?? []);
  const nextDeferred: string[] = [];
  snapshots.sort(
    (a, b) =>
      Number(deferred.has(b.id)) - Number(deferred.has(a.id)) ||
      a.created.localeCompare(b.created) ||
      a.id.localeCompare(b.id),
  );
  // Capture immutable bytes before touching the existing projection. Only paths and hashes survive this loop.
  for (const snapshot of snapshots) {
    if (!options.force && snapshot.old?.fingerprint === snapshot.fingerprint) continue;
    if (sourceBytes + snapshot.bytes > grokSyncByteBudget) {
      deferredSessions++;
      nextDeferred.push(snapshot.id);
      warnings.push('Grok session deferred: pass-byte-budget');
      continue;
    }
    sourceBytes += snapshot.bytes;
    const capturedArchive = join(dataDir, 'imports', 'grok', stamp, snapshot.id);
    const files: Record<string, string> = {};
    for (const [name, source] of Object.entries(snapshot.files)) {
      const destination = join(capturedArchive, name);
      files[name] = archiveFile(source, destination, snapshot.sizes[name]!);
      snapshot.files[name] = destination;
    }
    // Validate the immutable summary actually captured, never a different live revision.
    try {
      const summary = JSON.parse(
        readSafe(capturedArchive, join(capturedArchive, 'summary.json'), true)!.toString('utf8'),
      );
      if (typeof summary?.info?.cwd !== 'string' || normalized(summary.info.cwd) !== normalized(project.path))
        throw Error('scope');
      snapshot.created = iso(summary.created_at, now);
      snapshot.updated = iso(summary.updated_at, snapshot.created);
      snapshot.captured = { archive: capturedArchive, hashes: files };
    } catch {
      snapshot.excluded = true;
      skippedSessions++;
      warnings.push('Grok session skipped: invalid-summary');
      removeCapture(capturedArchive, files);
    }
  }
  snapshots.sort((a, b) => a.created.localeCompare(b.created) || a.id.localeCompare(b.id));
  const all = new Map<string, ConversationMessage>();
  // Retain PugPort messages and completed workflows; never rewrite native logs or remove old history.
  for (const id of new Set([target.id, ...imports.map((row) => row.value.conversationId)]))
    for (const message of store.allMessages(id)) all.set(message.id, structuredClone(message));
  let changed = snapshots.some((snapshot) => snapshot.captured) && !existingTarget?.grokHistory,
    addedMessages = 0,
    incompleteLines = 0;
  const refreshedImports: { id: string; value: ImportRecord }[] = [];
  let latest: GrokHistoryArchive['continuation'] = oldArchive?.continuation;
  for (const snapshot of snapshots) {
    if (!options.force && snapshot.old?.fingerprint === snapshot.fingerprint) {
      refreshedImports.push({ id: snapshot.id, value: { ...snapshot.old, conversationId: target.id } });
      continue;
    }
    if (!snapshot.captured) continue;
    const { archive: capturedArchive, hashes: files } = snapshot.captured;
    let stable = false;
    try {
      stable = inventory(snapshot.source).fingerprint === snapshot.fingerprint;
    } catch {
      /* Retry changed live sources. */
    }
    const parsed = grokHistoryMessages(grokFileLines(snapshot.files['chat_history.jsonl']!), {
      updates: snapshot.files['updates.jsonl'] ? grokFileLines(snapshot.files['updates.jsonl']) : undefined,
      sessionCreatedAt: snapshot.created,
      sessionUpdatedAt: snapshot.updated,
    });
    incompleteLines += parsed.incompleteLines + parsed.incompleteUpdateLines;
    if (parsed.incompleteLines || parsed.incompleteUpdateLines)
      warnings.push('检测到尚未写完的记录行，已跳过；下次同步继续读取。');
    const candidates = [...all.values()].filter(
      (
        m,
      ): m is ConversationMessage & {
        importedFrom: Extract<NonNullable<ConversationMessage['importedFrom']>, { provider: 'grok' }>;
      } => m.importedFrom?.provider === 'grok' && m.importedFrom.sessionId === snapshot.sessionId,
    );
    const candidatesNeedMigration = () => candidates.some((m) => !m.importedFrom.sourceKey);
    // The original archives disambiguate line-based legacy IDs before matching a compacted native suffix.
    if (
      snapshot.old?.archive &&
      existsSync(snapshot.old.archive) &&
      inside(resolve(dataDir, 'imports'), resolve(snapshot.old.archive))
    ) {
      const legacyChat = checkedSource(snapshot.old.archive, join(snapshot.old.archive, 'chat_history.jsonl'));
      const legacyUpdates = checkedSource(snapshot.old.archive, join(snapshot.old.archive, 'updates.jsonl'));
      if (legacyChat && candidatesNeedMigration()) {
        const legacy = grokHistoryMessages(grokFileLines(legacyChat), {
          updates: legacyUpdates ? grokFileLines(legacyUpdates) : undefined,
          sessionCreatedAt: snapshot.created,
        });
        for (const old of legacy.messages) {
          const message = all.get('grok-' + hash(snapshot.id + ':' + old.line));
          if (
            !message ||
            message.content !== old.content ||
            message.role !== old.role ||
            (message.importedFrom?.provider === 'grok' && message.importedFrom.sourceKey)
          )
            continue;
          const before = JSON.stringify(message);
          message.importedFrom = {
            provider: 'grok',
            sessionId: snapshot.sessionId,
            line: old.line,
            timestampKind: old.timestampKind ?? 'unknown',
            sourceKey: old.sourceKey,
            contentHash: old.contentHash,
            occurrence: old.occurrence,
          };
          if (old.timestampKind === 'exact' && old.createdAt) message.createdAt = old.createdAt;
          changed ||= before !== JSON.stringify(message);
        }
      }
    }
    const used = new Set<string>();
    for (const item of parsed.messages) {
      const contentHash = grokMessageContentHash(item.role, item.content);
      const matches = candidates.filter(
        (m) => !used.has(m.id) && grokMessageContentHash(m.role, m.content) === contentHash,
      );
      const exact = matches.find((m) => item.timestampKind === 'exact' && item.createdAt === m.createdAt);
      const fallback =
        matches.find(
          (m) =>
            !(item.timestampKind === 'exact' && m.importedFrom?.timestampKind === 'exact') &&
            m.importedFrom?.sourceKey === item.sourceKey,
        ) ?? matches.find((m) => !(item.timestampKind === 'exact' && m.importedFrom?.timestampKind === 'exact'));
      const match = exact ?? fallback;
      if (match) {
        used.add(match.id);
        const before = JSON.stringify(match);
        if (item.timestampKind === 'exact' && item.createdAt) {
          match.createdAt = item.createdAt;
          match.importedFrom = { ...match.importedFrom!, timestampKind: 'exact' };
        }
        match.conversationId = target.id;
        changed ||= before !== JSON.stringify(match);
        continue;
      }
      const id =
        'grok-sync-' +
        hash(snapshot.id + ':' + item.sourceKey + ':' + (item.timestampKind === 'exact' ? item.createdAt : ''));
      if (all.has(id)) {
        used.add(id);
        continue;
      }
      // Never invent per-line wall-clock timestamps when the source has no observed event.
      const createdAt = item.createdAt ?? snapshot.updated;
      all.set(id, {
        id,
        conversationId: target.id,
        role: item.role,
        content: item.content,
        createdAt,
        importedFrom: {
          provider: 'grok',
          sessionId: snapshot.sessionId,
          line: item.line,
          timestampKind: item.timestampKind ?? 'fallback',
          sourceKey: item.sourceKey,
          contentHash,
          occurrence: item.occurrence,
        },
      });
      addedMessages++;
      changed = true;
    }
    const newArchive =
      !snapshot.old ||
      Object.keys(files).length !== Object.keys(snapshot.old.files ?? {}).length ||
      Object.entries(files).some(([name, digest]) => snapshot.old!.files?.[name] !== digest);
    changed ||= newArchive;
    const archive = newArchive ? capturedArchive : snapshot.old!.archive;
    if (!newArchive) removeCapture(capturedArchive, files);
    refreshedImports.push({
      id: snapshot.id,
      value: {
        conversationId: target.id,
        sessionId: snapshot.sessionId,
        source: snapshot.source,
        archive,
        importedAt: newArchive ? now : snapshot.old!.importedAt,
        files,
        fingerprint: stable ? snapshot.fingerprint : undefined,
        createdAt: snapshot.created,
        updatedAt: snapshot.updated,
      },
    });
    if (!latest || snapshot.updated >= latest.updatedAt)
      latest = {
        sessionId: snapshot.sessionId,
        updatedAt: snapshot.updated,
        lastUserRequest: parsed.messages
          .filter((m) => m.role === 'user')
          .at(-1)
          ?.content.slice(-6000),
        lastAssistantResponse: parsed.messages
          .filter((m) => m.role === 'assistant' && !m.content.startsWith('工具结果'))
          .at(-1)
          ?.content.slice(-6000),
        ...(snapshot.files['plan.json'] ? { planPath: join(archive, 'plan.json') } : {}),
      };
  }
  const sorted = [...all.values()].sort(
    (a, b) =>
      a.createdAt.localeCompare(b.createdAt) ||
      (a.importedFrom?.provider === 'grok' && b.importedFrom?.provider === 'grok'
        ? a.importedFrom.sessionId.localeCompare(b.importedFrom.sessionId) || a.importedFrom.line - b.importedFrom.line
        : 0),
  );
  const result = {
    conversationId: target.id,
    sessions: snapshots.filter((snapshot) => !snapshot.excluded).length,
    addedMessages,
    retainedMessages: sorted.length,
    incompleteLines,
    changed,
    warnings: [...new Set(warnings)],
    sourceBytes,
    deferredSessions,
    skippedSessions,
  };
  if (!changed) {
    store.save('grok-deferred-sessions', projectId, projectId, { ids: nextDeferred });
    for (const row of refreshedImports) store.save('grok-import', row.id, projectId, row.value);
    rememberSource(result);
    return result;
  }
  mkdirSync(join(dataDir, 'backups'), { recursive: true });
  const backup = join(dataDir, 'backups', 'before-grok-sync-' + stamp + '.sqlite');
  // Back up only records this sync can replace; unrelated chats, runs and audit bodies never enter the copy.
  store.db.exec("ATTACH DATABASE ':memory:' AS grok_backup");
  try {
    store.db
      .prepare(
        `CREATE TABLE grok_backup.workspace_records AS
         SELECT record.* FROM workspace_records record WHERE (
           (kind='conversation' AND id IN (SELECT value FROM json_each(?))) OR
           (kind='message' AND owner IN (SELECT value FROM json_each(?))) OR
           (kind='grok-import' AND id IN (SELECT value FROM json_each(?))) OR
           (kind IN ('history-archive','grok-deferred-sessions','grok-source-cache') AND id=?)
         ) AND NOT EXISTS (
           SELECT 1 FROM workspace_records chat WHERE chat.kind='conversation'
           AND json_extract(chat.value,'$.incognito')=1
           AND chat.id IN (record.id, record.owner, json_extract(record.value,'$.conversationId'),
             json_extract(record.value,'$.result.conversationId'))
         )`,
      )
      .run(
        JSON.stringify([...new Set([target.id, ...importIds])]),
        JSON.stringify([...new Set([target.id, ...importIds])]),
        JSON.stringify(refreshedImports.map((row) => row.id)),
        projectId,
      );
    store.db.exec("VACUUM grok_backup INTO '" + backup.replaceAll("'", "''") + "'");
  } finally {
    store.db.exec('DETACH DATABASE grok_backup');
  }
  const history = join(dataDir, 'history', projectId, 'grok-history-' + stamp + '.jsonl');
  mkdirSync(dirname(history), { recursive: true });
  const historyFd = openSync(history, 'wx');
  try {
    for (const message of sorted)
      writeFileSync(historyFd, JSON.stringify({ ...message, conversationId: target.id }) + '\n');
  } finally {
    closeSync(historyFd);
  }
  const archive: GrokHistoryArchive = {
    path: history,
    messages: sorted.length,
    createdAt: now,
    conversationId: target.id,
    continuation: latest,
    sourceArchives: [
      ...new Set([...imports.map((row) => row.value.archive), ...refreshedImports.map((row) => row.value.archive)]),
    ],
  };
  store.transaction(() => {
    // The main app can delete or rename a conversation while this worker parses
    // large native logs. Check again under the write transaction, not just at entry.
    const currentArchive = store.get<GrokHistoryArchive>('history-archive', projectId);
    for (const id of new Set([target.id, oldArchive?.conversationId, currentArchive?.conversationId]))
      if (
        id &&
        (store.get<Conversation>('conversation', id)?.deletedAt || (id !== target.id && !store.get('conversation', id)))
      )
        throw Error('合并历史已被删除；本次同步未写入，不会自动恢复这个对话。');
    const currentTarget = store.get<Conversation>('conversation', target.id);
    if (existingTarget && !currentTarget) throw Error('合并历史已被移除；本次同步未写入。');
    if (currentTarget) Object.assign(target, currentTarget);
    if (
      store.db
        .prepare(
          "SELECT 1 FROM workspace_records WHERE kind='workflow' AND json_extract(value,'$.projectId')=? AND json_extract(value,'$.status') IN ('queued','waiting-resource','planning','running','waiting-approval','waiting-confirmation') LIMIT 1",
        )
        .get(projectId)
    )
      throw Error('项目中开始了新任务，本次同步未写入，请任务结束后重试。');
    for (const message of sorted) {
      message.conversationId = target.id;
      store.save('message', message.id, target.id, message);
    }
    target.updatedAt = now;
    target.grokHistory = {
      syncedAt: now,
      sessions: snapshots.filter((snapshot) => !snapshot.excluded).length,
      messages: sorted.length,
    };
    store.save('conversation', target.id, projectId, target);
    for (const row of refreshedImports) store.save('grok-import', row.id, projectId, row.value);
    for (const id of importIds)
      if (id !== target.id) {
        const old = store.get<Conversation>('conversation', id);
        // Only old import-only shells are hidden; conversations with workflows remain visible and intact.
        if (
          old &&
          !store.db.prepare("SELECT 1 FROM workspace_records WHERE kind='workflow' AND owner=? LIMIT 1").get(id)
        ) {
          old.deletedAt = now;
          store.save('conversation', id, projectId, old);
        }
      }
    store.save('history-archive', projectId, projectId, archive);
    store.save('grok-deferred-sessions', projectId, projectId, { ids: nextDeferred });
  });
  rememberSource(result);
  return result;
}

export function syncGrokHistory(...args: Parameters<typeof syncGrokHistoryNow>): GrokHistorySyncResult {
  const end = isMainThread ? track('grok-history-sync') : () => {};
  try {
    return syncGrokHistoryNow(...args);
  } finally {
    end();
  }
}
