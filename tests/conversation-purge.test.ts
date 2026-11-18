import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { MediaAnalysisManager } from '../src/server/media-analysis.ts';
import type { MediaDecoder } from '../src/server/media-decoder.ts';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { ConversationPurger, removeConversationRecords } from '../src/server/conversation-purge.ts';
import { ProjectPurger } from '../src/server/project-purge.ts';
import { Store } from '../src/server/store.ts';
import { WorkspaceStore } from '../src/server/workspace-store.ts';
import { memoryConversationPaths } from '../src/server/local-memory.ts';
import { deleteIncognito, purgeIncognito } from '../src/server/incognito.ts';
import { Attachments } from '../src/server/attachments.ts';
import type { Conversation, Project } from '../src/shared/types.ts';
import { fixture as workspaceFixture } from './helpers/session-workspace.ts';
import { listedRemovedProjects } from '../src/shared/removed-projects.ts';
import { seedTraceContextRows, traceContextRowCounts } from './helpers/trace-context-rows.ts';

const day = 86400000;

function fixture(t: TestContext) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'pugport-chat-purge-')));
  t.mock.property(process, 'env', {
    ...process.env,
    COMBORUNNER_MEMORY_DIR: join(root, 'private-memory'),
    COMBORUNNER_MEMORY_VECTORS_DIR: join(root, 'vectors'),
  });
  const data = join(root, 'data');
  const db = new Store(data);
  const store = new WorkspaceStore(db.db);
  const project: Project = {
    id: randomUUID(),
    name: 'Live fixture',
    path: join(root, 'original'),
    createdAt: '',
    updatedAt: '',
  };
  mkdirSync(project.path);
  writeFileSync(join(project.path, 'keep.txt'), 'original contents');
  store.save('project', project.id, project.id, project);
  let busy = new Set<string>();
  const routing: string[][] = [],
    media: string[][] = [],
    finished: string[][] = [];
  const attachments = new Attachments(data, store);
  const host: ConstructorParameters<typeof ConversationPurger>[0] = {
    store,
    dataDir: data,
    attachments,
    quiesce: async () => {},
    assertAppIdle: () => {},
    assertIdle: (ids) => {
      if (ids.some((id) => busy.has(id))) throw Error('Synthetic active task');
    },
    purgeMedia: (ids) => void media.push(ids),
    purgeRouting: async (ids) => void routing.push(ids),
    finished: (ids) => void finished.push(ids),
  };
  const purger = new ConversationPurger(host);
  const put = (path: string, contents = 'owned') => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
    return path;
  };
  const chat = (patch: Partial<Conversation> = {}, projectId = project.id) => {
    const conversation: Conversation = {
      id: randomUUID(),
      projectId,
      title: 'Synthetic chat',
      createdAt: '',
      updatedAt: '',
      deletedAt: new Date().toISOString(),
      deletedByUser: true,
      ...patch,
    };
    store.save('conversation', conversation.id, projectId, conversation);
    return conversation;
  };
  t.after(() => {
    db.close();
    assert.ok(basename(root).startsWith('pugport-chat-purge-'));
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    data,
    db,
    store,
    project,
    purger,
    host,
    attachments,
    put,
    chat,
    routing,
    media,
    finished,
    busy: (...ids: string[]) => {
      busy = new Set(ids);
    },
  };
}

