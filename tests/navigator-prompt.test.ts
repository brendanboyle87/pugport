import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { codexAdapter } from '../src/server/adapters/codex.ts';
import { ConversationActions } from '../src/server/conversation-actions.ts';
import { modePrompt } from '../src/shared/work-modes.ts';
import type { ExecuteContext } from '../src/shared/types.ts';
import { idleMachineReading } from './helpers/machine-reading.ts';
import { fixture, settled as finished, input, result } from './helpers/session-workspace.ts';

const navigatorBlock = '<pugport-mode kind="navigator">';
const swarmHint = '当前是蜂群协作模式';

async function turn(t: TestContext, setup: (actions: ConversationActions, id: string) => void, child = false) {
  const f = fixture(t, false);
  // Delegation must not wait on this computer's real CPU load.
  t.mock.method(f.controller, 'machineReading', idleMachineReading);
  f.controller.targets = f.controller.targets.slice(0, 1);
  f.controller.snapshots = f.controller.snapshots.slice(0, 1);
  // A bridge address makes the controller grant bridge tools and add its usage hints to the prompt.
  f.controller.agentBridgeUrl = 'http://127.0.0.1:0/mcp';
  const calls: ExecuteContext[] = [];
  let childId = '';
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    calls.push(ctx);
    if (child && !ctx.input.agentChild && !childId) {
      childId = (await f.workspace.delegate(ctx.input.workflowId!, 'scout', 'Read the notes', 'nav-prompt')).workflow
        .id;
      await finished(f.workspace, childId);
    }
    return result('completed', 'Synthetic reply.');
  });
  const project = await f.workspace.createProject(f.directory);
  const conversation = f.workspace.createConversation(project.id);
  setup(new ConversationActions(f.workspace), conversation.id);
  const sent = await f.workspace.send(conversation.id, { ...input, runtimeId: 'mock' });
  assert.equal((await finished(f.workspace, sent.workflow.id)).status, 'completed');
  const lead = calls.find((ctx) => ctx.input.workflowId === sent.workflow.id)!;
  return { lead, child: calls.find((ctx) => ctx.input.workflowId === childId) };
}

test('the navigator lead gets its block once and not the swarm paragraph it replaces', async (t) => {
  const { lead, child } = await turn(t, (actions, id) => actions.setWorkMode(id, 'navigator'), true);
  assert.equal(lead.input.prompt.split(navigatorBlock).length, 2);
  assert.ok(lead.input.prompt.includes(modePrompt('navigator', 'lead', { write: true })));
  assert.ok(!lead.input.prompt.includes(swarmHint), 'one set of dispatch instructions, not two');
  assert.ok(child, 'the lead delegated');
  assert.ok(!child!.input.prompt.includes(navigatorBlock), 'a child is an ordinary delegated task');
});

test('an ordinary swarm turn keeps the swarm paragraph and gets no mode block', async (t) => {
  const { lead } = await turn(t, (actions, id) => actions.setSwarm(id, true));
  assert.ok(lead.input.prompt.includes(swarmHint));
  assert.ok(!lead.input.prompt.includes(navigatorBlock));
});

test('a read-only navigator turn drops the write=true line', async (t) => {
  const f = fixture(t, false);
  // Delegation must not wait on this computer's real CPU load.
  t.mock.method(f.controller, 'machineReading', idleMachineReading);
  f.controller.targets = f.controller.targets.slice(0, 1);
  f.controller.snapshots = f.controller.snapshots.slice(0, 1);
  const calls: ExecuteContext[] = [];
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    calls.push(ctx);
    return result('completed', 'Synthetic reply.');
  });
  const project = await f.workspace.createProject(f.directory);
  const conversation = f.workspace.createConversation(project.id);
  new ConversationActions(f.workspace).setWorkMode(conversation.id, 'navigator');
  const sent = await f.workspace.send(conversation.id, { ...input, permissionMode: 'read-only', runtimeId: 'mock' });
  assert.equal((await finished(f.workspace, sent.workflow.id)).status, 'completed');
  const prompt = calls.at(-1)!.input.prompt;
  assert.ok(prompt.includes(modePrompt('navigator', 'lead', { write: false })));
  assert.ok(!prompt.includes('write=true with files'));
});
