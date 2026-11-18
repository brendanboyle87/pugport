import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Workspace } from '../src/server/workspace.ts';
import { WorkspaceStore } from '../src/server/workspace-store.ts';

const skippedKinds = [
  'maintainer-desk-state',
  'maintainer-state',
  'maintainer-pr',
  'maintainer-issue',
  'maintainer-suite-day',
  'maintainer-suite',
  'maintainer-card',
  'grok-source-cache',
  'grok-deferred-sessions',
  'grok-import',
  'history-archive',
  'grok-sync-status',
  'claude-history-import',
  'memory',
  'memory-auto',
  'memory-distillation-history',
  'local-memory-status',
  'hindsight-document',
  'hindsight-retired-bank',
  'hindsight-generation',
  'hindsight-audit',
  'worklog',
  'conversation-mail',
  'github-repo',
  'github-notice',
  'lane-result',
  'conversation-classification',
  'conversation-folder-position',
  'delegation-human-update',
  'delegation-recovery-context',
  'delegation-batch',
  'swarm-message',
  'routine',
  'judge-run',
  'remote-job',
  'peer-task',
  'peer-request',
  'attachment',
  'attachment-upload',
  'conversation-purge',
  'native-session-exclusion',
];
const readKinds = [
  'project',
  'project-purge',
  'conversation',
  'conversation-folder',
  'message',
  'workflow',
  'taste-test',
  'external-conversation',
  'human-message',
  'conversation-job',
];
function fixture(t: TestContext) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const store = new WorkspaceStore(db, { recoverInterrupted: false });
  const workspace = Object.assign(Object.create(Workspace.prototype), {
    store,
    controller: { dataDir: '' },
    folderAvailability: new Map(),
    tastes: { list: () => store.list('taste-test') },
  }) as Workspace;
  const revision = () => db.prepare('SELECT n FROM workspace_revision WHERE id=1').get()!.n;
  // Spy on SQL as well as public collections: includes dispatch and pinned-message reads.
  const reads = t.mock.method(db, 'prepare');
  const collectionReads = () =>
    reads.mock.calls.filter(
      ({ arguments: args }) => /SELECT/i.test(String(args[0])) && /workspace_records/i.test(String(args[0])),
    ).length;
  return { db, store, workspace, revision, collectionReads };
}
for (const kind of skippedKinds)
  for (const operation of ['insert', 'update', 'delete'])
    test(`skipped ${kind}: ${operation} keeps revision and cached collections`, (t) => {
      const { db, store, workspace, revision, collectionReads } = fixture(t);
      if (operation !== 'insert') store.save(kind, 'synthetic', '', { id: 'synthetic' });
      workspace.state();
      const before = revision(),
        reads = collectionReads();
      if (operation === 'delete') db.prepare('DELETE FROM workspace_records WHERE kind=?').run(kind);
      else store.save(kind, 'synthetic', '', { id: 'synthetic', updated: true });
      assert.equal(revision(), before);
      workspace.state();
      assert.equal(collectionReads(), reads);
    });
for (const kind of readKinds)
  for (const operation of ['insert', 'update', 'delete'])
    test(`read ${kind}: ${operation} invalidates exactly once`, (t) => {
      const { db, store, workspace, revision, collectionReads } = fixture(t);
      const value = { id: 'synthetic', path: '', createdAt: '', updatedAt: '', plan: [], input: {} };
      if (operation !== 'insert') store.save(kind, 'synthetic', '', value);
      workspace.state();
      const before = Number(revision()),
        reads = collectionReads();
      if (operation === 'delete') db.prepare('DELETE FROM workspace_records WHERE kind=?').run(kind);
      else store.save(kind, 'synthetic', '', value);
      assert.equal(revision(), before + 1);
      workspace.state();
      assert.ok(collectionReads() > reads);
      const rebuilt = collectionReads();
      workspace.state();
      assert.equal(collectionReads(), rebuilt);
    });
test('kind transitions invalidate in both directions but skip-to-skip stays cached', (t) => {
  const { db, store, workspace, revision, collectionReads } = fixture(t);
  store.save('maintainer-desk-state', 'synthetic', '', { id: 'synthetic' });
  workspace.state();
  let previous = 'maintainer-desk-state';
  for (const next of ['maintainer-state', 'conversation-folder', 'maintainer-desk-state']) {
    const before = Number(revision()),
      reads = collectionReads();
    db.prepare('UPDATE workspace_records SET kind=? WHERE kind=?').run(next, previous);
    const changed = next === 'conversation-folder' || previous === 'conversation-folder';
    assert.equal(revision(), before + Number(changed));
    workspace.state();
    assert.equal(collectionReads() > reads, changed);
    previous = next;
  }
});
for (const legacy of [false, true])
  test(`${legacy ? 'previous triggers upgrade' : 'fresh database'} installs skip migration once`, (t) => {
    const { db, store, revision } = fixture(t);
    if (legacy) {
      db.prepare(
        "DELETE FROM workspace_records WHERE kind='migration' AND id='workspace-revision-skip-kinds-v2'",
      ).run();
      for (const op of ['INSERT', 'UPDATE', 'DELETE']) {
        const name = 'workspace_revision_' + op.toLowerCase();
        db.exec(
          `DROP TRIGGER ${name}; CREATE TRIGGER ${name} AFTER ${op} ON workspace_records BEGIN UPDATE workspace_revision SET n=n+1 WHERE id=1; END`,
        );
      }
      store.save('maintainer-desk-state', 'existing', '', {});
      new WorkspaceStore(db, { recoverInterrupted: false });
    }
    assert.equal(store.get<{ completed: boolean }>('migration', 'workspace-revision-skip-kinds-v2')?.completed, true);
    const before = revision();
    new WorkspaceStore(db, { recoverInterrupted: false });
    assert.equal(revision(), before);
    for (const kind of skippedKinds) {
      store.save(kind, 'synthetic', '', {});
      store.save(kind, 'synthetic', '', { updated: true });
      db.prepare('DELETE FROM workspace_records WHERE kind=? AND id=?').run(kind, 'synthetic');
    }
    assert.equal(revision(), before);
    store.save('conversation-folder', 'synthetic', '', {});
    assert.equal(revision(), Number(before) + 1);
  });
