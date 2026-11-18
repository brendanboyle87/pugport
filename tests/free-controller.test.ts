import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Controller } from '../src/server/controller.ts';
import { Store } from '../src/server/store.ts';
import { apiTarget } from '../src/server/api-providers.ts';
import { apiPreset } from '../src/shared/api-providers.ts';
import { automaticExecutorAllowed } from '../src/shared/automatic-executors.ts';
import type { probeFreeSource } from '../src/server/free-sources.ts';

function fixture(t: TestContext, probe: typeof probeFreeSource) {
  const dir = mkdtempSync(join(tmpdir(), 'pugport-free-controller-'));
  t.mock.method(process, 'emitWarning', () => {});
  const previous = process.env.COMBORUNNER_SECRETS_DIR;
  process.env.COMBORUNNER_SECRETS_DIR = join(dir, 'secrets');
  const store = new Store(join(dir, 'data'));
  store.setConfig('targets', []);
  store.close();
  const controller = new Controller(dir, join(dir, 'data'), { freeProbe: probe, readAccountIdentity: () => undefined });
  const controllers = [controller];
  clearInterval(controller.timer);
  // Factory native entries must never invoke real transports in this fixture.
  controller.targets = [];
  t.after(async () => {
    for (const instance of controllers.reverse()) if (instance.store.db.isOpen) await instance.close();
    if (previous === undefined) delete process.env.COMBORUNNER_SECRETS_DIR;
    else process.env.COMBORUNNER_SECRETS_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  return { controller, dir, controllers };
}

test('refresh detects disabled local cards using probes only; removal persists dismissal', async (t) => {
  const calls: string[] = [];
  const { controller } = fixture(t, async (target) => {
    calls.push(target.apiProvider!);
    return target.apiProvider === 'ollama'
      ? { models: [{ id: 'local', name: 'local' }] }
      : { models: [], error: 'runtime-network-error' };
  });
  await controller.refresh();
  const target = controller.targets.find((target) => target.apiProvider === 'ollama')!;
  assert.equal(target.enabled, false);
  const card = controller.apiProviders()[0];
  assert.equal(card.detected, true);
  assert.equal(card.modelCount, 1);
  assert.equal(card.local, true);
  assert.equal(card.mayLog, false);
  assert.equal(card.keyHint, undefined);
  await controller.removeApiProvider(target.id);
  calls.length = 0;
  await controller.refresh();
  assert.ok(!calls.includes('ollama'));
  assert.equal(controller.apiProviders().length, 0);
  assert.equal(controller.store.config<Record<string, boolean>>('freeSourcesDismissed', {}).ollama, true);
});

test('closing during a local probe never touches the closed store or starts another probe', async (t) => {
  let finish!: () => void;
  let calls = 0;
  const { controller } = fixture(t, async () => {
    calls++;
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return { models: [{ id: 'late', name: 'late' }] };
  });
  const refresh = controller.refresh();
  await controller.close();
  finish();
  await refresh;
  assert.equal(calls, 1);
  assert.equal(controller.targets.length, 0);
});

test('a successful explicit probe prepares an enabled recovered source without launching Pi', async (t) => {
  const { controller, dir } = fixture(t, async () => ({ models: [{ id: 'recovered', name: 'recovered' }] }));
  const target = apiTarget(dir, join(dir, 'data'), apiPreset('ollama')!, 'api-ollama', 'Ollama');
  controller.targets.push(target);
  await controller.probeFreeSource(target.id);
  assert.equal(controller.apiProviders()[0].modelCount, 1);
  assert.equal(controller.snapshots[0].status, 'ready');
  assert.equal(controller.snapshots[0].capabilities.approvals, true);
  const config = JSON.parse(readFileSync(join(target.agentDir!, 'models.json'), 'utf8'));
  assert.equal(config.providers['pugport-ollama'].models[0].id, 'recovered');
});

test('adding free sources enforces defaults and URLs, refuses budgets and respects global exclusions', async (t) => {
  const { controller } = fixture(t, async () => ({ models: [], error: 'runtime-network-error' }));
  controller.settings.excludedExecutors = ['excluded-fixture'];
  await assert.rejects(controller.addFreeSource('custom', undefined, undefined, 'https://u:p@example.invalid'));
  await assert.rejects(controller.addFreeSource('groq-free'));
  await assert.rejects(controller.addFreeSource('groq-free', 'fixture-key', undefined, 'https://other.invalid'));
  await controller.addFreeSource('custom', undefined, 'Custom fixture', 'http://127.0.0.1:9999/v1/', false);
  await controller.refresh({ runtimeIds: ['api-custom'] });
  const custom = controller.targets.find((target) => target.id === 'api-custom')!;
  assert.equal(custom.enabled, true);
  assert.equal(custom.apiBaseUrl, 'http://127.0.0.1:9999/v1');
  assert.equal(custom.apiMayLog, false);
  assert.equal(automaticExecutorAllowed({}, controller.settings, custom.id), true);
  assert.deepEqual(controller.settings.excludedExecutors, ['excluded-fixture']);
  assert.throws(() => controller.updateApiBudget(custom.id, { limitUsd: 5 }), /免费来源不支持预算/);
  await controller.addFreeSource('groq-free', 'synthetic-key', undefined, undefined, false);
  await controller.refresh({ runtimeIds: ['api-groq-free'] });
  assert.equal(controller.targets.find((target) => target.apiProvider === 'groq-free')!.apiMayLog, true);
  assert.equal(controller.apiProviders().find((card) => card.preset === 'groq-free')!.mayLog, true);
  controller.settings.excludedExecutors = ['excluded-fixture'];
  controller.updateTarget(custom.id, { enabled: true });
  await controller.refresh();
  assert.equal(automaticExecutorAllowed({}, controller.settings, custom.id), true);
  assert.deepEqual(controller.settings.excludedExecutors, ['excluded-fixture']);
});

test('custom URL and logging survive startup re-derivation; explicit probes clear auth but preserve quota', async (t) => {
  const { controller, dir, controllers } = fixture(t, async () => ({ models: [], error: 'runtime-network-error' }));
  const target = {
    ...apiTarget(dir, join(dir, 'data'), apiPreset('custom')!, 'api-custom', 'fixture'),
    apiBaseUrl: 'http://127.0.0.1:5432/v1',
    apiMayLog: false,
    enabled: false,
  };
  controller.targets.push(target);
  controller.store.setConfig('targets', controller.targets);
  await controller.close();
  const next = new Controller(dir, join(dir, 'data'), {
    freeProbe: async () => ({ models: [{ id: 'one', name: 'one' }] }),
    readAccountIdentity: () => undefined,
  });
  controllers.push(next);
  clearInterval(next.timer);
  next.targets = next.targets.filter((item) => item.gateway === 'api');
  assert.equal(next.targets[0].apiBaseUrl, target.apiBaseUrl);
  assert.equal(next.targets[0].apiMayLog, false);
  next.freeHealth.record(target, 'authentication-required');
  await next.probeFreeSource(target.id);
  assert.equal(next.apiProviders()[0].cooldown, undefined);
  assert.equal(next.apiProviders()[0].modelCount, 1);
  next.freeHealth.record(target, 'quota-or-rate-limit', 80);
  await next.probeFreeSource(target.id);
  assert.equal(next.apiProviders()[0].cooldown?.reason, 'quota');
  next.freeHealth.record(target, 'authentication-required');
  await next.replaceApiKey(target.id, 'synthetic-replacement');
  await next.refresh({ runtimeIds: [target.id] });
  assert.equal(next.apiProviders()[0].cooldown, undefined);
  await next.close();
});
