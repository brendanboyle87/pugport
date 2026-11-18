import '../src/server/platform/under-test.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPiAdapter } from '../src/server/adapters/pi.ts';
import { apiBudgetPolicy } from '../src/server/api-budget.ts';
import type { ExecuteContext, RunEvent } from '../src/shared/types.ts';

const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(32)]);
const response = (usage = true) =>
  new Response(
    JSON.stringify({
      data: [{ b64_json: png.toString('base64') }],
      ...(usage ? { usage: { input_tokens: 10, output_tokens: 500 } } : {}),
    }),
  );

async function setup(t: import('node:test').TestContext, fetch: typeof globalThis.fetch) {
  const directory = await mkdtemp(join(tmpdir(), 'pugport-image-batch-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const events: RunEvent[] = [];
  const ctx: ExecuteContext = {
    target: {
      id: 'synthetic',
      label: 'Synthetic',
      provider: 'pi',
      command: 'unused',
      environment: 'native',
      enabled: true,
      gateway: 'api',
      apiProvider: 'openai',
      apiBudget: apiBudgetPolicy({ perRunUsd: 1 }),
    },
    input: {
      prompt: 'Four images',
      projectPath: directory,
      kind: 'general',
      permissionMode: 'read-only',
      imageGeneration: {
        outputDir: directory,
        prompt: 'Four images',
        prompts: ['one', 'two', 'three', 'four'],
        model: 'chatgpt-image-latest',
        edit: false,
      },
    },
    route: { runtimeId: 'synthetic', model: 'openai/gpt-5.2', kind: 'general', reasons: [], warnings: [] },
    signal: new AbortController().signal,
    emit: (event) => events.push(event),
    approve: async () => false,
    apiBudget: { maxCostUsd: 10 },
  };
  return { ctx, events, directory, adapter: createPiAdapter({ key: () => 'synthetic-key', fetch }) };
}

test('four prompts run concurrently with n=1, exact model, ordered images and additive usage', async (t) => {
  const calls: Record<string, unknown>[] = [];
  let active = 0,
    peak = 0;
  const f = await setup(t, async (_url, init) => {
    calls.push(JSON.parse(init!.body as string));
    peak = Math.max(peak, ++active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    return response();
  });
  const result = await f.adapter.execute(f.ctx);
  assert.equal(peak, 4);
  assert.equal(result.generatedImages?.length, 4);
  assert.deepEqual(
    calls.map((call) => [call.prompt, call.n, call.model]),
    ['one', 'two', 'three', 'four'].map((prompt) => [prompt, 1, 'chatgpt-image-latest']),
  );
  const usage = f.events.filter((event) => event.type === 'usage');
  assert.equal(usage.length, 4);
  assert.ok(usage.every((event) => event.data?.cumulative === false));
  assert.equal(
    usage.reduce((sum, event) => sum + Number(event.data?.costUsd), 0),
    4 * 0.02005,
  );
  assert.equal(f.events.filter((event) => event.data?.kind === 'image-request').length, 4);
});

test('partial failures retain successful images and record each failed prompt', async (t) => {
  let calls = 0;
  const f = await setup(t, async () => (++calls % 2 ? response() : new Response('{}', { status: 400 })));
  const result = await f.adapter.execute(f.ctx);
  assert.equal(result.generatedImages?.length, 2);
  const failures = f.events.filter((event) => event.data?.kind === 'image-batch-failure');
  assert.equal(failures.length, 2);
  assert.deepEqual(
    failures.map((event) => event.data?.detail),
    [
      { index: 2, prompt: 'two', error: 'image-request-rejected' },
      { index: 4, prompt: 'four', error: 'image-request-rejected' },
    ],
  );
});

test('all failures reject for candidate fallback; unsupported DALL-E never calls fetch', async (t) => {
  let calls = 0;
  const f = await setup(t, async () => {
    calls++;
    return new Response('{}', { status: 400 });
  });
  await assert.rejects(f.adapter.execute(f.ctx), /image-request-rejected/);
  assert.equal(calls, 4);
  f.ctx.input.imageGeneration!.model = 'dall-e-3';
  await assert.rejects(f.adapter.execute(f.ctx), /runtime-image-generation-unavailable/);
  assert.equal(calls, 4);
});

test('a per-run reservation smaller than the batch never stops it', async (t) => {
  const f = await setup(t, async () => response());
  f.ctx.target.apiBudget!.perRunUsd = 0.01;
  const result = await f.adapter.execute(f.ctx);
  assert.equal(result.generatedImages?.length, 4);
});

test('missing usage counts one reservation per picture; expired budget sends no requests', async (t) => {
  let calls = 0;
  const f = await setup(t, async () => {
    calls++;
    return response(false);
  });
  const result = await f.adapter.execute(f.ctx);
  assert.equal(result.generatedImages?.length, 4);
  assert.equal(
    f.events.filter((event) => event.type === 'usage').reduce((sum, event) => sum + Number(event.data?.costUsd), 0),
    4,
  );
  f.ctx.apiBudget!.expiresAt = new Date(0).toISOString();
  await assert.rejects(f.adapter.execute(f.ctx), /api-budget-expired/);
  assert.equal(calls, 4);
});

test('spending past the remaining card credit cancels pending calls but keeps completed image and usage', async (t) => {
  let calls = 0;
  const f = await setup(t, async (_url, init) => {
    calls++;
    if (calls === 1) return response();
    return new Promise<Response>((_resolve, reject) =>
      init!.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
    );
  });
  // Only the remaining credit stops a batch; the per-run reservation is not a spending cap.
  f.ctx.apiBudget!.maxCostUsd = 0.01;
  const result = await f.adapter.execute(f.ctx);
  assert.equal(result.generatedImages?.length, 1);
  assert.equal(calls, 4);
  assert.equal(f.events.filter((event) => event.type === 'usage').length, 1);
  assert.ok(
    f.events
      .filter((event) => event.data?.kind === 'image-batch-failure')
      .every((event) => (event.data?.detail as { error: string }).error === 'api-budget-exhausted'),
  );
});

test('every edit uses the same reference, and a set beyond four is drawn whole', async (t) => {
  const references: string[] = [];
  const f = await setup(t, async (url, init) => {
    assert.match(String(url), /images\/edits$/);
    const form = init!.body as FormData;
    references.push(await (form.get('image[]') as Blob).text());
    return response();
  });
  const path = join(f.directory, 'reference.png');
  await writeFile(path, png);
  Object.assign(f.ctx.input.imageGeneration!, {
    edit: true,
    references: [{ path, mimeType: 'image/png', name: 'reference.png' }],
    prompts: Array.from({ length: 30 }, (_, index) => `prompt ${index + 1}`),
    titles: Array.from({ length: 30 }, (_, index) => `Person ${index + 1}`),
  });
  const result = await f.adapter.execute(f.ctx);
  assert.equal(result.generatedImages?.length, 30);
  assert.deepEqual(references, Array(30).fill(png.toString()));
  assert.deepEqual(
    result.generatedImages?.slice(0, 2).map((image) => image.title),
    ['Person 1', 'Person 2'],
  );
});

test('each picture sends only its own references, and one with none is drawn from words', async (t) => {
  const sent: Array<{ url: string; images: string[] }> = [];
  const f = await setup(t, async (url, init) => {
    const form = init!.body instanceof FormData ? init!.body : undefined;
    sent.push({
      url: String(url),
      images: form ? await Promise.all(form.getAll('image[]').map((file) => (file as Blob).text())) : [],
    });
    return response();
  });
  const person = join(f.directory, 'person.png');
  const outfit = join(f.directory, 'outfit.png');
  await writeFile(person, 'person-bytes');
  await writeFile(outfit, 'outfit-bytes');
  Object.assign(f.ctx.input.imageGeneration!, {
    edit: true,
    references: [
      { path: person, mimeType: 'image/png', name: 'person.png' },
      { path: outfit, mimeType: 'image/png', name: 'outfit.png' },
    ],
    prompts: ['person in the outfit', 'person alone', 'a new character'],
    referenceSets: [[0, 1], [0], []],
  });
  const result = await f.adapter.execute(f.ctx);
  assert.equal(result.generatedImages?.length, 3);
  const byPrompt = sent.map((item) => item.images.join('+'));
  assert.deepEqual(byPrompt.sort(), ['', 'person-bytes', 'person-bytes+outfit-bytes'].sort());
  assert.ok(sent.some((item) => item.url.endsWith('/images/generations')));
});
