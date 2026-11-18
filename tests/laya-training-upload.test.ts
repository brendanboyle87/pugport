import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LayaReviewRecord, LayaSettings } from '../src/shared/laya.ts';
import { LayaTrainingUpload } from '../src/server/laya-training-upload.ts';
import { LayaReviewStore } from '../src/server/laya-review-store.ts';

const baseTime = Date.parse('2026-10-30T10:00:00.000Z');
function record(extra: Partial<LayaReviewRecord> = {}): LayaReviewRecord {
  const workflowId = randomUUID();
  return {
    id: `2026-10-30/${workflowId}`,
    workflowId,
    conversationId: 'synthetic-conversation',
    projectId: 'synthetic-project',
    createdAt: new Date(baseTime).toISOString(),
    question: 'Translate the synthetic example.',
    state: {
      message: 'Translate the synthetic example.',
      recent_context: '',
      reference_text: '',
      attachments: [],
      candidate_executors: ['synthetic-runtime'],
    },
    inference: { status: 'ok', reason: 'synthetic', modelVersion: 'pugport-laya-v4', latencyMs: 1 },
    policy: { applied: false, reasons: [], conflicts: [], excludeRuntimeIds: [] },
    outcome: { status: 'completed', routes: [{ runId: 'synthetic-run', model: 'synthetic-model' }] },
    training: { status: 'pending', updatedAt: new Date(baseTime).toISOString() },
    ...extra,
  };
}
type Request = { url: string; headers: Record<string, string>; body: Record<string, any> };
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'laya-upload-'));
  const instances: LayaTrainingUpload[] = [];
  t.after(async () => {
    await Promise.all(instances.map((instance) => instance.stop()));
    await rm(directory, { recursive: true, force: true });
  });
  const calls: Request[] = [];
  let settings: LayaSettings = { mode: 'cloud', shareTraining: true };
  let region: 'eu' | 'other' | undefined;
  let eligible = true;
  let now = baseTime;
  let consentAfter = 0;
  let respond: (call: Request) => Promise<Response> = async (call) =>
    Response.json(call.url.endsWith('delete_laya_samples') ? 4 : randomUUID());
  const create = () => {
    const instance = new LayaTrainingUpload({
      dataDir: directory,
      appVersion: 'synthetic-test',
      settings: () => settings,
      region: () => region,
      consentAfter: () => consentAfter,
      eligible: () => eligible,
      config: { url: 'https://synthetic.invalid', publishableKey: 'sb_publishable_synthetic' },
      now: () => now,
      fetch: (async (url, options) => {
        const call = {
          url: String(url),
          headers: options?.headers as Record<string, string>,
          body: JSON.parse(String(options?.body)),
        };
        calls.push(call);
        return respond(call);
      }) as typeof fetch,
    });
    instances.push(instance);
    return instance;
  };
  return {
    directory,
    calls,
    create,
    uploader: create(),
    settings: (value: LayaSettings) => (settings = value),
    region: (value: typeof region) => (region = value),
    eligible: (value: boolean) => (eligible = value),
    time: (value: number) => (now = value),
    consentAfter: (value: number) => (consentAfter = value),
    respond: (value: typeof respond) => (respond = value),
    state: async () => JSON.parse(await readFile(join(directory, 'laya-training-upload.json'), 'utf8')),
  };
}

test('completed records persist locally and upload sequentially in bounded batches without account identity', async (t) => {
  const f = await fixture(t);
  await f.uploader.enqueue(record({ outcome: { status: 'running', routes: [] } }));
  for (let index = 0; index < 12; index++) await f.uploader.enqueue(record());
  assert.equal(f.calls.length, 0);
  const pending = await f.state();
  assert.equal(pending.pending.length, 12);
  assert.match(pending.identity.installId, /^[0-9a-f-]{36}$/);
  assert.equal(Buffer.from(pending.identity.token, 'base64url').length, 32);
  await f.uploader.flush();
  assert.equal(f.calls.length, 10);
  assert.equal((await f.state()).pending.length, 2);
  await f.uploader.flush();
  assert.equal(f.calls.length, 12);
  assert.equal((await f.state()).pending.length, 0);
  const call = f.calls[0]!;
  assert.equal(call.url, 'https://synthetic.invalid/rest/v1/rpc/submit_laya_sample');
  assert.deepEqual(call.headers, { apikey: 'sb_publishable_synthetic', 'Content-Type': 'application/json' });
  assert.deepEqual(Object.keys(call.body).sort(), ['app_version', 'install_id', 'model_version', 'sample', 'token']);
  assert.equal(call.body.install_id, pending.identity.installId);
  assert.equal(call.body.token, pending.identity.token);
  assert.equal(call.body.sample.projectId, undefined);
  assert.equal(call.body.sample.conversationId, undefined);
  assert.equal(call.body.sample.workflowId, undefined);
  assert.equal(call.body.sample.outcome.routes[0].runId, undefined);
});

