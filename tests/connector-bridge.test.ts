import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { AgentBridge } from '../src/server/agent-bridge.ts';
import { ConnectorService } from '../src/server/connectors.ts';
import { extensions } from '../src/server/extensions.ts';
import { Controller } from '../src/server/controller.ts';
import type { Workspace } from '../src/server/workspace.ts';
import { WorkspaceStore } from '../src/server/workspace-store.ts';
import { codexAdapter } from '../src/server/adapters/codex.ts';
import type { ExecuteContext, RunEvent, RunRecord, RuntimeSnapshot, RuntimeTarget } from '../src/shared/types.ts';
import type { ConnectorCapability } from '../src/shared/connectors.ts';

const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
const rpc = (name: string, args: Record<string, unknown>) => ({
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: { name, arguments: args },
});
const result = (response: { body?: unknown }) => (response.body as any).result;
const errorText = (response: { body?: unknown }) => result(response).content[0].text as string;

test('deferred connector calls keep account scope and mandatory draft confirmation', async (t) => {
  const f = await fixture(t);
  Object.assign(f.caller, { deferredTools: true });
  f.conversation.connectorIds = [f.accounts[0].id];
  assert.ok(!(await f.list()).some((tool) => tool.name.startsWith('connector_')));
  const discovery = result(await f.call('search_tools', { names: ['connector_mail_create_draft'] }));
  assert.equal(JSON.parse(discovery.content[0].text).tools.length, 1);
  const args = {
    accountId: f.accounts[0].id,
    to: ['r@example.com'],
    subject: 'Synthetic',
    body: 'Complete draft text',
  };
  assert.equal(
    result(await f.call('call_tool', { name: 'connector_mail_create_draft', arguments: args })).isError,
    true,
  );
  assert.equal(f.approvals.length, 1);
  assert.equal(f.effects.length, 0);
  f.approve(async () => {
    f.conversation.connectorIds = [];
    return true;
  });
  assert.equal(
    result(await f.call('call_tool', { name: 'connector_mail_create_draft', arguments: args })).isError,
    true,
  );
  assert.equal(f.effects.length, 0);
  assert.ok(
    f.auditEvents.some(
      ({ event }) => event.data?.tool === 'connector_mail_create_draft' && event.data?.dispatchedVia === 'call_tool',
    ),
  );
});

test('office writes use the same mandatory confirmation and read-only boundary as email drafts', async (t) => {
  const f = await fixture(t, true, ['documents_write', 'calendar_write']);
  f.conversation.connectorIds = [f.accounts[0].id];
  const args = { accountAlias: '学校', title: 'Quarterly notes' };
  assert.equal(result(await f.call('connector_google_docs_create', args)).isError, true);
  assert.equal(f.effects.length, 0);
  assert.equal(f.approvals[0][4]?.requireUser, true);
  assert.equal(f.approvals[0][4]?.timeoutMs, 270_000);
  assert.match(String(f.approvals[0][2]), /Quarterly notes/);
  f.approve(async () => true);
  assert.equal(result(await f.call('connector_google_docs_create', args)).isError, undefined);
  assert.equal(f.effects.length, 1);
  f.caller.write = false;
  assert.equal(result(await f.call('connector_google_docs_create', args)).isError, true);
  assert.equal(f.effects.length, 1);
  assert.deepEqual(
    f.auditEvents.map(({ event }) => event.data?.status),
    ['inProgress', 'failed', 'inProgress', 'completed', 'inProgress', 'failed'],
  );
  assert.ok(f.auditEvents.every(({ runId, event }) => runId === 'run' && event.data?.hostAudit === true));
});

test('office confirmation shows normalized defaults and cannot proceed after reauthorization', async (t) => {
  const f = await fixture(t, true, ['calendar_write']);
  f.conversation.connectorIds = [f.accounts[0].id];
  const args = {
    accountId: f.accounts[0].id,
    summary: 'Review',
    interval: { type: 'allDay', start: '2026-10-10', end: '2026-10-11' },
  };
  f.approve(async () => {
    const start = await f.connectors.connect({
      provider: 'google',
      alias: '学校',
      accountId: f.accounts[0].id,
      capabilities: ['calendar_write'],
    });
    await f.connectors.completeOAuth({
      state: new URL(start.authorizationUrl).searchParams.get('state')!,
      code: 'test-code',
    });
    return true;
  });
  const response = await f.call('connector_google_calendar_event_create', args);
  assert.equal(result(response).isError, true);
  assert.match(errorText(response), /授权已变更/);
  assert.match(String(f.approvals[0][2]), /"sendUpdates": "all"/);
  assert.equal(f.effects.length, 0);
});

