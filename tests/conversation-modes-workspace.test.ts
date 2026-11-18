import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from './helpers/session-workspace.ts';
import type { Conversation, RunInput, Project, Workflow } from '../src/shared/types.ts';

const manifest = {
  schemaVersion: 1,
  id: 'example.form',
  version: '1.0.0',
  title: 'Form',
  description: 'fixture',
  view: {
    markdown: 'This is only UI data',
    fields: [{ id: 'note', label: 'Note', type: 'textarea' }],
    actions: [],
  },
};

test('real enqueue snapshots mode identity without altering message, route, permission or prompt; queued cancellation settles the switch', async (t) => {
  const { controller, workspace, directory } = fixture(t);
  t.mock.method(workspace, 'wake', () => {});
  const project = await workspace.createProject(directory, 'Fixture');
  const conversation = workspace.createConversation(project.id);
  workspace.modes.import(manifest);
  workspace.modes.install('example.form', '1.0.0');
  const mode = workspace.modes.bind(conversation.id, { modeId: 'example.form' });
  workspace.modes.action(conversation.id, {
    instanceId: mode.instance!.id,
    expectedRevision: 0,
    action: { type: 'save', values: { note: 'Never silently inject this field' } },
  });
  const input = {
    content: 'Hello, explain a map.',
    mode: 'chat' as const,
    permissionMode: 'read-only' as const,
    executionPolicy: 'cli-only' as const,
    runtimeId: 'mock',
    model: 'mock-model',
    effort: 'medium',
  };
  const { message, workflow } = await workspace.send(conversation.id, input);
  assert.equal(message.content, input.content);
  assert.deepEqual(workflow.modeSnapshot, { binding: mode.binding, revision: 1 });
  const dispatched = (workspace as unknown as { input(w: Workflow, p: Project, prompt: string): RunInput }).input(
    workflow,
    project,
    'User goal',
  );
  assert.equal(dispatched.permissionMode, 'read-only');
  assert.equal(dispatched.runtimeId, 'mock');
  assert.equal(dispatched.model, 'mock-model');
  assert.equal(dispatched.routingPrompt, input.content);
  assert.ok(!dispatched.prompt.includes('Never silently inject'));
  assert.ok(!dispatched.prompt.includes('only UI data'));
  assert.equal(controller.active.size, 0);
  assert.equal(workspace.store.workflows(conversation.id).length, 1);
  const switched = workspace.modes.bind(conversation.id, { modeId: null });
  assert.equal(switched.pending?.afterWorkflowId, workflow.id);
  assert.ok(switched.binding);
  workspace.cancel(workflow.id);
  assert.equal(workspace.modes.view(conversation.id).binding, null);
  assert.equal(
    workspace.store.get<Workflow>('workflow', workflow.id)?.modeSnapshot?.binding.instanceId,
    mode.instance?.id,
  );
  const ordinary = await workspace.send(conversation.id, { ...input, content: 'Another ordinary message.' });
  assert.equal(ordinary.workflow.modeSnapshot, undefined);
});

test('mode barrier includes QueueDeferred and active terminal work until the existing owner releases it', async (t) => {
  const { workspace, directory } = fixture(t);
  t.mock.method(workspace, 'wake', () => {});
  const project = await workspace.createProject(directory, 'Fixture');
  const conversation = workspace.createConversation(project.id);
  workspace.modes.import(manifest);
  workspace.modes.install('example.form', '1.0.0');
  workspace.modes.bind(conversation.id, { modeId: 'example.form' });
  const { workflow } = await workspace.send(conversation.id, {
    content: 'Hello',
    mode: 'chat',
    permissionMode: 'read-only',
    executionPolicy: 'cli-only',
    runtimeId: 'mock',
  });
  workflow.status = 'waiting-resource';
  workflow.startedAt = new Date().toISOString();
  workspace.store.save('workflow', workflow.id, conversation.id, workflow);
  workspace.modes.bind(conversation.id, { modeId: null });
  workspace.modes.settled(workflow);
  assert.ok(workspace.modes.view(conversation.id).pending);
  const active = (workspace as unknown as { active: Map<string, { workflow: Workflow }> }).active;
  active.set(workflow.id, { workflow });
  workflow.status = 'completed';
  workspace.store.save('workflow', workflow.id, conversation.id, workflow);
  workspace.modes.settled(workflow);
  assert.ok(workspace.modes.view(conversation.id).pending);
  active.delete(workflow.id);
  workspace.modes.settled(workflow);
  assert.equal(workspace.modes.view(conversation.id).binding, null);
  assert.equal(workspace.store.get<Conversation>('conversation', conversation.id)?.pendingModeBinding, undefined);
});

test('closing an incognito conversation removes its mode instance with existing owner cleanup', async (t) => {
  const { workspace, directory } = fixture(t);
  t.mock.method(workspace, 'wake', () => {});
  const project = await workspace.createProject(directory, 'Fixture');
  const conversation = workspace.createConversation(project.id, 'Private', true);
  workspace.modes.import(manifest);
  workspace.modes.install('example.form', '1.0.0');
  const state = workspace.modes.bind(conversation.id, { modeId: 'example.form' });
  workspace.modes.action(conversation.id, {
    instanceId: state.instance!.id,
    expectedRevision: 0,
    action: { type: 'save', values: { note: 'private draft' } },
  });
  assert.equal((await workspace.closeIncognito(conversation.id)).deleted, true);
  assert.equal(workspace.store.get('mode-instance', state.instance!.id), undefined);
  assert.equal(workspace.modes.catalog().installed.length, 1);
  assert.throws(() => workspace.modes.view(conversation.id));
});
