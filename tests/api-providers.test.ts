import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { apiPreset, metaModelIds, routeKey, routeKeyLabel } from '../src/shared/api-providers.ts';
import {
  apiEnvironment,
  apiTarget,
  fetchBalance,
  keyHint,
  readApiKey,
  removeApiKey,
  saveApiKey,
} from '../src/server/api-providers.ts';
import { route } from '../src/server/routing.ts';
import { RoutePolicyEditor, routeOptions } from '../src/ui/RoutePolicyEditor.tsx';
import { routePolicy } from '../src/shared/route-policy.ts';
import type { RuntimeSnapshot, RuntimeTarget, Settings } from '../src/shared/types.ts';
import { ModelConfig } from '../node_modules/@earendil-works/pi-coding-agent/dist/core/model-config.js';
import { composeModelProvider } from '../node_modules/@earendil-works/pi-coding-agent/dist/core/provider-composer.js';
import { createPiAdapter } from '../src/server/adapters/pi.ts';
import { selectAutomaticModel } from '../src/server/model-selection.ts';
import { testDirectory } from '../src/server/platform/under-test.ts';

const deepseek = apiPreset('deepseek')!;

test('an API executor gets only its own key, an isolated home and no ambient credentials', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'pugport-api-env-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const target = apiTarget('C:/app', home, deepseek, 'api-deepseek', 'DeepSeek');
  assert.equal(target.gateway, 'api');
  assert.equal(target.apiProvider, 'deepseek');
  assert.equal(target.accountingMode, 'usage');
  const env = apiEnvironment(target, deepseek, 'sk-test-1234', {
    PATH: 'C:/bin',
    OPENAI_API_KEY: 'ambient',
    DEEPSEEK_API_KEY: 'ambient-deepseek',
    USERPROFILE: 'C:/Users/me',
  });
  assert.equal(env.DEEPSEEK_API_KEY, 'sk-test-1234');
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.PATH, 'C:/bin');
  assert.equal(env.PI_CODING_AGENT_DIR, target.agentDir);
  assert.equal(env.USERPROFILE, target.agentDir);
  // Without a saved key, nothing is borrowed from the environment either.
  assert.equal(
    apiEnvironment(target, deepseek, undefined, { DEEPSEEK_API_KEY: 'ambient' }).DEEPSEEK_API_KEY,
    undefined,
  );
  assert.throws(() => apiTarget('C:/app', 'C:/data', deepseek, '../escape', 'x'));
});

test('keys are saved outside the data folder and can be replaced and removed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cr-secrets-'));
  const previous = process.env.COMBORUNNER_SECRETS_DIR;
  process.env.COMBORUNNER_SECRETS_DIR = dir;
  try {
    assert.equal(readApiKey('api-deepseek'), undefined);
    await saveApiKey('api-deepseek', '  sk-first-0001 ');
    assert.equal(readApiKey('api-deepseek'), 'sk-first-0001');
    await saveApiKey('api-deepseek', 'sk-second-0002');
    assert.equal(readApiKey('api-deepseek'), 'sk-second-0002');
    assert.equal(keyHint(readApiKey('api-deepseek')), '…0002');
    await assert.rejects(saveApiKey('api-deepseek', 'has space'));
    await removeApiKey('api-deepseek');
    assert.equal(readApiKey('api-deepseek'), undefined);
  } finally {
    if (previous === undefined) delete process.env.COMBORUNNER_SECRETS_DIR;
    else process.env.COMBORUNNER_SECRETS_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('balances are read from each platform format, and failures are explained', async () => {
  const reply = (status: number, body: unknown) =>
    (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  const now = () => new Date('2026-10-02T00:00:00Z');
  assert.deepEqual(
    (
      await fetchBalance(
        deepseek,
        'k',
        reply(200, { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '23.50' }] }),
        now,
      )
    ).amounts,
    [{ currency: 'CNY', total: 23.5 }],
  );
  assert.deepEqual(
    (
      await fetchBalance(
        apiPreset('openrouter')!,
        'k',
        reply(200, { data: { total_credits: 10, total_usage: 2.5 } }),
        now,
      )
    ).amounts,
    [{ currency: 'USD', total: 7.5 }],
  );
  assert.deepEqual(
    (await fetchBalance(apiPreset('moonshot-cn')!, 'k', reply(200, { data: { available_balance: 12 } }), now)).amounts,
    [{ currency: 'CNY', total: 12 }],
  );
  assert.match((await fetchBalance(deepseek, 'k', reply(401, {}), now)).error!, /Key 无效/);
  assert.match((await fetchBalance(apiPreset('openai')!, 'k', reply(200, {}), now)).error!, /控制台/);
});

