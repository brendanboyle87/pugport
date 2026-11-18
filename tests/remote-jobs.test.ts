import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { RemoteJobs, parseStatus } from '../src/server/remote-jobs.ts';
import { ProjectCliContextService } from '../src/server/project-cli-context.ts';
import { startScript } from '../src/server/remote-job-scripts.ts';
import { WorkspaceStore } from '../src/server/workspace-store.ts';
import type { ProjectSshQuery } from '../src/shared/project-cli-context.ts';
import type { spawnTarget } from '../src/server/adapters/process.ts';

class Child extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  finish(code: number) {
    this.exitCode = code;
    this.emit('close', code);
  }
}
type Response = { code?: number; stdout?: string; stderr?: string; chunks?: Buffer[]; hold?: boolean };
async function fixture() {
  let now = Date.parse('2026-10-27T00:00:00Z');
  const records = new Map<string, unknown>([
    ['project:p', { id: 'p', path: process.cwd(), scope: 'project' }],
    ['project:q', { id: 'q', path: process.cwd(), scope: 'project' }],
  ]);
  const store = {
    get: <T>(kind: string, id: string) => structuredClone(records.get(kind + ':' + id)) as T | undefined,
    save: (kind: string, id: string, owner: string, value: unknown) => {
      assert.equal(kind === 'remote-job' ? owner : 'p', 'p');
      records.set(kind + ':' + id, structuredClone(value));
    },
  } as Pick<WorkspaceStore, 'get' | 'save'>;
  const context = new ProjectCliContextService(store);
  const query: ProjectSshQuery = {
    name: 'build',
    host: 'synthetic-alias',
    argv: ['true'],
    background: true,
    timeoutSeconds: 10,
  };
  await context.update('p', { revision: 0, autoMemoryDirectory: null, sshQueries: [query] }, { source: 'user' });
  const responses: Response[] = [];
  const calls: { command: string; args: string[]; script: string; child: Child }[] = [];
  const delays: number[] = [];
  let terminated = 0;
  const launch: typeof spawnTarget = async (target, args, options) => {
    assert.equal(options?.cwd, process.cwd());
    assert.equal(options.syncAccountConfig, false);
    const response = responses.shift();
    assert.ok(response, 'Unexpected subprocess: all processes must be fake');
    const child = new Child();
    const call = { command: target.command, args, script: '', child };
    calls.push(call);
    child.stdin.on('data', (chunk) => {
      call.script += chunk.toString();
    });
    setImmediate(() => {
      if (response.hold) return;
      for (const chunk of response.chunks ?? [Buffer.from(response.stdout ?? '')]) child.stdout.write(chunk);
      child.stderr.write(response.stderr ?? '');
      child.finish(response.code ?? 0);
    });
    return child as unknown as Awaited<ReturnType<typeof spawnTarget>>;
  };
  const deps = {
    launch,
    terminate: async (child: Awaited<ReturnType<typeof spawnTarget>>) => {
      terminated++;
      if (child.exitCode === null) (child as unknown as Child).finish(255);
    },
    clock: () => now,
    sleep: async (ms: number, signal?: AbortSignal) => {
      signal?.throwIfAborted();
      delays.push(ms);
      now += ms;
    },
  };
  const jobs = new RemoteJobs(context, store, deps);
  const configure = async (patch: Partial<ProjectSshQuery>) => {
    await context.update(
      'p',
      { revision: context.get('p').revision, autoMemoryDirectory: null, sshQueries: [{ ...query, ...patch }] },
      { source: 'user' },
    );
  };
  return {
    jobs,
    context,
    store,
    records,
    query,
    deps,
    responses,
    calls,
    delays,
    configure,
    terminated: () => terminated,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
const look = (exit = '', lines = '', tail = '') => (exit ? exit + '\n' : '') + '---\n' + lines + '\n---\n' + tail;

test('start persists project-owned records and restart status uses one stdin SSH with no background polling', async () => {
  const f = await fixture();
  f.responses.push({ stdout: 'STARTED\n' });
  const started = await f.jobs.start('p', 'build', {}, { write: true });
  assert.equal(started.status, 'running');
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0]!.args.slice(-3), ['--', 'synthetic-alias', 'sh -s']);
  assert.equal(f.calls[0]!.args.includes('-n'), false);
  assert.match(f.calls[0]!.script, /command -v "\$tool"/);
  const stored = f.records.get('remote-job:' + started.jobId) as { projectId: string };
  assert.equal(stored.projectId, 'p');
  assert.equal('projectId' in started, false);
  const recovered = new RemoteJobs(new ProjectCliContextService(f.store), f.store, f.deps);
  f.advance(5000);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(f.calls.length, 1);
  f.responses.push({ stdout: look('0', 'RESULT: ok', 'done') });
  const result = await recovered.status('p', started.jobId);
  assert.equal(result.status, 'completed');
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.resultLines, ['RESULT: ok']);
  assert.equal(result.outputTail, 'done');
  assert.equal(f.calls.length, 2);
  assert.match(f.calls[1]!.script, /tail -c 32768/);
  assert.equal(f.terminated(), 2);
});

