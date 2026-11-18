import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import fs, { link, mkdtemp, mkdir, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { LayaReviewStore, type StoredLayaReviewRecord } from '../src/server/laya-review-store.ts';
import type { LayaReviewRecord } from '../src/shared/laya.ts';

const record = (
  extra: Partial<Omit<LayaReviewRecord, 'id' | 'training'>> = {},
): Omit<LayaReviewRecord, 'id' | 'training'> => ({
  workflowId: randomUUID(),
  projectId: 'project-a',
  conversationId: 'conversation-a',
  createdAt: new Date(2026, 9, 26, 0, 30).toISOString(),
  question: 'Implement the feature.\nKeep "quoted text". https://example.test/docs?a=1',
  state: {
    message: 'Implement the feature.',
    recent_context: '',
    reference_text: '',
    attachments: [],
    candidate_executors: ['Muse'],
  },
  inference: {
    status: 'ok',
    reason: 'fixture',
    latencyMs: 1,
    modelVersion: 'pugport-laya-v4',
    raw: { task_type: ['coding', 0.9] },
  },
  policy: { applied: false, reasons: [], conflicts: [], excludeRuntimeIds: [] },
  ...extra,
});
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'laya-review-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, store: new LayaReviewStore(directory) };
}

function childStore(directory: string, value: ReturnType<typeof record>, hold: boolean | 'release-gap' = false) {
  const script = `
    import { LayaReviewStore } from ${JSON.stringify(new URL('../src/server/laya-review-store.ts', import.meta.url).href)};
    import { unlink } from 'node:fs/promises';
    import { join } from 'node:path';
    const store = new LayaReviewStore(${JSON.stringify(directory)});
    const mode = ${JSON.stringify(hold)};
    if (mode === true) store.write = async () => {
      console.log(JSON.stringify({ held: true, pid: process.pid }));
      await new Promise(() => setInterval(() => {}, 1000));
    };
    if (mode === 'release-gap') store.removeLock = async (path, owner) => {
      await unlink(join(path, owner.name));
      console.log(JSON.stringify({ held: true, pid: process.pid }));
      await new Promise(() => setInterval(() => {}, 1000));
    };
    const id = await store.capture(${JSON.stringify(value)});
    console.log(JSON.stringify({ id }));
  `;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk).slice(-4096);
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code));
  });
  const ready = new Promise<{ id?: string; held?: boolean; pid?: number }>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Synthetic lock holder timed out.'));
    }, 5000);
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk;
      if (!output.includes('\n')) return;
      clearTimeout(timer);
      try {
        resolve(JSON.parse(output.slice(0, output.indexOf('\n'))));
      } catch (error) {
        reject(error);
      }
    });
    exited.then(() => {
      clearTimeout(timer);
      reject(new Error(stderr || 'Synthetic lock holder exited before readiness.'));
    }, reject);
  });
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  };
  return { child, exited, ready, stop };
}

test('captures local-date records atomically, with formatted raw text and an incognito guard', async (t) => {
  const { directory, store } = await fixture(t);
  const value = record();
  assert.equal(await store.capture(value, { incognito: true }), undefined);
  assert.deepEqual(await readdir(directory), []);
  const id = await store.capture(value);
  assert.equal(id, `2026-10-26/${value.workflowId}`);
  const saved = JSON.parse(await readFile(join(store.directory, id! + '.json'), 'utf8')) as StoredLayaReviewRecord;
  assert.equal(saved.question, value.question);
  assert.deepEqual(saved.inference.raw, value.inference.raw);
  assert.equal(saved.training.status, 'pending');
  assert.deepEqual(saved.capture, { redacted: false, truncated: false });
  assert.deepEqual(await readdir(join(store.directory, '2026-10-26')), [value.workflowId + '.json']);
});

