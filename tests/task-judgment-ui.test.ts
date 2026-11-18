import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AppState } from '../src/shared/types.ts';
import type { TaskJudgment } from '../src/shared/task-judgment.ts';
import { SettingsPage } from '../src/ui/App.tsx';
import { TaskJudgmentCard } from '../src/ui/TaskJudgment.tsx';

const judgment: TaskJudgment = {
  contractVersion: 'comborunner-task-judgment-v1',
  inputHash: 'fixture-hash',
  source: 'jev',
  status: 'accepted',
  intent: 'action',
  kind: 'architecture',
  complexity: 'complex',
  confidence: {
    intent: {
      value: 0.87,
      support: 0.94,
      margin: 0.9,
      probabilities: { action: 0.94, question: 0.04, uncertain: 0.02 },
    },
    kind: null,
    complexity: null,
  },
  observedAt: '2026-09-27T12:00:00Z',
  latencyMs: 243,
  reason: 'accepted',
  usage: { inputTokens: 52, outputTokens: 0, totalTokens: 52, costUsd: null },
  requestAttempted: true,
};
const state: AppState = {
  app: { name: 'PugPort', version: 'test', platform: 'win32', dataDir: 'fixture' },
  targets: [],
  runtimes: [],
  runs: [],
  approvals: [],
  plugins: [],
  refreshing: false,
  settings: {
    refreshSeconds: 60,
    reservePercent: 10,
    maxQuotaAgeSeconds: 120,
    preferCli: true,
    designProvider: 'claude',
    architectureProvider: 'codex',
    routineProvider: 'codex',
    unknownQuotaPolicy: 'manual-only',
    defaultProjectPath: 'C:/Fixture',
    maxConcurrentRuns: 1,
  },
};
const actions = { api: async <T>() => ({}) as T, notify() {}, reload: async () => {} };

test('settings expose no retired cloud classification controls, including saved legacy settings', () => {
  const legacy = {
    ...state,
    settings: { ...state.settings, taskJudgment: 'jev', memoryEvidence: 'jev', decisionMode: 'auto' },
    jev: { configured: true, enabled: true, status: 'configured-unverified', note: '' },
  } as unknown as AppState;
  for (const saved of [state, legacy]) {
    const routing = renderToStaticMarkup(
      createElement(SettingsPage, { category: 'routing', ...actions, state: saved }),
    );
    assert.match(routing, /<h2>自动路由<\/h2>/);
    const advanced = renderToStaticMarkup(
      createElement(SettingsPage, { category: 'advanced', ...actions, state: saved }),
    );
    assert.match(advanced, /启用固定路由偏好/);
    for (const html of [routing, advanced])
      assert.doesNotMatch(
        html,
        /TypeSafe|判断服务|settings-judgment|aria-label="任务判断方式"|aria-label="历史证据筛选"/,
      );
  }
});

test('historical cloud classification and fallback cards stay hidden', () => {
  assert.equal(renderToStaticMarkup(createElement(TaskJudgmentCard, {})), '');
  for (const record of [
    judgment,
    { ...judgment, source: 'local' as const, status: 'fallback' as const, reason: 'timeout' as const },
    { ...judgment, reason: 'manual-selection' as const },
    { ...judgment, reason: 'in-progress' as const },
    { ...judgment, reason: 'cancelled' as const },
  ])
    assert.equal(renderToStaticMarkup(createElement(TaskJudgmentCard, { judgment: record })), '');
});

test('ordinary local classification stays absent', () => {
  for (const reason of [
    'disabled',
    'not-configured',
    'confirmation-mode',
    'bounded-lookup',
    'self-contained-chat',
  ] as const)
    assert.equal(
      renderToStaticMarkup(
        createElement(TaskJudgmentCard, {
          judgment: { ...judgment, source: 'local', status: 'skipped', reason, requestAttempted: false },
        }),
      ),
      '',
      reason,
    );
});

test('manual execution retains the fixed choice and its permission and context explanation', () => {
  const html = renderToStaticMarkup(
    createElement(TaskJudgmentCard, {
      judgment: {
        ...judgment,
        source: 'local',
        status: 'skipped',
        reason: 'manual-selection',
        requestAttempted: false,
        confidence: { intent: null, kind: null, complexity: null },
        usage: { inputTokens: null, outputTokens: null, totalTokens: null, costUsd: null },
      },
    }),
  );
  assert.match(html, /执行选择记录/);
  assert.match(html, /手动选择 · 直接执行/);
  assert.match(html, /仍检查额度与文件权限/);
  assert.match(html, /携带当前对话上下文/);
  assert.doesNotMatch(html, /Jev|Laya|任务判断 ·|置信分数|复杂度|Tokens|使用本地回退/);
});
