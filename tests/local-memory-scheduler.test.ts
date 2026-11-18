import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { LocalMemoryScheduler, type MemoryJob, type MemoryResult } from '../src/server/local-memory-scheduler.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function settle() {
  // Dispatch, result delivery and finally/arming are separate promise turns.
  for (let turn = 0; turn < 12; turn++) await Promise.resolve();
}

function fixture(t: TestContext, held = false, closeTimeoutMs = 5000) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10_000 });
  const jobs: MemoryJob[] = [];
  const waiting: ReturnType<typeof deferred<MemoryResult>>[] = [];
  const delivered: { result: MemoryResult; configured: boolean }[] = [];
  let closed = 0;
  const executor = {
    execute(job: MemoryJob) {
      jobs.push(job);
      if (!held) return Promise.resolve({ projectId: job.projectId, files: [], warnings: [] });
      const pending = deferred<MemoryResult>();
      waiting.push(pending);
      return pending.promise;
    },
    async close() {
      closed++;
      for (const [index, pending] of waiting.entries())
        pending.resolve({ projectId: jobs[index].projectId, files: [], warnings: ['Fixture executor stopped.'] });
    },
  };
  const scheduler = new LocalMemoryScheduler(
    'fixture-data',
    'fixture-app',
    (result, configured) => {
      delivered.push({ result, configured });
    },
    { executor, closeTimeoutMs },
  );
  t.after(async () => {
    // Finish controlled jobs before teardown so fixture time never leaves pending work.
    for (const [index, pending] of waiting.entries())
      pending.resolve({ projectId: jobs[index].projectId, files: [], warnings: [] });
    await settle();
    await scheduler.close();
  });
  return { scheduler, jobs, waiting, delivered, closed: () => closed };
}

test('forgetting a project drops queued exports and waits for its active writer without stopping other projects', async (t) => {
  const f = fixture(t, true);
  const active = f.scheduler.flush('project-a');
  t.mock.timers.tick(0);
  await settle();
  const queued = f.scheduler.flush('project-a');
  f.scheduler.schedule('project-b');
  let forgotten = false;
  const forgetting = f.scheduler.forgetProject('project-a').then(() => {
    forgotten = true;
  });
  await settle();
  assert.equal(forgotten, false);
  assert.equal((await queued).warnings.length, 1);
  f.waiting[0]!.resolve({ projectId: 'project-a', files: ['last-copy'], warnings: [] });
  await active;
  await forgetting;
  assert.equal(forgotten, true);
  t.mock.timers.tick(2000);
  await settle();
  assert.deepEqual(
    f.jobs.map((job) => job.projectId),
    ['project-a', 'project-b'],
  );
  f.waiting[1]!.resolve({ projectId: 'project-b', files: [], warnings: [] });
  await settle();
});

test('a two-second project burst coalesces conversation updates without performing work inline', async (t) => {
  const f = fixture(t);
  f.scheduler.schedule('project-a', 'conversation-one');
  assert.equal(f.jobs.length, 0);
  t.mock.timers.tick(500);
  f.scheduler.schedule('project-a', 'conversation-one');
  f.scheduler.schedule('project-a', 'conversation-two');
  t.mock.timers.tick(1499);
  await settle();
  assert.equal(f.jobs.length, 0);
  t.mock.timers.tick(1);
  await settle();
  assert.equal(f.jobs.length, 1);
  assert.equal(f.jobs[0].projectId, 'project-a');
  assert.equal(f.jobs[0].all, false);
  assert.deepEqual(f.jobs[0].conversationIds, ['conversation-one', 'conversation-two']);
  assert.equal(f.jobs[0].dataDir, 'fixture-data');
  assert.equal(f.jobs[0].appRoot, 'fixture-app');
  assert.equal(f.jobs[0].configure, false);
  assert.equal(f.delivered.length, 1);
});

test('full-project refresh survives later partial updates and independent projects keep separate due times', async (t) => {
  const f = fixture(t);
  f.scheduler.schedule('project-a', 'conversation-one');
  f.scheduler.schedule('project-a');
  f.scheduler.schedule('project-a', 'conversation-two');
  t.mock.timers.tick(1000);
  f.scheduler.schedule('project-b', 'conversation-b');
  t.mock.timers.tick(1000);
  await settle();
  assert.equal(f.jobs.length, 1);
  assert.equal(f.jobs[0].all, true);
  assert.equal(f.jobs[0].projectId, 'project-a');
  t.mock.timers.tick(999);
  await settle();
  assert.equal(f.jobs.length, 1);
  t.mock.timers.tick(1);
  await settle();
  assert.deepEqual(
    f.jobs.map((job) => job.projectId),
    ['project-a', 'project-b'],
  );
  assert.deepEqual(f.jobs[1].conversationIds, ['conversation-b']);
  assert.equal(f.jobs[1].all, false);
});

