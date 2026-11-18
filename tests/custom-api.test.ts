import '../src/server/platform/under-test.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { ModelConfig } from '../node_modules/@earendil-works/pi-coding-agent/dist/core/model-config.js';
import { composeModelProvider } from '../node_modules/@earendil-works/pi-coding-agent/dist/core/provider-composer.js';
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript';
import { apiCreditPace, apiPreset, validateApiConnection, type ApiConnection } from '../src/shared/api-providers.ts';
import { apiEnvironment, apiTarget, readApiKey, syncApiModelsConfig } from '../src/server/api-providers.ts';
import {
  apiCatalog,
  apiConnectionModel,
  mergeApiModels,
  refreshApiModelList,
} from '../src/server/api-model-discovery.ts';
import { createPiAdapter, piModelAuditDetails, piModels } from '../src/server/adapters/pi.ts';
import { apiBudgetPolicy, apiBudgetView } from '../src/server/api-budget.ts';
import { Controller } from '../src/server/controller.ts';
import { route, quotaPoolKey } from '../src/server/routing.ts';
import { testDirectory } from '../src/server/platform/under-test.ts';
import { fakeHost } from './helpers/fake-host.ts';
import type { ExecuteContext, RuntimeSnapshot, Settings } from '../src/shared/types.ts';

const preset = apiPreset('custom-api')!;
const key = 'SYNTHETIC_CUSTOM_API_KEY';
const connection: ApiConnection = {
  protocol: 'azure-openai-responses',
  baseUrl: 'https://synthetic.openai.azure.com/openai/v1',
  model: 'deployment-alias',
  price: { input: 2, output: 8 },
};
const targetFor = (suffix: string, configured = connection) => ({
  ...apiTarget(process.cwd(), join(testDirectory(), suffix), preset, `api-custom-api-${suffix}`, 'Synthetic API'),
  apiConnection: configured,
});

test('custom connections normalize method URLs and Azure roots without rerouting unrelated paths', () => {
  for (const path of ['', '/', '/openai', '/openai/v1/', '/responses', '/openai/v1/responses/'])
    assert.equal(
      validateApiConnection({ ...connection, baseUrl: `https://synthetic.openai.azure.com${path}` }).baseUrl,
      connection.baseUrl,
    );
  for (const [protocol, suffix] of [
    ['openai-responses', '/responses'],
    ['openai-completions', '/chat/completions'],
    ['anthropic-messages', '/messages'],
  ] as const)
    assert.equal(
      validateApiConnection({ ...connection, protocol, baseUrl: `https://proxy.invalid/prefix/v1${suffix}` }).baseUrl,
      'https://proxy.invalid/prefix/v1',
    );
  for (const changes of [
    { protocol: 'unknown' },
    { baseUrl: 'https:synthetic.invalid' },
    { baseUrl: 'https://bad_host.invalid' },
    { baseUrl: 'https://synthetic.invalid\\responses' },
    { baseUrl: 'https://user:secret@synthetic.invalid' },
    { baseUrl: 'https://synthetic.invalid?api-version=secret' },
    { baseUrl: 'https://synthetic.invalid#secret' },
    { baseUrl: 'https://synthetic.invalid/openai/deployments/old/responses' },
    { baseUrl: 'https://synthetic.invalid/openai/v1/messages' },
    { model: 'alias with spaces' },
    { model: '../bad\nheader' },
    { price: { input: 0, output: 1 } },
    { price: { input: 1, output: NaN } },
    { price: { input: Number.MAX_VALUE, output: 1 } },
  ])
    assert.throws(() => validateApiConnection({ ...connection, ...changes }));
});

