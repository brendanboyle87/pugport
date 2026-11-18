import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chooseCursorPool, cursorModelPool } from '../src/shared/cursor-models.ts';
import { route } from '../src/server/routing.ts';
import type { RunInput, RuntimeSnapshot, Settings } from '../src/shared/types.ts';

// Synthetic catalogs and quota readings only; no executor or provider is contacted.

const now = Date.parse('2026-10-27T15:15:00Z');
const hour = 3_600_000;
const iso = (offset = 0) => new Date(now + offset).toISOString();
const settings: Settings = {
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
};
const card = (
  id: string,
  provider: RuntimeSnapshot['provider'],
  models: string[],
  windows: RuntimeSnapshot['quota']['windows'],
): RuntimeSnapshot => ({
  id,
  provider,
  label: id,
  environment: 'native',
  installed: true,
  status: 'ready',
  models: models.map((model) => ({
    id: model,
    label: model,
    efforts: ['low', 'medium', 'high'],
    ...(provider === 'cursor' ? { quotaPool: cursorModelPool(model) } : {}),
  })),
  quota: { status: 'known', source: 'fixture', observedAt: iso(), windows },
  capabilities: { execute: true, resume: true, cancel: true, approvals: true },
  refreshedAt: iso(),
});
// Monthly pool windows report no length, like Cursor's live data.
const cursor = (cursorUsed: number, otherUsed: number, resetIn = 50 * hour) =>
  card(
    'cursor-native',
    'cursor',
    ['claude-opus-5-5', 'claude-sonnet-5-5', 'gpt-5.6-sol', 'grok-4.7', 'composer-2.5', 'gemini-3.8-flash'],
    [
      {
        id: 'cursor-auto',
        label: 'Cursor Models',
        modelPool: 'cursor',
        usedPercent: cursorUsed,
        resetsAt: iso(resetIn),
      },
      { id: 'cursor-api', label: 'Other Models', modelPool: 'other', usedPercent: otherUsed, resetsAt: iso(resetIn) },
    ],
  );
const weekly = (used: number, resetIn: number) => [
  { id: 'week', label: 'Weekly', usedPercent: used, resetsAt: iso(resetIn), durationMinutes: 7 * 24 * 60 },
];
const ask = (prompt: string, patch: Partial<RunInput> = {}): RunInput => ({
  prompt,
  projectPath: 'C:/Fixture',
  kind: 'auto',
  ...patch,
});
const decide = (input: RunInput, snapshots: RuntimeSnapshot[], patch: Partial<Settings> = {}) =>
  route(input, snapshots, { ...settings, ...patch }, new Set(), now);

test('light work goes to Composer when the Cursor pool is behind its line', () => {
  const decision = decide(ask('rename the variable foo to bar'), [
    cursor(27.7, 62.7),
    card('codex-native', 'codex', ['gpt-5.6-sol'], weekly(60, 3.5 * 24 * hour)),
  ]);
  assert.equal(decision.runtimeId, 'cursor-native');
  assert.equal(decision.model, 'composer-2.5');
  assert.match(decision.reasons.join('\n'), /Cursor 自家模型池剩 72%，2 天后重置，按进度优先用/);
});

test('hard work goes to Cursor’s Claude Opus when both Claude accounts are ahead of plan', () => {
  const claudeAhead = (id: string) => card(id, 'claude', ['opus'], weekly(70, 4 * 24 * hour));
  const decision = decide(ask('Refactor the authentication architecture'), [
    claudeAhead('claude-native'),
    claudeAhead('claude-work'),
    cursor(27.7, 62.7),
  ]);
  assert.equal(decision.runtimeId, 'cursor-native');
  assert.equal(decision.model, 'claude-opus-5-5');
});

test('a Grok task uses Cursor’s Grok when native Grok is ahead and the Cursor pool is behind', () => {
  const grok = card('grok-native', 'grok', ['grok-4.7'], weekly(41, 6.3 * 24 * hour));
  const policy = { routePreferencesEnabled: true, routePolicy: { routine: ['grok'] } };
  const decision = decide(
    ask('rename the variable foo to bar', { kind: 'routine' }),
    [grok, cursor(27.7, 62.7)],
    policy,
  );
  assert.equal(decision.runtimeId, 'cursor-native');
  assert.equal(decision.model, 'grok-4.7');
  // Native Grok behind its line, Cursor far from its reset: native Grok keeps the work.
  const behind = card('grok-native', 'grok', ['grok-4.7'], weekly(5, 6.3 * 24 * hour));
  assert.equal(
    decide(ask('rename the variable foo to bar', { kind: 'routine' }), [behind, cursor(60, 60, 29 * 24 * hour)], policy)
      .runtimeId,
    'grok-native',
  );
});

test('a pinned Cursor card keeps choosing by tier even when the category sends work to Grok', () => {
  const policy = { routePreferencesEnabled: true, routePolicy: { routine: ['grok'] } };
  const decision = decide(
    ask('rename the variable foo to bar', { kind: 'routine', runtimeId: 'cursor-native' }),
    [cursor(27.7, 62.7)],
    policy,
  );
  assert.equal(decision.model, 'composer-2.5');
  assert.doesNotMatch(decision.reasons.join('\n'), /成人内容/);
});

test('a Cursor pool at its reserve line is not chosen', () => {
  const decision = decide(ask('rename the variable foo to bar'), [
    cursor(95, 95),
    card('codex-native', 'codex', ['gpt-5.6-sol'], weekly(60, 3.5 * 24 * hour)),
  ]);
  assert.equal(decision.runtimeId, 'codex-native');
});

test('an explicit model pin is unchanged', () => {
  const decision = decide(ask('rename the variable foo to bar', { runtimeId: 'cursor-native', model: 'grok-4.7' }), [
    cursor(27.7, 62.7),
  ]);
  assert.equal(decision.model, 'grok-4.7');
});

test('pool choice follows pace when both pools can do the work', () => {
  const base = { tier: 'standard' as const, offered: { cursor: true, other: true }, reservePercent: 10 };
  const fits = { cursor: true, other: true };
  assert.deepEqual(
    chooseCursorPool({ ...base, headroom: { cursor: 70, other: 40 }, pace: { cursor: 3, other: 5 }, fits }).order[0],
    'other',
  );
  assert.deepEqual(
    chooseCursorPool({ ...base, headroom: { cursor: 40, other: 70 }, pace: { cursor: 5, other: 3 }, fits }).order[0],
    'cursor',
  );
});

test('a known billing period sets the pool pace instead of the 30-day default', () => {
  const policy = { routePreferencesEnabled: true, routePolicy: { routine: ['grok'] } };
  // Native Grok exactly on its line: 50% left with half the week to go.
  const grok = card('grok-native', 'grok', ['grok-4.7'], weekly(50, 3.5 * 24 * hour));
  const pick = (periodDays: number) => {
    // Both Cursor pools 50% left, resetting in 10 days.
    const cursorCard = cursor(50, 50, 10 * 24 * hour);
    for (const window of cursorCard.quota.windows) window.periodStartedAt = iso((10 - periodDays) * 24 * hour);
    return decide(ask('rename the variable foo to bar', { kind: 'routine' }), [grok, cursorCard], policy).runtimeId;
  };
  // A 30-day period: 33% should be left, 50% is, so Cursor is behind and takes the Grok work.
  assert.equal(pick(30), 'cursor-native');
  // A 14-day trial: 71% should be left, 50% is, so Cursor is ahead and native Grok keeps the work.
  assert.equal(pick(14), 'grok-native');
});
