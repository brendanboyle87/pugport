import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chooseCursorPool, cursorModelPool, type CursorPool } from '../src/shared/cursor-models.ts';
import { route, RouteUnavailableError } from '../src/server/routing.ts';
import type { RunInput, RuntimeSnapshot, Settings } from '../src/shared/types.ts';

// Synthetic catalogs and quota readings only; no executor or provider is contacted.

type Row = {
  name: string;
  tier: 'light' | 'standard' | 'strong';
  headroom?: Partial<Record<CursorPool, number>>;
  offered?: Partial<Record<CursorPool, boolean>>;
  order: Array<CursorPool | 'dynamic'>;
  reason?: RegExp;
};

const rows: Row[] = [
  {
    name: 'light work starts in Cursor’s own pool',
    tier: 'light',
    headroom: { cursor: 80, other: 80 },
    order: ['cursor', 'other', 'dynamic'],
    reason: /^简单任务，先用 Cursor 自家模型池（Composer、Grok），把前沿模型池留给复杂任务$/,
  },
  {
    name: 'hard work starts in the frontier pool',
    tier: 'strong',
    headroom: { cursor: 80, other: 80 },
    order: ['other', 'cursor', 'dynamic'],
    reason: /^复杂任务，先用前沿模型池/,
  },
  {
    name: 'ordinary work takes the pool with more left',
    tier: 'standard',
    headroom: { cursor: 30, other: 70 },
    order: ['other', 'cursor', 'dynamic'],
    reason: /^一般任务，先用剩余较多的前沿模型池$/,
  },
  {
    name: 'ordinary work, Cursor’s pool has more left',
    tier: 'standard',
    headroom: { cursor: 70, other: 30 },
    order: ['cursor', 'other', 'dynamic'],
    reason: /^一般任务，先用剩余较多的 Cursor 自家模型池$/,
  },
  {
    name: 'ordinary work with no per-pool reading saves the frontier pool',
    tier: 'standard',
    order: ['cursor', 'other', 'dynamic'],
    reason: /^一般任务，先用 Cursor 自家模型池$/,
  },
  {
    name: 'a preferred pool near its reserve gives way to a healthier one',
    tier: 'light',
    headroom: { cursor: 15, other: 60 },
    order: ['other', 'cursor', 'dynamic'],
    reason: /^简单任务本应先用 Cursor 自家模型池，但它只剩 15%，接近保留线，改用前沿模型池（剩 60%）$/,
  },
  {
    name: 'hard work moves to Cursor’s pool when the frontier pool is nearly used up',
    tier: 'strong',
    headroom: { cursor: 70, other: 14 },
    order: ['cursor', 'other', 'dynamic'],
    reason: /^复杂任务本应先用前沿模型池，但它只剩 14%，接近保留线，改用 Cursor 自家模型池（剩 70%）$/,
  },
  {
    name: 'both pools nearly used up: the preference stands',
    tier: 'strong',
    headroom: { cursor: 18, other: 12 },
    order: ['other', 'cursor', 'dynamic'],
    reason: /^复杂任务，先用前沿模型池/,
  },
  {
    name: 'a nearly used-up pool does not give way to one with no reading',
    tier: 'light',
    headroom: { cursor: 15 },
    order: ['cursor', 'other', 'dynamic'],
    reason: /^简单任务，先用 Cursor 自家模型池/,
  },
  {
    name: 'a used-up preferred pool is passed over',
    tier: 'strong',
    headroom: { cursor: 60, other: 8 },
    offered: { other: false },
    order: ['cursor', 'dynamic'],
    reason: /^复杂任务本应先用前沿模型池，但它已用到保留线，改用 Cursor 自家模型池$/,
  },
  {
    name: 'a preferred pool with no suitable model is passed over',
    tier: 'light',
    headroom: { cursor: 70, other: 70 },
    offered: { cursor: false },
    order: ['other', 'dynamic'],
    reason: /^简单任务本应先用 Cursor 自家模型池，但它现在没有能用的模型，改用前沿模型池$/,
  },
  {
    name: 'with no pooled model, only Auto is left',
    tier: 'standard',
    offered: { cursor: false, other: false },
    order: ['dynamic'],
  },
];

test('the Cursor pool choice follows the task’s difficulty and each pool’s headroom', () => {
  for (const row of rows) {
    const choice = chooseCursorPool({
      tier: row.tier,
      headroom: row.headroom ?? {},
      offered: { cursor: true, other: true, ...row.offered },
      reservePercent: 10,
    });
    assert.deepEqual(choice.order, row.order, row.name);
    if (row.reason) assert.match(choice.reason ?? '', row.reason, row.name);
    else assert.equal(choice.reason, undefined, row.name);
  }
});