test('empty removes every owned copy of old and recent deleted chats and nothing else', async (t) => {
  const f = fixture(t);
  const recent = f.chat();
  const old = f.chat({ deletedAt: new Date(Date.now() - 90 * day).toISOString() });
  const archived = f.chat({ archivedAt: new Date().toISOString(), deletedAt: undefined, deletedByUser: undefined });
  const normal = f.chat({ deletedAt: undefined, deletedByUser: undefined });
  const side = f.chat({
    sideChat: { parentConversationId: recent.id } as Conversation['sideChat'],
    deletedAt: undefined,
    deletedByUser: undefined,
  });
  for (const item of [recent, old, archived, normal, side]) f.store.addMessage(item.id, 'user', `msg ${item.id}`);
  const workflowId = randomUUID(),
    runId = randomUUID();
  f.store.save('workflow', workflowId, recent.id, {
    id: workflowId,
    projectId: f.project.id,
    conversationId: recent.id,
    status: 'completed',
    runIds: [runId],
  });
  f.db.db
    .prepare('INSERT INTO runs VALUES(?,?,?)')
    .run(runId, '', JSON.stringify({ id: runId, workflowId, nativeSessionId: 'Old-Session', status: 'completed' }));
  f.db.db.prepare('INSERT INTO run_audit_events VALUES(?,?,?)').run(runId, 0, '{}');
  seedTraceContextRows(f.db.db, [runId, 'surviving-run']);
  f.db.db.exec(
    'CREATE TABLE IF NOT EXISTS task_judgments (workflow_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, value TEXT NOT NULL)',
  );
  f.db.db.prepare('INSERT INTO task_judgments VALUES(?,?,?)').run(workflowId, f.project.id, '{}');
  f.store.save('worklog', workflowId, f.project.id, { content: 'owned log' });
  f.store.save('analysis', 'owned-analysis', workflowId, { result: 'owned' });
  f.store.save('claude-history-import', 'receipt', f.project.id, { conversationId: recent.id });
  f.store.save('claude-history-import', 'other-receipt', f.project.id, { conversationId: normal.id });
  const exclusive = `${randomUUID()}.txt`,
    shared = `${randomUUID()}.txt`;
  f.store.save('attachment', 'a1', recent.id, { id: 'a1', conversationId: recent.id, fileName: exclusive });
  f.store.save('attachment', 'a2', recent.id, { id: 'a2', conversationId: recent.id, fileName: shared });
  f.store.save('attachment', 'a3', normal.id, { id: 'a3', conversationId: normal.id, fileName: shared });
  const exclusivePath = f.put(join(f.data, 'attachments', exclusive));
  const sharedPath = f.put(join(f.data, 'attachments', shared));
  const memory = f.put(join(memoryConversationPaths(f.data, f.project.id, recent.id).directory, 'history.jsonl'));
  const results = f.put(join(f.data, 'member-results', recent.id, 'out.txt'));
  const missing = f.put(join(f.data, 'workspaces', 'missing-folder', recent.id, 'x.txt'));
  const oldResults = f.put(join(f.data, 'member-results', old.id, 'out.txt'));
  const keepResults = f.put(join(f.data, 'member-results', normal.id, 'out.txt'));
  const keepMemory = f.put(join(memoryConversationPaths(f.data, f.project.id, normal.id).directory, 'history.jsonl'));

  const history = f.purger.history();
  assert.deepEqual({ count: history.count, olderCount: history.olderCount }, { count: 1, olderCount: 1 });
  assert.match(history.token, /^[a-f0-9]{64}$/);
  const outcome = await f.purger.empty(history.token);
  assert.deepEqual(outcome, { deleted: 2, skipped: 0, kept: 0, unsafe: 0 });

  for (const gone of [recent, old, side]) assert.equal(f.store.get('conversation', gone.id), undefined);
  assert.equal(f.store.allMessages(recent.id).length, 0);
  assert.equal(f.store.allMessages(side.id).length, 0);
  assert.equal(f.store.get('workflow', workflowId), undefined);
  assert.equal(f.db.db.prepare('SELECT 1 FROM runs WHERE id=?').get(runId), undefined);
  assert.equal(f.db.db.prepare('SELECT 1 FROM run_audit_events WHERE run_id=?').get(runId), undefined);
  const none = Object.fromEntries(Object.keys(traceContextRowCounts(f.db.db, runId)).map((table) => [table, 0]));
  assert.deepEqual(traceContextRowCounts(f.db.db, runId), none, 'Trace › Context rows go with their run');
  assert.ok(
    Object.values(traceContextRowCounts(f.db.db, 'surviving-run')).every((count) => count === 1),
    'rows of runs outside the purge stay',
  );
  assert.ok(f.store.get('native-session-exclusion', 'old-session'));
  assert.equal(f.db.db.prepare('SELECT 1 FROM task_judgments WHERE workflow_id=?').get(workflowId), undefined);
  assert.equal(f.store.get('worklog', workflowId), undefined);
  assert.equal(f.store.get('analysis', 'owned-analysis'), undefined);
  assert.equal(f.store.get('claude-history-import', 'receipt'), undefined);
  assert.ok(f.store.get('claude-history-import', 'other-receipt'));
  assert.equal(existsSync(exclusivePath), false);
  assert.equal(existsSync(sharedPath), true, 'a file another chat still uses survives');
  for (const path of [memory, results, missing, oldResults]) assert.equal(existsSync(path), false, path);
  for (const path of [keepResults, keepMemory]) assert.equal(existsSync(path), true, path);
  assert.equal(readFileSync(join(f.project.path, 'keep.txt'), 'utf8'), 'original contents');
  assert.ok(f.store.get('conversation', archived.id) && f.store.get('conversation', normal.id));
  assert.ok(f.store.get('project', f.project.id), 'the project record is never removed');
  assert.deepEqual(f.routing.flat().sort(), [recent.id, old.id, side.id].sort());
  assert.deepEqual(f.media.flat().sort(), [recent.id, old.id, side.id].sort());
  assert.deepEqual(f.finished[0], [f.project.id]);
  assert.equal(f.purger.history().count + f.purger.history().olderCount, 0);
});