test('custom Pi config isolates the key and uses explicit conservative model metadata and prices', async () => {
  const target = targetFor('config');
  const env = apiEnvironment(target, preset, key, { OPENAI_API_KEY: 'ambient', AZURE_OPENAI_API_KEY: 'ambient' });
  assert.equal(env.PUGPORT_API_KEY, key);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.AZURE_OPENAI_API_KEY, undefined);
  const file = join(target.agentDir!, 'models.json');
  const text = readFileSync(file, 'utf8');
  assert.ok(!text.includes(key));
  assert.equal(JSON.parse(text).providers[preset.runtimeProvider].apiKey, '$PUGPORT_API_KEY');
  const config = await ModelConfig.load(file);
  assert.equal(config.getError(), undefined);
  const provider = composeModelProvider(preset.runtimeProvider, undefined, config, undefined);
  const [model] = provider.getModels();
  assert.equal(model.id, connection.model);
  assert.equal(model.api, connection.protocol);
  assert.equal(model.reasoning, false);
  assert.deepEqual(model.input, ['text']);
  assert.equal(model.contextWindow, 32768);
  assert.equal(model.maxTokens, 4096);
  assert.deepEqual(model.cost, { input: 2, output: 8, cacheRead: 2, cacheWrite: 4 });
  assert.deepEqual(mergeApiModels(target, piModels({ models: provider.getModels() }))[0].price, connection.price);
  let discoveryRequests = 0;
  await refreshApiModelList(target, key, async () => {
    discoveryRequests++;
    throw new Error('no discovery');
  });
  assert.equal(discoveryRequests, 0);
});

test('configured limits reach the Pi model metadata on macOS only', () => {
  const limits = { contextWindow: 65536, maxTokens: 32768 };
  const target = targetFor('limits', { ...connection, limits });
  const onMac = apiConnectionModel(target, fakeHost('darwin'));
  assert.equal(onMac.contextWindow, 65536);
  assert.equal(onMac.maxTokens, 32768);
  for (const platform of ['win32', 'linux'] as const) {
    const elsewhere = apiConnectionModel(target, fakeHost(platform));
    assert.equal(elsewhere.contextWindow, 32768);
    assert.equal(elsewhere.maxTokens, 4096);
  }
  const unset = apiConnectionModel(targetFor('limits-unset'), fakeHost('darwin'));
  assert.equal(unset.contextWindow, 32768);
  assert.equal(unset.maxTokens, 4096);
});

test('the Pi config file carries configured limits on macOS and the defaults elsewhere', async () => {
  const limits = { contextWindow: 65536, maxTokens: 32768 };
  for (const [platform, expected] of [
    ['darwin', limits],
    ['win32', { contextWindow: 32768, maxTokens: 4096 }],
    ['linux', { contextWindow: 32768, maxTokens: 4096 }],
  ] as const) {
    const target = targetFor(`limits-file-${platform}`, { ...connection, limits });
    syncApiModelsConfig(target, preset, fakeHost(platform));
    const file = join(target.agentDir!, 'models.json');
    const written = JSON.parse(readFileSync(file, 'utf8')).providers[preset.runtimeProvider].models[0];
    assert.equal(written.contextWindow, expected.contextWindow, platform);
    assert.equal(written.maxTokens, expected.maxTokens, platform);
    const config = await ModelConfig.load(file);
    assert.equal(config.getError(), undefined);
    const [model] = composeModelProvider(preset.runtimeProvider, undefined, config, undefined).getModels();
    assert.equal(model.contextWindow, expected.contextWindow, platform);
    assert.equal(model.maxTokens, expected.maxTokens, platform);
  }
});

