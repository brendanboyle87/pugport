import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { Workspace } from '../src/server/workspace.ts';
import { WorkspaceStore } from '../src/server/workspace-store.ts';
import { Store } from '../src/server/store.ts';
import { AgentBridge } from '../src/server/agent-bridge.ts';
import { Controller } from '../src/server/controller.ts';
import { codexAdapter } from '../src/server/adapters/codex.ts';
import { route } from '../src/server/routing.ts';
import { managedAgentLimits, swarmAgents, swarmLimits, type SwarmMessage } from '../src/shared/swarm.ts';
import type {
  ExecuteContext,
  MessageInput,
  RunInput,
  RunRecord,
  RuntimeSnapshot,
  Settings,
  Workflow,
} from '../src/shared/types.ts';

function task(id: string, parentId?: string, overrides: Partial<Workflow> = {}): Workflow {
  return {
    id,
    projectId: 'project',
    conversationId: 'conversation',
    userMessageId: `message-${id}`,
    input: {
      swarm: true,
      content: `Original request ${id}`,
      intentText: `Intent ${id}`,
      mode: 'build',
      permissionMode: 'workspace-write',
      runtimeId: 'pi-api',
      model: 'parent-model',
      effort: 'high',
      executionPolicy: 'cli-first',
    },
    status: 'running',
    phase: 'execute',
    runIds: [`run-${id}`],
    plan: [],
    memoryRevision: 0,
    memoryExcerpt: '',
    createdAt: '2026-10-09T00:00:00Z',
    updatedAt: '2026-10-09T00:00:00Z',
    ...(parentId ? { delegation: { parentId, role: 'worker', requestId: id, scope: ['src/child'] } } : {}),
    ...overrides,
  };
}

function fixture(t: TestContext, records = [task('root'), task('child', 'root')], db = new DatabaseSync(':memory:')) {
  t.after(() => {
    if (db.isOpen) db.close();
  });
  const store = new WorkspaceStore(db, { recoverInterrupted: false });
  store.save('project', 'project', '', { id: 'project', path: 'C:/synthetic/swarm' });
  store.save('conversation', 'conversation', 'project', { id: 'conversation', projectId: 'project', swarm: true });
  for (const workflow of records) store.save('workflow', workflow.id, workflow.conversationId, workflow);
  const events: { runId: string; event: unknown }[] = [];
  const runs = new Map<string, RunRecord>();
  const running = new Map(
    records.filter((workflow) => workflow.status === 'running').map((workflow) => [workflow.id, `run-${workflow.id}`]),
  );
  const active = new Map(
    records
      .filter((workflow) => workflow.status === 'running')
      .map((workflow) => [workflow.id, { abort: new AbortController(), pendingStart: false, workflow }]),
  );
  const steered: string[] = [];
  const captured: MessageInput[] = [];
  const controller = {
    targets: [
      {
        id: 'pi-api',
        provider: 'pi',
        label: 'API Pi',
        enabled: true,
        environment: 'native',
        command: 'unused',
        gateway: 'api',
      },
    ],
    snapshots: [],
    settings: {},
    activeRunFor: (id: string) => running.get(id),
    recordRunEvent: (runId: string, event: unknown) => events.push({ runId, event }),
    broadcast: () => {},
    steerInterrupts: () => false,
    steer: async (_id: string, prompt: string) => {
      steered.push(prompt);
      return true;
    },
    run: (id: string) => runs.get(id),
    runWithAudit: (id: string) => runs.get(id),
    shown: (run: RunRecord) => run,
  };
  const workspace = Object.create(Workspace.prototype) as Workspace;
  Object.assign(workspace, {
    store,
    controller,
    active,
    notices: new Map(),
    queuedSteers: new Map(),
    refreshWaits: new Map(),
    clock: () => Date.parse('2026-10-09T02:00:00Z'),
    requireConversation: (id: string) => store.get('conversation', id),
    requireProject: (id: string) => store.get('project', id),
    wake: () => {},
    send: async (
      conversationId: string,
      input: MessageInput,
      previous?: string,
      delegation?: Workflow['delegation'],
      options?: { userMessage?: { content: string; resumed?: true } },
    ) => {
      captured.push(input);
      const existing = store
        .conversationWorkflows(conversationId)
        .find((workflow) => previous && workflow.parentWorkflowId === previous);
      if (existing) return { workflow: existing };
      const workflow = task(`created-${captured.length}`, delegation?.parentId, {
        input,
        status: 'queued',
        runIds: [],
        parentWorkflowId: previous,
        delegation,
        createdAt: '2026-10-09T02:00:00Z',
      });
      store.save('workflow', workflow.id, conversationId, workflow);
      const message = store.addMessage(
        conversationId,
        'user',
        options?.userMessage?.content ?? input.content,
        workflow.id,
      );
      if (options?.userMessage?.resumed) message.resumed = true;
      store.save('message', message.id, conversationId, message);
      workflow.userMessageId = message.id;
      store.save('workflow', workflow.id, conversationId, workflow);
      return { workflow, message };
    },
  });
  return { workspace, store, controller, running, active, events, runs, steered, captured };
}