test('flush commits the queue once per batch and never between requests', async (t) => {
  const f = await fixture(t);
  for (let index = 0; index < 12; index++) await f.uploader.enqueue(record());
  const rename = t.mock.method(fs, 'rename');
  syncBuiltinESMExports();
  t.after(() => {
    rename.mock.restore();
    syncBuiltinESMExports();
  });
  f.respond(async () => {
    assert.equal(rename.mock.callCount(), f.calls.length <= 10 ? 0 : 1);
    return Response.json(randomUUID());
  });
  await f.uploader.flush();
  assert.equal(rename.mock.callCount(), 1);
  assert.equal(f.calls.length, 10);
  assert.equal((await f.state()).pending.length, 2);
  await f.uploader.flush();
  assert.equal(rename.mock.callCount(), 2);
  assert.equal(f.calls.length, 12);
  assert.equal((await f.state()).pending.length, 0);
  await f.uploader.flush();
  assert.equal(rename.mock.callCount(), 2, 'empty flush does not write');
});

for (const action of ['delete', 'revoke'] as const) {
  test(`${action} overtakes a queued flush before its first request`, async (t) => {
    const f = await fixture(t);
    await f.uploader.enqueue(record());
    const flushing = f.uploader.flush();
    if (action === 'delete') {
      const deleting = f.uploader.deleteSamples();
      await flushing;
      assert.equal(await deleting, 0);
    } else {
      f.settings({ mode: 'cloud', shareTraining: false });
      const cleanup = f.uploader.settingsChanged();
      f.settings({ mode: 'cloud', shareTraining: true });
      await Promise.all([flushing, cleanup]);
    }
    assert.equal(f.calls.length, 0);
    assert.equal((await f.state()).pending.length, 0);
    await f.uploader.stop();
    await f.create().flush();
    assert.equal(f.calls.length, 0);
  });
}

test('a partial batch failure and a privacy purge each commit the queue once', async (t) => {
  const f = await fixture(t);
  for (let index = 0; index < 3; index++) await f.uploader.enqueue(record());
  const rename = t.mock.method(fs, 'rename');
  syncBuiltinESMExports();
  t.after(() => {
    rename.mock.restore();
    syncBuiltinESMExports();
  });
  f.respond(async () =>
    f.calls.length === 1 ? Response.json(randomUUID()) : new Response('Synthetic retry', { status: 503 }),
  );
  await f.uploader.flush();
  assert.equal(f.calls.length, 2);
  assert.equal(rename.mock.callCount(), 1);
  const pending = (await f.state()).pending;
  assert.equal(pending.length, 2);
  assert.equal(pending[0].attempts, 1);
  assert.equal(pending[1].attempts, 0);
  f.eligible(false);
  await f.uploader.flush();
  assert.equal(rename.mock.callCount(), 2);
  assert.equal(f.calls.length, 2);
  assert.equal((await f.state()).pending.length, 0);
});

test('a lost batch commit retains remote deletion credentials across restart and privacy cleanup', async (t) => {
  const f = await fixture(t);
  await f.uploader.enqueue(record());
  await f.uploader.enqueue(record());
  const saved = await f.state();
  assert.equal(saved.identity.attempted, false);
  const rename = t.mock.method(fs, 'rename', async () => {
    throw new Error('Synthetic batch commit failure');
  });
  syncBuiltinESMExports();
  t.after(() => {
    rename.mock.restore();
    syncBuiltinESMExports();
  });
  await assert.rejects(f.uploader.flush(), /Synthetic batch commit failure/);
  assert.equal(f.calls.length, 2);
  assert.equal(rename.mock.callCount(), 1);
  assert.deepEqual(await f.state(), saved, 'disk still has the pre-dispatch queue');
  rename.mock.restore();
  syncBuiltinESMExports();
  await f.uploader.stop();
  const restarted = f.create();
  f.eligible(false);
  await restarted.settingsChanged();
  assert.equal((await f.state()).pending.length, 0);
  assert.equal(await restarted.deleteSamples(), 4);
  assert.equal(f.calls.length, 3, 'cleanup deletes possible uploads without resending the old samples');
  assert.ok(f.calls[2]!.url.endsWith('delete_laya_samples'));
  assert.equal(f.calls[2]!.body.install_id, saved.identity.installId);
  assert.equal(f.calls[2]!.body.token, saved.identity.token);
  f.eligible(true);
  await restarted.flush();
  assert.equal(f.calls.length, 3);
});

