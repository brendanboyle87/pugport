import { settledWorkflow as finished, workflowState } from './helpers/workflow-state.ts';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, sep } from 'node:path';
import { Controller } from '../src/server/controller.ts';
import { Workspace } from '../src/server/workspace.ts';
import { codexAdapter } from '../src/server/adapters/codex.ts';
import { claudeAdapter } from '../src/server/adapters/claude.ts';
import type { ExecuteContext, MessageInput, RunRecord, RuntimeSnapshot, Workflow } from '../src/shared/types.ts';

const input: MessageInput = {
  content: 'Check all synthetic batches and finish the requested report.',
  mode: 'build',
  permissionMode: 'workspace-write',
  executionPolicy: 'cli-first',
  runtimeId: 'mock',
  autoEscalate: true,
};
function fixture(t: TestContext) {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'pugport-continuation-')));
  const oldMemory = process.env.COMBORUNNER_MEMORY_DIR;
  process.env.COMBORUNNER_MEMORY_DIR = join(directory, 'memory');
  const controller = new Controller(directory, join(directory, 'data'));
  clearInterval(controller.timer);
  controller.settings.taskJudgment = 'local';
  controller.targets = [
    { id: 'mock', provider: 'codex', label: 'Synthetic', command: 'unused', environment: 'native', enabled: true },
  ];
  const snapshot: RuntimeSnapshot = {
    id: 'mock',
    provider: 'codex',
    label: 'Synthetic',
    environment: 'native',
    installed: true,
    status: 'ready',
    authMode: 'chatgpt',
    accountFingerprint: 'synthetic-account',
    models: [{ id: 'mock-model', label: 'Mock', efforts: ['medium', 'high'] }],
    quota: {
      status: 'known',
      source: 'fixture',
      observedAt: new Date().toISOString(),
      windows: [{ id: 'week', label: 'Week', usedPercent: 10, resetsAt: new Date(Date.now() + 3600000).toISOString() }],
    },
    capabilities: { execute: true, resume: true, cancel: true, approvals: true },
    refreshedAt: new Date().toISOString(),
  };
  controller.snapshots = [snapshot];
  t.mock.method(codexAdapter, 'discover', async () => structuredClone(controller.snapshots[0]!));
  const workspace = new Workspace(controller, { memoryDebounceMs: 100000 });
  t.after(async () => {
    await workspace.close();
    await controller.close();
    if (oldMemory === undefined) delete process.env.COMBORUNNER_MEMORY_DIR;
    else process.env.COMBORUNNER_MEMORY_DIR = oldMemory;
    assert.ok(
      directory.startsWith(realpathSync.native(tmpdir()) + sep) &&
        basename(directory).startsWith('pugport-continuation-'),
    );
    rmSync(directory, { recursive: true, force: true });
  });
  return { controller, workspace, directory };
}

function progress(ctx: ExecuteContext, id: string) {
  ctx.emit({
    at: new Date().toISOString(),
    type: 'tool',
    data: { itemId: id, kind: 'commandExecution', status: 'completed', exitCode: 0 },
  });
}
function result(
  status: 'partial' | 'completed' | 'blocked',
  summary = 'First batch done, remaining batches pending.',
  question?: { text: string; options?: string[] },
) {
  return {
    nativeSessionId: 'synthetic-session',
    output: `${summary}\nCOMBORUNNER_TASK_RESULT: ${JSON.stringify({ status, summary, ...(question ? { question } : {}) })}`,
  };
}
async function conversation(f: ReturnType<typeof fixture>) {
  const project = await f.workspace.createProject(f.directory);
  return f.workspace.createConversation(project.id);
}

for (const pinned of [false, true])
  test(`failed lookup continues twice in its own session without changing model: pinned=${pinned}`, async (t) => {
    const f = fixture(t);
    const calls: ExecuteContext[] = [];
    f.controller.snapshots[0]!.models = ['gpt-6-sol', 'gpt-6-astra'].map((id) => ({
      id,
      label: id,
      efforts: ['medium', 'high'],
    }));
    t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
      if (!ctx.input.stepId)
        return {
          output: JSON.stringify({
            steps: [
              { id: 'write', title: '实现报告', instruction: 'Deliver the report', kind: 'general', dependsOn: [] },
            ],
          }),
        };
      calls.push(ctx);
      ctx.emit({
        at: '',
        type: 'tool',
        data: {
          itemId: 'lookup',
          kind: 'commandExecution',
          command: 'rg missing src',
          status: 'completed',
          exitCode: 1,
        },
      });
      return result('partial', `Synthetic scan ${calls.length}; report still pending.`);
    });
    const c = await conversation(f);
    const sent = await f.workspace.send(c.id, {
      ...input,
      runtimeId: pinned ? 'mock' : undefined,
      model: pinned ? 'gpt-6-sol' : undefined,
    });
    const flow = await finished(f.workspace, sent.workflow.id);
    assert.equal(flow.status, 'blocked');
    assert.equal(calls.length, 3);
    assert.match(flow.error!, /已自动继续 2 次仍未完成/);
    assert.doesNotMatch(flow.error!, /本轮有可写工具失败或未确认结束/);
    for (let n = 1; n <= 2; n++) {
      const previous = f.controller.store.run(flow.plan[0]!.runIds[n - 1]!)!;
      const event = previous.events.find((event) => event.data?.automaticContinuation === n)!;
      assert.match(event.text!, new RegExp(`自动继续第 ${n} 次`));
      assert.equal(event.data?.resumeRunId, previous.id);
      assert.equal(calls[n]!.input.resumeRunId, previous.id);
      assert.equal(calls[n]!.nativeSessionId, 'synthetic-session');
      for (const key of ['runtimeId', 'model', 'accountFingerprint'] as const)
        assert.equal(calls[n]!.route[key], calls[0]!.route[key]);
      assert.match(calls[n]!.input.prompt, /只核对现状、读资料或写计划不算完成/);
    }
  });

