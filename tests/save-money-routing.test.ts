import { apiBudgetPolicy, apiBudgetView } from '../src/server/api-budget.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { route } from '../src/server/routing.ts';
import type { RunInput, RuntimeSnapshot } from '../src/shared/types.ts';
import { now, settings, input, free, paid } from './save-money-fixture.ts';

export const hosted: RuntimeSnapshot = { ...free, id: 'hosted', apiProvider: 'groq-free', local: false, mayLog: true };
const api: RuntimeSnapshot = { ...free, id: 'paid-api', apiProvider: 'openai', costTier: undefined, local: false };
const saving: RunInput = { ...input, textOnlyPrompt: 'Say hello' };
const choose = (sources: RuntimeSnapshot[], patch: Partial<RunInput> = {}) =>
  route({ ...saving, ...patch }, sources, { ...settings, routeGoal: 'save' }, new Set(), now);

test('save mode orders local free, hosted free, CLI, paid API despite CLI preference', () => {
  assert.equal(choose([api, hosted, paid, free]).runtimeId, free.id);
  assert.equal(choose([api, paid, hosted]).runtimeId, hosted.id);
  assert.equal(choose([api, paid]).runtimeId, paid.id);
  assert.match(choose([free]).reasons.join(' '), /轻量模式/);
});
test('complex, coordinator, agent calls and writable general tasks exclude free', () => {
  for (const patch of [
    { kind: 'architecture' },
    { coordinator: true },
    { agentCalls: true },
    { kind: 'general', permissionMode: 'workspace-write' },
    { kind: 'general', taskJudgment: { status: 'accepted', source: 'jev', complexity: 'complex' } },
  ] as Partial<RunInput>[])
    assert.equal(choose([free, paid], patch).runtimeId, paid.id);
  assert.equal(choose([free, paid], { kind: 'general', permissionMode: 'read-only' }).runtimeId, free.id);
});
test('lightweight skips scarce API-first while legacy message flags cannot override quality', () => {
  const scarce = {
    ...paid,
    quota: { ...paid.quota, windows: paid.quota.windows.map((w) => ({ ...w, usedPercent: 75 })) },
  };
  assert.equal(choose([api, scarce]).runtimeId, paid.id);
  const kept = route(saving, [api, scarce], settings, new Set(), now);
  assert.equal(kept.runtimeId, paid.id);
  assert.match(kept.reasons.join('\n'), /按次计费的 API 卡默认不参与自动选择/);
  const catalog = {
    ...paid,
    models: [
      { id: 'gpt-5.4-mini', label: 'Mini', efforts: ['low', 'medium', 'high'] },
      { id: 'gpt-6-sol', label: 'Sol', efforts: ['low', 'medium', 'high'] },
    ],
  };
  const legacy = { ...saving, saveMoney: true };
  assert.equal(route(legacy, [catalog], { ...settings, routeGoal: 'quality' }, new Set(), now).model, 'gpt-6-sol');
  assert.equal(choose([catalog]).model, 'gpt-5.4-mini');
});

test('automatic lightweight free relay stops after two attempts; explicit free relay remains free-only', () => {
  assert.equal(choose([free, paid], { freeRelayCount: 2 }).runtimeId, paid.id);
  assert.equal(choose([free, paid], { freeRelayCount: 2, freeChain: true }).runtimeId, free.id);
});
test('pins, strict rules, checklist and execution policy remain authoritative', () => {
  assert.equal(choose([free, paid], { runtimeId: paid.id }).runtimeId, paid.id);
  assert.equal(choose([free, paid], { executionPolicy: 'cli-only' }).runtimeId, paid.id);
  assert.equal(choose([free, paid], { automaticExecutors: [paid.id] }).runtimeId, paid.id);
  assert.equal(
    choose([free, paid], {
      category: { id: 'general', confidence: 'high', reason: 'fixture' },
      routingRules: {
        version: 2,
        text: '',
        unparsed: [],
        updatedAt: '',
        rules: [
          {
            id: 'subscription',
            category: 'general',
            strict: true,
            enabled: true,
            source: 'manual',
            candidates: [{ runtimeId: paid.id }],
          },
        ],
      },
    }).runtimeId,
    paid.id,
  );
});
test('may-log sources require independently built text and no attachments even on a pin', () => {
  assert.equal(choose([hosted, paid], { textOnlyPrompt: undefined }).runtimeId, paid.id);
  assert.equal(
    choose([hosted, paid], { attachments: [{ id: 'a', kind: 'text', name: 'a', path: '/fixture', size: 1 } as never] })
      .runtimeId,
    paid.id,
  );
  assert.throws(() => choose([hosted], { runtimeId: hosted.id, textOnlyPrompt: undefined }));
  assert.equal(choose([hosted]).runtimeId, hosted.id);
});

test('meaningful expiring credit stays ahead of free sources in save mode', () => {
  const day = 86400000;
  const budget = apiBudgetView(
    apiBudgetPolicy(
      { limitUsd: 200, expiresAt: new Date(now + 24 * day).toISOString() },
      undefined,
      new Date(now - 10 * day).toISOString(),
    ),
    5,
    0,
    0,
    now,
  );
  const gift = {
    ...api,
    apiBudgetState: budget,
    models: [{ id: 'model/pro', label: 'Pro', efforts: ['low', 'high'], price: { input: 1, output: 2 } }],
  };
  assert.equal(choose([free, hosted, gift]).runtimeId, free.id);
  gift.apiBudgetState = apiBudgetView(
    { ...budget.policy, expiresAt: new Date(now + 10 * day).toISOString() },
    5,
    0,
    0,
    now,
  );
  assert.equal(choose([free, hosted, gift]).runtimeId, gift.id);
  assert.equal(choose([free, gift], { schedule: { preferExpiringQuota: false } }).runtimeId, free.id);
});
