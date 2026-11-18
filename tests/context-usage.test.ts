import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ContextUsage, conversationContextRun } from '../src/ui/ContextUsage.tsx';
import type { RunRecord, Workflow } from '../src/shared/types.ts';
import { createTranslator } from '../src/shared/i18n/index.ts';
import english from '../src/shared/i18n/en.json' with { type: 'json' };
import { nextTurn, uiBundle, uiHarness } from './helpers/ui-harness.ts';

const at = '2026-10-14T00:00:00Z';
const render = (tokens: number, window?: number) =>
  renderToStaticMarkup(createElement(ContextUsage, { context: { tokens, window, at }, executor: 'Codex' }));

test('context hides missing or low usage and shows unknown windows only from 50k tokens', () => {
  assert.equal(renderToStaticMarkup(createElement(ContextUsage, { executor: 'Codex' })), '');
  assert.equal(render(0), '');
  assert.equal(render(49999), '');
  assert.match(render(50000), /50k tokens/);
  assert.doesNotMatch(render(50000), /<svg/);
  assert.doesNotMatch(render(126000), /<svg/);
  assert.match(render(126000), /126k tokens/);
  assert.equal(render(0, 200000), '');
  assert.equal(render(80000, 200000), '');
});

test('ring colours use unrounded 70% and 90% thresholds and clamp the drawing at full', () => {
  for (const [tokens, tone] of [
    [140000, 'warning'],
    [150000, 'warning'],
    [179999, 'warning'],
    [180000, 'danger'],
    [190000, 'danger'],
    [240000, 'danger'],
  ] as const)
    assert.match(render(tokens, 200000), new RegExp(`context-usage ${tone}`));
  assert.equal(render(139999, 200000), '');
  assert.match(render(150000, 200000), /上下文 约 75% · 150k \/ 200k tokens · 来自 Codex/);
  assert.match(render(240000, 200000), /stroke-dasharray="100 100"/);
});

test('million-token windows and occupancy use M in tooltips and plain text', () => {
  assert.match(render(750000, 1000000), /750k \/ 1M tokens/);
  assert.match(render(1000000), /1M tokens/);
  assert.doesNotMatch(render(750000, 1000000), /1000k/);
});

test('conversation context prefers main tasks and falls back only when no main task exists', () => {
  const main = { conversationId: 'own', runIds: ['main'] } as Workflow;
  const children = [
    { conversationId: 'own', runIds: ['delegated'], delegation: {} },
    { conversationId: 'own', runIds: ['child'], parentWorkflowId: 'main-workflow' },
  ] as Workflow[];
  const runs = ['main', 'delegated', 'child'].map((id, index) => ({
    id,
    startedAt: `${at}${index}`,
    context: { tokens: index + 1, at },
  })) as RunRecord[];
  assert.equal(conversationContextRun('own', [main, ...children], runs)?.id, 'main');
  assert.equal(conversationContextRun('own', children, runs)?.id, 'child');
  assert.equal(conversationContextRun('own', [main, ...children], runs.slice(1)), undefined);
});

test('conversation picks the latest run with context, ignoring other and deleted conversations', () => {
  const workflows = [
    { conversationId: 'own', runIds: ['old', 'latest', 'empty'] },
    { conversationId: 'other', runIds: ['foreign'] },
    { conversationId: 'own', runIds: ['deleted'], deletedAt: at },
  ] as Workflow[];
  const runs = ['latest', 'old', 'empty', 'foreign', 'deleted'].map((id, i) => ({
    id,
    startedAt: id === 'old' ? '2026-10-13' : `${at}${i}`,
    ...(id === 'empty' ? {} : { context: { tokens: i, at } }),
  })) as RunRecord[];
  assert.equal(conversationContextRun('own', workflows, runs)?.id, 'latest');
  assert.equal(conversationContextRun(undefined, workflows, runs), undefined);
  assert.equal(conversationContextRun('missing', workflows, runs), undefined);
  assert.equal(conversationContextRun('own', workflows, []), undefined);
});

test('context tooltips translate with dynamic token counts and executor names', () => {
  const translate = createTranslator(english);
  assert.equal(
    translate('上下文 约 63% · 126k / 200k tokens · 来自 Codex'),
    'Context ~63% · 126k / 200k tokens · from Codex',
  );
  assert.equal(translate('上下文 126k tokens · 来自 Cursor'), 'Context 126k tokens · from Cursor');
});

test('UI stores context from run events, preserves it on other events, and ignores replayed updates', async () => {
  const listeners = new Map<string, (message: { data: string }) => void>();
  const harness = uiHarness(await uiBundle('src/ui/App.tsx'), {
    fetch: async (url: string) => ({
      ok: true,
      json: async () =>
        url === '/api/session'
          ? { token: 'synthetic-session' }
          : {
              runs: [
                { id: 'own', events: [], output: '' },
                { id: 'other', events: [], output: '' },
              ],
            },
    }),
    EventSource: class {
      addEventListener(name: string, listener: (message: { data: string }) => void) {
        listeners.set(name, listener);
      }
      close() {}
    },
  });
  try {
    harness.render('useBackend');
    await nextTurn();
    const update = listeners.get('run');
    assert.ok(update);
    const context = { tokens: 126000, window: 200000, at };
    update({ data: JSON.stringify({ runId: 'own', event: { type: 'usage', at, seq: 1 }, context }) });
    const read = () => (harness.render('useBackend') as unknown as { state: { runs: RunRecord[] } }).state.runs;
    assert.equal(JSON.stringify(read()[0].context), JSON.stringify(context));
    assert.equal(read()[1].context, undefined);
    update({ data: JSON.stringify({ runId: 'own', event: { type: 'status', at, seq: 2 } }) });
    update({
      data: JSON.stringify({ runId: 'own', event: { type: 'usage', at, seq: 1 }, context: { ...context, tokens: 1 } }),
    });
    assert.equal(read()[0].context?.tokens, 126000);
  } finally {
    harness.unmount();
  }
});