test('BUSY and NOTOOLS are truthful terminal start results', async () => {
  for (const [code, marker, status] of [
    [3, 'BUSY', 'busy'],
    [5, 'NOTOOLS', 'failed'],
  ] as const) {
    const f = await fixture();
    f.responses.push({ code, stdout: marker + '\n' });
    const result = await f.jobs.start('p', 'build', {}, { write: true });
    assert.equal(result.status, status);
    assert.equal(result.remoteMayContinue, undefined);
    if (marker === 'NOTOOLS') assert.match(result.error!, /flock, setsid and timeout/);
    assert.equal((await f.jobs.status('p', result.jobId)).status, status);
    assert.equal(f.calls.length, 1);
  }
});

test('push failure persists push-failed and prevents any SSH start', async () => {
  const f = await fixture();
  await f.configure({ push: { repository: '/synthetic.git', refs: ['main:refs/heads/check'] } });
  f.responses.push({ code: 1, stderr: 'synthetic rejected the push\n' });
  const result = await f.jobs.start('p', 'build', {}, { write: true });
  assert.equal(result.status, 'push-failed');
  assert.match(result.error!, /synthetic rejected the push/);
  assert.deepEqual(
    f.calls.map((call) => call.command),
    ['git'],
  );
  assert.ok(f.calls[0]!.args.includes('ssh://synthetic-alias/synthetic.git'));
  assert.equal((await f.jobs.status('p', result.jobId)).status, 'push-failed');
});

test('push failure keeps only the last 4 KiB of stderr', async () => {
  const f = await fixture();
  await f.configure({ push: { repository: '/synthetic.git', refs: ['main:refs/heads/check'] } });
  const tail = 'TAIL-MARK';
  f.responses.push({ code: 1, stderr: 'x'.repeat(5000) + tail });
  const result = await f.jobs.start('p', 'build', {}, { write: true });
  assert.match(result.error!, /TAIL-MARK$/);
  assert.equal(result.error!.includes('x'.repeat(5000)), false);
  assert.ok(Buffer.byteLength(result.error!) < 4300);
});

test('successful push precedes start', async () => {
  const f = await fixture();
  await f.configure({ push: { repository: '/synthetic.git', refs: ['main:check'] } });
  f.responses.push({}, { stdout: 'STARTED\n' });
  assert.equal((await f.jobs.start('p', 'build', {}, { write: true })).status, 'running');
  assert.deepEqual(
    f.calls.map((call) => call.command),
    ['git', 'ssh'],
  );
});

test('empty exit remains running through grace; absent exit past timeout plus 60 becomes timed-out', async () => {
  const f = await fixture();
  f.responses.push({ stdout: 'STARTED' }, { stdout: look() }, { stdout: look() });
  const started = await f.jobs.start('p', 'build', {}, { write: true });
  f.advance(70_000);
  assert.equal((await f.jobs.status('p', started.jobId)).status, 'running');
  f.advance(1);
  const result = await f.jobs.status('p', started.jobId);
  assert.equal(result.status, 'timed-out');
  assert.equal(result.remoteMayContinue, true);
  assert.equal(f.calls.length, 3);
});

test('status failures retain the last stored result and append only a redacted error', async () => {
  const f = await fixture();
  f.responses.push(
    { stdout: 'STARTED' },
    { stdout: look('', 'RESULT: kept', 'previous') },
    { code: 255, stderr: 'password=never-store' },
    { stdout: 'malformed' },
  );
  const start = await f.jobs.start('p', 'build', {}, { write: true });
  const previous = await f.jobs.status('p', start.jobId);
  f.advance(100_000);
  for (let i = 0; i < 2; i++) {
    const result = await f.jobs.status('p', start.jobId);
    assert.equal(result.status, previous.status);
    assert.equal(result.outputTail, previous.outputTail);
    assert.deepEqual(result.resultLines, previous.resultLines);
    assert.ok(result.error);
    assert.doesNotMatch(JSON.stringify(result), /never-store/);
  }
});