for (const scenario of ['owner', 'question', 'approval', 'attempt-cap', 'account', 'selection'] as const)
  test(`same-session continuation respects ${scenario}`, async (t) => {
    const f = fixture(t);
    let calls = 0;
    t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
      calls++;
      progress(ctx, 'scan');
      if (scenario === 'question')
        f.workspace.setUserQuestion(ctx.input.workflowId!, {
          text: 'Synthetic choice?',
          options: [],
          askedAt: new Date().toISOString(),
        });
      if (scenario === 'approval') ctx.emit({ at: '', type: 'approval' });
      if (scenario === 'account') f.controller.snapshots[0]!.accountFingerprint = 'different-account';
      if (scenario === 'attempt-cap') {
        const flow = f.workspace['active'].get(ctx.input.workflowId!)!.workflow;
        flow.runIds.push(...Array.from({ length: 7 }, (_, n) => `synthetic-attempt-${n}`));
      }
      if (scenario === 'selection') {
        f.workspace['active'].get(ctx.input.workflowId!)!.workflow.selectionSwitch = {
          state: 'switching',
          runtimeLabel: 'Synthetic unavailable',
          requestedAt: new Date().toISOString(),
          fromRunId: [...f.controller.active.keys()][0],
          selection: { runtimeId: 'unavailable' },
        };
      }
      return scenario === 'owner'
        ? result('blocked', '需要主人决定用哪个方案', { text: 'Which plan?', options: ['A', 'B'] })
        : result('partial', 'Synthetic work remains.');
    });
    const c = await conversation(f);
    const sent = await f.workspace.send(c.id, { ...input, permissionMode: 'workspace-write' });
    const flow = await finished(f.workspace, sent.workflow.id);
    assert.equal(flow.status, 'blocked');
    if (scenario === 'owner') assert.equal(flow.userQuestion?.text, 'Which plan?');
    assert.equal(calls, 1);
    assert.ok(
      flow.runIds.every((id) => !f.controller.store.run(id)?.events.some((event) => event.data?.automaticContinuation)),
    );
  });

test('partial real progress continues in the same account/session and retains each attempt', async (t) => {
  const f = fixture(t),
    calls: ExecuteContext[] = [];
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    calls.push(ctx);
    queueMicrotask(() => f.controller.broadcast());
    ctx.emit({
      at: '',
      type: 'tool',
      data: { itemId: `batch-${calls.length}`, kind: 'commandExecution', status: 'inProgress' },
    });
    const active = [...f.controller.active.values()].find((entry) => entry.run.workflowId === ctx.input.workflowId)!;
    f.controller.recordRunEvent(active.run.id, {
      at: '',
      type: 'tool',
      data: { tool: 'organize_files', journal: 'synthetic-journal' },
    });
    progress(ctx, `batch-${calls.length}`);
    return result(calls.length === 1 ? 'partial' : 'completed');
  });
  const c = await conversation(f);
  const first = await f.workspace.send(c.id, input);
  const flow = await finished(f.workspace, first.workflow.id);
  assert.equal(flow.status, 'completed');
  assert.equal(calls.length, 2);
  assert.equal(flow.runIds.length, 2);
  assert.equal(calls[1]!.nativeSessionId, 'synthetic-session');
  for (const key of ['runtimeId', 'model', 'effort', 'accountFingerprint'] as const)
    assert.equal(calls[1]!.route[key], calls[0]!.route[key]);
  assert.equal(calls[1]!.input.permissionMode, 'workspace-write');
  assert.match(calls[1]!.input.prompt, /不要重放已经执行过的命令或外部操作/);
  assert.ok(f.controller.store.run(flow.runIds[0]!)!.events.some((event) => event.data?.automaticContinuation === 1));
  assert.equal(f.controller.listenerCount('run'), 0);
});

test('quota in a progressing native continuation hands only the unfinished step to another executor', async (t) => {
  const f = fixture(t);
  f.controller.targets.push({
    ...f.controller.targets[0]!,
    id: 'other',
    label: 'Other',
    provider: 'claude',
    enabled: false,
  });
  f.controller.snapshots.push({
    ...structuredClone(f.controller.snapshots[0]!),
    id: 'other',
    provider: 'claude',
    accountFingerprint: 'synthetic-other',
  });
  f.controller.settings.routineProvider = 'codex';
  t.mock.method(f.controller, 'refresh', async () => {});
  const calls: ExecuteContext[] = [];
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    if (!ctx.input.stepId)
      return {
        output: JSON.stringify({
          steps: [
            {
              id: 'batch-step',
              title: 'Synthetic batches',
              instruction: 'Finish the synthetic batches',
              kind: 'general',
              transport: 'auto',
              dependsOn: [],
            },
          ],
        }),
      };
    calls.push(ctx);
    queueMicrotask(() => f.controller.broadcast());
    f.controller.targets[1]!.enabled = true;
    progress(ctx, `finished-batch-${calls.length}`);
    if (calls.length === 1) return result('partial', 'Synthetic first batch completed; second remains.');
    ctx.emit({ at: '', type: 'text', text: 'Synthetic second batch completed before quota.' });
    throw new Error('quota-or-rate-limit');
  });
  t.mock.method(claudeAdapter, 'execute', async (ctx: ExecuteContext) => {
    calls.push(ctx);
    queueMicrotask(() => f.controller.broadcast());
    return result('completed', 'Synthetic remaining work complete.');
  });
  const c = await conversation(f);
  const sent = await f.workspace.send(c.id, { ...input, runtimeId: undefined });
  const flow = await finished(f.workspace, sent.workflow.id);
  assert.equal(flow.status, 'completed');
  assert.deepEqual(
    calls.map((ctx) => ctx.target.id),
    ['mock', 'mock', 'other'],
  );
  assert.equal(calls[1]!.nativeSessionId, 'synthetic-session');
  assert.equal(calls[2]!.nativeSessionId, undefined);
  assert.equal(calls[2]!.input.permissionMode, 'workspace-write');
  // Handoffs carry readable actions and the output tail, not native tool IDs.
  assert.match(calls[2]!.input.prompt, /<<<PUGPORT_HANDOFF_NOTE>>>/);
  assert.match(calls[2]!.input.prompt, /命令 → 退出码 0（2 次）/);
  assert.match(calls[2]!.input.prompt, /Synthetic second batch completed before quota\./);
  assert.doesNotMatch(calls[2]!.input.prompt, /finished-batch-[12]/);
  assert.match(calls[2]!.input.prompt, /不重放已完成/);
  assert.equal(calls[2]!.input.stepId, calls[1]!.input.stepId);
  const quotaRun = flow.runIds
    .map((id) => f.controller.store.run(id)!)
    .find((run) => run.errorCode === 'quota-or-rate-limit')!;
  assert.equal(quotaRun.handoffCheckpoint?.safe, true);
  assert.equal(f.controller.store.run(flow.runIds.at(-1)!)!.relay?.reason, 'quota');
});

