import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workspace } from '../src/server/workspace.ts';
import { WorkspaceStore, revisionSkippedKinds } from '../src/server/workspace-store.ts';

// Guard for the revision triggers: a kind state() reads must never be on the skip list, or the UI would go stale.
test('state() never reads a kind the revision triggers skip', () => {
  const directory = mkdtempSync(join(tmpdir(), 'workspace-read-kinds-'));
  const db = new DatabaseSync(join(directory, 'synthetic.sqlite'));
  const store = new WorkspaceStore(db, { recoverInterrupted: false });
  const at = (minutes = 0) => new Date(Date.parse('2026-10-29T08:00:00Z') + minutes * 60_000).toISOString();
  // Synthetic records for every branch state() walks: projects, conversations (plain, delegated, dispatch, inbox),
  // workflows with runs, messages (pinned, external), folders, a pending purge and a taste test.
  store.save('project', 'p', 'p', {
    id: 'p',
    name: 'Synthetic',
    path: join(directory, 'p'),
    createdAt: at(),
    updatedAt: at(),
  });
  store.save('project', 'gone', 'gone', {
    id: 'gone',
    name: 'Removed',
    path: join(directory, 'gone'),
    removedAt: at(),
    createdAt: at(),
    updatedAt: at(),
  });
  store.save('project-purge', 'gone', 'gone', { projectId: 'gone', status: 'pending', at: at() });
  store.save('conversation-folder', 'f', 'p', { id: 'f', projectId: 'p', name: 'Folder', createdAt: at() });
  for (const [id, extra] of [
    ['c', { folderId: 'f' }],
    ['child', { parentConversationId: 'c', delegated: true }],
    ['dispatch', { title: 'Claude Code · synthetic' }],
  ] as const)
    store.save('conversation', id, 'p', { id, projectId: 'p', createdAt: at(), updatedAt: at(), ...extra });
  store.save('external-conversation', 'x', 'dispatch', { id: 'x', conversationId: 'dispatch', createdAt: at() });
  store.save('human-message', 'h', 'c', { id: 'h', conversationId: 'c', content: 'synthetic', createdAt: at() });
  store.save('conversation-job', 'j', 'dispatch', { id: 'j', conversationId: 'dispatch', createdAt: at() });
  for (const [id, status, conversationId] of [
    ['w1', 'completed', 'c'],
    ['w2', 'running', 'c'],
    ['w3', 'waiting-approval', 'child'],
  ] as const)
    store.save('workflow', id, conversationId, {
      id,
      conversationId,
      projectId: 'p',
      userMessageId: 'm1',
      status,
      createdAt: at(),
      updatedAt: at(1),
      plan: [{ id: 's', title: 'Step', status: 'done' }],
      runIds: ['run-' + id],
      input: { content: 'synthetic' },
      delegation: { parentWorkflowId: 'w1', checkpoints: [] },
    });
  store.save('message', 'm1', 'c', {
    id: 'm1',
    conversationId: 'c',
    role: 'user',
    content: 'hi',
    createdAt: at(),
    pinned: true,
  });
  store.save('message', 'm2', 'c', {
    id: 'm2',
    conversationId: 'c',
    role: 'assistant',
    content: 'synthetic',
    workflowId: 'w1',
    createdAt: at(1),
  });
  store.save('message', 'm3', 'dispatch', {
    id: 'm3',
    conversationId: 'dispatch',
    role: 'user',
    content: 'from outside',
    external: true,
    createdAt: at(2),
  });
  store.save('taste-test', 't', 'p', { id: 't', projectId: 'p', createdAt: at() });

  const read = new Set<string>();
  const known = new Set(
    (db.prepare('SELECT DISTINCT kind FROM workspace_records').all() as { kind: string }[]).map((row) => row.kind),
  );
  for (const kind of revisionSkippedKinds) known.add(kind);
  const note = (sql: string, args: unknown[]) => {
    if (!/workspace_records/.test(sql)) return;
    for (const match of sql.matchAll(/'([a-z][a-z0-9-]*)'/g)) if (known.has(match[1]!)) read.add(match[1]!);
    for (const value of args.flat()) if (typeof value === 'string' && known.has(value)) read.add(value);
  };
  const prepare = db.prepare.bind(db);
  db.prepare = ((sql: string) => {
    const statement = prepare(sql) as StatementSync;
    for (const method of ['all', 'get', 'iterate', 'run'] as const) {
      const original = statement[method].bind(statement) as (...args: unknown[]) => unknown;
      (statement as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => {
        note(sql, args);
        return original(...args);
      };
    }
    return statement;
  }) as typeof db.prepare;
  const workspace = Object.assign(Object.create(Workspace.prototype), {
    store,
    controller: { dataDir: join(directory, 'protected'), broadcast() {} },
    folderAvailability: new Map(),
    tastes: { list: () => store.list('taste-test') },
    active: new Map(),
  }) as Workspace;
  try {
    const state = workspace.state();
    assert.ok(state.projects?.length, 'synthetic data reached the project branch');
    for (const kind of ['project', 'conversation', 'workflow', 'message'])
      assert.ok(read.has(kind), `state() was expected to read ${kind}; the guard is not seeing its reads`);
    const overlap = revisionSkippedKinds.filter((kind) => read.has(kind));
    assert.deepEqual(overlap, [], `state() reads skipped kinds: ${overlap.join(', ')}`);
  } finally {
    db.close();
  }
});
