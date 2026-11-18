import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalPrompt } from './helpers/normal-prompt.ts';
import { codexAdapter } from '../src/server/adapters/codex.ts';
import { ConversationActions } from '../src/server/conversation-actions.ts';
import { modePrompt, workModeMarker, type WorkMode } from '../src/shared/work-modes.ts';
import type { ExecuteContext, Workflow } from '../src/shared/types.ts';
import { idleMachineReading } from './helpers/machine-reading.ts';
import { fixture, settled as finished, input, result } from './helpers/session-workspace.ts';

const personal = '个人指令（适用于所有对话；与项目规则冲突时，项目规则优先）：\nPERSONAL_FIXTURE';

function setup(t: Parameters<typeof fixture>[0]) {
  const f = fixture(t, false);
  // Delegation must not wait on this computer's real CPU load.
  t.mock.method(f.controller, 'machineReading', idleMachineReading);
  f.controller.targets = f.controller.targets.slice(0, 1);
  f.controller.snapshots = f.controller.snapshots.slice(0, 1);
  f.controller.settings.globalInstructions = 'PERSONAL_FIXTURE';
  const calls: ExecuteContext[] = [];
  return { ...f, calls, actions: new ConversationActions(f.workspace) };
}

for (const mode of ['chat', 'build'] as const)
  for (const kind of ['mods-author', 'navigator'] as const)
    test(`${mode} prompt: the ${kind} block sits directly after personal instructions`, async (t) => {
      const f = setup(t);
      t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
        f.calls.push(ctx);
        return result('completed', 'Synthetic reply.');
      });
      const project = await f.workspace.createProject(f.directory);
      const conversation = f.workspace.createConversation(project.id);
      f.actions.setWorkMode(conversation.id, kind);
      const sent = await f.workspace.send(conversation.id, { ...input, mode, runtimeId: 'mock' });
      const flow = await finished(f.workspace, sent.workflow.id);
      assert.equal(flow.status, 'completed');
      assert.equal(flow.input.workMode, kind);
      const prompt = f.calls.at(-1)!.input.prompt;
      const block = modePrompt(kind, 'lead', { write: flow.input.permissionMode === 'workspace-write' });
      assert.equal(prompt.split(workModeMarker).length, 2, 'exactly one mode block');
      assert.ok(prompt.includes(`${personal}\n\n${block}\n\n`), 'block follows personal instructions');
      assert.ok(prompt.indexOf(block) < prompt.indexOf('回复要求：'));
    });

// Captured before work modes existed; see work-modes-normal-source.json.
for (const mode of ['chat', 'build'] as const)
  test('Normal ' + mode + ' prompt is byte-identical to the pre-mode snapshot', async (t) => {
    const expected = readFileSync(new URL('./fixtures/work-modes-normal-' + mode + '.txt', import.meta.url), 'utf8');
    assert.equal(await normalPrompt(t, mode), expected);
  });

for (const kind of ['mods-author', 'navigator'] as const)
  test(`${kind}: a delegated child gets the member variant or none`, async (t) => {
    const f = setup(t);
    let childId = '';
    t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
      f.calls.push(ctx);
      if (ctx.input.agentChild) return result('completed', 'Synthetic child result.');
      const child = await f.workspace.delegate(ctx.input.workflowId!, 'scout', 'Read the synthetic file', 'child-1');
      childId = child.workflow.id;
      await finished(f.workspace, childId);
      return result('completed', 'Synthetic lead result.');
    });
    const project = await f.workspace.createProject(f.directory);
    const conversation = f.workspace.createConversation(project.id);
    f.actions.setWorkMode(conversation.id, kind);
    const sent = await f.workspace.send(conversation.id, { ...input, mode: 'chat', runtimeId: 'mock' });
    assert.equal((await finished(f.workspace, sent.workflow.id)).status, 'completed');
    const child = f.workspace.store.get<Workflow>('workflow', childId)!;
    assert.equal(child.input.workMode, kind, 'children keep the snapshot through the parent input');
    const childPrompt = f.calls.find((ctx) => ctx.input.workflowId === childId)!.input.prompt;
    const lead = f.calls.find((ctx) => ctx.input.workflowId === sent.workflow.id)!.input.prompt;
    assert.ok(
      lead.includes(modePrompt(kind, 'lead', { write: sent.workflow.input.permissionMode === 'workspace-write' })),
    );
    if (kind === 'navigator') assert.ok(!childPrompt.includes(workModeMarker));
    else {
      assert.ok(childPrompt.includes(modePrompt(kind, 'member')));
      assert.ok(childPrompt.includes('Do not call mod_load'));
      assert.ok(!childPrompt.includes('call mod_load to pack'));
    }
  });

test('a mode change applies from the next message; a queued task keeps its snapshot', async (t) => {
  const f = setup(t);
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    f.calls.push(ctx);
    return result('completed', 'Synthetic reply.');
  });
  const project = await f.workspace.createProject(f.directory);
  const conversation = f.workspace.createConversation(project.id);
  const seen: (WorkMode | undefined)[] = [];
  for (const kind of ['navigator', null, 'mods-author'] as const) {
    f.actions.setWorkMode(conversation.id, kind);
    const sent = await f.workspace.send(conversation.id, { ...input, mode: 'chat', runtimeId: 'mock' });
    f.actions.setWorkMode(conversation.id, 'navigator');
    const flow = await finished(f.workspace, sent.workflow.id);
    seen.push(flow.input.workMode);
    assert.equal(
      f.calls.at(-1)!.input.prompt.includes(workModeMarker),
      !!kind,
      'the run follows the snapshot, not the later edit',
    );
  }
  assert.deepEqual(seen, ['navigator', undefined, 'mods-author']);
});

test('navigator block drops the write line when the turn is read-only', () => {
  assert.match(modePrompt('navigator', 'lead', { write: true }), /write=true with files/);
  assert.doesNotMatch(modePrompt('navigator', 'lead', { write: false }), /write=true/);
  assert.equal(modePrompt(undefined, 'lead'), '');
  assert.equal(modePrompt('navigator', 'member'), '');
});

test('side chats and work lanes refuse a mode; clearing always works', async (t) => {
  const f = setup(t);
  const project = await f.workspace.createProject(f.directory);
  const main = f.workspace.createConversation(project.id);
  for (const extra of [
    { sideChat: { parentConversationId: main.id } },
    { lane: { parentConversationId: main.id, sourceWorkflowId: 'synthetic' } },
  ]) {
    const conversation = { ...f.workspace.createConversation(project.id), ...extra };
    f.workspace.store.save('conversation', conversation.id, project.id, conversation);
    assert.throws(() => f.actions.setWorkMode(conversation.id, 'navigator'), /不能切换模式/);
    assert.equal(f.actions.setWorkMode(conversation.id, null).workMode, undefined);
  }
});
