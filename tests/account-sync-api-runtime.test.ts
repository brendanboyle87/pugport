import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { apiSyncFixture } from './helpers/api-sync-fixture.ts';
import { apiPreset } from '../src/shared/api-providers.ts';
import { apiTarget } from '../src/server/api-providers.ts';
import {
  AccountSyncApi,
  apiProviderIdentity,
  checkLocalApi,
  localApiUnavailable,
  validateApiProviderValue,
  writeApiSyncModels,
} from '../src/server/account-sync-api.ts';
import { apiBudgetPolicy } from '../src/server/api-budget.ts';
import { route } from '../src/server/routing.ts';
import type { RuntimeSnapshot } from '../src/shared/types.ts';

test('API card import preserves local routing id, key rotation, model list, exclusions and rebuilds paths', async (t) => {
  const a = apiSyncFixture(t),
    b = apiSyncFixture(t);
  const seed = async (f: typeof a, id: string) => {
    const target = {
      ...apiTarget(f.dir, join(f.dir, 'data'), apiPreset('deepseek')!, id, 'Synthetic card'),
      apiBudget: apiBudgetPolicy({ limitUsd: 20, expiresAt: '2099-11-01T00:00:00Z', preferExpiring: false }),
      accountingMode: 'usage' as const,
    };
    f.controller.targets = [target];
    f.controller.settings.excludedExecutors = [id];
    await f.keys.save(id, 'synthetic-key-a');
    writeApiSyncModels(target, { ids: ['deepseek-chat'], retired: ['old-model'] });
    return target;
  };
  const original = await seed(a, 'api-deepseek');
  const local = await seed(b, 'api-my-card');
  const incoming = await a.api.read(),
    prior = await b.api.read();
  assert.notEqual(incoming[0].id, prior[0].id);
  assert.equal(apiProviderIdentity(incoming[0].value), apiProviderIdentity(prior[0].value));
  incoming[0].value.card.label = 'Renamed cloud card';
  await b.api.write(incoming, prior);
  assert.equal(b.controller.targets.length, 1);
  assert.equal(b.controller.targets[0].id, local.id);
  assert.equal(b.controller.targets[0].label, 'Renamed cloud card');
  assert.ok(b.controller.targets[0].agentDir!.startsWith(b.dir));
  assert.ok(!b.controller.targets[0].agentDir!.startsWith(a.dir));
  assert.deepEqual(b.controller.settings.excludedExecutors, [local.id]);
  assert.deepEqual(b.controller.targets[0].apiBudget, original.apiBudget);
  assert.equal(b.controller.targets[0].accountingMode, 'usage');
  const before = await b.api.read();
  assert.equal(before[0].id, incoming[0].id);
  assert.deepEqual(before[0].value.models, incoming[0].value.models);
  incoming[0].value.key = 'synthetic-rotated-key';
  await b.api.write(incoming, before);
  assert.equal(b.keys.read(local.id), 'synthetic-rotated-key');
  assert.equal((await b.api.read())[0].id, incoming[0].id);
  assert.ok(b.refresh.mock.callCount() > 0);
  const state = JSON.stringify(b.controller.state());
  assert.ok(!state.includes('synthetic-rotated-key'));
  assert.ok(!state.includes('synthetic-key-a'));
  await b.api.write([], await b.api.read());
  assert.equal(b.controller.targets.length, 0);
  assert.equal(b.keys.read(local.id), undefined);
});

test('synced billed card remains excluded from automatic routing but can be pinned', async (t) => {
  const b = apiSyncFixture(t);
  const id = `api-${randomUUID()}`;
  const value = validateApiProviderValue({
    id,
    card: { apiProvider: 'deepseek', label: 'Billed card', enabled: true, accountingMode: 'usage' },
    key: 'synthetic-billed-key',
    excluded: true,
  });
  await b.api.write([{ id, value }], []);
  const snapshot: RuntimeSnapshot = {
    id,
    provider: 'pi',
    gateway: 'api',
    apiProvider: 'deepseek',
    label: 'Billed card',
    environment: 'native',
    installed: true,
    status: 'ready',
    capabilities: { execute: true, resume: true, cancel: true, approvals: true },
    models: [{ id: 'deepseek/deepseek-flash', label: 'Flash', efforts: ['low'] }],
    quota: { status: 'unknown', source: 'synthetic', observedAt: null, windows: [] },
    accounting: { mode: 'usage', source: 'synthetic' },
    refreshedAt: new Date().toISOString(),
  };
  assert.throws(
    () =>
      route(
        { prompt: 'write a helper', projectPath: b.dir, kind: 'routine' },
        [snapshot],
        b.controller.settings,
        new Set(),
      ),
    /自动|执行器|可用/,
  );
  assert.equal(
    route(
      { prompt: 'write a helper', projectPath: b.dir, kind: 'routine', runtimeId: id },
      [snapshot],
      b.controller.settings,
      new Set(),
    ).runtimeId,
    id,
  );
});