test('a stale token is refused and nothing is removed', async (t) => {
  const f = fixture(t);
  const first = f.chat();
  const { token } = f.purger.history();
  f.chat();
  await assert.rejects(f.purger.empty(token), /列表已有变化/);
  await assert.rejects(f.purger.empty(''), /列表已有变化/);
  assert.ok(f.store.get('conversation', first.id));
});

test('only one empty runs at a time', async (t) => {
  const f = fixture(t);
  f.chat();
  const { token } = f.purger.history();
  const first = f.purger.empty(token);
  await assert.rejects(f.purger.empty(token), /另一个清空/);
  assert.equal((await first).deleted, 1);
  assert.equal(f.purger.inProgress, false);
});

test('busy chats and chats that own a working copy are skipped and counted', async (t) => {
  const f = fixture(t);
  const busy = f.chat(),
    lane = f.chat({ lane: { parentConversationId: randomUUID(), sourceWorkflowId: randomUUID(), workspaceId: 'w' } }),
    child = f.chat(),
    ready = f.chat();
  const workflowId = randomUUID();
  f.store.save('workflow', workflowId, child.id, {
    id: workflowId,
    projectId: f.project.id,
    conversationId: child.id,
    status: 'completed',
    executionWorkspaceId: 'managed',
    runIds: [],
  });
  const running = f.chat();
  f.store.save('workflow', 'running', running.id, {
    id: 'running',
    projectId: f.project.id,
    conversationId: running.id,
    status: 'running',
    runIds: [],
  });
  f.busy(busy.id);
  const outcome = await f.purger.empty(f.purger.history().token);
  assert.deepEqual(outcome, { deleted: 1, skipped: 2, kept: 2, unsafe: 0 });
  assert.equal(f.store.get('conversation', ready.id), undefined);
  for (const kept of [busy, lane, child, running]) assert.ok(f.store.get('conversation', kept.id));
});

test('chats deleted inside a removed project are never purged', async (t) => {
  const f = fixture(t);
  const gone: Project = {
    ...f.project,
    id: randomUUID(),
    path: join(f.root, 'other'),
    removedAt: new Date().toISOString(),
  };
  mkdirSync(gone.path);
  f.store.save('project', gone.id, gone.id, gone);
  const hidden = f.chat({}, gone.id);
  const withProject = f.chat({ removedWithProject: f.project.id });
  const history = f.purger.history();
  assert.equal(history.count, 0);
  assert.deepEqual(await f.purger.empty(history.token), { deleted: 0, skipped: 0, kept: 0, unsafe: 0 });
  assert.ok(f.store.get('conversation', hidden.id) && f.store.get('conversation', withProject.id));
});

test('emptying never removes the now-empty chat project, its folder or the daily task project', async (t) => {
  const f = fixture(t);
  const folder = join(f.data, 'workspaces', randomUUID());
  mkdirSync(folder, { recursive: true });
  const chatProject: Project = { ...f.project, id: randomUUID(), path: folder, scope: 'chat' };
  f.store.save('project', chatProject.id, chatProject.id, chatProject);
  const only = f.chat({}, chatProject.id);
  await f.purger.empty(f.purger.history().token);
  assert.equal(f.store.get('conversation', only.id), undefined);
  assert.ok(f.store.get('project', chatProject.id));
  assert.equal(existsSync(folder), true);
});

test('startup incognito cleanup leaves deleted ordinary chats alone', async (t) => {
  const f = fixture(t);
  const kept = f.chat();
  const attachments = new Attachments(f.data, f.store);
  assert.equal(await purgeIncognito(f.store, attachments, true), false);
  assert.ok(f.store.get('conversation', kept.id));
});