for (const host of ['synthetic.openai.azure.com', 'synthetic.services.ai.azure.com'])
  test(`generated config resolves its isolated key and Azure SDK uses api-key and deployment at ${host}`, async () => {
    const target = targetFor(`azure-request-${host.split('.')[1]}`, {
      ...connection,
      baseUrl: `https://${host}/openai/v1`,
    });
    const env = apiEnvironment(target, preset, key, {});
    const config = await ModelConfig.load(join(target.agentDir!, 'models.json'));
    const provider = composeModelProvider(preset.runtimeProvider, undefined, config, undefined);
    const auth = await provider.auth.apiKey!.resolve({
      ctx: { env: async (name) => env[name], fileExists: async () => false },
      signal: new AbortController().signal,
    });
    assert.equal(auth?.auth.apiKey, key);
    let requests = 0;
    const result = await provider
      .streamSimple(
        provider.getModels()[0],
        normalizeContext({
          messages: [{ role: 'user', content: 'Synthetic request', timestamp: 0 }],
        }),
        {
          ...auth!.auth,
          maxRetries: 0,
          fetch: async (input, init) => {
            requests++;
            const request = new Request(input, init);
            const url = new URL(request.url);
            assert.equal(url.origin, `https://${host}`);
            assert.equal(url.pathname, '/openai/v1/responses');
            assert.equal(url.searchParams.get('api-version'), 'v1');
            assert.equal(request.headers.get('api-key'), key);
            assert.equal(request.headers.get('authorization'), null);
            const body = (await request.json()) as Record<string, unknown>;
            assert.equal(body.model, connection.model);
            assert.equal(body.max_output_tokens, 4096);
            assert.equal(body.stream, true);
            assert.equal(body.reasoning, undefined);
            const event = {
              type: 'response.completed',
              response: {
                id: 'synthetic-response',
                status: 'completed',
                output: [],
                usage: {
                  input_tokens: 100,
                  output_tokens: 10,
                  total_tokens: 110,
                  input_tokens_details: { cached_tokens: 0 },
                },
              },
            };
            return new Response(`event: response.completed\ndata: ${JSON.stringify(event)}\n\n`, {
              headers: { 'content-type': 'text/event-stream' },
            });
          },
        },
      )
      .result();
    assert.equal(requests, 1);
    assert.equal(result.stopReason, 'stop', result.errorMessage ?? 'Azure stream failed');
    assert.equal(result.usage.cost.total, 0.00028);
  });

for (const [protocol, suffix, header] of [
  ['openai-responses', '/responses', 'authorization'],
  ['openai-completions', '/chat/completions', 'authorization'],
  ['anthropic-messages', '/messages', 'x-api-key'],
] as const)
  test(`custom ${protocol} uses the matching SDK endpoint and authentication`, async () => {
    const target = targetFor(protocol, { ...connection, protocol, baseUrl: 'https://synthetic.invalid/prefix/v1' });
    const env = apiEnvironment(target, preset, key, {});
    const config = await ModelConfig.load(join(target.agentDir!, 'models.json'));
    const provider = composeModelProvider(preset.runtimeProvider, undefined, config, undefined);
    const auth = await provider.auth.apiKey!.resolve({
      ctx: { env: async (name) => env[name], fileExists: async () => false },
      signal: new AbortController().signal,
    });
    let requests = 0;
    const result = await provider
      .streamSimple(
        provider.getModels()[0],
        normalizeContext({ messages: [{ role: 'user', content: 'Synthetic transport request', timestamp: 0 }] }),
        {
          ...auth!.auth,
          maxRetries: 0,
          fetch: async (input, init) => {
            requests++;
            const request = new Request(input, init);
            assert.equal(new URL(request.url).pathname, `/prefix/v1${suffix}`);
            assert.equal(request.headers.get(header), header === 'authorization' ? `Bearer ${key}` : key);
            const body = (await request.json()) as Record<string, unknown>;
            assert.equal(body.model, connection.model);
            assert.equal(body.stream, true);
            return new Response(
              JSON.stringify({
                error: { type: 'synthetic_test_error', message: 'Synthetic rejection after request validation' },
              }),
              { status: 400, headers: { 'content-type': 'application/json' } },
            );
          },
        },
      )
      .result();
    assert.equal(requests, 1);
    assert.equal(result.stopReason, 'error');
  });