test('a quota failure waits for accepted steering to settle before constructing the handoff', async (t) => {
  const f = fixture(t);
  f.controller.settings.steerOnSend = true;
  f.controller.targets.push({
    ...f.controller.targets[0]!,
    id: 'other',
    label: 'Other',
    provider: 'claude',
    enabled: false,
  });
  f.controller.snapshots.push({
    ...structuredClone(f.controller.snapshots[0]!),
    id: 'other',
    provider: 'claude',
    accountFingerprint: 'synthetic-other',
  });
  f.controller.settings.routineProvider = 'codex';
  t.mock.method(f.controller, 'refresh', async () => {});
  let fail!: () => void;
  let receipt!: () => void;
  const calls: ExecuteContext[] = [];
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    if (!ctx.input.stepId)
      return {
        output: JSON.stringify({
          steps: [
            {
              id: 'batch-step',
              title: 'Synthetic batches',
              instruction: 'Finish the synthetic batches',
              kind: 'general',
              transport: 'auto',
              dependsOn: [],
            },
          ],
        }),
      };
    calls.push(ctx);
    queueMicrotask(() => f.controller.broadcast());
    f.controller.targets[1]!.enabled = true;
    ctx.registerSteer?.(async () => {
      await new Promise<void>((resolve) => {
        receipt = resolve;
        queueMicrotask(() => f.controller.broadcast());
        ctx.signal.addEventListener('abort', () => resolve(), { once: true });
      });
    });
    progress(ctx, 'batch-confirmed');
    await new Promise<void>((resolve) => {
      fail = resolve;
      queueMicrotask(() => f.controller.broadcast());
      ctx.signal.addEventListener('abort', () => resolve(), { once: true });
    });
    throw new Error('quota-or-rate-limit');
  });
  t.mock.method(claudeAdapter, 'execute', async (ctx: ExecuteContext) => {
    calls.push(ctx);
    queueMicrotask(() => f.controller.broadcast());
    return result('completed');
  });
  const c = await conversation(f);
  const sent = await f.workspace.send(c.id, { ...input, runtimeId: undefined });
  await workflowState(f.workspace, () => !!fail);
  const delivery = f.workspace.send(c.id, {
    ...input,
    runtimeId: undefined,
    content: '只继续 synthetic 第三批，其余保留。',
  });
  await workflowState(f.workspace, () => !!receipt);
  fail();
  await workflowState(
    f.workspace,
    () =>
      f.controller.run(f.workspace.store.get<Workflow>('workflow', sent.workflow.id)!.runIds.at(-1)!)?.status ===
      'failed',
  );
  assert.equal(calls.length, 1, 'the terminal native status must not bypass an unsettled correction');
  receipt();
  const supplement = await delivery;
  assert.equal(supplement.message.steering?.status, 'accepted');
  assert.equal((await finished(f.workspace, sent.workflow.id)).status, 'completed');
  assert.equal(calls[1]!.target.id, 'other');
  assert.match(calls[1]!.input.prompt, /只继续 synthetic 第三批，其余保留/);
  assert.equal(calls[1]!.nativeSessionId, undefined);
});

test('a writable child registered during handoff discovery must settle before the new executor starts', async (t) => {
  const f = fixture(t);
  f.controller.targets.push({ ...f.controller.targets[0]!, id: 'other', provider: 'claude', enabled: false });
  f.controller.snapshots.push({
    ...structuredClone(f.controller.snapshots[0]!),
    id: 'other',
    provider: 'claude',
    accountFingerprint: 'other-account',
  });
  f.controller.settings.routineProvider = 'codex';
  t.mock.method(f.controller, 'refresh', async () => {});
  const calls: ExecuteContext[] = [];
  let discovering = false,
    release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
    queueMicrotask(() => f.controller.broadcast());
  });
  const originalStart = f.controller.start.bind(f.controller);
  t.mock.method(f.controller, 'start', async (...args: Parameters<Controller['start']>) => {
    if (args[0].relayReason === 'quota' && !discovering) {
      discovering = true;
      queueMicrotask(() => f.controller.broadcast());
      await gate;
    }
    return originalStart(...args);
  });
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    if (!ctx.input.stepId)
      return {
        output: JSON.stringify({
          steps: [
            {
              id: 'report',
              title: 'Report',
              instruction: 'Finish report',
              kind: 'general',
              transport: 'auto',
              dependsOn: [],
            },
          ],
        }),
      };
    calls.push(ctx);
    queueMicrotask(() => f.controller.broadcast());
    progress(ctx, 'confirmed-first-batch');
    f.controller.targets[1]!.enabled = true;
    throw new Error('quota-or-rate-limit');
  });
  t.mock.method(claudeAdapter, 'execute', async (ctx: ExecuteContext) => {
    calls.push(ctx);
    queueMicrotask(() => f.controller.broadcast());
    return result('completed');
  });
  const c = await conversation(f);
  const sent = await f.workspace.send(c.id, { ...input, runtimeId: undefined });
  await workflowState(f.workspace, () => discovering);
  const child: Workflow = {
    ...structuredClone(f.workspace.store.get<Workflow>('workflow', sent.workflow.id)!),
    id: 'synthetic-late-child',
    status: 'running',
    runIds: [],
    input: {
      ...input,
      content: 'Write the separate synthetic appendix',
      intentText: 'Write the separate synthetic appendix',
    },
    delegation: { parentId: sent.workflow.id, role: 'worker', requestId: 'late-appendix' },
  };
  f.workspace.store.save('workflow', child.id, c.id, child);
  for (let index = 0; index < 205; index++) {
    const historical: Workflow = {
      ...structuredClone(child),
      id: `synthetic-history-${index}`,
      status: 'completed',
      delegation: undefined,
      updatedAt: new Date(Date.now() + index + 1000).toISOString(),
    };
    f.workspace.store.save('workflow', historical.id, c.id, historical);
  }
  assert.ok(
    !f.workspace.store.workflows(c.id).some((item) => item.id === child.id),
    'fixture hides the child beyond paginated history',
  );
  release();
  await workflowState(f.workspace, () =>
    /等待可写子任务结束/.test(f.workspace.store.get<Workflow>('workflow', sent.workflow.id)?.scheduling?.reason ?? ''),
  );
  assert.equal(calls.length, 1, 'discovery must not bypass a newly registered writable child');
  // The child finished normally although one of its writes failed once before a retry succeeded. A completed
  // child owns its result, so that intermediate failure must not cancel the parent's handoff.
  const parentRun = f.controller.store.run(
    f.workspace.store.get<Workflow>('workflow', sent.workflow.id)!.runIds.at(-1)!,
  )!;
  const childRun: RunRecord = {
    ...structuredClone(parentRun),
    id: 'synthetic-late-child-run',
    workflowId: child.id,
    status: 'completed',
    errorCode: undefined,
    error: undefined,
    handoffCheckpoint: {
      version: 1,
      source: 'native-tool-results',
      safe: false,
      observedAt: new Date().toISOString(),
      completedToolIds: ['retried-write-2'],
      unconfirmedTools: [{ id: 'retried-write-1', status: 'failed' }],
      blockedReason: 'unconfirmed-tool',
    },
  };
  f.controller.store.saveRun(childRun);
  child.runIds = [childRun.id];
  child.status = 'completed';
  child.finalMessageId = f.workspace.store.addMessage(
    c.id,
    'assistant',
    'The late appendix was verified.',
    child.id,
  ).id;
  f.workspace.store.save('workflow', child.id, c.id, child);
  await f.workspace.tickQueue();
  const flow = await finished(f.workspace, sent.workflow.id);
  assert.equal(flow.status, 'completed');
  assert.equal(calls.length, 3, 'the handoff is followed by one collection of the unread child result');
  assert.match(calls[1]!.input.prompt, /synthetic-late-child；状态 completed/);
  assert.doesNotMatch(calls[1]!.input.prompt, /synthetic-late-child；状态 running/);
  assert.match(calls[2]!.input.prompt, /已收集子任务结果/);
  assert.match(calls[2]!.input.prompt, /The late appendix was verified/);
  assert.equal(calls[2]!.target.id, calls[1]!.target.id);
  assert.equal(calls[2]!.nativeSessionId, 'synthetic-session');
});