async function fixture(
  t: TestContext,
  write = true,
  capabilities: ConnectorCapability[] = ['mail_read', 'mail_draft'],
  connectorsOn = true,
) {
  const dir = await mkdtemp(join(tmpdir(), 'pugport-connector-bridge-'));
  const events = new EventEmitter();
  let ownedBridge: AgentBridge | undefined;
  t.after(async () => {
    await ownedBridge?.close();
    assert.equal(events.listenerCount('state'), 0, 'bridge close releases its controller subscription');
    assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep));
    assert.match(dir, /pugport-connector-bridge-/);
    await rm(dir, { recursive: true, force: true });
  });
  const effects: { url: string; body?: BodyInit | null }[] = [];
  const connectors = new ConnectorService({
    file: join(dir, 'credentials.json'),
    fetch: (async (url, init = {}) => {
      const path = String(url);
      if (path.endsWith('/token'))
        return json({
          access_token: 'SYNTHETIC_ACCESS',
          refresh_token: 'SYNTHETIC_REFRESH',
          token_type: 'Bearer',
          expires_in: 3600,
          scope:
            'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose https://www.googleapis.com/auth/documents https://www.googleapis.com/auth/calendar',
        });
      if (path.includes('/userinfo')) return json({ sub: 'synthetic-user', email: 'test@example.com' });
      effects.push({ url: path, body: init.body });
      if (path.endsWith('/drafts')) return json({ id: 'synthetic-draft', message: { id: 'synthetic-message' } });
      return json({ messages: [] });
    }) as typeof fetch,
  });
  await connectors.saveProviderConfig('google', { clientId: 'synthetic-client' });
  const accounts = [];
  for (const alias of ['学校', '个人']) {
    const start = await connectors.connect({ provider: 'google', alias, capabilities });
    accounts.push(
      await connectors.completeOAuth({
        state: new URL(start.authorizationUrl).searchParams.get('state')!,
        code: 'test-code',
      }),
    );
  }
  const conversation = {
    id: 'conversation',
    connectorIds: undefined as string[] | undefined,
    deletedAt: undefined as string | undefined,
  };
  const workflow = { id: 'workflow', conversationId: conversation.id, input: {} };
  const abort = new AbortController();
  const caller = {
    run: { id: 'run', workflowId: workflow.id },
    target: { provider: 'codex' },
    write,
    child: false,
    delegate: false,
    recycle: false,
    fiction: false,
    signal: abort.signal,
  };
  const approvals: Parameters<Controller['approve']>[] = [];
  const auditEvents: { runId: string; event: RunEvent }[] = [];
  let approve: () => Promise<boolean> = async () => false;
  const controller = Object.assign(events, {
    dataDir: join(dir, 'data'),
    recordRunEvent: (runId: string, event: RunEvent) => {
      const audited = structuredClone({ ...event, data: { ...event.data, hostAudit: true } });
      auditEvents.push({ runId, event: audited });
      events.emit('run', { runId, event: audited });
    },
    agentBridgeCaller: (token: string) => (token === 'fixture' ? caller : undefined),
    returnExecution: () => async () => {},
    retainMutation: () => () => {},
    approve: async (...args: Parameters<Controller['approve']>) => {
      approvals.push(args);
      return approve();
    },
  }) as unknown as Controller;
  const workspace = {
    store: {
      get: (kind: string, id: string) =>
        kind === 'workflow' && id === workflow.id
          ? workflow
          : kind === 'conversation' && id === conversation.id
            ? conversation
            : undefined,
    },
  } as unknown as Workspace;
  t.mock.method(extensions, 'bridgeTools', () => []);
  const bridge = new AgentBridge(workspace, controller, dir, {}, connectorsOn ? connectors : undefined);
  ownedBridge = bridge;
  assert.equal(events.listenerCount('state'), 1, 'the fixture provides the real controller event contract');
  return {
    bridge,
    connectors,
    accounts,
    conversation,
    effects,
    approvals,
    auditEvents,
    caller,
    controller,
    approve(fn: () => Promise<boolean>) {
      approve = fn;
    },
    call: (name: string, args: Record<string, unknown>) => bridge.handle('Bearer fixture', rpc(name, args)),
    list: async () =>
      result(await bridge.handle('Bearer fixture', { jsonrpc: '2.0', id: 1, method: 'tools/list' })).tools as any[],
  };
}

