import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Conversation, ConversationMessage, Project, Workflow } from '../src/shared/types.ts';
import { syncGrokHistory, type GrokHistoryArchive } from '../src/server/grok-history-sync.ts';
import { WorkspaceStore } from '../src/server/workspace-store.ts';
import { Attachments } from '../src/server/attachments.ts';
import { deleteIncognito } from '../src/server/incognito.ts';

const sessionA = '11111111-1111-4111-8111-111111111111';
const sessionB = '22222222-2222-4222-8222-222222222222';
const syncAt = '2026-09-29T18:00:00.000Z';
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
type NativeMessage = { role: 'user' | 'assistant'; content: string; at: string };
type CapturedImport = {
  conversationId: string;
  sessionId: string;
  source: string;
  archive: string;
  importedAt: string;
  files: Record<string, string>;
};

function nativeFiles(projectPath: string, messages: NativeMessage[], createdAt?: string, updatedAt?: string) {
  const summary = {
    info: { cwd: projectPath },
    generated_title: 'Synthetic native task',
    created_at: createdAt ?? messages[0]!.at,
    updated_at: updatedAt ?? messages.at(-1)!.at,
  };
  const history = messages.map((message) => JSON.stringify({ type: message.role, content: message.content }));
  const updates = messages.flatMap((message) => {
    const timestamp = Date.parse(message.at) / 1000;
    const records = [
      {
        method: 'session/update',
        timestamp,
        params: {
          update: {
            sessionUpdate: message.role === 'user' ? 'user_message_chunk' : 'agent_message_chunk',
            content: { type: 'text', text: message.content },
          },
        },
      },
    ];
    return message.role === 'assistant'
      ? [...records, { method: 'session/update', timestamp, params: { update: { sessionUpdate: 'turn_completed' } } }]
      : records;
  });
  return {
    'summary.json': JSON.stringify(summary),
    'chat_history.jsonl': history.join('\n') + '\n',
    'updates.jsonl': updates.map((record) => JSON.stringify(record)).join('\n') + '\n',
  };
}

function writeFiles(directory: string, files: Record<string, string>) {
  mkdirSync(directory, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(directory, name), content);
}

function treeHashes(directory: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!existsSync(directory)) return result;
  function visit(path: string) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isSymbolicLink()) result[relative(directory, child)] = 'symbolic-link';
      else if (entry.isDirectory()) visit(child);
      else result[relative(directory, child)] = hash(readFileSync(child));
    }
  }
  visit(directory);
  return result;
}

function records(store: WorkspaceStore) {
  return store.db.prepare('SELECT kind,id,owner,updated_at,value FROM workspace_records ORDER BY kind,id').all();
}

function fixture(t: TestContext) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'comborunner-grok-sync-test-')));
  const projectPath = join(root, 'synthetic project'),
    dataDir = join(root, 'synthetic-state'),
    grokHome = join(root, 'synthetic-grok-home');
  mkdirSync(projectPath);
  mkdirSync(dataDir);
  const sourceRoot = join(grokHome, 'sessions', encodeURIComponent(projectPath));
  mkdirSync(sourceRoot, { recursive: true });
  const db = new DatabaseSync(join(dataDir, 'studio.sqlite'));
  db.exec('CREATE TABLE runs(id TEXT PRIMARY KEY,value TEXT)');
  const store = new WorkspaceStore(db);
  const project: Project = {
    id: 'synthetic-project',
    name: 'Synthetic project',
    path: realpathSync.native(projectPath),
    createdAt: '2026-09-01T08:00:00.000Z',
    updatedAt: '2026-09-01T08:00:00.000Z',
  };
  store.save('project', project.id, project.id, project);
  t.after(() => {
    db.close();
    const cleanup = resolve(root);
    assert.ok(
      cleanup.startsWith(realpathSync.native(tmpdir()) + sep) &&
        basename(cleanup).startsWith('comborunner-grok-sync-test-'),
      'cleanup stays inside the unique synthetic temporary workspace',
    );
    rmSync(cleanup, { recursive: true, force: true });
  });
  return {
    root,
    dataDir,
    grokHome,
    sourceRoot,
    project,
    store,
    session(id: string, messages: NativeMessage[], createdAt?: string, updatedAt?: string) {
      const source = join(sourceRoot, id),
        files = nativeFiles(project.path, messages, createdAt, updatedAt);
      writeFiles(source, files);
      return { source, files };
    },
    sync(now = syncAt) {
      return syncGrokHistory(store, dataDir, project.id, { grokHomes: [grokHome], now });
    },
  };
}

test('Grok history sync rejects removed projects without changing records', (t) => {
  const f = fixture(t);
  f.store.save('project', f.project.id, f.project.id, { ...f.project, removedAt: syncAt });
  const before = records(f.store);
  assert.throws(() => f.sync(), /请选择已有本地项目/);
  assert.deepEqual(records(f.store), before);
});

