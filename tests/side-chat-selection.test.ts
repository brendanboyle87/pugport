import { sideChatMessageInput } from '../src/ui/side-chat.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { AppState } from '../src/shared/types.ts';
import { inheritSideChatSelection } from '../src/ui/side-chat-selection.ts';

const state = {
  targets: [
    { id: 'codex-primary', provider: 'codex' },
    { id: 'codex-secondary', provider: 'codex' },
  ],
  workflows: [
    { id: 'main-work', conversationId: 'main' },
    { id: 'foreign-work', conversationId: 'foreign' },
  ],
  runs: [
    {
      id: 'main-run',
      workflowId: 'main-work',
      stepId: 'step1',
      startedAt: '2026-09-30T12:00:00Z',
      nativeSessionId: 'main-session',
      route: { runtimeId: 'codex-primary', model: 'main-model', effort: 'high' },
    },
    {
      id: 'foreign-run',
      workflowId: 'foreign-work',
      stepId: 'step1',
      startedAt: '2026-09-30T12:01:00Z',
      route: { runtimeId: 'codex-secondary', model: 'foreign-model', effort: 'low' },
    },
  ],
} as AppState;

test('automatic side chat inherits the main run actual settings instead of a newer delegated writer', () => {
  const view = structuredClone(state);
  view.workflows!.push({
    ...view.workflows![0]!,
    id: 'child',
    delegation: { parentId: 'main-work', requestId: 'child', role: 'implementer' },
  } as any);
  view.runs.push({
    ...view.runs[0]!,
    id: 'child-run',
    workflowId: 'child',
    startedAt: '2026-09-30T13:00:00Z',
    route: { ...view.runs[0]!.route, runtimeId: 'codex-secondary', model: 'child-model' },
  });
  view.runs[0]!.effectiveModel = { model: 'confirmed-model', effort: 'medium', source: 'fixture' };
  const inherited = inheritSideChatSelection(view, 'main', { executionPolicy: 'cli-first' });
  assert.equal(inherited.runtimeId, 'codex-primary');
  assert.equal(inherited.model, 'confirmed-model');
  assert.equal(inherited.effort, 'medium');
});

test('a provider group or automatic side chat inherits the actual main account and model', () => {
  for (const provider of [undefined, 'codex' as const]) {
    const inherited = inheritSideChatSelection(state, 'main', { provider, executionPolicy: 'cli-first' });
    assert.equal(inherited.runtimeId, 'codex-primary');
    assert.equal(inherited.model, 'main-model');
    assert.equal(inherited.effort, 'high');
    assert.equal(inherited.executionPolicy, 'cli-first');
    assert.equal('nativeSessionId' in inherited, false);
  }
});

test('an explicit different account or model keeps the main composer choices', () => {
  const account = inheritSideChatSelection(state, 'main', {
    runtimeId: 'codex-secondary',
    model: 'new-model',
    executionPolicy: 'cli-only',
  });
  assert.equal(account.runtimeId, 'codex-secondary');
  assert.equal(account.model, 'new-model');
  assert.equal(account.effort, undefined);
  const model = inheritSideChatSelection(state, 'main', {
    provider: 'codex',
    model: 'new-model',
    executionPolicy: 'cli-first',
  });
  assert.equal(model.runtimeId, 'codex-primary');
  assert.equal(model.model, 'new-model');
  assert.equal(model.effort, undefined);
});

test('a new side chat never borrows another conversation route', () => {
  const inherited = inheritSideChatSelection(state, 'brand-new', { executionPolicy: 'cli-first' });
  assert.equal(inherited.runtimeId, undefined);
  assert.equal(inherited.model, undefined);
  assert.equal(inherited.effort, undefined);
});

test('automatic Cursor side chats replay confirmed true and false flags, including an explicit effort change', () => {
  for (const thinking of [true, false]) {
    for (const fast of [true, false]) {
      const view = structuredClone(state);
      view.targets[0]!.provider = 'cursor';
      view.runs[0]!.route.model = 'claude-opus-5';
      view.runs[0]!.effectiveModel = {
        model: 'claude-opus-5',
        effort: 'high',
        parameters: { thinking: String(thinking), fast: String(fast) },
        source: 'fixture',
      };
      for (const effort of [undefined, 'medium']) {
        const inherited = inheritSideChatSelection(view, 'main', { effort, executionPolicy: 'cli-first' });
        assert.equal(
          inherited.model,
          `claude-opus-5${thinking ? '-thinking' : ''}-${effort ?? 'high'}${fast ? '-fast' : ''}`,
        );
        assert.equal(inherited.effort, effort ?? 'high');
      }
      const explicit = inheritSideChatSelection(view, 'main', { model: 'other-model', executionPolicy: 'cli-first' });
      assert.equal(explicit.model, 'other-model');
      assert.equal(explicit.effort, undefined);
    }
  }
});

test('Cursor side chats without confirmed parameter metadata do not turn canonical defaults into false flags', () => {
  const view = structuredClone(state);
  view.targets[0]!.provider = 'cursor';
  view.runs[0]!.route.model = 'claude-opus-5';
  const inherited = inheritSideChatSelection(view, 'main', { executionPolicy: 'cli-first' });
  assert.equal(inherited.model, 'claude-opus-5');
  assert.equal(inherited.effort, 'high');
});

test('changing effort on the same confirmed Cursor replay slug rebuilds it instead of sending conflicting settings', () => {
  const view = structuredClone(state);
  view.targets[0]!.provider = 'cursor';
  view.runs[0]!.effectiveModel = {
    model: 'claude-opus-5',
    effort: 'high',
    parameters: { thinking: 'true', fast: 'true' },
    source: 'fixture',
  };
  for (const model of ['claude-opus-5', 'claude-opus-5-thinking-high-fast']) {
    const inherited = inheritSideChatSelection(view, 'main', { model, effort: 'medium', executionPolicy: 'cli-first' });
    assert.equal(inherited.model, 'claude-opus-5-thinking-medium-fast');
    assert.equal(inherited.effort, 'medium');
  }
  const distinct = inheritSideChatSelection(view, 'main', {
    model: 'grok-4.7-medium-fast',
    effort: 'medium',
    executionPolicy: 'cli-first',
  });
  assert.equal(distinct.model, 'grok-4.7-medium-fast');
  assert.equal(distinct.effort, 'medium');
});

test('side chat inheritance and messages ignore legacy save-money overrides', () => {
  for (const saveMoney of [true, false]) {
    const selection = { executionPolicy: 'cli-first' as const, saveMoney };
    const inherited = inheritSideChatSelection(state, 'main', selection);
    assert.equal('saveMoney' in inherited, false);
    assert.equal(inherited.executionPolicy, 'cli-first');
    const message = sideChatMessageInput({ requestId: 'fixture', parentConversationId: 'main', selection }, 'hello');
    assert.equal('saveMoney' in message, false);
    assert.equal(message.executionPolicy, 'cli-first');
  }
});
