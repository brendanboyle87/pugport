import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { captureReplyIdentity, namedIdentity, replyIdentity } from '../src/shared/reply-identity.ts';
import type { AppState, ConversationMessage, RunRecord, Workflow } from '../src/shared/types.ts';
import { ReplyIdentity } from '../src/ui/ReplyIdentity.tsx';
import { ConversationHistory } from '../src/ui/Workspace.tsx';
import { SettingsPage } from '../src/ui/App.tsx';
import { findNode, uiBundle, uiHarness } from './helpers/ui-harness.ts';

const workflow = {
  id: 'parent',
  conversationId: 'chat',
  ownSelection: {},
  input: { runtimeId: 'routed-account' },
  runIds: ['author', 'planner'],
  finalMessageId: 'reply',
  status: 'completed',
  plan: [],
} as unknown as Workflow;
const run = {
  id: 'author',
  workflowId: 'parent',
  stepId: 'reply',
  status: 'completed',
  route: { runtimeId: 'cursor-work', model: 'requested-model', effort: 'high' },
  effectiveModel: { model: 'actual-model', effort: 'medium', source: 'fixture' },
  account: { id: 'cursor-work', label: 'Cursor Work', provider: 'cursor' },
  output: 'Saved answer',
  endedAt: '2026-10-05T12:00:00.000Z',
} as RunRecord;
const message: ConversationMessage = {
  id: 'reply',
  conversationId: 'chat',
  role: 'assistant',
  content: 'Saved answer',
  workflowId: 'parent',
  createdAt: '2026-10-05T12:00:01.000Z',
};

test('reply provenance keeps runtime-confirmed settings and account independently of future routing', () => {
  const identity = captureReplyIdentity(workflow, [run]);
  assert.equal(identity.automatic, true, 'the user picked auto, even though project rules then selected an account');
  assert.equal(identity.runs[0]?.model, 'actual-model');
  assert.equal(identity.runs[0]?.effort, 'medium');
  assert.equal(identity.runs[0]?.accountLabel, 'Cursor Work');
  assert.equal(identity.runs[0]?.confirmed, true);
  const changed = { ...workflow, ownSelection: { runtimeId: 'another-account' } };
  assert.equal(replyIdentity({ ...message, replyIdentity: identity }, changed, []), identity);
  assert.equal(captureReplyIdentity(changed, [run]).automatic, false);
  assert.equal(captureReplyIdentity({ ...workflow, ownSelection: { provider: 'claude' } }, [run]).automatic, false);
  assert.equal(
    captureReplyIdentity({ ...changed, replyRouting: 'auto' }, [run]).automatic,
    true,
    'continuing an automatic task may internally pin its original native session',
  );
});

test('old replies never acquire a child agent, planner, later retry, or ambiguous author', () => {
  assert.equal(replyIdentity(message, workflow, [run])?.runs[0]?.runId, 'author');
  assert.deepEqual(replyIdentity(message, { ...workflow, plan: [{}, {}] as Workflow['plan'] }, [run])?.runs, []);
  for (const invalid of [
    { ...run, workflowId: 'child' },
    { ...run, stepId: undefined },
    { ...run, endedAt: '2026-10-06T12:00:00.000Z' },
    { ...run, output: 'Different answer' },
    { ...run, status: 'failed' as const },
  ])
    assert.deepEqual(replyIdentity(message, workflow, [invalid])?.runs, []);
  assert.deepEqual(replyIdentity(message, workflow, [run, { ...run }])?.runs, []);
  assert.equal(replyIdentity(message, { ...workflow, conversationId: 'other-chat' }, [run]), undefined);
  assert.equal(replyIdentity({ ...message, role: 'user' }, workflow, [run]), undefined);
  assert.equal(replyIdentity(message, undefined, [run]), undefined);
  assert.equal(replyIdentity(message, workflow, [{ ...run, summary: true }])?.runs[0]?.runId, 'author');
  assert.deepEqual(replyIdentity({ ...message, id: 'older-reply' }, workflow, [{ ...run, summary: true }])?.runs, []);
});

test('reply labels distinguish system output and launch settings instead of inventing effective effort', () => {
  const html = renderToStaticMarkup(createElement(ReplyIdentity, { identity: captureReplyIdentity(workflow, [run]) }));
  assert.match(html, /Cursor Work.*actual-model.*中/);
  assert.doesNotMatch(html, /requested-model|high|启动配置/);
  const launch = renderToStaticMarkup(
    createElement(ReplyIdentity, {
      identity: captureReplyIdentity(workflow, [
        { ...run, effectiveModel: undefined, route: { ...run.route, effort: undefined } },
      ]),
    }),
  );
  assert.match(launch, /requested-model.*强度未报告/);
  assert.match(launch, /启动配置/);
  const system = renderToStaticMarkup(
    createElement(ReplyIdentity, { identity: captureReplyIdentity(workflow, [run], 'system') }),
  );
  assert.match(system, /PugPort 系统提示/);
  assert.doesNotMatch(system, /actual-model/);
});

