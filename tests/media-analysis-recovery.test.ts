import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { MediaAnalysisManager } from '../src/server/media-analysis.ts';
import type { MediaDecoder } from '../src/server/media-decoder.ts';

const signature = { time: 0, hash: '1234567890abcdef', texture: 0, colours: Array(12).fill(0.25) };
function decoder(image: MediaDecoder['image'] = async () => signature): MediaDecoder {
  return {
    description: 'synthetic recovery fixture',
    image,
    probe: async () => ({ duration: 23 }),
    frame: async () => signature,
  };
}
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pugport-media-recovery-')));
  const folder = join(root, 'media');
  await mkdir(folder);
  await writeFile(join(folder, 'synthetic.jpg'), 'synthetic payload');
  const data = join(root, 'data');
  const managers: MediaAnalysisManager[] = [];
  t.after(async () => {
    for (const manager of managers) await manager.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    folder,
    data,
    open: (options: ConstructorParameters<typeof MediaAnalysisManager>[1] = {}) => {
      const manager = new MediaAnalysisManager(data, { decoder: decoder(), ...options });
      managers.push(manager);
      return manager;
    },
    editSnapshot: (edit: (db: DatabaseSync) => void) => {
      const db = new DatabaseSync(join(data, 'media-analysis', 'checkpoint.sqlite'));
      try {
        edit(db);
      } finally {
        db.close();
      }
    },
  };
}

test('shutdown makes only unfinished active jobs recoverable and recovery retains the same job and records', async (t) => {
  const f = await fixture(t);
  let entered!: () => void;
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const manager = f.open({
    decoder: decoder(async (_path, signal) => {
      entered();
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      signal.throwIfAborted();
      return signature;
    }),
  });
  const active = await manager.start(
    { folders: [f.folder], engine: 'legacy' },
    { conversationId: 'one', projectPath: f.folder },
  );
  await reached;
  const queued = await manager.start(
    { folders: [f.folder], engine: 'legacy' },
    { conversationId: 'two', projectPath: f.folder },
  );
  await manager.close();
  const reopened = f.open();
  assert.deepEqual(
    reopened.recoverable().map((job) => job.id),
    [active.id, queued.id],
  );
  assert.equal(reopened.status(active.id).recovery?.reason, 'shutdown');
  assert.equal(reopened.status(queued.id).recovery?.reason, 'shutdown');
  assert.equal(reopened.status(active.id).counts.files, 1);
  assert.equal(reopened.status(active.id).status, 'interrupted', 'constructor never starts an unvalidated owner');
  reopened.resume(active.id, { conversationId: 'one', projectPath: f.folder });
  const done = await reopened.wait(active.id);
  assert.equal(done.id, active.id);
  assert.equal(done.status, 'completed');
  assert.deepEqual(done.recovery, { resumeWanted: false, reason: 'completed', previousPhase: 'fingerprinting' });
  assert.equal(done.counts.fingerprinted, 1);
  assert.deepEqual(
    reopened.recoverable().map((job) => job.id),
    [queued.id],
  );
  reopened.pause(queued.id, 'workflow');
  assert.deepEqual(reopened.recoverable(), [], 'a stopped owner clears recovery even while already interrupted');
});

test('explicit user and workflow pauses and cancelled jobs stay stopped after exit', async (t) => {
  const f = await fixture(t);
  const manager = f.open();
  const user = await manager.start({ folders: [f.folder], engine: 'legacy' });
  manager.pause(user.id);
  await manager.wait(user.id);
  const workflow = await manager.start(
    { folders: [f.folder], engine: 'legacy' },
    { conversationId: 'one', workflowId: 'work' },
  );
  manager.cancelForWorkflow('work');
  await manager.wait(workflow.id);
  const closed = await manager.start({ folders: [f.folder], engine: 'legacy' });
  manager.cancel(closed.id);
  await manager.wait(closed.id);
  await manager.close();
  const reopened = f.open();
  assert.deepEqual(reopened.recoverable(), []);
  assert.equal(reopened.status(user.id).recovery?.reason, 'user');
  assert.equal(reopened.status(workflow.id).recovery?.reason, 'workflow');
  assert.equal(reopened.status(closed.id).status, 'cancelled');
  assert.equal(reopened.status(closed.id).recovery?.resumeWanted, false);
  assert.throws(() => reopened.resume(closed.id), /closed/);
});