test('local endpoint health sends no key, follows no redirects and blocks routing on this computer', async (t) => {
  const b = apiSyncFixture(t);
  const id = `api-${randomUUID()}`;
  const target = {
    ...apiTarget(b.dir, join(b.dir, 'data'), apiPreset('custom-api')!, id, 'Local unavailable'),
    apiConnection: {
      protocol: 'openai-completions' as const,
      baseUrl: 'http://127.0.0.1:43199/v1',
      model: 'synthetic-model',
    },
  };
  let calls = 0;
  assert.equal(
    await checkLocalApi(target, (async (_url, init) => {
      calls++;
      assert.equal(init?.method, 'HEAD');
      assert.equal(init?.headers, undefined);
      assert.equal(init?.body, undefined);
      assert.equal(init?.redirect, 'error');
      throw Error('offline');
    }) as typeof fetch),
    false,
  );
  assert.equal(calls, 1);
  assert.equal(
    await checkLocalApi(
      {
        ...target,
        apiConnection: { ...target.apiConnection, model: join(b.dir, 'missing.gguf').replaceAll('\\', '/') },
      },
      (async () => {
        throw Error('must not probe a missing model');
      }) as typeof fetch,
    ),
    false,
  );
  t.mock.method(globalThis, 'fetch', async () => {
    throw Error('synthetic offline');
  });
  const value = validateApiProviderValue({
    id,
    card: { apiProvider: 'custom-api', label: 'Local unavailable', enabled: true, apiConnection: target.apiConnection },
    key: 'synthetic-never-probed-key',
    excluded: false,
  });
  await b.api.write([{ id, value }], []);
  assert.equal(b.controller.apiProviders()[0].unavailable, localApiUnavailable);
  const base = {
    id,
    provider: 'pi',
    gateway: 'api',
    label: 'Local unavailable',
    environment: 'native',
    installed: true,
    status: 'ready',
    models: [{ id: 'synthetic', label: 'synthetic', efforts: [] }],
    quota: { status: 'unknown', source: 'synthetic', observedAt: null, windows: [] },
    capabilities: { execute: true, resume: true, cancel: true, approvals: true },
    refreshedAt: new Date().toISOString(),
  } as RuntimeSnapshot;
  const blocked = (b.controller as unknown as { health(snapshot: RuntimeSnapshot): RuntimeSnapshot }).health(base);
  assert.equal(blocked.status, 'error');
  assert.throws(
    () =>
      route(
        { prompt: 'run', projectPath: b.dir, runtimeId: id, kind: 'routine' },
        [blocked],
        b.controller.settings,
        new Set(),
      ),
    /本地 API 或模型不可用/,
  );
  assert.equal((await b.api.read())[0].value.card.enabled, true);
  assert.equal(Object.hasOwn((await b.api.read())[0].value.card, 'unavailable'), false);
});

test('a local card edit during an asynchronous key write survives the remote update', async (t) => {
  const b = apiSyncFixture(t),
    id = `api-${randomUUID()}`;
  const value = validateApiProviderValue({
    id,
    card: { apiProvider: 'deepseek', label: 'Original', enabled: true },
    key: 'synthetic-original',
    excluded: false,
  });
  await b.api.write([{ id, value }], []);
  const expected = await b.api.read();
  let started!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const slow = new AccountSyncApi(b.controller, {
    ...b.keys,
    save: async (id, key) => {
      started();
      await gate;
      await b.keys.save(id, key);
    },
  });
  const writing = slow.write(
    [{ id, value: { ...value, key: 'synthetic-new-key', card: { ...value.card, label: 'Remote rename' } } }],
    expected,
  );
  await entered;
  b.controller.targets[0].label = 'Local rename';
  b.controller.settings.excludedExecutors = [id];
  release();
  await writing;
  assert.equal(b.controller.targets[0].label, 'Local rename');
  assert.deepEqual(b.controller.settings.excludedExecutors, [id]);
  assert.equal(b.keys.read(id), 'synthetic-new-key');
});

test('sync input rejects executable fields and URLs containing credentials without leaking keys', () => {
  const value = {
    id: `api-${randomUUID()}`,
    card: { apiProvider: 'deepseek', label: 'test', enabled: true, command: 'bad.exe' },
    key: 'synthetic-secret-do-not-echo',
    excluded: false,
  };
  assert.throws(() => validateApiProviderValue(value), /^Error: INVALID_API_PROVIDER$/);
  assert.throws(
    () =>
      validateApiProviderValue({
        ...value,
        card: {
          apiProvider: 'custom-api',
          label: 'test',
          enabled: true,
          apiConnection: {
            protocol: 'openai-completions',
            baseUrl: 'https://user:password@example.invalid/v1',
            model: 'test',
          },
        },
      }),
    /^Error: INVALID_API_PROVIDER$/,
  );
});

test('removing and recreating a card does not reuse its old sync identity', async (t) => {
  const b = apiSyncFixture(t);
  const target = apiTarget(b.dir, join(b.dir, 'data'), apiPreset('ollama')!, 'api-ollama', 'Local model');
  b.controller.targets = [target];
  const before = (await b.api.read())[0].id;
  await b.controller.removeApiProvider(target.id);
  assert.equal(b.controller.store.config<Record<string, string>>('apiSyncIds', {})[target.id], undefined);
  b.controller.targets = [target];
  assert.notEqual((await b.api.read())[0].id, before);
});
