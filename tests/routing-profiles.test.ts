import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { RoutingProfiles } from '../src/server/routing-profiles.ts';
import { WorkspaceStore } from '../src/server/workspace-store.ts';
import {
  conversationRuleSet,
  effectiveRoutingProfileId,
  profileConversationRouting,
  routingProfileSchema,
  routingRuleDraft,
  routingModelExcluded,
} from '../src/shared/routing-profiles.ts';
import { parseRoutingRules } from '../src/shared/routing-parser.ts';
import { routingRuleSetSchema } from '../src/shared/routing-schema.ts';
import type { RoutingRuleSet, Settings } from '../src/shared/types.ts';
import { taskCategory } from '../src/server/task-category.ts';
import { matchRule } from '../src/server/routing-rules.ts';
import { routedMessage, routingCards } from '../src/server/conversation-routing.ts';

const rules = (id: string): RoutingRuleSet => ({
  version: 2,
  text: 'Simple questions use the configured account',
  rules: [{ id, category: 'other', candidates: [{ runtimeId: id }], enabled: true, strict: true, source: 'manual' }],
  unparsed: [],
  updatedAt: '2026-10-25T00:00:00Z',
});

test('saved profile roles survive projection, validation, inheritance and upgrading', () => {
  const roles = {
    coordinator: { provider: 'claude' as const },
    verifier: [{ provider: 'codex' as const, model: 'gpt-6-astra' }],
  };
  const profileRules = { ...rules('current'), roles };
  assert.deepEqual(routingRuleSetSchema.parse({ ...routingRuleDraft(profileRules), updatedAt: 'now' }).roles, roles);
  const id = randomUUID();
  const settings = { routingProfiles: [{ id, name: 'Flow', rules: profileRules }] };
  const selected = conversationRuleSet(settings, {}, { routingProfileId: id });
  assert.deepEqual(selected?.roles, roles);
  assert.deepEqual(conversationRuleSet(settings, { routingProfileId: id })?.roles, roles);
  assert.equal(
    conversationRuleSet(
      { routingProfiles: [{ id, name: 'No roles', rules: rules('plain') }] },
      {
        routingProfileId: id,
        routing: { ...profileRules, chapterAgents: false, mask: false },
      },
    )?.roles,
    undefined,
  );
});

test('parsed conversation options project into the strict saved-profile contract', () => {
  const parsed = parseRoutingRules('其余内容使用 Claude，每章独立 agent', [
    { id: 'claude', provider: 'claude', label: 'Claude' },
  ]);
  assert.equal(routingRuleSetSchema.safeParse({ ...parsed, updatedAt: 'now' }).success, false);
  const profile = { ...routingRuleDraft(parsed), updatedAt: 'now', selection: 'quota', excludeModels: ['*-light-*'] };
  assert.equal(routingRuleSetSchema.safeParse(profile).success, true);
  assert.equal('chapterAgents' in profile, false);
  assert.equal('mask' in profile, false);
  assert.equal(routingRuleSetSchema.safeParse({ ...profile, unexpected: true }).success, false);
  assert.equal(routingRuleSetSchema.safeParse({ ...profile, excludeModels: ['/(light|tiny)/'] }).success, false);
});

test('model exclusions use case-insensitive literal wildcard matching and profiles replace old local constraints', () => {
  assert.equal(routingModelExcluded('Claude-LIGHT-2', ['*-light-*']), true);
  assert.equal(routingModelExcluded('model.v1', ['model.v1']), true);
  assert.equal(routingModelExcluded('modelXv1', ['model.v1']), false);
  assert.equal(routingModelExcluded('a', ['a*a']), false);
  assert.equal(routingModelExcluded('AA', ['a*a']), true);
  assert.equal(routingModelExcluded('many', ['*'.repeat(200) + 'x']), false);
  const id = randomUUID();
  const selected = conversationRuleSet(
    { routingProfiles: [{ id, name: 'Simple', rules: rules('current') }] },
    {
      routingProfileId: id,
      routing: { ...rules('local'), chapterAgents: false, mask: false, excludeModels: ['*'], selection: 'quota' },
    },
  );
  assert.equal(selected?.excludeModels, undefined);
  assert.equal(selected?.selection, undefined);
});

