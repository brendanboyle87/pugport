import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Controller } from '../src/server/controller.ts';
import { hindsightSettingsSchema, loadHindsightSettings } from '../src/server/hindsight-settings.ts';
import { defaultHindsightSettings } from '../src/shared/hindsight.ts';

const configured = {
  ...defaultHindsightSettings,
  enabled: true,
  pythonExecutable: 'C:/Synthetic/python.exe',
  runtimeId: 'api-synthetic',
  projectIds: ['project-stable-id'],
};

test('Hindsight settings reject unknown fields, malformed limits and incomplete opt-in', () => {
  assert.deepEqual(hindsightSettingsSchema.parse(defaultHindsightSettings), defaultHindsightSettings);
  assert.deepEqual(hindsightSettingsSchema.parse(configured), configured);
  for (const patch of [
    { enabled: 'true' },
    { pythonExecutable: 'python\n--run-unsafe' },
    { runtimeId: 'https://key@host' },
    { projectIds: ['project-stable-id', 'project-stable-id'] },
    { projectIds: ['../project'] },
    { dailyModelCalls: 0 },
    { dailyModelCalls: 101 },
    { dailyModelCalls: 1.5 },
    { recallTimeoutMs: 199 },
    { recallTimeoutMs: 3001 },
    { apiKey: 'synthetic-never-save' },
    { token: 'synthetic-never-save' },
    { pythonExecutable: '' },
    { runtimeId: '' },
    { projectIds: [] },
  ])
    assert.equal(hindsightSettingsSchema.safeParse({ ...configured, ...patch }).success, false, JSON.stringify(patch));
});

test('absent or invalid saved settings fail closed without retaining unrecognized data', () => {
  assert.deepEqual(loadHindsightSettings(undefined), { settings: defaultHindsightSettings, invalid: false });
  for (const value of [null, [], true, { enabled: true }, { ...configured, key: 'synthetic' }])
    assert.deepEqual(loadHindsightSettings(value), { settings: defaultHindsightSettings, invalid: true });
  const loaded = loadHindsightSettings(undefined).settings;
  loaded.projectIds.push('mutation');
  assert.deepEqual(defaultHindsightSettings.projectIds, []);
});

test('controller preserves Hindsight opt-in across restart and rejects invalid writes before persistence', async (t) => {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'pugport-hindsight-settings-')));
  let controller = new Controller(directory, join(directory, 'data'));
  clearInterval(controller.timer);
  t.after(async () => {
    await controller.close();
    assert.equal(dirname(directory).toLowerCase(), realpathSync.native(tmpdir()).toLowerCase());
    assert.ok(directory.includes('pugport-hindsight-settings-'));
    rmSync(directory, { recursive: true, force: true });
  });
  controller.updateSettings({ hindsight: configured, globalInstructions: 'Synthetic unrelated preference' });
  await controller.close();
  controller = new Controller(directory, join(directory, 'data'));
  clearInterval(controller.timer);
  assert.deepEqual(controller.settings.hindsight, configured);
  assert.equal(controller.settings.globalInstructions, 'Synthetic unrelated preference');
  assert.throws(() => controller.updateSettings({ hindsight: { ...configured, dailyModelCalls: 0 } }));
  assert.deepEqual(controller.store.config<{ hindsight?: unknown }>('settings', {}).hindsight, configured);
  controller.store.setConfig('settings', { ...controller.settings, hindsight: { ...configured, token: 'synthetic' } });
  await controller.close();
  const warning = t.mock.method(console, 'warn', () => {});
  controller = new Controller(directory, join(directory, 'data'));
  clearInterval(controller.timer);
  assert.deepEqual(controller.settings.hindsight, defaultHindsightSettings);
  assert.deepEqual(
    controller.store.config<{ hindsight?: unknown }>('settings', {}).hindsight,
    defaultHindsightSettings,
  );
  assert.equal(controller.settings.globalInstructions, 'Synthetic unrelated preference');
  assert.equal(warning.mock.callCount(), 1);
  assert.doesNotMatch(String(warning.mock.calls[0]?.arguments), /synthetic/);
});