test('an enqueue persistence failure cannot leave an uploadable entry in memory', async (t) => {
  const f = await fixture(t);
  const rename = t.mock.method(fs, 'rename', async () => {
    throw new Error('Synthetic enqueue commit failure');
  });
  syncBuiltinESMExports();
  t.after(() => {
    rename.mock.restore();
    syncBuiltinESMExports();
  });
  await assert.rejects(f.uploader.enqueue(record()), /Synthetic enqueue commit failure/);
  rename.mock.restore();
  syncBuiltinESMExports();
  await f.uploader.flush();
  assert.equal(f.calls.length, 0);
  await assert.rejects(access(join(f.directory, 'laya-training-upload.json')), { code: 'ENOENT' });
  await f.uploader.enqueue(record());
  await f.uploader.flush();
  assert.equal(f.calls.length, 1);
});

test('failed delivery retries after backoff and survives restart with the same deletion credentials', async (t) => {
  const f = await fixture(t);
  f.respond(async () => new Response('private provider failure', { status: 503 }));
  await f.uploader.enqueue(record());
  await f.uploader.flush();
  const failed = await f.state();
  assert.equal(failed.pending[0].attempts, 1);
  assert.equal(failed.identity.attempted, true);
  await f.uploader.stop();
  const restarted = f.create();
  f.respond(async () => Response.json(randomUUID()));
  await restarted.flush();
  assert.equal(f.calls.length, 1);
  f.time(baseTime + 60_000);
  await restarted.flush();
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1]!.body.token, failed.identity.token);
  assert.equal((await f.state()).pending.length, 0);
});

for (const message of ['LAYA_GLOBAL_RATE_LIMITED', 'LAYA_INSTALL_RATE_LIMITED']) {
  test(`${message} retains the sample and retries after persistent backoff`, async (t) => {
    const f = await fixture(t);
    f.respond(async () => Response.json({ code: 'P0001', message, details: null, hint: null }, { status: 400 }));
    await f.uploader.enqueue(record());
    const queued = await f.state();
    await assert.doesNotReject(f.uploader.flush());
    const failed = await f.state();
    assert.equal(failed.pending.length, 1);
    assert.deepEqual(failed.pending[0].record, queued.pending[0].record);
    assert.equal(failed.pending[0].attempts, 1);
    assert.equal(failed.pending[0].nextAttempt, baseTime + 60_000);
    assert.equal(failed.deleting, false);
    await f.uploader.stop();
    const restarted = f.create();
    f.time(baseTime + 59_999);
    await restarted.flush();
    assert.equal(f.calls.length, 1, 'restart does not bypass backoff');
    f.time(baseTime + 60_000);
    await assert.doesNotReject(restarted.flush());
    const limitedAgain = await f.state();
    assert.equal(limitedAgain.pending.length, 1);
    assert.equal(limitedAgain.pending[0].attempts, 2);
    assert.equal(limitedAgain.pending[0].nextAttempt, baseTime + 180_000);
    assert.deepEqual(limitedAgain.identity, failed.identity);
    f.respond(async () => Response.json(randomUUID()));
    f.time(baseTime + 179_999);
    await restarted.flush();
    assert.equal(f.calls.length, 2);
    f.time(baseTime + 180_000);
    await restarted.flush();
    assert.equal(f.calls.length, 3);
    assert.deepEqual(f.calls[1]!.body, f.calls[0]!.body);
    assert.deepEqual(f.calls[2]!.body, f.calls[0]!.body);
    assert.equal((await f.state()).pending.length, 0);
  });
}