test('Clear list hides by timestamp but keeps purge-marked projects', () => {
  const at = (hour: number, extra: Partial<Project> = {}): Project => ({
    id: randomUUID(),
    name: 'p',
    path: '',
    createdAt: '',
    updatedAt: '',
    removedAt: `2026-10-27T0${hour}:00:00.000Z`,
    ...extra,
  });
  const before = at(1),
    marked = at(1, { purgePending: true }),
    after = at(3);
  const all = [before, marked, after];
  assert.equal(listedRemovedProjects(all).length, 3);
  assert.deepEqual(
    listedRemovedProjects(all, '2026-10-27T02:00:00.000Z').map((project) => project.id),
    [marked.id, after.id],
  );
});

test('workspace: delete-all archived, history counts, clear list and state stay unfiltered', async (t) => {
  const { workspace, directory, controller } = workspaceFixture(t);
  mkdirSync(join(directory, 'project'));
  const project = await workspace.createProject(join(directory, 'project'));
  const one = workspace.createConversation(project.id),
    two = workspace.createConversation(project.id);
  workspace.archiveConversation(one.id, true);
  workspace.archiveConversation(two.id, true);
  workspace.store.save('workflow', 'busy', two.id, {
    id: 'busy',
    projectId: project.id,
    conversationId: two.id,
    status: 'running',
    runIds: [],
  });
  assert.deepEqual(workspace.deleteArchivedConversations(), { deleted: 1, skipped: 1 });
  const history = workspace.conversationHistory();
  assert.equal(history.archived, 1);
  assert.equal(history.deleted, 1);
  assert.equal(history.purge.count, 1);
  await assert.rejects(workspace.conversationPurge.empty('0'.repeat(64)), /列表已有变化/);
  assert.deepEqual(await workspace.conversationPurge.empty(history.purge.token), {
    deleted: 1,
    skipped: 0,
    kept: 0,
    unsafe: 0,
  });
  assert.equal(workspace.store.get('conversation', one.id), undefined);

  workspace.store.save('workflow', 'busy', two.id, {
    id: 'busy',
    projectId: project.id,
    conversationId: two.id,
    status: 'completed',
    runIds: [],
  });
  workspace.removeProject(project.id);
  const before = workspace.state().removedProjects?.length;
  workspace.clearRemovedProjects();
  assert.ok(controller.settings.removedProjectsClearedAt);
  assert.equal(workspace.state().removedProjects?.length, before);
});

test('derived, uploaded and workflow-owned attachments respect references from surviving chats', async (t) => {
  const f = fixture(t);
  const gone = f.chat(),
    survivor = f.chat({ deletedAt: undefined, deletedByUser: undefined });
  const workflowId = randomUUID();
  f.store.save('workflow', workflowId, gone.id, {
    id: workflowId,
    projectId: f.project.id,
    conversationId: gone.id,
    status: 'completed',
    runIds: [],
  });
  const exclusive = randomUUID() + '.png',
    fitted = randomUUID() + '.png',
    shared = randomUUID() + '.png';
  const temporary = randomUUID() + '.tmp',
    destination = randomUUID() + '.jpg',
    owned = randomUUID() + '.txt';
  f.store.save('attachment', 'derived', gone.id, { fileName: exclusive, fitted: { fileName: fitted } });
  f.store.save('attachment', 'shared-original', gone.id, { fileName: shared });
  f.store.save('attachment', 'survivor-derived', survivor.id, {
    fileName: randomUUID() + '.png',
    fitted: { fileName: shared },
  });
  f.store.save('attachment-upload', 'upload', gone.id, { fileName: temporary, destinationFileName: destination });
  f.store.save('attachment', 'workflow-file', workflowId, { fileName: owned });
  for (const name of [exclusive, fitted, shared, temporary, destination, owned])
    f.put(join(f.data, 'attachments', name));
  await f.purger.empty(f.purger.history().token);
  for (const name of [exclusive, fitted, temporary, destination, owned])
    assert.equal(existsSync(join(f.data, 'attachments', name)), false, name);
  assert.equal(existsSync(join(f.data, 'attachments', shared)), true);
});