test('route policy lists installed CLIs and added APIs, never the internal runtime', () => {
  const targets = [
    { id: 'codex-native', provider: 'codex', environment: 'native' },
    { id: 'pi-local', provider: 'pi', environment: 'native' },
    { id: 'api-deepseek', provider: 'pi', gateway: 'api', apiProvider: 'deepseek', environment: 'native' },
  ] as RuntimeTarget[];
  assert.deepEqual(routeOptions(targets), [
    { key: 'codex', label: 'Codex' },
    { key: 'api:deepseek', label: 'DeepSeek API' },
  ]);
  assert.equal(routeKey({ provider: 'pi', apiProvider: 'deepseek' }), 'api:deepseek');
  assert.equal(routeKeyLabel('claude'), 'Claude');
  const html = renderToStaticMarkup(
    createElement(RoutePolicyEditor, {
      value: routePolicy({ designProvider: 'claude', architectureProvider: 'codex', routePolicy: { design: ['pi'] } }),
      options: routeOptions(targets),
      onChange() {},
    }),
  );
  assert.doesNotMatch(html, />Pi</);
  assert.match(html, /DeepSeek API/);
});

test('a category that names an API platform routes there even with CLI-first', () => {
  const now = Date.parse('2026-10-02T00:00:00Z');
  const base = {
    environment: 'native',
    installed: true,
    status: 'ready',
    capabilities: { execute: true, resume: true, cancel: true, approvals: true },
    refreshedAt: new Date(now).toISOString(),
  } as const;
  const codex: RuntimeSnapshot = {
    ...base,
    id: 'codex-native',
    provider: 'codex',
    label: 'Codex',
    models: [{ id: 'gpt', label: 'gpt', efforts: ['medium'] }],
    quota: {
      status: 'known',
      source: 'test',
      observedAt: new Date(now).toISOString(),
      windows: [{ id: 'w', label: 'w', usedPercent: 10, resetsAt: new Date(now + 3600_000).toISOString() }],
    },
  };
  const api: RuntimeSnapshot = {
    ...base,
    id: 'api-deepseek',
    provider: 'pi',
    apiProvider: 'deepseek',
    label: 'DeepSeek',
    models: [{ id: 'deepseek/deepseek-v4-pro', label: 'V4 Pro', efforts: ['high'] }],
    quota: { status: 'unknown', source: 'test', observedAt: null, windows: [] },
    accounting: { mode: 'usage', source: 'test' },
  };
  const settings = {
    refreshSeconds: 60,
    reservePercent: 10,
    maxQuotaAgeSeconds: 180,
    preferCli: true,
    designProvider: 'claude',
    architectureProvider: 'codex',
    routineProvider: 'codex',
    unknownQuotaPolicy: 'manual-only',
    defaultProjectPath: 'C:/p',
    maxConcurrentRuns: 2,
    routePolicy: { routine: ['api:deepseek'] },
    routePreferencesEnabled: true,
  } as Settings;
  const pick = (kind: 'routine' | 'general') =>
    route({ prompt: 'rename a variable', projectPath: 'C:/p', kind }, [codex, api], settings, new Set(), now);
  assert.equal(pick('routine').runtimeId, 'api-deepseek');
  assert.match(pick('routine').reasons.join('\n'), /DeepSeek API/);
  // Categories that do not name it keep the subscription CLI first.
  assert.equal(pick('general').runtimeId, 'codex-native');
});