const now = Date.parse('2026-10-11T12:00:00Z');
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
const snapshot = (
  id: string,
  provider: RuntimeSnapshot['provider'],
  models: Array<{ id: string; label?: string }>,
  windows: RuntimeSnapshot['quota']['windows'],
): RuntimeSnapshot => ({
  id,
  provider,
  label: id,
  environment: 'native',
  installed: true,
  status: 'ready',
  models: models.map((model) => ({
    id: model.id,
    label: model.label ?? model.id,
    efforts: ['low', 'medium', 'high'],
    ...(provider === 'cursor' ? { quotaPool: cursorModelPool(model.id) } : {}),
  })),
  quota: { status: 'known', source: 'fixture', observedAt: iso(), windows },
  capabilities: { execute: true, resume: true, cancel: true, approvals: true },
  refreshedAt: iso(),
});
// These cases exercise the configured reserve; reset-window release has separate regressions.
const weekly = (used: number) => [{ id: 'week', label: 'Weekly', usedPercent: used, resetsAt: iso(2 * 86_400_000) }];
const cursor = (cursorUsed = 20, otherUsed = 20, ids = ['auto', 'claude-sonnet-5', 'claude-opus-5', 'composer-2.5']) =>
  snapshot(
    'cursor-a',
    'cursor',
    ids.map((id) => ({ id })),
    [
      {
        id: 'cursor-auto',
        label: 'Cursor Models',
        modelPool: 'cursor',
        usedPercent: cursorUsed,
        resetsAt: iso(2 * 86_400_000),
      },
      {
        id: 'cursor-api',
        label: 'Other Models',
        modelPool: 'other',
        usedPercent: otherUsed,
        resetsAt: iso(2 * 86_400_000),
      },
    ],
  );
const routine = 'rename the variable foo to bar';
const complex = 'Refactor the authentication architecture';
const ask = (prompt: string, patch: Partial<RunInput> = {}): RunInput => ({
  prompt,
  projectPath: 'C:/Fixture',
  kind: 'auto',
  ...patch,
});
const decide = (input: RunInput, snapshots: RuntimeSnapshot[]) => route(input, snapshots, settings, new Set(), now);
const reasons = (input: RunInput, snapshots: RuntimeSnapshot[]) => decide(input, snapshots).reasons.join('\n');

test('routing straight to Cursor picks the pool by difficulty and switches when one runs low', () => {
  const pinned = { runtimeId: 'cursor-a' };
  assert.equal(decide(ask(routine, pinned), [cursor()]).model, 'composer-2.5');
  assert.match(reasons(ask(routine, pinned), [cursor()]), /简单任务，Cursor 自家模型池剩 \d+%.*按进度优先用/);
  assert.equal(decide(ask(complex, pinned), [cursor()]).model, 'claude-opus-5');
  assert.match(reasons(ask(complex, pinned), [cursor()]), /复杂任务，先用前沿模型池/);
  // The frontier pool nearly used up: hard work moves to Cursor's own pool (a standard model, never a light one).
  assert.equal(decide(ask(complex, pinned), [cursor(20, 85)]).model, 'composer-2.5');
  assert.match(reasons(ask(complex, pinned), [cursor(20, 85)]), /接近保留线，改用 Cursor 自家模型池/);
  assert.equal(decide(ask(complex, pinned), [cursor(20, 95)]).model, 'composer-2.5');
  assert.match(reasons(ask(complex, pinned), [cursor(20, 95)]), /已用到保留线，改用 Cursor 自家模型池/);
  // Cursor's own pool used up: light work takes the frontier pool rather than wait.
  assert.equal(decide(ask(routine, pinned), [cursor(95, 20)]).model, 'claude-sonnet-5');
  assert.match(reasons(ask(routine, pinned), [cursor(95, 20)]), /已用到保留线，改用前沿模型池/);
  // A pinned model is always respected and carries no pool note.
  const exact = decide(ask(routine, { ...pinned, model: 'claude-opus-5' }), [cursor()]);
  assert.equal(exact.model, 'claude-opus-5');
  assert.doesNotMatch(exact.reasons.join('\n'), /模型池/);
  assert.throws(
    () => decide(ask(routine, { ...pinned, model: 'claude-opus-5' }), [cursor(20, 95)]),
    (error) => error instanceof RouteUnavailableError && error.kind === 'quota',
  );
  // Auto, charged by whatever it picks, is the last resort.
  assert.equal(decide(ask(routine, pinned), [cursor(20, 20, ['auto', 'claude-sonnet-5'])]).model, 'claude-sonnet-5');
  assert.equal(decide(ask(routine, pinned), [cursor(20, 20, ['auto'])]).model, 'auto');
});

test('automatic routing that lands on Cursor uses the same pool choice', () => {
  const codex = snapshot('codex-a', 'codex', [{ id: 'gpt-5.6-sol' }], weekly(97));
  const decision = decide(ask(routine), [codex, cursor()]);
  assert.deepEqual([decision.runtimeId, decision.model], ['cursor-a', 'composer-2.5']);
  assert.match(decision.reasons.join('\n'), /简单任务，Cursor 自家模型池剩 \d+%.*按进度优先用/);
});

