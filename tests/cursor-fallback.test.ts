import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cursorModelPool } from '../src/shared/cursor-models.ts';
import {
  cursorEquivalent,
  cursorFamilies,
  cursorModelForPin,
  nativeFamily,
  parseCursorModel,
} from '../src/shared/model-family.ts';
import { route, RouteUnavailableError } from '../src/server/routing.ts';
import type { RunInput, RuntimeSnapshot, Settings } from '../src/shared/types.ts';

test('Cursor model ids split into family, effort, speed and thinking; CLI models name the same families', () => {
  assert.deepEqual(parseCursorModel('grok-4.7-high-fast'), {
    id: 'grok-4.7-high-fast',
    family: 'grok-4.7',
    effort: 'high',
    fast: true,
    thinking: false,
  });
  assert.equal(parseCursorModel('cursor-grok-4.6-low').family, 'grok-4.6');
  assert.deepEqual(
    [parseCursorModel('claude-opus-5-thinking-high')].map((v) => [v.family, v.effort, v.thinking]),
    [['claude-opus-5', 'high', true]],
  );
  assert.equal(parseCursorModel('claude-opus-5-5-max').family, 'claude-opus-5-5');
  assert.equal(parseCursorModel('gpt-5.5-extra-high').effort, 'xhigh');
  assert.equal(parseCursorModel('gpt-5.2').effort, undefined);

  assert.equal(nativeFamily('grok', { id: 'grok-4.7', label: 'grok-4.7' }), 'grok-4.7');
  assert.equal(nativeFamily('claude', { id: 'opus', label: 'Opus 5.5' }), 'claude-opus-5-5');
  assert.equal(nativeFamily('claude', { id: 'fable', label: 'Fable 5.1' }), 'claude-fable-5-1');
  assert.equal(nativeFamily('claude', { id: 'claude-opus-5', label: 'Opus 5' }), 'claude-opus-5');
  assert.equal(nativeFamily('claude', { id: 'default', label: 'Default (recommended)' }), undefined);
  assert.equal(nativeFamily('codex', { id: 'gpt-5.6-sol', label: 'gpt-5.6-sol' }), 'gpt-5.6-sol');

  const cursor = [
    'grok-4.7-low',
    'grok-4.7-high',
    'grok-4.7-high-fast',
    'grok-4.7-xhigh',
    'claude-opus-5-high',
    'claude-opus-5-thinking-high',
  ].map((id) => ({ id }));
  assert.equal(cursorEquivalent(cursor, 'grok-4.7', 'high'), 'grok-4.7-high', 'standard speed before fast');
  assert.equal(
    cursorEquivalent(cursor, 'grok-4.7', 'medium'),
    'grok-4.7-low',
    'nearest effort when the exact one is missing',
  );
  assert.equal(
    cursorEquivalent(cursor, 'claude-opus-5', 'high'),
    'claude-opus-5-thinking-high',
    'Claude keeps thinking',
  );
  assert.equal(cursorEquivalent(cursor, 'gpt-6-astra', 'high'), undefined);
  assert.deepEqual(cursorFamilies([{ id: 'auto' }, ...cursor]), [
    { id: 'grok-4.7', label: 'grok-4.7', efforts: ['low', 'high', 'xhigh'] },
    { id: 'claude-opus-5', label: 'claude-opus-5', efforts: ['high'] },
  ]);
});

const now = Date.parse('2026-10-04T12:00:00Z');
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
const base = (patch: Partial<RuntimeSnapshot>): RuntimeSnapshot =>
  ({
    environment: 'native',
    installed: true,
    status: 'ready',
    refreshedAt: iso(),
    capabilities: { execute: true, resume: true, cancel: true, approvals: true },
    ...patch,
  }) as RuntimeSnapshot;
