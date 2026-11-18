import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AppState } from '../src/shared/types.ts';
import type { MemoryEvidenceReport } from '../src/shared/memory-evidence.ts';
import { SettingsPage } from '../src/ui/App.tsx';
import { MemoryEvidenceCard } from '../src/ui/MemoryEvidence.tsx';

const state: AppState = {
  app: { name: 'PugPort', version: 'fixture', platform: 'win32', dataDir: 'fixture' },
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
const report: MemoryEvidenceReport = {
  source: 'local',
  status: 'local',
  reason: 'Local evidence labels preserve context without making factual claims.',
  assessedAt: '2026-10-08T12:00:00Z',
  elapsedMs: 20,
  requestCount: 0,
  cachedCount: 2,
  usage: { inputTokens: 44, outputTokens: null, totalTokens: null },
  decisions: [
    {
      messageId: 'same-chat',
      sourceOffset: 0,
      status: 'supported',
      reason: 'private-text',
      scores: { relevant: 0.91, answers: 0.72, contradicts: 0.1, injection: 0.01 },
    },
    { messageId: 'other-chat', sourceOffset: 5, status: 'conflicting', reason: 'private-text' },
    { messageId: 'current-check', sourceOffset: 3, status: 'needs-current-check', reason: 'private-text' },
  ],
};

test('history filtering has no cloud selector or key controls, even with saved legacy settings', () => {
  const html = renderToStaticMarkup(
    createElement(SettingsPage, {
      category: 'advanced',
      ...actions,
      state: {
        ...state,
        settings: { ...state.settings, taskJudgment: 'jev', memoryEvidence: 'jev' },
        jev: { configured: true, enabled: true, status: 'configured-unverified', note: '' },
      } as unknown as AppState,
    }),
  );
  assert.doesNotMatch(
    html,
    /TypeSafe|aria-label="历史证据筛选"|aria-label="任务判断方式"|settings-judgment|type="password"/,
  );
});

test('evidence details summarize decisions and expose source provenance without raw model text', () => {
  const html = renderToStaticMarkup(
    createElement(MemoryEvidenceCard, {
      report,
      sourceMessageIds: new Set(['same-chat']),
      onJumpMessage() {},
    }),
  );
  assert.match(html, /本地筛选 · 支持 1 · 部分支持 0 · 冲突 1 · 需当前核实 1/);
  assert.match(html, /请求 0 次 · 缓存 2 条/);
  assert.match(html, /<code>other-chat<\/code>/);
  assert.doesNotMatch(html, /0\.91|private-text|probabilities/);
  assert.doesNotMatch(html, /Jev|Laya|云端/);
  assert.equal(renderToStaticMarkup(createElement(MemoryEvidenceCard, {})), '');
});

test('historical cloud evidence, fallback and empty reports stay hidden', () => {
  for (const hidden of [
    { ...report, source: 'jev' as const, status: 'accepted' as const },
    { ...report, status: 'fallback' as const, reason: 'Jev deadline exceeded; local context retained.' },
    { ...report, status: 'empty' as const, decisions: [] },
  ])
    assert.equal(renderToStaticMarkup(createElement(MemoryEvidenceCard, { report: hidden })), '');
});

test('source links jump only to messages available in the current chat', () => {
  const jumped: string[] = [];
  const tree = MemoryEvidenceCard({
    report,
    sourceMessageIds: new Set(['same-chat']),
    onJumpMessage: (id) => jumped.push(id),
  });
  const buttons: ReactElement<{ onClick: () => void; children?: ReactNode }>[] = [];
  function visit(node: ReactNode) {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!isValidElement<{ children?: ReactNode }>(node)) return;
    if (node.type === 'button') buttons.push(node as ReactElement<{ onClick: () => void; children?: ReactNode }>);
    visit(node.props.children);
  }
  visit(tree);
  assert.equal(buttons.length, 1);
  buttons[0]!.props.onClick();
  assert.deepEqual(jumped, ['same-chat']);
});
