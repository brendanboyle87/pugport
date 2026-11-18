import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, symlinkSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workspace } from '../src/server/workspace.ts';
import { WorkspaceStore } from '../src/server/workspace-store.ts';
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'workspace-revision-'));
  const file = join(directory, 'synthetic.sqlite');
  const db = new DatabaseSync(file);
  db.exec(
    'PRAGMA journal_mode=WAL; CREATE TABLE runs(id TEXT PRIMARY KEY,value TEXT); CREATE TABLE run_audit_events(value TEXT)',
  );
  // Start from a populated legacy schema without revision infrastructure.
  db.exec(`CREATE TABLE workspace_records(kind TEXT NOT NULL,id TEXT NOT NULL,owner TEXT NOT NULL,updated_at TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(kind,id));
    INSERT INTO workspace_records VALUES('migration','legacy','legacy','','{"completed":true}')`);
  const store = new WorkspaceStore(db, { recoverInterrupted: false });
  const workspace = Object.assign(Object.create(Workspace.prototype), {
    store,
    controller: { dataDir: join(directory, 'protected') },
    folderAvailability: new Map(),
    tastes: { list: () => [] },
  }) as Workspace;
  t.after(() => db.close());
  return { directory, file, db, store, workspace };
}
test('workspace collections survive local and external run/audit writes and rebuild once for messages', (t) => {
  const { db, file, store, workspace } = fixture(t);
  store.save('conversation', 'c', 'p', { id: 'c', projectId: 'p' });
  store.transaction(() => {
    for (let i = 0; i < 2500; i++) {
      store.save('message', `m${i}`, 'c', {
        id: `m${i}`,
        conversationId: 'c',
        role: 'user',
        content: 'synthetic',
        createdAt: String(i),
      });
      store.save('workflow', `w${i}`, 'c', {
        id: `w${i}`,
        conversationId: 'c',
        projectId: 'p',
        status: 'completed',
        createdAt: String(i),
        updatedAt: String(i),
        plan: [],
        input: { content: 'synthetic' },
      });
    }
  });
  const spy = t.mock.method(store, 'recentMessages');
  // Every collection the state reads, so a future read before the cache check is caught too.
  const others = [t.mock.method(store, 'conversations'), t.mock.method(store, 'visibleWorkflows')];
  const collectionReads = () => others.map((other) => other.mock.callCount());
  workspace.state();
  const active = new Map();
  Object.assign(workspace, { active });
  active.set('synthetic-running', { workflow: { id: 'synthetic-running' } });
  workspace.state();
  active.delete('synthetic-running');
  workspace.state();
  assert.equal(spy.mock.callCount(), 1, 'active alone is not a state dependency');
  const before = collectionReads();
  db.exec(`INSERT INTO runs VALUES('r','{}'); INSERT INTO run_audit_events VALUES('{}')`);
  workspace.state();
  assert.equal(spy.mock.callCount(), 1, 'local unrelated writes must not rebuild');
  assert.deepEqual(collectionReads(), before, 'no other collection is read on a cache hit');
  const other = new DatabaseSync(file);
  try {
    other.exec(`UPDATE runs SET value='{"status":"running"}'; INSERT INTO run_audit_events VALUES('{}')`);
    workspace.state();
    assert.equal(spy.mock.callCount(), 1, 'external unrelated writes must not rebuild');
    other.exec(
      `UPDATE workspace_records SET value=json_set(value,'$.content','changed') WHERE kind='message' AND id='m2499'`,
    );
    assert.ok(workspace.state().conversationMessages!.some((m) => m.content === 'changed'));
    assert.equal(spy.mock.callCount(), 2);
    workspace.state();
    assert.equal(spy.mock.callCount(), 2);
    const original = store.recentMessages.bind(store);
    let intervene = true;
    t.mock.method(store, 'recentMessages', () => {
      const result = original();
      if (intervene) {
        intervene = false;
        other.exec(
          `UPDATE workspace_records SET value=json_set(value,'$.content','during-build') WHERE kind='message' AND id='m2499'`,
        );
      }
      return result;
    });
    store.save('conversation-folder', 'force', '', { id: 'force' });
    workspace.state();
    assert.ok(
      workspace.state().conversationMessages!.some((m) => m.content === 'during-build'),
      'concurrent build is not cached',
    );
  } finally {
    other.close();
  }
});
test('revision migration is singleton and transactional; rollback, running transitions and bulk purge stay fresh', (t) => {
  const { db, store, workspace } = fixture(t);
  const revision = () => (db.prepare('SELECT n FROM workspace_revision WHERE id=1').get() as { n: number }).n;
  const before = revision();
  new WorkspaceStore(db, { recoverInterrupted: false });
  assert.equal(revision(), before);
  assert.equal(db.prepare('SELECT count(*) AS n FROM workspace_revision').get()!.n, 1);
  store.save('workflow', 'w', 'c', {
    id: 'w',
    conversationId: 'c',
    projectId: 'p',
    status: 'queued',
    plan: [],
    input: { content: 'synthetic' },
  });
  for (const status of ['running', 'completed']) {
    db.prepare("UPDATE workspace_records SET value=json_set(value,'$.status',?) WHERE kind='workflow'").run(status);
    assert.equal(workspace.state().workflows![0]!.status, status);
  }
  const saved = revision();
  assert.throws(() =>
    store.transaction(() => {
      store.save('conversation-folder', 'f', '', { id: 'f', name: 'rollback' });
      assert.equal(workspace.state().conversationFolders!.length, 1);
      throw Error('synthetic rollback');
    }),
  );
  assert.equal(revision(), saved);
  assert.equal(workspace.state().conversationFolders!.length, 0);
  for (let i = 0; i < 100; i++) store.save('conversation-folder', String(i), '', { id: String(i) });
  assert.equal(workspace.state().conversationFolders!.length, 100);
  db.prepare(
    "DELETE FROM workspace_records WHERE kind='conversation-folder' AND id IN (SELECT value FROM json_each(?))",
  ).run(JSON.stringify(Array.from({ length: 100 }, (_, i) => String(i))));
  assert.equal(workspace.state().conversationFolders!.length, 0);
  assert.equal(revision(), saved + 200);
});
test('a message write keeps the task list; every kind of task write shows in the next state', (t) => {
  const { db, file, store, workspace } = fixture(t);
  store.save('conversation', 'c', 'p', { id: 'c', projectId: 'p' });
  const save = (id: string, status: string) =>
    store.save('workflow', id, 'c', {
      id,
      conversationId: 'c',
      projectId: 'p',
      status,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: `2026-01-01T00:00:0${id.slice(1)}.000Z`,
      plan: [],
      input: { content: 'synthetic' },
    });
  for (let i = 0; i < 5; i++) save(`w${i}`, 'completed');
  const reads = t.mock.method(store, 'visibleWorkflows');
  const status = (id: string) => workspace.state().workflows!.find((workflow) => workflow.id === id)?.status;
  const first = workspace.state();
  assert.equal(reads.mock.callCount(), 1);
  store.save('message', 'm', 'c', { id: 'm', conversationId: 'c', role: 'user', content: 'new', createdAt: '1' });
  const second = workspace.state();
  assert.notEqual(second, first, 'the message rebuilds the state');
  assert.deepEqual(
    second.conversationMessages!.map((message) => message.id),
    ['m'],
  );
  assert.equal(reads.mock.callCount(), 1, 'tasks are not read again for a message');
  assert.deepEqual(second.workflows, first.workflows);
  save('w1', 'failed');
  assert.equal(status('w1'), 'failed');
  assert.equal(reads.mock.callCount(), 2);
  db.prepare("UPDATE workspace_records SET value=json_set(value,'$.status','blocked') WHERE id='w2'").run();
  assert.equal(status('w2'), 'blocked', 'direct SQL without updated_at');
  const other = new DatabaseSync(file);
  try {
    other.exec("UPDATE workspace_records SET value=json_set(value,'$.status','cancelled') WHERE id='w3'");
    assert.equal(status('w3'), 'cancelled', 'another connection');
  } finally {
    other.close();
  }
  db.prepare("UPDATE workspace_records SET kind='workflow-archive' WHERE id='w4'").run();
  assert.equal(status('w4'), undefined, 'a record leaving the kind');
  db.prepare("UPDATE workspace_records SET kind='workflow' WHERE id='w4'").run();
  assert.equal(status('w4'), 'completed', 'and coming back');
  db.prepare("DELETE FROM workspace_records WHERE kind='workflow' AND id='w0'").run();
  assert.equal(status('w0'), undefined, 'a deleted record');
  assert.throws(() =>
    store.transaction(() => {
      save('w1', 'running');
      assert.equal(status('w1'), 'running', 'inside the transaction');
      throw Error('synthetic rollback');
    }),
  );
  assert.equal(status('w1'), 'failed', 'after the rollback');
  // An unchanged task is reused from the previous read, a changed one is parsed again.
  const before = workspace.state().workflows!.find((workflow) => workflow.id === 'w2')!;
  save('w1', 'completed');
  const after = workspace.state().workflows!;
  assert.equal(after.find((workflow) => workflow.id === 'w1')!.status, 'completed');
  assert.deepEqual(
    after.find((workflow) => workflow.id === 'w2'),
    before,
  );
});
test('a stopped task leaves the attention view when its 14 days pass, without a task write', (t) => {
  const { store, workspace } = fixture(t);
  let now = Date.parse('2026-03-01T00:00:00.000Z');
  t.mock.method(Date, 'now', () => now);
  store.save('conversation', 'c', 'p', { id: 'c', projectId: 'p' });
  const task = (id: string, status: string, updatedAt: string) =>
    store.save('workflow', id, 'c', {
      id,
      conversationId: 'c',
      projectId: 'p',
      status,
      createdAt: updatedAt,
      updatedAt,
      plan: [],
      runIds: [],
      input: { content: 'synthetic' },
    });
  // Saved first, so 200 newer tasks push it out of the recent window; only its attention keeps it visible.
  task('stopped', 'failed', new Date(now - 14 * 86_400_000 + 3600_000).toISOString());
  for (let i = 0; i < 200; i++) task(`done-${i}`, 'completed', new Date(now).toISOString());
  const visible = () => workspace.state().workflows!.some((workflow) => workflow.id === 'stopped');
  assert.equal(visible(), true);
  now += 2 * 3600_000;
  store.save('message', 'm', 'c', { id: 'm', conversationId: 'c', role: 'user', content: 'later', createdAt: '1' });
  assert.equal(visible(), false);
});
test('cached project trust follows junction targets and folder refresh without database writes', (t) => {
  const { directory, store, workspace } = fixture(t);
  const safe = join(directory, 'safe'),
    protectedPath = join(directory, 'protected'),
    link = join(directory, 'link');
  mkdirSync(safe);
  mkdirSync(protectedPath);
  symlinkSync(safe, link, 'junction');
  store.save('project', 'p', 'p', { id: 'p', name: 'synthetic', path: link, trusted: true });
  assert.equal(workspace.state().projects![0]!.trusted, true);
  renameSync(link, join(directory, 'old-link'));
  symlinkSync(protectedPath, link, 'junction');
  assert.equal(workspace.state().projects![0]!.trusted, false);
  store.save('project', 'missing', 'missing', { id: 'missing', name: 'missing', path: join(directory, 'later') });
  assert.equal(workspace.state().projects!.find((p) => p.id === 'missing')!.folderMissing, true);
  mkdirSync(join(directory, 'later'));
  workspace.refreshProjectFolders();
  assert.equal(workspace.state().projects!.find((p) => p.id === 'missing')!.folderMissing, false);
});