for (const policy of ['cli-only', 'api-only', 'cli-first', undefined] as const) {
  test(`automatic swarm delegation retains execution channel ${policy ?? '(default)'}`, async (t) => {
    const root = task('root');
    if (policy) root.input.executionPolicy = policy;
    else Reflect.deleteProperty(root.input, 'executionPolicy');
    const f = fixture(t, [root]);
    const { workflow: child } = await f.workspace.delegateToAgent(
      'root',
      { label: 'Automatic' },
      'Read a file and summarize',
    );
    const input = f.store.get<Workflow>('workflow', child.id)!.input;
    assert.equal(input.executionPolicy, policy ?? 'cli-first');
    assert.equal(input.runtimeId, undefined);
    assert.equal(input.provider, undefined);
    const now = Date.parse('2026-10-16T00:00:00Z');
    const runtime = (provider: 'codex' | 'pi'): RuntimeSnapshot => ({
      id: provider,
      provider,
      label: provider,
      environment: 'native',
      installed: true,
      status: 'ready',
      models: [{ id: 'gpt-6-sol', label: 'Synthetic', efforts: ['low', 'medium', 'high'] }],
      capabilities: { execute: true, resume: true, cancel: true, approvals: false },
      quota: {
        status: 'known',
        source: 'Synthetic',
        observedAt: new Date(now).toISOString(),
        windows: [{ id: 'week', label: 'Week', usedPercent: 0, resetsAt: new Date(now + 86400000).toISOString() }],
      },
      refreshedAt: new Date(now).toISOString(),
      ...(provider === 'pi' ? { accounting: { mode: 'usage', source: 'Synthetic' } } : {}),
    });
    const config: Settings = {
      refreshSeconds: 60,
      reservePercent: 10,
      maxQuotaAgeSeconds: 180,
      preferCli: true,
      designProvider: 'claude',
      architectureProvider: 'codex',
      routineProvider: 'codex',
      unknownQuotaPolicy: 'manual-only',
      defaultProjectPath: 'C:/synthetic',
      maxConcurrentRuns: 0,
    };
    const run: RunInput = {
      prompt: input.content,
      projectPath: 'C:/synthetic',
      kind: 'general',
      agentChild: true,
      executionPolicy: input.executionPolicy,
    };
    const cli = runtime('codex'),
      api = runtime('pi');
    assert.equal(route(run, [cli, api], config, undefined, now).runtimeId, policy === 'api-only' ? api.id : cli.id);
    if (policy === 'cli-only' || policy === 'api-only')
      assert.throws(() => route(run, [policy === 'cli-only' ? api : cli], config, undefined, now));
  });
}

test('swarm and ordinary nested delegation retain independent effort and cannot widen inherited file scope', async (t) => {
  const f = fixture(t);
  const agent = { provider: 'pi' as const, runtimeId: 'pi-api', label: 'API Pi' };
  await f.workspace.delegateToAgent('child', agent, 'Review a function', { write: false, effort: 'low' });
  assert.equal(f.captured[0]!.swarm, true);
  assert.equal(f.captured[0]!.runtimeId, 'pi-api');
  assert.equal(f.captured[0]!.model, undefined);
  // The caller's effort is a suggestion for automatic selection, never a pin on the child.
  assert.equal(f.captured[0]!.effort, undefined);
  assert.equal(f.store.get<Workflow>('workflow', 'created-1')!.delegation!.suggestedEffort, 'low');
  assert.equal(f.captured[0]!.permissionMode, 'read-only');
  await assert.rejects(
    f.workspace.delegateToAgent('child', agent, 'Edit outside', { write: true, files: ['src/outside.ts'] }),
    /不能扩大/,
  );
  await f.workspace.delegateToAgent('child', agent, 'Edit inside', { write: true, files: ['src/child/index.ts'] });
  assert.equal(f.captured.at(-1)!.effort, undefined);
  const child = f.store.get<Workflow>('workflow', 'child')!;
  child.input.swarm = false;
  f.store.save('workflow', child.id, child.conversationId, child);
  await f.workspace.delegateToAgent('child', agent, 'Ordinary nested attempt');
  assert.equal(f.captured.at(-1)!.swarm, false);
  await assert.rejects(
    f.workspace.delegateToAgent('child', agent, 'Ordinary outside scope', { write: true, files: ['outside.ts'] }),
    /不能扩大/,
  );
  await f.workspace.delegate('child', 'scout', 'Ordinary nested attempt', 'request');
  assert.equal(f.captured.at(-1)!.permissionMode, 'read-only');
});

test('depth four and sixty logical children are enforced while historical continuations do not spend another child', async (t) => {
  const rows = [task('root')];
  for (let i = 1; i <= 4; i++) rows.push(task(`depth-${i}`, i === 1 ? 'root' : `depth-${i - 1}`));
  const f = fixture(t, rows);
  await assert.rejects(
    f.workspace.delegateToAgent('depth-4', { provider: 'pi', label: 'API Pi', runtimeId: 'pi-api' }, 'Too deep'),
    /最多 4 层/,
  );
  for (let i = 4; i < swarmLimits.children; i++) {
    const child = task(`sibling-${i}`, 'root');
    f.store.save('workflow', child.id, child.conversationId, child);
  }
  for (let i = 0; i < 12; i++) {
    const continued = task(`continued-${i}`, 'root', { parentWorkflowId: i ? `continued-${i - 1}` : 'sibling-4' });
    f.store.save('workflow', continued.id, continued.conversationId, continued);
  }
  assert.equal(swarmAgents('root', f.store.conversationWorkflows('conversation')).length, 61);
  await assert.rejects(
    f.workspace.delegateToAgent('root', { provider: 'pi', label: 'API Pi' }, 'Sixty first'),
    /最多 60 个/,
  );
});

