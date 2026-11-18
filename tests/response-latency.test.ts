import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RuntimeSnapshot, RuntimeTarget } from '../src/shared/types.ts';
import {
  estimateResponseLatency,
  responseLatencyKey,
  type ResponseLatencySample,
} from '../src/server/response-latency.ts';

const now = Date.parse('2026-10-23T12:00:00Z');
const day = 86_400_000;
const lookup = {
  runtimeId: 'runtime-a',
  key: 'connection-a',
  model: 'model-a',
  effort: 'low',
  sessionMode: 'new' as const,
};
const sample = (
  index: number,
  firstTextMs = 1000,
  changes: Partial<ResponseLatencySample> = {},
): ResponseLatencySample => ({
  ...lookup,
  runId: `run-${index}`,
  observedAt: new Date(now - index * 1000).toISOString(),
  firstTextMs,
  ...changes,
});
const target: RuntimeTarget = {
  id: 'runtime-a',
  provider: 'pi',
  environment: 'native',
  label: 'Example',
  command: 'node',
  args: ['cli.js'],
  agentDir: '/agent/a',
  enabled: true,
  accountFingerprint: 'identity-a',
};
const snapshot: RuntimeSnapshot = {
  id: target.id,
  provider: target.provider,
  environment: target.environment,
  label: target.label,
  installed: true,
  status: 'ready',
  version: '1.0',
  models: [],
  accountFingerprint: 'identity-a',
  quota: { status: 'unknown', source: 'test', observedAt: null, windows: [] },
  capabilities: { execute: true, resume: true, cancel: true, approvals: true, steer: true },
  refreshedAt: new Date(now).toISOString(),
};

test('requires two exact observations and computes the median without mutating samples', () => {
  assert.equal(estimateResponseLatency([], lookup, now), undefined);
  assert.equal(estimateResponseLatency([sample(1)], lookup, now), undefined);
  const values = [sample(2, 9000), sample(1, 1000)];
  const original = structuredClone(values);
  assert.deepEqual(estimateResponseLatency(values, lookup, now), {
    milliseconds: 5000,
    samples: 2,
    lastObservedAt: values[1]!.observedAt,
    scope: 'model',
  });
  assert.deepEqual(values, original);
});

test('uses the latest eight by observation time and retains slow successful samples', () => {
  const values = Array.from({ length: 12 }, (_, index) => sample(index, index < 8 ? (index + 1) * 1000 : 1));
  assert.equal(estimateResponseLatency(values.reverse(), lookup, now)?.milliseconds, 4500);
  assert.equal(estimateResponseLatency(values, lookup, now)?.samples, 8);
  assert.equal(
    estimateResponseLatency([sample(1, 3_600_000), sample(2, 7_200_000)], lookup, now)?.milliseconds,
    5_400_000,
  );
});

test('rejects expired, future, malformed times and non-positive/nonfinite durations', () => {
  const invalid = [
    sample(1, 10, { observedAt: new Date(now - 7 * day).toISOString() }),
    sample(2, 10, { observedAt: new Date(now + 1).toISOString() }),
    sample(3, 10, { observedAt: 'invalid' }),
    ...[0, -1, NaN, Infinity, -Infinity].map((value, index) => sample(index + 4, value)),
  ];
  assert.equal(estimateResponseLatency(invalid, lookup, now), undefined);
  const edge = sample(20, 100, { observedAt: new Date(now - 7 * day + 1).toISOString() });
  assert.equal(estimateResponseLatency([...invalid, edge, sample(21, 300)], lookup, now)?.milliseconds, 200);
  assert.equal(estimateResponseLatency([sample(1), sample(2)], lookup, NaN), undefined);
});

test('isolates runtime, connection, session mode and exact effort', () => {
  for (const changes of [
    { runtimeId: 'other' },
    { key: 'other' },
    { sessionMode: 'resume' as const },
    { effort: 'high' },
    { effort: undefined },
  ])
    assert.equal(estimateResponseLatency([sample(1), sample(2, 100, changes)], lookup, now), undefined);
  assert.equal(estimateResponseLatency([sample(1), sample(2)], { ...lookup, sessionMode: 'resume' }, now), undefined);
  assert.equal(
    estimateResponseLatency(
      [sample(1, 100, { effort: undefined }), sample(2, 200, { effort: undefined })],
      { ...lookup, effort: undefined },
      now,
    )?.milliseconds,
    150,
  );
});

test('falls back only with three low/medium runtime observations and prefers sufficient exact data', () => {
  const values = [
    sample(1, 1000, { model: 'other' }),
    sample(2, 2000, { effort: 'medium' }),
    sample(3, 9000, { model: 'third', effort: 'medium' }),
  ];
  assert.equal(estimateResponseLatency(values.slice(0, 2), lookup, now), undefined);
  assert.deepEqual(estimateResponseLatency(values, lookup, now), {
    milliseconds: 2000,
    samples: 3,
    lastObservedAt: values[0]!.observedAt,
    scope: 'runtime',
  });
  assert.equal(estimateResponseLatency([...values, sample(4, 100), sample(5, 300)], lookup, now)?.milliseconds, 200);
  assert.equal(estimateResponseLatency([...values, sample(4, 100), sample(5, 300)], lookup, now)?.scope, 'model');
});

