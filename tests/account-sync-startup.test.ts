import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceStore } from '../src/server/workspace-store.ts';
import { SyncStore } from '../src/server/account-sync-store.ts';

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'account-startup-'));
  const path = join(dir, 'workspace.sqlite');
  const db = new DatabaseSync(path);
  const workspace = new WorkspaceStore(db, { recoverInterrupted: false });
  const local = new SyncStore(workspace, dir);
  t.after(() => {
    local.dispose?.();
    if (db.isOpen) db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, path, db, workspace, local };
}

test('activate reconciles only changed rows in a 20k-record workspace and detects offline deletes', async (t) => {
  const { db, workspace, local } = fixture(t);
  await local.activate('synthetic-user');
  local.suppress(() => {
    for (let i = 0; i < 20_000; i++) {
      const value = { id: `p${i}`, name: `Project ${i}` };
      workspace.save('project', value.id, '', value, '2000-01-01T00:00:00.000Z');
      local.setBase('project', value.id, i + 1, { owner: '', value, deleted: false }, 'synthetic-device');
    }
  });
  local.deactivate();
  workspace.save('project', 'p5', '', { id: 'p5', name: 'Changed' });
  workspace.deleteRecord('project', 'p9');
  let processed = 0;
  const filtered = local.filtered.bind(local);
  local.filtered = (kind, value) => {
    processed++;
    return filtered(kind, value);
  };
  const start = performance.now();
  await local.activate('synthetic-user');
  const elapsed = performance.now() - start;
  t.diagnostic(`Incremental activate: ${elapsed.toFixed(1)}ms, ${processed} filtered rows, 20,000 stored records`);
  assert.ok(processed <= 3, `processed ${processed} rows instead of only changed rows`);
  assert.ok(elapsed < 10_000, `incremental activate took ${elapsed}ms`);
  assert.deepEqual(
    local.pending().map(({ id, deleted }) => ({ id, deleted })),
    [
      { id: 'p5', deleted: false },
      { id: 'p9', deleted: true },
    ],
  );
  assert.equal(db.prepare('SELECT enabled FROM sync_state').get()?.enabled, 1);
});

test('opening a second WorkspaceStore preserves active sync triggers', async (t) => {
  const { path, local } = fixture(t);
  await local.activate('synthetic-user');
  const second = new DatabaseSync(path);
  try {
    const workspace = new WorkspaceStore(second, { recoverInterrupted: false });
    workspace.save('project', 'second', '', { id: 'second', name: 'Synthetic' });
    assert.equal(local.state()?.enabled, 1);
    assert.equal(local.pendingOne('project', 'second')?.value.name, 'Synthetic');
  } finally {
    second.close();
  }
});

test('cloud reset followed by deactivation re-enrolls unchanged local records', async (t) => {
  const { workspace, local } = fixture(t);
  workspace.save('project', 'old', '', { id: 'old', name: 'Existing project' }, '2000-01-01T00:00:00.000Z');
  await local.activate('synthetic-user');
  local.resetAfterCloudDeletion();
  local.deactivate();
  await local.activate('synthetic-user');
  assert.equal(local.pendingOne('project', 'old')?.value.name, 'Existing project');
});

test('first merge backup yields the event loop and removes incognito content from disk', async (t) => {
  const { workspace, local } = fixture(t);
  workspace.save('conversation', 'private', '', { id: 'private', incognito: true, title: 'PRIVATE_TITLE_SENTINEL' });
  workspace.save('message', 'private-message', 'private', {
    id: 'private-message',
    content: 'PRIVATE_MESSAGE_SENTINEL',
  });
  workspace.save('human-message', 'private-message', 'private', { id: 'private-message' });
  workspace.save('conversation', 'public', '', { id: 'public', title: 'Public' });
  let yielded = false;
  setImmediate(() => {
    yielded = true;
  });
  await local.activate('synthetic-user');
  assert.equal(yielded, true);
  const copy = new DatabaseSync(local.backupPath!);
  try {
    assert.equal(
      copy.prepare("SELECT COUNT(*) AS n FROM workspace_records WHERE id='private' OR owner='private'").get()?.n,
      0,
    );
    assert.equal(copy.prepare("SELECT COUNT(*) AS n FROM workspace_records WHERE id='public'").get()?.n, 1);
  } finally {
    copy.close();
  }
  assert.equal(readFileSync(local.backupPath!).includes(Buffer.from('PRIVATE_MESSAGE_SENTINEL')), false);
  assert.equal(readFileSync(local.backupPath!).includes(Buffer.from('PRIVATE_TITLE_SENTINEL')), false);
  assert.ok(workspace.get('conversation', 'private'));
});

