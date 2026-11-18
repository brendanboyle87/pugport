import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apiPreset, freePresets, routeKeyLabel } from '../src/shared/api-providers.ts';
import { apiTarget, apiEnvironment, validateApiBaseUrl, syncApiModelsConfig } from '../src/server/api-providers.ts';
import {
  probeFreeSource,
  freeModelsJson,
  syncFreeSourceConfig,
  retryAfterSeconds,
} from '../src/server/free-sources.ts';
import { createPiAdapter } from '../src/server/adapters/pi.ts';
import { routeOptions } from '../src/ui/RoutePolicyEditor.tsx';

const target = (id: string) => apiTarget('fixture', 'fixture', apiPreset(id)!, `api-${id}`, id);
const reply = (body: unknown, status = 200, headers?: HeadersInit) =>
  (async () => new Response(JSON.stringify(body), { status, headers })) as typeof fetch;

test('free preset defaults, labels, and policy options preserve the paid catalog', () => {
  assert.equal(freePresets.length, 7);
  for (const preset of freePresets) {
    assert.equal(preset.mayLog, !preset.local);
    assert.equal(preset.keyVariable, 'PUGPORT_SOURCE_KEY');
    assert.equal(routeKeyLabel(`api:${preset.id}`), preset.label);
  }
  assert.deepEqual(routeOptions(freePresets.map((p) => target(p.id))), []);
  assert.equal(routeKeyLabel('api:deepseek'), 'DeepSeek API');
});

test('Ollama tags create isolated zero-cost models; hosted settings disable retry and contain no key', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pugport-free-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const local = { ...target('ollama'), agentDir: dir };
  const result = await probeFreeSource(local, undefined, (async (url, init) => {
    assert.equal(url, 'http://127.0.0.1:11434/api/tags');
    assert.equal(init?.redirect, 'error');
    assert.ok(init?.signal);
    assert.equal(new Headers(init?.headers).get('Authorization'), null);
    return new Response(JSON.stringify({ models: [{ name: 'qwen:7b' }, { name: 'qwen:7b' }] }));
  }) as typeof fetch);
  assert.deepEqual(result.models, [{ id: 'qwen:7b', name: 'qwen:7b' }]);
  syncFreeSourceConfig(local, result.models);
  syncApiModelsConfig(local, apiPreset('ollama')!);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'models.json'), 'utf8')), freeModelsJson(local, result.models));
  assert.equal(freeModelsJson(local, result.models).providers['pugport-ollama'].apiKey, 'local');
  const hosted = { ...target('groq-free'), agentDir: dir };
  syncFreeSourceConfig(hosted, result.models);
  assert.equal(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')).retry.enabled, false);
  assert.equal(freeModelsJson(hosted, result.models).providers['pugport-groq'].apiKey, '$PUGPORT_SOURCE_KEY');
  const env = apiEnvironment(hosted, apiPreset('groq-free')!, 'synthetic-key', {
    OPENAI_API_KEY: 'ambient',
    GROQ_API_KEY: 'ambient',
    PUGPORT_SOURCE_KEY: 'ambient',
    PATH: 'path',
  });
  assert.equal(env.PUGPORT_SOURCE_KEY, 'synthetic-key');
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.GROQ_API_KEY, undefined);
  assert.equal(apiEnvironment(local, apiPreset('ollama')!, undefined, {}).PUGPORT_SOURCE_KEY, 'local');
});

test('LM Studio caps and sanitizes discovery at 200 unique models', async () => {
  const result = await probeFreeSource(
    target('lmstudio'),
    undefined,
    reply({
      data: [{ id: '!command' }, { id: '${SECRET}' }, ...Array.from({ length: 230 }, (_, i) => ({ id: `model-${i}` }))],
    }),
  );
  assert.equal(result.models.length, 200);
  assert.equal(result.models[0].id, 'model-0');
});

test('OpenRouter requires :free and explicit zero pricing for all published charges', async () => {
  const result = await probeFreeSource(
    target('openrouter-free'),
    'fixture-key',
    reply({
      data: [
        { id: 'yes:free', pricing: { prompt: '0', completion: '0' } },
        { id: 'paid', pricing: { prompt: '0', completion: '0' } },
        { id: 'paid:free', pricing: { prompt: '0', completion: '0.1' } },
        { id: 'extra:free', pricing: { prompt: '0', completion: '0', request: '1' } },
        { id: 'missing:free', pricing: { prompt: '0' } },
        { id: 'null:free', pricing: { prompt: null, completion: '0' } },
        { id: 'boolean:free', pricing: { prompt: false, completion: '0' } },
      ],
    }),
  );
  assert.deepEqual(
    result.models.map((m) => m.id),
    ['yes:free'],
  );
});

test('Gemini uses a header, lists generateContent only, and never reflects the key or fetch diagnostic', async () => {
  const key = 'fixture-private-token';
  const result = await probeFreeSource(target('gemini-free'), key, (async (url, init) => {
    assert.ok(!String(url).includes(key));
    assert.equal(new Headers(init?.headers).get('x-goog-api-key'), key);
    return new Response(
      JSON.stringify({
        models: [
          { name: 'models/gemini-flash', supportedGenerationMethods: ['generateContent'], displayName: key },
          { name: 'models/embed', supportedGenerationMethods: ['embedContent'] },
          { name: `models/${key}`, supportedGenerationMethods: ['generateContent'] },
        ],
      }),
    );
  }) as typeof fetch);
  assert.deepEqual(result.models, [{ id: 'gemini-flash', name: 'gemini-flash' }]);
  assert.ok(!JSON.stringify(result).includes(key));
  const failed = await probeFreeSource(target('gemini-free'), key, async () => {
    throw new Error(`https://example.invalid/?key=${key}`);
  });
  assert.deepEqual(failed, { models: [], error: 'runtime-network-error' });
});