test('syncing B while A is incognito backs up only replaced Grok records, with no private text after A closes', async (t) => {
  const f = fixture(t);
  f.session(sessionA, [{ role: 'user', content: 'SYNTHETIC_GROK_BEFORE', at: syncAt }]);
  const first = f.sync();
  const before = records(f.store);
  const other = { ...f.project, id: 'private-project', name: 'Synthetic A' };
  f.store.save('project', other.id, other.id, other);
  const chat = { ...conversation(other, randomUUID(), syncAt), incognito: true, memory: 'off' as const };
  f.store.save('conversation', chat.id, other.id, chat);
  const message = f.store.addMessage(chat.id, 'user', 'SYNTHETIC_PRIVATE_MESSAGE');
  const flow = workflow(other, chat.id, 'completed');
  flow.runIds = ['private-run'];
  f.store.save('workflow', flow.id, chat.id, flow);
  f.store.save('worklog', flow.id, other.id, { summary: 'SYNTHETIC_PRIVATE_WORKLOG' });
  f.store.db.exec(
    'CREATE TABLE run_audit_events(run_id TEXT,seq INTEGER,value TEXT); CREATE TABLE task_judgments(workflow_id TEXT,value TEXT)',
  );
  f.store.db
    .prepare('INSERT INTO runs VALUES(?,?)')
    .run('private-run', JSON.stringify({ workflowId: flow.id, prompt: 'SYNTHETIC_PRIVATE_RUN' }));
  f.store.db.prepare('INSERT INTO run_audit_events VALUES(?,?,?)').run('private-run', 1, 'SYNTHETIC_PRIVATE_AUDIT');
  f.store.db.prepare('INSERT INTO task_judgments VALUES(?,?)').run(flow.id, 'SYNTHETIC_PRIVATE_JUDGMENT');
  f.session(sessionA, [{ role: 'user', content: 'SYNTHETIC_GROK_AFTER', at: syncAt }]);
  assert.equal(f.sync().changed, true);
  await deleteIncognito(f.store, new Attachments(f.dataDir, f.store), chat.id);
  assert.equal(f.store.get('conversation', chat.id), undefined);
  assert.equal(f.store.get('message', message.id), undefined);
  const backups = readdirSync(join(f.dataDir, 'backups')).filter((name) => name.endsWith('.sqlite'));
  assert.equal(backups.length, 2);
  let restored = false;
  for (const name of backups) {
    const path = join(f.dataDir, 'backups', name);
    assert.equal(readFileSync(path).includes(Buffer.from('SYNTHETIC_PRIVATE_')), false);
    const saved = new DatabaseSync(path, { readOnly: true });
    try {
      const rows = saved.prepare('SELECT kind,id,owner,updated_at,value FROM workspace_records ORDER BY kind,id').all();
      assert.doesNotMatch(JSON.stringify(rows), /SYNTHETIC_PRIVATE_/);
      assert.deepEqual(
        saved
          .prepare("SELECT name FROM sqlite_master WHERE type='table'")
          .all()
          .map((row) => row.name),
        ['workspace_records'],
      );
      if (rows.length) {
        assert.deepEqual(
          rows,
          before.filter((row) => row.kind !== 'project' && row.kind !== 'migration'),
        );
        assert.ok(rows.some((row) => row.kind === 'conversation' && row.id === first.conversationId));
        assert.match(JSON.stringify(rows), /SYNTHETIC_GROK_BEFORE/);
        restored = true;
      }
    } finally {
      saved.close();
    }
  }
  assert.equal(restored, true, 'the replaced Grok projection remains recoverable');
});

test('backup excludes incognito-owned rows even inside the replaced import projection', (t) => {
  const f = fixture(t);
  f.session(sessionA, [{ role: 'user', content: 'SYNTHETIC_PRIVATE_OLD_IMPORT', at: syncAt }]);
  const first = f.sync();
  const chat = f.store.get<Conversation>('conversation', first.conversationId)!;
  f.store.save('conversation', chat.id, f.project.id, { ...chat, incognito: true, memory: 'off' });
  f.store.addMessage(chat.id, 'user', 'SYNTHETIC_PRIVATE_LOCAL_MESSAGE');
  f.session(sessionA, [{ role: 'user', content: 'Synthetic updated import', at: syncAt }]);
  assert.equal(f.sync().changed, true);
  const backups = readdirSync(join(f.dataDir, 'backups')).filter((name) => name.endsWith('.sqlite'));
  assert.equal(backups.length, 2);
  for (const name of backups) {
    const path = join(f.dataDir, 'backups', name);
    assert.equal(readFileSync(path).includes(Buffer.from('SYNTHETIC_PRIVATE_')), false);
    const saved = new DatabaseSync(path, { readOnly: true });
    try {
      const rows = saved.prepare('SELECT kind FROM workspace_records').all();
      assert.ok(rows.every((row) => row.kind === 'grok-deferred-sessions'));
    } finally {
      saved.close();
    }
  }
});

