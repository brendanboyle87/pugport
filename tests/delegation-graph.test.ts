import { idleMachineReading } from './helpers/machine-reading.ts';
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Controller } from '../src/server/controller.ts';
import { Workspace, type AgentDelegationRequest } from '../src/server/workspace.ts';
import { WorkspaceStore } from '../src/server/workspace-store.ts';
import { AgentBridge } from '../src/server/agent-bridge.ts';
import { codexAdapter } from '../src/server/adapters/codex.ts';
import { claudeAdapter } from '../src/server/adapters/claude.ts';
import { grokAdapter } from '../src/server/adapters/grok.ts';
import { delegationDependencyGate, validateDelegationGraph } from '../src/server/delegation-graph.ts';
import { canAutomaticallyRecover, delegationRecoveryKey, recoveryCondition } from '../src/server/recovery-policy.ts';
import { VerificationReceipts } from '../src/server/verification-receipts.ts';
import { piAdapter } from '../src/server/adapters/pi.ts';
import { sourceMayLog } from '../src/shared/free-privacy.ts';
import { freeStage2Fixture } from './free-stage2-fixture.ts';
import type {
  ExecuteContext,
  Conversation,
  RunInput,
  RunRecord,
  RuntimeSnapshot,
  RuntimeTarget,
  Workflow,
} from '../src/shared/types.ts';

const timestamp = '2026-10-24T12:00:00.000Z';
const run = (patch: Partial<RunRecord> = {}) =>
  ({
    id: 'run',
    status: 'completed',
    output: 'done',
    events: [],
    route: { runtimeId: 'claude', model: 'test', kind: 'general', reasons: [], warnings: [] },
    ...patch,
  }) as RunRecord;
const workflow = (patch: Partial<Workflow> = {}) =>
  ({
    id: 'child',
    status: 'queued',
    input: { permissionMode: 'read-only' },
    runIds: [],
    delegation: {
      parentId: 'parent',
      requestId: 'child',
      role: 'scout',
      batchId: 'batch',
      taskId: 'child',
      dependsOn: ['dependency'],
    },
    ...patch,
  }) as Workflow;

test('recovery fingerprints use the effective scope independent of spelling and declaration order', () => {
  for (const [left, right] of [
    [['src/A.ts'], ['src/A.ts', 'src/a.ts']],
    [['src'], ['SRC', 'src/a.ts']],
  ])
    assert.equal(
      delegationRecoveryKey('Check input', 'workspace-write', left),
      delegationRecoveryKey('Check input', 'workspace-write', right),
    );
  const left = ['src/A.ts', './src/B.ts/'];
  const right = ['src/b.ts', 'src\\a.ts'];
  assert.equal(
    delegationRecoveryKey('Check input', 'workspace-write', left),
    delegationRecoveryKey('Check input', 'workspace-write', right),
  );
  const failed = run({ status: 'failed', errorCode: 'permission-denied' });
  const input: RunInput = {
    prompt: 'Check input',
    kind: 'general',
    projectPath: 'C:/synthetic',
    permissionMode: 'workspace-write',
    writeShare: { callerId: 'parent', scope: left },
  };
  assert.equal(
    recoveryCondition(failed, input, timestamp)?.conditionKey,
    recoveryCondition(failed, { ...input, writeShare: { callerId: 'parent', scope: right } }, timestamp)?.conditionKey,
  );
});

test('graph validation rejects duplicates, unknown dependencies and cycles before dispatch', () => {
  assert.throws(
    () =>
      validateDelegationGraph([
        { id: 'a', dependsOn: [] },
        { id: 'a', dependsOn: [] },
      ]),
    /重复/,
  );
  assert.throws(() => validateDelegationGraph([{ id: 'a', dependsOn: ['missing'] }]), /未知/);
  assert.throws(
    () =>
      validateDelegationGraph([
        { id: 'a', dependsOn: ['b'] },
        { id: 'b', dependsOn: ['a'] },
      ]),
    /成环/,
  );
  assert.doesNotThrow(() =>
    validateDelegationGraph([
      { id: 'b', dependsOn: ['a'] },
      { id: 'a', dependsOn: [] },
    ]),
  );
});