test('re-capture freezes the full reserved/used message sample while outcomes remain updateable', async (t) => {
  const { store } = await fixture(t);
  const value = record({ messageId: randomUUID() });
  const id = (await store.capture(value))!;
  const path = join(store.directory, id + '.json');
  const changed = {
    ...value,
    question: 'A different question for the same message',
    state: {
      message: 'A different instruction',
      recent_context: 'Different context',
      reference_text: 'Different reference',
      candidate_executors: ['Other card'],
      attachments: [{ kind: 'image', name: 'different.png', mime_type: 'image/png' }],
    },
    inference: { ...value.inference, reason: 'Different judgment', raw: { task_type: ['research', 0.99] } },
    policy: { ...value.policy, applied: true, runtimeId: 'different-runtime', reasons: ['Different routing policy'] },
    outcome: { status: 'An outcome passed through re-capture must not replace the file', routes: [] },
  };
  await store.transition([id], 'reviewed');
  for (const status of ['reserved', 'used'] as const) {
    await store.transition([id], status, { batchId: 'batch-a', modelVersion: 'model-v5' });
    const originalBytes = await readFile(path, 'utf8');
    const original = JSON.parse(originalBytes) as LayaReviewRecord;
    assert.equal(await store.capture(changed), id);
    assert.equal(await readFile(path, 'utf8'), originalBytes, `${status} sample must remain byte-for-byte identical`);
    const outcome = { status: `${status}-task-done`, routes: [{ runId: `run-${status}`, runtimeId: 'final-runtime' }] };
    await store.updateOutcome(id, outcome);
    const saved = (await store.list())[0]!;
    assert.deepEqual(saved.outcome, outcome);
    for (const field of ['question', 'state', 'inference', 'policy', 'training'] as const)
      assert.deepEqual(saved[field], original[field], `${status} ${field} must remain frozen`);
    assert.equal(saved.training.status, status);
    assert.equal(saved.training.batchId, 'batch-a');
    assert.equal(saved.training.modelVersion, 'model-v5');
  }
  assert.equal((await store.list()).length, 1);
});

test('a pending enqueue placeholder accepts its real judgment once while retaining identity, training and outcome', async (t) => {
  const { store } = await fixture(t);
  const value = record({ messageId: randomUUID() });
  const placeholder = {
    ...value,
    inference: { ...value.inference, status: 'skipped' as const, reason: 'queued-pending-judgment', raw: undefined },
  };
  const id = (await store.capture(placeholder))!;
  const path = join(store.directory, id + '.json');
  const queued = (await store.list())[0]!;
  const outcome = { status: 'running', routes: [{ runId: 'run-a', runtimeId: 'selected-runtime' }] };
  await store.updateOutcome(id, outcome);
  const judged = {
    ...value,
    state: { ...value.state, reference_text: 'Reference included at judgment time' },
    inference: { ...value.inference, reason: 'actual-model-judgment', raw: { task_type: ['coding', 0.99] } },
    policy: { ...value.policy, applied: true, reasons: ['Actual policy snapshot'] },
    outcome: { status: 'must-not-overwrite-existing-outcome', routes: [] },
  };
  assert.equal(await store.capture(judged), id);
  const saved = (await store.list())[0]!;
  assert.equal(saved.id, queued.id);
  assert.equal(saved.question, queued.question);
  assert.deepEqual(saved.training, queued.training);
  assert.deepEqual(saved.outcome, outcome);
  assert.deepEqual(saved.state, judged.state);
  assert.deepEqual(saved.inference, judged.inference);
  assert.deepEqual(saved.policy, judged.policy);
  const completedBytes = await readFile(path, 'utf8');
  await store.capture({ ...judged, inference: { ...judged.inference, reason: 'second-judgment-must-be-ignored' } });
  assert.equal(await readFile(path, 'utf8'), completedBytes);
  assert.equal((await store.list()).length, 1);
});

test('reserved placeholders and mismatched questions or message ownership cannot be completed', async (t) => {
  const { store } = await fixture(t);
  const value = record({ messageId: randomUUID() });
  const placeholder = {
    ...value,
    inference: { ...value.inference, status: 'skipped' as const, reason: 'queued-pending-judgment', raw: undefined },
  };
  const id = (await store.capture(placeholder))!;
  const path = join(store.directory, id + '.json');
  const queuedBytes = await readFile(path, 'utf8');
  for (const changed of [
    { ...value, question: 'Another question' },
    { ...value, workflowId: randomUUID() },
    { ...value, projectId: 'another-project' },
    { ...value, conversationId: 'another-conversation' },
    placeholder,
  ]) {
    assert.equal(await store.capture(changed), id);
    assert.equal(await readFile(path, 'utf8'), queuedBytes);
  }
  await store.transition([id], 'reviewed');
  await store.transition([id], 'reserved', { batchId: 'batch-a' });
  const reservedBytes = await readFile(path, 'utf8');
  assert.equal(await store.capture(value), id);
  assert.equal(await readFile(path, 'utf8'), reservedBytes);
  assert.equal((await store.list())[0]!.inference.reason, 'queued-pending-judgment');
});