test('sharing policy is checked at enqueue and again at dispatch, including regional defaults', async (t) => {
  const f = await fixture(t);
  for (const settings of [
    { mode: 'local', shareTraining: true },
    { mode: 'jev', shareTraining: true },
    { mode: 'rules', shareTraining: true },
    { mode: 'cloud', shareTraining: false },
    { mode: 'cloud', shareTraining: true, recordTraining: false },
  ] satisfies LayaSettings[]) {
    f.settings(settings);
    await f.uploader.enqueue(record());
  }
  f.settings({ mode: 'cloud' });
  f.region('eu');
  await f.uploader.enqueue(record());
  await f.uploader.flush();
  assert.equal(f.calls.length, 0);
  f.region('other');
  await f.uploader.enqueue(record());
  f.region('eu');
  await f.uploader.flush();
  assert.equal(f.calls.length, 0);
  assert.equal((await f.state()).pending.length, 0);
  f.settings({ mode: 'cloud', shareTraining: true });
  await f.uploader.enqueue(record());
  await f.uploader.flush();
  assert.equal(f.calls.length, 1);
});

test('unknown region prevents default sharing at enqueue and flush', async (t) => {
  const f = await fixture(t);
  f.settings({ mode: 'cloud' });
  await f.uploader.enqueue(record());
  await f.uploader.flush();
  assert.equal(f.calls.length, 0);
  await assert.rejects(access(join(f.directory, 'laya-training-upload.json')), { code: 'ENOENT' });
  f.region('other');
  await f.uploader.enqueue(record());
  assert.equal((await f.state()).pending.length, 1);
  f.region(undefined);
  await f.uploader.flush();
  assert.equal(f.calls.length, 0);
  assert.equal((await f.state()).pending.length, 0);
});

test('incognito and no-record eligibility reject enqueue and remove pending samples before dispatch', async (t) => {
  const f = await fixture(t);
  f.eligible(false);
  await f.uploader.enqueue(record());
  f.eligible(true);
  await f.uploader.enqueue(record());
  f.eligible(false);
  await f.uploader.flush();
  assert.equal(f.calls.length, 0);
  assert.equal((await f.state()).pending.length, 0);
});

test('turning sharing off clears queued samples even when enabled again before cleanup runs', async (t) => {
  const f = await fixture(t);
  await f.uploader.enqueue(record());
  f.settings({ mode: 'cloud', shareTraining: false });
  const cleanup = f.uploader.settingsChanged();
  f.settings({ mode: 'cloud', shareTraining: true });
  await cleanup;
  await f.uploader.flush();
  assert.equal(f.calls.length, 0);
  assert.equal((await f.state()).pending.length, 0);
});

test('sharing revocation while a request is in flight prevents the rest of that batch even after rapid re-enable', async (t) => {
  const f = await fixture(t);
  let release!: () => void;
  let dispatched!: () => void;
  const began = new Promise<void>((resolve) => (dispatched = resolve));
  const held = new Promise<void>((resolve) => (release = resolve));
  f.respond(async () => {
    dispatched();
    await held;
    return Response.json(randomUUID());
  });
  await f.uploader.enqueue(record());
  await f.uploader.enqueue(record());
  const uploading = f.uploader.flush();
  await began;
  f.settings({ mode: 'cloud', shareTraining: false });
  const cleanup = f.uploader.settingsChanged();
  f.settings({ mode: 'cloud', shareTraining: true });
  release();
  await Promise.all([uploading, cleanup]);
  assert.equal(f.calls.length, 1);
  assert.equal((await f.state()).pending.length, 0);
});

test('the background timer dispatches a batch and stop prevents further scheduled uploads', async (t) => {
  const f = await fixture(t);
  await f.uploader.enqueue(record());
  t.mock.timers.enable({ apis: ['setTimeout'] });
  f.uploader.start();
  assert.equal(f.calls.length, 0);
  t.mock.timers.tick(30_000);
  await f.uploader.flush();
  assert.equal(f.calls.length, 1);
  await f.uploader.stop();
  await f.uploader.enqueue(record());
  t.mock.timers.tick(60_000);
  assert.equal(f.calls.length, 1);
  assert.equal((await f.state()).pending.length, 1);
});

test('an empty uploader starts without a timer or state file and schedules only after a completed record', async (t) => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const timers = t.mock.method(globalThis, 'setTimeout');
  f.uploader.start();
  assert.equal(timers.mock.callCount(), 0);
  await assert.rejects(access(join(f.directory, 'laya-training-upload.json')), { code: 'ENOENT' });
  await f.uploader.enqueue(record());
  assert.equal(timers.mock.callCount(), 1);
  assert.equal(f.calls.length, 0);
});