test('custom API reaches Bifrost with an isolated virtual key and preserves the model, stream and usage', async () => {
  const virtualKey = 'sk-bf-synthetic-pilot';
  const gateway = {
    ...connection,
    protocol: 'openai-completions' as const,
    baseUrl: 'http://127.0.0.1:8080/openai/v1',
    model: 'pilot',
  };
  const target = targetFor('bifrost', gateway);
  const env = apiEnvironment(target, preset, virtualKey, { OPENAI_API_KEY: 'upstream-key-must-not-leak' });
  assert.equal(env.OPENAI_API_KEY, undefined);
  const config = await ModelConfig.load(join(target.agentDir!, 'models.json'));
  const provider = composeModelProvider(preset.runtimeProvider, undefined, config, undefined);
  const auth = await provider.auth.apiKey!.resolve({
    ctx: { env: async (name) => env[name], fileExists: async () => false },
    signal: new AbortController().signal,
  });
  let requests = 0;
  const result = await provider
    .streamSimple(
      provider.getModels()[0],
      normalizeContext({ messages: [{ role: 'user', content: 'Synthetic gateway request', timestamp: 0 }] }),
      {
        ...auth!.auth,
        maxRetries: 0,
        fetch: async (input, init) => {
          requests++;
          const request = new Request(input, init);
          assert.equal(request.url, `${gateway.baseUrl}/chat/completions`);
          assert.equal(request.headers.get('authorization'), `Bearer ${virtualKey}`);
          const body = (await request.json()) as Record<string, unknown>;
          assert.equal(body.model, gateway.model);
          assert.equal(body.stream, true);
          const chunk = (delta: object, finish: string | null, usage?: object) =>
            `data: ${JSON.stringify({
              id: 'synthetic-gateway',
              object: 'chat.completion.chunk',
              created: 1,
              model: gateway.model,
              choices: [{ index: 0, delta, finish_reason: finish }],
              ...(usage ? { usage } : {}),
            })}\n\n`;
          return new Response(
            chunk({ role: 'assistant', content: 'Gateway ready' }, null) +
              chunk({}, 'stop', { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }) +
              'data: [DONE]\n\n',
            { headers: { 'content-type': 'text/event-stream' } },
          );
        },
      },
    )
    .result();
  assert.equal(requests, 1);
  assert.equal(result.stopReason, 'stop', result.errorMessage ?? 'Gateway stream failed');
  assert.equal(result.model, gateway.model);
  assert.deepEqual(result.content, [{ type: 'text', text: 'Gateway ready' }]);
  assert.equal(result.usage.input, 3);
  assert.equal(result.usage.output, 2);
  assert.equal(result.usage.totalTokens, 5);
});

function fixture(t: TestContext) {
  const dir = join(testDirectory(), `controller-${Math.random().toString(36).slice(2)}`);
  const previous = process.env.COMBORUNNER_SECRETS_DIR;
  process.env.COMBORUNNER_SECRETS_DIR = join(dir, 'secrets');
  const create = () => {
    const controller = new Controller(dir, join(dir, 'data'), { readAccountIdentity: () => undefined });
    clearInterval(controller.timer);
    t.mock.method(controller as unknown as { checkApiKey(): void }, 'checkApiKey', () => {});
    return controller;
  };
  const controllers: Controller[] = [];
  t.after(async () => {
    for (const controller of controllers) if (controller.store.db.isOpen) await controller.close();
    if (previous === undefined) delete process.env.COMBORUNNER_SECRETS_DIR;
    else process.env.COMBORUNNER_SECRETS_DIR = previous;
  });
  return () => {
    const controller = create();
    controllers.push(controller);
    return controller;
  };
}

test('a re-added provider budget excludes earlier extra usage', async (t) => {
  const controller = fixture(t)();
  controller.targets = [];
  await controller.addApiProvider('deepseek', key);
  controller.recordApiExtraUsage('api-deepseek', { tokens: 10, costUsd: 3 });
  await controller.removeApiProvider('api-deepseek');
  await controller.addApiProvider('deepseek', key, undefined, undefined, { budget: { limitUsd: 10 } });
  assert.equal(controller.apiProviders()[0].budget?.spentUsd, 0);
  controller.recordApiExtraUsage('api-deepseek', { tokens: 1, costUsd: 1 });
  assert.equal(controller.apiProviders()[0].budget?.spentUsd, 1);
});

