import assert from 'node:assert/strict';
import { test } from 'node:test';
import { route, RouteUnavailableError } from '../src/server/routing.ts';
import type { RuntimeSnapshot, Settings } from '../src/shared/types.ts';

// Synthetic cards only; no executor is started.
const now = Date.parse('2026-10-27T20:00:00Z');
const iso = (offset = 0) => new Date(now + offset).toISOString();
const settings = {
  refreshSeconds: 60,
  reservePercent: 10,
  maxQuotaAgeSeconds: 120,
  preferCli: true,
  designProvider: 'claude',
  architectureProvider: 'codex',
  routineProvider: 'codex',
  unknownQuotaPolicy: 'manual-only',
  defaultProjectPath: 'C:/Fixture',
  maxConcurrentRuns: 4,
} as Settings;
const card = (id: string, provider: RuntimeSnapshot['provider'], retryIn?: number): RuntimeSnapshot => ({
  id,
  provider,
  label: id,
  environment: 'native',
  installed: true,
  status: 'ready',
  models: [{ id: `${provider}-model`, label: 'model', efforts: ['low', 'medium', 'high'] }],
  quota: {
    status: 'known',
    source: 'fixture',
    observedAt: iso(),
    windows: [{ id: 'week', label: 'Weekly', usedPercent: 20, resetsAt: iso(3 * 86_400_000), durationMinutes: 10080 }],
  },
  capabilities: { execute: true, resume: true, cancel: true, approvals: true },
  refreshedAt: iso(),
  ...(retryIn === undefined
    ? {}
    : {
        executorCooldown: {
          reason: 'failures' as const,
          streak: 2,
          errorCode: 'runtime-process-closed',
          observedAt: iso(),
          retryAt: iso(retryIn),
        },
      }),
});
const ask = { prompt: 'rename the variable foo to bar', projectPath: 'C:/Fixture', kind: 'auto' as const };

test('automatic routing skips a card in cooldown and says until when', () => {
  const decision = route(
    ask,
    [card('codex-a', 'codex', 5 * 60_000), card('claude-a', 'claude')],
    settings,
    new Set(),
    now,
  );
  assert.equal(decision.runtimeId, 'claude-a');
  // A card PugPort picked itself (a rule or a relay naming it) waits for the cooldown instead of running.
  assert.throws(
    () =>
      route(
        { ...ask, runtimeId: 'codex-a', automaticExecutorSelection: true },
        [card('codex-a', 'codex', 60_000), card('claude-a', 'claude')],
        settings,
        new Set(),
        now,
      ),
    (error: unknown) => error instanceof RouteUnavailableError && error.kind === 'quota',
  );
});

test('a card the user named still runs during its cooldown, and an expired cooldown is ignored', () => {
  assert.equal(
    route({ ...ask, runtimeId: 'codex-a' }, [card('codex-a', 'codex', 60_000)], settings, new Set(), now).runtimeId,
    'codex-a',
  );
  assert.equal(route(ask, [card('codex-a', 'codex', -1)], settings, new Set(), now).runtimeId, 'codex-a');
});

test('when every card is cooling down the task waits for the earliest one', () => {
  assert.throws(
    () =>
      route(
        ask,
        [card('codex-a', 'codex', 15 * 60_000), card('claude-a', 'claude', 5 * 60_000)],
        settings,
        new Set(),
        now,
      ),
    (error: unknown) =>
      error instanceof RouteUnavailableError &&
      error.kind === 'quota' &&
      error.retryAt === iso(5 * 60_000) &&
      /连续 2 次技术失败，冷却到/.test(error.message),
  );
});