test('closed incognito native sessions stay excluded across SQLite connections and memory search', async (t) => {
  const f = fixture(t);
  f.store.db.exec('CREATE TABLE run_audit_events(run_id TEXT,seq INTEGER,value TEXT)');
  const privateChat = { ...conversation(f.project, randomUUID(), syncAt), incognito: true, closedAt: syncAt };
  f.store.save('conversation', privateChat.id, f.project.id, privateChat);
  const flow = workflow(f.project, privateChat.id, 'completed');
  flow.runIds = ['private-run'];
  f.store.save('workflow', flow.id, privateChat.id, flow);
  const nativeId = 'ABCDEFAB-1234-4123-8123-ABCDEFABCDEF';
  // Also cover a run missing from workflow.runIds, which the purge still deletes by workflowId.
  for (const id of ['private-run', 'unlisted-run'])
    f.store.db
      .prepare('INSERT INTO runs(id,value) VALUES(?,?)')
      .run(id, JSON.stringify({ workflowId: flow.id, nativeSessionId: nativeId }));
  f.session(nativeId, [
    { role: 'user', content: 'PRIVATE_INCOGNITO_SYNTHETIC', at: syncAt },
    { role: 'assistant', content: 'PRIVATE_INCOGNITO_REPLY', at: syncAt },
  ]);
  assert.throws(() => f.sync(), /没有可读取/);
  await deleteIncognito(f.store, new Attachments(f.dataDir, f.store), privateChat.id);
  assert.equal(f.store.get('conversation', privateChat.id), undefined);
  assert.equal(f.store.db.prepare('SELECT count(*) AS count FROM runs').get()!.count, 0);
  const marker = f.store.db
    .prepare("SELECT id,owner,updated_at,value FROM workspace_records WHERE kind='native-session-exclusion'")
    .all();
  assert.deepEqual(
    marker.map((row) => ({ ...row })),
    [{ id: nativeId.toLowerCase(), owner: 'native-session-exclusions', updated_at: '', value: '{}' }],
  );
  const db = new DatabaseSync(f.store.db.location()!);
  try {
    const workerStore = new WorkspaceStore(db, { initialize: false });
    assert.throws(
      () => syncGrokHistory(workerStore, f.dataDir, f.project.id, { grokHomes: [f.grokHome] }),
      /没有可读取/,
    );
  } finally {
    db.close();
  }
  assert.equal(f.store.list('grok-import').length, 0);
  const reader = conversation(f.project, randomUUID(), syncAt);
  f.store.save('conversation', reader.id, f.project.id, reader);
  const anchor = f.store.addMessage(reader.id, 'user', 'PRIVATE_INCOGNITO_SYNTHETIC');
  assert.deepEqual(f.store.searchMemory(f.project.id, reader.id, anchor.id, ['PRIVATE_INCOGNITO_SYNTHETIC']), []);
});

function conversation(project: Project, id: string, createdAt: string): Conversation {
  return { id, projectId: project.id, title: 'Synthetic imported conversation', createdAt, updatedAt: createdAt };
}

function workflow(project: Project, conversationId: string, status: Workflow['status']): Workflow {
  return {
    id: 'synthetic-workflow',
    projectId: project.id,
    conversationId,
    userMessageId: 'synthetic-comborunner-user',
    input: {
      content: 'Synthetic PugPort task',
      mode: 'chat',
      permissionMode: 'read-only',
      executionPolicy: 'cli-only',
    },
    status,
    phase: status === 'completed' ? 'summarize' : 'queue',
    plan: [],
    runIds: status === 'completed' ? ['synthetic-run'] : [],
    memoryRevision: 0,
    memoryExcerpt: 'Synthetic original task context',
    createdAt: '2026-09-20T12:00:00.000Z',
    updatedAt: '2026-09-20T12:01:00.000Z',
  };
}