test('bridge exposes no connector by default and limits tool account enum to selected IDs', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.list()).filter((tool) => tool.name.startsWith('connector_')).length, 0);
  f.conversation.connectorIds = [f.accounts[0].id];
  const tools = (await f.list()).filter((tool) => tool.name.startsWith('connector_'));
  assert.equal(tools.length, 4);
  for (const tool of tools) assert.deepEqual(tool.inputSchema.properties.accountId.enum, [f.accounts[0].id]);
  assert.equal(tools.find((tool) => tool.name === 'connector_mail_read').annotations.readOnlyHint, true);
  assert.equal(tools.find((tool) => tool.name === 'connector_mail_create_draft').annotations.readOnlyHint, false);
  const denied = await f.call('connector_mail_search', { accountId: f.accounts[1].id });
  assert.equal(result(denied).isError, true);
  assert.match(errorText(denied), /没有选择/);
  assert.equal(f.effects.length, 0);
  const read = await f.call('connector_mail_search', { accountId: f.accounts[0].id });
  assert.equal(result(read).isError, undefined);
  assert.match(errorText(read), /仅作资料/);
  assert.equal(f.effects.length, 1);
});

test('bridge rechecks conversation selection and disabled account during a running task', async (t) => {
  const f = await fixture(t);
  f.conversation.connectorIds = [f.accounts[0].id];
  assert.ok((await f.list()).some((tool) => tool.name === 'connector_mail_read'));
  f.conversation.connectorIds = [];
  assert.equal(result(await f.call('connector_mail_search', { accountId: f.accounts[0].id })).isError, true);
  f.conversation.connectorIds = [f.accounts[0].id];
  await f.connectors.update(f.accounts[0].id, { enabled: false });
  assert.equal(result(await f.call('connector_mail_search', { accountId: f.accounts[0].id })).isError, true);
  assert.equal(f.effects.length, 0);
  await f.connectors.update(f.accounts[0].id, { enabled: true });
  f.conversation.deletedAt = new Date().toISOString();
  assert.equal((await f.list()).filter((tool) => tool.name.startsWith('connector_')).length, 0);
});

test('readonly sessions hide and deny draft tools without asking approval', async (t) => {
  const f = await fixture(t, false);
  f.conversation.connectorIds = [f.accounts[0].id];
  assert.ok(!(await f.list()).some((tool) => tool.name === 'connector_mail_create_draft'));
  const reply = await f.call('connector_mail_create_draft', {
    accountId: f.accounts[0].id,
    to: ['r@example.com'],
    subject: '主题',
    body: '内容',
  });
  assert.equal(result(reply).isError, true);
  assert.equal(f.approvals.length, 0);
  assert.equal(f.effects.length, 0);
});

test('draft approval is explicitly required; denial never reaches provider and approval creates only a draft', async (t) => {
  const f = await fixture(t);
  f.conversation.connectorIds = [f.accounts[0].id];
  const args = { accountId: f.accounts[0].id, to: ['r@example.com'], subject: '主题', body: '待确认的完整正文' };
  const denied = await f.call('connector_mail_create_draft', args);
  assert.equal(result(denied).isError, true);
  assert.match(errorText(denied), /未同意/);
  assert.equal(f.approvals[0][4]?.requireUser, true);
  assert.equal(f.approvals[0][4]?.timeoutMs, 270_000);
  assert.match(String(f.approvals[0][2]), /待确认的完整正文/);
  assert.match(String(f.approvals[0][2]), /学校/);
  assert.equal(f.effects.length, 0);
  f.approve(async () => true);
  const approved = await f.call('connector_mail_create_draft', args);
  assert.equal(result(approved).isError, undefined);
  assert.equal(f.effects.length, 1);
  assert.ok(f.effects[0].url.endsWith('/drafts'));
  assert.ok(!f.effects[0].url.includes('/send'));
});

