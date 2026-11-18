import assert from 'node:assert/strict';
import { test } from 'node:test';
import { route, RouteUnavailableError } from '../src/server/routing.ts';
import type { RunInput, RuntimeSnapshot, Settings } from '../src/shared/types.ts';

const now = Date.parse('2026-10-12T12:00:00Z');
const settings: Settings = {
  refreshSeconds: 60,
  reservePercent: 10,
  maxQuotaAgeSeconds: 180,
  preferCli: true,
  designProvider: 'claude',
  architectureProvider: 'codex',
  routineProvider: 'codex',
  unknownQuotaPolicy: 'manual-only',
  defaultProjectPath: 'fixture',
  maxConcurrentRuns: 2,
};
const input: RunInput = { prompt: 'Say hello', kind: 'routine', projectPath: 'fixture', permissionMode: 'read-only' };
const free: RuntimeSnapshot = {
  id: 'api-ollama',
  provider: 'pi',
  gateway: 'api',
  apiProvider: 'ollama',
  costTier: 'free',
  local: true,
  mayLog: false,
  label: 'Ollama',
  environment: 'native',
  installed: true,
  status: 'ready',
  models: [{ id: 'pugport-ollama/qwen', label: 'qwen', efforts: ['off'] }],
  quota: { status: 'unknown', source: 'test', observedAt: null, windows: [] },
  accounting: { mode: 'usage', source: 'test' },
  capabilities: { execute: true, resume: true, cancel: true, approvals: true, toolless: true },
  refreshedAt: new Date(now).toISOString(),
};
const paid: RuntimeSnapshot = {
  ...free,
  id: 'codex',
  provider: 'codex',
  label: 'Codex',
  apiProvider: undefined,
  costTier: undefined,
  gateway: undefined,
  models: [{ id: 'gpt-6-sol', label: 'Sol', efforts: ['low', 'medium', 'high'] }],
  accounting: { mode: 'subscription', source: 'test' },
  quota: {
    status: 'known',
    source: 'test',
    observedAt: new Date(now).toISOString(),
    windows: [{ id: 'week', label: 'week', usedPercent: 20, resetsAt: new Date(now + 3600000).toISOString() }],
  },
};

test('automatic routing excludes free sources before rejection classification, including below-reserve subscriptions', () => {
  const decision = route(input, [paid, free], settings, new Set(), now);
  assert.equal(decision.runtimeId, paid.id);
  assert.equal(decision.reasons.filter((r) => r.includes('免费模型')).length, 1);
  const exhausted = {
    ...paid,
    quota: { ...paid.quota, windows: paid.quota.windows.map((w) => ({ ...w, usedPercent: 100 })) },
  };
  assert.throws(
    () => route(input, [exhausted, { ...free, status: 'auth-required' }], settings, new Set(), now),
    (error: unknown) => {
      assert.ok(error instanceof RouteUnavailableError);
      assert.match(error.message, /已排除：Ollama/);
      assert.doesNotMatch(error.message, /Ollama：/);
      return true;
    },
  );
});

test('only a human card pin may choose free; rules, provider pins, children and internal relays cannot', () => {
  assert.equal(route({ ...input, runtimeId: free.id }, [free], settings, new Set(), now).runtimeId, free.id);
  for (const change of [
    { provider: 'pi' },
    { runtimeId: free.id, automaticExecutorSelection: true },
    { runtimeId: free.id, relayReason: 'technical' },
    { runtimeId: free.id, relayReason: 'quota' },
    { runtimeId: free.id, relayReason: 'content' },
    { runtimeId: free.id, agentChild: true },
  ] as Partial<RunInput>[])
    assert.throws(() => route({ ...input, ...change }, [free], settings, new Set(), now), /已排除：Ollama/);
});
