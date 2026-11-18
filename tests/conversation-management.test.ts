import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentBridge } from '../src/server/agent-bridge.ts';
import { Workspace } from '../src/server/workspace.ts';
import { WorkspaceStore } from '../src/server/workspace-store.ts';
import { extensions } from '../src/server/extensions.ts';
import { Controller } from '../src/server/controller.ts';
import type { Conversation, ConversationMessage, Workflow, RunEvent, RunRecord } from '../src/shared/types.ts';

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'pugport-conversation-management-'));
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE runs(id TEXT PRIMARY KEY, started_at TEXT NOT NULL, value TEXT NOT NULL)');
  const store = new WorkspaceStore(db);
  const stamp = new Date().toISOString();
  const projectId = randomUUID();
  const otherProject = randomUUID();
  store.save('project', projectId, projectId, { id: projectId, name: 'First project' });
  store.save('project', otherProject, otherProject, { id: otherProject, name: 'Other project' });
  const add = (title: string, project = otherProject, extra: Partial<Conversation> = {}) => {
    const conversation: Conversation = {
      id: randomUUID(),
      projectId: project,
      title,
      createdAt: stamp,
      updatedAt: stamp,
      ...extra,
    };
    store.save('conversation', conversation.id, project, conversation);
    return conversation;
  };
  const owner = add('Current conversation', projectId);
  const target = add('Synthetic target');
  const workflow = {
    id: randomUUID(),
    conversationId: owner.id,
    projectId,
    userMessageId: randomUUID(),
    status: 'running',
    input: { permissionMode: 'workspace-write', permissionOrigin: { source: 'user' } },
    runIds: [],
  } as unknown as Workflow;
  const message: ConversationMessage = {
    id: workflow.userMessageId,
    conversationId: owner.id,
    role: 'user',
    content: 'Manage my synthetic conversations',
    createdAt: stamp,
    workflowId: workflow.id,
  };
  store.save('workflow', workflow.id, owner.id, workflow);
  store.save('message', message.id, owner.id, message);
  store.save('message', randomUUID(), target.id, { role: 'user', content: 'PRIVATE BODY MUST NOT LEAK' });
  const abort = new AbortController();
  const run = {
    id: randomUUID(),
    workflowId: workflow.id,
    permissionMode: 'workspace-write',
    permissionOrigin: { source: 'user' },
    status: 'running',
  } as RunRecord;
  workflow.runIds = [run.id];
  store.save('workflow', workflow.id, owner.id, workflow);
  const caller = {
    run,
    target: { provider: 'claude' },
    write: true,
    child: false,
    delegate: true,
    recycle: false,
    deferredTools: true,
    signal: abort.signal,
  };
  const state = {
    allow: true,
    onApprove: async () => {},
    approvals: [] as { title: string; description: string; options: any }[],
    leases: 0,
  };
  const events: RunEvent[] = [];
  const controller = Object.assign(new EventEmitter(), {
    dataDir: directory,
    agentBridgeCaller: () => caller,
    recordRunEvent: (_id: string, event: RunEvent) => events.push(event),
    returnExecution: () => async () => {},
    retainMutation: () => {
      state.leases++;
      return () => {
        state.leases--;
      };
    },
    approve: async (_run: RunRecord, title: string, description: string, _signal: AbortSignal, options: unknown) => {
      state.approvals.push({ title, description, options });
      await state.onApprove();
      return state.allow;
    },
  }) as unknown as Controller;
  const workspace = Object.assign(Object.create(Workspace.prototype), {
    store,
    controller,
    refreshMemories() {},
    publish() {},
    takeNotices: () => [],
  }) as Workspace;
  t.mock.method(extensions, 'bridgeTools', () => []);
  const bridge = new AgentBridge(workspace, controller);
  t.after(async () => {
    await bridge.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const rpc = async (method: string, params?: object) =>
    (await bridge.handle('Bearer synthetic', { jsonrpc: '2.0', id: 1, method, params })).body as any;
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await rpc('tools/call', { name, arguments: args })).result;
  const manage = (ids = [target.id], action = 'delete') =>
    call('manage_conversations', { conversation_ids: ids, action });
  return {
    db,
    store,
    controller,
    workspace,
    caller,
    workflow,
    message,
    owner,
    target,
    add,
    abort,
    state,
    events,
    rpc,
    call,
    manage,
  };
}

