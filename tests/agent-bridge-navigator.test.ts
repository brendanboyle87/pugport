import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { codexAdapter } from '../src/server/adapters/codex.ts';
import { claudeAdapter } from '../src/server/adapters/claude.ts';
import { ConversationActions } from '../src/server/conversation-actions.ts';
import type { ExecuteContext, Workflow } from '../src/shared/types.ts';
import { idleMachineReading } from './helpers/machine-reading.ts';
import { fixture, settled as finished, input, result } from './helpers/session-workspace.ts';
import { readBridge } from './helpers/read-bridge.ts';

type Bridge = ReturnType<typeof readBridge>;

/**
 * A Navigator turn whose lead run, while it runs, talks to the bridge through a synthetic caller. `during` gets
 * the caller and the bridge; the lead's own grant is read-only, as the host gives it.
 */
async function navigatorTurn(
  t: TestContext,
  permissionMode: 'workspace-write' | 'read-only',
  during: (bridge: Bridge, ctx: ExecuteContext, f: ReturnType<typeof fixture>) => Promise<void>,
  kind: 'navigator' | null = 'navigator',
) {
  const f = fixture(t, false);
  // Delegation must not wait on this computer's real CPU load.
  t.mock.method(f.controller, 'machineReading', idleMachineReading);
  const bridge = readBridge(t, f.directory, undefined, f.workspace);
  let done = false;
  const execute = async (ctx: ExecuteContext) => {
    if (!ctx.input.agentChild && !done) {
      done = true;
      Object.assign(bridge.caller, {
        target: f.controller.targets.find((target) => target.id === ctx.target.id),
        delegate: true,
        write: ctx.input.permissionMode === 'workspace-write',
      });
      bridge.caller.run.workflowId = ctx.input.workflowId;
      await during(bridge, ctx, f);
    }
    return result('completed', 'Synthetic reply.');
  };
  t.mock.method(codexAdapter, 'execute', execute);
  t.mock.method(claudeAdapter, 'execute', execute);
  const project = await f.workspace.createProject(f.directory);
  const conversation = f.workspace.createConversation(project.id);
  if (kind) new ConversationActions(f.workspace).setWorkMode(conversation.id, kind);
  const sent = await f.workspace.send(conversation.id, { ...input, permissionMode, runtimeId: 'mock' });
  const flow = await finished(f.workspace, sent.workflow.id);
  assert.equal(flow.status, 'completed', flow.error ?? 'Synthetic navigator turn should complete');
  return { f, flow };
}

const names = async (bridge: Bridge) =>
  ((await bridge.list()).tools as { name: string; description: string }[]).map((tool) => tool.name);

test('the navigator gets plan, delegate, swarm and question tools, never tools that change things', async (t) => {
  let workflowReads = 0;
  await navigatorTurn(t, 'workspace-write', async (bridge, ctx, f) => {
    assert.equal(ctx.input.permissionMode, 'read-only');
    // Even if a grant said otherwise, the lead never sees file-changing tools.
    Object.assign(bridge.caller, { write: true, recycle: true });
    const get = f.workspace.store.get.bind(f.workspace.store);
    const spy = t.mock.method(f.workspace.store, 'get', (...args: Parameters<typeof get>) => {
      if (args[0] === 'workflow' && args[1] === ctx.input.workflowId) workflowReads++;
      return get(...args);
    });
    const listed = await names(bridge);
    spy.mock.restore();
    for (const name of [
      'delegate',
      'delegate_many',
      'get_result',
      'set_plan',
      'list_swarm',
      'ask_user',
      'read_document',
    ])
      assert.ok(listed.includes(name), name);
    for (const name of [
      'organize_files',
      'undo_organize',
      'recycle_files',
      'call_tool',
      'commit_branch',
      'push_branch',
    ])
      assert.equal(listed.includes(name), false, name);
    const delegate = ((await bridge.list()).tools as { name: string; description: string }[]).find(
      (tool) => tool.name === 'delegate',
    )!;
    assert.match(delegate.description, /give implementation sub-tasks write=true with files/);
    assert.match((await bridge.call('recycle_files', { paths: ['x'] })).content[0].text, /领航员不自己改动任何东西/);
  });
  // Other permission checks also read the workflow; this bound catches one extra read per listed tool.
  assert.ok(workflowReads > 0 && workflowReads < 20, `tool listing repeated workflow reads: ${workflowReads}`);
});