test('workspace discovery schedules a refresh with the discovered workspace', async (t) => {
  const controller = fixture(t)();
  controller.targets = [];
  await controller.addApiProvider('anthropic', key);
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ data: [{ id: 'wrkspc_test' }] })));
  const refreshed: string[] = [];
  t.mock.method(controller, 'refresh', async (options?: Parameters<Controller['refresh']>[0]) => {
    assert.deepEqual(options?.runtimeIds, ['api-anthropic']);
    refreshed.push(controller.targets[0].apiWorkspaceId!);
  });
  const internal = controller as unknown as { detectApiWorkspace(id: string): Promise<boolean> };
  assert.equal(await internal.detectApiWorkspace('api-anthropic'), true);
  assert.deepEqual(refreshed, ['wrkspc_test']);
});

test('removing or setting a workspace clears an old lookup failure', async (t) => {
  const controller = fixture(t)();
  controller.targets = [];
  await controller.addApiProvider('anthropic', key);
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 403 }));
  const internal = controller as unknown as { detectApiWorkspace(id: string): Promise<boolean> };
  await internal.detectApiWorkspace('api-anthropic');
  assert.equal(controller.apiProviders()[0].workspaceLookup?.outcome, 'refused');
  controller.setApiWorkspace('api-anthropic', 'wrkspc_test');
  assert.equal(controller.apiProviders()[0].workspaceLookup, undefined);
  controller.setApiWorkspace('api-anthropic', '');
  assert.equal(controller.apiProviders()[0].workspaceLookup, undefined);
  await internal.detectApiWorkspace('api-anthropic');
  await controller.removeApiProvider('api-anthropic');
  await controller.addApiProvider('anthropic', key);
  assert.equal(controller.apiProviders()[0].workspaceLookup, undefined);
});

test('an old workspace lookup cannot update a replacement card with the same key', async (t) => {
  const controller = fixture(t)();
  controller.targets = [];
  await controller.addApiProvider('anthropic', key);
  let finish!: (response: Response) => void;
  t.mock.method(globalThis, 'fetch', () => new Promise<Response>((resolve) => (finish = resolve)));
  const internal = controller as unknown as { detectApiWorkspace(id: string): Promise<boolean> };
  const pending = internal.detectApiWorkspace('api-anthropic');
  await controller.removeApiProvider('api-anthropic');
  await controller.addApiProvider('anthropic', key);
  finish(new Response('', { status: 403 }));
  assert.equal(await pending, false);
  assert.equal(controller.apiProviders()[0].workspaceLookup, undefined);
});

test('missing-key discovery handles malformed custom connections', async () => {
  const adapter = createPiAdapter({ key: () => undefined });
  for (const apiConnection of [undefined, {}]) {
    const target = { ...targetFor('no-key'), apiConnection } as ReturnType<typeof targetFor>;
    const snapshot = await adapter.discover(target);
    assert.equal(snapshot.status, 'error');
    assert.deepEqual(snapshot.models, []);
  }
});

