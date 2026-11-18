import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classify, quotaPoolKey, route } from '../src/server/routing.ts';
import { apiBudgetPolicy, apiBudgetView } from '../src/server/api-budget.ts';
import type { RouteCapacity } from '../src/server/routing.ts';
import type { RoutingRuleSet, RunInput, RuntimeSnapshot, Settings } from '../src/shared/types.ts';

const now = Date.parse('2026-10-27T01:00:00Z');
const iso = (offset = 0) => new Date(now + offset).toISOString();
const settings: Settings = {
  refreshSeconds: 60,
  reservePercent: 10,
  maxQuotaAgeSeconds: 180,
  preferCli: true,
  designProvider: 'claude',
  architectureProvider: 'codex',
  routineProvider: 'codex',
  unknownQuotaPolicy: 'manual-only',
  defaultProjectPath: 'synthetic',
  maxConcurrentRuns: 2,
};
const runtime = (id = 'claude-fixture'): RuntimeSnapshot => ({
  id,
  provider: 'claude',
  label: id,
  environment: 'native',
  installed: true,
  status: 'ready',
  models: ['haiku', 'sonnet', 'opus'].map((id) => ({ id, label: id, efforts: ['low', 'medium', 'high'] })),
  capabilities: { execute: true, resume: true, cancel: true, approvals: true },
  quota: {
    status: 'known',
    source: 'synthetic',
    observedAt: iso(),
    windows: [{ id: 'weekly', label: 'Weekly', usedPercent: 20, resetsAt: iso(7 * 86_400_000) }],
  },
  refreshedAt: iso(),
});
const base: RunInput = { prompt: 'Evaluate the proposed project', kind: 'auto', projectPath: 'synthetic' };
const choose = (
  input: Partial<RunInput> = {},
  sources = [runtime()],
  config: Partial<Settings> = {},
  capacity?: RouteCapacity,
) => route({ ...base, ...input }, sources, { ...settings, ...config }, capacity ?? new Set(), now);

test('business and process design do not become interface work', () => {
  for (const prompt of [
    '背景：给客户实施邮件自动化，设计人工审核、异常转交和失败处理。研究是否可以训练模型，以及训练和运行需要什么设备。',
    '设计一套订单审批流程，比较人工审核与自动处理的成本。',
    'Design an approval workflow for the support team.',
    'Review the business process design and estimate training hardware.',
  ])
    assert.equal(classify(prompt).kind, 'general', prompt);
});

test('visual and interface design requests retain design routing', () => {
  for (const prompt of [
    '设计一个登录界面',
    '帮我设计公司网页',
    '改进网页设计',
    '调整配色和排版',
    'Design a dashboard for customer support',
    'Improve the landing page layout and typography',
    'Create a graphic design for the event poster',
  ])
    assert.equal(classify(prompt).kind, 'design', prompt);
});

test('main tasks use validated automatic tier advice for both the model and effort', () => {
  for (const [suggestedTier, model, effort] of [
    ['light', 'haiku', 'low'],
    ['standard', 'sonnet', 'medium'],
    ['strong', 'opus', 'high'],
  ] as const) {
    const picked = choose({ suggestedTier });
    assert.deepEqual([picked.model, picked.effort], [model, effort]);
  }
  const mapped = choose({ suggestedTier: 'strong', suggestedEffort: 'xhigh' });
  assert.deepEqual([mapped.model, mapped.effort], ['opus', 'high']);
});

// Outside quality mode Laya's advice decides the main task's tier; the local text classifier only flags
// a conflict for the assessment. Quality mode keeps the strong floor.
test('main-task advice decides an architecture-sounding task outside quality mode', () => {
  const prompt = 'Review the authentication architecture';
  for (const [suggestedTier, model, effort] of [
    ['light', 'haiku', 'low'],
    ['standard', 'sonnet', 'medium'],
  ] as const) {
    const picked = choose({ prompt, suggestedTier });
    assert.deepEqual([picked.kind, picked.model, picked.effort], ['architecture', model, effort]);
    const quality = choose({ prompt, suggestedTier }, undefined, { routeGoal: 'quality' });
    assert.deepEqual([quality.kind, quality.model, quality.effort], ['architecture', 'opus', 'high']);
  }
});