test('the routing goal picks lighter or stronger models, and light work moves to an API when a subscription runs low', () => {
  const now = Date.parse('2026-10-02T00:00:00Z');
  const base = {
    environment: 'native',
    installed: true,
    status: 'ready',
    capabilities: { execute: true, resume: true, cancel: true, approvals: true },
    refreshedAt: new Date(now).toISOString(),
  } as const;
  const codex = (used: number): RuntimeSnapshot => ({
    ...base,
    id: 'codex-native',
    provider: 'codex',
    label: 'Codex',
    models: [
      { id: 'gpt-6.1-sol', label: 'Sol', efforts: ['low', 'medium', 'high', 'xhigh'] },
      { id: 'gpt-6-luna', label: 'Luna', efforts: ['low', 'medium', 'high'], lightweight: true },
    ],
    quota: {
      status: 'known',
      source: 'test',
      observedAt: new Date(now).toISOString(),
      windows: [{ id: 'w', label: 'w', usedPercent: used, resetsAt: new Date(now + 3600_000).toISOString() }],
    },
  });
  const api: RuntimeSnapshot = {
    ...base,
    id: 'api-deepseek',
    provider: 'pi',
    apiProvider: 'deepseek',
    label: 'DeepSeek',
    models: [{ id: 'deepseek/deepseek-flash', label: 'Flash', efforts: ['low', 'high'] }],
    quota: { status: 'unknown', source: 'test', observedAt: null, windows: [] },
    accounting: { mode: 'usage', source: 'test' },
  };
  const settings = {
    refreshSeconds: 60,
    reservePercent: 10,
    maxQuotaAgeSeconds: 180,
    preferCli: true,
    designProvider: 'claude',
    architectureProvider: 'codex',
    routineProvider: 'codex',
    unknownQuotaPolicy: 'manual-only',
    defaultProjectPath: 'C:/p',
    maxConcurrentRuns: 2,
  } as Settings;
  const pick = (goal: Settings['routeGoal'], snapshots: RuntimeSnapshot[], kind: 'general' | 'routine' = 'general') =>
    route(
      { prompt: 'write a helper', projectPath: 'C:/p', kind },
      snapshots,
      { ...settings, routeGoal: goal },
      new Set(),
      now,
    );
  assert.deepEqual([pick('save', [codex(20)]).model, pick('save', [codex(20)]).effort], ['gpt-6-luna', 'low']);
  assert.deepEqual(
    [pick('balanced', [codex(20)]).model, pick('balanced', [codex(20)]).effort],
    ['gpt-6.1-sol', 'medium'],
  );
  assert.deepEqual([pick('quality', [codex(20)]).model, pick('quality', [codex(20)]).effort], ['gpt-6.1-sol', 'high']);
  // Plenty of subscription left: it stays first. Nearly used up: light work goes to the API.
  assert.equal(pick('balanced', [codex(20), api], 'routine').runtimeId, 'codex-native');
  assert.equal(pick('balanced', [codex(80), api], 'routine').runtimeId, 'api-deepseek');
  // Heavier work keeps the remaining subscription.
  assert.equal(pick('balanced', [codex(80), api], 'general').runtimeId, 'codex-native');
});

test('API costs show small amounts in full and switch between yuan and dollars', async () => {
  const { money, convert } = await import('../src/ui/Executors.tsx');
  assert.equal(money(0.00048, 'USD'), '$0.0005');
  assert.equal(money(0, 'USD'), '$0.00');
  assert.equal(money(12.5, 'CNY'), '¥12.50');
  assert.equal(money(convert(1, 'USD', 'CNY'), 'CNY'), '¥7.10');
  assert.equal(convert(7.1, 'CNY', 'USD'), 1);
  assert.equal(apiPreset('deepseek')!.currency, 'CNY');
  assert.equal(apiPreset('openai')!.currency, undefined);
});