test('a crash snapshot recovers active work, while a pause intent persisted before status wins', async (t) => {
  const f = await fixture(t);
  const manager = f.open();
  const recover = await manager.start({ folders: [f.folder], engine: 'legacy' });
  await manager.wait(recover.id);
  const pause = await manager.start({ folders: [f.folder], engine: 'legacy' });
  await manager.wait(pause.id);
  const failed = await manager.start({ folders: [f.folder], engine: 'legacy' });
  await manager.wait(failed.id);
  await manager.close();
  f.editSnapshot((db) => {
    db.prepare(
      "UPDATE jobs SET status='running',phase='comparing',audit=json_set(audit,'$.recovery',json(?)) WHERE id=?",
    ).run(JSON.stringify({ resumeWanted: true, reason: 'active' }), recover.id);
    db.prepare("UPDATE jobs SET status='running',audit=json_set(audit,'$.recovery',json(?)) WHERE id=?").run(
      JSON.stringify({ resumeWanted: false, reason: 'user' }),
      pause.id,
    );
    db.prepare("UPDATE jobs SET status='failed',audit=json_set(audit,'$.recovery',json(?)) WHERE id=?").run(
      JSON.stringify({ resumeWanted: false, reason: 'failed' }),
      failed.id,
    );
  });
  const reopened = f.open();
  assert.deepEqual(
    reopened.recoverable().map((job) => job.id),
    [recover.id],
  );
  assert.equal(reopened.status(recover.id).recovery?.reason, 'crash');
  assert.equal(reopened.status(recover.id).recovery?.previousPhase, 'comparing');
  assert.equal(reopened.status(pause.id).status, 'interrupted');
  assert.equal(reopened.status(pause.id).recovery?.reason, 'user');
  assert.equal(reopened.status(failed.id).status, 'failed');
  reopened.resume(recover.id);
  const done = await reopened.wait(recover.id);
  assert.equal(done.resume?.savedFingerprints, 1);
  assert.equal(done.resume?.previousPhase, 'comparing');
  assert.equal(done.counts.fingerprinted, 1);
});

test('legacy shutdown/crash messages migrate narrowly without reviving legacy pauses or the closed dense task', async (t) => {
  const f = await fixture(t);
  const manager = f.open();
  const ids: string[] = [];
  for (let index = 0; index < 5; index++) {
    const job = await manager.start({ folders: [f.folder], engine: 'legacy' });
    await manager.wait(job.id);
    ids.push(job.id);
  }
  await manager.close();
  f.editSnapshot((db) => {
    for (const [index, progress] of [
      '应用关闭，分析进度已保留。',
      '应用退出时分析尚未完成；可从本地记录续跑。',
      '已暂停本地分析，证据保留，可从此处续跑。',
      '应用关闭，分析进度已保留。',
      'unknown older stop reason',
    ].entries())
      db.prepare(
        "UPDATE jobs SET status=?,phase='paused',progress=?,audit=json_remove(audit,'$.recovery') WHERE id=?",
      ).run(index === 3 ? 'cancelled' : 'interrupted', progress, ids[index]!);
  });
  const reopened = f.open();
  assert.deepEqual(
    reopened.recoverable().map((job) => job.id),
    ids.slice(0, 2),
  );
  assert.equal(reopened.status(ids[0]!).recovery?.reason, 'shutdown');
  assert.equal(reopened.status(ids[1]!).recovery?.reason, 'crash');
  assert.equal(reopened.status(ids[3]!).status, 'cancelled');
  reopened.pause(ids[0]!);
  await reopened.close();
  const again = f.open();
  assert.deepEqual(
    again.recoverable().map((job) => job.id),
    [ids[1]],
  );
  assert.equal(again.status(ids[0]!).recovery?.reason, 'user');
});