test('project inheritance respects explicit automatic, chat overrides and missing profile failures', () => {
  const id = randomUUID(),
    other = randomUUID();
  const project = { routingProfileId: id };
  const settings = {
    routingRules: rules('global'),
    routingProfiles: [{ id, name: 'Project', rules: rules('project') }],
  };
  assert.equal(effectiveRoutingProfileId({}, project), id);
  assert.equal(effectiveRoutingProfileId({ routingProfileId: null }, project), undefined);
  assert.equal(effectiveRoutingProfileId({ routingProfileId: other }, project), other);
  assert.equal(conversationRuleSet(settings, {}, project)?.rules[0]?.candidates[0]?.runtimeId, 'project');
  assert.equal(
    conversationRuleSet(settings, { routingProfileId: null }, project)?.rules[0]?.candidates[0]?.runtimeId,
    'global',
  );
  assert.throws(() => conversationRuleSet(settings, {}, { routingProfileId: other }), /不可用/);
});

test('project-referenced profiles cannot be removed, including removed projects that can still be restored', () => {
  const db = new DatabaseSync(':memory:');
  const store = new WorkspaceStore(db, { recoverInterrupted: false });
  const id = randomUUID();
  let settings = { routingProfiles: [{ id, name: 'Project', rules: rules('project') }] } as Settings;
  const profiles = new RoutingProfiles({
    store,
    settings: () => settings,
    save: (patch) => {
      settings = { ...settings, ...patch };
    },
  });
  try {
    store.save('project', 'project', 'project', { id: 'project', routingProfileId: id, removedAt: '2026-01-01' });
    assert.throws(() => profiles.remove(id), /项目/);
    assert.equal(profiles.list().length, 1);
    store.save('project', 'project', 'project', { id: 'project' });
    assert.deepEqual(profiles.remove(id).profiles, []);
  } finally {
    db.close();
  }
});

test('a selected profile does not inherit old custom content categories', () => {
  const id = randomUUID();
  const code = { ...rules('code'), rules: [{ ...rules('code').rules[0]!, category: 'code' }] };
  const selected = conversationRuleSet(
    { routingProfiles: [{ id, name: 'Code', rules: code }] },
    {
      routingProfileId: id,
      routing: {
        ...rules('old'),
        chapterAgents: false,
        mask: false,
        categories: [{ id: 'custom:old', label: 'Old', keywords: ['code'] }],
      },
    },
  )!;
  const category = taskCategory({ prompt: 'Explain this code', categories: selected.categories });
  assert.equal(category.id, 'code');
  assert.equal(matchRule(selected.rules, category)?.id, 'code');
});

test('API coordinator rules retain the exact account both in the current catalog and when disconnected', () => {
  const target = {
    id: 'api-deepseek',
    provider: 'pi' as const,
    gateway: 'api' as const,
    apiProvider: 'deepseek',
    label: 'DeepSeek account',
    command: 'synthetic',
    enabled: true,
    environment: 'native' as const,
  };
  const cards = routingCards([target]);
  assert.equal(cards[0]?.id, target.id);
  const routing = {
    ...rules('code'),
    chapterAgents: false,
    mask: false,
    roles: { coordinator: { runtimeId: target.id, provider: target.provider } },
  };
  for (const catalog of [cards, []]) {
    const input = routedMessage(
      { content: 'Explain this code', mode: 'chat', permissionMode: 'read-only', executionPolicy: 'api-only' },
      routing,
      catalog,
    );
    assert.equal(input.runtimeId, target.id);
    assert.equal(input.provider, undefined);
  }
});