test('a child status change after quota handoff cannot replace a native continuation with the old checkpoint prompt', async (t) => {
  const f = fixture(t);
  f.controller.settings.steerOnSend = true;
  f.controller.targets.push({ ...f.controller.targets[0]!, id: 'other', provider: 'claude', enabled: false });
  f.controller.snapshots.push({
    ...structuredClone(f.controller.snapshots[0]!),
    id: 'other',
    provider: 'claude',
    accountFingerprint: 'other-account',
  });
  t.mock.method(f.controller, 'refresh', async () => {});
  const calls: ExecuteContext[] = [];
  let releasePartial!: () => void;
  let releaseResume!: () => void;
  let resuming = false;
  let child!: Workflow;
  const resumeGate = new Promise<void>((resolve) => {
    releaseResume = resolve;
  });
  const originalStart = f.controller.start.bind(f.controller);
  t.mock.method(f.controller, 'start', async (...args: Parameters<Controller['start']>) => {
    if (args[0].resumeRunId) {
      resuming = true;
      await resumeGate;
    }
    return originalStart(...args);
  });
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    if (!ctx.input.stepId)
      return {
        output: JSON.stringify({
          steps: [
            {
              id: 'batch',
              title: 'Batch',
              instruction: 'Finish remaining batches',
              kind: 'general',
              transport: 'auto',
              dependsOn: [],
            },
          ],
        }),
      };
    calls.push(ctx);
    queueMicrotask(() => f.controller.broadcast());
    child = {
      ...structuredClone(f.workspace.store.get<Workflow>('workflow', ctx.input.workflowId!)!),
      id: 'synthetic-observer',
      status: 'running',
      runIds: [],
      input: {
        ...input,
        mode: 'chat',
        permissionMode: 'read-only',
        content: 'Read the independent summary.',
        intentText: 'Read the independent summary.',
      },
      delegation: { parentId: ctx.input.workflowId!, role: 'scout', requestId: 'observer' },
    };
    f.workspace.store.save('workflow', child.id, child.conversationId, child);
    f.controller.targets[1]!.enabled = true;
    progress(ctx, 'confirmed-source-batch');
    throw new Error('quota-or-rate-limit');
  });
  let otherCalls = 0;
  t.mock.method(claudeAdapter, 'execute', async (ctx: ExecuteContext) => {
    calls.push(ctx);
    queueMicrotask(() => f.controller.broadcast());
    if (++otherCalls === 1) {
      ctx.registerSteer?.(async () => {});
      await new Promise<void>((resolve) => {
        releasePartial = resolve;
      });
      progress(ctx, 'confirmed-current-batch');
      return result('partial', 'The current batch was verified; only the final summary remains.');
    }
    progress(ctx, 'confirmed-final-summary');
    return result('completed', 'The narrowed final summary is complete.');
  });
  const c = await conversation(f);
  const sent = await f.workspace.send(c.id, { ...input, runtimeId: undefined });
  await workflowState(
    f.workspace,
    () => !!releasePartial && [...f.controller.active.values()].some((entry) => f.controller.canSteer(entry.run.id)),
  );
  const correction = 'Only finish the current batch and final summary. Leave archived batches unchanged.';
  const steered = await f.workspace.send(c.id, { ...input, runtimeId: undefined, content: correction });
  assert.equal(steered.message.steering?.status, 'accepted');
  releasePartial();
  await workflowState(f.workspace, () => resuming);
  child.status = 'completed';
  child.finalMessageId = f.workspace.store.addMessage(
    c.id,
    'assistant',
    'The independent observer verified the summary.',
    child.id,
  ).id;
  f.workspace.store.save('workflow', child.id, child.conversationId, child);
  releaseResume();
  const flow = await finished(f.workspace, sent.workflow.id);
  assert.equal(flow.status, 'completed');
  assert.deepEqual(
    calls.map((ctx) => ctx.target.id),
    ['mock', 'other', 'other', 'other'],
  );
  assert.equal(calls[1]!.nativeSessionId, undefined, 'the cross-account handoff starts a fresh session');
  assert.equal(calls[2]!.nativeSessionId, 'synthetic-session', 'the next partial result resumes that new account');
  assert.match(calls[2]!.input.prompt, /The current batch was verified; only the final summary remains/);
  assert.ok(
    calls[2]!.input.prompt.includes(correction),
    'the latest accepted scope must survive the child status change',
  );
  assert.equal(calls[2]!.input.stepId, calls[1]!.input.stepId);
  assert.equal(calls[3]!.nativeSessionId, 'synthetic-session', 'collection continues the new account session');
  assert.match(calls[3]!.input.prompt, /已收集子任务结果/);
  assert.match(calls[3]!.input.prompt, /The independent observer verified the summary/);
  assert.ok(calls[3]!.input.prompt.includes(correction), 'collection preserves the accepted narrowed scope');
  assert.match(calls[3]!.input.prompt, /The narrowed final summary is complete/);
  assert.equal(calls[3]!.input.stepId, calls[2]!.input.stepId);
});