test('manual flush bypasses debounce and shares one configured export between all callers', async (t) => {
  const f = fixture(t, true);
  f.scheduler.schedule('project-a', 'conversation-one');
  const first = f.scheduler.flush('project-a');
  const second = f.scheduler.flush('project-a', true);
  assert.equal(f.jobs.length, 0);
  t.mock.timers.tick(0);
  await settle();
  assert.equal(f.jobs.length, 1);
  assert.equal(f.jobs[0].configure, true);
  assert.equal(f.jobs[0].all, true);
  assert.deepEqual(f.jobs[0].conversationIds, ['conversation-one']);
  const result = { projectId: 'project-a', files: ['fixture-rule'], warnings: [] };
  f.waiting[0].resolve(result);
  assert.deepEqual(await first, result);
  assert.deepEqual(await second, result);
  assert.deepEqual(f.delivered, [{ result, configured: true }]);
  await settle();
  const fresh = f.scheduler.flush('project-c');
  t.mock.timers.tick(0);
  await settle();
  assert.equal(f.jobs[1].all, true);
  assert.deepEqual(f.jobs[1].conversationIds, []);
  f.waiting[1].resolve({ projectId: 'project-c', files: [], warnings: [] });
  await fresh;
});

test('updates arriving during a busy export run next and do not overwrite or overlap its in-flight job', async (t) => {
  const f = fixture(t, true);
  const first = f.scheduler.flush('project-a');
  t.mock.timers.tick(0);
  await settle();
  f.scheduler.schedule('project-a', 'new-conversation');
  f.scheduler.schedule('project-b', 'independent-conversation');
  const followup = f.scheduler.flush('project-a');
  t.mock.timers.tick(2000);
  await settle();
  assert.equal(f.jobs.length, 1);
  f.waiting[0].resolve({ projectId: 'project-a', files: ['first'], warnings: [] });
  assert.deepEqual((await first).files, ['first']);
  await settle();
  t.mock.timers.tick(0);
  await settle();
  assert.equal(f.jobs.length, 2);
  assert.equal(f.jobs[1].projectId, 'project-a');
  assert.deepEqual(f.jobs[1].conversationIds, ['new-conversation']);
  assert.notEqual(f.jobs[1].id, f.jobs[0].id);
  f.waiting[1].resolve({ projectId: 'project-a', files: ['followup'], warnings: [] });
  assert.deepEqual((await followup).files, ['followup']);
  await settle();
  t.mock.timers.tick(0);
  await settle();
  assert.equal(f.jobs.length, 3);
  assert.equal(f.jobs[2].projectId, 'project-b');
  assert.deepEqual(f.jobs[2].conversationIds, ['independent-conversation']);
  f.waiting[2].resolve({ projectId: 'project-b', files: [], warnings: [] });
  await settle();
});

test('export errors settle waiting callers with warnings and do not block the next project', async (t) => {
  const f = fixture(t, true);
  const first = f.scheduler.flush('project-a');
  const next = f.scheduler.flush('project-b');
  t.mock.timers.tick(0);
  await settle();
  f.waiting[0].reject(new Error('Fixture disk failure'));
  assert.deepEqual((await first).warnings, ['Fixture disk failure']);
  await settle();
  t.mock.timers.tick(0);
  await settle();
  assert.equal(f.jobs.length, 2);
  f.waiting[1].resolve({ projectId: 'project-b', files: [], warnings: [] });
  assert.deepEqual((await next).warnings, []);
});

test('close drains pending projects immediately without waiting for their debounce windows', async (t) => {
  const f = fixture(t);
  f.scheduler.schedule('project-a', 'conversation-one');
  f.scheduler.schedule('project-b', 'conversation-two');
  assert.equal(f.jobs.length, 0);
  await f.scheduler.close();
  assert.deepEqual(
    f.jobs.map((job) => job.projectId),
    ['project-a', 'project-b'],
  );
  assert.equal(f.delivered.length, 2);
  assert.equal(f.closed(), 1);
  f.scheduler.schedule('after-close', 'ignored');
  const result = await f.scheduler.flush('after-close');
  assert.match(result.warnings.join('\n'), /已关闭/);
  t.mock.timers.tick(10_000);
  await settle();
  assert.equal(f.jobs.length, 2);
});

test('close deadline stops a stuck export and settles queued flushes without delivering results after shutdown', async (t) => {
  const f = fixture(t, true, 50);
  const active = f.scheduler.flush('project-a');
  const pending = f.scheduler.flush('project-b');
  t.mock.timers.tick(0);
  await settle();
  assert.equal(f.jobs.length, 1);
  let finished = false;
  const closing = f.scheduler.close().then(() => {
    finished = true;
  });
  f.scheduler.schedule('during-close', 'ignored');
  const rejected = await f.scheduler.flush('manual-flush-during-close', true);
  assert.match(rejected.warnings.join('\n'), /正在关闭/);
  assert.deepEqual(rejected.files, []);
  t.mock.timers.tick(49);
  await settle();
  assert.equal(finished, false);
  t.mock.timers.tick(1);
  await closing;
  assert.equal(finished, true);
  assert.equal(f.closed(), 1);
  assert.equal(f.jobs.length, 1);
  assert.match((await pending).warnings.join('\n'), /关闭期间未完成/);
  assert.deepEqual((await active).warnings, ['Fixture executor stopped.']);
  assert.deepEqual(f.delivered, []);
  t.mock.timers.tick(10_000);
  await settle();
  assert.equal(f.jobs.length, 1);
});
