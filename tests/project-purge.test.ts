import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { ProjectPurger } from '../src/server/project-purge.ts';
import { Store } from '../src/server/store.ts';
import { WorkspaceStore } from '../src/server/workspace-store.ts';
import { memoryProjectDirectory } from '../src/server/local-memory.ts';
import { memoryVectorCleanupPaths } from '../src/server/memory-vectors.ts';
import type { Conversation, Project } from '../src/shared/types.ts';
import type { Routine } from '../src/shared/scheduled-tasks.ts';
import { ScheduledTasks } from '../src/server/scheduled-tasks.ts';
import { appendLaneEvent, laneEventsPath } from '../src/server/lane-events.ts';
import { seedTraceContextRows, traceContextRowCounts } from './helpers/trace-context-rows.ts';

function fixture(t: TestContext) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'pugport-purge-')));
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
    name: 'Removed fixture',
    path: join(root, 'original'),
    createdAt: '',
    updatedAt: '',
    removedAt: '2026-10-25T00:00:00Z',
  };
  mkdirSync(project.path);
  writeFileSync(join(project.path, 'keep.txt'), 'original contents');
  store.save('project', project.id, project.id, project);
  const conversations = Array.from({ length: 2 }, (_, index): Conversation => ({
    id: randomUUID(),
    projectId: project.id,
    title: `Chat ${index}`,
    createdAt: '',
    updatedAt: '',
    deletedAt: project.removedAt,
    removedWithProject: project.id,
  }));
  for (const conversation of conversations) store.save('conversation', conversation.id, project.id, conversation);
  let busy = false,
    mediaFailure = false,
    done = 0;
  let quiesce = async (_id: string) => {};
  const purger = new ProjectPurger({
    store,
    dataDir: data,
    assertIdle: (_project, ids) => {
      if (ids.some((id) => store.conversationBusy(id))) throw Error('Synthetic active task');
      if (busy) throw Error('Synthetic active task');
    },
    quiesce: (id) => quiesce(id),
    purgeMedia: () => {
      if (mediaFailure) throw Error('Synthetic checkpoint busy');
    },
    finished: () => {
      done++;
    },
  });
  const put = (path: string, contents = 'owned') => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
    return path;
  };
  t.after(() => {
    db.close();
    assert.equal(dirname(root).toLowerCase(), realpathSync.native(tmpdir()).toLowerCase());
    assert.ok(basename(root).startsWith('pugport-purge-'));
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    data,
    db,
    store,
    project,
    conversations,
    purger,
    put,
    busy: (value: boolean) => {
      busy = value;
    },
    failMedia: (value: boolean) => {
      mediaFailure = value;
    },
    quiesce: (work: typeof quiesce) => {
      quiesce = work;
    },
    done: () => done,
  };
}

