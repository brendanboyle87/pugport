import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { claudeAdapter } from '../src/server/adapters/claude.ts';
import { codexAdapter } from '../src/server/adapters/codex.ts';
import { ConversationActions } from '../src/server/conversation-actions.ts';
import type { ExecuteContext, Workflow } from '../src/shared/types.ts';
import { idleMachineReading } from './helpers/machine-reading.ts';
import { fixture, settled as finished, input, result } from './helpers/session-workspace.ts';

/** Two synthetic cards (mock = Codex, other = Claude) and a project chat in Navigator mode. */
async function navigatorChat(t: TestContext, lead?: (ctx: ExecuteContext) => Promise<unknown>) {
  const f = fixture(t, false);
  // Delegation must not wait on this computer's real CPU load.
  t.mock.method(f.controller, 'machineReading', idleMachineReading);
  const calls: ExecuteContext[] = [];
  const execute = async (ctx: ExecuteContext) => {
    calls.push(ctx);
    if (!ctx.input.agentChild && lead) await lead(ctx);
    return result('completed', 'Synthetic reply.');
  };
  t.mock.method(codexAdapter, 'execute', execute);
  t.mock.method(claudeAdapter, 'execute', execute);
  const actions = new ConversationActions(f.workspace);
  const project = await f.workspace.createProject(f.directory);
  const conversation = f.workspace.createConversation(project.id);
  actions.setWorkMode(conversation.id, 'navigator');
  const send = async (extra: Partial<typeof input> = {}) => {
    const sent = await f.workspace.send(conversation.id, { ...input, ...extra });
    const flow = await finished(f.workspace, sent.workflow.id);
    assert.equal(flow.status, 'completed', flow.error ?? 'Synthetic navigator turn should complete');
    return { flow, run: calls.find((ctx) => ctx.input.workflowId === flow.id)! };
  };
  return { ...f, calls, actions, conversation, send };
}

test('the saved route runs the lead on its card, read-only, as the coordinator', async (t) => {
  const f = await navigatorChat(t);
  f.actions.setNavigatorRoute(f.conversation.id, { runtimeId: 'other', model: 'mock-model', effort: 'high' });
  const { flow, run } = await f.send();
  assert.equal(run.target.id, 'other');
  assert.equal(run.route.model, 'mock-model');
  assert.equal(run.route.effort, 'high');
  assert.equal(flow.input.runtimeIdFromMode, true);
  assert.equal(flow.input.allowExecutorFallback, true);
  assert.equal(flow.input.permissionMode, 'workspace-write', "the user's grant stays the children's ceiling");
  assert.equal(run.input.permissionMode, 'read-only', 'the lead itself never writes');
  assert.equal(run.input.coordinator, true);
  assert.equal(run.input.workMode, 'navigator');
});

test('a cooling saved card re-routes automatically with a note; the route stays saved', async (t) => {
  const f = await navigatorChat(t);
  const other = f.controller.snapshots.find((snapshot) => snapshot.id === 'other')!;
  other.quota = { ...other.quota!, windows: [{ ...other.quota!.windows[0]!, usedPercent: 100 }] };
  f.actions.setNavigatorRoute(f.conversation.id, { runtimeId: 'other', model: 'mock-model', effort: 'high' });
  const { run } = await f.send();
  assert.equal(run.target.id, 'mock');
  assert.ok(
    // The ordinary technical-fallback note, or the routing preference note: either way the turn is not blocked.
    run.route.reasons.some((reason) => /other .*(?:已自动切换到|已自动改用) mock/.test(reason)),
    run.route.reasons.join(' | '),
  );
  assert.deepEqual(f.workspace.requireConversation(f.conversation.id).navigatorRoute, {
    runtimeId: 'other',
    model: 'mock-model',
    effort: 'high',
  });
});

test('a card pinned on the message wins over the saved route', async (t) => {
  const f = await navigatorChat(t);
  f.actions.setNavigatorRoute(f.conversation.id, { runtimeId: 'other' });
  const { flow, run } = await f.send({ runtimeId: 'mock' });
  assert.equal(run.target.id, 'mock');
  assert.equal(flow.input.runtimeIdFromMode, undefined);
});

test('children never inherit the route or the coordinator tier, and a greeting skips the upgrade', async (t) => {
  let childId = '';
  const f = await navigatorChat(t, async (ctx) => {
    if (childId) return;
    const child = await f.workspace.delegate(ctx.input.workflowId!, 'scout', 'Read the synthetic file', 'nav-child');
    childId = child.workflow.id;
    await finished(f.workspace, childId);
  });
  f.actions.setNavigatorRoute(f.conversation.id, { runtimeId: 'other', model: 'mock-model', effort: 'high' });
  const { run } = await f.send();
  assert.equal(run.input.coordinator, true);
  const child = f.workspace.store.get<Workflow>('workflow', childId)!;
  assert.equal(child.input.runtimeId, undefined);
  assert.equal(child.input.model, undefined);
  assert.equal(child.input.effort, undefined);
  assert.equal(child.input.runtimeIdFromMode, undefined);
  const childRun = f.calls.find((ctx) => ctx.input.workflowId === childId)!;
  assert.equal(childRun.input.coordinator, undefined);
  assert.equal(childRun.input.workMode, undefined, 'a child is an ordinary delegated task');
  const greeting = await f.send({ mode: 'chat', content: '你好' });
  assert.equal(greeting.run.input.coordinator, undefined, 'a greeting is answered directly, without the strong tier');
});