test('ordinary family limits cover nested descendants and continuations without changing permissions', async (t) => {
  const rows = [task('root')];
  for (let i = 1; i <= managedAgentLimits.depth; i++)
    rows.push(task(`depth-${i}`, i === 1 ? 'root' : `depth-${i - 1}`));
  for (const row of rows) row.input.swarm = false;
  const f = fixture(t, rows);
  await assert.rejects(
    f.workspace.delegateToAgent(`depth-${managedAgentLimits.depth}`, { label: 'Automatic' }, 'Too deep'),
    /最多 4 层/,
  );
  for (let i = rows.length - 1; i < managedAgentLimits.children; i++) {
    const child = task(`ordinary-${i}`, 'depth-1');
    child.input.swarm = false;
    f.store.save('workflow', child.id, child.conversationId, child);
  }
  const continuation = task('continued', 'root', { parentWorkflowId: 'depth-1' });
  continuation.input.swarm = false;
  f.store.save('workflow', continuation.id, continuation.conversationId, continuation);
  await assert.rejects(f.workspace.delegateToAgent('root', { label: 'Automatic' }, 'Thirteenth'), /最多 12 个/);
  assert.equal(swarmAgents('root', f.workspace.swarmSnapshot('conversation').workflows).length, 13);
});

test('concurrent ordinary batches reserve the whole family budget across different parents', async (t) => {
  const rows = [task('root'), task('first', 'root'), task('second', 'root')];
  for (const row of rows) row.input.swarm = false;
  const f = fixture(t, rows);
  const requests = Array.from({ length: 6 }, (_, index) => ({
    id: `part-${index}`,
    dependsOn: [],
    agent: { label: 'Automatic' },
    task: 'Independent check',
    options: {},
  }));
  Object.assign(f.workspace, { publish: () => {} });
  const results = await Promise.allSettled([
    f.workspace.delegateBatch('first', requests),
    f.workspace.delegateBatch('second', requests),
  ]);
  assert.equal(
    results.filter((result) => result.status === 'fulfilled').length,
    1,
    results.map((result) => (result.status === 'rejected' ? String(result.reason) : 'ok')).join('\n'),
  );
  const rejected = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
  assert.match(rejected.reason.message, /最多 12 个/);
  assert.equal(swarmAgents('root', f.workspace.swarmSnapshot('conversation').workflows).length, 9);
});

test('ordinary members remain visible and can receive collaboration without changing their mode or permissions', async (t) => {
  const root = task('root');
  root.input.swarm = false;
  const sibling = task('old-sibling', 'root');
  sibling.input.swarm = false;
  const continued = task('root-swarm', undefined, { parentWorkflowId: 'root', createdAt: '2026-10-09T01:00:00Z' });
  const f = fixture(t, [root, sibling, continued]);
  const snapshot = f.workspace.swarmSnapshot('conversation');
  assert.equal(snapshot.workflows.length, 3);
  const agents = swarmAgents('root-swarm', snapshot.workflows);
  assert.equal(agents.length, 2);
  assert.equal(agents.find((agent) => agent.depth === 0)!.workflow.id, 'root-swarm');
  assert.equal(snapshot.workflows.find((workflow) => workflow.id === 'old-sibling')!.input.swarm, false);
  assert.equal(
    (await f.workspace.messageSwarmAgent('root-swarm', 'old-sibling', 'Review this evidence', 'run-root-swarm'))
      .delivery,
    'delivered',
  );
  assert.equal(f.store.get<Workflow>('workflow', 'old-sibling')!.input.swarm, false);
});