test('purge removes only owned project copies and records while preserving shared attachments and global installations', async (t) => {
  const f = fixture(t);
  const otherProject = randomUUID();
  const event = { at: 'synthetic', type: 'lane-created' as const, lane: 'lane' };
  appendLaneEvent(f.data, f.project.id, event);
  appendLaneEvent(f.data, otherProject, event);
  const [one, two] = f.conversations;
  for (const item of f.conversations) f.store.addMessage(item.id, 'user', 'private synthetic message');
  f.store.save('mode-instance', 'mode-instance', one!.id, { state: { private: 'notes' } });
  f.store.save('mode-manifest', 'global-mode', 'conversation-modes', { title: 'keep' });
  f.store.save('mode-installation', 'global-mode', 'conversation-modes', { version: '1' });
  f.store.save('hindsight-retired-bank', 'bank', f.project.id, { projectId: f.project.id });
  f.store.save('hindsight-generation', f.project.id, f.project.id, { id: 'keep-generation' });
  const workflowId = randomUUID(),
    runId = randomUUID();
  f.store.save('workflow', workflowId, one!.id, {
    id: workflowId,
    projectId: f.project.id,
    conversationId: one!.id,
    status: 'completed',
    runIds: [runId],
  });
  f.db.db
    .prepare('INSERT INTO runs VALUES(?,?,?)')
    .run(runId, '', JSON.stringify({ id: runId, workflowId, nativeSessionId: 'Old-Session', status: 'completed' }));
  f.db.db.prepare('INSERT INTO run_audit_events VALUES(?,?,?)').run(runId, 0, '{}');
  seedTraceContextRows(f.db.db, [runId, 'surviving-run']);
  const exclusive = `${randomUUID()}.txt`,
    shared = `${randomUUID()}.txt`;
  const originalExclusive = f.put(join(f.data, 'attachments', exclusive), 'secret');
  const originalShared = f.put(join(f.data, 'attachments', shared), 'shared');
  for (const [conversation, fileName] of [
    [one!, exclusive],
    [one!, shared],
    [two!, exclusive],
  ] as const)
    f.store.save('attachment', randomUUID(), conversation.id, { conversationId: conversation.id, fileName });
  f.store.save('attachment', 'outside-reference', 'outside-chat', { conversationId: 'outside-chat', fileName: shared });
  const memory = f.put(join(memoryProjectDirectory(f.data, f.project.id), 'conversations', one!.id, 'history.jsonl'));
  const member = f.put(join(f.data, 'member-results', one!.id, `${workflowId}.md`));
  const missing = f.put(join(f.data, 'workspaces', 'missing-folder', two!.id, 'generated.txt'));
  const vectors = memoryVectorCleanupPaths(f.project.id);
  for (const path of vectors.paths) f.put(path);
  const otherVector = f.put(join(vectors.root, 'unrelated.bin'));
  const preview = await f.purger.preview(f.project.id);
  assert.equal(preview.canPurge, true);
  assert.equal(preview.conversations, 2);
  assert.equal(preview.attachments, 3);
  assert.ok(preview.managedBytes > 0);
  const result = await f.purger.purge(f.project.id, preview.token);
  assert.equal(existsSync(laneEventsPath(f.data, f.project.id)), false);
  assert.equal(existsSync(laneEventsPath(f.data, otherProject)), true);
  assert.equal(result.sharedFilesKept, 1);
  assert.equal(result.databaseSpace, 'reusable');
  assert.ok(result.freedBytes > 0);
  for (const path of [originalExclusive, memory, member, missing, ...vectors.paths])
    assert.equal(existsSync(path), false, path);
  for (const path of [originalShared, otherVector, join(f.project.path, 'keep.txt')])
    assert.equal(existsSync(path), true, path);
  assert.equal(readFileSync(join(f.project.path, 'keep.txt'), 'utf8'), 'original contents');
  for (const [kind, id] of [
    ['project', f.project.id],
    ['conversation', one!.id],
    ['conversation', two!.id],
    ['workflow', workflowId],
    ['mode-instance', 'mode-instance'],
    ['project-purge', f.project.id],
  ])
    assert.equal(f.store.get(kind!, id!), undefined);
  assert.equal(f.db.db.prepare('SELECT 1 FROM runs WHERE id=?').get(runId), undefined);
  assert.equal(f.db.db.prepare('SELECT 1 FROM run_audit_events WHERE run_id=?').get(runId), undefined);
  const none = Object.fromEntries(Object.keys(traceContextRowCounts(f.db.db, runId)).map((table) => [table, 0]));
  assert.deepEqual(traceContextRowCounts(f.db.db, runId), none, 'Trace › Context rows go with their run');
  assert.ok(
    Object.values(traceContextRowCounts(f.db.db, 'surviving-run')).every((count) => count === 1),
    'rows of runs outside the purge stay',
  );
  assert.ok(f.store.get('native-session-exclusion', 'old-session'));
  assert.ok(f.store.get('mode-manifest', 'global-mode'));
  assert.ok(f.store.get('mode-installation', 'global-mode'));
  assert.ok(f.store.get('attachment', 'outside-reference'));
  assert.ok(f.store.get('hindsight-retired-bank', 'bank'));
  assert.ok(f.store.get('hindsight-generation', f.project.id));
  assert.equal(f.done(), 1);
});