test('starting a fresh uploader resumes its persisted queue with the existing identity', async (t) => {
  const f = await fixture(t);
  await f.uploader.enqueue(record());
  const saved = await f.state();
  await f.uploader.stop();
  const restarted = f.create();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const flushes = t.mock.method(restarted, 'flush');
  restarted.start();
  assert.equal(f.calls.length, 0);
  assert.equal(flushes.mock.callCount(), 0);
  t.mock.timers.tick(30_000);
  assert.equal(flushes.mock.callCount(), 1);
  await flushes.mock.calls[0]!.result;
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0]!.body.install_id, saved.identity.installId);
  assert.equal((await f.state()).pending.length, 0);
});

test('default test fixtures never start upload timers or call the built-in Supabase transport', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'laya-upload-default-'));
  const previousUrl = process.env.PUGPORT_SUPABASE_URL;
  delete process.env.PUGPORT_SUPABASE_URL;
  const uploader = new LayaTrainingUpload({
    dataDir: directory,
    appVersion: 'synthetic-test',
    settings: () => ({ mode: 'cloud', shareTraining: true }),
    region: () => undefined,
    eligible: () => true,
  });
  t.after(async () => {
    await uploader.stop();
    if (previousUrl === undefined) delete process.env.PUGPORT_SUPABASE_URL;
    else process.env.PUGPORT_SUPABASE_URL = previousUrl;
    await rm(directory, { recursive: true, force: true });
  });
  const requests = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Unexpected default transport request');
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const timers = t.mock.method(globalThis, 'setTimeout');
  uploader.start();
  await uploader.enqueue(record());
  assert.equal(timers.mock.callCount(), 0);
  await uploader.flush();
  assert.equal(requests.mock.callCount(), 0);
  const state = JSON.parse(await readFile(join(directory, 'laya-training-upload.json'), 'utf8'));
  assert.equal(state.pending.length, 1);
  await assert.rejects(uploader.deleteSamples(), /tests require an explicit transport/);
  assert.equal(requests.mock.callCount(), 0);
});

test('deletion waits for an in-flight upload, clears old work, rotates only after success and rejects late old completions', async (t) => {
  const f = await fixture(t);
  let release!: () => void;
  let dispatched!: () => void;
  const began = new Promise<void>((resolve) => (dispatched = resolve));
  const held = new Promise<void>((resolve) => (release = resolve));
  f.respond(async (call) => {
    if (call.url.endsWith('submit_laya_sample')) {
      dispatched();
      await held;
      return Response.json(randomUUID());
    }
    return Response.json(7);
  });
  await f.uploader.enqueue(record());
  await f.uploader.enqueue(record());
  const old = (await f.state()).identity;
  const uploading = f.uploader.flush();
  await began;
  const deleting = f.uploader.deleteSamples();
  assert.equal(deleting, f.uploader.deleteSamples());
  await f.uploader.enqueue(record());
  assert.equal(f.calls.length, 1);
  release();
  await uploading;
  assert.equal(await deleting, 7);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1]!.body.install_id, old.installId);
  const fresh = await f.state();
  assert.notEqual(fresh.identity.installId, old.installId);
  assert.notEqual(fresh.identity.token, old.token);
  assert.equal(fresh.pending.length, 0);
  await f.uploader.enqueue(record());
  await f.uploader.flush();
  assert.equal(f.calls.length, 2);
  await f.uploader.enqueue(record({ createdAt: new Date(baseTime + 1).toISOString() }));
  await f.uploader.flush();
  assert.equal(f.calls.length, 3);
  assert.equal(f.calls[2]!.body.install_id, fresh.identity.installId);
});

test('failed deletion retains identity and a persistent upload barrier until an explicit successful retry', async (t) => {
  const f = await fixture(t);
  await f.uploader.enqueue(record());
  await f.uploader.flush();
  const old = (await f.state()).identity;
  f.respond(async () => new Response('do not expose private error', { status: 503 }));
  await assert.rejects(f.uploader.deleteSamples(), /^Error: Laya training request failed \(503\)\.$/);
  assert.deepEqual((await f.state()).identity, old);
  assert.equal((await f.state()).deleting, true);
  await f.uploader.stop();
  const restarted = f.create();
  await restarted.enqueue(record({ createdAt: new Date(baseTime + 1).toISOString() }));
  await restarted.flush();
  assert.equal(f.calls.length, 2);
  f.respond(async () => Response.json(1));
  assert.equal(await restarted.deleteSamples(), 1);
  assert.equal(f.calls[2]!.body.token, old.token);
  assert.notEqual((await f.state()).identity.token, old.token);
  assert.equal((await f.state()).deleting, false);
});

