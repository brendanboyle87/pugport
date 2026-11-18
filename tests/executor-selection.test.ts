import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { Controller } from '../src/server/controller.ts';
import { Workspace } from '../src/server/workspace.ts';
import { codexAdapter } from '../src/server/adapters/codex.ts';
import { grokAdapter } from '../src/server/adapters/grok.ts';
import type {
  ExecuteContext,
  ExecuteResult,
  MessageInput,
  RuntimeSnapshot,
  RuntimeTarget,
  Workflow,
} from '../src/shared/types.ts';

const base: MessageInput = {
  content: '  请检查这个项目。\n保留这行用户原文。  ',
  mode: 'chat',
  permissionMode: 'read-only',
  executionPolicy: 'cli-only',
  autoEscalate: true,
  runtimeId: 'selection-grok',
  provider: 'grok',
  model: 'grok-4',
  effort: 'low',
};

async function until(predicate: () => boolean, label: string) {
  for (let attempt = 0; attempt < 250; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Synthetic executor-selection timeout: ${label}`);
}

async function fixture(t: TestContext) {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'pugport-selection-test-')));
  const oldMemory = process.env.COMBORUNNER_MEMORY_DIR;
  process.env.COMBORUNNER_MEMORY_DIR = join(directory, 'memory');
  const targets: RuntimeTarget[] = ['grok', 'codex'].map((provider) => ({
    id: `selection-${provider}`,
    provider: provider as 'grok' | 'codex',
    label: `Synthetic ${provider}`,
    command: 'never-spawned',
    environment: 'native',
    enabled: true,
    accountFingerprint: `synthetic-${provider}`,
  }));
  const snapshots: RuntimeSnapshot[] = targets.map((target) => ({
    id: target.id,
    provider: target.provider,
    label: target.label,
    environment: 'native',
    installed: true,
    status: 'ready',
    accountFingerprint: target.accountFingerprint,
    models: [
      { id: target.provider === 'grok' ? 'grok-4' : 'gpt-6-sol', label: 'Synthetic model', efforts: ['low', 'high'] },
    ],
    quota: {
      status: 'known',
      source: 'Synthetic',
      observedAt: new Date().toISOString(),
      windows: [
        { id: 'week', label: 'Week', usedPercent: 10, resetsAt: new Date(Date.now() + 86400000).toISOString() },
      ],
    },
    capabilities: { execute: true, resume: true, cancel: true, approvals: true },
    refreshedAt: new Date().toISOString(),
  }));
  const controller = new Controller(directory, join(directory, 'data'), {
    readAccountIdentity: (target) => target.accountFingerprint,
  });
  clearInterval(controller.timer);
  controller.settings.taskJudgment = 'local';
  controller.settings.toolApprovalMode = 'auto';
  controller.targets = targets;
  controller.snapshots = snapshots;
  t.mock.method(controller, 'refresh', async () => {});
  const calls: ExecuteContext[] = [];
  let behavior: (context: ExecuteContext) => Promise<ExecuteResult> = async () => ({ output: 'Synthetic finished.' });
  for (const adapter of [grokAdapter, codexAdapter]) {
    t.mock.method(adapter, 'discover', async (target: RuntimeTarget) =>
      snapshots.find((snapshot) => snapshot.id === target.id)!,
    );
    t.mock.method(adapter, 'execute', async (context: ExecuteContext) => {
      calls.push(context);
      return behavior(context);
    });
  }
  const workspace = new Workspace(controller, { autoTick: false });
  const project = await workspace.createProject(directory);
  const conversation = workspace.createConversation(project.id);
  t.after(async () => {
    await workspace.close();
    await controller.close();
    if (oldMemory === undefined) delete process.env.COMBORUNNER_MEMORY_DIR;
    else process.env.COMBORUNNER_MEMORY_DIR = oldMemory;
    assert.equal(dirname(directory).toLowerCase(), realpathSync.native(tmpdir()).toLowerCase());
    assert.ok(basename(directory).startsWith('pugport-selection-test-'));
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    workspace,
    controller,
    conversation,
    calls,
    behavior: (next: typeof behavior) => {
      behavior = next;
    },
    flow: (id: string) => workspace.store.get<Workflow>('workflow', id)!,
  };
}

test('an idle selection applies without model execution and repeating it is unchanged', async (t) => {
  const f = await fixture(t);
  const selected = { runtimeId: 'selection-codex', provider: 'codex' as const, model: 'gpt-6-sol', effort: 'high' };
  assert.equal((await f.workspace.selectExecutor(f.conversation.id, selected)).state, 'applied');
  assert.equal((await f.workspace.selectExecutor(f.conversation.id, selected)).state, 'unchanged');
  assert.equal(f.calls.length, 0);
});

test('read-only live switch starts a fresh executor in the same workflow and preserves exact human source', async (t) => {
  const f = await fixture(t);
  f.behavior(async (context) => {
    if (context.target.provider !== 'grok')
      return { output: 'New executor completed.', nativeSessionId: 'new-session' };
    context.emit({ at: new Date().toISOString(), type: 'text', text: 'Observed partial answer.' });
    return new Promise((resolve) => {
      context.signal.addEventListener(
        'abort',
        () => resolve({ output: 'Observed partial answer.', nativeSessionId: 'old-session' }),
        { once: true },
      );
    });
  });
  const sent = await f.workspace.send(f.conversation.id, base);
  await f.workspace.tickQueue();
  await until(() => f.calls.length === 1, 'first executor started');
  const result = await f.workspace.selectExecutor(f.conversation.id, {
    runtimeId: 'selection-codex',
    provider: 'codex',
    model: 'gpt-6-sol',
    effort: 'high',
  });
  assert.equal(result.state, 'switching');
  assert.ok(result.requestedAt);
  assert.equal(f.flow(sent.workflow.id).selectionSwitch?.state, 'switching');
  await until(() => !f.controller.active.size, 'old read-only executor settled');
  await f.workspace.tickQueue();
  await until(() => f.calls.length === 2, 'new executor actually started');
  assert.equal(f.flow(sent.workflow.id).selectionSwitch?.state, 'continued');
  assert.equal(f.calls[1]!.input.workflowId, sent.workflow.id);
  assert.equal(f.calls[1]!.target.id, 'selection-codex');
  assert.equal(f.calls[1]!.nativeSessionId, undefined);
  assert.match(f.calls[1]!.input.prompt, /Observed partial answer\./);
  const recorded = f.controller.store.runSummaries().filter((record) => record.workflowId === sent.workflow.id);
  assert.equal(recorded.length, 2);
  for (const record of recorded) assert.equal(record.userInput, base.content);
  assert.equal(f.workspace.store.messages(f.conversation.id).filter((message) => message.role === 'user').length, 1);
});

test('fixed to automatic selection lets the current executor finish without cancellation or replay', async (t) => {
  const f = await fixture(t);
  let release!: () => void;
  f.behavior(async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return { output: 'Original executor finished.' };
  });
  const sent = await f.workspace.send(f.conversation.id, base);
  await f.workspace.tickQueue();
  await until(() => f.calls.length === 1, 'executor started');
  const result = await f.workspace.selectExecutor(f.conversation.id, {});
  assert.equal(result.state, 'finishing-current');
  assert.equal(f.calls[0]!.signal.aborted, false);
  release();
  await until(
    () => ['completed', 'blocked', 'failed'].includes(f.flow(sent.workflow.id).status),
    'current workflow finished',
  );
  await f.workspace.tickQueue();
  assert.equal(f.calls.length, 1);
});

test('the latest fixed choice wins while the fresh executor is awaiting admission', async (t) => {
  const f = await fixture(t);
  f.behavior(async (context) => {
    if (context.target.provider !== 'grok') return { output: 'Newest selection completed.' };
    return new Promise((resolve) => {
      context.signal.addEventListener('abort', () => resolve({ output: 'Settled old progress.' }), { once: true });
    });
  });
  let release!: () => void;
  let admissionWaiting = false;
  const originalStart = f.controller.start.bind(f.controller);
  t.mock.method(f.controller, 'start', async (...args: Parameters<Controller['start']>) => {
    if (args[0].relayReason === 'selection' && !admissionWaiting) {
      admissionWaiting = true;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }
    return originalStart(...args);
  });
  const sent = await f.workspace.send(f.conversation.id, base);
  await f.workspace.tickQueue();
  await until(() => f.calls.length === 1, 'old executor started');
  f.workspace.selectExecutor(f.conversation.id, {
    runtimeId: 'selection-codex',
    provider: 'codex',
    model: 'gpt-6-sol',
    effort: 'low',
  });
  await until(() => admissionWaiting, 'first replacement awaiting admission');
  await new Promise((resolve) => setTimeout(resolve, 2));
  const newest = f.workspace.selectExecutor(f.conversation.id, {
    runtimeId: 'selection-codex',
    provider: 'codex',
    model: 'gpt-6-sol',
    effort: 'high',
  });
  release();
  await until(() => f.calls.length === 2, 'latest replacement actually started');
  assert.equal(f.calls[1]!.route.effort, 'high');
  assert.equal(f.flow(sent.workflow.id).selectionSwitch?.requestedAt, newest.requestedAt);
  assert.equal(f.flow(sent.workflow.id).selectionSwitch?.state, 'continued');
  assert.equal(f.calls.length, 2, 'the superseded fixed choice never starts a model turn');
  assert.equal(f.workspace.store.messages(f.conversation.id).filter((message) => message.role === 'user').length, 1);
});

test('a newer fixed choice retains the stopped source while child settlement is awaited', async (t) => {
  const f = await fixture(t);
  f.behavior(async (context) => {
    if (context.target.provider !== 'grok') return { output: 'Latest choice completed.' };
    return new Promise((resolve) => {
      context.signal.addEventListener('abort', () => resolve({ output: 'Settled source output.' }), { once: true });
    });
  });
  let release!: () => void;
  let settling = false;
  const original = (f.workspace as any).settleHandoffChildren.bind(f.workspace);
  t.mock.method(f.workspace as any, 'settleHandoffChildren', async (...args: unknown[]) => {
    if (!settling) {
      settling = true;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }
    return original(...args);
  });
  const sent = await f.workspace.send(f.conversation.id, base);
  await f.workspace.tickQueue();
  await until(() => f.calls.length === 1, 'old executor started');
  const first = f.workspace.selectExecutor(f.conversation.id, {
    runtimeId: 'selection-codex',
    provider: 'codex',
    model: 'gpt-6-sol',
    effort: 'low',
  });
  await until(() => settling, 'source terminal and child settlement paused');
  assert.equal(f.controller.activeRunFor(sent.workflow.id), undefined);
  const sourceId = f.flow(sent.workflow.id).selectionSwitch?.fromRunId;
  const newest = f.workspace.selectExecutor(f.conversation.id, {
    runtimeId: 'selection-codex',
    provider: 'codex',
    model: 'gpt-6-sol',
    effort: 'high',
  });
  assert.equal(f.flow(sent.workflow.id).selectionSwitch?.fromRunId, sourceId);
  assert.notEqual(newest.requestedAt, first.requestedAt);
  release();
  await until(() => f.calls.length === 2, 'latest replacement after settlement');
  assert.equal(f.calls[1]!.route.effort, 'high');
  assert.equal(f.flow(sent.workflow.id).selectionSwitch?.state, 'continued');
  assert.equal(f.calls.length, 2);
});

test('a choice made in the terminal cleanup window applies without replay or a stale switching status', async (t) => {
  const f = await fixture(t);
  let selected: ReturnType<Workspace['selectExecutor']> | undefined;
  const selectDuringCleanup = () => {
    if (selected) return;
    const finished = [...f.controller.active.values()].find((entry) => entry.run.status === 'completed');
    if (!finished) return;
    assert.equal(f.controller.activeRunFor(finished.run.workflowId!), undefined);
    selected = f.workspace.selectExecutor(f.conversation.id, {
      runtimeId: 'selection-codex',
      provider: 'codex',
      model: 'gpt-6-sol',
      effort: 'high',
    });
  };
  f.controller.on('execution-capacity', selectDuringCleanup);
  t.after(() => f.controller.off('execution-capacity', selectDuringCleanup));
  const sent = await f.workspace.send(f.conversation.id, base);
  await f.workspace.tickQueue();
  await until(() => !!selected, 'selection made before terminal native cleanup finished');
  assert.equal(selected!.state, 'applied');
  await until(() => f.flow(sent.workflow.id).status === 'completed', 'original task completed');
  assert.equal(f.flow(sent.workflow.id).selectionSwitch, undefined);
  assert.equal(f.calls.length, 1, 'a finished turn never replays only to apply future options');
});