test('first sync merges native sessions in observed chronological order and archives source bytes locally', (t) => {
  const f = fixture(t);
  const first: NativeMessage[] = [
    { role: 'user', content: 'Synthetic A request', at: '2026-09-01T09:05:00.000Z' },
    { role: 'assistant', content: 'Synthetic A late response', at: '2026-09-01T11:10:00.000Z' },
  ];
  const second: NativeMessage[] = [
    { role: 'user', content: 'Synthetic B request', at: '2026-09-01T10:05:00.000Z' },
    { role: 'assistant', content: 'Synthetic B response', at: '2026-09-01T10:08:00.000Z' },
  ];
  f.session(sessionA, first, '2026-09-01T09:00:00.000Z', '2026-09-01T11:15:00.000Z');
  f.session(sessionB, second, '2026-09-01T10:00:00.000Z', '2026-09-01T10:10:00.000Z');
  writeFileSync(join(f.sourceRoot, sessionA, 'plan.json'), '{"steps":["synthetic pending verification"]}');
  const sourceBefore = treeHashes(f.grokHome);
  const result = f.sync();
  assert.equal(result.changed, true);
  assert.equal(result.sessions, 2);
  assert.equal(result.addedMessages, 4);
  assert.equal(result.retainedMessages, 4);
  assert.equal(result.incompleteLines, 0);
  assert.equal(f.store.conversations(f.project.id).length, 1);
  const expected = [first[0]!, ...second, first[1]!];
  const messages = f.store.allMessages(result.conversationId);
  assert.deepEqual(
    messages.map((message) => message.content),
    expected.map((message) => message.content),
  );
  assert.deepEqual(
    messages.map((message) => message.createdAt),
    expected.map((message) => message.at),
  );
  assert.ok(
    messages.every(
      (message) => message.importedFrom?.provider === 'grok' && message.importedFrom.timestampKind === 'exact',
    ),
  );
  const imports = f.store.list<CapturedImport>('grok-import', f.project.id);
  assert.equal(imports.length, 2);
  for (const imported of imports) {
    assert.equal(imported.conversationId, result.conversationId);
    assert.ok(relative(f.dataDir, imported.archive).startsWith('imports' + sep));
    for (const [name, digest] of Object.entries(imported.files)) {
      const captured = readFileSync(join(imported.archive, name));
      assert.equal(hash(captured), digest);
      assert.deepEqual(captured, readFileSync(join(imported.source, name)));
    }
  }
  const archive = f.store.get<GrokHistoryArchive>('history-archive', f.project.id)!;
  assert.equal(archive.conversationId, result.conversationId);
  assert.equal(archive.messages, messages.length);
  assert.deepEqual(
    readFileSync(archive.path, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line)),
    messages,
  );
  assert.equal(archive.continuation?.sessionId, sessionA);
  assert.equal(archive.continuation?.lastUserRequest, first[0]!.content);
  assert.equal(archive.continuation?.lastAssistantResponse, first[1]!.content);
  assert.ok(archive.continuation?.planPath && existsSync(archive.continuation.planPath));
  assert.ok(readdirSync(join(f.dataDir, 'backups')).some((name) => name.endsWith('.sqlite')));
  assert.deepEqual(treeHashes(f.grokHome), sourceBefore, 'sync never rewrites native logs');
});

test('unchanged repeated sync is idempotent and creates no new records or archive files', (t) => {
  const f = fixture(t);
  f.session(sessionA, [
    { role: 'user', content: 'Synthetic request', at: '2026-09-01T09:00:00.000Z' },
    { role: 'assistant', content: 'Synthetic reply', at: '2026-09-01T09:01:00.000Z' },
  ]);
  const first = f.sync(),
    recordsBefore = records(f.store),
    filesBefore = treeHashes(f.dataDir),
    sourceBefore = treeHashes(f.grokHome);
  const repeated = f.sync('2026-09-29T19:00:00.000Z');
  assert.equal(repeated.conversationId, first.conversationId);
  assert.equal(repeated.changed, false);
  assert.equal(repeated.addedMessages, 0);
  assert.equal(repeated.retainedMessages, 2);
  assert.deepEqual(records(f.store), recordsBefore);
  assert.deepEqual(treeHashes(f.dataDir), filesBefore);
  assert.deepEqual(treeHashes(f.grokHome), sourceBefore);
});

test('unchanged native history uses metadata only and counts newer PugPort messages without parsing the full archive', (t) => {
  const f = fixture(t);
  f.session(sessionA, [
    { role: 'user', content: 'Synthetic request', at: '2026-09-01T09:00:00.000Z' },
    { role: 'assistant', content: 'Synthetic response', at: '2026-09-01T09:01:00.000Z' },
  ]);
  const initial = f.sync();
  f.store.save('message', 'later-comborunner-message', initial.conversationId, {
    id: 'later-comborunner-message',
    conversationId: initial.conversationId,
    role: 'assistant',
    content: 'New locally completed response',
    createdAt: '2026-09-02T09:00:00.000Z',
  });
  t.mock.method(f.store, 'allMessages', () => {
    assert.fail('unchanged native sources must not rebuild the entire message projection');
  });
  const repeated = f.sync();
  assert.equal(repeated.changed, false);
  assert.equal(repeated.retainedMessages, 3);
});

