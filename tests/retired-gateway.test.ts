import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { Controller, removedMagpieMessage } from '../src/server/controller.ts';
import { Store } from '../src/server/store.ts';
import { piAdapter } from '../src/server/adapters/pi.ts';
import { codexAdapter } from '../src/server/adapters/codex.ts';
import type { RunInput, RunRecord, RuntimeSnapshot, RuntimeTarget, Settings } from '../src/shared/types.ts';

test('retiring the gateway preserves history and direct API/CLI routing across restart', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'comborunner-retired-gateway-'));
  const dataDir = join(directory, 'data');
  const home = join(directory, 'home');
  mkdirSync(home, { recursive: true });
  const env = {
    HOME: home,
    USERPROFILE: home,
    APPDATA: home,
    LOCALAPPDATA: home,
    PATH: '',
    JEV_API_KEY: undefined,
    TYPESAFE_API_KEY: undefined,
  };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  let controller: Controller | undefined;
  t.after(async () => {
    try {
      await controller?.close();
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      const absolute = resolve(directory);
      assert.ok(
        absolute.startsWith(resolve(tmpdir()) + sep) && basename(absolute).startsWith('comborunner-retired-gateway-'),
      );
      rmSync(absolute, { recursive: true, force: true });
    }
  });
  const retired: RuntimeTarget = {
    id: 'pi-magpie',
    provider: 'pi',
    gateway: 'magpie',
    label: 'Legacy gateway',
    command: 'never-spawn',
    environment: 'native',
    enabled: true,
  };
  const renamed = { ...retired, id: 'old-custom-gateway', label: 'Legacy custom name' };
  const api: RuntimeTarget = {
    id: 'api-deepseek',
    provider: 'pi',
    gateway: 'api',
    apiProvider: 'deepseek',
    label: 'DeepSeek API',
    command: 'fixture',
    environment: 'native',
    enabled: true,
    accountingMode: 'usage',
  };
  const native: RuntimeTarget = {
    id: 'codex-fixture',
    provider: 'codex',
    label: 'Codex',
    command: 'fixture',
    commandDiscovery: 'fixed',
    environment: 'native',
    enabled: true,
  };
  const history: RunRecord = {
    id: 'old-gateway-run',
    prompt: 'Synthetic archived task',
    projectPath: directory,
    kind: 'general',
    status: 'completed',
    route: { runtimeId: retired.id, model: 'magpie/fixture/model', kind: 'general', reasons: [], warnings: [] },
    startedAt: '2026-09-20T00:00:00Z',
    endedAt: '2026-09-20T00:00:01Z',
    nativeSessionId: 'preserved-session',
    output: 'Preserved result',
    events: [],
  };
  const seed = new Store(dataDir);
  seed.setConfig('targets', [retired, renamed, api, native]);
  seed.setConfig('settings', { preferMagpie: true, saveMoney: true, reservePercent: 7, maxConcurrentRuns: 3 });
  seed.setConfig('magpieConnection', { selectedModel: 'fixture/model' });
  seed.saveRun(history);
  seed.close();
  const archive = join(dataDir, 'magpie', 'saved-config.json');
  mkdirSync(join(dataDir, 'magpie'), { recursive: true });
  writeFileSync(archive, '{"preserve":"user-owned archive"}\n');
  const discoveries: string[] = [];
  const discover = async (target: RuntimeTarget): Promise<RuntimeSnapshot> => {
    discoveries.push(target.id);
    assert.notEqual(target.gateway, 'magpie');
    return {
      ...target,
      installed: true,
      status: 'ready',
      authMode: target.provider === 'codex' ? 'chatgpt' : undefined,
      models: [
        {
          id: target.gateway === 'api' ? 'deepseek/deepseek-chat' : 'codex-test',
          label: 'Fixture',
          efforts: ['medium'],
        },
      ],
      quota: {
        status: 'known',
        source: 'fixture',
        observedAt: new Date().toISOString(),
        windows: [
          { id: 'week', label: 'Week', usedPercent: 10, resetsAt: new Date(Date.now() + 3600000).toISOString() },
        ],
      },
      capabilities: { execute: true, resume: true, cancel: true, approvals: true },
      refreshedAt: new Date().toISOString(),
    };
  };
  t.mock.method(piAdapter, 'discover', discover);
  t.mock.method(codexAdapter, 'discover', discover);
  t.mock.method(piAdapter, 'execute', async () => {
    throw new Error('No real model calls in migration tests');
  });
  t.mock.method(codexAdapter, 'execute', async () => {
    throw new Error('No real model calls in migration tests');
  });
  const input: RunInput = { prompt: 'Explain fixture', projectPath: directory, kind: 'general' };
  for (let restart = 0; restart < 2; restart++) {
    controller = new Controller(directory, dataDir, { readAccountIdentity: () => undefined });
    clearInterval(controller.timer);
    for (const legacy of [retired, renamed]) {
      assert.equal(controller.targets.find((target) => target.id === legacy.id)?.enabled, false);
      assert.equal(
        controller.state().targets.some((target) => target.id === legacy.id),
        false,
      );
      assert.throws(() => controller!.updateTarget(legacy.id, { enabled: true }), { message: removedMagpieMessage });
      assert.throws(() => controller!.preview({ ...input, runtimeId: legacy.id }), /Magpie 网关已移除/);
      await assert.rejects(controller.start({ ...input, runtimeId: legacy.id }), /Magpie 网关已移除/);
    }
    assert.equal('preferMagpie' in controller.settings, false);
    assert.equal('saveMoney' in controller.settings, false);
    assert.equal('saveMoney' in controller.store.config('settings', {}), false);
    assert.equal(controller.settings.reservePercent, 7);
    assert.equal(controller.settings.maxConcurrentRuns, 3);
    assert.equal(
      controller.store.config<{ preferMagpie?: boolean }>('legacyMagpieRoutingPreferences', {}).preferMagpie,
      true,
    );
    assert.deepEqual(controller.store.config('magpieConnection', {}), { selectedModel: 'fixture/model' });
    assert.deepEqual(controller.run(history.id), history);
    assert.equal(readFileSync(archive, 'utf8'), '{"preserve":"user-owned archive"}\n');
    await controller.refresh({ runtimeIds: [retired.id, renamed.id, api.id, native.id] });
    assert.equal(controller.preview({ ...input, runtimeId: api.id, executionPolicy: 'api-only' }).runtimeId, api.id);
    assert.equal(
      controller.preview({ ...input, runtimeId: native.id, executionPolicy: 'cli-only' }).runtimeId,
      native.id,
    );
    controller.updateSettings({ preferMagpie: true, saveMoney: true } as Partial<Settings>);
    assert.equal('preferMagpie' in controller.settings, false);
    assert.equal('saveMoney' in controller.settings, false);
    assert.equal('saveMoney' in controller.store.config('settings', {}), false);
    await controller.close();
    controller = undefined;
  }
  assert.deepEqual(discoveries.sort(), [api.id, api.id, native.id, native.id].sort());
});