test('high, default and unknown efforts cannot contaminate or receive runtime fallback', () => {
  const high = [
    sample(1, 10, { effort: 'high' }),
    sample(2, 20, { effort: 'high' }),
    sample(3, 30, { effort: 'high' }),
  ];
  assert.equal(estimateResponseLatency(high, lookup, now), undefined);
  const low = [sample(1), sample(2), sample(3)];
  for (const effort of ['high', 'max', 'off', 'minimal', undefined])
    assert.equal(estimateResponseLatency(low, { ...lookup, model: 'other', effort }, now), undefined);
  assert.equal(estimateResponseLatency(high, { ...lookup, effort: 'high' }, now)?.scope, 'model');
});

test('duplicate run observations do not fabricate sample confidence', () => {
  assert.equal(estimateResponseLatency([sample(1), sample(1), sample(1)], lookup, now), undefined);
});

test('malformed persisted records cannot create fallback confidence or crash estimation', () => {
  const malformed = [null, {}, sample(1, 100, { model: '' }), sample(2, 100, { runId: '' })];
  assert.equal(estimateResponseLatency(malformed as ResponseLatencySample[], lookup, now), undefined);
});

test('connection keys change with account, executable, endpoint, deployment, protocol and CLI version', () => {
  const key = responseLatencyKey(target, snapshot);
  assert.match(key, /^[a-f0-9]{64}$/);
  for (const changes of [
    { provider: 'cursor' as const },
    { command: 'other-node' },
    { args: ['other.js'] },
    { agentDir: '/agent/b' },
    { environment: 'wsl' as const },
    { accountId: 'other-account' },
    { accountHome: '/other-home' },
    { accountFingerprint: 'other-identity' },
    { gateway: 'api' as const },
    { apiProvider: 'other-api' },
    { apiBaseUrl: 'https://other.example/v1' },
    { apiWorkspaceId: 'other-workspace' },
  ])
    assert.notEqual(responseLatencyKey({ ...target, ...changes }, snapshot), key);
  assert.notEqual(responseLatencyKey(target, { ...snapshot, version: '2.0' }), key);
  assert.notEqual(responseLatencyKey(target, { ...snapshot, accountFingerprint: 'new-login' }), key);
  const api = {
    ...target,
    apiConnection: {
      protocol: 'azure-openai-responses' as const,
      baseUrl: 'https://example.test/openai/deployments/a',
      model: 'deployment-a',
    },
  };
  const apiKey = responseLatencyKey(api, snapshot);
  assert.notEqual(
    responseLatencyKey({ ...api, apiConnection: { ...api.apiConnection, model: 'deployment-b' } }, snapshot),
    apiKey,
  );
  assert.notEqual(
    responseLatencyKey({ ...api, apiConnection: { ...api.apiConnection, protocol: 'openai-responses' } }, snapshot),
    apiKey,
  );
  assert.notEqual(
    responseLatencyKey(
      { ...api, apiConnection: { ...api.apiConnection, baseUrl: 'https://example.test/openai/deployments/b' } },
      snapshot,
    ),
    apiKey,
  );
});

test('keys ignore display/quota changes and secret values without ignoring endpoint changes', () => {
  assert.equal(
    responseLatencyKey(target, snapshot),
    responseLatencyKey(
      { ...target, label: 'Renamed' },
      { ...snapshot, refreshedAt: new Date(now + 1000).toISOString(), quota: { ...snapshot.quota, status: 'error' } },
    ),
  );
  const args = (secret: string) => [
    'cli.js',
    '--api-key',
    secret,
    '--token=' + secret,
    '--endpoint',
    'https://example.test/v1',
  ];
  const a = responseLatencyKey({ ...target, args: args('synthetic-one') }, snapshot);
  assert.equal(a, responseLatencyKey({ ...target, args: args('synthetic-two') }, snapshot));
  assert.notEqual(
    a,
    responseLatencyKey({ ...target, args: [...args('synthetic-two').slice(0, -1), 'https://other.test/v1'] }, snapshot),
  );
});

test('endpoint keys ignore URL credentials while retaining non-secret endpoint configuration', () => {
  const endpoint = (secret: string) => `https://user:${secret}@example.test/v1?api_key=${secret}&api-version=v1`;
  const key = responseLatencyKey({ ...target, apiBaseUrl: endpoint('synthetic-one') }, snapshot);
  assert.equal(key, responseLatencyKey({ ...target, apiBaseUrl: endpoint('synthetic-two') }, snapshot));
  assert.notEqual(
    key,
    responseLatencyKey(
      { ...target, apiBaseUrl: endpoint('synthetic-one').replace('api-version=v1', 'api-version=v2') },
      snapshot,
    ),
  );
});

test('a new API credential generation isolates samples without an account fingerprint', () => {
  const api: RuntimeTarget = {
    ...target,
    gateway: 'api',
    apiProvider: 'synthetic-api',
    apiBaseUrl: 'https://example.test/v1',
    accountFingerprint: undefined,
    responseLatencyEpoch: 'synthetic-connection-one',
  };
  const apiSnapshot = { ...snapshot, accountFingerprint: undefined };
  const oldKey = responseLatencyKey(api, apiSnapshot);
  const currentKey = responseLatencyKey({ ...api, responseLatencyEpoch: 'synthetic-connection-two' }, apiSnapshot);
  assert.notEqual(currentKey, oldKey);
  assert.equal(responseLatencyKey(structuredClone(api), structuredClone(apiSnapshot)), oldKey);
  const previous = [sample(1, 100, { key: oldKey }), sample(2, 200, { key: oldKey })];
  assert.equal(estimateResponseLatency(previous, { ...lookup, key: currentKey }, now), undefined);
  assert.equal(estimateResponseLatency(previous, { ...lookup, key: oldKey }, now)?.milliseconds, 150);
});