test('status parsing bounds RESULT lines/characters and UTF-8 tail, redacts query-style secrets', () => {
  const result = parseStatus(
    look(
      '0',
      Array(60)
        .fill('RESULT: ' + 'x'.repeat(100))
        .join('\n'),
      'prefix' +
        '中'.repeat(12000) +
        ' password=private-value\n-----BEGIN OPENSSH PRIVATE KEY-----\nkey-payload\n-----END OPENSSH PRIVATE KEY-----',
    ),
  );
  assert.ok(result.resultLines.length <= 50);
  assert.ok(result.resultLines.join('\n').length <= 4000);
  assert.ok(Buffer.byteLength(result.outputTail) <= 32768);
  assert.doesNotMatch(result.outputTail, /prefix|private-value|key-payload|\ufffd/);
  assert.equal(parseStatus(look()).exitCode, undefined);
  assert.throws(() => parseStatus(look('999')));
  assert.throws(() => parseStatus('not a status response'));
});

test('remote exit maps success, failure and timeout, with UTF-8 split across SSH chunks', async () => {
  for (const [exit, status] of [
    ['0', 'completed'],
    ['4', 'failed'],
    ['124', 'timed-out'],
    ['137', 'timed-out'],
  ] as const) {
    const f = await fixture();
    const output = Buffer.from(look(exit, 'RESULT: 中文', '中文'));
    const split = output.indexOf(Buffer.from('中')) + 1;
    f.responses.push({ stdout: 'STARTED' }, { chunks: [output.subarray(0, split), output.subarray(split)] });
    const start = await f.jobs.start('p', 'build', {}, { write: true });
    const result = await f.jobs.status('p', start.jobId);
    assert.equal(result.status, status);
    assert.equal(result.remoteMayContinue, undefined);
    assert.deepEqual(result.resultLines, ['RESULT: 中文']);
  }
});