test('busy tasks, live workflows and changed scopes reject before creating a purge marker or deleting files', async (t) => {
  const f = fixture(t);
  const file = f.put(join(f.data, 'member-results', f.conversations[0]!.id, 'notes.md'));
  f.busy(true);
  assert.equal((await f.purger.preview(f.project.id)).canPurge, false);
  f.busy(false);
  const preview = await f.purger.preview(f.project.id);
  f.store.addMessage(f.conversations[0]!.id, 'user', 'new data');
  await assert.rejects(f.purger.purge(f.project.id, preview.token), /已有变化/);
  assert.equal(f.store.get('project-purge', f.project.id), undefined);
  f.store.save('workflow', 'waiting', f.conversations[0]!.id, {
    id: 'waiting',
    projectId: f.project.id,
    status: 'waiting-resource',
  });
  assert.equal((await f.purger.preview(f.project.id)).canPurge, false);
  assert.equal(existsSync(file), true);
  f.project.removedAt = undefined;
  f.store.save('project', f.project.id, f.project.id, f.project);
  await assert.rejects(f.purger.preview(f.project.id), /只能清空已/);
});

test('nested links are detached without visiting their target', { timeout: 10000 }, async (t) => {
  const f = fixture(t);
  const outside = join(f.root, 'outside');
  const kept = f.put(join(outside, 'keep.txt'), 'outside sentinel');
  const memberRoot = join(f.data, 'member-results');
  const own = join(memberRoot, f.conversations[0]!.id);
  mkdirSync(own, { recursive: true });
  symlinkSync(outside, join(own, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  const preview = await f.purger.preview(f.project.id);
  assert.equal(preview.canPurge, true);
  await f.purger.purge(f.project.id, preview.token);
  assert.equal(readFileSync(kept, 'utf8'), 'outside sentinel');
  assert.equal(existsSync(own), false);
});

test('a redirected managed root is refused before any data is removed', { timeout: 10000 }, async (t) => {
  const g = fixture(t);
  const outside = join(g.root, 'outside');
  const kept = g.put(join(outside, 'keep.txt'), 'outside sentinel');
  symlinkSync(outside, join(g.data, 'member-results'), process.platform === 'win32' ? 'junction' : 'dir');
  const refused = await g.purger.preview(g.project.id);
  assert.equal(refused.canPurge, false);
  assert.match(refused.blockedReason!, /链接/);
  await assert.rejects(g.purger.purge(g.project.id, refused.token), /链接/);
  assert.equal(g.store.get('project-purge', g.project.id), undefined);
  assert.equal(readFileSync(kept, 'utf8'), 'outside sentinel');
});

test('partial failure retains records and a durable retry marker, then an explicit retry completes', async (t) => {
  const f = fixture(t);
  const file = f.put(join(f.data, 'member-results', f.conversations[0]!.id, 'notes.md'));
  const preview = await f.purger.preview(f.project.id);
  f.failMedia(true);
  await assert.rejects(f.purger.purge(f.project.id, preview.token), /checkpoint busy/);
  assert.equal(existsSync(file), false);
  assert.ok(f.store.get('project', f.project.id));
  assert.ok(f.store.get('conversation', f.conversations[0]!.id));
  assert.ok(f.store.get('project-purge', f.project.id));
  assert.equal(f.done(), 0);
  const retry = await f.purger.preview(f.project.id);
  assert.equal(retry.partial, true);
  assert.equal(retry.canPurge, true);
  f.failMedia(false);
  await f.purger.purge(f.project.id, retry.token);
  assert.equal(f.store.get('project', f.project.id), undefined);
});

test('an app-created chat workspace is retained when another project shares its directory', async (t) => {
  const f = fixture(t);
  f.project.scope = 'chat';
  f.project.path = join(f.data, 'workspaces', randomUUID());
  const file = f.put(join(f.project.path, 'result.md'));
  f.store.save('project', f.project.id, f.project.id, f.project);
  const other = { ...f.project, id: randomUUID(), name: 'Other', removedAt: undefined };
  f.store.save('project', other.id, other.id, other);
  const preview = await f.purger.preview(f.project.id);
  const result = await f.purger.purge(f.project.id, preview.token);
  assert.equal(existsSync(file), true);
  assert.ok(result.warnings?.some((warning) => warning.includes('另一个项目')));
  assert.ok(f.store.get('project', other.id));
});

test('purging chat records retains the repository backing managed child worktrees', async (t) => {
  const f = fixture(t);
  f.project.scope = 'chat';
  f.project.path = join(f.data, 'workspaces', randomUUID());
  const git = f.put(join(f.project.path, '.git', 'config'), 'synthetic repository metadata');
  f.store.save('project', f.project.id, f.project.id, f.project);
  const id = randomUUID();
  const child = f.put(join(f.data, 'workspaces', 'managed-children', id, 'checkout', 'result.txt'));
  f.store.save('workflow', id, f.conversations[0]!.id, {
    id,
    projectId: f.project.id,
    conversationId: f.conversations[0]!.id,
    status: 'completed',
    runIds: [],
    executionWorkspaceId: id,
  });
  const preview = await f.purger.preview(f.project.id);
  const result = await f.purger.purge(f.project.id, preview.token);
  assert.equal(existsSync(git), true);
  assert.equal(existsSync(child), true);
  assert.ok(result.warnings?.some((warning) => warning.includes('Git 仓库')));
  assert.equal(f.store.get('project', f.project.id), undefined);
});

test('an unshared app-created chat workspace is permanently removed', async (t) => {
  const g = fixture(t);
  g.project.scope = 'chat';
  g.project.path = join(g.data, 'workspaces', randomUUID());
  g.put(join(g.project.path, 'result.md'));
  g.store.save('project', g.project.id, g.project.id, g.project);
  const own = await g.purger.preview(g.project.id);
  await g.purger.purge(g.project.id, own.token);
  assert.equal(existsSync(g.project.path), false);
});

test('purging waits for the last export and refuses another purge while it owns the cleanup', async (t) => {
  const f = fixture(t);
  let release!: () => void;
  f.quiesce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const memory = join(memoryProjectDirectory(f.data, f.project.id), 'LATEST.md');
  const preview = await f.purger.preview(f.project.id);
  const deleting = f.purger.purge(f.project.id, preview.token);
  for (let tries = 0; !release && tries < 100; tries++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(release);
  assert.equal((await f.purger.preview(f.project.id)).canPurge, false);
  await assert.rejects(f.purger.purge(f.project.id, preview.token), /正在清空/);
  f.put(memory, 'last writer');
  release();
  await deleting;
  assert.equal(existsSync(memory), false);
});

test('a registered original folder overlapping any managed target is never deleted', async (t) => {
  const f = fixture(t);
  const source = join(f.data, 'member-results', f.conversations[0]!.id);
  const sentinel = f.put(join(source, 'source.ts'), 'original source');
  f.project.path = source;
  f.store.save('project', f.project.id, f.project.id, f.project);
  const preview = await f.purger.preview(f.project.id);
  assert.equal(preview.canPurge, false);
  assert.match(preview.blockedReason!, /原项目文件夹重叠/);
  assert.equal(readFileSync(sentinel, 'utf8'), 'original source');
  assert.equal(f.store.get('project-purge', f.project.id), undefined);
});

test('another registered original folder inside a managed tree also prevents deletion', async (t) => {
  const f = fixture(t);
  const source = join(f.data, 'member-results', f.conversations[0]!.id, 'source');
  const sentinel = f.put(join(source, 'source.ts'), 'other project original');
  const alias = join(f.root, 'source-alias');
  symlinkSync(source, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const other = { ...f.project, id: randomUUID(), path: alias, removedAt: undefined };
  f.store.save('project', other.id, other.id, other);
  const preview = await f.purger.preview(f.project.id);
  assert.equal(preview.canPurge, false);
  assert.match(preview.blockedReason!, /原项目文件夹重叠/);
  assert.equal(readFileSync(sentinel, 'utf8'), 'other project original');
});

test('stale upload ownership deletes both temporary and renamed private bytes after a restart', async (t) => {
  const f = fixture(t);
  const id = randomUUID();
  const temporary = f.put(join(f.data, 'attachments', `${id}.tmp`), 'interrupted private upload');
  const renamed = f.put(join(f.data, 'attachments', `${id}.txt`), 'renamed before acknowledgment');
  f.store.save('attachment-upload', id, f.conversations[0]!.id, {
    conversationId: f.conversations[0]!.id,
    fileName: `${id}.tmp`,
    destinationFileName: `${id}.txt`,
  });
  const preview = await f.purger.preview(f.project.id);
  assert.equal(preview.attachments, 0, 'an unfinished upload is not a saved attachment');
  assert.equal(preview.managedFiles, 2);
  await f.purger.purge(f.project.id, preview.token);
  assert.equal(existsSync(temporary), false);
  assert.equal(existsSync(renamed), false);
});

test('standalone distillation and taste-test runs are purged by explicit ownership while financial history is retained', async (t) => {
  const f = fixture(t);
  const distillationRun = randomUUID(),
    tasteRun = randomUUID(),
    otherRun = randomUUID();
  const attempts = [
    { projectId: f.project.id, runId: distillationRun, status: 'completed' },
    { projectId: randomUUID(), runId: otherRun, status: 'completed' },
  ];
  f.store.save('memory-distillation-history', 'global', 'global', { attempts });
  f.store.save('taste-test', 'taste', f.conversations[0]!.id, { candidates: [{ runId: tasteRun }] });
  for (const id of [distillationRun, tasteRun, otherRun]) {
    const value = JSON.stringify({
      id,
      status: 'completed',
      prompt: 'private synthetic sample',
      output: 'private synthetic answer',
    });
    f.db.db.prepare('INSERT INTO runs VALUES(?,?,?)').run(id, '', value);
    f.db.db.prepare('INSERT INTO run_summaries VALUES(?,?,?)').run(id, '', value);
    f.db.db.prepare('INSERT INTO run_audit_events VALUES(?,?,?)').run(id, 0, '{}');
  }
  const preview = await f.purger.preview(f.project.id);
  await f.purger.purge(f.project.id, preview.token);
  for (const id of [distillationRun, tasteRun]) {
    assert.equal(f.db.db.prepare('SELECT 1 FROM runs WHERE id=?').get(id), undefined);
    assert.equal(f.db.db.prepare('SELECT 1 FROM run_summaries WHERE id=?').get(id), undefined);
    assert.equal(f.db.db.prepare('SELECT 1 FROM run_audit_events WHERE run_id=?').get(id), undefined);
  }
  assert.ok(f.db.db.prepare('SELECT 1 FROM runs WHERE id=?').get(otherRun));
  assert.ok(f.db.db.prepare('SELECT 1 FROM run_summaries WHERE id=?').get(otherRun));
  assert.deepEqual(f.store.get('memory-distillation-history', 'global'), { attempts });
});

test('purge previews and pauses only associated routines, including an unlaunched path alias, without deleting their configuration', async (t) => {
  const f = fixture(t);
  const alias = join(f.root, 'original-alias');
  symlinkSync(f.project.path, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const base: Routine = {
    id: 'bound',
    name: 'Keep routine',
    prompt: 'Keep configured task',
    enabled: true,
    schedule: { type: 'daily', time: '09:00' },
    permissionMode: 'read-only',
    createdAt: '',
    nextRunAt: '2026-10-25T00:00:00Z',
    history: [{ at: '', workflowId: 'old', status: 'completed' }],
    projectId: f.project.id,
  };
  const unlaunched = { ...base, id: 'unlaunched', projectId: undefined, projectPath: alias, history: [] };
  const unrelated = {
    ...base,
    id: 'unrelated',
    projectId: undefined,
    projectPath: join(f.root, 'different'),
    nextRunAt: '2026-10-26T09:00:00Z',
  };
  delete unlaunched.projectId;
  delete unrelated.projectId;
  for (const routine of [base, unlaunched, unrelated]) f.store.save('routine', routine.id, routine.id, routine);
  const preview = await f.purger.preview(f.project.id);
  assert.equal(preview.scheduledTasks, 2);
  const result = await f.purger.purge(f.project.id, preview.token);
  assert.equal(result.scheduledTasks, 2);
  assert.deepEqual(f.store.get('routine', base.id), { ...base, enabled: false });
  assert.deepEqual(f.store.get('routine', unlaunched.id), { ...unlaunched, enabled: false });
  assert.deepEqual(f.store.get('routine', unrelated.id), unrelated);
  let starts = 0;
  const tasks = new ScheduledTasks(
    {
      store: f.store,
      controller: { store: f.db },
      createProject: async () => {
        starts++;
        throw Error('Unexpected background recreation');
      },
    } as unknown as ConstructorParameters<typeof ScheduledTasks>[0],
    () => new Date('2026-10-25T12:00:00Z'),
  );
  try {
    await tasks.tick();
    assert.equal(starts, 0);
  } finally {
    await tasks.close();
  }
});