test('deleting before any dispatch clears the queue without registering an installation', async (t) => {
  const f = await fixture(t);
  await f.uploader.enqueue(record());
  const old = (await f.state()).identity;
  assert.equal(await f.uploader.deleteSamples(), 0);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.state()).pending.length, 0);
  assert.notEqual((await f.state()).identity.token, old.token);
});

test('uncertain upload failure still keeps the installation identity available for remote deletion', async (t) => {
  const f = await fixture(t);
  f.respond(async (call) => {
    if (call.url.endsWith('submit_laya_sample')) throw new Error('Synthetic connection lost after commit');
    return Response.json(1);
  });
  await f.uploader.enqueue(record());
  await f.uploader.flush();
  assert.equal(await f.uploader.deleteSamples(), 1);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0]!.body.install_id, f.calls[1]!.body.install_id);
});

test('sample sanitation reuses the local credential redactor and never sends attachment payload', async (t) => {
  const f = await fixture(t);
  const sample = record();
  sample.question =
    'API_KEY=synthetic-private-value at C:\\Users\\synthetic\\private.txt and /home/synthetic/private.txt';
  sample.state.message = 'Bearer synthetic-bearer-value';
  sample.state.attachments = [{ kind: 'image', name: 'synthetic.png', mime_type: 'image/png' }];
  await f.uploader.enqueue(sample);
  await f.uploader.flush();
  const sent = JSON.stringify(f.calls[0]!.body.sample);
  assert.equal(sent.includes('synthetic-private-value'), false);
  assert.equal(sent.includes('synthetic-bearer-value'), false);
  assert.equal(sent.includes('C:\\\\Users\\\\synthetic'), false);
  assert.equal(sent.includes('/home/synthetic/private.txt'), false);
  assert.equal(sent.includes('synthetic.png'), true);
});

test('invalid persistent state fails closed without replacing the deletion identity', async (t) => {
  const f = await fixture(t);
  const content = '{"version":1,"identity":{"installId":"do-not-replace"}}';
  await writeFile(join(f.directory, 'laya-training-upload.json'), content);
  await assert.rejects(f.uploader.flush(), /Invalid Laya upload state/);
  assert.equal(await readFile(join(f.directory, 'laya-training-upload.json'), 'utf8'), content);
  assert.equal(f.calls.length, 0);
});

test('review callbacks observe new completed captures only, without scanning or backfilling existing records', async (t) => {
  const f = await fixture(t);
  const oldStore = new LayaReviewStore(f.directory);
  const oldRecord = record();
  const { id: ignoredId, training: ignoredTraining, ...oldInput } = oldRecord;
  const oldId = (await oldStore.capture(oldInput))!;
  const store = new LayaReviewStore(f.directory, { onCompleted: (value) => f.uploader.enqueue(value) });
  await store.capture(oldInput);
  await store.updateOutcome(oldId, { status: 'completed', routes: [] });
  assert.equal(await store.capture({ ...oldInput, workflowId: randomUUID() }, { incognito: true }), undefined);
  const newId = (await store.capture({ ...oldInput, workflowId: randomUUID() }))!;
  await store.updateOutcome(newId, { status: 'blocked', routes: [] });
  await f.uploader.flush();
  assert.equal(f.calls.length, 0);
  await store.updateOutcome(newId, { status: 'completed', routes: [] });
  await f.uploader.flush();
  assert.equal(f.calls.length, 1);
  await store.updateOutcome(newId, { status: 'completed', routes: [] });
  await f.uploader.flush();
  assert.equal(f.calls.length, 1);
});