test('multi-step output shows every contributing executor without repeating the same settings', () => {
  const identity = captureReplyIdentity(workflow, [
    run,
    { ...run, id: 'same-writer-again' },
    {
      ...run,
      id: 'second-writer',
      route: { ...run.route, runtimeId: 'codex-b' },
      account: { id: 'codex-b', label: 'Codex B', provider: 'codex' },
      effectiveModel: { model: 'second-model', effort: 'high', source: 'fixture' },
    },
  ]);
  const html = renderToStaticMarkup(createElement(ReplyIdentity, { identity }));
  assert.equal(html.match(/Cursor Work/g)?.length, 1);
  assert.match(html, /Codex B.*second-model.*高/);
});

const state = {
  app: { platform: 'win32' },
  settings: { refreshSeconds: 60, maxQuotaAgeSeconds: 120, reservePercent: 10, maxConcurrentRuns: 0 },
  runs: [],
  targets: [],
  runtimes: [],
  workflows: [],
  approvals: [],
  plugins: [],
  refreshing: false,
} as unknown as AppState;
const actions = { api: async <T>() => ({}) as T, notify() {}, reload: async () => {}, onInspect() {} };

test('reply identity defaults on, can be disabled in settings, and remains hidden for manual routing', () => {
  const saved = { ...message, replyIdentity: captureReplyIdentity(workflow, [run]) };
  const render = (enabled?: boolean, row = saved) =>
    renderToStaticMarkup(
      createElement(ConversationHistory, {
        ...actions,
        messages: [row],
        workflows: [],
        state: { ...state, settings: { ...state.settings, showAutomaticReplyIdentity: enabled } },
      }),
    );
  assert.match(render(), /Cursor Work.*actual-model/);
  assert.match(render(true), /actual-model/);
  assert.doesNotMatch(render(false), /actual-model/);
  assert.doesNotMatch(
    render(true, { ...saved, replyIdentity: { ...saved.replyIdentity, automatic: false } }),
    /actual-model/,
  );
  const settings = renderToStaticMarkup(createElement(SettingsPage, { category: 'conversation', ...actions, state }));
  assert.match(settings, /显示自动回复的执行器、模型和强度/);
  assert.doesNotMatch(settings, /默认关闭/);
  assert.doesNotMatch(settings, /开启后标注/);
});

test('reply identity settings switch writes immediately and can be turned off again', async () => {
  const writes: unknown[] = [];
  const props = {
    ...actions,
    state,
    api: async (path: string, body: unknown, method: string) => {
      writes.push(structuredClone({ path, body, method }));
      return {};
    },
  };
  const harness = uiHarness(await uiBundle('src/ui/App.tsx', true));
  let tree = harness.render('SettingsPage', { ...props, category: 'conversation' });
  const checkbox = () => findNode(tree, (node) => node.props['aria-label'] === '显示自动回复的执行器、模型和强度')!;
  assert.equal(checkbox().props.checked, true);
  checkbox().props.onChange({ target: { checked: false } });
  await new Promise<void>((resolve) => setImmediate(resolve));
  tree = harness.render('SettingsPage', { ...props, category: 'conversation' });
  assert.equal(checkbox().props.checked, false);
  assert.deepEqual(writes[0], { path: '/api/settings', body: { showAutomaticReplyIdentity: false }, method: 'PATCH' });
  checkbox().props.onChange({ target: { checked: true } });
  await new Promise<void>((resolve) => setImmediate(resolve));
  tree = harness.render('SettingsPage', { ...props, category: 'conversation' });
  assert.equal(checkbox().props.checked, true);
  assert.deepEqual(writes[1], { path: '/api/settings', body: { showAutomaticReplyIdentity: true }, method: 'PATCH' });
  harness.unmount();
});

test('runs without an account label show the card name, never the internal executor id', () => {
  const identity = {
    automatic: true,
    kind: 'model' as const,
    runs: [
      {
        runId: 'r1',
        runtimeId: 'api-anthropic',
        model: 'anthropic/claude-sonnet-5-5',
        effort: 'medium',
        confirmed: false,
      },
      { runId: 'r2', runtimeId: 'codex-a', accountLabel: 'Codex A', model: 'gpt-6-astra', confirmed: true },
    ],
  };
  const named = namedIdentity(identity, [
    { id: 'api-anthropic', label: 'Anthropic' },
    { id: 'codex-a', label: 'Codex · 本机' },
  ])!;
  assert.deepEqual(
    named.runs.map((run) => run.accountLabel),
    ['Anthropic', 'Codex A'],
  );
  const markup = renderToStaticMarkup(createElement(ReplyIdentity, { identity: named }));
  assert.match(markup, /Anthropic/);
  assert.doesNotMatch(markup, /api-anthropic/);
  assert.equal(namedIdentity(undefined, []), undefined);
});