test('original root archive retains continuation runs, new descendants, original messages, and durable communication after live summaries expire', (t) => {
  const original = task('root');
  original.input.swarm = false;
  const continued = task('root-v2', undefined, { parentWorkflowId: 'root' });
  const child = task('new-child', 'root-v2');
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'pug-swarm-archive-')));
  const archive = new Store(directory);
  t.after(() => {
    archive.close();
    assert.ok(resolve(directory).startsWith(realpathSync.native(tmpdir()) + sep));
    assert.ok(basename(directory).startsWith('pug-swarm-archive-'));
    rmSync(directory, { recursive: true, force: true });
  });
  const f = fixture(t, [original, continued, child], archive.db);
  const savedRuns = [original, continued, child].map(
    (workflow) =>
      ({
        id: `saved-${workflow.id}`,
        workflowId: workflow.id,
        prompt: workflow.input.content,
        projectPath: 'C:/synthetic/swarm',
        kind: 'general',
        route: { runtimeId: 'pi-api', model: 'parent-model', kind: 'general', reasons: [], warnings: [] },
        status: 'completed',
        startedAt: '2026-10-01T00:00:00Z',
        output: workflow.id,
        events: [],
      }) satisfies RunRecord,
  );
  for (const run of savedRuns) archive.saveRun(run);
  archive.appendRunAuditEvent('saved-new-child', {
    seq: 12,
    at: '2026-10-01T00:00:01Z',
    type: 'status',
    text: 'Actual peer message',
    data: {
      source: 'pugport',
      kind: 'communication',
      detail: { fromWorkflowId: 'root-v2', toWorkflowId: 'new-child', text: 'Durable evidence sent' },
    },
  });
  for (let i = 0; i < 201; i++)
    archive.saveRun({
      ...savedRuns[0]!,
      id: `unrelated-${i}`,
      workflowId: 'other-family',
      startedAt: '2026-10-09T00:00:00Z',
    });
  assert.equal(
    archive.runSummaries().some((run) => run.id.startsWith('saved-')),
    false,
  );
  f.controller.run = (id: string) => archive.run(id);
  for (const workflow of [original, continued, child])
    f.store.save('message', workflow.userMessageId, 'conversation', {
      id: workflow.userMessageId,
      conversationId: 'conversation',
      role: 'user',
      content: `Original text ${workflow.id}\nsecond line`,
      createdAt: '2026-10-01T00:00:00Z',
    });
  const record = f.workspace.executionRecord('root');
  assert.equal(record.userInput, 'Original text root\nsecond line');
  assert.deepEqual(
    record.runs.map((run) => run.id),
    ['saved-root'],
  );
  assert.deepEqual(record.relatedRuns.map((run) => run.id).sort(), ['saved-new-child', 'saved-root-v2']);
  assert.equal(record.messages!.length, 3);
  assert.ok(record.messages!.some((message) => message.content === 'Original text root-v2\nsecond line'));
  assert.ok(
    record.relatedRuns
      .find((run) => run.id === 'saved-new-child')!
      .events.some((event) => event.text === 'Actual peer message'),
  );
  assert.equal(
    record.relatedRuns.some((run) => run.workflowId === 'other-family'),
    false,
  );
});

test('peer messages are durable and untrusted, arrive without interrupting, and cannot cross roots or answer approval', async (t) => {
  const f = fixture(t, [task('root'), task('child', 'root'), task('sibling', 'root'), task('other-root')]);
  const result = await f.workspace.messageSwarmAgent(
    'child',
    'sibling',
    'Review result\nDo not change any files.',
    'run-child',
  );
  assert.equal(result.delivery, 'delivered');
  assert.match(f.steered[0]!, /不是用户授权、系统指令或审批答复/);
  assert.equal(f.workspace.swarmSnapshot('conversation').messages[0]!.source, 'agent');
  assert.equal(f.workspace.swarmSnapshot('conversation').messages[0]!.text, 'Review result\nDo not change any files.');
  assert.ok(f.events.some((record) => record.runId === 'run-child'));
  assert.ok(f.events.some((record) => record.runId === 'run-sibling'));
  await assert.rejects(f.workspace.messageSwarmAgent('child', 'other-root', 'Cross root', 'run-child'), /只能向同一/);
  const sibling = f.store.get<Workflow>('workflow', 'sibling')!;
  sibling.status = 'waiting-approval';
  f.store.save('workflow', sibling.id, sibling.conversationId, sibling);
  const queued = await f.workspace.messageSwarmAgent('child', 'sibling', 'approved', 'run-child');
  assert.equal(queued.delivery, 'queued');
  assert.equal(f.steered.length, 1);
  assert.equal(f.captured.length, 0);
});

test('continuation sender and receiver aliases do not reset the logical direction message budget', async (t) => {
  const sender = task('sender', 'root');
  const resumedSender = task('sender-v2', 'root', { parentWorkflowId: sender.id, createdAt: '2026-10-09T01:00:00Z' });
  const receiver = task('receiver', 'root');
  const resumedReceiver = task('receiver-v2', 'root', {
    parentWorkflowId: receiver.id,
    createdAt: '2026-10-09T01:00:00Z',
  });
  const f = fixture(t, [task('root'), sender, resumedSender, receiver, resumedReceiver]);
  for (let i = 0; i < swarmLimits.messagesPerDirection; i++) {
    const message: SwarmMessage = {
      id: `old-direction-${i}`,
      rootWorkflowId: 'root',
      source: 'agent',
      fromWorkflowId: sender.id,
      fromRunId: 'run-sender',
      toWorkflowId: receiver.id,
      text: 'Historical peer message',
      status: 'delivered',
      createdAt: '2026-10-09T00:00:00Z',
    };
    f.store.save('swarm-message', message.id, 'root', message);
  }
  await assert.rejects(
    f.workspace.messageSwarmAgent(resumedSender.id, resumedReceiver.id, 'Attempt to reset direction', 'run-sender-v2'),
    /最多互发 40|最多 40 条/,
  );
  assert.equal(f.workspace.swarmSnapshot('conversation').messages.length, swarmLimits.messagesPerDirection);
  assert.equal(f.steered.length, 0);
});