test('an older source cache version is reprojected once instead of reusing incompatible cached output', (t) => {
  const f = fixture(t);
  f.session(sessionA, [{ role: 'user', content: 'Synthetic request', at: '2026-09-01T09:00:00.000Z' }]);
  f.sync();
  const cache = f.store.get<{ version: number; fingerprint: string }>('grok-source-cache', f.project.id)!;
  f.store.save('grok-source-cache', f.project.id, f.project.id, { ...cache, version: cache.version - 1 });
  const original = f.store.allMessages.bind(f.store);
  const projection = t.mock.method(f.store, 'allMessages', original);
  const repeated = f.sync();
  assert.equal(repeated.changed, false);
  assert.ok(projection.mock.callCount() > 0);
  assert.equal(f.store.get<{ version: number }>('grok-source-cache', f.project.id)?.version, cache.version);
  projection.mock.restore();
  t.mock.method(f.store, 'allMessages', () => assert.fail('migrated cache should now skip full reprojection'));
  assert.equal(f.sync().changed, false);
});

test('changed plans and compaction segments invalidate metadata cache even when chat bytes stay the same', (t) => {
  const f = fixture(t);
  const native = f.session(sessionA, [{ role: 'user', content: 'Synthetic request', at: '2026-09-01T09:00:00.000Z' }]);
  f.sync();
  writeFileSync(join(native.source, 'plan.json'), '{"steps":["Check the existing output"]}');
  const plan = f.sync();
  assert.equal(plan.changed, true);
  assert.equal(plan.addedMessages, 0);
  assert.ok(f.store.get<GrokHistoryArchive>('history-archive', f.project.id)?.continuation?.planPath);
  writeFiles(join(native.source, 'compaction'), { 'recap.md': 'Synthetic durable recap' });
  assert.equal(f.sync().changed, true);
  rmSync(join(native.source, 'compaction', 'recap.md'));
  assert.equal(f.sync().changed, true, 'a removed relevant source file also produces a new immutable capture');
  assert.equal(f.sync().changed, false);
});

test('a terminal appending during capture is retried next sync instead of cached as already imported', (t) => {
  const f = fixture(t);
  const original: NativeMessage[] = [
    { role: 'user', content: 'Synthetic first request', at: '2026-09-01T09:00:00.000Z' },
  ];
  f.session(sessionA, original);
  f.sync();
  const allMessages = f.store.allMessages.bind(f.store);
  const mock = t.mock.method(f.store, 'allMessages', (conversationId: string) => {
    f.session(sessionA, [
      ...original,
      { role: 'assistant', content: 'Appended while snapshotting', at: '2026-09-01T09:01:00.000Z' },
    ]);
    return allMessages(conversationId);
  });
  const stale = syncGrokHistory(f.store, f.dataDir, f.project.id, { grokHomes: [f.grokHome], force: true });
  assert.equal(stale.addedMessages, 0);
  mock.mock.restore();
  const latest = f.sync();
  assert.equal(latest.addedMessages, 1);
  assert.ok(
    f.store.allMessages(latest.conversationId).some((message) => message.content === 'Appended while snapshotting'),
  );
});

test('background synchronization never resurrects a deleted merged conversation or discards its archive', (t) => {
  const f = fixture(t);
  f.session(sessionA, [
    { role: 'user', content: 'Synthetic retained request', at: '2026-09-01T09:00:00.000Z' },
    { role: 'assistant', content: 'Synthetic retained reply', at: '2026-09-01T09:01:00.000Z' },
  ]);
  const initial = f.sync();
  f.store.deleteConversation(initial.conversationId);
  const before = records(f.store),
    files = treeHashes(f.dataDir);
  assert.throws(() => f.sync(), /不会在后台自动恢复/);
  assert.deepEqual(records(f.store), before);
  assert.deepEqual(treeHashes(f.dataDir), files);
  assert.equal(f.store.conversations(f.project.id).length, 0);
  assert.equal(f.store.allMessages(initial.conversationId).length, 2);
});

test('deleting the merged conversation during capture prevents the final transaction from resurrecting it', (t) => {
  const f = fixture(t);
  const original: NativeMessage[] = [
    { role: 'user', content: 'Synthetic first request', at: '2026-09-01T09:00:00.000Z' },
  ];
  f.session(sessionA, original);
  const initial = f.sync();
  const archive = f.store.get<GrokHistoryArchive>('history-archive', f.project.id);
  f.session(sessionA, [
    ...original,
    { role: 'assistant', content: 'New native reply', at: '2026-09-01T09:01:00.000Z' },
  ]);
  const allMessages = f.store.allMessages.bind(f.store);
  const beforeMessages = allMessages(initial.conversationId);
  t.mock.method(f.store, 'allMessages', (id: string) => {
    f.store.deleteConversation(initial.conversationId);
    return allMessages(id);
  });
  assert.throws(() => f.sync(), /已被删除|不会自动恢复/);
  assert.ok(f.store.get<Conversation>('conversation', initial.conversationId)?.deletedAt);
  assert.equal(f.store.conversations(f.project.id).length, 0);
  assert.deepEqual(
    allMessages(initial.conversationId),
    beforeMessages,
    'the worker transaction did not insert new turns',
  );
  assert.deepEqual(f.store.get<GrokHistoryArchive>('history-archive', f.project.id), archive);
});

