import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConversationPanel, type PanelTab } from '../src/ui/ConversationPanel.tsx';
import type { AppState, Conversation, RuntimeTarget } from '../src/shared/types.ts';
import { maxActiveChildAgents } from '../src/shared/conversation-routing.ts';

const target = (id: string, provider: RuntimeTarget['provider'], label: string, enabled = true): RuntimeTarget => ({
  id,
  provider,
  label,
  command: 'unused',
  environment: 'native',
  enabled,
});
const state = {
  targets: [
    target('grok-native', 'grok', 'Grok · 本机'),
    target('grok-b', 'grok', 'Grok B'),
    target('claude-native', 'claude', 'Claude · 本机'),
    target('old', 'codex', 'Codex Old', false),
  ],
  runtimes: [
    {
      id: 'grok-b',
      installed: true,
      status: 'ready',
      models: [
        { id: 'grok-4.7', label: 'grok-4.7', efforts: ['low', 'medium', 'high', 'xhigh'] },
        { id: 'grok-4.6', label: 'grok-4.6', efforts: ['low', 'high'] },
      ],
    },
  ],
} as unknown as AppState;
const conversation: Conversation = {
  id: 'c1',
  projectId: 'p1',
  title: '小说',
  createdAt: '2026-10-04T00:00:00Z',
  updatedAt: '2026-10-04T00:00:00Z',
  routing: {
    text: '成人内容必须交给 Grok B',
    rules: [
      {
        topic: 'adult',
        target: { runtimeId: 'grok-b', provider: 'grok' },
        strict: true,
        model: 'grok-4.7',
        effort: 'xhigh',
      },
    ],
    chapterAgents: true,
    mask: false,
    updatedAt: '2026-10-04T00:00:00Z',
  },
};
const render = (tab: PanelTab, value = conversation, memory?: string) =>
  renderToStaticMarkup(
    createElement(ConversationPanel, {
      tab,
      onTab() {},
      onClose() {},
      conversation: value,
      state,
      api: (async () => ({})) as never,
      notify() {},
      ...(memory ? { memory: createElement('p', null, memory) } : {}),
    }),
  );

test('memory tab is available to general chats and incognito cannot enable memory or open the project editor', () => {
  assert.match(render('memory'), /对话记忆/);
  assert.match(render('memory'), /重新开启后，整条对话都会重新计入记忆/);
  const html = render('memory', { ...conversation, incognito: true, memory: 'off' }, 'PRIVATE_PROJECT_EDITOR');
  assert.match(html, /type="checkbox" disabled=""/);
  assert.doesNotMatch(html, /PRIVATE_PROJECT_EDITOR|checked=""/);
});

test('the routing tab shows saved rules, chapter and mask controls without unrelated policy text', () => {
  const html = render('routing');
  assert.equal((html.match(/aria-label="自动执行器列表"/g) ?? []).length, 0);
  assert.match(html, /跟随全局 · 3 个里 3 个可自动选择/);
  assert.equal((html.match(/aria-label="路由规则原话"/g) ?? []).length, 1);
  assert.match(html, /<section aria-label="内容规则">/);
  assert.match(html, /<details class="routing-options"><summary>写作分工<\/summary>/);
  assert.match(html, /role="tab" aria-selected="true"[^>]*>.*?路由规则/);
  assert.match(html, /成人内容必须交给 Grok B<\/textarea>/);
  assert.match(html, /<option value="r:grok-b" selected="">Grok B<\/option>/);
  assert.doesNotMatch(html, /Codex Old/, 'disabled cards are not offered');
  // The rule's executor offers its models; the chosen model offers its efforts.
  assert.match(
    html,
    /aria-label="成人内容候选 1的模型"><option value="">默认模型<\/option><option value="grok-4.7" selected="">grok-4.7<\/option><option value="grok-4.6">/,
  );
  assert.match(html, /aria-label="成人内容候选 1的强度"[^>]*>.*?<option value="xhigh" selected="">很高<\/option>/);
  assert.doesNotMatch(html, /拆分与理解的模型/, 'rules that are not set show no model choice');
  assert.match(html, /每一章交给一个独立的子智能体/);
  assert.match(html, new RegExp(`同时最多 ${maxActiveChildAgents} 个，其余排队`));
  assert.doesNotMatch(html, /涉及未成年人的性内容在任何规则下都会被拒绝/);
  assert.match(html, /清除规则/);
  assert.match(html, /已启用 · 更新于/);
});

test('without rules the tab explains the default, and memory shows the project editor it is given', () => {
  const { routing: _routing, ...plain } = conversation;
  const html = render('routing', plain);
  assert.match(html, /aria-label="路由流程"/);
  assert.equal((html.match(/class="routing-stage"/g) ?? []).length, 3);
  assert.match(html, /aria-label="自动执行子任务"[^>]*checked=""/);
  assert.match(html, /未指定的分类自动选择。/);
  assert.match(html, /完成后核验/);
  assert.doesNotMatch(html, /aria-label="自动执行器列表"/);
  assert.match(html, /重新解析/);
  assert.doesNotMatch(html, /清除规则/);
  assert.match(render('memory', plain, 'project memory editor'), /<p>project memory editor<\/p>/);
  assert.match(render('memory', plain), /不在项目里/);
  assert.match(render('skills', plain), /读取 Skills/);
});
