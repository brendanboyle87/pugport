import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConversationActions } from '../src/server/conversation-actions.ts';
import { upgradeRouting } from '../src/shared/conversation-routing.ts';
import { parseRoutingRules } from '../src/shared/routing-parser.ts';
import type { Conversation } from '../src/shared/types.ts';
import type { Workspace } from '../src/server/workspace.ts';

test('PATCH history restores the previous set, including migrated roles and clearing, capped at ten snapshots', () => {
  let saved: Conversation = {
    id: 'fixture',
    projectId: 'project',
    title: 'Fixture',
    createdAt: '',
    updatedAt: '',
    routing: {
      text: 'original',
      rules: [
        { topic: 'adult', target: { provider: 'grok' }, strict: true },
        { topic: 'split', target: { provider: 'claude' }, strict: false },
      ],
      chapterAgents: true,
      mask: true,
      updatedAt: '',
    },
  };
  const original = upgradeRouting(saved.routing!);
  const workspace = {
    controller: { targets: [{ id: 'grok', provider: 'grok', enabled: true }] },
    store: {
      get: () => structuredClone(saved),
      save: (_kind: string, _id: string, _owner: string, value: Conversation) => {
        saved = structuredClone(value);
      },
    },
    notifyConversationChanged() {},
  } as unknown as Workspace;
  const actions = new ConversationActions(workspace);
  const next = { ...parseRoutingRules('代码用 codex 或 claude', []), automaticExecutors: ['grok'] };
  actions.setRouting(saved.id, next);
  assert.deepEqual(saved.routing?.automaticExecutors, ['grok']);
  assert.equal(saved.routingHistory?.length, 1);
  actions.undoRouting(saved.id);
  assert.deepEqual(upgradeRouting(saved.routing!).rules, original.rules);
  assert.deepEqual(upgradeRouting(saved.routing!).roles, original.roles);
  assert.equal(saved.routing?.text, 'original');
  assert.equal(saved.routing?.mask, true);
  assert.equal(saved.routing?.automaticExecutors, undefined);
  assert.equal(saved.routingHistory?.length, 0);
  actions.setRouting(saved.id, null);
  assert.equal(saved.routing, undefined);
  assert.equal(actions.undoRouting(saved.id).routing?.text, 'original');
  for (let i = 0; i < 12; i++) actions.setRouting(saved.id, { ...next, text: `${i}` });
  assert.equal(saved.routingHistory?.length, 10);
  actions.undoRouting(saved.id);
  assert.equal(saved.routing?.text, '10');
  const before = structuredClone(saved);
  assert.throws(() => actions.setRouting(saved.id, { ...next, rules: [...next.rules, ...next.rules] }));
  assert.deepEqual(saved, before, 'invalid drafts neither save nor consume undo history');
});
test('undo restores the initial absence of rules', () => {
  let saved: Conversation = { id: 'fixture', projectId: 'project', title: 'Fixture', createdAt: '', updatedAt: '' };
  const actions = new ConversationActions({
    controller: { targets: [] },
    store: {
      get: () => structuredClone(saved),
      save: (_k: string, _i: string, _o: string, value: Conversation) => {
        saved = structuredClone(value);
      },
    },
    notifyConversationChanged() {},
  } as unknown as Workspace);
  actions.setRouting(saved.id, parseRoutingRules('代码用 codex', []));
  actions.undoRouting(saved.id);
  assert.equal(saved.routing, undefined);
  assert.throws(() => actions.undoRouting(saved.id), /没有可撤销/);
});