test('draft selection revoked while awaiting approval cannot write after approval', async (t) => {
  const f = await fixture(t);
  f.conversation.connectorIds = [f.accounts[0].id];
  f.approve(async () => {
    f.conversation.connectorIds = [];
    return true;
  });
  const reply = await f.call('connector_mail_create_draft', {
    accountId: f.accounts[0].id,
    to: ['r@example.com'],
    subject: '主题',
    body: '内容',
  });
  assert.equal(result(reply).isError, true);
  assert.equal(f.effects.length, 0);
});

test('named mailbox draft approval identifies the real account and cannot retarget after a rename', async (t) => {
  const f = await fixture(t);
  f.conversation.connectorIds = f.accounts.map((account) => account.id);
  f.approve(async () => true);
  const args = { accountAlias: '学校', to: ['r@example.com'], subject: '主题', body: '内容' };
  const approved = await f.call('connector_mail_create_draft', args);
  assert.equal(result(approved).isError, undefined);
  assert.match(String(f.approvals[0][2]), /学校 \(test@example.com\)/);
  assert.ok(String(f.approvals[0][2]).includes(f.accounts[0].id));
  assert.ok(!String(f.approvals[0][2]).includes(f.accounts[1].id));
  assert.equal(f.effects.length, 1);
  f.approve(async () => {
    await f.connectors.update(f.accounts[0].id, { alias: '原学校' });
    await f.connectors.update(f.accounts[1].id, { alias: '学校' });
    return true;
  });
  const renamed = await f.call('connector_mail_create_draft', args);
  assert.equal(result(renamed).isError, true);
  assert.match(errorText(renamed), /不一致/);
  assert.equal(f.effects.length, 1, 'a newly renamed account must not inherit approval for the old account');
});

test('draft exceeding approval preview limit is rejected before asking or writing', async (t) => {
  const f = await fixture(t);
  f.conversation.connectorIds = [f.accounts[0].id];
  const reply = await f.call('connector_mail_create_draft', {
    accountId: f.accounts[0].id,
    to: ['r@example.com'],
    subject: '主题',
    body: 'a'.repeat(18001),
  });
  assert.equal(result(reply).isError, true);
  assert.match(errorText(reply), /过长/);
  assert.equal(f.approvals.length, 0);
  assert.equal(f.effects.length, 0);
});

test('approval freezes original draft and releases mutation lease after provider call', async (t) => {
  const f = await fixture(t);
  f.conversation.connectorIds = [f.accounts[0].id];
  const args = {
    accountId: f.accounts[0].id,
    to: ['original@example.com'],
    subject: '主题',
    body: 'Approved original body',
  };
  let retained = 0,
    released = 0;
  t.mock.method(f.controller, 'retainMutation', () => {
    retained++;
    return () => {
      released++;
    };
  });
  f.approve(async () => {
    args.to = ['changed@example.com'];
    args.body = 'Changed after preview';
    return true;
  });
  const response = await f.call('connector_mail_create_draft', args);
  assert.equal(result(response).isError, undefined);
  assert.equal(retained, 1);
  assert.equal(released, 1);
  const message = JSON.parse(String(f.effects[0].body)).message;
  const mime = Buffer.from(message.raw, 'base64url').toString('utf8');
  assert.match(mime, /original@example.com/);
  assert.ok(!mime.includes('changed@example.com'));
  assert.equal(Buffer.from(mime.split('\r\n\r\n')[1], 'base64').toString('utf8'), 'Approved original body');
});

test('a yielded writer cannot create draft even when approval was accepted', async (t) => {
  const f = await fixture(t);
  f.conversation.connectorIds = [f.accounts[0].id];
  f.approve(async () => true);
  t.mock.method(f.controller, 'retainMutation', () => {
    throw new Error('当前任务正在等待子任务，写入位置已释放。');
  });
  const response = await f.call('connector_mail_create_draft', {
    accountId: f.accounts[0].id,
    to: ['r@example.com'],
    subject: '主题',
    body: '内容',
  });
  assert.equal(result(response).isError, true);
  assert.match(errorText(response), /等待子任务/);
  assert.equal(f.effects.length, 0);
});

