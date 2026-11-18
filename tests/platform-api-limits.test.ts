import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apiLimitDefaults, validateApiConnection, type ApiConnection } from '../src/shared/api-providers.ts';
import { customApiLimits, customApiLimitsConfigurable } from '../src/server/platform/api-limits.ts';
import { fakeHost } from './helpers/fake-host.ts';

/* Custom API context and output limits are a macOS setting; Windows and Linux keep the fixed defaults. */

const connection: ApiConnection = {
  protocol: 'openai-completions',
  baseUrl: 'http://127.0.0.1:8000/v1',
  model: 'synthetic-local-model',
};

test('macOS reports the limits configured on a custom connection', () => {
  const limits = { contextWindow: 65536, maxTokens: 32768 };
  assert.equal(customApiLimitsConfigurable(fakeHost('darwin')), true);
  assert.deepEqual(customApiLimits({ limits }, fakeHost('darwin')), limits);
});

test('a limit left out on macOS falls back to its default', () => {
  assert.deepEqual(customApiLimits({ limits: { contextWindow: 131072 } }, fakeHost('darwin')), {
    contextWindow: 131072,
    maxTokens: apiLimitDefaults.maxTokens,
  });
  assert.deepEqual(customApiLimits({}, fakeHost('darwin')), { ...apiLimitDefaults });
});

for (const platform of ['win32', 'linux'] as const)
  test(`${platform} keeps the fixed defaults even when a connection carries limits`, () => {
    assert.equal(customApiLimitsConfigurable(fakeHost(platform)), false);
    assert.deepEqual(customApiLimits({ limits: { contextWindow: 65536, maxTokens: 32768 } }, fakeHost(platform)), {
      ...apiLimitDefaults,
    });
  });

test('valid limits survive validation and an empty limits object is dropped', () => {
  const limits = { contextWindow: 65536, maxTokens: 32768 };
  assert.deepEqual(validateApiConnection({ ...connection, limits }).limits, limits);
  assert.deepEqual(validateApiConnection({ ...connection, limits: { maxTokens: 8192 } }).limits, { maxTokens: 8192 });
  assert.equal('limits' in validateApiConnection({ ...connection, limits: {} }), false);
  assert.equal('limits' in validateApiConnection(connection), false);
});

test('limits outside the allowed range, fractions and an output limit above the context are rejected', () => {
  for (const limits of [
    null,
    { contextWindow: 1023 },
    { contextWindow: 2_097_153 },
    { contextWindow: 65536.5 },
    { contextWindow: '65536' },
    { maxTokens: 0 },
    { maxTokens: NaN },
    { maxTokens: Infinity },
    // Above the default context window of 32,768.
    { maxTokens: 65536 },
    { contextWindow: 8192, maxTokens: 16384 },
    // The default output limit of 4,096 no longer fits.
    { contextWindow: 2048 },
  ])
    assert.throws(() => validateApiConnection({ ...connection, limits }), /上限/);
});