test('invalid connection or budget never saves a key; custom connection and budget survive restart', async (t) => {
  const create = fixture(t);
  const controller = create();
  controller.targets = [];
  for (const options of [
    {},
    { connection: { ...connection, baseUrl: 'https://secret@synthetic.invalid' } },
    { connection, budget: { limitUsd: -1 } },
    { connection: { ...connection, price: undefined }, budget: { limitUsd: 10 } },
  ]) {
    await assert.rejects(controller.addApiProvider('custom-api', key, undefined, undefined, options));
    assert.equal(readApiKey('api-custom-api'), undefined);
    assert.equal(controller.targets.length, 0);
  }
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  await controller.addApiProvider('custom-api', key, 'Synthetic Azure', undefined, {
    connection: { ...connection, baseUrl: 'https://synthetic.openai.azure.com/responses' },
    budget: { limitUsd: 10, expiresAt },
  });
  const original = controller.targets[0];
  assert.deepEqual(original.apiConnection, connection);
  assert.equal(original.apiBudget?.expiresAt, expiresAt);
  await controller.close();
  const restarted = create();
  const saved = restarted.targets.find((target) => target.id === original.id)!;
  assert.deepEqual(saved.apiConnection, connection);
  assert.deepEqual(saved.apiBudget, original.apiBudget);
  assert.equal(readApiKey(saved.id), key);
  assert.deepEqual(restarted.apiProviders().find((card) => card.targetId === saved.id)?.connection, connection);
  assert.ok(!JSON.stringify(saved).includes(key));
  // Context and output limits are saved with the connection and survive a restart too.
  const limited = { ...connection, limits: { contextWindow: 65536, maxTokens: 32768 } };
  await restarted.removeApiProvider(saved.id);
  await restarted.addApiProvider('custom-api', key, 'Synthetic limits', undefined, { connection: limited });
  const withLimits = restarted.targets.find((target) => target.label === 'Synthetic limits')!;
  assert.deepEqual(withLimits.apiConnection, limited);
  await restarted.close();
  const again = create();
  assert.deepEqual(again.targets.find((target) => target.id === withLimits.id)?.apiConnection, limited);
  assert.deepEqual(again.apiProviders().find((card) => card.targetId === withLimits.id)?.connection, limited);
});

