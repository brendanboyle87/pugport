import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ExtensionHub, extensions } from '../src/server/extensions.ts';
import { ConversationActions } from '../src/server/conversation-actions.ts';
import { claudeAdapter } from '../src/server/adapters/claude.ts';
import { agentPresetSkills, builtinAgentPresets } from '../src/shared/agent-presets.ts';
import type { SkillExtension } from '../src/shared/extensions.ts';
import type { Conversation, ExecuteContext, MessageInput, Project, RunInput, Workflow } from '../src/shared/types.ts';
import type { Workspace } from '../src/server/workspace.ts';
import { fixture } from './helpers/session-workspace.ts';

const skill = (name: string, path: string, patch: Partial<SkillExtension> = {}): SkillExtension => ({
  kind: 'skill',
  id: name,
  name,
  description: 'Review the current request',
  path,
  source: 'synthetic fixture',
  managed: false,
  enabled: true,
  installedAt: '2026-10-24T00:00:00Z',
  ...patch,
});
const input: MessageInput = {
  content: '你好',
  mode: 'chat',
  permissionMode: 'read-only',
  executionPolicy: 'cli-only',
  runtimeId: 'other',
};
const dispatch = (workspace: Workspace, workflow: Workflow, project: Project) =>
  (workspace as unknown as { input(workflow: Workflow, project: Project, prompt: string): RunInput }).input(
    workflow,
    project,
    'Synthetic context',
  );

async function setup(t: TestContext) {
  const f = fixture(t);
  t.mock.method(f.workspace, 'wake', () => {});
  const project = await f.workspace.createProject(f.directory, 'Fixture');
  const conversation = f.workspace.createConversation(project.id);
  const folder = join(f.directory, 'synthetic-skill');
  mkdirSync(folder);
  writeFileSync(
    join(folder, 'SKILL.md'),
    '---\nname: review\ndescription: Review the request\n---\nSynthetic full instructions only opened by use_skill.',
  );
  const hubDirectory = join(f.directory, 'hub');
  mkdirSync(hubDirectory);
  writeFileSync(
    join(hubDirectory, 'extensions.json'),
    JSON.stringify({
      version: 1,
      items: [skill('review', folder), skill('ordinary', folder), skill('disabled', folder, { enabled: false })],
    }),
  );
  const hub = new ExtensionHub(hubDirectory, []);
  t.mock.method(extensions, 'all', () => hub.all());
  const actions = new ConversationActions(f.workspace);
  return { ...f, project, conversation, hub, actions };
}

test('application belongs to one conversation, preserves the allowlist and clearing keeps ordinary skills callable', async (t) => {
  const f = await setup(t);
  const other = f.workspace.createConversation(f.project.id);
  f.actions.setSkills(f.conversation.id, ['review', 'ordinary']);
  f.workspace.store.save('conversation', f.conversation.id, f.project.id, {
    ...f.workspace.store.get<Conversation>('conversation', f.conversation.id)!,
    updatedAt: '2020-01-01T00:00:00.000Z',
  });
  const applied = f.actions.setAppliedSkills(
    f.conversation.id,
    [' REVIEW ', 'review', 'disabled'],
    f.hub.all().map((item) => item.name),
  );
  assert.deepEqual(applied.appliedSkills, ['review', 'disabled']);
  assert.ok(applied.updatedAt > '2020-01-01T00:00:00.000Z');
  assert.equal(f.workspace.store.get<Conversation>('conversation', f.conversation.id)?.updatedAt, applied.updatedAt);
  assert.deepEqual(applied.skills, ['review', 'ordinary']);
  assert.equal(f.workspace.store.get<Conversation>('conversation', other.id)?.appliedSkills, undefined);
  assert.deepEqual(f.workspace.store.get<Conversation>('conversation', f.conversation.id)?.appliedSkills, [
    'review',
    'disabled',
  ]);
  assert.match(f.hub.skillHint('one turn', applied.skills, applied.appliedSkills)!, /每轮必须先检查.*适合时必须先调用/);
  assert.doesNotMatch(f.hub.skillHint('next turn', applied.skills, applied.appliedSkills)!, /- disabled：/);
  const cleared = f.actions.setAppliedSkills(
    f.conversation.id,
    [],
    f.hub.all().map((item) => item.name),
  );
  assert.deepEqual(cleared.appliedSkills, []);
  assert.deepEqual(cleared.skills, ['review', 'ordinary']);
  assert.doesNotMatch(f.hub.skillHint('next turn', cleared.skills, cleared.appliedSkills)!, /本对话已应用/);
  const result = await f.hub.call('use_skill', { name: 'ordinary' }, false);
  assert.match(String(result.content[0]?.text), /Synthetic full instructions/);
  assert.ok(f.hub.all().find((item) => item.id === 'ordinary')?.enabled);
});

test('applied names cannot bypass disabled skills, role restrictions, allowed empty or host authorization', async (t) => {
  const f = await setup(t);
  const applied = ['review', 'disabled'];
  assert.equal(f.hub.skillHint('request', [], applied), undefined);
  const allowed = agentPresetSkills({ ...builtinAgentPresets[0]!, skills: ['ordinary'] }, ['review', 'ordinary']);
  assert.deepEqual(allowed, ['ordinary']);
  assert.doesNotMatch(f.hub.skillHint('request', allowed, applied)!, /本对话已应用|- review：|- disabled：/);
  assert.deepEqual(
    f.hub.bridgeTools(false, []).map((tool) => tool.name),
    [],
  );
  await assert.rejects(f.hub.call('use_skill', { name: 'review' }, false, undefined, allowed), /没有名为/);
  await assert.rejects(f.hub.call('use_skill', { name: 'disabled' }, false), /没有名为/);
  await assert.rejects(
    f.hub.call('use_skill', { name: 'review' }, false, undefined, undefined, undefined, () => {
      throw new Error('authorization denied');
    }),
    /authorization denied/,
  );
});

