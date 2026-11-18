import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { RunRecord } from '../src/shared/types.ts';
import { RunAccountSummary } from '../src/ui/RunAccountSummary.tsx';
import { RunOutput } from '../src/ui/App.tsx';

test('execution output exposes actual account and relay source without manufacturing account data for historical runs', () => {
  const run: RunRecord = {
    id: 'fixture-run-b',
    prompt: 'fixture',
    projectPath: 'C:/Fixture',
    kind: 'routine',
    status: 'running',
    route: { runtimeId: 'grok-account-b', model: 'grok-fixture', kind: 'routine', reasons: [], warnings: [] },
    startedAt: '2026-09-27T12:00:00Z',
    output: '',
    events: [],
  };
  assert.equal(renderToStaticMarkup(createElement(RunAccountSummary, { run })), '');
  const relay: RunRecord = {
    ...run,
    account: { id: 'account-b', label: 'Grok B', provider: 'grok' },
    relay: { fromRunId: 'fixture-run-a', fromRuntimeId: 'grok-account-a', reason: 'quota' },
  };
  const html = renderToStaticMarkup(
    createElement(RunOutput, {
      run: relay,
      runtimes: [],
      targets: [
        {
          id: 'grok-account-a',
          provider: 'grok',
          label: 'Grok A',
          environment: 'native',
          command: 'fixture',
          enabled: true,
        },
      ],
      api: async <T>() => ({}) as T,
      notify() {},
      onHandoff() {},
    }),
  );
  assert.match(html, /使用账号：Grok B/);
  assert.match(html, /账号接力：Grok A → Grok B/);
  assert.match(html, /原账号额度受限/);
  assert.match(html, /来源任务 fixture-/);
  const fallback = renderToStaticMarkup(
    createElement(RunAccountSummary, { run: { ...relay, relay: { ...relay.relay!, reason: 'authentication' } } }),
  );
  assert.match(fallback, /grok-account-a → Grok B/);
  assert.match(fallback, /原账号认证被拒绝/);
});

test('a run that answered from the text alone says so plainly', () => {
  const run: RunRecord = {
    id: 'fixture-run-c',
    prompt: 'fixture',
    projectPath: 'C:/Fixture',
    kind: 'general',
    status: 'completed',
    route: { runtimeId: 'claude-b', model: 'claude-fixture', kind: 'general', reasons: [], warnings: [] },
    startedAt: '2026-10-10T12:00:00Z',
    output: '',
    events: [],
    toolless: true,
  };
  assert.match(renderToStaticMarkup(createElement(RunAccountSummary, { run })), /纯聊天（不读文件）/);
  assert.doesNotMatch(
    renderToStaticMarkup(createElement(RunAccountSummary, { run: { ...run, toolless: undefined } })),
    /纯聊天/,
  );
});