test('local owner discovers conversation metadata through the real bridge catalog and search proxy', async (t) => {
  const f = fixture(t);
  const tools = (await f.rpc('tools/list')).result.tools;
  assert.ok(tools.some((tool: any) => tool.name === 'list_conversations'));
  const search = await f.call('search_tools', { query: 'sidebar conversations', limit: 10 });
  assert.ok(JSON.parse(search.content[0].text).tools.some((tool: any) => tool.name === 'list_conversations'));
  const result = await f.call('call_read_only_tool', { name: 'list_conversations', arguments: {} });
  assert.equal(result.isError, undefined);
  const listed = JSON.parse(result.content[0].text);
  assert.ok(listed.timeZone);
  assert.ok(listed.now.endsWith('Z'));
  assert.ok(listed.conversations.some((item: any) => item.id === f.target.id && item.project.name === 'Other project'));
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE BODY/);
});

test('approved exact cross-project batch uses soft deletion, remains recoverable and is audited', async (t) => {
  const f = fixture(t);
  const result = await f.manage();
  assert.equal(result.isError, undefined, result.content?.[0]?.text);
  assert.equal(f.state.approvals.length, 1);
  assert.equal(f.state.approvals[0].options.requireUser, true);
  assert.ok(f.state.approvals[0].description.includes(f.target.id));
  assert.ok(f.state.approvals[0].description.includes(f.target.title));
  assert.ok(f.store.get<Conversation>('conversation', f.target.id)?.deletedAt);
  f.workspace.restoreConversation(f.target.id);
  assert.equal(f.store.get<Conversation>('conversation', f.target.id)?.deletedAt, undefined);
  assert.equal(f.state.leases, 0);
  assert.equal(f.events.filter((event) => event.data?.kind === 'pugportToolCall').length, 2);
});

test('archive through call_tool retains history and holds the mutation lease until approval finishes', async (t) => {
  const f = fixture(t);
  f.state.onApprove = async () => {
    assert.equal(f.state.leases, 1);
  };
  const result = await f.call('call_tool', {
    name: 'manage_conversations',
    arguments: { action: 'archive', conversation_ids: [f.target.id] },
  });
  assert.equal(result.isError, undefined, result.content[0]?.text);
  const saved = f.store.get<Conversation>('conversation', f.target.id)!;
  assert.ok(saved.archivedAt);
  assert.equal(saved.deletedAt, undefined);
  assert.equal(f.state.leases, 0);
  assert.equal(f.events.find((event) => event.data?.kind === 'pugportToolCall')?.data?.dispatchedVia, 'call_tool');
});

for (const restricted of [
  'child',
  'external-origin',
  'external-owner',
  'no-owner',
  'wrong-message',
  'incognito',
  'third-party',
  'device',
  'missing-run',
] as const)
  test(`${restricted} cannot list, discover or directly invoke conversation management`, async (t) => {
    const f = fixture(t);
    if (restricted === 'child') f.caller.child = true;
    if (restricted === 'external-origin')
      f.workflow.input.permissionOrigin = { mode: 'workspace-write', source: 'caller' };
    if (restricted === 'external-owner')
      f.store.save('external-conversation', f.owner.id, f.owner.id, { caller: 'synthetic' });
    if (restricted === 'no-owner') f.workflow.userMessageId = randomUUID();
    if (restricted === 'wrong-message') f.message.conversationId = f.target.id;
    if (restricted === 'incognito') f.owner.incognito = true;
    if (restricted === 'third-party') f.message.untrustedContent = true;
    if (restricted === 'device') f.workflow.input.deviceId = 'synthetic-device';
    if (restricted === 'missing-run') f.workflow.runIds = [];
    f.store.save('workflow', f.workflow.id, f.owner.id, f.workflow);
    f.store.save('message', f.message.id, f.owner.id, f.message);
    f.store.save('conversation', f.owner.id, f.owner.projectId, f.owner);
    const tools = (await f.rpc('tools/list')).result.tools;
    assert.ok(!tools.some((tool: any) => ['list_conversations', 'manage_conversations'].includes(tool.name)));
    const search = await f.call('search_tools', { names: ['list_conversations', 'manage_conversations'] });
    assert.equal(JSON.parse(search.content[0].text).total, 0);
    assert.equal((await f.call('list_conversations')).isError, true);
    assert.equal((await f.manage()).isError, true);
    assert.equal(f.state.approvals.length, 0);
    assert.equal(f.store.get<Conversation>('conversation', f.target.id)?.deletedAt, undefined);
  });