test('the root mailbox limit counts durable history in full and rejects without writing or waking another task', async (t) => {
  const f = fixture(t);
  const message: SwarmMessage = {
    id: 'template',
    rootWorkflowId: 'root',
    source: 'human',
    toWorkflowId: 'child',
    text: 'Preserved history',
    status: 'delivered',
    createdAt: '2026-10-09T00:00:00Z',
  };
  const insert = f.store.db.prepare('INSERT INTO workspace_records(kind,id,owner,updated_at,value) VALUES(?,?,?,?,?)');
  f.store.transaction(() => {
    for (let i = 0; i < swarmLimits.messages; i++)
      insert.run(
        'swarm-message',
        `history-${i}`,
        'root',
        message.createdAt,
        JSON.stringify({ ...message, id: `history-${i}` }),
      );
  });
  await assert.rejects(
    f.workspace.messageSwarmAgent('root', 'child', 'Must not forget older messages', 'run-root'),
    /最多保存 10000 条/,
  );
  const count = f.store.db
    .prepare("SELECT COUNT(*) AS count FROM workspace_records WHERE kind='swarm-message' AND owner='root'")
    .get() as { count: number };
  assert.equal(count.count, swarmLimits.messages);
  assert.equal(f.store.get<SwarmMessage>('swarm-message', 'history-0')!.text, 'Preserved history');
  assert.equal(f.captured.length, 0);
  assert.equal(f.steered.length, 0);
});

test('mailbox survives a reconstructed host and only messages included in an actual run are acknowledged', async (t) => {
  const f = fixture(t, [task('root'), task('child', 'root', { status: 'queued', runIds: [] })]);
  const original = '  exact original text\nsecond line  ';
  await f.workspace.sendSwarmMessage('child', original);
  const prompt = f.workspace.swarmMailboxPrompt('child');
  assert.ok(prompt.includes(original));
  await f.workspace.sendSwarmMessage('child', 'arrived after prompt construction');
  f.runs.set('real-run', { id: 'real-run', prompt } as RunRecord);
  const reconstructed = Object.create(Workspace.prototype) as Workspace;
  Object.assign(reconstructed, { store: f.store, controller: f.controller, clock: () => Date.now() });
  assert.match(reconstructed.swarmMailboxPrompt('child'), /arrived after prompt/);
  reconstructed.swarmMailboxPrompt('child', 'real-run');
  const mailbox = f.store.list<SwarmMessage>('swarm-message', 'root');
  assert.equal(mailbox.find((message) => message.text === original)!.status, 'delivered');
  assert.equal(mailbox.find((message) => message.text.startsWith('arrived'))!.status, 'queued');
  assert.match(reconstructed.swarmMailboxPrompt('child'), /arrived after prompt/);
  assert.ok(reconstructed.swarmAcceptedMailboxPrompt('child', 'real-run').includes(original));
  assert.ok(!reconstructed.swarmAcceptedMailboxPrompt('child', 'real-run').includes('arrived after prompt'));
  assert.equal(reconstructed.swarmAcceptedMailboxPrompt('root', 'real-run'), '');
});

