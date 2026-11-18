import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { Controller } from '../src/server/controller.ts';
import { saveApiKey } from '../src/server/api-providers.ts';
import { temporaryFolder } from './helpers/fake-peer.ts';
import type { RuntimeTarget } from '../src/shared/types.ts';

test('a DeepSeek card can lend its key to web search only on request, server-side', async (t) => {
  const previous = process.env.COMBORUNNER_SECRETS_DIR;
  process.env.COMBORUNNER_SECRETS_DIR = join(temporaryFolder(t, 'pugport-search-key-'), 'secrets');
  t.after(() => {
    if (previous === undefined) delete process.env.COMBORUNNER_SECRETS_DIR;
    else process.env.COMBORUNNER_SECRETS_DIR = previous;
  });
  const card = (id: string, apiProvider: string): RuntimeTarget => ({
    id,
    provider: 'pi',
    gateway: 'api',
    apiProvider,
    label: id,
    environment: 'native',
    enabled: true,
    command: 'never-spawn',
  });
  const updates: unknown[] = [];
  const controller = Object.create(Controller.prototype) as Controller;
  Object.assign(controller, {
    targets: [
      card('api-deepseek-fixture', 'deepseek'),
      card('api-openai-fixture', 'openai'),
      card('api-deepseek-empty', 'deepseek'),
    ],
    webSearch: {
      update: async (input: unknown) => {
        updates.push(input);
        return { provider: 'deepseek', enabled: true, configured: true, keyHint: '••••' };
      },
    },
  });
  await saveApiKey('api-deepseek-fixture', 'sk-synthetic-deepseek');
  await saveApiKey('api-openai-fixture', 'sk-synthetic-openai');
  const view = await controller.useApiKeyForWebSearch('api-deepseek-fixture');
  assert.deepEqual(updates, [{ key: 'sk-synthetic-deepseek', enabled: true }]);
  assert.doesNotMatch(JSON.stringify(view), /sk-synthetic/);
  assert.throws(() => controller.useApiKeyForWebSearch('api-openai-fixture'), /DeepSeek/);
  assert.throws(() => controller.useApiKeyForWebSearch('api-deepseek-empty'), /Key/);
  assert.throws(() => controller.useApiKeyForWebSearch('missing'));
  assert.equal(updates.length, 1);
});