test('a file cleanup failure retains a retry receipt and still cleans media, routing and cached state', async (t) => {
  const f = fixture(t),
    gone = f.chat();
  const name = randomUUID() + '.txt';
  f.store.save('attachment', 'file', gone.id, { fileName: name });
  const path = f.put(join(f.data, 'attachments', name));
  const failure = t.mock.method(f.attachments, 'removeUnshared', () => {
    throw Error('Synthetic locked file');
  });
  await assert.rejects(f.purger.empty(f.purger.history().token));
  assert.equal(f.store.get('conversation', gone.id), undefined, 'database records leave before files');
  assert.ok(f.store.get('conversation-purge', gone.id), 'cleanup evidence survives the commit');
  assert.equal(existsSync(path), true);
  assert.deepEqual(f.media.flat(), [gone.id]);
  assert.deepEqual(f.routing.flat(), [gone.id]);
  assert.deepEqual(f.finished, [[f.project.id]]);
  failure.mock.restore();
  const restarted = new ConversationPurger(f.host);
  assert.deepEqual(await restarted.empty(restarted.history().token), { deleted: 0, skipped: 0, kept: 0, unsafe: 0 });
  assert.equal(existsSync(path), false);
  assert.equal(f.store.get('conversation-purge', gone.id), undefined);
});

for (const target of ['missing-folder', 'attachments'] as const) {
  test('purge preserves a registered original project overlapping ' + target, async (t) => {
    const f = fixture(t),
      gone = f.chat();
    const name = randomUUID() + '.txt';
    const original =
      target === 'missing-folder' ? join(f.data, 'workspaces', 'missing-folder', gone.id) : join(f.data, 'attachments');
    const kept = f.put(join(original, target === 'attachments' ? name : 'source.txt'), 'source bytes');
    if (target === 'attachments') f.store.save('attachment', 'a', gone.id, { fileName: name });
    const protectedProject = { ...f.project, id: randomUUID(), path: original };
    f.store.save('project', protectedProject.id, protectedProject.id, protectedProject);
    assert.deepEqual(await f.purger.empty(f.purger.history().token), { deleted: 0, skipped: 0, kept: 0, unsafe: 1 });
    assert.equal(readFileSync(kept, 'utf8'), 'source bytes');
    assert.ok(f.store.get('conversation', gone.id));
  });
}

test('scope is rechecked after writers settle and before the database transaction deletes anything', async (t) => {
  const f = fixture(t),
    gone = f.chat();
  let appChecks = 0;
  f.host.assertAppIdle = () => {
    if (++appChecks !== 2) return;
    f.store.restoreConversation(gone.id);
  };
  await assert.rejects(f.purger.empty(f.purger.history().token), /列表已有变化/);
  assert.ok(f.store.get('conversation', gone.id));
  assert.equal(f.media.length, 0);
});

test('a busy conversation arising after preflight is skipped inside the write transaction', async (t) => {
  const f = fixture(t),
    gone = f.chat();
  let appChecks = 0;
  f.host.assertAppIdle = () => {
    if (++appChecks !== 2) return;
    f.busy(gone.id);
  };
  assert.deepEqual(await f.purger.empty(f.purger.history().token), { deleted: 0, skipped: 1, kept: 0, unsafe: 0 });
  assert.ok(f.store.get('conversation', gone.id));
});

test('replacing a side chat with another identity during preflight keeps the parent and both file sets', async (t) => {
  const f = fixture(t),
    parent = f.chat();
  const side = f.chat({
    deletedAt: undefined,
    deletedByUser: undefined,
    sideChat: { parentConversationId: parent.id } as Conversation['sideChat'],
  });
  const oldFile = f.put(join(f.data, 'member-results', side.id, 'keep.txt'));
  let replacement!: Conversation;
  let appChecks = 0;
  f.host.assertAppIdle = () => {
    if (++appChecks !== 2) return;
    f.store.db.prepare("DELETE FROM workspace_records WHERE kind='conversation' AND id=?").run(side.id);
    replacement = f.chat({
      deletedAt: undefined,
      deletedByUser: undefined,
      sideChat: { parentConversationId: parent.id } as Conversation['sideChat'],
    });
    f.put(join(f.data, 'member-results', replacement.id, 'keep.txt'));
  };
  assert.deepEqual(await f.purger.empty(f.purger.history().token), { deleted: 0, skipped: 0, kept: 0, unsafe: 1 });
  assert.ok(f.store.get('conversation', parent.id));
  assert.ok(f.store.get('conversation', replacement.id));
  assert.equal(existsSync(oldFile), true);
  assert.equal(existsSync(join(f.data, 'member-results', replacement.id, 'keep.txt')), true);
});