test('explicit Continue carries the previous member accepted mailbox into a fresh session without replay or new authorization', async (t) => {
  const old = task('root', undefined, {
    status: 'completed',
    runIds: ['original-run', 'safe-relay-run', 'visual-run'],
  });
  const f = fixture(t, [old, task('child', 'root', { status: 'completed' })]);
  const delivered: SwarmMessage = {
    id: 'received-human',
    rootWorkflowId: old.id,
    source: 'human',
    toWorkflowId: old.id,
    toRunId: 'safe-relay-run',
    text: 'Previously accepted: check the saved manifest before comparing again.',
    status: 'delivered',
    createdAt: '2026-10-09T00:00:01Z',
  };
  const carried: SwarmMessage = {
    ...delivered,
    id: 'received-peer',
    source: 'agent',
    fromWorkflowId: 'child',
    fromRunId: 'run-child',
    toRunId: 'original-run',
    text: 'Peer evidence previously handed over safely.',
  };
  const excluded: SwarmMessage = {
    ...delivered,
    id: 'earlier-only',
    toRunId: 'original-run',
    text: 'Unrelated older receipt absent from the last safe context.',
  };
  const otherMember: SwarmMessage = {
    ...delivered,
    id: 'other-member',
    toWorkflowId: 'child',
    text: 'Private child data',
  };
  for (const message of [delivered, carried, excluded, otherMember])
    f.store.save('swarm-message', message.id, old.id, message);
  const internal = f.workspace as unknown as {
    swarmMessagePrompt(message: SwarmMessage): string;
    attemptOnce(workflow: Workflow, step: undefined, input: RunInput, signal: AbortSignal): Promise<RunRecord>;
  };
  const prior: RunRecord = {
    id: 'safe-relay-run',
    workflowId: old.id,
    prompt: `Existing safe context\n${internal.swarmMessagePrompt(carried)}`,
    projectPath: 'C:/synthetic/swarm',
    kind: 'general',
    route: { runtimeId: 'pi-api', model: 'parent-model', kind: 'general', reasons: [], warnings: [] },
    status: 'completed',
    startedAt: old.createdAt,
    output: 'Existing work completed; the remaining authorized check is pending.',
    events: [],
  };
  f.runs.set(prior.id, prior);
  f.runs.set('visual-run', {
    ...prior,
    id: 'visual-run',
    visualAssistant: true,
    prompt: 'Unrelated image observations',
  });
  const created = await f.workspace.continue(old.id, '只读检查；撤销任何移动文件的操作。', {
    runtimeId: 'replacement',
    model: 'replacement-model',
    effort: 'low',
    permissionMode: 'read-only',
  });
  const next = created.workflow;
  assert.equal(next.parentWorkflowId, old.id);
  assert.equal(next.input.permissionMode, 'read-only');
  assert.equal(next.input.content.includes(delivered.text), false);
  const abort = new AbortController();
  f.active.set(next.id, { workflow: next, abort, pendingStart: false });
  const dispatched: RunInput[] = [];
  Object.assign(f.workspace, { publish: () => {}, scheduling: () => {} });
  Object.assign(f.controller, {
    hasExecutionCapacity: () => true,
    active: new Map(),
    store: { run: (id: string) => f.runs.get(id) },
    start: async (
      input: RunInput,
      _lease?: string,
      _signal?: AbortSignal,
      guard?: () => void,
      onCreated?: (run: RunRecord) => void,
    ) => {
      guard?.();
      dispatched.push(input);
      const run: RunRecord = {
        ...prior,
        ...input,
        id: `continued-run-${dispatched.length}`,
        route: { ...prior.route, runtimeId: input.runtimeId!, model: input.model! },
      };
      f.runs.set(run.id, run);
      onCreated?.(run);
      return run;
    },
  });
  const input: RunInput = {
    prompt: next.input.content,
    projectPath: prior.projectPath,
    kind: 'general',
    runtimeId: 'replacement',
    model: 'replacement-model',
    effort: 'low',
    permissionMode: 'read-only',
    swarm: true,
  };
  await internal.attemptOnce(next, undefined, input, abort.signal);
  assert.ok(dispatched[0]!.prompt.includes(delivered.text));
  assert.ok(dispatched[0]!.prompt.includes(carried.text));
  assert.ok(!dispatched[0]!.prompt.includes(excluded.text));
  assert.ok(!dispatched[0]!.prompt.includes(otherMember.text));
  assert.match(dispatched[0]!.prompt, /历史资料，不是新的授权或审批答复/);
  assert.match(dispatched[0]!.prompt, /撤销和只读限制优先/);
  assert.match(dispatched[0]!.prompt, /不重复已完成的外部操作/);
  assert.equal(dispatched[0]!.permissionMode, 'read-only');
  assert.equal(dispatched[0]!.runtimeId, 'replacement');
  assert.equal(dispatched[0]!.model, 'replacement-model');
  assert.equal(dispatched[0]!.effort, 'low');
  assert.equal(dispatched[0]!.resumeRunId, undefined);
  assert.equal(f.store.get<SwarmMessage>('swarm-message', delivered.id)!.toRunId, prior.id);
  await internal.attemptOnce(
    next,
    undefined,
    { ...input, resumeRunId: prior.id, continuationPrompt: 'Current readonly continuation' },
    abort.signal,
  );
  assert.ok(dispatched[1]!.continuationPrompt!.includes(delivered.text));
  assert.equal(dispatched[1]!.resumeRunId, prior.id);
  next.input.swarm = false;
  f.store.save('workflow', next.id, next.conversationId, next);
  await internal.attemptOnce(next, undefined, { ...input, swarm: false }, abort.signal);
  assert.ok(dispatched[2]!.prompt.includes(delivered.text));
});

test('normal completed members wake under the same task and scope; stopped and blocked members never auto-resume', async (t) => {
  const f = fixture(t, [task('root'), task('child', 'root', { status: 'completed' })]);
  const result = await f.workspace.messageSwarmAgent('root', 'child', 'Consider evidence from my check.', 'run-root');
  assert.equal(result.delivery, 'queued');
  assert.notEqual(result.workflowId, 'child');
  assert.equal(f.captured[0]!.permissionMode, 'workspace-write');
  assert.equal(f.captured[0]!.intentText, 'Intent child');
  assert.equal(f.store.get<Workflow>('workflow', result.workflowId)!.delegation!.scope![0], 'src/child');
  const original = f.store.get<Workflow>('workflow', 'child')!;
  original.stopped = true;
  f.store.save('workflow', original.id, original.conversationId, original);
  // Target aliases always resolve to the latest continuation; stop that real agent too.
  const resumed = f.store.get<Workflow>('workflow', result.workflowId)!;
  const resumeMessage = f.store
    .allMessages(resumed.conversationId)
    .find((message) => message.id === resumed.userMessageId)!;
  assert.equal(resumeMessage.content, '');
  assert.equal(resumeMessage.resumed, true);
  assert.match(resumed.input.content, /^继续同一蜂群任务：/);
  resumed.status = 'cancelled';
  resumed.stopped = true;
  f.store.save('workflow', resumed.id, resumed.conversationId, resumed);
  await assert.rejects(f.workspace.messageSwarmAgent('root', 'child', 'Wake again', 'run-root'), /已停止/);
  const blocked = task('blocked-child', 'root', { status: 'blocked' });
  f.store.save('workflow', blocked.id, blocked.conversationId, blocked);
  assert.equal((await f.workspace.sendSwarmMessage(blocked.id, 'A human supplement')).delivery, 'queued');
  assert.equal(f.captured.length, 1);
});

