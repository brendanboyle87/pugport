import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { LayaRuntime } from '../src/server/laya-runtime.ts';
import type { LayaSettings, LayaState } from '../src/shared/laya.ts';
import { sanitizeLayaCloudValue } from '../src/server/laya-cloud-privacy.ts';

const VERSION = 'pugport-laya-v4';
const SHA = '4445f9401b321a94ebc3614d231847dc08beaa0c9ccc3fded8dc39f90e8bb4b9';
const choices = {
  task_type: [
    'conversation',
    'coding',
    'research',
    'writing',
    'translation',
    'data_analysis',
    'media',
    'automation',
    'mixed',
    'unclear',
  ],
  difficulty: ['simple', 'standard', 'complex', 'unclear'],
  web_search: ['yes', 'no', 'unclear'],
  input_modality: ['text', 'image', 'audio', 'video', 'mixed', 'unclear'],
  document_read: ['yes', 'no', 'unclear'],
  media_output: [
    'none',
    'image_create',
    'image_edit',
    'speech',
    'music',
    'video_generate',
    'video_render',
    'mixed',
    'unclear',
  ],
  project_access: ['none', 'read', 'write', 'unclear'],
  run_commands: ['yes', 'no', 'unclear'],
  browser_use: ['yes', 'no', 'unclear'],
  executor_intent: ['none', 'assign', 'exclude', 'reassign', 'mention_only', 'unclear'],
};
const state: LayaState = {
  message: 'A synthetic request',
  recent_context: '',
  reference_text: '',
  attachments: [],
  candidate_executors: [],
};

const privateState: LayaState = {
  ...state,
  message: 'Inspect "C:\\Users\\Synthetic Person\\PRIVATE_WINDOWS.txt" using api_key=syntheticCredential',
  recent_context: 'Prior file /home/synthetic/PRIVATE_POSIX.txt with Bearer syntheticBearer',
  reference_text: 'Reference \\\\synthetic-host\\share\\PRIVATE_UNC.txt and file:///tmp/PRIVATE_URI.txt',
  attachments: [{ kind: 'text', name: '/tmp/PRIVATE_ATTACHMENT.txt', mime_type: 'text/plain' }],
};

test('cloud transport removes credentials and absolute paths from every text field', async (t) => {
  const runtime = new LayaRuntime({
    root: '',
    settings: () => undefined,
    fetch: async (_url, init) => {
      const body = String(init?.body);
      for (const marker of ['PRIVATE_', 'syntheticCredential', 'syntheticBearer', 'Synthetic Person', 'synthetic-host'])
        assert.ok(!body.includes(marker), marker);
      assert.deepEqual(Object.keys(JSON.parse(body).state), Object.keys(state));
      assert.equal(JSON.parse(body).state.attachments[0].mime_type, 'text/plain');
      return Response.json(cloudResult());
    },
  });
  t.after(() => runtime.close());
  assert.equal((await runtime.predict(privateState)).status, 'ok');
  assert.ok(privateState.message.includes('PRIVATE_WINDOWS'));
});

test('cloud privacy handles path variants before truncating and preserves public URLs', () => {
  const value = sanitizeLayaCloudValue({
    text: "'C:/Program Files/PRIVATE_QUOTED/file.txt' //host/share/PRIVATE_FORWARD /var/PRIVATE_UNIX ./relative.txt https://example.com/docs/api",
    long: '/home/' + 'x'.repeat(14000) + '/PRIVATE_TAIL.txt',
  });
  assert.ok(!JSON.stringify(value).includes('PRIVATE_'));
  assert.ok(value.text.includes('./relative.txt'));
  assert.ok(value.text.includes('https://example.com/docs/api'));
});

function cloudResult() {
  return {
    modelVersion: VERSION,
    modelSha256: SHA,
    device: 'mps',
    latencyMs: 7,
    region: 'eu',
    raw: {
      answers: Object.fromEntries(
        Object.entries(choices).map(([key, allowed]) => [
          key,
          {
            type: 'choice',
            choice: allowed[0],
            probabilities: Object.fromEntries(allowed.map((value, index) => [value, index === 0 ? 1 : 0])),
          },
        ]),
      ),
    },
  };
}

test('cloud is the default, preserves the raw result, and remembers only validated regions', async (t) => {
  const regions: string[] = [];
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let settings: LayaSettings | undefined;
  const runtime = new LayaRuntime({
    root: '',
    settings: () => settings,
    initialRegion: 'other',
    onRegion: (region) => regions.push(region),
    fetch: async (url, init) => {
      calls.push({ url: String(url), init: init! });
      return Response.json(cloudResult());
    },
  });
  t.after(() => runtime.close());
  assert.equal(runtime.status().region, 'other');
  const result = await runtime.predict(state);
  assert.equal(result.status, 'ok');
  assert.equal(result.device, 'cloud:mps');
  assert.deepEqual(result.raw, cloudResult().raw);
  assert.equal(result.choices?.task_type, 'conversation');
  assert.equal(runtime.status().device, 'cloud:mps');
  assert.equal(runtime.status().region, 'eu');
  assert.deepEqual(regions, ['eu']);
  assert.equal(calls[0].url, 'https://laya.pugport.com/v1/judge');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.redirect, 'error');
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { state });
  for (const mode of ['rules', 'jev', 'local'] as const) {
    settings = { mode };
    assert.equal((await runtime.predict(state)).status, 'fallback');
  }
  assert.equal(calls.length, 1);
  assert.equal(runtime.status().region, 'eu');
});