test('GitHub catalog requires the users bearer token; HTTP failure retains only safe fields', async () => {
  const result = await probeFreeSource(target('github-models'), 'fixture-token', (async (url, init) => {
    assert.equal(url, 'https://models.github.ai/catalog/models');
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer fixture-token');
    return new Response(JSON.stringify([{ id: 'openai/gpt-small' }]));
  }) as typeof fetch);
  assert.equal(result.models[0].id, 'openai/gpt-small');
  assert.equal(
    (
      await probeFreeSource(target('github-models'), undefined, async () => {
        throw new Error('must not fetch');
      })
    ).error,
    'authentication-required',
  );
  assert.deepEqual(await probeFreeSource(target('groq-free'), 'fixture', reply({}, 429, { 'Retry-After': '123' })), {
    models: [],
    error: 'quota-or-rate-limit',
    retryAfterSeconds: 123,
  });
  assert.equal(
    (await probeFreeSource(target('groq-free'), 'fixture', reply({}, 401))).error,
    'authentication-required',
  );
});

test('unreachable and disabled free targets never spawn Pi; keyless local targets never read keys', async () => {
  let spawns = 0;
  const adapter = createPiAdapter({
    key: () => {
      throw new Error('must not read local key');
    },
    spawn: async () => {
      spawns++;
      throw new Error('must not spawn');
    },
    probe: async () => ({ models: [], error: 'runtime-network-error' }),
  });
  const unavailable = await adapter.discover(target('ollama'));
  assert.equal(unavailable.status, 'missing');
  assert.equal(unavailable.costTier, 'free');
  assert.equal(unavailable.local, true);
  assert.equal(unavailable.mayLog, false);
  assert.equal(spawns, 0);
  const disabled = createPiAdapter({
    ...{
      spawn: async () => {
        spawns++;
        throw new Error('must not spawn');
      },
    },
    probe: async () => ({ models: [{ id: 'local', name: 'local' }] }),
    key: () => undefined,
  });
  const found = await disabled.discover({ ...target('ollama'), enabled: false });
  assert.equal(found.models.length, 1);
  assert.equal(found.status, 'ready');
  assert.equal(spawns, 0);
});

test('base URL validation normalizes trailing slashes and rejects credentials, schemes and oversized input', () => {
  assert.equal(validateApiBaseUrl('http://127.0.0.1:1234/v1///'), 'http://127.0.0.1:1234/v1');
  for (const url of [
    'file:///tmp',
    'ftp://example.com',
    'https://u:p@example.com',
    'invalid',
    `https://example.com/${'a'.repeat(2000)}`,
    'https://example.com/?key=secret',
    'https://example.com/#secret',
  ])
    assert.throws(() => validateApiBaseUrl(url));
});

test('Retry-After accepts seconds and HTTP dates without exposing the original diagnostic', () => {
  assert.equal(retryAfterSeconds('42'), 42);
  assert.equal(retryAfterSeconds('429 Retry-After: 2.5'), 2.5);
  assert.equal(retryAfterSeconds('{"Retry-After": 42, "diagnostic": "private"}'), 42);
  assert.equal(retryAfterSeconds('Retry-After: -1'), undefined);
  assert.equal(retryAfterSeconds('Retry-After: Mon, 12 Oct 2026 12:01:00 GMT', Date.parse('2026-10-12T12:00:00Z')), 60);
  assert.equal(retryAfterSeconds('API key private-token failed'), undefined);
});

test('enabled keyless discovery probes before the injected Pi transport and writes its model config', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pugport-free-pi-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  child.stdin.on('data', (line: Buffer) => {
    const packet = JSON.parse(line.toString());
    child.stdout.write(
      `${JSON.stringify({
        id: packet.id,
        type: 'response',
        success: true,
        data: {
          models: [
            { id: 'qwen', provider: 'pugport-ollama', name: 'qwen', cost: { input: 0, output: 0 } },
            { id: 'unrelated-paid-model', provider: 'openai' },
          ],
        },
      })}\n`,
    );
  });
  const order: string[] = [];
  const adapter = createPiAdapter({
    probe: async () => {
      order.push('probe');
      return { models: [{ id: 'qwen', name: 'qwen' }] };
    },
    key: () => {
      throw new Error('keyless must not read a key');
    },
    environment: () => ({}),
    permissionExtension: async () => 'fixture',
    version: async () => 'fixture',
    spawn: async () => {
      order.push('spawn');
      return child as unknown as ChildProcessWithoutNullStreams;
    },
    terminate: async () => {},
  });
  const snapshot = await adapter.discover({ ...target('ollama'), agentDir: dir });
  assert.deepEqual(order, ['probe', 'spawn']);
  assert.equal(snapshot.status, 'ready');
  assert.deepEqual(
    snapshot.models.map((model) => model.id),
    ['pugport-ollama/qwen'],
  );
  assert.match(readFileSync(join(dir, 'models.json'), 'utf8'), /pugport-ollama/);
});

test('local and hosted probes supply their separate timeout signals', async (t) => {
  const timeouts: number[] = [];
  t.mock.method(AbortSignal, 'timeout', (ms: number) => {
    timeouts.push(ms);
    const controller = new AbortController();
    setImmediate(() => controller.abort());
    return controller.signal;
  });
  const blocked = ((_url, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('fixture timeout')), { once: true });
    })) as typeof fetch;
  assert.equal((await probeFreeSource(target('ollama'), undefined, blocked)).error, 'runtime-network-error');
  assert.equal((await probeFreeSource(target('groq-free'), 'fixture-key', blocked)).error, 'runtime-network-error');
  assert.deepEqual(timeouts, [1500, 8000]);
});
