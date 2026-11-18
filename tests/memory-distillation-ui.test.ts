import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryTabs, MemoryAutoPanel, MemoryDistillationSwitch } from '../src/ui/MemoryAuto.tsx';
import type { MemoryAutoView, Settings } from '../src/shared/types.ts';

test('automatic memory switch defaults off and explains the account restrictions', () => {
  for (const enabled of [undefined, false, true]) {
    const html = renderToStaticMarkup(
      createElement(MemoryDistillationSwitch, {
        settings: { memoryDistillation: enabled === undefined ? undefined : { enabled } } as Settings,
        disabled: false,
        onChange() {},
      }),
    );
    assert.equal(html.includes('checked=""'), enabled === true);
    assert.match(html, /自动整理项目记忆/);
    assert.match(html, /默认不用 Claude 和付费 API/);
  }
});

test('both memory tabs are localized and maintain independent selection', () => {
  for (const value of ['owner', 'auto'] as const) {
    const html = renderToStaticMarkup(createElement(MemoryTabs, { value, disabled: false, onChange() {} }));
    assert.match(html, /我写的/);
    assert.match(html, /自动整理/);
    assert.equal((html.match(/aria-selected="true"/g) ?? []).length, 1);
  }
});

test('automatic pane is read-only, localized, shows provenance, and disables regeneration with its reason', () => {
  const view: MemoryAutoView = {
    eligible: false,
    reason: '新进展不足。',
    sourceLabel: 'Grok',
    note: {
      projectId: 'p',
      content: 'facts:\n事实内容\ndecisions:\n决定内容\npitfalls:\n风险内容',
      updatedAt: '2026-10-12T12:00:00Z',
      sourceRuntimeId: 'grok',
      runId: 'r',
    },
  };
  const render = (eligible: boolean, busy = false) =>
    renderToStaticMarkup(
      createElement(MemoryAutoPanel, {
        view: { ...view, eligible },
        busy,
        onRun() {},
        onClear() {},
      }),
    );
  const html = render(false);
  assert.doesNotMatch(html, /textarea|contenteditable|facts:|decisions:|pitfalls:/);
  assert.match(html, /事实：/);
  assert.match(html, /Grok/);
  assert.match(html, /整理时间/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>重新整理/);
  assert.match(html, /title="新进展不足。"/);
  assert.doesNotMatch(render(true), /<button[^>]*disabled=""[^>]*>重新整理/);
  assert.match(render(true, true), /<button[^>]*disabled=""[^>]*>重新整理/);
});