test('bridge exposes swarm tools only with swarm grants, permits independent same-executor children, and preserves own-child controls', async (t) => {
  const f = fixture(t, [task('root'), task('child', 'root'), task('sibling', 'root')]);
  const bridge = Object.create(AgentBridge.prototype) as AgentBridge;
  Object.assign(bridge, { workspace: f.workspace, controller: f.controller, questions: new Map(), awaited: new Map() });
  const caller = {
    run: { id: 'run-child', workflowId: 'child' },
    target: f.controller.targets[0],
    delegate: true,
    child: true,
    recycle: false,
    write: false,
    signal: new AbortController().signal,
  };
  const internal = bridge as unknown as {
    message(caller: unknown, request: unknown): Promise<any>;
    call(caller: unknown, name: string, args: Record<string, unknown>): Promise<any>;
    results(): Promise<string[]>;
  };
  const listed = await internal.message(caller, { id: 1, method: 'tools/list' });
  assert.ok(listed.result.tools.some((tool: { name: string }) => tool.name === 'message_agent'));
  const closed = await internal.message({ ...caller, child: false, delegate: false }, { id: 2, method: 'tools/list' });
  assert.ok(!closed.result.tools.some((tool: { name: string }) => tool.name === 'list_swarm'));
  await assert.rejects(internal.call(caller, 'get_result', { task_id: 'sibling' }), /不属于当前任务/);
  internal.results = async () => ['fixture child result'];
  await internal.call(caller, 'delegate', {
    agent: 'API Pi',
    task: 'Independent same account task',
    write: false,
    effort: 'low',
  });
  assert.equal(f.captured[0]!.runtimeId, 'pi-api');
  assert.equal(f.captured[0]!.effort, undefined);
  assert.equal(f.store.get<Workflow>('workflow', 'created-1')!.delegation!.suggestedEffort, 'low');
  const ordinary = f.store.get<Workflow>('workflow', 'child')!;
  ordinary.input.swarm = false;
  f.store.save('workflow', ordinary.id, ordinary.conversationId, ordinary);
  await internal.call(caller, 'delegate', {
    agent: 'API Pi',
    task: 'Ordinary self writing task',
    write: true,
    files: ['src/child'],
  });
  // Ordinary Pi may create an independent child on the same account within its inherited scope.
  const rootCaller = { ...caller, run: { id: 'run-root', workflowId: 'root' }, child: false };
  const root = f.store.get<Workflow>('workflow', 'root')!;
  root.input.swarm = false;
  f.store.save('workflow', root.id, root.conversationId, root);
  await internal.call(rootCaller, 'delegate', { agent: 'API Pi', task: 'Ordinary independent reader', write: false });
  assert.equal(f.captured.at(-1)!.permissionMode, 'read-only');
  await internal.call(caller, 'message_agent', { task_id: 'sibling', text: 'Ordinary collaboration' });
});

test('parked callers reacquire the same swarm capacity before returning, while ordinary tasks keep existing behavior', (t) => {
  const last = `child-${swarmLimits.active}`;
  const f = fixture(t, [
    task('root'),
    ...Array.from({ length: swarmLimits.active }, (_, index) => task(`child-${index + 1}`, 'root')),
  ]);
  const controller = Object.create(Controller.prototype) as Controller;
  const active = new Map(
    f.store.conversationWorkflows('conversation').map((workflow) => [
      workflow.runIds[0]!,
      {
        run: { id: workflow.runIds[0], workflowId: workflow.id, status: 'running', route: { runtimeId: 'unused' } },
        abort: new AbortController(),
        parked: workflow.id === 'root',
        permissionMode: 'read-only',
        project: 'synthetic',
      },
    ]),
  );
  let resumed = 0;
  Object.assign(controller, {
    store: { db: f.store.db },
    active,
    settings: { maxConcurrentRuns: 0 },
    targets: [],
    snapshots: [],
    executionResumes: [
      {
        runId: 'run-root',
        dispose: () => {},
        resolve: () => {
          resumed++;
        },
        reject: assert.fail,
      },
    ],
    projectDeliveries: new Set(),
  });
  assert.equal(controller.hasSwarmExecutionCapacity('root'), false);
  const internal = controller as unknown as { resumeExecutions(): void };
  internal.resumeExecutions();
  assert.equal(resumed, 0);
  active.get(`run-${last}`)!.parked = true;
  assert.equal(controller.hasSwarmExecutionCapacity('root'), true);
  internal.resumeExecutions();
  assert.equal(resumed, 1);
  assert.equal(active.get('run-root')!.parked, false);
  assert.equal(controller.hasSwarmExecutionCapacity(last), false);
  const root = f.store.get<Workflow>('workflow', 'root')!;
  root.input.swarm = false;
  f.store.save('workflow', root.id, root.conversationId, root);
  assert.equal(controller.hasSwarmExecutionCapacity('root'), false, 'one flag cannot remove an existing family cap');
  for (const member of f.store.conversationWorkflows('conversation')) {
    member.input.swarm = false;
    f.store.save('workflow', member.id, member.conversationId, member);
  }
  assert.equal(controller.hasSwarmExecutionCapacity('root'), true);
  assert.equal(controller.hasSwarmExecutionCapacity(last), false, 'ordinary children keep the smaller family cap');
});