test('appended native turns and new sessions retain the same conversation and completed PugPort work', (t) => {
  const f = fixture(t);
  const original: NativeMessage[] = [
    { role: 'user', content: 'Synthetic first request', at: '2026-09-01T09:00:00.000Z' },
    { role: 'assistant', content: 'Synthetic first reply', at: '2026-09-01T09:01:00.000Z' },
  ];
  f.session(sessionA, original);
  const first = f.sync();
  const oldNative = f.store.allMessages(first.conversationId);
  const completed = workflow(f.project, first.conversationId, 'completed');
  const comboMessages: ConversationMessage[] = [
    {
      id: completed.userMessageId,
      conversationId: first.conversationId,
      role: 'user',
      content: 'Synthetic PugPort follow-up',
      createdAt: completed.createdAt,
      workflowId: completed.id,
    },
    {
      id: 'synthetic-comborunner-assistant',
      conversationId: first.conversationId,
      role: 'assistant',
      content: 'Synthetic completed PugPort result',
      createdAt: completed.updatedAt,
      workflowId: completed.id,
    },
  ];
  completed.finalMessageId = comboMessages[1]!.id;
  f.store.save('workflow', completed.id, first.conversationId, completed);
  for (const message of comboMessages) f.store.save('message', message.id, first.conversationId, message);
  const appended: NativeMessage[] = [
    ...original,
    { role: 'user', content: 'Synthetic appended request', at: '2026-09-21T09:00:00.000Z' },
    { role: 'assistant', content: 'Synthetic appended reply', at: '2026-09-21T09:01:00.000Z' },
  ];
  f.session(sessionA, appended);
  const newest: NativeMessage[] = [
    { role: 'user', content: 'Synthetic new session request', at: '2026-09-22T09:00:00.000Z' },
    { role: 'assistant', content: 'Synthetic new session reply', at: '2026-09-22T09:01:00.000Z' },
  ];
  f.session(sessionB, newest);
  const sourceBefore = treeHashes(f.grokHome);
  const updated = f.sync('2026-09-29T20:00:00.000Z');
  assert.equal(updated.conversationId, first.conversationId);
  assert.equal(updated.sessions, 2);
  assert.equal(updated.addedMessages, 4);
  assert.equal(updated.retainedMessages, 8);
  assert.equal(f.store.conversations(f.project.id).length, 1);
  assert.deepEqual(f.store.get('workflow', completed.id), completed);
  for (const message of [...oldNative, ...comboMessages]) assert.deepEqual(f.store.get('message', message.id), message);
  assert.deepEqual(
    f.store.allMessages(first.conversationId).map((message) => message.content),
    [
      ...original.map((message) => message.content),
      ...comboMessages.map((message) => message.content),
      ...appended.slice(2).map((message) => message.content),
      ...newest.map((message) => message.content),
    ],
  );
  assert.equal(f.store.get<GrokHistoryArchive>('history-archive', f.project.id)?.continuation?.sessionId, sessionB);
  assert.deepEqual(treeHashes(f.grokHome), sourceBefore);
});

test('equal observed timestamps preserve native message order rather than ordering by generated IDs', (t) => {
  const f = fixture(t);
  const messages: NativeMessage[] = Array.from({ length: 12 }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user',
    content: `Synthetic equal-time message ${index}`,
    at: '2026-09-01T09:00:00.000Z',
  }));
  f.session(sessionA, messages);
  const synced = f.sync();
  const stored = f.store.allMessages(synced.conversationId);
  assert.deepEqual(
    stored.map((message) => message.createdAt),
    messages.map((message) => message.at),
  );
  assert.deepEqual(
    stored.map((message) => message.content),
    messages.map((message) => message.content),
  );
});

