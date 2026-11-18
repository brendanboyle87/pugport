import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ModelInfo, RuntimeSnapshot, RuntimeTarget } from '../src/shared/types.ts';
import { WorkspaceExecutionFields, workspaceExecutionSelection, workspaceRouteFields } from '../src/ui/Workspace.tsx';

const target = (id: string, provider: RuntimeTarget['provider'], enabled = true): RuntimeTarget => ({
  id,
  provider,
  enabled,
  label: id,
  command: 'fixture',
  environment: 'native',
});
const model = (id: string, efforts: string[], label = id): ModelInfo => ({ id, label, efforts });
const runtime = (target: RuntimeTarget, models: ModelInfo[]): RuntimeSnapshot => ({
  id: target.id,
  label: target.label,
  provider: target.provider,
  environment: target.environment,
  installed: true,
  status: 'ready',
  models,
  quota: { status: 'unknown', source: 'fixture', observedAt: null, windows: [] },
  capabilities: { execute: true, resume: true, cancel: true, approvals: true },
  refreshedAt: '2026-09-27T18:00:00Z',
});
const targets = [
  target('grok-a', 'grok'),
  target('grok-b', 'grok'),
  target('grok-disabled', 'grok', false),
  target('codex-a', 'codex'),
  target('codex-b', 'codex'),
  target('pi-local', 'pi'),
];
const state = {
  targets,
  runtimes: [
    runtime(targets[0], [model('grok-shared', ['low', 'high']), model('grok-a-only', ['low'])]),
    runtime(targets[1], [model('grok-shared', ['medium', 'high']), model('grok-b-only', ['high'])]),
    runtime(targets[2], [model('grok-disabled-only', ['max'])]),
    runtime(targets[3], [model('codex-shared', ['low', 'high']), model('codex-a-only', ['low'])]),
    runtime(targets[4], [model('codex-shared', ['medium']), model('codex-b-only', ['xhigh'])]),
    runtime(targets[5], [model('pi-only', ['max'])]),
  ],
};

test('the executor choice is automatic or one specific account, never a provider group', () => {
  assert.deepEqual(workspaceRouteFields(''), {});
  assert.deepEqual(workspaceRouteFields('grok-b'), { runtimeId: 'grok-b' });
  assert.deepEqual(workspaceRouteFields('codex-a'), { runtimeId: 'codex-a' });
  const html = renderToStaticMarkup(
    createElement(WorkspaceExecutionFields, {
      state,
      policy: 'cli-first' as const,
      selection: '',
      model: '',
      onSelection() {},
      onModel() {},
    }),
  );
  assert.match(html, /<option value="" selected="">自动<\/option>/);
  assert.doesNotMatch(html, /自动选择账号|provider:/);
  for (const id of ['grok-a', 'grok-b', 'codex-a', 'codex-b']) assert.match(html, new RegExp(`value="${id}">${id}<`));
  assert.doesNotMatch(html, /grok-disabled/);
});

test('a specific account keeps only its own model catalog and stays pinned', () => {
  const chosen = workspaceExecutionSelection(state, 'cli-only', 'grok-a');
  assert.equal(chosen.unavailable, false);
  assert.equal(chosen.chosenRuntime?.id, 'grok-a');
  assert.deepEqual(
    chosen.models.map((item) => item.id),
    ['grok-shared', 'grok-a-only'],
  );
  assert.deepEqual(chosen.models[0].efforts, ['low', 'high']);
  const codex = workspaceExecutionSelection(state, 'cli-first', 'codex-b');
  assert.deepEqual(
    codex.models.map((item) => item.id),
    ['codex-shared', 'codex-b-only'],
  );
  const picker = renderToStaticMarkup(
    createElement(WorkspaceExecutionFields, {
      state,
      policy: 'cli-only' as const,
      selection: 'codex-b',
      model: '',
      onSelection() {},
      onModel() {},
    }),
  ).match(/<select aria-label="任务模型"[^]*?<\/select>/)?.[0];
  assert.ok(picker);
  assert.match(picker, /codex-b-only/);
  assert.doesNotMatch(picker, /grok|codex-a-only|pi-only/);
});

test('an account the current policy cannot use is shown as unavailable instead of silently widening dispatch', () => {
  const selected = workspaceExecutionSelection(state, 'api-only', 'grok-a');
  assert.equal(selected.unavailable, true);
  assert.equal(selected.chosenRuntime?.id, 'grok-a');
  const html = renderToStaticMarkup(
    createElement(WorkspaceExecutionFields, {
      state,
      policy: 'api-only' as const,
      selection: 'grok-a',
      model: '',
      onSelection() {},
      onModel() {},
    }),
  );
  assert.match(html, /aria-label="任务模型" disabled=""/);
});
