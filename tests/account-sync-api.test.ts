import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { apiSyncFixture } from './helpers/api-sync-fixture.ts';
import { apiPreset } from '../src/shared/api-providers.ts';
import { apiTarget } from '../src/server/api-providers.ts';
import { apiBudgetPolicy } from '../src/server/api-budget.ts';
import { validateApiProviderValue, writeApiSyncModels } from '../src/server/account-sync-api.ts';
import { WorkspaceStore } from '../src/server/workspace-store.ts';
import { SyncStore } from '../src/server/account-sync-store.ts';
import { SyncEngine } from '../src/server/account-sync.ts';
import { AccountSyncFiles } from '../src/server/account-sync-files.ts';
import { DeviceStore } from '../src/server/devices/store.ts';
import { MemorySyncRemote } from '../src/server/account-sync-remote.ts';
import { createDataKey } from '../src/server/account-sync-crypto.ts';
import { replaceSyncedSettings } from '../src/shared/account-sync.ts';

const config = { url: 'https://synthetic.invalid', publishableKey: 'sb_publishable_synthetic' };
function computer(t: TestContext, remote: MemorySyncRemote) {
  let engine: SyncEngine;
  // One seal key per computer, shared by every engine that opens its database.
  const sealKey = createDataKey();
  // Stop the engine before the fixture closes its shared database.
  t.after(async () => {
    engine?.stop();
    await engine?.drain();
  });
  const host = apiSyncFixture(t);
  const local = new SyncStore(
    new WorkspaceStore(host.controller.store.db, { recoverInterrupted: false }),
    join(host.dir, 'data'),
  );
  const files = new AccountSyncFiles(
    new DeviceStore(join(host.secrets, 'devices.json')),
    join(host.dir, 'remote-servers.json'),
    () => {},
    host.api,
  );
  engine = new SyncEngine({
    local,
    files,
    remote,
    deviceId: host.dir,
    config,
    sealKey,
    onApplied: () => replaceSyncedSettings(host.controller.settings, local.settings()),
  });
  return { ...host, local, engine, files, sealKey, remote };
}
async function seed(host: ReturnType<typeof computer>, id: string, provider: string, secret: string) {
  const target = apiTarget(host.dir, join(host.dir, 'data'), apiPreset(provider)!, id, provider);
  host.controller.targets.push(target);
  await host.keys.save(id, secret);
  return target;
}
async function enable(host: ReturnType<typeof computer>) {
  await host.engine.enable({ userId: 'user', generation: host.remote.generation });
  assert.equal(host.engine.status, 'idle');
}
async function cycle(...hosts: ReturnType<typeof computer>[]) {
  for (const host of hosts) {
    await host.engine.syncNow();
    assert.equal(host.engine.status, 'idle');
  }
}
test('two computers restore complete API cards and key files, with no plaintext keys in DB/state/views/cloud', async (t) => {
  const remote = new MemorySyncRemote(),
    a = computer(t, remote),
    b = computer(t, remote);
  const first = await seed(a, 'api-deepseek', 'deepseek', 'synthetic-api-key-one-001');
  const second = await seed(a, 'api-openai', 'openai', 'synthetic-api-key-two-002');
  first.enabled = false;
  first.executionDisabledByUser = true;
  second.apiBudget = apiBudgetPolicy({ limitUsd: 35, expiresAt: '2099-11-01T00:00:00Z', preferExpiring: false });
  a.controller.settings.excludedExecutors = [second.id];
  writeApiSyncModels(first, { ids: ['deepseek-chat'], retired: ['old-model'] });
  await enable(a);
  await cycle(a);
  await enable(b);
  await cycle(b);
  const restored = await b.api.read();
  assert.equal(restored.length, 2);
  assert.equal(readdirSync(b.secrets).filter((name) => name.endsWith('.key')).length, 2);
  const deepseek = restored.find((entry) => entry.value.card.apiProvider === 'deepseek')!;
  const openai = restored.find((entry) => entry.value.card.apiProvider === 'openai')!;
  assert.equal(deepseek.value.card.enabled, false);
  assert.equal(deepseek.value.card.executionDisabledByUser, true);
  assert.deepEqual(deepseek.value.models, { ids: ['deepseek-chat'], retired: ['old-model'] });
  assert.deepEqual(openai.value.card.apiBudget, second.apiBudget);
  assert.equal(openai.value.excluded, true);
  assert.equal(openai.value.card.accountingMode, 'usage');
  assert.ok(b.refresh.mock.callCount() > 0);
  for (const host of [a, b]) {
    const db = host.controller.store.db;
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    const dump = tables
      .map(({ name }) => JSON.stringify(db.prepare(`SELECT * FROM "${String(name).replaceAll('"', '""')}"`).all()))
      .join('\n');
    const state = JSON.stringify(host.controller.state());
    const views = JSON.stringify(host.controller.apiProviders());
    for (const secret of ['synthetic-api-key-one-001', 'synthetic-api-key-two-002']) {
      assert.ok(!dump.includes(secret));
      assert.ok(!state.includes(secret));
      assert.ok(!views.includes(secret));
      assert.ok(!JSON.stringify([...remote.records.values()]).includes(secret));
      assert.ok(JSON.stringify([...remote.secrets.values()]).includes(secret));
      const database = db
        .prepare('PRAGMA database_list')
        .all()
        .find((row) => row.name === 'main')?.file as string;
      for (const path of [database, `${database}-wal`])
        if (existsSync(path)) assert.ok(!readFileSync(path).includes(Buffer.from(secret)));
    }
  }
  for (const target of b.controller.targets)
    assert.ok(readFileSync(join(b.secrets, `${target.id}.key`), 'utf8').startsWith('synthetic-api-key-'));
  const cards = [...remote.records.values()].filter((record) => record.kind === 'api-provider');
  assert.equal(cards.length, 2);
  for (const record of cards) {
    assert.equal(Object.hasOwn(record.body.value, 'key'), false);
    assert.match(remote.secrets.get(JSON.stringify([record.kind, record.id]))?.key ?? '', /^synthetic-api-key-/);
  }
});
test('key changes retain sync identity and deletion removes the other computer card and key', async (t) => {
  const remote = new MemorySyncRemote(),
    a = computer(t, remote),
    b = computer(t, remote);
  await seed(a, 'api-deepseek', 'deepseek', 'synthetic-first-key');
  await enable(a);
  await cycle(a);
  await enable(b);
  await cycle(b);
  const before = (await a.api.read())[0].id;
  const bId = b.controller.targets[0].id;
  await a.keys.save('api-deepseek', 'synthetic-updated-key');
  await cycle(a, b);
  assert.equal((await a.api.read())[0].id, before);
  assert.equal((await b.api.read())[0].id, before);
  assert.equal(b.keys.read(bId), 'synthetic-updated-key');
  a.controller.targets = [];
  await a.keys.remove('api-deepseek');
  await cycle(a, b);
  assert.equal(b.controller.targets.length, 0);
  assert.equal(b.keys.read(bId), undefined);
  assert.ok(
    [...remote.records.values()].filter((record) => record.kind === 'api-provider').every((record) => record.deleted),
  );
});
test('same identity cards deduplicate while different keys with the same original local id remain distinct', async (t) => {
  const remote = new MemorySyncRemote(),
    a = computer(t, remote),
    b = computer(t, remote);
  await seed(a, 'api-deepseek', 'deepseek', 'synthetic-shared-key');
  await seed(b, 'api-custom-name', 'deepseek', 'synthetic-shared-key');
  await seed(b, 'api-deepseek', 'deepseek', 'synthetic-other-key');
  await enable(a);
  await cycle(a);
  await enable(b);
  await cycle(b, a, b, a);
  assert.equal(a.controller.targets.length, 2);
  assert.equal(b.controller.targets.length, 2);
  assert.ok(b.controller.targets.some((target) => target.id === 'api-custom-name'));
  assert.equal(
    [...remote.records.values()].filter((record) => record.kind === 'api-provider' && !record.deleted).length,
    2,
  );
  await b.keys.save('api-custom-name', 'synthetic-shared-rotated');
  await cycle(b, a, b);
  assert.equal(a.controller.targets.length, 2);
  assert.equal((await a.api.read()).filter((entry) => entry.value.key === 'synthetic-shared-rotated').length, 1);
  b.controller.targets = b.controller.targets.filter((target) => target.id !== 'api-custom-name');
  await b.keys.remove('api-custom-name');
  await cycle(b, a, b);
  assert.equal(a.controller.targets.length, 1);
  assert.equal(b.controller.targets.length, 1);
});
test('a restored local API is unavailable on B and its health is not copied to the cloud', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => {
    throw Error('synthetic offline');
  });
  const remote = new MemorySyncRemote(),
    a = computer(t, remote),
    b = computer(t, remote);
  const target = await seed(a, 'api-local', 'custom-api', 'synthetic-local-key');
  target.apiConnection = {
    protocol: 'openai-completions',
    baseUrl: 'http://127.0.0.1:43199/v1',
    model: 'synthetic-model',
  };
  await enable(a);
  await cycle(a);
  await enable(b);
  await cycle(b);
  assert.match(b.controller.apiProviders()[0].unavailable ?? '', /本地 API 或模型不可用/);
  assert.equal((await b.api.read())[0].value.card.enabled, true);
  assert.ok(!JSON.stringify((await b.api.read())[0]).includes('unavailable'));
});
test('a custom API with context and output limits syncs to another computer with its limits', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => {
    throw Error('synthetic offline');
  });
  const remote = new MemorySyncRemote(),
    a = computer(t, remote),
    b = computer(t, remote);
  const target = await seed(a, 'api-local', 'custom-api', 'synthetic-local-key');
  const limits = { contextWindow: 65536, maxTokens: 32768 };
  target.apiConnection = {
    protocol: 'openai-completions',
    baseUrl: 'http://127.0.0.1:43199/v1',
    model: 'synthetic-model',
    limits,
  };
  await enable(a);
  await cycle(a);
  assert.deepEqual((await a.api.read())[0].value.card.apiConnection?.limits, limits);
  await enable(b);
  await cycle(b);
  assert.deepEqual(b.controller.targets[0].apiConnection?.limits, limits);
  const stored = (await b.api.read())[0].value;
  for (const bad of [
    { contextWindow: 512 },
    { maxTokens: 1.5 },
    { contextWindow: 8192, maxTokens: 16384 },
    { extra: 1 },
  ])
    assert.throws(() =>
      validateApiProviderValue({
        ...stored,
        card: { ...stored.card, apiConnection: { ...target.apiConnection, limits: bad } },
      }),
    );
});
test('local API deletion during pull stays deleted and uploads a tombstone on the next cycle', async (t) => {
  const remote = new MemorySyncRemote(),
    a = computer(t, remote);
  await seed(a, 'api-deepseek', 'deepseek', 'synthetic-deletion-key');
  await enable(a);
  await cycle(a);
  const pull = remote.pull.bind(remote);
  let deleted = false;
  remote.pull = async (...args) => {
    if (!deleted) {
      deleted = true;
      a.controller.targets = [];
      await a.keys.remove('api-deepseek');
    }
    return pull(...args);
  };
  await cycle(a, a);
  assert.equal(a.controller.targets.length, 0);
  assert.equal(a.keys.read('api-deepseek'), undefined);
  assert.ok(
    [...remote.records.values()].filter((record) => record.kind === 'api-provider').every((record) => record.deleted),
  );
});
test('routing rules and conversation selections keep pointing to the same card across different local ids', async (t) => {
  const remote = new MemorySyncRemote(),
    a = computer(t, remote),
    b = computer(t, remote);
  await seed(a, 'api-deepseek', 'deepseek', 'synthetic-rule-key');
  await seed(b, 'api-renamed', 'deepseek', 'synthetic-rule-key');
  const rules = {
    version: 2 as const,
    text: 'Literal api-deepseek stays text',
    rules: [],
    unparsed: [],
    roles: { coordinator: { runtimeId: 'api-deepseek', model: 'deepseek/deepseek-chat' } },
    updatedAt: '2026-11-01T00:00:00Z',
  };
  a.controller.settings.routingRules = rules;
  a.controller.settings.routingProfiles = [{ id: '00000000-0000-4000-8000-000000000001', name: 'profile', rules }];
  a.controller.store.setConfig('settings', a.controller.settings);
  a.local.workspace.save('conversation', 'chat', '', {
    id: 'chat',
    title: 'api-deepseek text',
    routing: { ...rules, automaticExecutors: ['api-deepseek'], chapterAgents: false, mask: false },
  });
  // Upgrade an account whose rules were uploaded before API cards had sync identities.
  const oldEngine = new SyncEngine({ local: a.local, remote, deviceId: 'pre-api-sync', config, sealKey: a.sealKey });
  await oldEngine.enable({ userId: 'user', generation: remote.generation });
  await oldEngine.syncNow();
  oldEngine.stop();
  await enable(a);
  await cycle(a);
  await enable(b);
  await cycle(b, a, b, a);
  assert.equal(a.controller.targets.length, 1);
  assert.equal(b.controller.targets.length, 1);
  assert.equal(b.controller.targets[0].id, 'api-renamed');
  assert.equal(b.controller.settings.routingRules?.roles?.coordinator?.runtimeId, 'api-renamed');
  assert.equal(b.controller.settings.routingProfiles?.[0].rules.roles?.coordinator?.runtimeId, 'api-renamed');
  assert.equal(a.controller.settings.routingRules?.roles?.coordinator?.runtimeId, 'api-deepseek');
  const conversation = b.local.workspace.get<any>('conversation', 'chat');
  assert.deepEqual(conversation.routing.automaticExecutors, ['api-renamed']);
  assert.equal(conversation.routing.roles.coordinator.runtimeId, 'api-renamed');
  assert.equal(conversation.title, 'api-deepseek text');
  assert.equal(b.controller.settings.routingRules?.text, 'Literal api-deepseek stays text');
});
test('switching accounts removes former account API secrets instead of uploading them to the next account', async (t) => {
  const remote = new MemorySyncRemote(),
    a = computer(t, remote);
  await seed(a, 'api-deepseek', 'deepseek', 'synthetic-account-one-key');
  await enable(a);
  await cycle(a);
  a.engine.stop();
  const nextRemote = new MemorySyncRemote(undefined, 'other');
  const next = new SyncEngine({
    local: a.local,
    files: a.files,
    remote: nextRemote,
    deviceId: 'other-device',
    config,
    sealKey: a.sealKey,
  });
  try {
    await next.enable({ userId: 'other', generation: nextRemote.generation, allowAccountChange: true });
    await next.syncNow();
    assert.equal(next.status, 'idle');
    assert.equal(a.controller.targets.length, 0);
    assert.equal(a.keys.read('api-deepseek'), undefined);
    assert.equal([...nextRemote.records.values()].filter((record) => record.kind === 'api-provider').length, 0);
  } finally {
    next.stop();
    await next.drain();
  }
});
test('a cloud reset reconstructs API cards from the secret files', async (t) => {
  const remote = new MemorySyncRemote(),
    a = computer(t, remote);
  await seed(a, 'api-deepseek', 'deepseek', 'synthetic-reset-key');
  await enable(a);
  await cycle(a);
  a.engine.stop();
  await remote.deleteMyCloudData();
  a.local.resetAfterCloudDeletion();
  await enable(a);
  await cycle(a);
  assert.equal(a.keys.read('api-deepseek'), 'synthetic-reset-key');
  assert.equal([...remote.secrets.values()][0]?.key, 'synthetic-reset-key');
  assert.equal(
    [...remote.records.values()].filter((record) => record.kind === 'api-provider' && !record.deleted).length,
    1,
  );
});