test('cloud reports regions only when they change, including the persisted initial region', async (t) => {
  for (const initialRegion of [undefined, 'eu', 'other'] as const) {
    const regions: string[] = [];
    let region = 'eu';
    const runtime = new LayaRuntime({
      root: '',
      settings: () => undefined,
      initialRegion,
      onRegion: (value) => regions.push(value),
      fetch: async () => Response.json({ ...cloudResult(), region }),
    });
    t.after(() => runtime.close());
    for (let index = 0; index < 3; index++) assert.equal((await runtime.predict(state)).status, 'ok');
    assert.deepEqual(regions, initialRegion === 'eu' ? [] : ['eu']);
    region = 'other';
    for (let index = 0; index < 2; index++) assert.equal((await runtime.predict(state)).status, 'ok');
    region = 'eu';
    assert.equal((await runtime.predict(state)).status, 'ok');
    assert.deepEqual(regions, initialRegion === 'eu' ? ['other', 'eu'] : ['eu', 'other', 'eu']);
    assert.equal(runtime.status().region, 'eu');
  }
});

test('cloud base URL override and legacy disabled flag still select cloud', async (t) => {
  const previous = process.env.LAYA_CLOUD_URL;
  process.env.LAYA_CLOUD_URL = 'http://127.0.0.1:19876';
  t.after(() => {
    if (previous === undefined) delete process.env.LAYA_CLOUD_URL;
    else process.env.LAYA_CLOUD_URL = previous;
  });
  const runtime = new LayaRuntime({
    root: '',
    settings: () => ({ enabled: false }),
    fetch: async (url) => {
      assert.equal(url, 'http://127.0.0.1:19876/v1/judge');
      return Response.json(cloudResult());
    },
  });
  t.after(() => runtime.close());
  assert.equal((await runtime.predict(state)).status, 'ok');
});

test('cloud tests require an explicit transport without changing the default or opening the breaker', async (t) => {
  const previous = process.env.LAYA_CLOUD_URL;
  delete process.env.LAYA_CLOUD_URL;
  t.after(() => {
    if (previous === undefined) delete process.env.LAYA_CLOUD_URL;
    else process.env.LAYA_CLOUD_URL = previous;
  });
  const transport = t.mock.method(globalThis, 'fetch', async (url: Parameters<typeof fetch>[0]) => {
    assert.equal(url, 'http://127.0.0.1:19876/v1/judge');
    return Response.json(cloudResult());
  });
  const runtime = new LayaRuntime({ root: '', settings: () => undefined });
  t.after(() => runtime.close());
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await runtime.predict(state);
    assert.equal(result.status, 'fallback');
    assert.equal(result.reason, 'test_transport_required');
    assert.equal(runtime.status().state, 'ready');
    assert.equal(runtime.status().device, 'cloud');
  }
  assert.equal(transport.mock.callCount(), 0);
  process.env.LAYA_CLOUD_URL = 'http://127.0.0.1:19876';
  assert.equal((await runtime.predict(state)).status, 'ok');
  assert.equal(transport.mock.callCount(), 1);
});

test('cloud rejects invalid inputs before fetch without opening its breaker', async (t) => {
  let calls = 0;
  const runtime = new LayaRuntime({
    root: '',
    settings: () => undefined,
    fetch: async () => {
      calls++;
      return Response.json(cloudResult());
    },
  });
  t.after(() => runtime.close());
  assert.equal((await runtime.predict({ ...state, message: 'x'.repeat(32769) })).reason, 'invalid_state');
  assert.equal((await runtime.predict({ ...state, message: '中'.repeat(24000) })).reason, 'input_too_large');
  assert.equal(calls, 0);
  assert.equal((await runtime.predict(state)).status, 'ok');
});

test('cloud failures fall back with a short breaker and preserve the last region', async (t) => {
  let now = 100_000;
  t.mock.method(Date, 'now', () => now);
  for (const [name, response] of [
    ['http429', () => new Response('', { status: 429 })],
    ['http503', () => new Response('', { status: 503 })],
    [
      'network',
      () => {
        throw new Error('SYNTHETIC_SECRET');
      },
    ],
    ['json', () => new Response('{')],
    ['identity', () => Response.json({ ...cloudResult(), modelSha256: 'wrong' })],
    ['region', () => Response.json({ ...cloudResult(), region: 'unknown' })],
    ['latency', () => Response.json({ ...cloudResult(), latencyMs: -1 })],
    [
      'choice',
      () => {
        const value = cloudResult();
        value.raw.answers.task_type.choice = 'invented';
        return Response.json(value);
      },
    ],
    [
      'probability',
      () => {
        const value = cloudResult();
        value.raw.answers.web_search.probabilities.yes = -1;
        return Response.json(value);
      },
    ],
    ['oversize', () => new Response('x'.repeat(256 * 1024 + 1))],
  ] as const) {
    let calls = 0;
    const runtime = new LayaRuntime({
      root: '',
      settings: () => undefined,
      initialRegion: 'eu',
      fetch: async () => (++calls === 1 ? response() : Response.json(cloudResult())),
    });
    try {
      const result = await runtime.predict(state);
      assert.equal(result.status, 'fallback', name);
      assert.equal(result.raw, undefined, name);
      assert.ok(!JSON.stringify(result).includes('SYNTHETIC_SECRET'));
      assert.equal(runtime.status().region, 'eu', name);
      assert.equal((await runtime.predict(state)).reason, 'cooldown', name);
      assert.equal(calls, 1, name);
      now += 30_001;
      assert.equal((await runtime.predict(state)).status, 'ok', name);
      assert.equal(calls, 2, name);
    } finally {
      await runtime.close();
    }
  }
});