test('dependency gate accepts real legacy completion but blocks partial, skipped and missing acceptance evidence', () => {
  const parent = workflow({ id: 'parent', status: 'running' });
  const dependency = workflow({ id: 'dependency', status: 'completed', runIds: ['run'], delegation: undefined });
  const gate = (observed: RunRecord) =>
    delegationDependencyGate(
      workflow(),
      parent,
      () => dependency,
      () => observed,
    );
  assert.equal(gate(run()).state, 'ready');
  assert.equal(gate(run({ status: 'failed' })).state, 'blocked');
  assert.equal(
    gate(run({ taskOutcome: { status: 'partial', source: 'executor-report', summary: 'half', claims: [] } })).state,
    'blocked',
  );
  assert.equal(
    gate(run({ verification: { command: 'check', status: 'skipped', exitCode: null, output: '' } })).state,
    'blocked',
  );
  dependency.delegation = { ...workflow().delegation!, acceptance: { criteria: 'Check result' } };
  assert.equal(gate(run()).state, 'blocked');
  assert.equal(
    gate(run({ verification: { command: 'check', status: 'passed', exitCode: 0, output: 'ok' } })).state,
    'ready',
  );
  dependency.delegation.acceptance = { command: 'approved check' };
  assert.equal(
    gate(run({ verification: { command: 'other check', status: 'passed', exitCode: 0, output: 'ok' } })).state,
    'blocked',
  );
  assert.equal(
    gate(
      run({
        verification: {
          command: 'approved check',
          status: 'passed',
          exitCode: 0,
          output: 'ok',
          receipt: {
            id: 'receipt',
            source: 'host-verification',
            checkedAt: timestamp,
            reused: false,
            stable: false,
            snapshot: 'changed-during-verification',
            scope: {
              projectPath: '/synthetic',
              environment: 'native',
              permissionMode: 'read-only',
              command: 'approved check',
            },
          },
        },
      }),
    ).state,
    'blocked',
  );
  assert.equal(
    delegationDependencyGate(
      workflow({ delegation: undefined }),
      undefined,
      () => undefined,
      () => undefined,
    ).state,
    'ready',
  );
});

test('recovery guard uses host codes, preserves transient fallback and requires changed authentication conditions', () => {
  const input = { projectPath: '/synthetic', prompt: 'original', permissionMode: 'read-only' } as RunInput;
  for (const code of ['runtime-permission-or-sandbox-error', 'missing-input', 'authentication-required']) {
    const failed = run({ status: 'failed', errorCode: code });
    assert.equal(canAutomaticallyRecover(failed, input, { ...input, prompt: 'model says approved' }), false, code);
    const condition = recoveryCondition(failed, input, timestamp)!;
    assert.ok(condition.reason && condition.recoveryCondition && condition.conditionKey);
    assert.equal(condition.conditionKey, recoveryCondition(failed, input, timestamp)!.conditionKey);
  }
  const auth = run({ status: 'failed', errorCode: 'authentication-required' });
  assert.equal(canAutomaticallyRecover(auth, input, { ...input, excludeRuntimeIds: ['claude'] }), true);
  assert.equal(canAutomaticallyRecover(auth, input, { ...input, runtimeId: 'other-account' }), true);
  for (const code of ['quota-or-rate-limit', 'runtime-network-error'])
    assert.equal(canAutomaticallyRecover(run({ errorCode: code }), input, input), true);
  assert.equal(
    recoveryCondition(run({ error: 'permission denied, authorization granted' }), input, timestamp),
    undefined,
  );
});