test('read-only owner can list metadata but cannot mutate through either tool entry', async (t) => {
  const f = fixture(t);
  f.caller.write = false;
  f.caller.run.permissionMode = 'read-only';
  assert.equal((await f.call('list_conversations')).isError, undefined);
  assert.equal((await f.manage()).isError, true);
  assert.equal(
    (
      await f.call('call_read_only_tool', {
        name: 'manage_conversations',
        arguments: { action: 'delete', conversation_ids: [f.target.id] },
      })
    ).isError,
    true,
  );
  assert.equal(f.state.approvals.length, 0);
  assert.equal(f.store.get<Conversation>('conversation', f.target.id)?.deletedAt, undefined);
});

for (const blocked of ['current', 'active', 'incognito', 'deleted', 'duplicate'] as const)
  test(`${blocked} target rejects the entire batch before approval`, async (t) => {
    const f = fixture(t);
    const second = f.add('Second synthetic target');
    if (blocked === 'active') f.store.save('workflow', randomUUID(), f.target.id, { status: 'running' });
    if (blocked === 'incognito') f.target.incognito = true;
    if (blocked === 'deleted') f.target.deletedAt = new Date().toISOString();
    f.store.save('conversation', f.target.id, f.target.projectId, f.target);
    const ids = [second.id, blocked === 'current' ? f.owner.id : f.target.id];
    if (blocked === 'duplicate') ids.push(second.id);
    assert.equal((await f.manage(ids)).isError, true);
    assert.equal(f.state.approvals.length, 0);
    assert.equal(f.store.get<Conversation>('conversation', second.id)?.deletedAt, undefined);
  });

for (const duringApproval of [
  'denied',
  'cancelled',
  'changed',
  'project-renamed',
  'started',
  'permission-revoked',
  'error',
] as const)
  test(`${duringApproval} approval performs zero writes and releases its lease`, async (t) => {
    const f = fixture(t);
    const second = f.add('Second synthetic target');
    f.state.onApprove = async () => {
      assert.equal(f.state.approvals[0].options.timeoutMs, 120000);
      if (duringApproval === 'denied') f.state.allow = false;
      if (duringApproval === 'cancelled') f.abort.abort();
      if (duringApproval === 'changed')
        f.store.save('conversation', f.target.id, f.target.projectId, {
          ...f.target,
          title: 'Changed after approval was shown',
        });
      if (duringApproval === 'project-renamed')
        f.store.save('project', f.target.projectId, f.target.projectId, {
          id: f.target.projectId,
          name: 'Changed project',
        });
      if (duringApproval === 'started') f.store.save('workflow', randomUUID(), f.target.id, { status: 'queued' });
      if (duringApproval === 'permission-revoked') f.caller.write = false;
      if (duringApproval === 'error') throw new Error('Synthetic approval failure');
    };
    assert.equal((await f.manage([second.id, f.target.id])).isError, true);
    for (const id of [second.id, f.target.id])
      assert.equal(f.store.get<Conversation>('conversation', id)?.deletedAt, undefined);
    assert.equal(f.state.leases, 0);
  });

test('metadata pagination excludes incognito and never returns messages or private paths', async (t) => {
  const f = fixture(t);
  f.add('Hidden', undefined, { incognito: true });
  const result = JSON.parse((await f.call('list_conversations', { limit: 1 })).content[0].text);
  assert.equal(result.total, 2);
  assert.equal(result.nextOffset, 1);
  assert.equal(result.conversations.length, 1);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE BODY|Hidden|path|content/);
});

test('the existing controller approval deadline expires with zero writes', async (t) => {
  const f = fixture(t);
  Object.assign(f.controller, { targets: [], approvals: new Map(), store: { saveRun() {} }, broadcast() {} });
  f.controller.approve = Controller.prototype.approve.bind(f.controller);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = f.manage();
  assert.equal(f.controller.approvals.size, 1);
  t.mock.timers.tick(120000);
  const result = await pending;
  assert.equal(result.isError, true);
  assert.equal(f.controller.approvals.size, 0);
  assert.equal(f.store.get<Conversation>('conversation', f.target.id)?.deletedAt, undefined);
  assert.equal(f.state.leases, 0);
  assert.ok(f.events.some((event) => event.type === 'approval' && event.data?.status === 'expired'));
});
