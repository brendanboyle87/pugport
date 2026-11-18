import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { quotaWindowsForModel } from '../src/shared/cursor-models.ts';
import { quotaLines, quotaTotals } from '../src/shared/quota-summary.ts';
import { route } from '../src/server/routing.ts';
import { AccountHealth } from '../src/server/account-health.ts';
import { QuotaCard } from '../src/ui/App.tsx';
import { quotaLeft } from '../src/ui/Executors.tsx';
import type { ModelInfo, RunRecord, RuntimeSnapshot, RuntimeTarget, Settings } from '../src/shared/types.ts';

const now = Date.parse('2026-10-05T18:00:00Z');
const iso = (offset = 0) => new Date(now + offset).toISOString();
const settings: Settings = {
  refreshSeconds: 60,
  reservePercent: 10,
  maxQuotaAgeSeconds: 120,
  preferCli: true,
  designProvider: 'claude',
  architectureProvider: 'codex',
  routineProvider: 'claude',
  unknownQuotaPolicy: 'manual-only',
  defaultProjectPath: 'C:/Fixture',
  maxConcurrentRuns: 4,
};
const model = (id: string, label = id): ModelInfo => ({ id, label, efforts: ['low', 'medium', 'high'] });
const target: RuntimeTarget = {
  id: 'claude-native',
  provider: 'claude',
  label: 'Claude',
  environment: 'native',
  command: 'unused',
  enabled: true,
};
function snapshot(fableUsed = 13): RuntimeSnapshot {
  return {
    ...target,
    installed: true,
    status: 'ready',
    models: [model('fable', 'Fable 5.1'), model('sonnet', 'Sonnet 5')],
    subscription: { label: 'Max (20x)', source: 'fixture', observedAt: iso() },
    refreshedAt: iso(),
    capabilities: { execute: true, resume: true, cancel: true, approvals: true },
    quota: {
      status: 'known',
      source: 'fixture',
      observedAt: iso(),
      windows: [
        { id: 'five_hour', label: '5 小时额度', durationMinutes: 300, usedPercent: 17, resetsAt: iso(3600000) },
        { id: 'seven_day', label: '每周额度', durationMinutes: 10080, usedPercent: 58, resetsAt: iso(86400000) },
        {
          id: 'model_scoped:fable',
          label: 'Fable · 每周额度',
          modelFamily: 'fable',
          durationMinutes: 10080,
          usedPercent: fableUsed,
          resetsAt: iso(86400000),
        },
      ],
    },
  };
}
const choose = (runtime: RuntimeSnapshot, selected?: string, config = settings) =>
  route(
    {
      prompt: 'Review this document',
      projectPath: 'C:/Fixture',
      kind: 'general',
      runtimeId: runtime.id,
      model: selected,
    },
    [runtime],
    config,
    new Set(),
    now,
  );

test('an exhausted Claude family does not block other named families, but still blocks the selected family', () => {
  const runtime = snapshot(100);
  assert.throws(() => choose(runtime, 'fable'), /Fable.*保护阈值/);
  assert.equal(choose(runtime, 'sonnet').model, 'sonnet');
  runtime.models.push(model('claude-fable-5-1', 'Fable 5.1'), model('haiku', 'Haiku 5'));
  assert.throws(() => choose(runtime, 'claude-fable-5-1'), /Fable.*保护阈值/);
  assert.equal(choose(runtime, 'haiku').model, 'haiku');
  assert.equal(choose(runtime).model, 'sonnet');
  assert.equal(choose(runtime, undefined, { ...settings, routeGoal: 'quality' }).model, 'sonnet');
});

test('Claude family filters retain shared limits, and unreported optional family caps are not invented', () => {
  const runtime = snapshot();
  const sonnet = runtime.models[1]!;
  assert.deepEqual(
    quotaWindowsForModel(runtime.quota, sonnet, 'claude').map((value) => value.id),
    ['five_hour', 'seven_day'],
  );
  runtime.quota.windows[1]!.usedPercent = 100;
  for (const id of ['fable', 'sonnet']) assert.throws(() => choose(runtime, id), /每周额度.*保护阈值/);
  runtime.quota.windows[1]!.usedPercent = 58;
  runtime.quota.windows[2]!.usedPercent = null;
  assert.throws(() => choose(runtime, 'fable'), /Fable.*未知/);
  assert.equal(choose(runtime, 'sonnet').model, 'sonnet');
  runtime.quota.observedAt = iso(-120000);
  assert.throws(() => choose(runtime, 'sonnet'), /额度数据已过期/);
});