const grok = (id: string, label: string, used: number) =>
  base({
    id,
    label,
    provider: 'grok',
    models: [
      { id: 'grok-4.7', label: 'grok-4.7', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high' },
      { id: 'grok-4.7-build-fast', label: 'grok-4.7-build-fast', efforts: ['high'] },
    ],
    quota: {
      status: 'known',
      source: 'fixture',
      observedAt: iso(),
      windows: [{ id: 'weekly', label: '每周额度', usedPercent: used, resetsAt: iso(48 * 3_600_000) }],
    },
  });
const cursor = base({
  id: 'cursor-native',
  label: 'Cursor · 本机',
  provider: 'cursor',
  models: ['auto', 'grok-4.7-medium', 'grok-4.7-high', 'grok-4.7-high-fast', 'claude-opus-5-thinking-high'].map(
    (id) => ({
      id,
      label: id,
      efforts: [],
      quotaPool: cursorModelPool(id),
    }),
  ),
  quota: {
    status: 'known',
    source: 'fixture',
    observedAt: iso(),
    windows: [
      { id: 'cursor-auto', label: 'Cursor Models', modelPool: 'cursor', usedPercent: 0, resetsAt: iso(48 * 3_600_000) },
      { id: 'cursor-api', label: 'Other Models', modelPool: 'other', usedPercent: 0, resetsAt: iso(48 * 3_600_000) },
    ],
  },
});
const input = (patch: Partial<RunInput> = {}): RunInput => ({
  prompt: '把第三章的对白改得更自然',
  projectPath: 'C:/Fixture',
  kind: 'general',
  provider: 'grok',
  ...patch,
});
const run = (value: RunInput, snapshots: RuntimeSnapshot[], config: Settings = settings) =>
  route(value, snapshots, config, new Set(), now);

test('executor checklist: quota fallback skips unchecked Cursor cards and never widens the allowed pool', () => {
  const allowedCursor = { ...cursor, id: 'cursor-b', label: 'Cursor B' };
  const low = [grok('grok-native', 'Grok', 95), cursor, allowedCursor];
  const config = { ...settings, excludedExecutors: [cursor.id] };
  assert.equal(run(input(), low, config).runtimeId, 'cursor-b');
  assert.throws(
    () => run(input(), low, { ...config, excludedExecutors: [cursor.id, 'cursor-b'] }),
    (error: unknown) => error instanceof RouteUnavailableError && error.kind === 'quota',
  );
});

test('when every Grok account is below the reserve, the same model runs through Cursor and says so', () => {
  const low = [grok('grok-native', 'Grok · 本机', 95), grok('grok-b', 'Grok B', 92), cursor];
  const decision = run(input({ effort: 'high' }), low);
  assert.deepEqual([decision.runtimeId, decision.model], ['cursor-native', 'grok-4.7-high']);
  assert.match(
    decision.reasons[0]!,
    /Grok · 本机 的额度已低于保留线，这次改由 Cursor · 本机 的 grok-4.7-high 运行（同款模型 grok-4.7，计入 Cursor Models 额度）/,
  );
  assert.match(decision.warnings[0]!, /改由 Cursor/);
  // A pinned card, named model and explicit effort carry over.
  assert.equal(
    run(input({ provider: undefined, runtimeId: 'grok-b', model: 'grok-4.7', effort: 'medium' }), low).model,
    'grok-4.7-medium',
  );
  // Automatic fallback must use the task's normal routing effort, not the CLI catalog's default high.
  const normal = run(input(), [grok('grok-native', 'Grok · 本机', 30)]);
  assert.equal(normal.effort, 'medium');
  assert.equal(run(input(), low).model, `grok-4.7-${normal.effort}`);
  // With one Grok account still above the reserve, Grok keeps the task.
  assert.equal(
    run(input(), [grok('grok-native', 'Grok · 本机', 95), grok('grok-b', 'Grok B', 30), cursor]).runtimeId,
    'grok-b',
  );
});

test('adult material, a turned-off setting, a model Cursor lacks or an exhausted Cursor pool keep the wait', () => {
  const low = [grok('grok-native', 'Grok · 本机', 95), cursor];
  const waits = (value: RunInput, snapshots = low, config = settings) =>
    assert.throws(
      () => run(value, snapshots, config),
      (error) => error instanceof RouteUnavailableError && error.kind === 'quota',
    );
  waits(input({ prompt: '写第二章的性爱描写' }));
  waits(input({ relayReason: 'content' }));
  waits(input(), low, { ...settings, cursorFallback: false });
  waits(input({ model: 'grok-4.7-build-fast' }));
  const spent = {
    ...cursor,
    quota: { ...cursor.quota, windows: cursor.quota.windows.map((w) => ({ ...w, usedPercent: 99 })) },
  };
  waits(input(), [grok('grok-native', 'Grok · 本机', 95), spent]);
  // Without a Cursor executor there is nothing to fall back to.
  waits(input(), [grok('grok-native', 'Grok · 本机', 95)]);
});

test('parameterized Cursor catalogs expose real efforts and retain saved fast and thinking pins', () => {
  const models = [
    { id: 'auto', efforts: [] },
    { id: 'grok-4.7', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' },
    { id: 'claude-opus-5', efforts: ['low', 'medium', 'high', 'max'], defaultEffort: 'medium' },
  ];
  assert.deepEqual(cursorFamilies(models), [
    { id: 'grok-4.7', label: 'grok-4.7', efforts: ['low', 'medium', 'high'] },
    { id: 'claude-opus-5', label: 'claude-opus-5', efforts: ['low', 'medium', 'high', 'max'] },
  ]);
  assert.equal(cursorEquivalent(models, 'grok-4.7', 'high'), 'grok-4.7');
  assert.equal(cursorEquivalent(models, 'grok-4.7', 'max'), undefined);
  assert.deepEqual(cursorModelForPin(models, 'grok-4.7-high-fast'), {
    id: 'grok-4.7-high-fast',
    efforts: ['high'],
    defaultEffort: 'high',
  });
  assert.equal(cursorModelForPin(models, 'claude-opus-5-thinking-high')?.id, 'claude-opus-5-thinking-high');
  assert.equal(cursorModelForPin(models, 'grok-4.7-max-fast'), undefined);
  assert.equal(cursorModelForPin(models, 'grok-missing-high'), undefined);
});

test('quota fallback carries canonical effort and waits when Cursor cannot honor that effort', () => {
  const parameterized = {
    ...cursor,
    models: [
      { id: 'grok-4.7', label: 'Grok 4.7', efforts: ['low', 'medium', 'high'], quotaPool: cursorModelPool('grok-4.7') },
    ],
  };
  const low = [grok('grok-native', 'Grok · 本机', 95), parameterized];
  const decision = run(input({ model: 'grok-4.7', effort: 'high' }), low);
  assert.deepEqual([decision.runtimeId, decision.model, decision.effort], ['cursor-native', 'grok-4.7', 'high']);
  assert.equal(run(input(), low).effort, 'medium');
  assert.throws(
    () => run(input({ model: 'grok-4.7', effort: 'xhigh' }), low),
    (error) => error instanceof RouteUnavailableError && error.kind === 'quota',
  );
});