test('cloud deadlines include a stalled body and abort the request at three seconds', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal: AbortSignal | undefined;
  const runtime = new LayaRuntime({
    root: '',
    settings: () => undefined,
    fetch: async (_url, init) => {
      signal = init!.signal!;
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array([123]));
          },
        }),
      );
    },
  });
  t.after(() => runtime.close());
  const prediction = runtime.predict(state);
  await Promise.resolve();
  t.mock.timers.tick(3000);
  assert.equal((await prediction).reason, 'timeout');
  assert.equal(signal?.aborted, true);
  assert.equal((await runtime.predict(state)).reason, 'cooldown');
});

test('cloud cancellation, mode changes and close stop requests even if fetch ignores abort', async (t) => {
  let settings: LayaSettings = { mode: 'cloud' };
  let signal: AbortSignal | undefined;
  let calls = 0;
  const runtime = new LayaRuntime({
    root: '',
    settings: () => settings,
    fetch: async (_url, init) => {
      calls++;
      signal = init!.signal!;
      return new Promise(() => {});
    },
  });
  t.after(() => runtime.close());
  const controller = new AbortController();
  controller.abort();
  assert.equal((await runtime.predict(state, { signal: controller.signal })).reason, 'cancelled');
  assert.equal(calls, 0);
  const active = new AbortController();
  const first = runtime.predict(state, { signal: active.signal });
  active.abort();
  assert.equal((await first).reason, 'cancelled');
  assert.equal(signal?.aborted, true);
  assert.equal(runtime.status().state, 'ready');
  const second = runtime.predict(state);
  settings = { mode: 'rules' };
  runtime.update();
  assert.equal((await second).reason, 'configuration_changed');
  assert.equal(signal?.aborted, true);
  settings = { mode: 'cloud' };
  const third = runtime.predict(state);
  await runtime.close();
  assert.equal((await third).reason, 'closed');
  assert.equal(signal?.aborted, true);
  assert.equal((await runtime.predict(state)).reason, 'closed');
  assert.equal(calls, 3);
});

// Node runs this synthetic .py entrypoint. No Python dependency, model or GPU is loaded.
const stub = `
const fs = require('node:fs');
const path = require('node:path');
const checkpoint = process.argv[process.argv.indexOf('--checkpoint') + 1];
const config = JSON.parse(fs.readFileSync(path.join(checkpoint, 'stub.json'), 'utf8'));
const choices = ${JSON.stringify(choices)};
fs.appendFileSync(path.join(checkpoint, 'pids'), process.pid + '\\n');
if (config.mode === 'tree') {
  const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:'ignore',windowsHide:true});
  fs.writeFileSync(path.join(checkpoint, 'descendant'), String(child.pid));
}
function send(value) { process.stdout.write(JSON.stringify(value) + '\\n'); }
const ready = { type: 'ready', modelVersion: ${JSON.stringify(VERSION)}, modelSha256: ${JSON.stringify(SHA)}, device: 'cuda:0' };
if (config.mode === 'unsupported') send({type:'unsupported'});
else if (config.mode === 'identity') send({...ready, modelSha256:'wrong'});
else if (config.mode === 'cpu') send({...ready, device:'cpu'});
else if (config.mode === 'stderr') process.stderr.write('secret-synthetic-token'.repeat(2000));
else if (config.mode === 'no-ready') {};
if (!['unsupported','identity','cpu','stderr','no-ready','tree'].includes(config.mode)) setTimeout(() => send(ready), config.readyDelay || 0);
let input = '';
let requests = 0;
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  input += chunk;
  let newline;
  while ((newline = input.indexOf('\\n')) !== -1) {
    const request = JSON.parse(input.slice(0, newline)); input = input.slice(newline + 1);
    fs.appendFileSync(path.join(checkpoint, 'requests'), request.id + '\\n');
    if (config.mode === 'hang') continue;
    if (config.mode === 'exit') process.exit(17);
    if (config.mode === 'oversize') { process.stdout.write('x'.repeat(300000)); continue; }
    const answers = Object.fromEntries(Object.entries(choices).map(([key, allowed]) => [key, {
      type: 'choice', choice: allowed[0], probabilities: Object.fromEntries(allowed.map((value, index) => [value, index === 0 ? 1 : 0])),
      confidence: 1, answer_confidence: 1, action: {act_probability: 0.25}
    }]));
    const raw = {model:'laya-rl-agent', answers, usage:{synthetic:true, pid:process.pid}, marker:config.marker || 'original'};
    if (config.mode === 'echo') raw.state = request.state;
    if (config.mode === 'choice') answers.task_type.choice = 'invented';
    if (config.mode === 'missing') delete answers.web_search;
    if (config.mode === 'extra') answers.unexpected = answers.web_search;
    if (config.mode === 'probability') answers.web_search.probabilities.yes = -1;
    if (config.mode === 'nan') answers.web_search.probabilities.yes = NaN;
    if (config.mode === 'infinity') raw.usage.nonfinite = 1e999;
    if (config.mode === 'abstain') answers.task_type.abstention = 'abstained';
    if (config.mode === 'deep') { let node = raw; for (let i=0;i<25;i++) {node.nested={}; node=node.nested;} }
    const result = {type:'result', id:config.mode === 'id' ? 'wrong-id' : request.id, raw};
    if (config.mode === 'infinity') {
      process.stdout.write(JSON.stringify(result).replace('"nonfinite":null', '"nonfinite":1e999') + '\\n');
    } else setTimeout(() => send(result), requests++ === 0 ? (config.firstDelay ?? config.delay ?? 0) : (config.delay || 0));
  }
});
`;