test('malformed persisted connections stay visible and removable without exposing invalid view values', async (t) => {
  const create = fixture(t);
  const controller = create();
  const malformed = [
    undefined,
    null,
    false,
    true,
    42,
    'invalid',
    [],
    {},
    { ...connection, protocol: {} },
    { ...connection, baseUrl: { invalid: 'child' } },
    { ...connection, model: [] },
    { ...connection, price: 'invalid' },
  ];
  const targets = malformed.map((apiConnection, index) => ({
    ...targetFor(`malformed-${index}`),
    apiConnection,
  }));
  const valid = targetFor('persisted-valid', { ...connection, baseUrl: `${connection.baseUrl}/responses/` });
  const builtin = apiTarget(controller.root, controller.dataDir, apiPreset('deepseek')!, 'api-deepseek', 'DeepSeek');
  controller.store.db
    .prepare('INSERT INTO config(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run('targets', JSON.stringify([...targets, valid, builtin]));
  await controller.close();

  const restarted = create();
  const providers = JSON.parse(JSON.stringify(restarted.apiProviders()));
  for (const target of targets) {
    const provider = providers.find((row: { targetId: string }) => row.targetId === target.id);
    assert.ok(provider);
    assert.equal(provider.preset, 'custom-api');
    assert.equal(provider.label, target.label);
    assert.equal(provider.enabled, target.enabled);
    assert.equal(provider.connection, undefined);
    assert.equal(provider.connectionError, 'API 连接配置无效，请移除后重新添加。');
  }
  assert.deepEqual(providers.find((row: { targetId: string }) => row.targetId === valid.id)?.connection, connection);
  assert.equal(providers.find((row: { targetId: string }) => row.targetId === valid.id)?.connectionError, undefined);
  assert.equal(providers.find((row: { targetId: string }) => row.targetId === builtin.id)?.preset, 'deepseek');
  assert.equal(providers.find((row: { targetId: string }) => row.targetId === builtin.id)?.connectionError, undefined);
  assert.deepEqual(
    restarted.store
      .config<Array<{ apiConnection?: unknown }>>('targets', [])
      .slice(0, targets.length + 1)
      .map((target) => target.apiConnection),
    [...malformed, valid.apiConnection],
  );
  await restarted.removeApiProvider(targets[9].id);
  assert.ok(!restarted.apiProviders().some((provider) => provider.targetId === targets[9].id));
});

test('unpriced custom models stay unknown and budgets require explicit prices', async (t) => {
  const unpriced = { ...connection, price: undefined };
  const target = targetFor('unknown', unpriced);
  syncApiModelsConfig(target, preset);
  const model = mergeApiModels(target, piModels({ models: apiCatalog(target) }))[0];
  assert.equal(model.price, undefined);
  assert.equal(model.priceSource, undefined);
  assert.deepEqual(model.efforts, ['off']);
  const controller = fixture(t)();
  controller.targets = [];
  await controller.addApiProvider('custom-api', key, undefined, undefined, { connection: unpriced });
  assert.throws(() => controller.updateApiBudget(controller.targets[0].id, { limitUsd: 10 }), /价格/);
});

test('custom estimated pricing follows existing expiry, reservation and concurrency routing', () => {
  const now = Date.now();
  const target = targetFor('route');
  const policy = apiBudgetPolicy(
    { limitUsd: 10, expiresAt: new Date(now + 3600_000).toISOString() },
    undefined,
    new Date(now - 3600_000).toISOString(),
  );
  const snapshot: RuntimeSnapshot = {
    id: target.id,
    provider: 'pi',
    gateway: 'api',
    apiProvider: preset.id,
    apiConnection: connection,
    label: target.label,
    environment: 'native',
    installed: true,
    status: 'ready',
    models: mergeApiModels(target, piModels({ models: apiCatalog(target) })),
    quota: { status: 'unknown', source: 'synthetic', observedAt: null, windows: [] },
    accounting: { mode: 'usage', source: 'synthetic' },
    capabilities: { execute: true, resume: true, cancel: true, approvals: true },
    refreshedAt: new Date(now).toISOString(),
    apiBudgetState: apiBudgetView(policy, 0, 0, 0, now),
  };
  const settings: Settings = {
    refreshSeconds: 60,
    reservePercent: 10,
    maxQuotaAgeSeconds: 180,
    preferCli: true,
    designProvider: 'claude',
    architectureProvider: 'codex',
    routineProvider: 'codex',
    unknownQuotaPolicy: 'manual-only',
    defaultProjectPath: 'C:/synthetic',
    maxConcurrentRuns: 0,
  };
  const input = {
    prompt: 'Rename a variable',
    projectPath: 'C:/synthetic',
    kind: 'general' as const,
    runtimeId: target.id,
  };
  assert.equal(
    route(input, [snapshot], settings, new Set(), now).model,
    `${preset.runtimeProvider}/${connection.model}`,
  );
  assert.deepEqual(apiCreditPace(snapshot.apiBudgetState, now), { plannedUsd: 5, priority: 0.5 });
  assert.equal(route({ ...input, runtimeId: undefined }, [snapshot], settings, new Set(), now).runtimeId, target.id);
  for (const budget of [
    apiBudgetView(policy, 9.5, 0, 0, now),
    apiBudgetView(policy, 0, 9.5, 0, now),
    apiBudgetView(policy, 0, 0, 0, now + 3600_000),
  ])
    assert.throws(() => route(input, [{ ...snapshot, apiBudgetState: budget }], settings, new Set(), now));
  assert.throws(() =>
    route(
      input,
      [snapshot],
      settings,
      {
        reservations: new Map([[quotaPoolKey(snapshot), 4]]),
        settlingPools: new Set(),
      },
      now,
    ),
  );
  const updated = targetFor('route', { ...connection, price: { input: 3, output: 9 } });
  assert.deepEqual(mergeApiModels(updated, snapshot.models)[0].price, { input: 3, output: 9 });
  const details = piModelAuditDetails(
    {
      target,
      route: { model: snapshot.models[0].id },
      apiBudget: { maxCostUsd: 1, expiresAt: policy.expiresAt },
    } as ExecuteContext,
    'set_model',
    'requested',
  );
  assert.match(
    JSON.stringify(details),
    /azure-openai-responses.*synthetic.openai.azure.com.*deployment-alias.*user-estimate/,
  );
  assert.match(JSON.stringify(details), /budgetDecision.*maxCostUsd/);
  assert.ok(!JSON.stringify(details).includes(key));
});