test('new workflow-owned attachments arriving during preflight keep the conversation intact', async (t) => {
  const f = fixture(t),
    gone = f.chat();
  const name = randomUUID() + '.txt';
  const path = f.put(join(f.data, 'attachments', name));
  let appChecks = 0;
  f.host.assertAppIdle = () => {
    if (++appChecks !== 2) return;
    f.store.save('attachment', 'late', gone.id, { fileName: name });
  };
  assert.deepEqual(await f.purger.empty(f.purger.history().token), { deleted: 0, skipped: 0, kept: 0, unsafe: 1 });
  assert.ok(f.store.get('conversation', gone.id));
  assert.equal(existsSync(path), true);
});

test('ordinary purge removes real media checkpoint rows only for the selected chats', async (t) => {
  const f = fixture(t),
    gone = f.chat(),
    kept = f.chat({ deletedAt: undefined, deletedByUser: undefined });
  const decoder: MediaDecoder = {
    description: 'Synthetic cleanup fixture',
    image: async () => ({ time: 0, hash: '1234567890abcdef', texture: 0, colours: Array(12).fill(0.25) }),
    probe: async () => ({ duration: 1 }),
    frame: async (_path, time) => ({ time, hash: '1234567890abcdef', texture: 0, colours: Array(12).fill(0.25) }),
  };
  const manager = new MediaAnalysisManager(f.data, { decoder, staging: false });
  const db = new DatabaseSync(join(f.data, 'media-analysis', 'checkpoint.sqlite'));
  try {
    for (const [id, conversationId] of [
      ['ours', gone.id],
      ['other', kept.id],
    ]) {
      db.prepare(
        'INSERT INTO jobs(id,options,status,phase,progress,created,updated,coverage,owner) VALUES(?,?,?,?,?,?,?,?,?)',
      ).run(id, '{}', 'completed', 'done', '', '', '', '[]', JSON.stringify({ conversationId }));
      db.prepare('INSERT INTO files(job,path,kind) VALUES(?,?,?)').run(id, id + '.jpg', 'image');
      db.prepare('INSERT INTO evidence(job,a,b,data) VALUES(?,?,?,?)').run(id, 1, 2, '{}');
      db.prepare('INSERT INTO pair_cache(job,a,b,key,data) VALUES(?,?,?,?,?)').run(id, 1, 2, 'key', '{}');
      db.prepare('INSERT INTO pair_checks(job,a,b,key,checked) VALUES(?,?,?,?,?)').run(id, 1, 2, 'key', 'now');
    }
    f.host.assertIdle = (ids) => manager.assertConversationsIdle(ids);
    f.host.purgeMedia = (ids) => manager.purgeConversations(ids);
    await f.purger.empty(f.purger.history().token);
    assert.equal(db.prepare("SELECT 1 FROM jobs WHERE id='ours'").get(), undefined);
    assert.ok(db.prepare("SELECT 1 FROM jobs WHERE id='other'").get());
    for (const table of ['files', 'evidence', 'pair_cache', 'pair_checks']) {
      assert.equal(db.prepare(`SELECT 1 FROM ${table} WHERE job='ours'`).get(), undefined);
      assert.ok(db.prepare(`SELECT 1 FROM ${table} WHERE job='other'`).get());
    }
  } finally {
    db.close();
    await manager.close();
  }
});

test('a final refresh failure keeps cleanup evidence until a successful retry', async (t) => {
  const f = fixture(t),
    gone = f.chat();
  f.host.finished = async () => {
    throw Error('Synthetic refresh failure');
  };
  await assert.rejects(f.purger.empty(f.purger.history().token), /Synthetic refresh failure/);
  assert.equal(f.store.get('conversation', gone.id), undefined);
  assert.ok(f.store.get('conversation-purge', gone.id));
  f.host.finished = (ids) => {
    f.finished.push(ids);
  };
  const restarted = new ConversationPurger(f.host);
  await restarted.empty(restarted.history().token);
  assert.equal(f.store.get('conversation-purge', gone.id), undefined);
  assert.deepEqual(f.finished, [[f.project.id]]);
});