test('a queued generic writable child completes under the safely stopped parent lease before quota handoff', async (t) => {
  const f = fixture(t);
  f.controller.targets.push({ ...f.controller.targets[0]!, id: 'other', provider: 'claude', enabled: false });
  f.controller.snapshots.push({
    ...structuredClone(f.controller.snapshots[0]!),
    id: 'other',
    provider: 'claude',
    accountFingerprint: 'other-account',
  });
  t.mock.method(f.controller, 'refresh', async () => {});
  const calls: ExecuteContext[] = [];
  let childId = '';
  let delegated = 0;
  let childWrites = 0;
  let parentHandoffs = 0;
  let collections = 0;
  const plan = (id: string) => ({
    output: JSON.stringify({
      steps: [
        {
          id,
          title: id,
          instruction: 'Finish the specified synthetic report',
          kind: 'general',
          transport: 'auto',
          dependsOn: [],
        },
      ],
    }),
  });
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    assert.equal(ctx.input.agentChild, undefined, 'the exhausted source must not launch its child');
    if (!ctx.input.stepId) return plan('parent-report');
    calls.push(ctx);
    queueMicrotask(() => f.controller.broadcast());
    const child = await f.workspace.delegate(
      ctx.input.workflowId!,
      'worker',
      'Write a synthetic appendix and verify the result.',
      'appendix-once',
    );
    childId = child.workflow.id;
    delegated++;
    assert.equal(child.workflow.input.permissionMode, 'workspace-write');
    assert.equal(
      child.workflow.delegation?.agent,
      undefined,
      'this uses the generic writer path without file-scope sharing',
    );
    await f.workspace.tickQueue();
    assert.equal(childWrites, 0, 'the generic writer cannot run beside its still-running parent');
    f.controller.targets[1]!.enabled = true;
    progress(ctx, 'confirmed-parent-before-quota');
    throw new Error('quota-or-rate-limit');
  });
  t.mock.method(claudeAdapter, 'execute', async (ctx: ExecuteContext) => {
    if (ctx.input.agentChild) {
      if (!ctx.input.stepId) return plan('child-appendix');
      calls.push(ctx);
      queueMicrotask(() => f.controller.broadcast());
      childWrites++;
      const parent = f.workspace.store.get<Workflow>(
        'workflow',
        f.workspace.store.get<Workflow>('workflow', ctx.input.workflowId!)!.delegation!.parentId,
      )!;
      assert.equal(parent.status, 'waiting-resource');
      assert.equal(f.controller.activeRunFor(parent.id), undefined);
      assert.equal(ctx.input.permissionMode, 'workspace-write');
      progress(ctx, 'confirmed-child-appendix');
      return result('completed', 'The synthetic appendix is verified.');
    }
    calls.push(ctx);
    queueMicrotask(() => f.controller.broadcast());
    if (ctx.input.prompt.includes('已收集子任务结果')) {
      collections++;
      assert.equal(f.workspace.store.get<Workflow>('workflow', childId)?.status, 'completed');
      assert.match(ctx.input.prompt, /The synthetic appendix is verified/);
      assert.equal(ctx.nativeSessionId, 'synthetic-session', 'collection resumes the parent handoff session');
      const previous = f.controller.store.run(ctx.input.continuationRunId!)!;
      assert.equal(previous.workflowId, ctx.input.workflowId, 'collection never resumes the child session');
      progress(ctx, 'confirmed-child-integration');
      return result('completed', 'The parent summary includes the verified appendix.');
    }
    parentHandoffs++;
    assert.equal(f.workspace.store.get<Workflow>('workflow', childId)?.status, 'completed');
    assert.match(ctx.input.prompt, new RegExp(`任务 ${childId}；状态 completed`));
    assert.equal(ctx.nativeSessionId, undefined, 'a child native session cannot be imported into its parent handoff');
    progress(ctx, 'confirmed-parent-final-summary');
    return result('completed', 'The parent summary is complete without another delegation.');
  });
  const c = await conversation(f);
  const sent = await f.workspace.send(c.id, { ...input, runtimeId: undefined });
  const flow = await finished(f.workspace, sent.workflow.id);
  assert.equal(flow.status, 'completed');
  assert.equal(delegated, 1);
  assert.equal(childWrites, 1);
  assert.equal(parentHandoffs, 1);
  assert.equal(collections, 1);
  assert.equal(f.workspace.store.get<Workflow>('workflow', childId)?.status, 'completed');
  assert.deepEqual(
    calls.map((ctx) => ctx.target.id),
    ['mock', 'other', 'other', 'other'],
  );
  assert.equal(flow.runIds.length, 4, 'the planner, source, handoff and result collection each consume the run budget');
});

test('a progressing partial workflow automatically continues at most twice', async (t) => {
  const f = fixture(t);
  let calls = 0;
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    progress(ctx, `batch-${++calls}`);
    return result('partial', `Completed batch ${calls}; more remain.`);
  });
  const c = await conversation(f);
  const sent = await f.workspace.send(c.id, input);
  assert.equal((await finished(f.workspace, sent.workflow.id)).status, 'blocked');
  assert.equal(calls, 3);
});