test('backup retention starts at first successful sync and tracks backups across account changes', async (t) => {
  const { db, local } = fixture(t);
  await local.activate('synthetic-a');
  const first = local.backupPath!;
  await local.markSuccessfulSync();
  const success = db.prepare('SELECT first_success_at FROM sync_backups WHERE path=?').get(first)?.first_success_at;
  await local.markSuccessfulSync();
  assert.equal(
    db.prepare('SELECT first_success_at FROM sync_backups WHERE path=?').get(first)?.first_success_at,
    success,
  );
  await local.activate('synthetic-b', true);
  const second = local.backupPath!;
  db.prepare('UPDATE sync_backups SET first_success_at=? WHERE path=?').run(Date.now() - 15 * 86400_000, first);
  await local.cleanupBackups();
  assert.equal(existsSync(first), false);
  assert.equal(existsSync(second), true);
  await local.markSuccessfulSync();
  db.prepare('UPDATE sync_backups SET first_success_at=? WHERE path=?').run(Date.now() - 15 * 86400_000, second);
  await local.cleanupBackups();
  assert.equal(existsSync(second), false);
  assert.equal(local.backupPath, undefined);
});

test('account-switch backup disables copied sync triggers before privacy cleanup', async (t) => {
  const { workspace, local, db } = fixture(t);
  await local.activate('synthetic-a');
  workspace.save('conversation', 'private', '', { id: 'private', title: 'PRIVATE_SWITCH_SENTINEL_TITLE' });
  workspace.save('message', 'private-message', 'private', {
    id: 'private-message',
    content: 'PRIVATE_SWITCH_SENTINEL',
  });
  for (const [kind, id, owner] of [
    ['conversation', 'private', ''],
    ['message', 'private-message', 'private'],
    ['message', 'old-deleted-message', 'private'],
  ]) {
    const payload = { owner, value: { content: 'PRIVATE_SWITCH_SENTINEL_HISTORY' }, deleted: false };
    local.setBase(kind, id, 1, payload, 'old-device');
    db.prepare('INSERT INTO sync_retained(kind,id,payload) VALUES(?,?,?)').run(kind, id, JSON.stringify(payload));
  }
  db.prepare('INSERT INTO sync_human_markers(id,owner,value) VALUES(?,?,?)').run(
    'private-message',
    'private',
    JSON.stringify({ content: 'PRIVATE_SWITCH_SENTINEL_MARKER' }),
  );
  workspace.save('conversation', 'private', '', { id: 'private', incognito: true });
  // Defensively scrub stale queued content too; the source database must stay unchanged.
  local.enqueue('message', 'old-deleted-message', {
    owner: 'private',
    value: { content: 'PRIVATE_SWITCH_SENTINEL_QUEUED' },
    deleted: true,
  });
  local.setBase('project', 'public-project', 1, { owner: '', value: { name: 'Public' }, deleted: false }, 'old-device');
  await local.activate('synthetic-b', true);
  const copy = new DatabaseSync(local.backupPath!);
  try {
    assert.equal(copy.prepare('SELECT enabled FROM sync_state').get()?.enabled, 0);
    assert.equal(copy.prepare("SELECT COUNT(*) AS n FROM sync_outbox WHERE id='private-message'").get()?.n, 0);
    for (const table of ['sync_base', 'sync_retained', 'sync_outbox', 'sync_human_markers']) {
      assert.equal(
        copy
          .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE id IN ('private','private-message','old-deleted-message')`)
          .get()?.n,
        0,
        table,
      );
    }
    assert.equal(copy.prepare("SELECT COUNT(*) AS n FROM sync_base WHERE id='public-project'").get()?.n, 1);
  } finally {
    copy.close();
  }
  assert.equal(readFileSync(local.backupPath!).includes(Buffer.from('PRIVATE_SWITCH_SENTINEL')), false);
});

test('first successful sync also starts retention for earlier account-switch backups', async (t) => {
  const { db, local } = fixture(t);
  await local.activate('synthetic-a');
  await local.activate('synthetic-b', true);
  await local.markSuccessfulSync();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sync_backups WHERE first_success_at IS NULL').get()?.n, 0);
});

test('disposing backup cleanup before database close prevents delayed database access', async (t) => {
  const { db, local } = fixture(t);
  await local.activate('synthetic-user');
  await local.markSuccessfulSync();
  db.prepare('UPDATE sync_backups SET first_success_at=?').run(Date.now() - 15 * 86400_000);
  const cleanup = local.cleanupBackups();
  local.dispose();
  db.close();
  await assert.doesNotReject(cleanup);
});

test('remote project memory and folder tombstones retain the current content before deletion', async (t) => {
  const { workspace, local, db } = fixture(t);
  await local.activate('synthetic-user');
  for (const kind of ['project', 'memory', 'conversation-folder']) {
    const value =
      kind === 'memory' ? { projectId: 'p', content: 'Original content' } : { id: 'p', name: 'Original name' };
    workspace.save(kind, 'p', '', value);
    const current = local.current(kind, 'p');
    local.suppress(() => local.apply(kind, 'p', { owner: '', value: {}, deleted: true }));
    assert.equal(workspace.get(kind, 'p'), undefined);
    const retained = db.prepare('SELECT payload FROM sync_retained WHERE kind=? AND id=?').get(kind, 'p');
    assert.ok(retained, `${kind} content was not retained`);
    assert.deepEqual(JSON.parse(retained.payload as string), current);
  }
});