test('project purge finishes leftover chat cleanup after its project is removed', async (t) => {
  const f = fixture(t),
    gone = f.chat();
  const name = randomUUID() + '.txt';
  f.store.save('attachment', 'leftover', gone.id, { fileName: name });
  const path = f.put(join(f.data, 'attachments', name), 'owned copy');
  const failure = t.mock.method(f.attachments, 'removeUnshared', () => {
    throw Error('Synthetic attachment locked');
  });
  f.host.purgeMedia = () => {
    throw Error('Synthetic media locked');
  };
  await assert.rejects(f.purger.empty(f.purger.history().token));
  failure.mock.restore();
  assert.equal(f.store.get('conversation', gone.id), undefined);
  assert.ok(f.store.get('conversation-purge', gone.id));
  assert.equal(existsSync(path), true);

  f.store.save('project', f.project.id, f.project.id, { ...f.project, removedAt: new Date().toISOString() });
  const media: string[][] = [];
  const projectPurger = new ProjectPurger({
    store: f.store,
    dataDir: f.data,
    assertIdle: () => {},
    quiesce: async () => {},
    purgeMedia: (ids) => {
      media.push(ids);
    },
    finished: () => {},
  });
  const preview = await projectPurger.preview(f.project.id);
  assert.equal(preview.canPurge, true, preview.blockedReason ?? '');
  await projectPurger.purge(f.project.id, preview.token);
  assert.equal(existsSync(path), false);
  assert.deepEqual(media.flat(), [gone.id]);
  assert.equal(f.store.get('conversation-purge', gone.id), undefined);
  assert.equal(readFileSync(join(f.project.path, 'keep.txt'), 'utf8'), 'original contents');
});

for (const change of ['running', 'worktree'] as const) {
  test('a workflow acquiring ' + change + ' during preflight gets the matching skip reason', async (t) => {
    const f = fixture(t),
      gone = f.chat(),
      workflowId = randomUUID();
    const workflow = {
      id: workflowId,
      projectId: f.project.id,
      conversationId: gone.id,
      status: 'completed',
      runIds: [],
    };
    f.store.save('workflow', workflowId, gone.id, workflow);
    let appChecks = 0;
    f.host.assertAppIdle = () => {
      if (++appChecks !== 2) return;
      f.store.save('workflow', workflowId, gone.id, {
        ...workflow,
        ...(change === 'running' ? { status: 'running' } : { executionWorkspaceId: 'synthetic-worktree' }),
      });
    };
    const outcome = await f.purger.empty(f.purger.history().token);
    assert.deepEqual(outcome, {
      deleted: 0,
      skipped: change === 'running' ? 1 : 0,
      kept: change === 'worktree' ? 1 : 0,
      unsafe: 0,
    });
    assert.ok(f.store.get('conversation', gone.id));
    assert.equal(f.store.get('conversation-purge', gone.id), undefined);
  });
}

test('a pending Laya assessment keeps its deleted chat until the callback is finished', async (t) => {
  const { workspace, directory } = workspaceFixture(t);
  const source = join(directory, 'assessment-project');
  mkdirSync(source);
  const project = await workspace.createProject(source);
  const conversation = workspace.createConversation(project.id);
  const workflowId = randomUUID();
  workspace.store.save('workflow', workflowId, conversation.id, {
    id: workflowId,
    projectId: project.id,
    conversationId: conversation.id,
    status: 'completed',
    runIds: [],
  });
  workspace.store.deleteConversation(conversation.id);
  const assessments = Reflect.get(workspace, 'layaAssessments') as Map<string, AbortController>;
  assessments.set(workflowId, new AbortController());
  try {
    assert.deepEqual(await workspace.conversationPurge.empty(workspace.conversationHistory().purge.token), {
      deleted: 0,
      skipped: 1,
      kept: 0,
      unsafe: 0,
    });
    assert.ok(workspace.store.get('conversation', conversation.id));
    assert.ok(workspace.store.get('workflow', workflowId));
  } finally {
    assessments.delete(workflowId);
  }
  assert.deepEqual(await workspace.conversationPurge.empty(workspace.conversationHistory().purge.token), {
    deleted: 1,
    skipped: 0,
    kept: 0,
    unsafe: 0,
  });
  assert.equal(workspace.store.get('workflow', workflowId), undefined);
});

test('closing the last incognito chat preserves an unfinished ordinary cleanup and its project', async (t) => {
  const f = fixture(t);
  const folder = join(f.data, 'workspaces', randomUUID());
  mkdirSync(folder, { recursive: true });
  f.store.save('project', f.project.id, f.project.id, { ...f.project, path: folder, scope: 'chat' });
  const gone = f.chat();
  const secret = f.chat({ incognito: true, deletedAt: undefined, deletedByUser: undefined });
  const name = randomUUID() + '.txt';
  f.store.save('attachment', 'leftover', gone.id, { fileName: name });
  const path = f.put(join(f.data, 'attachments', name));
  const locked = t.mock.method(f.attachments, 'removeUnshared', () => {
    throw Error('Synthetic file lock');
  });
  await assert.rejects(f.purger.empty(f.purger.history().token));
  locked.mock.restore();
  const recycle = t.mock.fn(async () => {
    throw Error('Unexpected recycle');
  });
  await deleteIncognito(f.store, f.attachments, secret.id, recycle);
  assert.equal(recycle.mock.callCount(), 0);
  assert.ok(f.store.get('project', f.project.id));
  assert.ok(f.store.get('conversation-purge', gone.id));
  assert.equal(existsSync(folder), true);
  await f.purger.empty(f.purger.history().token);
  assert.equal(f.store.get('conversation-purge', gone.id), undefined);
  assert.equal(existsSync(path), false);
});