function fixture(t: TestContext) {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'delegation-graph-test-')));
  const controller = new Controller(directory, join(directory, 'data'));
  clearInterval(controller.timer);
  t.mock.method(controller, 'machineReading', idleMachineReading);
  controller.settings.decisionMode = 'auto';
  controller.settings.architectureProvider = 'codex';
  controller.settings.routineProvider = 'codex';
  controller.settings.designProvider = 'codex';
  controller.agentBridgeUrl = 'http://127.0.0.1:0/mcp';
  controller.targets = ['codex', 'claude', 'grok'].map((id) => ({
    id,
    provider: id as RuntimeTarget['provider'],
    label: id,
    command: 'unused',
    environment: 'native',
    enabled: true,
  }));
  controller.snapshots = controller.targets.map((target) => ({
    ...target,
    installed: true,
    status: 'ready',
    models: [{ id: 'test', label: 'test', efforts: ['low', 'medium', 'high'] }],
    capabilities: { execute: true, resume: true, cancel: true, approvals: true },
    quota: {
      status: 'known',
      source: 'fixture',
      observedAt: new Date().toISOString(),
      windows: [
        { id: 'week', label: 'week', usedPercent: 10, resetsAt: new Date(Date.now() + 3600_000).toISOString() },
      ],
    },
    refreshedAt: new Date().toISOString(),
  })) as RuntimeSnapshot[];
  t.mock.method(controller, 'refresh', async () => {});
  const workspace = new Workspace(controller, { autoTick: false });
  const bridge = new AgentBridge(workspace, controller);
  const calls: ExecuteContext[] = [];
  const releases: Array<() => void> = [];
  let parentContext: ExecuteContext;
  let behavior = async (_ctx: ExecuteContext) => 'Synthetic completed analysis';
  const execute = async (ctx: ExecuteContext) => {
    calls.push(ctx);
    ctx.registerSteer?.(async () => {});
    if (!ctx.input.agentChild) {
      parentContext = ctx;
      await new Promise<void>((resolve) => {
        releases.push(resolve);
        ctx.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return { output: 'Parent done' };
    }
    return { output: await behavior(ctx) };
  };
  for (const adapter of [codexAdapter, claudeAdapter, grokAdapter]) t.mock.method(adapter, 'execute', execute);
  t.after(async () => {
    releases.forEach((release) => release());
    await workspace.close();
    await controller.close();
    assert.ok(directory.startsWith(realpathSync.native(tmpdir())) && directory.includes('delegation-graph-test-'));
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    controller,
    workspace,
    bridge,
    directory,
    calls,
    releases,
    setBehavior: (next: typeof behavior) => {
      behavior = next;
    },
    start: async (write = false, swarm = false) => {
      const project = await workspace.createProject(directory);
      const conversation = workspace.createConversation(project.id);
      const result = await workspace.send(conversation.id, {
        content: 'Coordinate independent analysis tasks',
        mode: write ? 'build' : 'chat',
        provider: 'codex',
        permissionMode: write ? 'workspace-write' : 'read-only',
        autoEscalate: false,
        explicitWrite: write,
        executionPolicy: 'cli-first',
        swarm,
      });
      await workspace.tickQueue();
      await until(() => !!parentContext);
      return result.workflow;
    },
    ask: async (tasks: unknown[]) => {
      const reply = await bridge.handle(`Bearer ${parentContext!.agentBridge!.token}`, {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'delegate_many', arguments: { tasks } },
      });
      return (reply.body as { result: { content: { text: string }[] } }).result.content
        .map((item) => item.text)
        .join('\n');
    },
  };
}

async function until(check: () => boolean, tick?: () => Promise<void>) {
  const deadline = Date.now() + 30_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Synthetic task did not reach expected state');
    await tick?.();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const request = (id: string, dependsOn: string[] = []): AgentDelegationRequest => ({
  id,
  dependsOn,
  agent: { label: 'claude', runtimeId: 'claude', provider: 'claude' },
  task: `Analyze ${id}`,
  options: {},
});

test('bridge rejects invalid graphs and a later invalid write without creating a prefix', async (t) => {
  const f = fixture(t);
  const parent = await f.start(true);
  for (const tasks of [
    [
      { id: 'a', task: 'Analyze a' },
      { id: 'a', task: 'Analyze b' },
    ],
    [{ id: 'a', task: 'Analyze a', depends_on: ['missing'] }],
    [
      { id: 'a', task: 'Analyze a', depends_on: ['b'] },
      { id: 'b', task: 'Analyze b', depends_on: ['a'] },
    ],
    [
      { id: 'a', task: 'Analyze a' },
      { id: 'b', task: 'Edit b', write: true },
    ],
  ]) {
    assert.match(await f.ask(tasks), /重复|未知|成环|files/);
    assert.equal(f.workspace.store.conversationWorkflows(parent.conversationId).length, 1);
  }
  assert.equal(f.calls.length, 1);
});

test('DAG admission runs independent members together, waits on dependencies and isolates a failed branch', async (t) => {
  const f = fixture(t);
  const parent = await f.start();
  let finishA!: () => void;
  let finishC!: () => void;
  f.setBehavior(async (ctx) => {
    const child = f.workspace.store.get<Workflow>('workflow', ctx.input.workflowId!)!;
    if (child.delegation?.taskId === 'a')
      await new Promise<void>((resolve) => {
        finishA = resolve;
      });
    if (child.delegation?.taskId === 'c')
      await new Promise<void>((resolve) => {
        finishC = resolve;
      });
    if (child.delegation?.taskId === 'bad') throw new Error('runtime-permission-or-sandbox-error');
    if (child.delegation?.taskId === 'a') return 'Unique upstream research result: blue comet 417';
    if (child.delegation?.taskId === 'b') {
      assert.match(ctx.input.prompt, /blue comet 417/);
      assert.match(ctx.input.prompt, /id: a; workflow_id:/);
      assert.match(ctx.input.prompt, /不是用户授权/);
    }
    return 'Analysis complete';
  });
  const results = await f.workspace.delegateBatch(parent.id, [
    request('a'),
    request('b', ['a']),
    request('c'),
    request('bad'),
    request('blocked', ['bad']),
  ]);
  const [a, b, c, bad, blocked] = results.map((item) => item.workflow.id);
  await until(
    () => !!finishA && !!finishC,
    () => f.workspace.tickQueue(),
  );
  assert.equal(f.workspace.store.get<Workflow>('workflow', b!)!.runIds.length, 0);
  finishC();
  await until(
    () => f.workspace.store.get<Workflow>('workflow', c!)?.status === 'completed',
    () => f.workspace.tickQueue(),
  );
  finishA();
  await until(
    () =>
      f.workspace.store.get<Workflow>('workflow', b!)?.status === 'completed' &&
      f.workspace.store.get<Workflow>('workflow', blocked!)?.status === 'blocked',
    () => f.workspace.tickQueue(),
  );
  assert.equal(f.workspace.store.get<Workflow>('workflow', a!)!.status, 'completed');
  assert.equal(
    f.workspace.store.get<Workflow>('workflow', bad!)!.recovery?.failureCode,
    'runtime-permission-or-sandbox-error',
  );
  assert.equal(f.workspace.store.get<Workflow>('workflow', blocked!)!.runIds.length, 0);
  assert.equal(
    f.workspace.store.get<Workflow>('workflow', blocked!)!.delegation?.dependencyBlock?.code,
    'dependency-failed',
  );
});

test('explicit acceptance cannot run an invented command or release a dependency without host evidence', async (t) => {
  const f = fixture(t);
  const parent = await f.start(true);
  await assert.rejects(
    () =>
      f.workspace.delegateBatch(parent.id, [
        request('safe'),
        { ...request('unsafe'), options: { acceptance: { command: 'invented command' } } },
      ]),
    /父任务/,
  );
  assert.equal(f.workspace.store.conversationWorkflows(parent.conversationId).length, 1);
  const [first, second] = await f.workspace.delegateBatch(parent.id, [
    { ...request('first'), options: { acceptance: { criteria: 'Host must verify this result' } } },
    request('second', ['first']),
  ]);
  await until(
    () => f.workspace.store.get<Workflow>('workflow', second!.workflow.id)?.status === 'blocked',
    () => f.workspace.tickQueue(),
  );
  assert.equal(f.workspace.store.get<Workflow>('workflow', first!.workflow.id)!.status, 'completed');
  assert.equal(f.workspace.store.get<Workflow>('workflow', second!.workflow.id)!.runIds.length, 0);
  assert.equal(
    f.workspace.store.get<Workflow>('workflow', second!.workflow.id)!.delegation?.dependencyBlock?.code,
    'dependency-unverified',
  );
});

test('batch registration failure never launches a partial prefix and cleans up its workflow messages', async (t) => {
  const f = fixture(t);
  const parent = await f.start();
  const send = f.workspace.send.bind(f.workspace);
  let calls = 0;
  t.mock.method(f.workspace, 'send', async (...args: Parameters<Workspace['send']>) => {
    calls++;
    const result = await send(...args);
    await f.workspace.tickQueue();
    if (calls === 2) throw new Error('Synthetic enqueue failure after saving');
    return result;
  });
  await assert.rejects(() => f.workspace.delegateBatch(parent.id, [request('a'), request('b')]), /Synthetic enqueue/);
  assert.equal(f.workspace.store.conversationWorkflows(parent.conversationId).length, 1);
  assert.equal(
    f.workspace.store.allMessages(parent.conversationId).filter((item) => item.workflowId !== parent.id).length,
    0,
  );
  assert.equal(f.calls.length, 1);
});

test('cancelled dependencies and a completed or restarted parent prevent downstream launch', async (t) => {
  const f = fixture(t);
  const parent = await f.start();
  const [a, b] = await f.workspace.delegateBatch(parent.id, [request('a'), request('b', ['a'])]);
  f.workspace.cancel(a!.workflow.id);
  await until(
    () => f.workspace.store.get<Workflow>('workflow', b!.workflow.id)?.status === 'blocked',
    () => f.workspace.tickQueue(),
  );
  assert.equal(f.workspace.store.get<Workflow>('workflow', b!.workflow.id)!.runIds.length, 0);
  const [closedChild] = await f.workspace.delegateBatch(parent.id, [request('closed-parent')]);
  // Simulate a retained legacy terminal parent: current execution waits for its children before completing.
  const terminal = f.workspace.store.get<Workflow>('workflow', parent.id)!;
  terminal.status = 'completed';
  f.workspace.store.save('workflow', terminal.id, terminal.conversationId, terminal);
  await f.workspace.tickQueue();
  assert.equal(
    f.workspace.store.get<Workflow>('workflow', closedChild!.workflow.id)!.delegation?.dependencyBlock?.code,
    'parent-closed',
  );
  const restarted = workflow({
    id: 'restarted-parent',
    status: 'running',
    conversationId: parent.conversationId,
    projectId: parent.projectId,
    runIds: [],
    plan: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  f.workspace.store.save('workflow', restarted.id, restarted.conversationId, restarted);
  new WorkspaceStore(f.controller.store.db);
  assert.equal(f.workspace.store.get<Workflow>('workflow', restarted.id)!.status, 'interrupted');
  assert.equal(
    delegationDependencyGate(
      workflow(),
      f.workspace.store.get<Workflow>('workflow', restarted.id),
      () => undefined,
      () => undefined,
    ).state,
    'blocked',
  );
});

test('legacy delegate_many payloads remain usable and stable IDs cannot create a duplicate execution', async (t) => {
  const f = fixture(t);
  const parent = await f.start();
  const reply = await f.ask([
    { agent: 'claude', task: 'Analyze the first part' },
    { agent: 'grok', task: 'Analyze the second part' },
  ]);
  assert.equal([...reply.matchAll(/task_id: ([\da-f-]{36})/g)].length, 2);
  const results = await f.workspace.delegateBatch(parent.id, [request('stable')]);
  await assert.rejects(() => f.workspace.delegateBatch(parent.id, [request('stable')]), /id 已用于/);
  assert.equal(results[0]!.workflow.delegation?.taskId, 'stable');
});

test('concurrent batches reserve stable IDs before any asynchronous enqueue', async (t) => {
  const f = fixture(t);
  const parent = await f.start();
  const outcomes = await Promise.allSettled([
    f.workspace.delegateBatch(parent.id, [request('same')]),
    f.workspace.delegateBatch(parent.id, [request('same')]),
  ]);
  assert.equal(outcomes.filter((item) => item.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter((item) => item.status === 'rejected').length, 1);
  assert.equal(
    f.workspace.store.conversationWorkflows(parent.conversationId).filter((item) => item.delegation?.taskId === 'same')
      .length,
    1,
  );
});

test('unchanged host authentication failures cannot repeatedly create an automatic replacement run', async (t) => {
  const f = fixture(t);
  const parent = await f.start();
  parent.input.autoEscalate = true;
  f.workspace.store.save('workflow', parent.id, parent.conversationId, parent);
  t.mock.method(f.controller, 'accountRelay', (input: RunInput, previous: RunRecord) =>
    previous.status === 'failed' ? { ...input } : undefined,
  );
  f.setBehavior(async () => {
    throw new Error('authentication-required');
  });
  const [child] = await f.workspace.delegateBatch(parent.id, [request('auth')]);
  await until(
    () => f.workspace.store.get<Workflow>('workflow', child!.workflow.id)?.status === 'blocked',
    () => f.workspace.tickQueue(),
  );
  const failed = f.workspace.store.get<Workflow>('workflow', child!.workflow.id)!;
  assert.equal(failed.runIds.length, 1);
  assert.equal(failed.recovery?.failureCode, 'authentication-required');
  assert.match(failed.recovery!.recoveryCondition, /登录|账号/);
  f.setBehavior(async () => 'Completed after user supplied account information');
  const continued = await f.workspace.continue(failed.id, 'The account is fixed. Continue the analysis.');
  await until(
    () => f.workspace.store.get<Workflow>('workflow', continued.workflow.id)?.status === 'completed',
    () => f.workspace.tickQueue(),
  );
  assert.equal(f.workspace.store.get<Workflow>('workflow', continued.workflow.id)!.runIds.length, 1);
});

test('queued DAG writers retain overlap exclusion and recheck the caller permission', async (t) => {
  const f = fixture(t);
  const parent = await f.start(true);
  const writers = [request('first-writer'), request('second-writer')].map((item) => ({
    ...item,
    options: { write: true, files: ['shared.txt'] },
  }));
  let finishFirst!: () => void;
  f.setBehavior(async () => {
    await new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    return 'No file changes requested';
  });
  const [first, second] = await f.workspace.delegateBatch(parent.id, writers);
  await until(
    () => !!finishFirst,
    () => f.workspace.tickQueue(),
  );
  const waiting = f.workspace.store.get<Workflow>('workflow', second!.workflow.id)!;
  assert.equal(waiting.runIds.length, 0);
  assert.equal(waiting.status, 'waiting-resource');
  const currentParent = f.workspace.store.get<Workflow>('workflow', parent.id)!;
  currentParent.input.permissionMode = 'read-only';
  f.workspace.store.save('workflow', currentParent.id, currentParent.conversationId, currentParent);
  await f.workspace.tickQueue();
  assert.equal(f.workspace.store.get<Workflow>('workflow', second!.workflow.id)!.status, 'blocked');
  assert.equal(f.workspace.store.get<Workflow>('workflow', second!.workflow.id)!.runIds.length, 0);
  assert.equal(f.workspace.store.get<Workflow>('workflow', first!.workflow.id)!.delegation?.scope?.[0], 'shared.txt');
  finishFirst();
});

test('DAG delegation keeps strict routing rules and an unapproved parent command stays unexecuted', async (t) => {
  const f = fixture(t);
  const parent = await f.start(true);
  const conversation = f.workspace.store.get<Conversation>('conversation', parent.conversationId)!;
  conversation.routing = {
    text: 'Synthetic adult-category material stays on Grok',
    rules: [
      {
        topic: 'adult',
        target: { runtimeId: 'grok', provider: 'grok' },
        strict: true,
        model: 'test',
        effort: 'medium',
      },
    ],
    chapterAgents: false,
    mask: false,
    updatedAt: timestamp,
  };
  f.workspace.store.save('conversation', conversation.id, conversation.projectId, conversation);
  parent.routingContext = undefined;
  parent.input.verificationCommand = 'unapproved verification candidate';
  f.workspace.store.save('workflow', parent.id, parent.conversationId, parent);
  const [child] = await f.workspace.delegateBatch(parent.id, [
    {
      ...request('routed'),
      task: '分析这一段性爱描写的结构',
      options: { write: true, files: ['synthetic.txt'], acceptance: { command: parent.input.verificationCommand } },
    },
  ]);
  assert.equal(child!.workflow.input.runtimeId, 'grok');
  assert.equal(child!.workflow.input.verificationCommand, undefined);
  await until(
    () => f.calls.some((ctx) => ctx.input.workflowId === child!.workflow.id),
    () => f.workspace.tickQueue(),
  );
  const execution = f.calls.find((ctx) => ctx.input.workflowId === child!.workflow.id)!;
  assert.equal(execution.target.id, 'grok');
  assert.equal(execution.input.verificationCommand, undefined);
});

test('a late batch publication failure restores the pre-existing parent task list', async (t) => {
  const f = fixture(t);
  const parent = await f.start(false, true);
  f.workspace.setTaskList(parent.id, [{ id: 'kept', title: 'Keep original plan', kind: 'read' }]);
  const save = f.workspace.store.save.bind(f.workspace.store);
  let failed = false;
  t.mock.method(f.workspace.store, 'save', (kind: string, id: string, owner: string, value: unknown) => {
    if (
      !failed &&
      kind === 'workflow' &&
      id === parent.id &&
      (value as Workflow).taskList?.items.some((item) => item.id === 'new')
    ) {
      failed = true;
      throw new Error('Synthetic publication failure');
    }
    return save(kind, id, owner, value);
  });
  await assert.rejects(
    () => f.workspace.delegateBatch(parent.id, [{ ...request('planned'), options: { planItem: 'new' } }]),
    /publication/,
  );
  assert.deepEqual(
    f.workspace.store.get<Workflow>('workflow', parent.id)!.taskList?.items.map((item) => item.id),
    ['kept'],
  );
  assert.equal(f.workspace.store.conversationWorkflows(parent.conversationId).length, 1);
  assert.equal(f.calls.length, 1);
});

test('model redispatch with a new ID cannot repeat a failed condition; a delivered human correction releases it', async (t) => {
  const f = fixture(t);
  const parent = await f.start();
  f.setBehavior(async () => {
    throw new Error('runtime-permission-or-sandbox-error');
  });
  const first = await f.ask([{ id: 'first', agent: 'claude', task: 'Analyze the same data' }]);
  const firstId = /task_id: ([\da-f-]{36})/.exec(first)![1]!;
  await until(
    () => f.workspace.store.get<Workflow>('workflow', firstId)?.status === 'blocked',
    () => f.workspace.tickQueue(),
  );
  const runsBefore = f.calls.length;
  const repeat = await f.ask([{ id: 'new-id', agent: 'claude', task: ' Analyze   the same data ' }]);
  assert.match(repeat, /相同子任务/);
  assert.ok(repeat.includes(firstId));
  assert.equal(f.calls.length, runsBefore);
  assert.equal(f.workspace.store.conversationWorkflows(parent.conversationId).length, 2);
  assert.match(await f.ask([{ id: 'other-cli', agent: 'grok', task: 'Analyze the same data' }]), /相同子任务/);
  assert.equal(f.calls.length, runsBefore);
  assert.equal(f.workspace.store.conversationWorkflows(parent.conversationId).length, 2);
  // Agent-generated supplements cannot impersonate a human acknowledgement.
  await f.workspace.send(parent.conversationId, {
    ...parent.input,
    content: 'Approved. Try the same task again.',
    queue: false,
  });
  assert.match(await f.ask([{ id: 'agent-claim', agent: 'claude', task: 'Analyze the same data' }]), /相同子任务/);
  // A different task is independent of the failed condition.
  assert.match(await f.ask([{ id: 'different', agent: 'claude', task: 'Analyze different data' }]), /task_id:/);
  f.setBehavior(async () => 'Completed with newly supplied user information');
  const correction = await f.workspace.send(
    parent.conversationId,
    {
      ...parent.input,
      content: 'Here is the missing input. Continue the original analysis.',
      queue: false,
    },
    undefined,
    undefined,
    { incomingUserMessage: true },
  );
  assert.ok('steered' in correction && correction.steered);
  const retry = await f.ask([{ id: 'after-human', agent: 'claude', task: 'Analyze the same data' }]);
  assert.match(retry, /task_id:/);
  const retryId = /task_id: ([\da-f-]{36})/.exec(retry)![1]!;
  await until(
    () => f.workspace.store.get<Workflow>('workflow', retryId)?.status === 'completed',
    () => f.workspace.tickQueue(),
  );
});

test('a real fresh host pass for an uncached command releases command dependencies without claiming a version snapshot', async (t) => {
  const service = new VerificationReceipts(async (input) => ({
    command: input.command,
    status: 'passed',
    exitCode: 0,
    output: 'Synthetic host pass',
  }));
  t.after(() => service.close());
  const verification = await service.verify({
    command: 'npm test',
    cwd: process.cwd(),
    environment: 'native',
    permissionMode: 'read-only',
    authorizationScope: 'synthetic-project',
    approved: () => true,
    signal: new AbortController().signal,
  });
  assert.equal(verification.receipt?.stable, false);
  assert.equal(verification.receipt?.snapshot, undefined);
  assert.equal(verification.receipt?.reused, false);
  const dependency = workflow({
    id: 'dependency',
    status: 'completed',
    runIds: ['run'],
    delegation: { ...workflow().delegation!, acceptance: { command: 'npm test' } },
  });
  const gate = (value: typeof verification) =>
    delegationDependencyGate(
      workflow(),
      workflow({ status: 'running' }),
      () => dependency,
      () => run({ verification: value }),
    );
  assert.equal(gate(verification).state, 'ready');
  assert.equal(
    gate({ ...verification, receipt: { ...verification.receipt!, snapshot: 'changed', stable: false } }).state,
    'blocked',
  );
  assert.equal(gate({ ...verification, receipt: { ...verification.receipt!, reused: true } }).state, 'blocked');
});

test('two failures of one host condition cap rewritten model tasks until a real human supplement', async (t) => {
  const f = fixture(t);
  const parent = await f.start();
  f.setBehavior(async () => {
    throw new Error('runtime-permission-or-sandbox-error');
  });
  for (const [index, task] of ['Analyze customer data', 'Check the required input another way'].entries()) {
    const reply = await f.ask([{ id: `attempt-${index}`, agent: 'claude', task }]);
    const id = /task_id: ([\da-f-]{36})/.exec(reply)![1]!;
    await until(
      () => f.workspace.store.get<Workflow>('workflow', id)?.status === 'blocked',
      () => f.workspace.tickQueue(),
    );
  }
  const before = f.calls.length;
  const third = await f.ask([{ id: 'third-wording', agent: 'claude', task: 'Try a completely rewritten request' }]);
  assert.match(third, /同一宿主条件已有 2 次失败/);
  assert.equal(f.calls.length, before);
  assert.equal(f.workspace.store.conversationWorkflows(parent.conversationId).length, 3);
  await f.workspace.send(
    parent.conversationId,
    {
      ...parent.input,
      content: 'I supplied the missing local information. Continue the remaining task.',
      queue: false,
    },
    undefined,
    undefined,
    { incomingUserMessage: true },
  );
  f.setBehavior(async () => 'Completed after the host accepted a human correction');
  const resumed = await f.ask([
    { id: 'after-correction', agent: 'claude', task: 'Try a completely rewritten request' },
  ]);
  assert.match(resumed, /task_id:/);
  const id = /task_id: ([\da-f-]{36})/.exec(resumed)![1]!;
  await until(
    () => f.workspace.store.get<Workflow>('workflow', id)?.status === 'completed',
    () => f.workspace.tickQueue(),
  );
});

test('dependency reports disable may-log text-only input while normal privacy routing still delivers them', async (t) => {
  const f = await freeStage2Fixture(t);
  const marker = 'PRIVATE_DEPENDENCY_SOURCE_FILE_CONTENT';
  const sourceMessage = f.workspace.store.addMessage(f.conversation.id, 'assistant', marker, 'dependency');
  const dependency = workflow({
    id: 'dependency',
    status: 'completed',
    conversationId: f.conversation.id,
    projectId: f.project.id,
    finalMessageId: sourceMessage.id,
    delegation: undefined,
  });
  f.workspace.store.save('workflow', dependency.id, dependency.conversationId, dependency);
  const user = f.workspace.store.addMessage(f.conversation.id, 'user', 'Summarize the research');
  const child = workflow({
    id: 'downstream',
    projectId: f.project.id,
    conversationId: f.conversation.id,
    userMessageId: user.id,
    input: {
      content: 'Summarize the research',
      intentText: 'Summarize the research',
      mode: 'chat',
      permissionMode: 'read-only',
      executionPolicy: 'cli-first',
    },
  });
  const build = (
    f.workspace as unknown as { input: (item: Workflow, project: typeof f.project, prompt: string) => RunInput }
  ).input.bind(f.workspace);
  const input = build(child, f.project, 'Normal downstream prompt');
  assert.match(input.prompt, /PRIVATE_DEPENDENCY_SOURCE_FILE_CONTENT/);
  assert.equal(input.textOnlyPrompt, undefined);
  const seen: ExecuteContext[] = [];
  t.mock.method(piAdapter, 'execute', async (ctx: ExecuteContext) => {
    seen.push(ctx);
    return { output: 'Synthetic private answer' };
  });
  const decision = f.controller.preview(input);
  assert.equal(sourceMayLog(f.controller.targets.find((target) => target.id === decision.runtimeId)!), false);
  await f.controller.start(input);
  assert.equal(seen.length, 1);
  assert.match(seen[0]!.input.prompt, /PRIVATE_DEPENDENCY_SOURCE_FILE_CONTENT/);
  assert.equal(sourceMayLog(seen[0]!.target), false);
  await assert.rejects(() => f.controller.start({ ...input, runtimeId: 'hosted', automaticExecutorSelection: false }));
  assert.equal(seen.length, 1, 'a fixed may-log choice is rejected before a model call instead of silently rerouting');
  const ordinary = build(
    { ...child, delegation: { ...child.delegation!, dependsOn: [] } },
    f.project,
    'Private assembled context',
  );
  assert.match(ordinary.textOnlyPrompt!, /Summarize the research/);
  assert.doesNotMatch(ordinary.textOnlyPrompt!, /PRIVATE_DEPENDENCY/);
});