test('unchanged reports, failed writes, denials, changed identity and disabled automation stop continuation', async (t) => {
  for (const scenario of ['no-tools', 'shell-failure', 'denied', 'identity', 'disabled', 'same-report']) {
    await t.test(scenario, async (t) => {
      const f = fixture(t);
      let calls = 0;
      t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
        calls++;
        if (scenario === 'denied') ctx.emit({ at: '', type: 'status', data: { decision: 'deny' } });
        for (let i = 0; i < 1100; i++) ctx.emit({ at: '', type: 'text', text: '.' });
        if (scenario !== 'no-tools') progress(ctx, `batch-${calls}`);
        if (scenario === 'shell-failure')
          ctx.emit({ at: '', type: 'tool', data: { itemId: 'bad', kind: 'commandExecution', status: 'failed' } });
        if (scenario === 'identity') f.controller.snapshots[0]!.accountFingerprint = 'different-account';
        return result('partial');
      });
      const c = await conversation(f);
      const sent = await f.workspace.send(c.id, { ...input, autoEscalate: scenario !== 'disabled' });
      // Two rounds persist 2,200 events; allow for disk contention in the concurrent Windows suite.
      const stopped = await finished(f.workspace, sent.workflow.id);
      assert.equal(stopped.status, 'blocked');
      if (scenario === 'shell-failure') assert.match(stopped.error!, /变更结果尚未核实/);
      assert.equal(calls, ['same-report', 'no-tools'].includes(scenario) ? 2 : 1);
    });
  }
});

test('a failed read-only decode does not stop a turn with other successful read-only progress', async (t) => {
  const f = fixture(t);
  let calls = 0;
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    progress(ctx, `batch-${++calls}`);
    if (calls === 1)
      ctx.emit({ at: '', type: 'tool', data: { itemId: 'bad-decode', kind: 'commandExecution', status: 'failed' } });
    return result(calls === 1 ? 'partial' : 'completed');
  });
  const c = await conversation(f);
  const sent = await f.workspace.send(c.id, { ...input, permissionMode: 'read-only' });
  assert.equal((await finished(f.workspace, sent.workflow.id)).status, 'completed');
  assert.equal(calls, 2);
});

test('accepted steering remains in the continuation prompt and current task scope', async (t) => {
  const f = fixture(t),
    calls: ExecuteContext[] = [];
  f.controller.settings.steerOnSend = true;
  let release!: () => void;
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    calls.push(ctx);
    queueMicrotask(() => f.controller.broadcast());
    if (calls.length === 1) {
      ctx.registerSteer?.(async () => {});
      await new Promise<void>((resolve) => {
        release = resolve;
        queueMicrotask(() => f.controller.broadcast());
      });
    }
    progress(ctx, `batch-${calls.length}`);
    return result(calls.length === 1 ? 'partial' : 'completed');
  });
  const c = await conversation(f);
  const sent = await f.workspace.send(c.id, input);
  await workflowState(
    f.workspace,
    () => !!release && [...f.controller.active.values()].some((entry) => f.controller.canSteer(entry.run.id)),
  );
  const correction = '只处理 batch-A，batch-B 保持原样。';
  const steered = await f.workspace.send(c.id, { ...input, content: correction });
  assert.equal(steered.message.steering?.status, 'accepted');
  release();
  assert.equal((await finished(f.workspace, sent.workflow.id)).status, 'completed');
  assert.equal(calls.length, 2);
  assert.ok(calls[1]!.input.prompt.includes(correction));
  assert.equal(calls[1]!.nativeSessionId, 'synthetic-session');
});

test('a queued user task or cancellation prevents automatically extending the previous task', async (t) => {
  for (const scenario of ['queued', 'cancelled']) {
    await t.test(scenario, async (t) => {
      const f = fixture(t);
      f.controller.settings.steerOnSend = false;
      let release!: () => void,
        calls = 0;
      t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
        calls++;
        if (calls === 1)
          await new Promise<void>((resolve) => {
            release = resolve;
            queueMicrotask(() => f.controller.broadcast());
          });
        progress(ctx, `batch-${calls}`);
        return result(calls === 1 ? 'partial' : 'completed');
      });
      const c = await conversation(f);
      const sent = await f.workspace.send(c.id, input);
      await workflowState(f.workspace, () => !!release);
      const later =
        scenario === 'queued'
          ? await f.workspace.send(c.id, { ...input, content: 'Read the synthetic summary as a separate request.' })
          : undefined;
      if (scenario === 'cancelled') f.workspace.cancel(sent.workflow.id);
      release();
      const first = await finished(f.workspace, sent.workflow.id);
      assert.equal(first.runIds.length, 1);
      assert.equal(first.status, scenario === 'cancelled' ? 'cancelled' : 'blocked');
      if (later) assert.equal((await finished(f.workspace, later.workflow.id)).status, 'completed');
      assert.equal(calls, scenario === 'cancelled' ? 1 : 2);
    });
  }
});

test('a user request queued during continuation discovery wins before any new run starts', async (t) => {
  const f = fixture(t);
  f.controller.settings.steerOnSend = false;
  f.controller.settings.maxConcurrentRuns = 1;
  let calls = 0,
    discovering = false,
    resumedStart = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
    queueMicrotask(() => f.controller.broadcast());
  });
  const originalStart = f.controller.start.bind(f.controller);
  const catalog = structuredClone(f.controller.snapshots[0]!.models);
  t.mock.method(f.controller, 'start', async (...args: Parameters<Controller['start']>) => {
    if (args[0].resumeRunId) {
      resumedStart = true;
      f.controller.snapshots[0]!.models = [];
    }
    return originalStart(...args);
  });
  t.mock.method(f.controller, 'refresh', async () => {
    if (!resumedStart) return;
    discovering = true;
    queueMicrotask(() => f.controller.broadcast());
    await gate;
    f.controller.snapshots[0]!.models = catalog;
  });
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    progress(ctx, `batch-${++calls}`);
    return result(calls === 1 ? 'partial' : 'completed');
  });
  const c = await conversation(f);
  const sent = await f.workspace.send(c.id, input);
  await workflowState(f.workspace, () => discovering);
  assert.equal(calls, 1);
  const next = await f.workspace.send(c.id, { ...input, content: 'Process the newly requested synthetic report.' });
  release();
  const original = await finished(f.workspace, sent.workflow.id);
  assert.equal(original.runIds.length, 1, 'the superseded continuation never reserves a new run');
  assert.ok(['blocked', 'cancelled'].includes(original.status));
  assert.equal((await finished(f.workspace, next.workflow.id)).status, 'completed');
  assert.equal(calls, 2, 'only the original turn and the new user request execute');
  assert.equal(f.controller.active.size, 0);
});