test('saved names survive reload, cannot collide, and selecting rules does not mutate the definition', () => {
  const db = new DatabaseSync(':memory:');
  const store = new WorkspaceStore(db, { recoverInterrupted: false });
  let settings = {} as Settings;
  const host = {
    store,
    settings: () => settings,
    save: (patch: Pick<Settings, 'routingProfiles'>) => {
      settings = { ...settings, ...patch };
    },
  };
  try {
    const profiles = new RoutingProfiles(host);
    const id = randomUUID();
    profiles.put({ id, name: ' Fast questions ', rules: rules('fast') });
    assert.equal(new RoutingProfiles(host).list()[0]?.name, 'Fast questions');
    assert.throws(() => profiles.put({ id: randomUUID(), name: 'FAST QUESTIONS', rules: rules('other') }), /同名/);
    assert.equal(routingProfileSchema.safeParse({ id, name: 'x'.repeat(61), rules: rules('bad') }).success, false);
    const selected = profileConversationRouting(settings, { routingProfileId: id });
    assert.equal(selected?.rules[0]?.strict, true);
    selected!.rules.length = 0;
    assert.equal(profiles.list()[0]?.rules.rules.length, 1);
  } finally {
    db.close();
  }
});

test('profile selection replaces content rules and roles, preserves checklist; automatic keeps legacy rules', () => {
  const id = randomUUID();
  const local = {
    ...rules('local'),
    chapterAgents: true,
    mask: true,
    automaticExecutors: ['allowed'],
    roles: { coordinator: { runtimeId: 'coordinator' } },
  };
  const settings = { routingRules: rules('global'), routingProfiles: [{ id, name: 'Named', rules: rules('named') }] };
  const selected = conversationRuleSet(settings, { routingProfileId: id, routing: local });
  assert.equal(selected?.rules[0]?.candidates[0]?.runtimeId, 'named');
  assert.deepEqual(selected?.automaticExecutors, ['allowed']);
  assert.equal(selected?.roles, undefined);
  assert.deepEqual(conversationRuleSet(settings, { routing: local })?.roles, local.roles);
  assert.equal(selected?.mask, true);
  assert.equal(conversationRuleSet(settings, { routing: local })?.rules[0]?.candidates[0]?.runtimeId, 'local');
  assert.throws(() => conversationRuleSet(settings, { routingProfileId: randomUUID() }), /不可用/);
  const taskSnapshot = structuredClone(selected);
  settings.routingProfiles[0]!.rules = rules('edited');
  assert.equal(taskSnapshot?.rules[0]?.candidates[0]?.runtimeId, 'named');
  assert.equal(conversationRuleSet(settings, { routingProfileId: id })?.rules[0]?.candidates[0]?.runtimeId, 'edited');
});

test('deletion rejects profiles still selected by readable chats, then removes without changing chat content', () => {
  const db = new DatabaseSync(':memory:');
  const store = new WorkspaceStore(db, { recoverInterrupted: false });
  const id = randomUUID();
  let settings = { routingProfiles: [{ id, name: 'Keep', rules: rules('fast') }] } as Settings;
  const profiles = new RoutingProfiles({
    store,
    settings: () => settings,
    save: (patch) => {
      settings = { ...settings, ...patch };
    },
  });
  try {
    const conversation = { id: 'chat', projectId: 'project', routingProfileId: id, title: 'Keep my draft' };
    store.save('conversation', 'chat', 'project', conversation);
    assert.throws(() => profiles.remove(id), /切回自动/);
    assert.equal(profiles.list().length, 1);
    store.save('conversation', 'chat', 'project', { ...conversation, routingProfileId: undefined });
    profiles.remove(id);
    assert.equal(profiles.list().length, 0);
    assert.equal(store.get<{ title: string }>('conversation', 'chat')?.title, 'Keep my draft');
  } finally {
    db.close();
  }
});