test('weak automatic effort advice cannot lower a complex main task in quality mode', () => {
  const prompt = 'Review the authentication architecture';
  for (const suggestedEffort of ['low', 'medium']) {
    const picked = choose({ prompt, suggestedTier: 'standard', suggestedEffort }, undefined, { routeGoal: 'quality' });
    assert.deepEqual([picked.model, picked.effort], ['opus', 'high']);
    assert.doesNotMatch(picked.reasons.join('\n'), /调用方建议思考强度/);
  }
  // Outside quality mode Laya's standard tier and its effort advice apply.
  const balanced = choose({ prompt, suggestedTier: 'standard', suggestedEffort: 'low' });
  assert.deepEqual([balanced.model, balanced.effort], ['sonnet', 'low']);
  const explicit = choose({ prompt, suggestedEffort: 'medium', effort: 'low' });
  assert.deepEqual([explicit.model, explicit.effort], ['opus', 'low']);
  const child = choose({ prompt, suggestedEffort: 'low', agentChild: true });
  assert.deepEqual([child.model, child.effort], ['opus', 'low']);
  assert.match(child.reasons.join('\n'), /调用方建议思考强度：low/);
});

test('explicit model and effort choices remain authoritative over main-task advice', () => {
  const hinted = { suggestedTier: 'strong', suggestedEffort: 'high' } as const;
  const pinned = choose({ ...hinted, model: 'haiku', effort: 'low' });
  assert.deepEqual([pinned.model, pinned.effort], ['haiku', 'low']);
  const effort = choose({ ...hinted, effort: 'low' });
  assert.equal(effort.effort, 'low');
  assert.throws(() => choose({ ...hinted, effort: 'ultra' }), /不支持 ultra/);
  const fixed = choose({ ...hinted, runtimeId: 'fixed' }, [runtime('other'), runtime('fixed')]);
  assert.equal(fixed.runtimeId, 'fixed');
});

test('strict executor rules retain tier advice but their model and effort pins still win', () => {
  const rules: RoutingRuleSet = {
    version: 2,
    text: '',
    updatedAt: iso(),
    unparsed: [],
    rules: [
      {
        id: 'research-fixture',
        category: 'research',
        candidates: [{ runtimeId: 'fixed' }],
        strict: true,
        enabled: true,
        source: 'manual',
      },
    ],
  };
  const input: Partial<RunInput> = {
    suggestedTier: 'strong',
    suggestedEffort: 'high',
    category: { id: 'research', confidence: 'high', reason: 'synthetic' },
    routingRules: rules,
  };
  const sources = [runtime('other'), runtime('fixed')];
  const automaticModel = choose(input, sources);
  assert.deepEqual([automaticModel.runtimeId, automaticModel.model, automaticModel.effort], ['fixed', 'opus', 'high']);
  rules.rules[0]!.candidates[0] = { runtimeId: 'fixed', model: 'sonnet', effort: 'low' };
  const fixedModel = choose(input, sources);
  assert.deepEqual([fixedModel.runtimeId, fixedModel.model, fixedModel.effort], ['fixed', 'sonnet', 'low']);
});

test('strong advice sets a minimum even for the save goal', () => {
  const saving = choose({ suggestedTier: 'strong' }, undefined, { routeGoal: 'save' });
  assert.deepEqual([saving.model, saving.effort], ['opus', 'high']);
  const quality = choose({ suggestedTier: 'light' }, undefined, { routeGoal: 'quality' });
  assert.equal(quality.model, 'opus');
});

test('strong advice keeps capability filters and the complex-task minimum', () => {
  const source = runtime();
  source.models.find((model) => model.id === 'opus')!.noAutoApproval = true;
  assert.equal(choose({ suggestedTier: 'strong' }, [source]).model, 'sonnet');
  source.models = source.models.filter((model) => model.id === 'haiku');
  assert.throws(() => choose({ suggestedTier: 'strong' }, [source]), /仅有轻量模型/);
});