test('capture-time consent excludes sharing-off and local captures even if enabled before completion', async (t) => {
  const f = await fixture(t);
  let canShare = false;
  const store = new LayaReviewStore(f.directory, {
    canShare: () => canShare,
    onCompleted: (value) => f.uploader.enqueue(value),
  });
  const { id, training, ...input } = record();
  const off = (await store.capture(input))!;
  canShare = true;
  await store.updateOutcome(off, { status: 'completed', routes: [] });
  await f.uploader.flush();
  assert.equal(f.calls.length, 0);
  const active = (await store.capture({ ...input, workflowId: randomUUID() }))!;
  store.invalidateUploads();
  canShare = false;
  canShare = true;
  await store.updateOutcome(active, { status: 'completed', routes: [] });
  await f.uploader.flush();
  assert.equal(f.calls.length, 0);
  const fresh = (await store.capture({ ...input, workflowId: randomUUID() }))!;
  await store.updateOutcome(fresh, { status: 'completed', routes: [] });
  await f.uploader.flush();
  assert.equal(f.calls.length, 1);
  assert.equal((await store.list()).length, 3, 'Local review records remain available');
});

test('revocation while a capture is awaiting persistence cannot restore upload eligibility', async (t) => {
  const f = await fixture(t);
  const store = new LayaReviewStore(f.directory, {
    canShare: () => true,
    onCompleted: (value) => f.uploader.enqueue(value),
  });
  let release!: () => void;
  let reachedWrite!: () => void;
  const began = new Promise<void>((resolve) => (reachedWrite = resolve));
  const held = new Promise<void>((resolve) => (release = resolve));
  const writer = store as unknown as { write(value: LayaReviewRecord): Promise<void> };
  const originalWrite = writer.write.bind(store);
  writer.write = async (value) => {
    reachedWrite();
    await held;
    return originalWrite(value);
  };
  const { id, training, ...input } = record();
  const capturing = store.capture(input);
  await began;
  store.invalidateUploads();
  release();
  const capturedId = (await capturing)!;
  await store.updateOutcome(capturedId, { status: 'completed', routes: [] });
  await f.uploader.flush();
  assert.equal(f.calls.length, 0);
  assert.equal((await store.list()).length, 1);
});

test('a durable privacy cutoff rejects an old message captured only after recording is enabled', async (t) => {
  const f = await fixture(t);
  f.settings({ mode: 'cloud', shareTraining: true, recordTraining: false });
  await f.uploader.settingsChanged();
  f.time(baseTime + 1000);
  f.settings({ mode: 'cloud', shareTraining: true, recordTraining: true });
  await f.uploader.settingsChanged();
  await f.uploader.stop();
  const restarted = f.create();
  await restarted.enqueue(record());
  await restarted.flush();
  assert.equal(f.calls.length, 0);
  assert.equal((await f.state()).consentAfter, baseTime + 1000);
  await restarted.enqueue(record({ createdAt: new Date(baseTime + 1001).toISOString() }));
  await restarted.flush();
  assert.equal(f.calls.length, 1);
});

test('project or conversation opt-out during a request discards old queue entries after rapid re-enable', async (t) => {
  const f = await fixture(t);
  let release!: () => void;
  let dispatched!: () => void;
  const began = new Promise<void>((resolve) => (dispatched = resolve));
  const held = new Promise<void>((resolve) => (release = resolve));
  f.respond(async () => {
    dispatched();
    await held;
    return Response.json(randomUUID());
  });
  await f.uploader.enqueue(record());
  await f.uploader.enqueue(record());
  const uploading = f.uploader.flush();
  await began;
  f.eligible(false);
  const cleanup = f.uploader.settingsChanged();
  f.eligible(true);
  release();
  await Promise.all([uploading, cleanup]);
  await f.uploader.enqueue(record());
  await f.uploader.flush();
  assert.equal(f.calls.length, 1);
  assert.equal((await f.state()).pending.length, 0);
  await f.uploader.enqueue(record({ createdAt: new Date(baseTime + 1).toISOString() }));
  await f.uploader.flush();
  assert.equal(f.calls.length, 2);
});

test('an independently persisted cutoff protects an old queue after a crash before its privacy update was written', async (t) => {
  const f = await fixture(t);
  await f.uploader.enqueue(record());
  assert.equal((await f.state()).consentAfter, 0);
  await f.uploader.stop();
  f.consentAfter(baseTime + 1000);
  const restarted = f.create();
  await restarted.flush();
  assert.equal(f.calls.length, 0);
  assert.equal((await f.state()).pending.length, 0);
  assert.equal((await f.state()).consentAfter, baseTime + 1000);
  await restarted.enqueue(record());
  await restarted.enqueue(record({ createdAt: new Date(baseTime + 1001).toISOString() }));
  await restarted.flush();
  assert.equal(f.calls.length, 1);
});