test('unknown and mixed Claude aliases conservatively check all family limits', () => {
  const runtime = snapshot(100);
  for (const candidate of [model('default', 'Sonnet 5'), model('opusplan', 'Opus 5'), model('future-model')]) {
    runtime.models.push(candidate);
    assert.equal(quotaWindowsForModel(runtime.quota, candidate, 'claude').length, 3);
    assert.throws(() => choose(runtime, candidate.id), /Fable.*保护阈值/);
  }
  // Exact CLI aliases take precedence over a conflicting, older label.
  assert.equal(quotaWindowsForModel(runtime.quota, model('fable', 'Sonnet 5'), 'claude').length, 3);
  assert.equal(quotaWindowsForModel(runtime.quota, model('sonnet', 'Fable 5.1'), 'claude').length, 2);
});

test('Max usage renders separate session, weekly and Fable bars and retains the Fable name in the tray', () => {
  const runtime = snapshot();
  const html = renderToStaticMarkup(createElement(QuotaCard, { runtime, now, maxAge: 120 }));
  assert.match(html, /Max \(20x\)/);
  assert.match(html, /Fable · 每周额度/);
  for (const value of ['83%', '42%', '87%']) assert.ok(html.includes(value), value);
  assert.equal((html.match(/role="progressbar"/g) ?? []).length, 3);
  assert.deepEqual(
    quotaLines([runtime], [target])[0]!.windows.map((value) => value.name),
    ['5h', '周', 'Fable 周'],
  );
});

test('a family-specific Claude failure does not put the whole account on a weekly cooldown', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const health = new AccountHealth(db, () => now);
  const runtime = snapshot(100);
  const run: RunRecord = {
    id: 'family-failure',
    prompt: 'synthetic test',
    projectPath: 'C:/Fixture',
    kind: 'general',
    status: 'failed',
    route: { runtimeId: target.id, model: 'fable', kind: 'general', reasons: [], warnings: [] },
    startedAt: iso(-1000),
    endedAt: iso(),
    output: '',
    events: [],
    error: 'quota-or-rate-limit',
  };
  health.failure(target, run, runtime);
  assert.equal(health.report()[0]!.retryAt, iso(60000));
  health.clear(target.id);
  runtime.quota.windows[1]!.usedPercent = 100;
  health.failure(target, { ...run, id: 'shared-failure' }, runtime);
  assert.equal(health.report()[0]!.retryAt, iso(86400000));
});

test('Claude account overviews use shared capacity while retaining an exhausted Fable cap separately', () => {
  const runtime = snapshot(100);
  const lines = quotaLines([runtime], [target]);
  assert.equal(lines[0]!.tightest, 42);
  assert.equal(quotaLeft(runtime), 42);
  assert.equal(lines[0]!.windows.find((window) => window.name === 'Fable 周')?.remaining, 0);
  assert.equal(quotaTotals(lines)[0]!.total, 0.42, 'independent model caps are not added to account capacity');
  assert.throws(() => choose(runtime, 'fable'), /Fable.*保护阈值/);
  runtime.quota.windows[1]!.usedPercent = 100;
  assert.equal(quotaLines([runtime], [target])[0]!.tightest, 0);
  assert.equal(quotaLeft(runtime), 0, 'a genuinely exhausted shared limit still empties the account overview');
});

test('account overviews retain existing behavior when only model-specific limits are available', () => {
  const runtime = snapshot(100);
  runtime.quota.windows = runtime.quota.windows.filter((window) => window.modelFamily);
  assert.equal(quotaLines([runtime], [target])[0]!.tightest, 0);
  assert.equal(quotaLeft(runtime), 0, 'no shared window means no invented funded capacity');
  const cursor: RuntimeSnapshot = {
    ...runtime,
    provider: 'cursor',
    quota: {
      ...runtime.quota,
      windows: [
        { id: 'cursor', label: 'Cursor Models', modelPool: 'cursor', usedPercent: 20, resetsAt: iso(86400000) },
        { id: 'other', label: 'Other Models', modelPool: 'other', usedPercent: 100, resetsAt: iso(86400000) },
      ],
    },
  };
  assert.equal(quotaLines([cursor], [target])[0]!.tightest, 0);
  assert.equal(quotaLeft(cursor), 0, 'Cursor independent pools are unchanged by this Claude-only fix');
});
