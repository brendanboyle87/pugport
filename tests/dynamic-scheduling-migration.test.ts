import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Controller } from '../src/server/controller.ts';
import { Store } from '../src/server/store.ts';
import type { RuntimeTarget } from '../src/shared/types.ts';
import { automaticExecutorAllowed } from '../src/shared/automatic-executors.ts';

test('legacy global checklist migrates once and later cards join automatically', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dynamic-scheduling-'));
  const data = join(root, 'data');
  const targets: RuntimeTarget[] = ['codex-native', 'second', 'third'].map((id) => ({
    id,
    provider: 'codex',
    label: id,
    environment: 'native',
    enabled: true,
    command: 'codex',
  }));

  targets.push(
    { ...targets[0]!, id: 'api-anthropic', provider: 'pi', gateway: 'api', apiProvider: 'anthropic' },
    { ...targets[0]!, id: 'api-free-off', provider: 'pi', gateway: 'api', apiProvider: 'ollama', enabled: false },
    { ...targets[0]!, id: 'api-free-on', provider: 'pi', gateway: 'api', apiProvider: 'ollama' },
    { ...targets[0]!, id: 'user-disabled', executionDisabledByUser: true },
  );
  const store = new Store(data);
  store.setConfig('settings', { automaticExecutors: ['codex-native'] });
  store.setConfig('targets', targets);
  store.close();
  let controller = new Controller(root, data);
  clearInterval(controller.timer);
  assert.deepEqual(controller.settings.excludedExecutors, ['second', 'third', 'api-free-on']);
  assert.equal('automaticExecutors' in controller.store.config('settings', {}), false);
  assert.equal(automaticExecutorAllowed({}, controller.settings, 'new-card'), true);
  await controller.close();
  controller = new Controller(root, data);
  clearInterval(controller.timer);
  assert.deepEqual(controller.settings.excludedExecutors, ['second', 'third', 'api-free-on']);
  await controller.close();
});