test('application validates installed names and bounds without changing the previous record on rejection', async (t) => {
  const f = await setup(t);
  f.actions.setAppliedSkills(f.conversation.id, ['review'], ['review', 'disabled']);
  const before = f.workspace.store.get<Conversation>('conversation', f.conversation.id);
  for (const names of [['missing'], [''], ['x'.repeat(201)], Array.from({ length: 41 }, () => 'review')]) {
    assert.throws(() => f.actions.setAppliedSkills(f.conversation.id, names, ['review', 'disabled']));
    assert.deepEqual(f.workspace.store.get<Conversation>('conversation', f.conversation.id), before);
  }
  assert.throws(() => f.actions.setAppliedSkills('missing-conversation', [], ['review']));
});

test('a failed preference save leaves the original conversation and timestamp intact', async (t) => {
  const f = await setup(t);
  const before = f.workspace.store.get<Conversation>('conversation', f.conversation.id)!;
  const snapshot = structuredClone(before);
  const save = t.mock.method(f.workspace.store, 'save', () => {
    throw new Error('synthetic write failure');
  });
  try {
    assert.throws(
      () => f.actions.setAppliedSkills(f.conversation.id, ['review'], ['review']),
      /synthetic write failure/,
    );
    assert.deepEqual(before, snapshot);
    assert.deepEqual(f.workspace.store.get<Conversation>('conversation', f.conversation.id), snapshot);
  } finally {
    save.mock.restore();
  }
});

test('applied relevance descriptions survive the forty-entry budget on every turn without eager reads', async (t) => {
  const f = await setup(t);
  const ordinary = Array.from({ length: 45 }, (_, index) =>
    skill(`ordinary-${index}`, 'does-not-exist', { description: 'needle needle needle' }),
  );
  const selected = skill('preferred', 'does-not-exist', { description: 'An unrelated description' });
  t.mock.method(f.hub, 'all', () => [...ordinary, selected]);
  for (const request of ['needle', 'different request']) {
    const hint = f.hub.skillHint(request, undefined, ['preferred'])!;
    assert.match(hint, /^本对话已应用的技能（每轮必须先检查/);
    assert.match(hint, /- preferred：/);
    assert.equal(hint.split('\n').filter((line) => line.startsWith('- ')).length, 40);
    assert.doesNotMatch(hint, /Synthetic full instructions/);
  }
});

test('each new dispatch reads the current conversation preference, without changing the original user intent', async (t) => {
  const f = await setup(t);
  const { workflow } = await f.workspace.send(f.conversation.id, input);
  const initial = dispatch(f.workspace, workflow, f.project);
  assert.equal(initial.appliedSkills, undefined);
  assert.equal(initial.latencySensitiveChat, true);
  f.actions.setAppliedSkills(f.conversation.id, ['review'], ['review']);
  const selected = dispatch(f.workspace, workflow, f.project);
  assert.deepEqual(selected.appliedSkills, ['review']);
  assert.equal(selected.latencySensitiveChat, undefined);
  assert.equal(selected.routingPrompt, input.content);
  assert.equal(selected.permissionMode, initial.permissionMode);
  f.actions.setAppliedSkills(f.conversation.id, [], ['review']);
  assert.equal(dispatch(f.workspace, workflow, f.project).latencySensitiveChat, true);
  f.actions.setAppliedSkills(f.conversation.id, ['disabled'], ['disabled']);
  assert.equal(dispatch(f.workspace, workflow, f.project).latencySensitiveChat, true);
  f.actions.setAppliedSkills(f.conversation.id, ['review'], ['review']);
  f.actions.setSkills(f.conversation.id, []);
  assert.equal(dispatch(f.workspace, workflow, f.project).latencySensitiveChat, true);
});

test('selected ordinary chat receives the real bridge hint, while explicit no-tools keeps the native no-tools path', async (t) => {
  const f = await setup(t);
  f.actions.setAppliedSkills(f.conversation.id, ['review'], ['review']);
  f.controller.agentBridgeUrl = 'http://127.0.0.1:0/mcp';
  Object.assign(f.controller, { readAccountIdentity: () => 'synthetic-other' });
  const captured: ExecuteContext[] = [];
  const nativeToolModes: Array<'none' | undefined> = [];
  t.mock.method(claudeAdapter, 'execute', async (context: ExecuteContext) => {
    captured.push(context);
    return { output: 'Synthetic response' };
  });
  for (const content of ['你好', '你好，不要调用工具']) {
    const { workflow } = await f.workspace.send(f.conversation.id, { ...input, content });
    const run = await f.controller.start({
      ...dispatch(f.workspace, workflow, f.project),
      workflowId: workflow.id,
      stepId: 'synthetic-execution-step',
      model: 'mock-model',
      effort: 'medium',
    });
    const until = Date.now() + 10000;
    while (f.controller.active.has(run.id) && Date.now() < until)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(run.status, 'completed');
    nativeToolModes.push(run.nativeToolMode);
  }
  assert.equal(captured.length, 2);
  assert.ok(captured[0]!.agentBridge?.token);
  assert.match(captured[0]!.input.prompt, /本对话已应用的技能（每轮必须先检查/);
  assert.equal(nativeToolModes[0], undefined);
  assert.equal(captured[1]!.input.explicitNoTools, true);
  assert.equal(captured[1]!.agentBridge, undefined);
  assert.equal(nativeToolModes[1], 'none');
  assert.doesNotMatch(captured[1]!.input.prompt, /本对话已应用的技能/);
});