test('a generic worker uses its own intent to narrow the writable parent permission', async (t) => {
  const f = fixture(t),
    calls: ExecuteContext[] = [];
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    calls.push(ctx);
    queueMicrotask(() => f.controller.broadcast());
    return result('completed');
  });
  const c = await conversation(f);
  const sent = await f.workspace.send(c.id, { ...input, intentText: 'Update the synthetic report.' });
  await finished(f.workspace, sent.workflow.id);
  const child = await f.workspace.delegate(sent.workflow.id, 'worker', '不要改，只检查报告。', 'readonly-child');
  assert.equal((await finished(f.workspace, child.workflow.id)).status, 'completed');
  assert.equal(calls[0]!.input.permissionMode, 'workspace-write');
  assert.equal(calls[1]!.input.permissionMode, 'read-only');
});

test('generic children get independent native context and never replace the main conversation session', async (t) => {
  const f = fixture(t),
    calls: ExecuteContext[] = [];
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    calls.push(ctx);
    queueMicrotask(() => f.controller.broadcast());
    return { ...result('completed'), nativeSessionId: ctx.input.agentChild ? 'child-session' : 'main-session' };
  });
  const c = await conversation(f);
  const sent = await f.workspace.send(c.id, input);
  await finished(f.workspace, sent.workflow.id);
  const child = await f.workspace.delegate(
    sent.workflow.id,
    'scout',
    '只读检查 synthetic 报告。',
    'independent-context',
  );
  assert.equal((await finished(f.workspace, child.workflow.id)).status, 'completed');
  assert.equal(calls[1]!.input.agentChild, true);
  assert.equal(calls[1]!.nativeSessionId, undefined, 'the child never resumes the main native session');
  const next = await f.workspace.send(c.id, { ...input, content: 'Continue the synthetic main report.' });
  assert.equal((await finished(f.workspace, next.workflow.id)).status, 'completed');
  assert.equal(calls[2]!.nativeSessionId, 'main-session', 'a later main turn never resumes a child native session');
});

test('manual continuation keeps the complete original scope even without native resume', async (t) => {
  const f = fixture(t),
    calls: ExecuteContext[] = [];
  f.controller.snapshots[0]!.capabilities.resume = false;
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    calls.push(ctx);
    queueMicrotask(() => f.controller.broadcast());
    return { output: result(calls.length === 1 ? 'blocked' : 'completed').output };
  });
  const c = await conversation(f);
  const original = `Check the explicitly authorized fixture ${join(f.directory, 'early-authorized-folder')}.\n${'Synthetic description. '.repeat(500)}`;
  const sent = await f.workspace.send(c.id, { ...input, content: original });
  await finished(f.workspace, sent.workflow.id);
  const next = await f.workspace.continue(sent.workflow.id, '继续');
  assert.equal((await finished(f.workspace, next.workflow.id)).status, 'completed');
  assert.equal(calls[1]!.nativeSessionId, undefined);
  assert.ok(calls[1]!.input.prompt.includes(original));
  assert.equal(calls[1]!.input.permissionMode, 'workspace-write');
});

test('auto writable action questions stay writable on continue, while prior or current prohibitions stay read-only', async (t) => {
  for (const scenario of ['writable', 'prior-readonly', 'current-readonly']) {
    await t.test(scenario, async (t) => {
      const f = fixture(t),
        calls: ExecuteContext[] = [];
      t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
        calls.push(ctx);
        queueMicrotask(() => f.controller.broadcast());
        return result(calls.length === 1 ? 'blocked' : 'completed');
      });
      const c = await conversation(f);
      const sent = await f.workspace.send(c.id, {
        ...input,
        mode: 'auto',
        content: scenario === 'prior-readonly' ? '只看不改' : '可以去分类了吗？',
      });
      await finished(f.workspace, sent.workflow.id);
      assert.equal(calls[0]!.input.permissionMode, scenario === 'prior-readonly' ? 'read-only' : 'workspace-write');
      const next = await f.workspace.continue(sent.workflow.id, scenario === 'current-readonly' ? '只看不改' : '继续');
      await finished(f.workspace, next.workflow.id);
      assert.equal(calls[1]!.input.permissionMode, scenario === 'writable' ? 'workspace-write' : 'read-only');
    });
  }
});

test('Continue accepts explicitWrite without a toggle and preserves readonly boundaries', async (t) => {
  for (const boundary of ['writable', 'readonly-chip', 'named-role', 'untrusted']) {
    await t.test(boundary, async (t) => {
      const f = fixture(t),
        calls: ExecuteContext[] = [];
      f.controller.snapshots[0]!.capabilities.toolless = true;
      t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
        calls.push(ctx);
        queueMicrotask(() => f.controller.broadcast());
        return result('blocked');
      });
      const c = await conversation(f);
      const sent = await f.workspace.send(c.id, {
        ...input,
        mode: 'auto',
        content: '只看' + '不改',
        explicitWrite: false,
        ...(boundary === 'named-role' ? { agentPresetId: 'code-review' } : {}),
        ...(boundary === 'untrusted' ? { untrustedContent: true } : {}),
      });
      await finished(f.workspace, sent.workflow.id);
      assert.equal(calls[0]!.input.permissionMode, 'read-only');
      const next = await f.workspace.continue(sent.workflow.id, '继续', {
        explicitWrite: boundary !== 'readonly-chip',
        permissionReauthorized: false,
        ...(boundary === 'readonly-chip' ? { permissionMode: 'read-only' } : {}),
      });
      await finished(f.workspace, next.workflow.id);
      const expected = boundary === 'writable' ? 'workspace-write' : 'read-only';
      assert.equal(next.workflow.input.permissionMode, expected);
      assert.equal(calls[1]!.input.permissionMode, expected);
      if (boundary === 'writable') assert.equal(calls[1]!.nativeSessionId, undefined);
    });
  }
});