test('bulk record deletion uses a constant number of workspace deletes for hundreds of chats', (t) => {
  const f = fixture(t);
  const ids = Array.from({ length: 300 }, () => f.chat().id);
  for (const id of ids)
    for (let n = 0; n < 3; n++) {
      const workflow = randomUUID();
      f.store.save('workflow', workflow, id, {
        id: workflow,
        projectId: f.project.id,
        status: 'completed',
        runIds: [],
      });
      f.store.save('message', randomUUID(), id, { content: 'synthetic' });
    }
  let deletes = 0;
  const prepare = f.db.db.prepare.bind(f.db.db);
  t.mock.method(f.db.db, 'prepare', (sql: string) => {
    if (/^DELETE FROM workspace_records/i.test(sql.trim())) deletes++;
    return prepare(sql);
  });
  f.store.transaction(() => removeConversationRecords(f.store, ids));
  assert.equal(deletes, 4);
  assert.equal(f.store.list('conversation', f.project.id, 1000).length, 0);
});

test('old receipt paths are ignored and media and routing run once per batch', async (t) => {
  const f = fixture(t);
  const first = f.chat(),
    second = f.chat();
  const saved = f.host.purgeRouting;
  f.host.purgeRouting = async () => {
    throw Error('synthetic routing failure');
  };
  await assert.rejects(f.purger.empty(f.purger.history().token));
  const receipts = f.store.list<any>('conversation-purge', f.project.id, 10);
  assert.equal(receipts.length, 2);
  for (const receipt of receipts) {
    for (const copy of receipt.copies) copy.targets = [{ root: 'C:/old-data', path: 'C:/old-data/obsolete' }];
    f.store.save('conversation-purge', receipt.id, receipt.projectId, receipt);
  }
  f.host.purgeRouting = saved;
  f.media.length = 0;
  f.routing.length = 0;
  await f.purger.empty(f.purger.history().token);
  assert.equal(f.media.length, 1);
  assert.equal(f.routing.length, 1);
  assert.deepEqual(f.routing[0]!.sort(), [first.id, second.id].sort());
  assert.equal(f.store.list('conversation-purge', f.project.id, 10).length, 0);
});

test('application busy rejects before and inside the transaction while postcommit cleanup stays per chat', async (t) => {
  const f = fixture(t),
    chat = f.chat();
  f.host.assertAppIdle = () => {
    throw Error('有消息正在发送，稍后再试。');
  };
  await assert.rejects(f.purger.empty(f.purger.history().token), /有消息正在发送/);
  assert.ok(f.store.get('conversation', chat.id));
  let checks = 0;
  f.host.assertAppIdle = () => {
    if (++checks === 2) throw Error('有消息正在发送，稍后再试。');
  };
  await assert.rejects(f.purger.empty(f.purger.history().token), /有消息正在发送/);
  assert.ok(f.store.get('conversation', chat.id));
  f.host.assertAppIdle = () => {};
  f.host.quiesce = async () => {
    f.host.assertAppIdle = () => {
      throw Error('unrelated send');
    };
  };
  assert.equal((await f.purger.empty(f.purger.history().token)).deleted, 1);
});

test('postcommit quiesce failure publishes state and retains its receipt for retry', async (t) => {
  const f = fixture(t),
    chat = f.chat();
  f.host.quiesce = async () => {
    throw Error('synthetic quiesce failure');
  };
  await assert.rejects(f.purger.empty(f.purger.history().token), /synthetic quiesce failure/);
  assert.equal(f.store.get('conversation', chat.id), undefined);
  assert.ok(f.store.get('conversation-purge', chat.id));
  assert.deepEqual(f.finished, [[f.project.id]]);
  f.host.quiesce = async () => {};
  await f.purger.empty(f.purger.history().token);
  assert.equal(f.store.get('conversation-purge', chat.id), undefined);
});