test('legacy line-based IDs recover original timestamps from archived updates before compacted suffix matching', (t) => {
  const f = fixture(t);
  const original: NativeMessage[] = [
    { role: 'user', content: 'Synthetic repeated request', at: '2026-09-01T09:01:00.000Z' },
    { role: 'assistant', content: 'Synthetic earlier response', at: '2026-09-01T09:02:00.000Z' },
    { role: 'user', content: 'Synthetic repeated request', at: '2026-09-01T11:01:00.000Z' },
    { role: 'assistant', content: 'Synthetic later response', at: '2026-09-01T11:02:00.000Z' },
  ];
  const createdAt = '2026-09-01T09:00:00.000Z';
  const archivedFiles = nativeFiles(f.project.path, original, createdAt);
  const legacyArchive = join(f.dataDir, 'imports', 'grok', 'legacy', sessionA);
  writeFiles(legacyArchive, archivedFiles);
  const oldConversation = conversation(f.project, 'synthetic-legacy-conversation', createdAt);
  f.store.save('conversation', oldConversation.id, f.project.id, oldConversation);
  const importKey = hash(f.grokHome + '\0' + sessionA);
  const legacyIds = original.map((_, line) => 'grok-' + hash(importKey + ':' + line));
  for (const [line, message] of original.entries())
    f.store.save('message', legacyIds[line]!, oldConversation.id, {
      id: legacyIds[line],
      conversationId: oldConversation.id,
      role: message.role,
      content: message.content,
      createdAt: new Date(Date.parse(createdAt) + line).toISOString(),
      importedFrom: { provider: 'grok', sessionId: sessionA, line, timestampKind: 'session-start-plus-order' },
    });
  f.store.save('grok-import', importKey, f.project.id, {
    conversationId: oldConversation.id,
    sessionId: sessionA,
    source: join(f.sourceRoot, sessionA),
    archive: legacyArchive,
    importedAt: '2026-09-02T12:00:00.000Z',
    files: Object.fromEntries(Object.entries(archivedFiles).map(([name, bytes]) => [name, hash(bytes)])),
  });
  const fresh: NativeMessage[] = [
    { role: 'user', content: 'Synthetic task after compaction', at: '2026-09-01T12:01:00.000Z' },
    { role: 'assistant', content: 'Synthetic reply after compaction', at: '2026-09-01T12:02:00.000Z' },
  ];
  f.session(sessionA, [...original.slice(2), ...fresh], createdAt);
  const archivedBefore = treeHashes(legacyArchive),
    synced = f.sync();
  assert.equal(synced.conversationId, oldConversation.id);
  assert.equal(synced.addedMessages, fresh.length);
  assert.equal(synced.retainedMessages, original.length + fresh.length);
  const messages = f.store.allMessages(synced.conversationId);
  assert.deepEqual(
    messages.slice(0, original.length).map((message) => message.id),
    legacyIds,
  );
  assert.deepEqual(
    messages.map((message) => message.createdAt),
    [...original, ...fresh].map((message) => message.at),
  );
  assert.ok(
    messages.every(
      (message) => message.importedFrom?.provider === 'grok' && message.importedFrom.timestampKind === 'exact',
    ),
  );
  assert.deepEqual(treeHashes(legacyArchive), archivedBefore, 'migration retains the original archived source bytes');
});

test('native compaction rewrites retain prior imported messages and immutable raw snapshots', (t) => {
  const f = fixture(t);
  const original: NativeMessage[] = [
    { role: 'user', content: 'Synthetic early task', at: '2026-09-01T09:01:00.000Z' },
    { role: 'assistant', content: 'Synthetic early result', at: '2026-09-01T09:02:00.000Z' },
    { role: 'user', content: 'Synthetic later task', at: '2026-09-01T11:01:00.000Z' },
    { role: 'assistant', content: 'Synthetic later result', at: '2026-09-01T11:02:00.000Z' },
  ];
  const createdAt = '2026-09-01T09:00:00.000Z';
  f.session(sessionA, original, createdAt);
  const first = f.sync(),
    originalMessages = f.store.allMessages(first.conversationId),
    originalImport = f.store.list<CapturedImport>('grok-import', f.project.id)[0]!,
    originalArchive = treeHashes(originalImport.archive);
  const fresh: NativeMessage[] = [
    { role: 'user', content: 'Synthetic new compacted task', at: '2026-09-01T12:01:00.000Z' },
    { role: 'assistant', content: 'Synthetic new compacted result', at: '2026-09-01T12:02:00.000Z' },
  ];
  f.session(sessionA, [...original.slice(2), ...fresh], createdAt);
  const sourceBefore = treeHashes(f.grokHome),
    synced = f.sync('2026-09-29T21:00:00.000Z');
  assert.equal(synced.conversationId, first.conversationId);
  assert.equal(synced.addedMessages, 2);
  assert.equal(synced.retainedMessages, 6);
  for (const message of originalMessages) assert.deepEqual(f.store.get('message', message.id), message);
  assert.deepEqual(
    f.store.allMessages(first.conversationId).map((message) => message.content),
    [...original, ...fresh].map((message) => message.content),
  );
  assert.deepEqual(treeHashes(originalImport.archive), originalArchive);
  const updatedImport = f.store.list<CapturedImport>('grok-import', f.project.id)[0]!;
  assert.notEqual(updatedImport.archive, originalImport.archive);
  assert.deepEqual(
    readFileSync(join(updatedImport.archive, 'chat_history.jsonl')),
    readFileSync(join(updatedImport.source, 'chat_history.jsonl')),
  );
  assert.deepEqual(treeHashes(f.grokHome), sourceBefore);
  const repeated = f.sync('2026-09-29T22:00:00.000Z');
  assert.equal(repeated.changed, false);
  assert.equal(repeated.addedMessages, 0);
});