test('real Controller onCreated acknowledges the dispatched mailbox before the mocked adapter executes', async (t) => {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'swarm-created-test-')));
  const controller = new Controller(directory, join(directory, 'data'));
  clearInterval(controller.timer);
  controller.targets = [
    {
      id: 'codex-swarm-mock',
      provider: 'codex',
      label: 'Swarm mock',
      command: 'unused',
      environment: 'native',
      enabled: true,
    },
  ];
  controller.snapshots = [
    {
      ...controller.targets[0]!,
      installed: true,
      status: 'ready',
      models: [{ id: 'mock-model', label: 'Mock model', efforts: ['low', 'medium', 'high'] }],
      quota: {
        status: 'known',
        source: 'fixture',
        observedAt: new Date().toISOString(),
        windows: [
          { id: 'week', label: 'week', usedPercent: 10, resetsAt: new Date(Date.now() + 3600000).toISOString() },
        ],
      },
      capabilities: { execute: true, resume: true, cancel: true, approvals: true },
      refreshedAt: new Date().toISOString(),
    } as RuntimeSnapshot,
  ];
  controller.settings.decisionMode = 'auto';
  t.mock.method(controller, 'refresh', async () => {});
  // A roomy synthetic computer, so the swarm cap (not this machine's free memory) is what the test meets.
  t.mock.method(controller, 'machineReading', () => ({
    totalBytes: 64 * 1024 ** 3,
    availableMemoryBytes: 32 * 1024 ** 3,
    cpus: 32,
  }));
  const store = new WorkspaceStore(controller.store.db, { recoverInterrupted: false });
  store.save('conversation', 'conversation', 'project', { id: 'conversation', projectId: 'project', swarm: true });
  const root = task('root', undefined, { status: 'queued', runIds: [] });
  root.input.permissionMode = 'read-only';
  store.save('workflow', root.id, root.conversationId, root);
  const workspace = Object.create(Workspace.prototype) as Workspace;
  Object.assign(workspace, { store, controller, active: new Map(), clock: () => Date.now(), wake: () => {} });
  t.after(async () => {
    await controller.close();
    const absolute = resolve(directory);
    assert.ok(
      absolute.startsWith(realpathSync.native(tmpdir()) + sep) && basename(absolute).startsWith('swarm-created-test-'),
    );
    rmSync(absolute, { recursive: true, force: true });
  });
  await workspace.sendSwarmMessage(root.id, 'A durable user supplement');
  let executed = false;
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    executed = true;
    assert.match(ctx.input.prompt, /A durable user supplement/);
    const message = store.list<SwarmMessage>('swarm-message', root.id)[0]!;
    assert.equal(message.status, 'delivered');
    assert.ok(message.toRunId);
    assert.equal(controller.active.has(message.toRunId), true);
    return { output: 'Mock final result' };
  });
  const dispatched = `Original task\n\n${workspace.swarmMailboxPrompt(root.id)}`;
  const run = await controller.start(
    {
      prompt: dispatched,
      projectPath: directory,
      kind: 'general',
      runtimeId: 'codex-swarm-mock',
      model: 'mock-model',
      effort: 'low',
      permissionMode: 'read-only',
      workflowId: root.id,
      stepId: 'step-1',
      swarm: true,
    },
    undefined,
    undefined,
    undefined,
    (created) => {
      assert.ok(controller.run(created.id));
      assert.ok(controller.active.has(created.id));
      workspace.swarmMailboxPrompt(root.id, created.id);
    },
  );
  for (let i = 0; i < 200 && controller.active.has(run.id); i++) await new Promise((done) => setTimeout(done, 10));
  assert.equal(executed, true);
  assert.equal(controller.run(run.id)!.status, 'completed');
  assert.match(workspace.swarmAcceptedMailboxPrompt(root.id, run.id), /A durable user supplement/);
  // Direct retries/next steps bypass evaluateQueue, so Controller.start must enforce the same cap. The occupying
  // members run on other accounts, so the mock account's own quota share is not what turns the retry away.
  for (let i = 1; i <= swarmLimits.active; i++) {
    const member = task(`occupancy-${i}`, root.id);
    store.save('workflow', member.id, member.conversationId, member);
    const saved = controller.run(run.id)!;
    controller.active.set(`occupancy-run-${i}`, {
      run: {
        ...saved,
        id: `occupancy-run-${i}`,
        workflowId: member.id,
        status: 'running',
        route: { ...saved.route, runtimeId: `occupancy-account-${i}` },
      },
      abort: new AbortController(),
      project: directory.toLowerCase(),
      permissionMode: 'read-only',
    });
  }
  executed = false;
  let rejectedCallback = false;
  const retryInput = {
    prompt: 'Same authorized task retry',
    projectPath: directory,
    kind: 'general' as const,
    runtimeId: 'codex-swarm-mock',
    model: 'mock-model',
    effort: 'low',
    permissionMode: 'read-only' as const,
    workflowId: root.id,
    stepId: 'step-1',
    swarm: true,
  };
  await assert.rejects(
    controller.start(retryInput, undefined, undefined, undefined, () => {
      rejectedCallback = true;
    }),
    /子任务并发已满/,
  );
  assert.equal(rejectedCallback, false);
  assert.equal(executed, false);
  controller.active.delete(`occupancy-run-${swarmLimits.active}`);
  t.mock.method(codexAdapter, 'execute', async () => {
    executed = true;
    return { output: 'Retry after capacity returns' };
  });
  const resumed = await controller.start(retryInput);
  for (let i = 0; i < 200 && controller.active.has(resumed.id); i++) await new Promise((done) => setTimeout(done, 10));
  assert.equal(executed, true);
  assert.equal(controller.run(resumed.id)!.status, 'completed');
  for (let i = 1; i < swarmLimits.active; i++) controller.active.delete(`occupancy-run-${i}`);
});
