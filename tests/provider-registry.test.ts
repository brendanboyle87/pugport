import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  activeProviders,
  bridgeTiming,
  isApiHarness,
  isNativeCli,
  isRetiredProvider,
  nativeCliProviders,
  nativeVisionProviders,
  providerIds,
  providerSpecs,
  quotaAuthAccepted,
} from '../src/shared/provider-registry.ts';
import type { Provider } from '../src/shared/types.ts';

test('every provider has a spec and the derived lists agree with it', () => {
  const expected: Provider[] = ['codex', 'claude', 'grok', 'cursor', 'gemini', 'pi', 'dsh'];
  assert.deepEqual([...providerIds].sort(), [...expected].sort());
  assert.deepEqual([...nativeCliProviders].sort(), ['claude', 'codex', 'cursor', 'grok']);
  assert.deepEqual([...activeProviders].sort(), ['claude', 'codex', 'cursor', 'grok', 'pi']);
  assert.deepEqual([...nativeVisionProviders].sort(), ['claude', 'codex']);
  for (const id of providerIds) {
    assert.equal(isNativeCli(id), !providerSpecs[id].retired && providerSpecs[id].transport === 'cli');
    assert.equal(isApiHarness(id), providerSpecs[id].transport === 'api');
    assert.equal(isRetiredProvider(id), providerSpecs[id].retired === true);
  }
});

test('unknown or missing providers have no capabilities', () => {
  assert.equal(isNativeCli(undefined), false);
  assert.equal(isNativeCli('magpie'), false);
  assert.equal(isApiHarness(''), false);
  assert.equal(isRetiredProvider('nope'), false);
  assert.equal(quotaAuthAccepted('nope', undefined), true);
  assert.deepEqual(bridgeTiming('nope'), bridgeTiming('codex'));
});

test('only Codex gates quota on its authentication mode', () => {
  assert.equal(quotaAuthAccepted('codex', 'chatgpt'), true);
  assert.equal(quotaAuthAccepted('codex', 'apiKey'), false);
  assert.equal(quotaAuthAccepted('codex', undefined), false);
  for (const id of providerIds.filter((value) => value !== 'codex')) {
    assert.equal(quotaAuthAccepted(id, 'apiKey'), true, id);
    assert.equal(quotaAuthAccepted(id, undefined), true, id);
  }
});