test('changing connector selection starts fresh native session while unchanged selection can resume', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'pugport-connector-session-'));
  const controller = new Controller(dir, join(dir, 'data'));
  clearInterval(controller.timer);
  t.after(async () => {
    await controller.close();
    assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep));
    assert.match(dir, /pugport-connector-session-/);
    await rm(dir, { recursive: true, force: true });
  });
  const target: RuntimeTarget = {
    id: 'codex-fixture',
    provider: 'codex',
    label: 'Fixture',
    environment: 'native',
    enabled: true,
    command: 'unused',
  };
  const snapshot: RuntimeSnapshot = {
    ...target,
    installed: true,
    status: 'ready',
    accountFingerprint: 'synthetic-account',
    models: [{ id: 'test-model', label: 'Test', efforts: ['high'] }],
    quota: {
      status: 'known',
      source: 'fixture',
      observedAt: new Date().toISOString(),
      windows: [{ id: 'week', label: 'week', usedPercent: 10, resetsAt: new Date(Date.now() + 3600000).toISOString() }],
    },
    capabilities: { execute: true, resume: true, cancel: true, approvals: true },
    refreshedAt: new Date().toISOString(),
  };
  controller.targets = [target];
  controller.snapshots = [snapshot];
  t.mock.method(codexAdapter, 'discover', async () => snapshot);
  const calls: ExecuteContext[] = [];
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    calls.push(ctx);
    return { output: 'done', nativeSessionId: ctx.nativeSessionId ?? 'synthetic-session-' + calls.length };
  });
  const store = new WorkspaceStore(controller.store.db, { recoverInterrupted: false });
  for (const id of ['one', 'two', 'three'])
    store.save('workflow', id, 'same-conversation', { projectId: 'same-project' });
  const input = {
    prompt: 'Full conversation context',
    projectPath: dir,
    kind: 'general' as const,
    permissionMode: 'read-only' as const,
    connectorRevision: 'selection-one',
  };
  const finish = async (id: string) => {
    for (let i = 0; i < 300 && controller.active.has(id); i++)
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    assert.ok(!controller.active.has(id), 'mock execution must complete');
  };
  const first = await controller.start({ ...input, workflowId: 'one' });
  await finish(first.id);
  const unchanged = await controller.start({
    ...input,
    workflowId: 'two',
    continuationRunId: first.id,
    continuationPrompt: 'Compact next turn',
  });
  await finish(unchanged.id);
  assert.equal(calls[1].nativeSessionId, 'synthetic-session-1');
  assert.equal(calls[1].input.prompt, 'Compact next turn');
  const changed = await controller.start({
    ...input,
    connectorRevision: 'selection-two',
    workflowId: 'three',
    continuationRunId: unchanged.id,
    continuationPrompt: 'Must not use old tool context',
  });
  await finish(changed.id);
  assert.equal(calls[2].nativeSessionId, undefined);
  assert.equal(calls[2].input.prompt, input.prompt);
  assert.equal(changed.parentRunId, undefined);
  assert.equal(changed.connectorRevision, 'selection-two');
});