const claude = (used: number) =>
  snapshot(
    'claude-a',
    'claude',
    [
      { id: 'claude-opus-5', label: 'Opus 5' },
      { id: 'claude-sonnet-5', label: 'Sonnet 5' },
    ],
    weekly(used),
  );

test('a pinned executor’s quota fallback keeps its model family; only automatic routing changes family', () => {
  const low = (cursorUsed = 20, otherUsed = 20) => [claude(96), cursor(cursorUsed, otherUsed)];
  // Pinned Claude, light work: still Claude through Cursor, said in the old "same model" words.
  const light = decide(ask(routine, { provider: 'claude' }), low());
  assert.deepEqual([light.runtimeId, light.model], ['cursor-a', 'claude-sonnet-5']);
  assert.equal(
    light.reasons[0],
    'claude-a 的额度已低于保留线，这次改由 cursor-a 的 claude-sonnet-5 运行（同款模型 claude-sonnet-5，计入 Other Models 额度）',
  );
  assert.equal(light.reasons[1], '已指定 claude-a：额度回退只换成 Cursor 里的同款模型，不按任务难度换别的模型');
  assert.equal(decide(ask(complex, { provider: 'claude' }), low()).model, 'claude-opus-5');
  assert.equal(decide(ask(complex, { runtimeId: 'claude-a' }), low()).model, 'claude-opus-5');
  assert.equal(decide(ask(routine, { provider: 'claude', model: 'claude-opus-5' }), low()).model, 'claude-opus-5');
  // Pinned Grok on hard work stays Grok, although the frontier pool has room.
  const grok = snapshot('grok-a', 'grok', [{ id: 'grok-4.7' }], weekly(96));
  const withGrok = cursor(20, 20, ['claude-opus-5', 'composer-2.5', 'grok-4.7']);
  const hard = decide(ask(complex, { provider: 'grok' }), [grok, withGrok]);
  assert.equal(hard.model, 'grok-4.7');
  assert.match(hard.reasons[0]!, /同款模型 grok-4\.7，计入 Cursor Models 额度/);
  // The family's pool used up: the pinned task waits rather than taking another family.
  assert.throws(
    () => decide(ask(routine, { provider: 'claude' }), low(20, 95)),
    (error) => error instanceof RouteUnavailableError && error.kind === 'quota',
  );
  // The same accounts with nothing pinned: automatic routing picks Cursor's model by difficulty.
  const automatic = decide(ask(routine), low());
  assert.deepEqual([automatic.runtimeId, automatic.model], ['cursor-a', 'composer-2.5']);
  assert.match(automatic.reasons.join('\n'), /简单任务，Cursor 自家模型池剩 \d+%.*按进度优先用/);
  // Turned off: the original wait stands.
  assert.throws(
    () => route(ask(routine, { provider: 'claude' }), low(), { ...settings, cursorFallback: false }, new Set(), now),
    (error) => error instanceof RouteUnavailableError && error.kind === 'quota',
  );
});

test('adult material the policy sends to Grok may use Grok through Cursor, after native Grok and never GLM', () => {
  const decide = (input: RunInput, snapshots: RuntimeSnapshot[]) =>
    route(input, snapshots, { ...settings, routePreferencesEnabled: true }, new Set(), now);
  const adult = '写第二章的性爱描写';
  const grok = (used: number) => snapshot('grok-a', 'grok', [{ id: 'grok-4.7' }], weekly(used));
  const claudeOk = claude(20);
  const mixed = cursor(20, 20, ['claude-sonnet-5', 'glm-5p3', 'grok-4.7']);
  assert.equal(decide(ask(adult), [grok(20), claudeOk, mixed]).runtimeId, 'grok-a');
  const standIn = decide(ask(adult), [grok(96), claudeOk, mixed]);
  assert.deepEqual([standIn.runtimeId, standIn.model], ['cursor-a', 'grok-4.7']);
  assert.match(standIn.reasons.join('\n'), /原生 Grok 现在接不了这条成人内容，改用 Cursor 里的 Grok 模型/);
  // Cursor without a Grok model offers nothing for adult material; GLM waits for a refusal chain.
  const glmOnly = cursor(20, 20, ['claude-sonnet-5', 'glm-5p3']);
  const elsewhere = decide(ask(adult), [grok(96), claudeOk, glmOnly]);
  assert.notEqual(elsewhere.runtimeId, 'cursor-a');
  // A user's own pin on Grok still waits for its reset.
  assert.throws(
    () => decide(ask(adult, { provider: 'grok' }), [grok(96), mixed]),
    (error) => error instanceof RouteUnavailableError && error.kind === 'quota',
  );
});