test('active or pending workflows reject history sync before writing any records or archives', async (t) => {
  for (const status of [
    'queued',
    'waiting-resource',
    'planning',
    'running',
    'waiting-approval',
    'waiting-confirmation',
  ] as const)
    await t.test(status, (child) => {
      const f = fixture(child);
      f.session(sessionA, [{ role: 'user', content: 'Synthetic pending native task', at: '2026-09-01T09:00:00.000Z' }]);
      const current = workflow(f.project, 'synthetic-active-conversation', status);
      f.store.save('workflow', current.id, current.conversationId, current);
      const recordsBefore = records(f.store),
        filesBefore = treeHashes(f.dataDir),
        sourceBefore = treeHashes(f.grokHome);
      assert.throws(() => f.sync(), /未结束|等待|取消/);
      assert.deepEqual(records(f.store), recordsBefore);
      assert.deepEqual(treeHashes(f.dataDir), filesBefore);
      assert.deepEqual(treeHashes(f.grokHome), sourceBefore);
      assert.equal(existsSync(join(f.dataDir, 'backups')), false);
    });
});

test('linked source directories are refused without importing or following them', async (t) => {
  await t.test('project session root', (child) => {
    const f = fixture(child);
    const linkedTarget = join(f.root, 'synthetic-linked-sessions');
    mkdirSync(linkedTarget);
    rmdirSync(f.sourceRoot);
    symlinkSync(linkedTarget, f.sourceRoot, process.platform === 'win32' ? 'junction' : 'dir');
    const before = records(f.store);
    assert.throws(() => f.sync(), /链接|link/i);
    assert.deepEqual(records(f.store), before);
    assert.equal(existsSync(join(f.dataDir, 'imports')), false);
  });
  await t.test('individual native session', (child) => {
    const f = fixture(child);
    f.session(sessionA, [{ role: 'user', content: 'Synthetic ordinary source', at: '2026-09-01T09:00:00.000Z' }]);
    const linked = f.session(sessionB, [
      { role: 'user', content: 'Synthetic linked source', at: '2026-09-01T10:00:00.000Z' },
    ]);
    const linkedTarget = join(f.root, 'synthetic-linked-session');
    renameSync(linked.source, linkedTarget);
    symlinkSync(linkedTarget, linked.source, process.platform === 'win32' ? 'junction' : 'dir');
    const before = records(f.store);
    assert.throws(() => f.sync(), /链接|link/i);
    assert.deepEqual(records(f.store), before);
    assert.equal(existsSync(join(f.dataDir, 'imports')), false);
    assert.equal(readFileSync(join(linkedTarget, 'chat_history.jsonl'), 'utf8'), linked.files['chat_history.jsonl']);
  });
});

test('sessions PugPort started itself are not re-imported as native history', (t) => {
  const f = fixture(t);
  f.session(sessionA, [
    { role: 'user', content: 'Typed in the Grok terminal', at: '2026-09-01T09:05:00.000Z' },
    { role: 'assistant', content: 'Terminal answer', at: '2026-09-01T09:06:00.000Z' },
  ]);
  f.session(sessionB, [
    { role: 'user', content: 'PugPort wrapped prompt with retrieved history', at: '2026-09-01T10:05:00.000Z' },
    { role: 'assistant', content: 'Answer already saved by PugPort', at: '2026-09-01T10:06:00.000Z' },
  ]);
  f.store.db
    .prepare('INSERT INTO runs(id, value) VALUES (?, ?)')
    .run('own-run', JSON.stringify({ id: 'own-run', nativeSessionId: sessionB.toUpperCase() }));
  const result = f.sync();
  assert.equal(result.sessions, 1);
  const contents = f.store.allMessages(result.conversationId).map((message) => message.content);
  assert.deepEqual(contents, ['Typed in the Grok terminal', 'Terminal answer']);
});

test('a permanently emptied merged conversation is treated as deleted and is not re-imported', (t) => {
  const f = fixture(t);
  f.session(randomUUID(), [{ role: 'user', content: 'Synthetic request', at: '2026-09-01T09:00:00.000Z' }]);
  const initial = f.sync();
  f.store.deleteConversation(initial.conversationId);
  f.store.db.prepare("DELETE FROM workspace_records WHERE kind='conversation' AND id=?").run(initial.conversationId);
  assert.throws(() => f.sync(), /不会在后台自动恢复/);
  assert.equal(f.store.conversations(f.project.id).length, 0);
});