test('different steering messages on the same workflow retain separate identities', async (t) => {
  const { store } = await fixture(t);
  const value = record();
  const a = await store.capture({ ...value, messageId: randomUUID(), origin: 'user' });
  const b = await store.capture({
    ...value,
    messageId: randomUUID(),
    origin: 'steering',
    question: 'Additional constraint',
  });
  assert.notEqual(a, b);
  assert.equal((await store.list()).length, 2);
  assert.ok((await store.list()).every((saved) => saved.workflowId === value.workflowId));
});

test('serializes competing store instances and prevents another batch stealing reservations', async (t) => {
  const { directory, store } = await fixture(t);
  const other = new LayaReviewStore(directory);
  const value = record();
  const ids = await Promise.all([store.capture(value), other.capture(value), store.capture(value)]);
  assert.equal(new Set(ids).size, 1);
  const id = ids[0]!;
  await store.transition([id], 'reviewed');
  const results = await Promise.allSettled([
    store.transition([id], 'reserved', { batchId: 'a' }),
    other.transition([id], 'reserved', { batchId: 'b' }),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  assert.equal((await store.list()).length, 1);
});

test('reservation ownership, idempotence, failure release and used terminal state are enforced', async (t) => {
  const { store } = await fixture(t);
  const id = (await store.capture(record()))!;
  await assert.rejects(store.transition([id], 'reserved', { batchId: 'a' }), /reviewed/);
  await store.transition([id], 'reviewed');
  await assert.rejects(store.transition([id], 'reserved'), /batch ID/);
  await store.transition([id], 'reserved', { batchId: 'a', modelVersion: 'v5' });
  const updatedAt = (await store.list())[0]!.training.updatedAt;
  await store.transition([id], 'reserved', { batchId: 'a' });
  assert.equal((await store.list())[0]!.training.updatedAt, updatedAt);
  await assert.rejects(store.transition([id], 'reviewed', { batchId: 'b' }), /another training batch/);
  await assert.rejects(store.transition([id], 'used', { batchId: 'b' }), /another training batch/);
  await store.transition([id], 'reviewed', { batchId: 'a' });
  assert.equal((await store.list())[0]!.training.batchId, undefined);
  await store.transition([id], 'reserved', { batchId: 'b' });
  await store.transition([id], 'used', { batchId: 'b' });
  await store.transition([id], 'used', { batchId: 'b' });
  await assert.rejects(store.transition([id], 'reserved', { batchId: 'b' }), /cannot be reused/);
  await assert.rejects(store.transition([id], 'reviewed', { batchId: 'b' }), /cannot be reused/);
});

test('redacts credentials throughout state, raw judgments and route outcomes while preserving public URLs', async (t) => {
  const { store } = await fixture(t);
  const value = record({
    question:
      'Header\nAuthorization: Bearer synthetic-credential\nCookie: session=synthetic-cookie\nhttps://example.test/docs\nhttps://user:synthetic-password@example.test/?token=synthetic-query&topic=hello',
    state: {
      message: 'api_key=synthetic-key',
      recent_context: 'password="synthetic-pass"',
      reference_text: 'Bearer synthetic-auth',
      attachments: [
        {
          kind: 'image',
          name: 'example.png',
          mime_type: 'image/png',
          content: 'synthetic-attachment',
          path: 'private-path',
        } as never,
      ],
      candidate_executors: [],
    },
    inference: {
      status: 'ok',
      reason: 'sk-synthetic-key',
      latencyMs: 1,
      modelVersion: 'pugport-laya-v4',
      raw: {
        authorization: 'synthetic-raw-auth',
        nested: { refreshToken: 'synthetic-refresh' },
        credential: 'synthetic-credential-value',
        jwt: 'eyJsynthetic.eyJsynthetic.synthetic',
      },
    },
  });
  const id = (await store.capture(value))!;
  await store.updateOutcome(id, {
    status: 'done',
    routes: [{ runId: 'run-a', reason: 'token=synthetic-route-token' }],
  });
  const saved = (await store.list())[0] as StoredLayaReviewRecord;
  const json = JSON.stringify(saved);
  for (const secret of [
    'synthetic-credential',
    'synthetic-cookie',
    'synthetic-password',
    'synthetic-query',
    'synthetic-key',
    'synthetic-pass',
    'synthetic-auth',
    'synthetic-attachment',
    'private-path',
    'synthetic-raw-auth',
    'synthetic-refresh',
    'synthetic-credential-value',
    'eyJsynthetic',
    'synthetic-route-token',
  ])
    assert.ok(!json.includes(secret), secret);
  assert.ok(saved.question.includes('\n'));
  assert.ok(saved.question.includes('https://example.test/docs'));
  assert.ok(saved.question.includes('topic=hello'));
  assert.ok(saved.question.includes('[redacted]'));
  assert.equal(saved.capture.redacted, true);
  assert.deepEqual(Object.keys(saved.state.attachments[0]!).sort(), ['kind', 'mime_type', 'name']);
});

test('long text and raw structures retain explicit truncation evidence within the file bound', async (t) => {
  const { store } = await fixture(t);
  const id = (await store.capture(
    record({
      question: 'x'.repeat(39_980) + 'Final actual request',
      inference: {
        status: 'ok',
        reason: '',
        latencyMs: 1,
        modelVersion: 'pugport-laya-v4',
        raw: { samples: Array.from({ length: 500 }, () => 'y'.repeat(2000)) },
      },
    }),
  ))!;
  const saved = (await store.list())[0] as StoredLayaReviewRecord;
  assert.match(saved.question, /\[truncated: originalChars=40000; retainedChars=12000\]/);
  assert.ok(saved.question.includes('Final actual request'));
  assert.equal(saved.capture.truncated, true);
  assert.ok(Buffer.byteLength(await readFile(join(store.directory, id + '.json'))) <= 512 * 1024);
});

test('credential fragments at a truncation boundary are still redacted', async (t) => {
  const { store } = await fixture(t);
  await store.capture(record({ question: 'eyJ' + 's'.repeat(20_000) }));
  const saved = (await store.list())[0] as StoredLayaReviewRecord;
  assert.ok(!saved.question.includes('ssssss'));
  assert.match(saved.question, /\[redacted\].*\[truncated:/);
  assert.deepEqual(saved.capture, { redacted: true, truncated: true });
});

test('bounded attachment and route arrays keep valid record shapes and explicit capture metadata', async (t) => {
  const { store } = await fixture(t);
  const value = record();
  value.state.attachments = Array.from({ length: 120 }, () => ({ kind: 'image', name: 'example.png' }));
  const id = (await store.capture(value))!;
  await store.updateOutcome(id, { status: 'done', routes: Array.from({ length: 120 }, () => ({ runId: 'fixture' })) });
  const saved = (await store.list())[0] as StoredLayaReviewRecord;
  assert.equal(saved.state.attachments.length, 100);
  assert.ok(saved.state.attachments.every((attachment) => attachment.kind === 'image'));
  assert.equal(saved.outcome?.routes.length, 100);
  assert.ok(saved.outcome?.routes.every((route) => route.runId === 'fixture'));
  assert.equal(saved.capture.truncated, true);
});

test('filters, limits, updates outcomes, and deletes only the selected project records', async (t) => {
  const { directory, store } = await fixture(t);
  await writeFile(join(directory, 'user-project.txt'), 'keep');
  const a = (await store.capture(record()))!;
  const b = (await store.capture(
    record({ projectId: 'project-b', createdAt: new Date(2026, 9, 27, 12).toISOString() }),
  ))!;
  await store.transition([b], 'reviewed');
  await store.updateOutcome(a, {
    status: 'done',
    routes: [{ runId: 'run-1', runtimeId: 'account-a', model: 'dynamic-model' }],
  });
  assert.equal((await store.list({ date: '2026-10-26' }))[0]!.outcome?.routes[0]!.model, 'dynamic-model');
  assert.deepEqual(
    (await store.list({ status: 'reviewed' })).map((entry) => entry.id),
    [b],
  );
  assert.deepEqual(
    (await store.list({ limit: 1 })).map((entry) => entry.id),
    [b],
  );
  await store.deleteProject('project-a');
  assert.deepEqual(
    (await store.list()).map((entry) => entry.id),
    [b],
  );
  await store.clear();
  assert.deepEqual(await store.list(), []);
  assert.equal(await readFile(join(directory, 'user-project.txt'), 'utf8'), 'keep');
});

test('rejects traversal, invalid dates, malformed IDs and unsafe query limits before IO', async (t) => {
  const { store } = await fixture(t);
  for (const id of ['../outside', '2026-02-30/' + randomUUID(), '2026-10-26/../../x', '2026-10-26/not-uuid'])
    await assert.rejects(store.updateOutcome(id, { status: 'done', routes: [] }), /Invalid/);
  await assert.rejects(store.capture(record({ workflowId: '../outside' })), /UUID/);
  await assert.rejects(store.capture(record({ createdAt: 'invalid' })), /createdAt/);
  await assert.rejects(store.capture(record({ createdAt: '2026-02-30T00:00:00Z' })), /createdAt/);
  await assert.rejects(store.list({ date: '../../outside' }), /date/);
  await assert.rejects(store.list({ date: '2026-02-30' }), /date/);
  for (const limit of [0, 501, NaN, Infinity, 1.5]) await assert.rejects(store.list({ limit }), /limit/);
});

test('rejects directory junctions without touching their targets', async (t) => {
  const { directory, store } = await fixture(t);
  const outside = join(directory, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'preserve.txt'), 'keep');
  await symlink(outside, store.directory, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(store.capture(record()), /Unsafe/);
  await assert.rejects(store.clear(), /Unsafe/);
  await rm(store.directory);
  await mkdir(store.directory);
  await symlink(outside, join(store.directory, '2026-10-26'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(store.capture(record()), /Unsafe/);
  await assert.rejects(store.clear(), /Unsafe/);
  assert.equal(await readFile(join(outside, 'preserve.txt'), 'utf8'), 'keep');
});

test('refuses hardlinked files and never modifies the other link', async (t) => {
  const { directory, store } = await fixture(t);
  const value = record();
  const id = (await store.capture(value))!;
  const path = join(store.directory, id + '.json');
  const outside = join(directory, 'outside.json');
  await link(path, outside);
  const before = await readFile(outside, 'utf8');
  await assert.rejects(store.capture(value), /Unsafe/);
  await assert.rejects(store.updateOutcome(id, { status: 'done', routes: [] }), /Unsafe/);
  await assert.rejects(store.clear(), /Unsafe/);
  assert.equal(await readFile(outside, 'utf8'), before);
});

test('an unknown legacy lock fails promptly and is never removed', async (t) => {
  const { store } = await fixture(t);
  await mkdir(store.directory);
  const lock = join(store.directory, '.laya.lock');
  await writeFile(lock, 'foreign-owner');
  const start = Date.now();
  await assert.rejects(store.capture(record()), /busy/);
  assert.ok(Date.now() - start < 5000);
  assert.equal(await readFile(lock, 'utf8'), 'foreign-owner');
});

test('recovers a crashed owner across competing processes without changing reserved batch records', async (t) => {
  const { directory, store } = await fixture(t);
  const reservedId = (await store.capture(record()))!;
  await store.transition([reservedId], 'reviewed');
  await store.transition([reservedId], 'reserved', { batchId: 'preserved-batch' });
  const reservedBytes = await readFile(join(store.directory, reservedId + '.json'), 'utf8');
  const value = record();
  const crashed = childStore(directory, value, true);
  try {
    assert.equal((await crashed.ready).held, true);
    const names = await readdir(join(store.directory, '.laya.lock'));
    const ownership = JSON.parse(await readFile(join(store.directory, '.laya.lock', names[0]!), 'utf8'));
    assert.equal(ownership.pid, crashed.child.pid);
    assert.match(ownership.token, /^[0-9a-f-]{36}$/);
  } finally {
    await crashed.stop();
  }
  assert.throws(() => process.kill(crashed.child.pid!, 0), { code: 'ESRCH' });
  const contenders = [childStore(directory, value), childStore(directory, value)];
  try {
    const claimed = await Promise.all(contenders.map((contender) => contender.ready));
    assert.equal(new Set(claimed.map((result) => result.id)).size, 1);
    assert.deepEqual(await Promise.all(contenders.map((contender) => contender.exited)), [0, 0]);
  } finally {
    await Promise.all(contenders.map((contender) => contender.stop()));
  }
  assert.equal((await store.list()).length, 2);
  assert.equal(await readFile(join(store.directory, reservedId + '.json'), 'utf8'), reservedBytes);
  assert.ok(!(await readdir(store.directory)).some((name) => name === '.laya.lock' || name.startsWith('.laya-lock-')));
});

test('cannot steal a live process lock even after the wait timeout', async (t) => {
  const { directory, store } = await fixture(t);
  const held = childStore(directory, record(), true);
  try {
    assert.equal((await held.ready).held, true);
    const lock = join(store.directory, '.laya.lock');
    const names = await readdir(lock);
    const original = await readFile(join(lock, names[0]!), 'utf8');
    await assert.rejects(store.capture(record()), /busy/);
    assert.equal(await readFile(join(lock, names[0]!), 'utf8'), original);
    assert.doesNotThrow(() => process.kill(held.child.pid!, 0));
  } finally {
    await held.stop();
  }
  assert.ok(await store.capture(record()));
});

test('recovers a dead owner when its marker is unlinked during the lock snapshot', async (t) => {
  const { directory, store } = await fixture(t);
  const crashed = childStore(directory, record(), true);
  try {
    assert.equal((await crashed.ready).held, true);
  } finally {
    await crashed.stop();
  }
  const lock = join(store.directory, '.laya.lock');
  const [name] = await readdir(lock);
  assert.ok(name);
  const marker = join(lock, name);
  const original = fs.lstat;
  let removed = false;
  t.mock.method(fs, 'lstat', (async (...args: Parameters<typeof original>) => {
    const info = await Reflect.apply(original, fs, args);
    if (String(args[0]) === marker && !removed) {
      // POSIX lookup may retain the inode while a competing recovery unlinks its last name.
      await unlink(marker);
      info.nlink = 0n;
      removed = true;
    }
    return info;
  }) as typeof original);
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const value = record();
  assert.equal(await store.capture(value), `2026-10-26/${value.workflowId}`);
  assert.equal(removed, true);
  assert.equal((await store.list())[0]!.workflowId, value.workflowId);
  assert.ok(
    !(await readdir(store.directory)).some((entry) => entry === '.laya.lock' || entry.startsWith('.laya-lock-')),
  );
});

test('rejects a hard-linked lock marker without changing either link', async (t) => {
  const { directory, store } = await fixture(t);
  await mkdir(store.directory);
  const lock = join(store.directory, '.laya.lock');
  await mkdir(lock);
  const token = randomUUID();
  const marker = join(lock, `${process.pid}.${token}.json`);
  const contents = JSON.stringify({ version: 1, pid: process.pid, token });
  await writeFile(marker, contents);
  const outside = join(directory, 'preserved-lock.json');
  await link(marker, outside);
  await assert.rejects(store.capture(record()), /Unsafe Laya review lock/);
  assert.equal(await readFile(marker, 'utf8'), contents);
  assert.equal(await readFile(outside, 'utf8'), contents);
});

test('background recording tolerates a transient process lock held longer than 500ms', async (t) => {
  const { directory, store } = await fixture(t);
  const held = childStore(directory, record(), true);
  const value = record();
  try {
    assert.equal((await held.ready).held, true);
    const recording = store.capture(value);
    await new Promise((resolve) => setTimeout(resolve, 700));
    await held.stop();
    assert.ok(await recording);
    assert.equal((await store.list())[0]!.workflowId, value.workflowId);
  } finally {
    await held.stop();
  }
});

test('recovers a crash during lock release using the independent directory identity proof', async (t) => {
  const { directory, store } = await fixture(t);
  const value = record();
  const releasing = childStore(directory, value, 'release-gap');
  try {
    assert.equal((await releasing.ready).held, true);
    assert.deepEqual(await readdir(join(store.directory, '.laya.lock')), []);
    await assert.rejects(store.capture(record()), /busy/);
    assert.deepEqual(await readdir(join(store.directory, '.laya.lock')), []);
  } finally {
    await releasing.stop();
  }
  assert.ok(await store.capture(record()));
  const saved = await store.list();
  assert.equal(saved.length, 2);
  assert.ok(saved.some((sample) => sample.workflowId === value.workflowId));
  assert.ok(!(await readdir(store.directory)).some((name) => name === '.laya.lock' || name.startsWith('.laya-lock-')));
});

test('an empty lock directory without an ownership proof remains unknown', async (t) => {
  const { store } = await fixture(t);
  await mkdir(store.directory);
  await mkdir(join(store.directory, '.laya.lock'));
  await assert.rejects(store.capture(record()), /busy/);
  assert.deepEqual(await readdir(join(store.directory, '.laya.lock')), []);
});

test('rejects a lock-directory junction without reading or deleting its target', async (t) => {
  const { directory, store } = await fixture(t);
  const outside = join(directory, 'outside-lock');
  await mkdir(outside);
  await mkdir(store.directory);
  await writeFile(join(outside, 'preserve.txt'), 'keep');
  await symlink(outside, join(store.directory, '.laya.lock'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(store.capture(record()), /Unsafe/);
  assert.equal(await readFile(join(outside, 'preserve.txt'), 'utf8'), 'keep');
});

test('oversized and corrupt saved records cannot be consumed or silently overwritten', async (t) => {
  const { store } = await fixture(t);
  const value = record();
  const id = (await store.capture(value))!;
  const path = join(store.directory, id + '.json');
  await writeFile(path, 'x'.repeat(512 * 1024 + 1));
  await assert.rejects(store.list(), /oversized/);
  await assert.rejects(store.capture(value), /oversized/);
  await writeFile(path, '{}');
  await assert.rejects(store.list(), /Invalid/);
  await store.clear();
  assert.deepEqual(await store.list(), []);
});

test('conversation cleanup deletes only selected routing records even within one project', async (t) => {
  const { directory, store } = await fixture(t);
  await writeFile(join(directory, 'keep-source.txt'), 'source');
  const gone = await store.capture(record({ conversationId: 'gone' }));
  const sameProject = await store.capture(record({ conversationId: 'kept' }));
  const otherProject = await store.capture(record({ projectId: 'project-b', conversationId: 'other' }));
  assert.ok(gone && sameProject && otherProject);
  await store.deleteConversations(['gone']);
  assert.deepEqual((await store.list()).map((item) => item.id).sort(), [sameProject, otherProject].sort());
  assert.equal(await readFile(join(directory, 'keep-source.txt'), 'utf8'), 'source');
  await store.deleteConversations([]);
  assert.equal((await store.list()).length, 2);
});

test('writes queued in this process wait their turn instead of being dropped as busy', async (t) => {
  const { store } = await fixture(t);
  // A busy computer: every write takes 150 ms, so twenty queued captures need far more than the lock wait.
  const slow = store as unknown as { write: (value: LayaReviewRecord) => Promise<void> };
  const write = slow.write.bind(store);
  t.mock.method(slow, 'write', async (value: LayaReviewRecord) => {
    await new Promise((resolve) => setTimeout(resolve, 150));
    return write(value);
  });
  const placeholder = { status: 'skipped' as const, reason: 'queued-pending-judgment', latencyMs: 0 };
  const values = Array.from({ length: 20 }, () => record());
  const results = await Promise.allSettled(
    values.flatMap((value) => [
      store.capture({ ...value, inference: { ...value.inference, ...placeholder, raw: undefined } }),
      store.capture(value),
    ]),
  );
  assert.deepEqual(
    results.filter((result) => result.status === 'rejected').map((result) => String(result.reason)),
    [],
  );
  const stored = await store.list();
  assert.equal(stored.length, 20);
  assert.ok(
    stored.every((item) => item.inference.reason === 'fixture'),
    'every judged capture replaced its placeholder',
  );
});