test('with the user’s write grant a child may write; in a read-only chat write=true is refused', async (t) => {
  let childId = '';
  const write = await navigatorTurn(t, 'workspace-write', async (_bridge, ctx, f) => {
    // What delegate write=true does once the bridge has checked it: the child is created under the user's grant.
    const created = await f.workspace.delegateToAgent(
      ctx.input.workflowId!,
      { label: '自动选择' },
      'Fix the synthetic parser',
      { write: true, files: ['parser.ts'], caller: 'Navigator' },
    );
    childId = created.workflow.id;
    await finished(f.workspace, childId);
  });
  const child = write.f.workspace.store.get<Workflow>('workflow', childId)!;
  assert.equal(child.delegation?.parentId, write.flow.id);
  assert.equal(child.input.permissionMode, 'workspace-write', 'the child writes under the user’s grant');
  await navigatorTurn(t, 'read-only', async (bridge) => {
    const tools = (await bridge.list()).tools as { name: string; description: string }[];
    assert.match(tools.find((tool) => tool.name === 'delegate')!.description, /write=true is refused/);
    const refused = await bridge.call('delegate', { task: 'Fix the synthetic parser', write: true });
    assert.match(refused.content[0].text, /这条对话只读，子任务不能改文件/);
  });
});

test('an ordinary chat keeps its tools: the filter is for the navigator lead only', async (t) => {
  await navigatorTurn(
    t,
    'workspace-write',
    async (bridge) => {
      Object.assign(bridge.caller, { write: true });
      assert.ok((await names(bridge)).includes('organize_files'));
    },
    null,
  );
});

test('a navigator turn plans, hands out a reading and a writing part, adds a reviewer, and the Swarm view has the tree', async (t) => {
  const ids: string[] = [];
  const { f, flow } = await navigatorTurn(t, 'workspace-write', async (bridge, ctx, f) => {
    const plan = await bridge.call('set_plan', {
      items: [
        { id: 'read', title: 'Read the parser', kind: 'read' },
        { id: 'fix', title: 'Fix the parser', kind: 'write' },
        { id: 'review', title: 'Review the fix', kind: 'read' },
      ],
    });
    assert.equal(plan.isError, undefined, plan.content?.[0]?.text);
    const parent = ctx.input.workflowId!;
    const parts: [string, { write?: boolean; files?: string[]; planItem: string }][] = [
      ['Read the synthetic parser', { planItem: 'read' }],
      ['Fix the synthetic parser', { write: true, files: ['parser.ts'], planItem: 'fix' }],
    ];
    for (const [task, options] of parts)
      ids.push((await f.workspace.delegateToAgent(parent, { label: '自动选择' }, task, options)).workflow.id);
    ids.push((await f.workspace.delegate(parent, 'reviewer', 'Review the parser fix', 'nav-review')).workflow.id);
    for (const id of ids) await finished(f.workspace, id);
  });
  const children = ids.map((id) => f.workspace.store.get<Workflow>('workflow', id)!);
  assert.deepEqual(
    children.map((child) => [child.delegation?.parentId, child.input.permissionMode]),
    [
      [flow.id, 'read-only'],
      [flow.id, 'workspace-write'],
      [flow.id, 'read-only'],
    ],
  );
  assert.deepEqual(
    flow.taskList?.items.map((item) => item.id) ??
      f.workspace.store.get<Workflow>('workflow', flow.id)!.taskList?.items.map((item) => item.id),
    ['read', 'fix', 'review'],
  );
  const snapshot = f.workspace.swarmSnapshot(flow.conversationId) as { workflows: { id: string }[] };
  for (const id of [flow.id, ...ids])
    assert.ok(
      snapshot.workflows.some((item) => item.id === id),
      `${id} in the Swarm view`,
    );
});