test('cancel sends TERM only to tpid and stores uncertainty until an exit is observed', async () => {
  const f = await fixture();
  f.responses.push({ stdout: 'STARTED' }, {}, { stdout: look('143') });
  const start = await f.jobs.start('p', 'build', {}, { write: true });
  const result = await f.jobs.cancel('p', start.jobId);
  assert.equal(result.status, 'cancelled');
  assert.equal(result.remoteMayContinue, true);
  assert.match(f.calls[1]!.script, /\[ -e "\$d\/exit" \] && exit 0/);
  assert.match(f.calls[1]!.script, /ps -o comm=/);
  assert.match(f.calls[1]!.script, /kill -TERM "\$p"/);
  assert.doesNotMatch(f.calls[1]!.script, /KILL|\/pid"/);
  assert.equal((await f.jobs.cancel('p', start.jobId)).status, 'cancelled');
  assert.equal(f.calls.length, 2);
  const confirmed = await f.jobs.status('p', start.jobId);
  assert.equal(confirmed.status, 'cancelled');
  assert.equal(confirmed.exitCode, 143);
  assert.equal(confirmed.remoteMayContinue, undefined);
});

test('failed cancellation preserves running status; cross-project and read-only callers are refused', async () => {
  const f = await fixture();
  await assert.rejects(f.jobs.start('p', 'build', {}, { write: false }), /write access/);
  assert.equal(f.calls.length, 0);
  await f.configure({ readOnly: true });
  f.responses.push({ stdout: 'STARTED' }, { code: 255, stderr: 'connection unavailable' });
  const start = await f.jobs.start('p', 'build', {}, { write: false });
  await assert.rejects(f.jobs.status('q', start.jobId), /not authorized/);
  await assert.rejects(f.jobs.cancel('q', start.jobId), /not authorized/);
  const result = await f.jobs.cancel('p', start.jobId);
  assert.equal(result.status, 'running');
  assert.ok(result.error);
  assert.equal(f.calls.length, 2);
});

test('wait validates 0-300, does no polling for zero, and looks once per fixed five-second step', async () => {
  const f = await fixture();
  f.responses.push({ stdout: 'STARTED' }, { stdout: look() }, { stdout: look('0') });
  const start = await f.jobs.start('p', 'build', {}, { write: true });
  assert.equal((await f.jobs.wait('p', start.jobId, 0)).status, 'running');
  assert.equal(f.calls.length, 1);
  for (const seconds of [-1, 301, 1.5, NaN]) await assert.rejects(f.jobs.wait('p', start.jobId, seconds));
  const result = await f.jobs.wait('p', start.jobId, 12);
  assert.equal(result.status, 'completed');
  assert.deepEqual(f.delays, [5000, 5000]);
  assert.equal(f.calls.length, 3);
});

test('start uncertainty remains queryable; aborted calls never execute a real process', async () => {
  const f = await fixture();
  await assert.rejects(f.jobs.start('p', 'build', {}, { write: true }, AbortSignal.abort()));
  assert.equal(f.calls.length, 0);
  f.responses.push({ code: 255, stderr: 'lost after send' }, { stdout: look('', '', 'running') });
  const start = await f.jobs.start('p', 'build', {}, { write: true });
  assert.equal(start.status, 'failed');
  assert.equal(start.remoteMayContinue, true);
  assert.equal((await f.jobs.status('p', start.jobId)).status, 'running');
  assert.match(startScript('rj-20261027-1234abcd', 10, undefined, ['true']), /command -v "\$tool"/);
});

test('a definition changed during push cannot start and leaves no phantom running record', async () => {
  const f = await fixture();
  await f.configure({ push: { repository: '/synthetic.git', refs: ['main:check'] } });
  f.responses.push({});
  const jobs = new RemoteJobs(f.context, f.store, {
    ...f.deps,
    launch: async (target, args, options) => {
      const child = await f.deps.launch(target, args, options);
      await f.configure({ argv: ['false'] });
      return child;
    },
  });
  await assert.rejects(jobs.start('p', 'build', {}, { write: true }), /authorization changed/);
  assert.deepEqual(
    f.calls.map((call) => call.command),
    ['git'],
  );
  assert.equal([...f.records.keys()].filter((key) => key.startsWith('remote-job:')).length, 0);
});

test('an explicit SSH timeout cleans up its child and preserves start uncertainty', async (t) => {
  const f = await fixture();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  f.responses.push({ hold: true });
  const pending = f.jobs.start('p', 'build', {}, { write: true });
  await new Promise<void>((resolve) => setImmediate(resolve));
  t.mock.timers.tick(20_000);
  const result = await pending;
  assert.equal(result.status, 'failed');
  assert.equal(result.remoteMayContinue, true);
  assert.equal(f.terminated(), 1);
});

test('oversized SSH output fails a look without replacing stored output', async () => {
  const f = await fixture();
  f.responses.push({ stdout: 'STARTED' }, { stdout: 'x'.repeat(256 * 1024 + 1) });
  const start = await f.jobs.start('p', 'build', {}, { write: true });
  const result = await f.jobs.status('p', start.jobId);
  assert.equal(result.status, 'running');
  assert.equal(result.outputTail, '');
  assert.match(result.error!, /output limit/);
  assert.equal(f.terminated(), 2);
});

test('concurrent status and cancel serialize their reads so cancellation cannot be overwritten', async () => {
  const f = await fixture();
  f.responses.push({ stdout: 'STARTED' }, { stdout: look() }, {});
  const start = await f.jobs.start('p', 'build', {}, { write: true });
  const [lookResult, cancelResult] = await Promise.all([
    f.jobs.status('p', start.jobId),
    f.jobs.cancel('p', start.jobId),
  ]);
  assert.equal(lookResult.status, 'running');
  assert.equal(cancelResult.status, 'cancelled');
  assert.equal((f.records.get('remote-job:' + start.jobId) as { status: string }).status, 'cancelled');
});

test('wait cancellation and the three-wait limit release their slots', async () => {
  const f = await fixture();
  f.responses.push({ stdout: 'STARTED' });
  const start = await f.jobs.start('p', 'build', {}, { write: true });
  const releases: (() => void)[] = [];
  const jobs = new RemoteJobs(f.context, f.store, {
    ...f.deps,
    sleep: async (_ms, signal) => {
      await new Promise<void>((resolve) => releases.push(resolve));
      signal?.throwIfAborted();
    },
  });
  const waits = [1, 2, 3].map(() => jobs.wait('p', start.jobId, 5, AbortSignal.abort()));
  await assert.rejects(jobs.wait('p', start.jobId, 5), /three remote jobs/);
  releases.forEach((release) => release());
  const results = await Promise.allSettled(waits);
  assert.ok(results.every((result) => result.status === 'rejected'));
  assert.equal(f.calls.length, 1);
  assert.equal((await jobs.wait('p', start.jobId, 0)).status, 'running');
});

test('workspace SQLite JSON records survive a service/store reconstruction', async (t) => {
  const f = await fixture();
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const store = new WorkspaceStore(db, { recoverInterrupted: false });
  store.save('project', 'p', 'p', { id: 'p', path: process.cwd(), scope: 'project' });
  const context = new ProjectCliContextService(store);
  await context.update('p', { revision: 0, autoMemoryDirectory: null, sshQueries: [f.query] }, { source: 'user' });
  f.responses.push({ stdout: 'STARTED' }, { stdout: look('0', 'RESULT: persisted') });
  const started = await new RemoteJobs(context, store, f.deps).start('p', 'build', {}, { write: true });
  const saved = db
    .prepare("SELECT owner,value FROM workspace_records WHERE kind='remote-job' AND id=?")
    .get(started.jobId) as { owner: string; value: string };
  assert.equal(saved.owner, 'p');
  assert.equal(JSON.parse(saved.value).projectId, 'p');
  const restoredStore = new WorkspaceStore(db, { initialize: false, recoverInterrupted: false });
  const restored = new RemoteJobs(new ProjectCliContextService(restoredStore), restoredStore, f.deps);
  const result = await restored.status('p', started.jobId);
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.resultLines, ['RESULT: persisted']);
});