async function until(condition: () => boolean | Promise<boolean>, message = 'condition', timeout = 4000) {
  const deadline = performance.now() + timeout;
  while (!(await condition())) {
    assert.ok(performance.now() < deadline, `Timed out waiting for ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function fixture(t: TestContext, config: Record<string, unknown> = {}, enabled = true) {
  const root = await mkdtemp(join(tmpdir(), 'pugport-laya-runtime-'));
  const checkpoint = join(root, 'checkpoint');
  await mkdir(join(root, 'scripts'));
  await mkdir(checkpoint);
  await writeFile(join(root, 'scripts/laya-worker.py'), stub);
  await writeFile(join(checkpoint, 'stub.json'), JSON.stringify(config));
  let settings: LayaSettings = {
    mode: enabled ? 'local' : 'rules',
    enabled: false,
    pythonPath: process.execPath,
    checkpointPath: checkpoint,
  };
  const runtime = new LayaRuntime({ root, settings: () => settings });
  t.after(async () => {
    await runtime.close();
    const pids = await readFile(join(checkpoint, 'pids'), 'utf8').catch(() => '');
    for (const pid of pids.trim().split('\n').filter(Boolean).map(Number))
      assert.equal(alive(pid), false, `worker ${pid} leaked`);
    await rm(root, { recursive: true, force: true });
  });
  const pids = async () => (await readFile(join(checkpoint, 'pids'), 'utf8')).trim().split('\n').map(Number);
  return {
    runtime,
    root,
    checkpoint,
    pids,
    setSettings: (next: LayaSettings) => {
      settings = next;
    },
    getSettings: () => settings,
  };
}

test('disabled runtime never starts a worker or waits for inference', async (t) => {
  const f = await fixture(t, {}, false);
  f.runtime.update();
  assert.equal(f.runtime.status().state, 'disabled');
  assert.equal((await f.runtime.predict(state)).reason, 'disabled');
  assert.equal(await readFile(join(f.checkpoint, 'pids'), 'utf8').catch(() => ''), '');
});

test('local runtime requires explicit absolute local files', async (t) => {
  const f = await fixture(t, {}, false);
  for (const settings of [
    { mode: 'local' as const },
    { mode: 'local' as const, pythonPath: 'python', checkpointPath: f.checkpoint },
    { mode: 'local' as const, pythonPath: process.execPath, checkpointPath: join(f.root, 'missing') },
  ]) {
    f.setSettings(settings);
    f.runtime.update();
    assert.equal(f.runtime.status().state, 'error');
    assert.equal((await f.runtime.predict(state)).status, 'fallback');
  }
  assert.equal(await readFile(join(f.checkpoint, 'pids'), 'utf8').catch(() => ''), '');
});

test('local inference retains its original input instead of using cloud privacy scrubbing', async (t) => {
  const f = await fixture(t, { mode: 'echo' });
  await until(() => f.runtime.status().state === 'ready');
  const result = await f.runtime.predict(privateState);
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.raw?.state, privateState);
});

test('startup update spawns once, warming is nonblocking, and full raw output survives', async (t) => {
  const f = await fixture(t, { readyDelay: 200 });
  f.runtime.update();
  f.runtime.update();
  const started = performance.now();
  assert.equal((await f.runtime.predict(state)).reason, 'warming');
  assert.ok(performance.now() - started < 150);
  await until(() => f.runtime.status().state === 'ready', 'ready');
  const first = await f.runtime.predict(state);
  f.runtime.update();
  f.runtime.update();
  const second = await f.runtime.predict(state);
  assert.equal(first.status, 'ok');
  assert.equal(second.status, 'ok');
  assert.equal(first.modelVersion, VERSION);
  assert.equal(first.modelSha256, SHA);
  assert.equal(first.device, 'cuda:0');
  assert.equal(first.choices?.task_type, 'conversation');
  assert.deepEqual(first.raw, second.raw);
  assert.equal((first.raw?.usage as { synthetic: boolean }).synthetic, true);
  assert.equal((await f.pids()).length, 1);
  const snapshot = f.runtime.status();
  snapshot.state = 'error';
  assert.equal(f.runtime.status().state, 'ready');
});

test('busy callers wait for the in-flight prediction and run serially', async (t) => {
  const f = await fixture(t, { delay: 100 });
  await until(() => f.runtime.status().state === 'ready');
  const first = f.runtime.predict(state);
  const second = f.runtime.predict(state);
  const results = await Promise.all([first, second]);
  assert.ok(results.every((value) => value.status === 'ok'));
  assert.ok(results[1].latencyMs >= 180);
  assert.equal((await readFile(join(f.checkpoint, 'requests'), 'utf8')).trim().split('\n').length, 2);
  assert.equal((await f.pids()).length, 1);
});

test('waiting and inference share the original 3 second deadline', async (t) => {
  const f = await fixture(t, { delay: 1800 });
  await until(() => f.runtime.status().state === 'ready');
  const first = f.runtime.predict(state);
  const started = performance.now();
  const second = f.runtime.predict(state);
  assert.equal((await first).status, 'ok');
  const result = await second;
  assert.equal(result.reason, 'timeout');
  assert.ok(performance.now() - started >= 2900);
  assert.ok(performance.now() - started < 3600);
  assert.equal((await readFile(join(f.checkpoint, 'requests'), 'utf8')).trim().split('\n').length, 2);
});

test('cancelling a waiting caller leaves the in-flight prediction intact', async (t) => {
  const f = await fixture(t, { delay: 100 });
  await until(() => f.runtime.status().state === 'ready');
  const first = f.runtime.predict(state);
  const abort = new AbortController();
  const second = f.runtime.predict(state, { signal: abort.signal });
  abort.abort();
  assert.equal((await second).reason, 'cancelled');
  assert.equal((await first).status, 'ok');
  assert.equal((await f.runtime.predict(state)).status, 'ok');
  assert.equal((await readFile(join(f.checkpoint, 'requests'), 'utf8')).trim().split('\n').length, 2);
  assert.equal((await f.pids()).length, 1);
});

test('closing settles waiting callers without sending another request', async (t) => {
  const f = await fixture(t, { delay: 1000 });
  await until(() => f.runtime.status().state === 'ready');
  const first = f.runtime.predict(state);
  const second = f.runtime.predict(state);
  await until(async () => (await readFile(join(f.checkpoint, 'requests'), 'utf8').catch(() => '')).length > 0);
  await f.runtime.close();
  assert.equal((await first).reason, 'closed');
  assert.equal((await second).reason, 'closed');
  assert.equal((await readFile(join(f.checkpoint, 'requests'), 'utf8')).trim().split('\n').length, 1);
});

test('slow prediction times out, ignores its late result, and reuses the same worker', async (t) => {
  const f = await fixture(t, { firstDelay: 5000 });
  await until(() => f.runtime.status().state === 'ready');
  const [pid] = await f.pids();
  const start = performance.now();
  const result = await f.runtime.predict(state);
  assert.equal(result.reason, 'timeout');
  assert.ok(performance.now() - start >= 2900);
  assert.ok(performance.now() - start < 4500);
  assert.equal(alive(pid), true);
  assert.equal(f.runtime.status().state, 'ready');
  const next = await f.runtime.predict(state);
  assert.equal(next.status, 'ok');
  assert.equal((next.raw?.usage as { pid: number }).pid, pid);
  assert.equal((await f.pids()).length, 1);
  assert.equal((await readFile(join(f.checkpoint, 'requests'), 'utf8')).trim().split('\n').length, 2);
});

test('a caller during a late request waits then returns busy without writing stdin', async (t) => {
  const f = await fixture(t, { mode: 'hang' });
  await until(() => f.runtime.status().state === 'ready');
  const caller = new AbortController();
  assert.equal((await f.runtime.predict(state, { signal: caller.signal })).reason, 'timeout');
  // The caller already has its answer, so cancelling it now leaves the worker alone.
  caller.abort();
  const start = performance.now();
  assert.equal((await f.runtime.predict(state)).reason, 'busy');
  assert.ok(performance.now() - start >= 2900);
  assert.ok(performance.now() - start < 3600);
  assert.equal((await readFile(join(f.checkpoint, 'requests'), 'utf8')).trim().split('\n').length, 1);
  assert.equal((await f.pids()).length, 1);
  assert.equal(f.runtime.status().state, 'ready');
});

function longTimers(t: TestContext) {
  let offset = 0;
  const realNow = Date.now.bind(Date);
  const realTimeout = globalThis.setTimeout;
  const timers: { timer: NodeJS.Timeout; fire: () => void }[] = [];
  t.mock.method(Date, 'now', () => realNow() + offset);
  t.mock.method(
    globalThis,
    'setTimeout',
    (callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
      const timer = realTimeout(callback, delay, ...args);
      if (delay === 30_000) timers.push({ timer, fire: () => callback(...args) });
      return timer;
    },
  );
  return () => {
    const next = timers.shift();
    assert.ok(next, '30 second timer scheduled');
    assert.equal(next.timer.hasRef(), false);
    clearTimeout(next.timer);
    offset += 30_001;
    next.fire();
  };
}

test('a stuck late request is killed and restarts after cooldown without another request', async (t) => {
  const advance = longTimers(t);
  const f = await fixture(t, { mode: 'hang' });
  await until(() => f.runtime.status().state === 'ready');
  const [pid] = await f.pids();
  assert.equal((await f.runtime.predict(state)).reason, 'timeout');
  assert.equal(alive(pid), true);
  advance();
  assert.equal(f.runtime.status().state, 'error');
  assert.equal((await f.runtime.predict(state)).reason, 'cooldown');
  await until(() => !alive(pid), 'stuck worker termination');
  await writeFile(join(f.checkpoint, 'stub.json'), '{}');
  assert.equal((await f.pids()).length, 1);
  advance();
  await until(() => f.runtime.status().state === 'ready');
  assert.equal((await f.pids()).length, 2);
  assert.equal((await f.runtime.predict(state)).status, 'ok');
});

test('startup has a finite deadline and retires a worker that never becomes ready', async (t) => {
  const realTimeout = globalThis.setTimeout;
  t.mock.method(
    globalThis,
    'setTimeout',
    (callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) =>
      realTimeout(callback, delay === 120_000 ? 500 : delay, ...args),
  );
  const f = await fixture(t, { mode: 'no-ready' });
  await until(() => f.runtime.status().state === 'error');
  assert.equal(f.runtime.status().reason, 'startup_timeout');
  await until(async () => (await f.pids()).every((pid) => !alive(pid)));
});

test('a worker that fails at startup does not reload by itself after cooldown', async (t) => {
  const advance = longTimers(t);
  const f = await fixture(t, { mode: 'unsupported' });
  await until(() => f.runtime.status().state === 'error');
  assert.equal(f.runtime.status().reason, 'cuda_unsupported');
  assert.throws(advance, /30 second timer scheduled/);
  assert.equal((await f.pids()).length, 1);
});

test('a ready worker switched to missing files does not reload by itself', async (t) => {
  const advance = longTimers(t);
  const f = await fixture(t);
  await until(() => f.runtime.status().state === 'ready');
  f.setSettings({ ...f.getSettings(), checkpointPath: join(f.root, 'missing') });
  f.runtime.update();
  assert.equal(f.runtime.status().reason, 'local_files_missing');
  assert.throws(advance, /30 second timer scheduled/);
});

test('a worker exit restarts automatically after cooldown while idle', async (t) => {
  const advance = longTimers(t);
  const f = await fixture(t, { mode: 'exit' });
  await until(() => f.runtime.status().state === 'ready');
  assert.equal((await f.runtime.predict(state)).reason, 'worker_exited');
  await until(async () => (await f.pids()).every((pid) => !alive(pid)));
  await writeFile(join(f.checkpoint, 'stub.json'), '{}');
  assert.equal((await f.pids()).length, 1);
  advance();
  await until(() => f.runtime.status().state === 'ready');
  assert.equal((await f.runtime.predict(state)).status, 'ok');
  assert.equal((await f.pids()).length, 2);
});

test('a failed executable launch becomes a fallback without leaking a child', async (t) => {
  const f = await fixture(t, {}, false);
  const pythonPath = join(f.root, 'not-python.exe');
  await writeFile(pythonPath, 'synthetic invalid executable');
  f.setSettings({ ...f.getSettings(), mode: 'local', pythonPath });
  f.runtime.update();
  await until(() => f.runtime.status().state === 'error');
  assert.equal(f.runtime.status().reason, 'worker_start_failed');
  assert.equal((await f.runtime.predict(state)).status, 'fallback');
});

test('a settings failure invalidates startup that is scheduled but has not spawned', async (t) => {
  const f = await fixture(t, {}, false);
  let broken = false;
  const runtime = new LayaRuntime({
    root: f.root,
    settings: () => {
      if (broken) throw new Error('synthetic settings unavailable');
      return { ...f.getSettings(), mode: 'local' };
    },
  });
  try {
    broken = true;
    runtime.update();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(runtime.status().state, 'error');
    assert.equal(runtime.status().reason, 'invalid_settings');
    assert.equal(await readFile(join(f.checkpoint, 'pids'), 'utf8').catch(() => ''), '');
  } finally {
    await runtime.close();
  }
});

test('cancellation terminates in-flight work and a pre-aborted request never reaches stdin', async (t) => {
  let offset = 0;
  const realNow = Date.now.bind(Date);
  t.mock.method(Date, 'now', () => realNow() + offset);
  const f = await fixture(t, { mode: 'hang' });
  await until(() => f.runtime.status().state === 'ready');
  const cancelled = new AbortController();
  cancelled.abort();
  assert.equal((await f.runtime.predict(state, { signal: cancelled.signal })).reason, 'cancelled');
  assert.equal(f.runtime.status().state, 'ready');
  const controller = new AbortController();
  const result = f.runtime.predict(state, { signal: controller.signal });
  controller.abort();
  assert.equal((await result).reason, 'cancelled');
  await until(async () => (await f.pids()).every((pid) => !alive(pid)), 'cancelled worker termination');
  assert.equal((await f.runtime.predict(state)).reason, 'cooldown');
  await writeFile(join(f.checkpoint, 'stub.json'), '{}');
  assert.equal((await f.pids()).length, 1);
  offset = 30_001;
  assert.equal((await f.runtime.predict(state)).reason, 'warming');
  await until(() => f.runtime.status().state === 'ready');
  assert.equal((await f.runtime.predict(state)).status, 'ok');
  assert.equal((await f.pids()).length, 2);
});

test('an unexpected child exit settles the request before cooldown recovery', async (t) => {
  const f = await fixture(t, { mode: 'exit' });
  await until(() => f.runtime.status().state === 'ready');
  assert.equal((await f.runtime.predict(state)).reason, 'worker_exited');
  assert.equal(f.runtime.status().state, 'error');
  assert.equal((await f.pids()).length, 1);
});

test('configuration changes discard pending results and wait for the old process to exit', async (t) => {
  const f = await fixture(t, { delay: 1000 });
  await until(() => f.runtime.status().state === 'ready');
  const [oldPid] = await f.pids();
  const first = f.runtime.predict(state);
  const waiting = f.runtime.predict(state);
  const nextCheckpoint = join(f.root, 'replacement');
  await mkdir(nextCheckpoint);
  await writeFile(join(nextCheckpoint, 'stub.json'), JSON.stringify({ marker: 'replacement' }));
  f.setSettings({ ...f.getSettings(), checkpointPath: nextCheckpoint });
  f.runtime.update();
  assert.equal((await first).reason, 'configuration_changed');
  assert.equal((await waiting).reason, 'warming');
  assert.equal(f.runtime.status().state, 'starting');
  await until(() => f.runtime.status().state === 'ready', 'replacement ready');
  assert.equal(alive(oldPid), false);
  const second = await f.runtime.predict(state);
  assert.equal(second.status, 'ok');
  assert.equal(second.raw?.marker, 'replacement');
  const newPid = (second.raw?.usage as { pid: number }).pid;
  await f.runtime.close();
  assert.equal(alive(newPid), false);
  f.runtime.update();
  assert.equal((await f.runtime.predict(state)).reason, 'closed');
});

test('disabling during startup stops owned children and prevents a late ready event', async (t) => {
  const f = await fixture(t, { readyDelay: 500 });
  await until(async () => (await f.pids().catch(() => [])).length > 0);
  f.setSettings({ ...f.getSettings(), mode: 'rules' });
  f.runtime.update();
  await until(async () => (await f.pids()).every((pid) => !alive(pid)));
  assert.equal(f.runtime.status().state, 'disabled');
});

test(
  'Windows startup close terminates both the owned launcher and its child process',
  {
    skip: process.platform !== 'win32',
  },
  async (t) => {
    const f = await fixture(t, { mode: 'tree' });
    let descendant = 0;
    t.after(() => {
      if (descendant && alive(descendant)) process.kill(descendant);
    });
    await until(async () => {
      descendant = Number(await readFile(join(f.checkpoint, 'descendant'), 'utf8').catch(() => '0'));
      return descendant > 0;
    }, 'synthetic child process');
    const [launcher] = await f.pids();
    assert.ok(alive(launcher));
    assert.ok(alive(descendant));
    await f.runtime.close();
    await until(() => !alive(launcher) && !alive(descendant), 'owned process tree termination');
  },
);

for (const [mode, reason] of [
  ['unsupported', 'cuda_unsupported'],
  ['identity', 'invalid_model_identity'],
  ['cpu', 'invalid_model_identity'],
  ['stderr', 'stderr_limit'],
] as const) {
  test(`startup rejects ${mode} without exposing worker data`, async (t) => {
    const f = await fixture(t, { mode });
    await until(() => f.runtime.status().state === 'error');
    assert.equal(f.runtime.status().reason, reason);
    assert.ok(!JSON.stringify(f.runtime.status()).includes('secret-synthetic-token'));
  });
}

for (const [mode, reason] of [
  ['id', 'invalid_response_id'],
  ['choice', 'invalid_prediction'],
  ['missing', 'invalid_prediction'],
  ['extra', 'invalid_prediction'],
  ['probability', 'invalid_prediction'],
  ['nan', 'invalid_prediction'],
  ['infinity', 'invalid_prediction'],
  ['abstain', 'invalid_prediction'],
  ['deep', 'invalid_prediction'],
  ['oversize', 'output_too_large'],
] as const) {
  test(`untrusted ${mode} output is rejected and its worker stops`, async (t) => {
    const f = await fixture(t, { mode });
    await until(() => f.runtime.status().state === 'ready');
    const result = await f.runtime.predict(state);
    assert.equal(result.status, 'fallback');
    assert.equal(result.reason, reason);
    assert.equal(result.raw, undefined);
    await until(async () => (await f.pids()).every((pid) => !alive(pid)));
  });
}

test('state and UTF-8 byte boundaries reject oversized input without killing a ready worker', async (t) => {
  const f = await fixture(t);
  await until(() => f.runtime.status().state === 'ready');
  for (const value of [
    { ...state, message: 'x'.repeat(32769) },
    { ...state, attachments: Array.from({ length: 33 }, () => ({ kind: 'text', name: 'x' })) },
    { ...state, candidate_executors: ['x'.repeat(129)] },
  ])
    assert.equal((await f.runtime.predict(value)).reason, 'invalid_state');
  assert.equal((await f.runtime.predict({ ...state, message: '中'.repeat(24000) })).reason, 'input_too_large');
  assert.equal((await f.runtime.predict({ ...state, message: 'x'.repeat(32000) })).status, 'ok');
  assert.equal(f.runtime.status().state, 'ready');
});

test('packaged worker takes precedence over the development script', async (t) => {
  const f = await fixture(t, {}, false);
  await mkdir(join(f.root, 'dist/server'), { recursive: true });
  await writeFile(
    join(f.root, 'dist/server/laya-worker.py'),
    stub.replace("config.marker || 'original'", "'packaged'"),
  );
  await writeFile(join(f.root, 'scripts/laya-worker.py'), 'process.exit(33)');
  f.setSettings({ ...f.getSettings(), mode: 'local' });
  f.runtime.update();
  await until(() => f.runtime.status().state === 'ready');
  assert.equal((await f.runtime.predict(state)).raw?.marker, 'packaged');
});

test(
  'Python worker warms only synthetic data before ready and fails closed on warmup errors',
  {
    skip: !process.env.PUGPORT_LAYA_TEST_PYTHON,
    timeout: 15000,
  },
  async (t) => {
    const source = join(process.cwd(), 'scripts/laya-worker.py');
    for (const mode of ['success', 'warmup-failed', 'unsupported']) {
      await t.test(mode, async (t) => {
        const f = await fixture(t, { mode }, false);
        const questions = Object.fromEntries(
          Object.entries(choices).map(([key, options]) => [
            key,
            {
              type: 'choice',
              criteria: Object.fromEntries(options.map((option) => [option, option])),
            },
          ]),
        );
        await writeFile(join(f.checkpoint, 'questions.json'), JSON.stringify(questions));
        await writeFile(
          join(f.root, 'scripts/laya-worker.py'),
          `
import json, os, runpy, sys, types
from contextlib import contextmanager
from pathlib import Path
checkpoint = Path(sys.argv[sys.argv.index('--checkpoint') + 1])
config = json.loads((checkpoint / 'stub.json').read_text())
with (checkpoint / 'pids').open('a') as stream: stream.write(str(os.getpid()) + '\\n')
tracker = {'calls': 0, 'inference': False, 'device': False}
class Device:
    type = 'cuda'
    def __str__(self): return 'cuda:0'
class Tensor:
    device = Device()
    def sum(self): return self
    def item(self): return 6.0
@contextmanager
def device_context(name):
    assert name == 'cuda'
    tracker['device'] = True
    try: yield
    finally: tracker['device'] = False
@contextmanager
def inference_mode():
    tracker['inference'] = True
    try: yield
    finally: tracker['inference'] = False
def predict(state, questions):
    assert tracker['inference']
    tracker['calls'] += 1
    if tracker['calls'] == 1:
        assert state == {'message':'Hello.', 'recent_context':'', 'reference_text':'', 'attachments':[], 'candidate_executors':[]}
        if config['mode'] == 'warmup-failed': raise RuntimeError('synthetic warmup failure')
        (checkpoint / 'warmup.json').write_text(json.dumps(tracker))
    else:
        assert state['message'] == 'A synthetic request'
    print('SYNTHETIC_PRIVATE_DEPENDENCY_LOG')
    return {'model':'synthetic', 'warmupCalls':tracker['calls'], 'answers':{key:{'type':'choice', 'choice':next(iter(question['criteria'])), 'probabilities':{choice:1 if index == 0 else 0 for index,choice in enumerate(question['criteria'])}} for key,question in questions.items()}}
def load(path, **options):
    assert tracker['device'] and path == str(checkpoint)
    assert options == {'device':'cuda','compile':False,'expected_sha256':{'model.safetensors':${JSON.stringify(SHA)}}}
    return types.SimpleNamespace(device=Device(), predict=predict)
def threads(count): assert count == 2
def interop(count): assert count == 1
sys.modules['torch'] = types.SimpleNamespace(set_num_threads=threads,set_num_interop_threads=interop,device=device_context,inference_mode=inference_mode,tensor=lambda *a,**kw:Tensor(),cuda=types.SimpleNamespace(is_available=lambda:config['mode'] != 'unsupported',synchronize=lambda:None))
sys.modules['laya'] = types.SimpleNamespace(load=load)
runpy.run_path(${JSON.stringify(source)},run_name='__main__')
`,
        );
        f.setSettings({ ...f.getSettings(), mode: 'local', pythonPath: process.env.PUGPORT_LAYA_TEST_PYTHON });
        f.runtime.update();
        await until(() => ['ready', 'error'].includes(f.runtime.status().state));
        if (mode === 'success') {
          assert.equal(f.runtime.status().state, 'ready');
          const warmup = JSON.parse(await readFile(join(f.checkpoint, 'warmup.json'), 'utf8'));
          assert.equal(warmup.calls, 1);
          assert.equal(warmup.inference, true);
          const result = await f.runtime.predict(state);
          assert.equal(result.status, 'ok');
          assert.equal(result.raw?.warmupCalls, 2);
        } else {
          assert.equal(f.runtime.status().state, 'error');
          assert.equal(f.runtime.status().reason, mode === 'unsupported' ? 'cuda_unsupported' : 'worker_error');
          assert.equal(await readFile(join(f.checkpoint, 'warmup.json'), 'utf8').catch(() => ''), '');
        }
      });
    }
  },
);