test('real controller requires a user decision for drafts even in auto mode while ordinary escalation stays denied', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'pugport-connector-approval-'));
  const controller = new Controller(dir, join(dir, 'data'));
  clearInterval(controller.timer);
  const abort = new AbortController();
  t.after(async () => {
    abort.abort();
    await controller.close();
    assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep));
    assert.match(dir, /pugport-connector-approval-/);
    await rm(dir, { recursive: true, force: true });
  });
  const run: RunRecord = {
    id: 'synthetic-run',
    projectPath: dir,
    prompt: 'Create a draft',
    kind: 'general',
    status: 'running',
    toolApprovalMode: 'auto',
    permissionMode: 'workspace-write',
    output: '',
    events: [],
    route: { runtimeId: 'synthetic-runtime', model: 'fixture', kind: 'general', reasons: [], warnings: [] },
    startedAt: new Date().toISOString(),
  };
  assert.equal(await controller.approve(run, 'Unexpected escalation', 'Operation', abort.signal), false);
  assert.equal(controller.approvals.size, 0);
  assert.equal(run.status, 'running');
  for (const allow of [false, true]) {
    let settled = false;
    const pending = controller
      .approve(run, '创建邮件草稿', 'Recipient and full draft body', abort.signal, { requireUser: true })
      .then((value) => {
        settled = true;
        return value;
      });
    await new Promise<void>((done) => setImmediate(done));
    assert.equal(settled, false, 'requireUser must wait instead of inheriting auto permission');
    assert.equal(run.status, 'waiting-approval');
    assert.equal(controller.approvals.size, 1);
    const approval = controller.state().approvals.find((item) => item.runId === run.id)!;
    assert.ok(approval, 'approval must be exposed in the UI state');
    assert.equal(approval.tool, '创建邮件草稿');
    assert.equal(approval.description, 'Recipient and full draft body');
    assert.equal(approval.key, undefined);
    assert.throws(() => controller.answerApproval(approval.id, true, true), /不能保存/);
    controller.answerApproval(approval.id, allow);
    assert.equal(await pending, allow);
    assert.equal(controller.approvals.size, 0);
    assert.equal(run.status, 'running');
  }
});

for (const timeoutMs of [25, undefined])
  test(`controller approval expires at ${timeoutMs ?? 600_000} ms`, async (t) => {
    const events: RunEvent[] = [];
    const controller = Object.assign(Object.create(Controller.prototype), {
      targets: [],
      approvals: new Map(),
      closed: false,
      store: { saveRun: () => {} },
      recordRunEvent: (_id: string, event: RunEvent) => events.push(event),
      broadcast: () => {},
    }) as Controller;
    const run = { id: 'synthetic', status: 'running', route: { runtimeId: 'synthetic' } } as RunRecord;
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let expired = false;
    let settled = false;
    const pending = controller
      .approve(run, 'Fixture', 'Synthetic', new AbortController().signal, {
        timeoutMs,
        onExpired: () => {
          expired = true;
        },
      })
      .then((value) => {
        settled = true;
        return value;
      });
    const id = [...controller.approvals.keys()][0];
    t.mock.timers.tick((timeoutMs ?? 600_000) - 1);
    await Promise.resolve();
    assert.equal(settled, false);
    assert.equal(expired, false);
    t.mock.timers.tick(1);
    await Promise.resolve();
    assert.equal(settled, true);
    assert.equal(await pending, false);
    assert.equal(expired, true);
    assert.equal(events.at(-1)?.data?.status, 'expired');
    assert.equal(controller.approvals.size, 0);
    assert.equal(run.status, 'running');
    assert.throws(() => controller.answerApproval(id, true), /审批已失效/);
  });

test('connector confirmation expiry never writes', async (t) => {
  const f = await fixture(t, true, ['mail_read', 'mail_draft']);
  f.conversation.connectorIds = [f.accounts[0].id];
  f.approve(async () => {
    const options = f.approvals.at(-1)![4]!;
    assert.equal(options.timeoutMs, 270_000);
    options.onExpired!();
    return false;
  });
  const response = await f.call('connector_mail_create_draft', {
    accountId: f.accounts[0].id,
    to: ['synthetic@example.test'],
    subject: 'Fixture',
    body: 'Synthetic',
  });
  assert.equal(result(response).isError, true);
  assert.match(errorText(response), /4\.5 分钟内无人确认，未执行任何连接器写入/);
  assert.equal(f.effects.length, 0);
});

test('disabled connectors offer no tools and reject stale calls even with selected accounts', async (t) => {
  const f = await fixture(t, true, ['mail_read', 'mail_draft'], false);
  f.conversation.connectorIds = [f.accounts[0].id];
  assert.equal(
    (await f.list()).some((tool) => tool.name.startsWith('connector_')),
    false,
  );
  const response = await f.call('connector_mail_search', { accountId: f.accounts[0].id });
  assert.equal(result(response).isError, true);
  assert.match(errorText(response), /连接器尚未启用/);
  assert.equal(f.effects.length, 0);
});