test('quoted live and queued supplements retain pure user intent through manual continuation', async (t) => {
  for (const queued of [false, true])
    await t.test(queued ? 'queued' : 'direct', async (t) => {
      const f = fixture(t),
        calls: ExecuteContext[] = [];
      f.controller.settings.steerOnSend = true;
      let release!: () => void;
      t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
        calls.push(ctx);
        queueMicrotask(() => f.controller.broadcast());
        if (calls.length === 1) {
          ctx.registerSteer?.(async () => {});
          await new Promise<void>((resolve) => {
            release = resolve;
            queueMicrotask(() => f.controller.broadcast());
          });
        }
        return result(calls.length === 1 ? 'blocked' : 'completed');
      });
      const c = await conversation(f);
      const sent = await f.workspace.send(c.id, { ...input, content: '更新 synthetic 报告。' });
      await workflowState(
        f.workspace,
        () => !!release && [...f.controller.active.values()].some((e) => f.controller.canSteer(e.run.id)),
      );
      if (queued) calls[0]!.registerSteer?.(undefined, { state: 'waiting' });
      const quoted = await f.workspace.send(c.id, {
        ...input,
        content: '',
        quotes: [{ text: '不要修改。这是引用的旧要求。', note: '这份可以修复，再分别处理其余报告。' }],
      });
      if (queued) {
        calls[0]!.registerSteer?.(async () => {});
        await f.workspace.steerQueued(quoted.workflow.id);
      }
      const saved = f.workspace.store.get<Workflow>('workflow', sent.workflow.id)!;
      assert.equal(saved.input.intentText, '更新 synthetic 报告。\n\n这份可以修复，再分别处理其余报告。');
      assert.ok(!saved.input.intentText.includes('不要修改'));
      assert.ok(saved.input.content.includes('> 不要修改'));
      release();
      await finished(f.workspace, sent.workflow.id);
      const continued = await f.workspace.continue(sent.workflow.id);
      assert.equal((await finished(f.workspace, continued.workflow.id)).status, 'completed');
      assert.equal(calls[1]!.input.permissionMode, 'workspace-write');
      assert.ok(calls[1]!.input.prompt.includes('这份可以修复'));
    });
});

test('revocation is durable even when the replacement message fails to save, so Continue cannot revive writes', async (t) => {
  const f = fixture(t),
    calls: ExecuteContext[] = [];
  f.controller.settings.steerOnSend = false;
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    calls.push(ctx);
    queueMicrotask(() => f.controller.broadcast());
    if (calls.length === 1)
      await new Promise<void>((resolve) => {
        ctx.signal.addEventListener('abort', () => resolve(), { once: true });
        if (ctx.signal.aborted) resolve();
      });
    return result('completed');
  });
  const c = await conversation(f);
  const sent = await f.workspace.send(c.id, input);
  await workflowState(f.workspace, () => calls.length === 1);
  const saveMessage = t.mock.method(f.workspace.store, 'addMessage', () => {
    throw Error('Synthetic message save failure');
  });
  await assert.rejects(
    f.workspace.send(c.id, { ...input, mode: 'auto', explicitWrite: false, content: '只看不改' }),
    /Synthetic message save failure/,
  );
  saveMessage.mock.restore();
  await finished(f.workspace, sent.workflow.id);
  const stopped = f.workspace.store.get<Workflow>('workflow', sent.workflow.id)!;
  assert.equal(stopped.input.permissionMode, 'read-only');
  assert.match(stopped.input.intentText!, /只看不改/);
  const continued = await f.workspace.continue(sent.workflow.id, '继续');
  await finished(f.workspace, continued.workflow.id);
  assert.equal(calls[1]!.input.permissionMode, 'read-only');
});

test('an explicit Continue repairs a proven legacy quote downgrade without modifying old audit or reusing its read-only session', async (t) => {
  const f = fixture(t),
    calls: ExecuteContext[] = [];
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    calls.push(ctx);
    queueMicrotask(() => f.controller.broadcast());
    return result(calls.length === 1 ? 'blocked' : 'completed');
  });
  const c = await conversation(f);
  const sent = await f.workspace.send(c.id, {
    ...input,
    content: '',
    quotes: [{ text: '不要删除。这是旧说明。', note: '把已确认的 synthetic 重复文件回收。' }],
    autoEscalate: false,
  });
  await finished(f.workspace, sent.workflow.id);
  const legacy = f.workspace.store.get<Workflow>('workflow', sent.workflow.id)!;
  legacy.input.intentText = legacy.input.content;
  legacy.input.permissionMode = 'read-only';
  f.workspace.store.save('workflow', legacy.id, c.id, legacy);
  const oldRun = f.controller.run(legacy.runIds[0]!)!;
  oldRun.permissionMode = 'read-only';
  f.controller.store.saveRun(oldRun);
  const continued = await f.workspace.continue(legacy.id);
  assert.equal((await finished(f.workspace, continued.workflow.id)).status, 'completed');
  assert.match(continued.notice, /已纠正旧任务的引用误判/);
  assert.equal(calls[1]!.input.permissionMode, 'workspace-write');
  assert.equal(calls[1]!.nativeSessionId, undefined);
  assert.equal(f.controller.run(oldRun.id)!.permissionMode, 'read-only');
  assert.equal(f.workspace.store.get<Workflow>('workflow', legacy.id)!.input.permissionMode, 'read-only');
});

test('command handoff skips source completion checks and continues the workflow with context', async (t) => {
  const f = fixture(t);
  f.controller.targets.push({ ...f.controller.targets[0]!, id: 'next', label: 'Next synthetic executor' });
  f.controller.snapshots.push({
    ...structuredClone(f.controller.snapshots[0]!),
    id: 'next',
    accountFingerprint: 'next-account',
  });
  t.mock.method(f.controller, 'refresh', async () => {});
  const calls: ExecuteContext[] = [];
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    if (!ctx.input.stepId)
      return {
        output: JSON.stringify({
          steps: [
            { id: 'report', title: 'Report', instruction: 'Finish synthetic report', kind: 'general', dependsOn: [] },
          ],
        }),
      };
    calls.push(ctx);
    if (calls.length === 1) {
      ctx.input.requiresFileChanges = true;
      ctx.emit({
        at: new Date().toISOString(),
        type: 'tool',
        data: {
          toolCallId: 'denied',
          tool: 'powershell',
          status: 'failed',
          commandNotExecuted: true,
        },
      });
      assert.equal(ctx.commandDenied?.(), true);
      return result('partial', 'Captured synthetic context, command still required.');
    }
    assert.equal(ctx.input.needsLocalPrograms, true);
    assert.ok(ctx.input.prompt.includes('Captured synthetic context'));
    assert.ok(ctx.input.relayFromRunId);
    return result('completed', 'Synthetic report delivered.');
  });
  const c = await conversation(f);
  const sent = await f.workspace.send(c.id, { ...input, runtimeId: undefined });
  const flow = await finished(f.workspace, sent.workflow.id);
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0]!.route.runtimeId, calls[1]!.route.runtimeId);
  assert.equal(flow.status, 'completed');
});
