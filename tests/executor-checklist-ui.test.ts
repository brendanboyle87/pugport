import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ExecutorChecklist } from '../src/ui/ExecutorChecklist.tsx';
import { emptyExecutorReason } from '../src/shared/automatic-executors.ts';
import type { AppState, Conversation } from '../src/shared/types.ts';
import { findNode, nextTurn, uiBundle, uiHarness } from './helpers/ui-harness.ts';

const state = {
  targets: [
    { id: 'codex', provider: 'codex', label: 'Codex', enabled: true, environment: 'native' },
    { id: 'claude', provider: 'claude', label: 'Claude', enabled: true, environment: 'native' },
    { id: 'off', provider: 'claude', label: 'Disabled', enabled: false, environment: 'native' },
    { id: 'api', provider: 'pi', label: 'API card', gateway: 'api', enabled: true, environment: 'native' },
  ],
  runtimes: [{ id: 'claude', subscription: { label: 'Max' } }],
  settings: {
    excludedExecutors: ['claude', 'api'],
    designProvider: 'claude',
    architectureProvider: 'codex',
    routineProvider: 'codex',
  },
} as unknown as AppState;

test('executor checklist: table renders enabled cards, provider marks, plans and default checks', () => {
  const html = renderToStaticMarkup(createElement(ExecutorChecklist, { state, onChange() {} }));
  assert.match(html, /<table aria-label="自动执行器列表"/);
  assert.match(html, /provider-claude/);
  assert.match(html, />Max</);
  assert.match(html, /aria-label="自动选择 Claude"[^>]*checked/);
  assert.match(html, /API card/);
  assert.match(html, /aria-label="[^"]*API card"[^>]*disabled/);
  assert.doesNotMatch(html, /aria-label="[^"]*API card"[^>]*checked/);
  assert.doesNotMatch(html, /Disabled/);
  assert.match(html, /全选/);
  assert.match(html, /全不选/);
});

test('executor checklist: uncheck, select-all and select-none guard use the actual UI callbacks', async () => {
  const harness = uiHarness(await uiBundle('src/ui/ExecutorChecklist.tsx'));
  let value: string[] | undefined;
  const props = () => ({
    state,
    value,
    onChange: (next: string[]) => {
      value = Array.from(next);
    },
  });
  let tree = harness.render('ExecutorChecklist', props());
  findNode(tree, (node) => node.props['aria-label'] === '自动选择 Claude')!.props.onChange({
    target: { checked: false },
  });
  assert.deepEqual(value, ['codex']);
  tree = harness.render('ExecutorChecklist', props());
  findNode(tree, (node) => node.type === 'button' && node.props.children === '全不选')!.props.onClick();
  tree = harness.render('ExecutorChecklist', props());
  assert.equal(findNode(tree, (node) => node.props.role === 'alert')!.props.children, emptyExecutorReason);
  assert.deepEqual(value, ['codex']);
  findNode(tree, (node) => node.type === 'button' && node.props.children === '全选')!.props.onClick();
  assert.deepEqual(value, ['codex', 'claude']);
});

test('executor checklist: global settings save the edited IDs', async () => {
  const harness = uiHarness(await uiBundle('src/ui/App.tsx', true));
  const writes: Array<{ path: string; body: any; method: string }> = [];
  const props = {
    state: { ...state, app: { platform: 'darwin' } },
    api: async (path: string, body: any, method: string) => {
      writes.push({ path, body, method });
      return {};
    },
    reload: async () => {},
    notify() {},
  };
  let tree = harness.render('SettingsPage', { ...props, category: 'routing' });
  findNode(tree, (node) => node.type?.name === 'ExecutorChecklist')!.props.onChange(['claude']);
  tree = harness.render('SettingsPage', { ...props, category: 'routing' });
  await nextTurn();
  const saved = writes.find((write) => write.path === '/api/settings')!;
  assert.equal(saved.method, 'PATCH');
  assert.deepEqual(Array.from(saved.body.excludedExecutors), ['api', 'codex']);
});