test('strong advice retains selected-family quota checks and account reserve protection', () => {
  const source = runtime();
  source.quota.windows.push({
    id: 'opus-weekly',
    label: 'Opus weekly',
    modelFamily: 'opus',
    usedPercent: 95,
    resetsAt: iso(7 * 86_400_000),
  });
  assert.equal(choose({ suggestedTier: 'strong' }, [source]).model, 'sonnet');
  assert.throws(() => choose({ suggestedTier: 'strong', model: 'opus' }, [source]), /保护阈值/);
  source.quota.windows[0]!.usedPercent = 93;
  assert.throws(() => choose({ suggestedTier: 'strong' }, [source]), /保护阈值/);
  source.quota.windows[0]!.usedPercent = 20;
  source.quota.observedAt = iso(-180_000);
  assert.throws(() => choose({ suggestedTier: 'strong' }, [source]), /额度数据已过期/);
});

test('strong advice does not bypass API budgets or account concurrency', () => {
  const source = runtime();
  const capacity: RouteCapacity = {
    reservations: new Map([[quotaPoolKey(source), 1]]),
    settlingPools: new Set(),
    maxRunsPerPool: 1,
  };
  assert.throws(() => choose({ suggestedTier: 'strong' }, [source], {}, capacity), /并发容量已满/);
  source.apiBudgetState = apiBudgetView(apiBudgetPolicy({ limitUsd: 1, perRunUsd: 1 }), 1, 0, 0, now);
  assert.throws(() => choose({ suggestedTier: 'strong' }, [source]), /API 本地预算不足/);
});

test('quality strong advice only raises effort and never drops xhigh to high', () => {
  const source = runtime();
  source.models.forEach((model) => model.efforts.push('xhigh'));
  for (const advice of [
    { suggestedTier: 'strong' as const },
    { suggestedTier: 'strong' as const, suggestedEffort: 'high' },
    { prompt: 'Implement across multiple modules' },
  ]) {
    const picked = choose(advice, [source], { routeGoal: 'quality' });
    assert.deepEqual([picked.model, picked.effort], ['opus', 'xhigh']);
  }
});

test('ordinary complexity words, negations, versions and abbreviations do not create task floors', () => {
  for (const prompt of [
    '这个不复杂',
    'This is not complex.',
    'Explain a complex number.',
    'Compare 3.11 3.12 3.13 22.1 24.0.',
    'Rename the variable, e.g. count to total.',
    'Rename the variable, i.e. change its name.',
  ]) {
    const picked = choose({ prompt, kind: 'routine' });
    assert.deepEqual([picked.model, picked.effort], ['haiku', 'low'], prompt);
  }
  for (const prompt of ['这个不复杂', 'This is not complex.']) {
    const picked = choose({ prompt, kind: 'routine', agentChild: true, readOnlyMember: true });
    assert.deepEqual([picked.model, picked.effort], ['haiku', 'low'], prompt);
  }
});

test('real file paths and cross-module work retain the difficulty floor', () => {
  for (const prompt of [
    'Rename in src/a.ts src/b.ts src/c.ts src/d.ts src/e.ts',
    'Rename in src\\a.ts src\\b.ts src\\c.ts src\\d.ts src\\e.ts',
    'Rename in a.ts b.ts c.md d.py e.c',
    'Implement across multiple modules',
    'Implement multiple files',
    '实现跨模块改动',
  ]) {
    const picked = choose({ prompt, kind: 'routine' });
    assert.deepEqual([picked.model, picked.effort], ['opus', 'high'], prompt);
  }
  assert.deepEqual(
    [
      choose({ prompt: 'Rename in src/a.ts src/b.ts', kind: 'routine' }).model,
      choose({ prompt: 'Rename in src/a.ts src/b.ts', kind: 'routine' }).effort,
    ],
    ['sonnet', 'medium'],
  );
});

test('a route records the tier it aimed at, even when that tier is unavailable', () => {
  assert.equal(choose({ suggestedTier: 'light' }).targetTier, 'light');
  const strongOnly = runtime();
  strongOnly.models = [{ id: 'opus', label: 'opus', efforts: ['low', 'medium', 'high'] }];
  const picked = choose({ suggestedTier: 'light' }, [strongOnly]);
  assert.deepEqual([picked.model, picked.targetTier], ['opus', 'light']);
});
