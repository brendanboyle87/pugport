import assert from 'node:assert/strict';
import { test } from 'node:test';
import { modelDemand, modelSelectionReasons, selectAutomaticModel } from '../src/server/model-selection.ts';
import type { ModelInfo } from '../src/shared/types.ts';

const models = (ids: string[]): ModelInfo[] => ids.map((id) => ({ id, label: id, efforts: ['off', 'high'] }));
const writing = modelDemand('balanced', false, false);

test('Pi GLM generations prefer the plain newest model and flash for light work', () => {
  const catalog = models(['glm-4.6v', 'glm-5.3-highspeed', 'glm-5.3-flash', 'glm-5.3']);
  catalog[3].catalogDefault = true;
  assert.equal(selectAutomaticModel(catalog, 'pi', writing)?.id, 'glm-5.3');
  assert.equal(selectAutomaticModel(catalog, 'pi', modelDemand('save', false, true))?.id, 'glm-5.3-flash');
  assert.match(modelSelectionReasons(catalog[3], 'pi', writing, false).join('\n'), /模型组：glm；版本：5.3/);
});

test('Pi catalog default group beats alphabetical provider order, then compares versions inside it', () => {
  const catalog = models(['deepseek-v4-pro', 'qwen3.7-max', 'qwen3.8-max']);
  catalog[1].catalogDefault = true;
  assert.equal(selectAutomaticModel(catalog, 'pi', writing)?.id, 'qwen3.8-max');
});

test('Pi Anthropic default Opus does not override standard or light demand', () => {
  const catalog = models(['anthropic/claude-opus-4-8', 'anthropic/claude-sonnet-4-6', 'anthropic/claude-haiku-4-5']);
  catalog[0].catalogDefault = true;
  assert.equal(selectAutomaticModel(catalog, 'pi', writing)?.id, catalog[1].id);
  assert.equal(selectAutomaticModel(catalog, 'pi', modelDemand('save', false, true))?.id, catalog[2].id);
  assert.equal(selectAutomaticModel(catalog, 'pi', modelDemand('balanced', true, false))?.id, catalog[0].id);
});

test('Pi OpenRouter default Kimi does not block strong models for complex tasks', () => {
  const catalog = models(['openrouter/moonshotai/kimi-k2.6', 'openrouter/anthropic/claude-opus-4-8']);
  catalog[0].catalogDefault = true;
  assert.equal(selectAutomaticModel(catalog, 'pi', writing)?.id, catalog[0].id);
  assert.equal(selectAutomaticModel(catalog, 'pi', modelDemand('balanced', true, false))?.id, catalog[1].id);
});

test('Pi Mistral default does not override light demand', () => {
  const catalog = models(['mistral/devstral-latest', 'mistral/mistral-small-latest']);
  catalog[0].catalogDefault = true;
  assert.equal(selectAutomaticModel(catalog, 'pi', modelDemand('save', false, true))?.id, catalog[1].id);
});

test('Pi OpenRouter versions stop before parameter counts and dates', () => {
  for (const ids of [
    ['openrouter/qwen/qwen3-235b-a22b', 'openrouter/qwen/qwen3.5-32b'],
    ['openrouter/qwen/qwen3-2025-12-31', 'openrouter/qwen/qwen3.5-2024'],
    ['openrouter/qwen/qwen3.5-32b', 'openrouter/qwen/qwen3.5'],
  ])
    assert.equal(selectAutomaticModel(models(ids), 'pi', writing)?.id, ids[1]);
});