test('executor checklist: conversation inherits global, saves override and restores inheritance', async () => {
  const harness = uiHarness(await uiBundle('src/ui/ConversationPanel.tsx'));
  const writes: any[] = [];
  const conversation = { id: 'conversation' } as Conversation;
  const props = {
    state,
    conversation,
    api: async (path: string, body: any, method: string) => {
      writes.push({ path, body, method });
      return {};
    },
    notify() {},
  };
  let tree = harness.render('RoutingTab', props);
  let checklist = findNode(tree, (node) => node.type?.name === 'ExecutorChecklist')!;
  assert.equal(checklist, undefined);
  assert.ok(findNode(tree, (node) => node.props.children === '跟随全局 · 3 个里 1 个可自动选择'));
  const globalCheckbox = () =>
    findNode(
      tree,
      (node) => node.type === 'input' && node.props.type === 'checkbox' && node.props.checked !== undefined,
    )!;
  globalCheckbox().props.onChange({ target: { checked: false } });
  tree = harness.render('RoutingTab', props);
  checklist = findNode(tree, (node) => node.type?.name === 'ExecutorChecklist')!;
  assert.equal(checklist.props.disabled, false);
  checklist.props.onChange(['claude']);
  tree = harness.render('RoutingTab', props);
  const editor = findNode(tree, (node) => node.type?.name === 'RoutingRulesEditor')!;
  editor.props.onParsed({
    version: 2,
    text: '代码用 claude',
    rules: [],
    unparsed: [],
    chapterAgents: false,
    mask: false,
  });
  tree = harness.render('RoutingTab', props);
  assert.deepEqual(
    Array.from(findNode(tree, (node) => node.type?.name === 'RoutingRulesEditor')!.props.value.automaticExecutors),
    ['claude'],
  );
  const save = () =>
    findNode(tree, (node) => node.type?.name === 'RoutingRulesEditor')!.props.onSave(
      findNode(tree, (node) => node.type?.name === 'RoutingRulesEditor')!.props.value,
    );
  save();
  await nextTurn();
  assert.equal(writes[0].method, 'PATCH');
  assert.equal(writes[0].path, '/api/conversations/conversation/routing');
  assert.deepEqual(Array.from(writes[0].body.routing.automaticExecutors), ['claude']);
  tree = harness.render('RoutingTab', props);
  globalCheckbox().props.onChange({ target: { checked: true } });
  tree = harness.render('RoutingTab', props);
  assert.equal(
    findNode(tree, (node) => node.type?.name === 'ExecutorChecklist'),
    undefined,
  );
  save();
  await nextTurn();
  assert.equal(writes[1].body.routing.automaticExecutors, undefined);
});

test('executor checklist resolves Cursor plan from the quota reading, including retained readings', () => {
  const cursor = { id: 'cursor', provider: 'cursor', label: 'Cursor', enabled: true, environment: 'native' };
  for (const retained of [false, true]) {
    const quota = { status: 'known', windows: [], subscription: { label: 'Pro' } };
    const value = {
      ...state,
      targets: [cursor],
      runtimes: [
        {
          ...cursor,
          quota: retained ? { status: 'error', windows: [] } : quota,
          lastKnownQuota: retained ? quota : undefined,
        },
      ],
    } as unknown as AppState;
    const html = renderToStaticMarkup(createElement(ExecutorChecklist, { state: value, onChange() {} }));
    assert.match(html, /class="tag">Pro</);
    assert.doesNotMatch(html, /未知套餐/);
  }
});

test('executor checklist explains automatic use only for behind-pace paid credit', () => {
  const now = Date.now();
  const day = 86400000;
  for (const spentUsd of [0, 150]) {
    const view = {
      ...state,
      runtimes: [
        {
          ...state.targets[3]!,
          apiBudgetState: {
            policy: {
              limitUsd: 200,
              startedAt: new Date(now - 10 * day).toISOString(),
              expiresAt: new Date(now + 9 * day).toISOString(),
              preferExpiring: true,
              perRunUsd: 1,
              maxConcurrentRuns: 1,
              burstConcurrentRuns: 4,
            },
            spentUsd,
            reservedUsd: 0,
            remainingUsd: 200 - spentUsd,
            unreportedRuns: 0,
            phase: 'normal',
            maxConcurrentRuns: 1,
          },
        },
      ],
    } as unknown as AppState;
    const html = renderToStaticMarkup(createElement(ExecutorChecklist, { state: view, onChange() {} }));
    assert.equal(html.includes('到期额度按计划自动使用'), spentUsd === 0);
    assert.equal(html.includes('按次计费，钉选后可用'), spentUsd !== 0);
  }
});