test('Meta Model API has an isolated key and a complete priced Pi catalog with a Spark default', async (t) => {
  const preset = apiPreset('meta-model-api')!;
  assert.equal(preset.label, 'Meta Model API');
  assert.equal(routeKeyLabel('api:meta-model-api'), 'Meta Model API');
  assert.equal(preset.console, 'https://dev.meta.ai/');
  assert.equal(preset.keyPage, 'https://dev.meta.ai/');
  assert.deepEqual(preset.endpoint, {
    baseUrl: 'https://api.meta.ai/v1',
    api: 'openai-completions',
    discovery: 'openai-models',
  });
  const dir = join(testDirectory(), 'meta-config');
  const target = apiTarget(process.cwd(), dir, preset, 'api-meta-model-api', preset.label);
  const second = apiTarget(process.cwd(), dir, preset, 'api-meta-model-api-2', preset.label);
  const previous = process.env.COMBORUNNER_SECRETS_DIR;
  process.env.COMBORUNNER_SECRETS_DIR = join(dir, 'secrets');
  t.after(() => {
    if (previous === undefined) delete process.env.COMBORUNNER_SECRETS_DIR;
    else process.env.COMBORUNNER_SECRETS_DIR = previous;
  });
  await saveApiKey(target.id, 'synthetic-meta-first');
  await saveApiKey(second.id, 'synthetic-meta-second');
  assert.equal(readApiKey(target.id), 'synthetic-meta-first');
  assert.equal(readApiKey(second.id), 'synthetic-meta-second');
  const env = apiEnvironment(target, preset, readApiKey(target.id), {
    MODEL_API_KEY: 'ambient-meta',
    DEEPSEEK_API_KEY: 'ambient-deepseek',
    OPENAI_API_KEY: 'ambient-openai',
  });
  assert.equal(env.MODEL_API_KEY, 'synthetic-meta-first');
  assert.equal(env.DEEPSEEK_API_KEY, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.HOME, target.agentDir);
  assert.notEqual(target.agentDir, second.agentDir);
  assert.equal(apiEnvironment(second, preset, undefined, env).MODEL_API_KEY, undefined);
  const other = apiTarget(process.cwd(), dir, deepseek, 'api-deepseek-meta-test', 'DeepSeek');
  const otherEnv = apiEnvironment(other, deepseek, 'synthetic-deepseek', env);
  assert.equal(otherEnv.MODEL_API_KEY, undefined);
  assert.equal(otherEnv.DEEPSEEK_API_KEY, 'synthetic-deepseek');
  const file = join(target.agentDir!, 'models.json');
  const raw = readFileSync(file, 'utf8');
  assert.ok(!raw.includes('synthetic-meta-first'));
  const definition = JSON.parse(raw).providers[preset.runtimeProvider];
  assert.equal(definition.apiKey, '$MODEL_API_KEY');
  assert.equal(definition.baseUrl, preset.endpoint!.baseUrl);
  assert.equal(definition.api, 'openai-completions');
  const config = await ModelConfig.load(file);
  assert.equal(config.getError(), undefined);
  const provider = composeModelProvider(preset.runtimeProvider, undefined, config, undefined);
  const models = provider.getModels();
  assert.deepEqual(
    models.map((model) => model.id),
    metaModelIds,
  );
  for (const model of models) {
    assert.equal(model.api, 'openai-completions');
    assert.equal(model.baseUrl, 'https://api.meta.ai/v1');
    assert.equal(model.contextWindow, 32768);
    assert.equal(model.maxTokens, 4096);
    assert.deepEqual(model.input, ['text']);
    assert.deepEqual(
      model.cost,
      model.id === 'muse-wonder-1.0'
        ? { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 0 }
        : { input: 1.25, output: 4.25, cacheRead: 0.15, cacheWrite: 0 },
    );
  }
  const auth = await provider.auth.apiKey!.resolve({
    ctx: { env: async (name) => env[name], fileExists: async () => false },
    signal: new AbortController().signal,
  });
  assert.equal(auth?.auth.apiKey, 'synthetic-meta-first');
  const snapshot = await createPiAdapter({ key: () => undefined }).discover(target);
  assert.equal(snapshot.models.find((model) => model.catalogDefault)?.id, 'pugport-meta/muse-spark-1.3');
  assert.equal(
    selectAutomaticModel(snapshot.models, 'pi', { tier: 'standard', effort: 'off', goal: 'balanced' })?.id,
    'pugport-meta/muse-spark-1.3',
  );
});
