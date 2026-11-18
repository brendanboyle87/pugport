import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { Controller } from '../src/server/controller.ts';
import { Store } from '../src/server/store.ts';
import { Workspace } from '../src/server/workspace.ts';
import { codexAdapter } from '../src/server/adapters/codex.ts';
import { chineseSteeringPrompt } from './helpers/steering-expectations.ts';
import type {
  ConversationMessage,
  ExecuteContext,
  MessageInput,
  RuntimeSnapshot,
  Workflow,
} from '../src/shared/types.ts';

const base: MessageInput = {
  content: 'Explain the synthetic project.',
  mode: 'chat',
  permissionMode: 'read-only',
  runtimeId: 'mock',
  model: 'mock-model',
  effort: 'low',
  executionPolicy: 'cli-only',
  autoEscalate: false,
};
const snapshot = (): RuntimeSnapshot => ({
  id: 'mock',
  provider: 'codex',
  label: 'Synthetic',
  environment: 'native',
  installed: true,
  status: 'ready',
  authMode: 'chatgpt',
  accountFingerprint: 'synthetic-account',
  models: [{ id: 'mock-model', label: 'Synthetic', efforts: ['low', 'high'] }],
  quota: {
    status: 'known',
    source: 'fixture',
    observedAt: new Date().toISOString(),
    windows: [{ id: 'week', label: 'week', usedPercent: 1, resetsAt: new Date(Date.now() + 3600000).toISOString() }],
  },
  capabilities: { execute: true, resume: true, cancel: true, approvals: true, steer: true },
  refreshedAt: new Date().toISOString(),
});
async function until(predicate: () => boolean) {
  for (let i = 0; i < 300; i++) {
    if (predicate()) return;
    await new Promise((done) => setTimeout(done, 10));
  }
  throw new Error('Synthetic fixture did not settle.');
}
async function fixture(t: TestContext, firstInput = base, searchEnabled = false, trusted = false) {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'studio-queued-steering-')));
  const memoryDirectory = realpathSync.native(mkdtempSync(join(tmpdir(), 'studio-queued-steering-memory-')));
  const previousMemoryDirectory = process.env.COMBORUNNER_MEMORY_DIR;
  process.env.COMBORUNNER_MEMORY_DIR = memoryDirectory;
  const data = join(directory, 'data');
  // Seed isolated account paths before Controller construction. Every discovery,
  // identity read and execution used here is synthetic; no real CLI is launched.
  const target = {
    id: 'mock',
    provider: 'codex' as const,
    label: 'Synthetic',
    command: 'unused',
    accountId: 'synthetic',
    accountHome: join(directory, 'account'),
    environment: 'native' as const,
    enabled: true,
  };
  const seed = new Store(data);
  seed.setConfig('targets', [target]);
  seed.close();
  let identity = 'synthetic-account';
  const controller = new Controller(directory, data, {
    readAccountIdentity: () => identity,
    nativeLogin: { pending: () => false },
  });
  // Steering concurrency is independent of the test runner's CPU and memory pressure.
  t.mock.method(controller, 'machineReading', () => ({
    sampledAt: Date.now(),
    totalBytes: 32 * 1024 ** 3,
    cpus: 16,
    availableMemoryBytes: 16 * 1024 ** 3,
    cpuPercent: 20,
  }));
  clearInterval(controller.timer);
  controller.targets = [target];
  controller.snapshots = [snapshot()];
  if (searchEnabled) {
    t.mock.method(controller.webSearch, 'available', () => true);
    controller.agentBridgeUrl = 'http://127.0.0.1:4317/mcp';
  }
  t.mock.method(codexAdapter, 'discover', async () => snapshot());
  let ctx: ExecuteContext | undefined;
  let release!: () => void;
  let launches = 0;
  t.mock.method(codexAdapter, 'execute', async (context: ExecuteContext) => {
    launches++;
    ctx = context;
    await new Promise<void>((done) => {
      release = done;
      context.signal.addEventListener('abort', () => done(), { once: true });
    });
    context.registerSteer?.(undefined);
    return { output: 'Synthetic result', nativeSessionId: 'synthetic-session' };
  });
  const workspace = new Workspace(controller, { autoTick: false });
  if (trusted) controller.isTrustedProjectPath = () => true;
  const project = await workspace.createProject(directory);
  project.localMemory = { exportEnabled: false, cliEnabled: false };
  workspace.store.save('project', project.id, project.id, project);
  const conversation = workspace.createConversation(project.id);
  t.after(async () => {
    await workspace.close();
    await controller.close();
    for (const path of [directory, memoryDirectory]) {
      const cleanup = resolve(path);
      assert.ok(cleanup.startsWith(realpathSync.native(tmpdir()) + sep));
      assert.ok(basename(cleanup).startsWith('studio-queued-steering-'));
      rmSync(cleanup, { recursive: true, force: true });
    }
    if (previousMemoryDirectory === undefined) delete process.env.COMBORUNNER_MEMORY_DIR;
    else process.env.COMBORUNNER_MEMORY_DIR = previousMemoryDirectory;
  });
  const first = await workspace.send(conversation.id, firstInput);
  await workspace.tickQueue();
  await until(() => !!ctx);
  return {
    workspace,
    controller,
    project,
    conversation,
    first,
    ctx: ctx!,
    release: () => release(),
    launches: () => launches,
    setIdentity: (value: string) => {
      identity = value;
    },
    flow: (id: string) => workspace.store.get<Workflow>('workflow', id)!,
    message: (id: string) => workspace.store.get<ConversationMessage>('message', id)!,
  };
}
async function manualQueue(f: Awaited<ReturnType<typeof fixture>>, content = 'Include one more synthetic example.') {
  f.ctx.registerSteer?.(undefined, { state: 'waiting', reason: 'Synthetic temporary pause' });
  const queued = await f.workspace.send(f.conversation.id, { ...base, content });
  assert.equal(queued.workflow.pendingSteer, undefined);
  return queued;
}

test('local steering revokes only search and aborts its live signal without stopping the native task', async (t) => {
  const f = await fixture(t, { ...base, content: 'Read current public docs' }, true);
  const bridge = f.ctx.agentBridge!;
  assert.ok(bridge);
  assert.ok(bridge.extraTools?.includes('web_search'));
  assert.ok(bridge.extraTools?.includes('web_fetch'));
  const before = f.controller.agentBridgeCaller(bridge.token)!;
  assert.equal(before.webSearch, true);
  assert.equal(before.webSearchSignal?.aborted, false);
  f.ctx.registerSteer?.(async () => {});
  assert.equal(
    await f.controller.steer(f.flow(f.first.workflow.id).runIds[0]!, '不要进行联网搜索，只分析本地文件'),
    true,
  );
  const after = f.controller.agentBridgeCaller(bridge.token)!;
  assert.equal(after.webSearch, undefined);
  assert.equal(before.webSearchSignal?.aborted, true);
  assert.equal(after.signal.aborted, false);
  assert.equal(f.ctx.signal.aborted, false);
});

test('a trusted write turn Codex runs with full access gets no PugPort web search', async (t) => {
  const write = {
    ...base,
    content: 'Read current public docs',
    mode: 'build',
    permissionMode: 'workspace-write',
  } as const;
  const f = await fixture(t, write, true, true);
  assert.equal(f.ctx.trustedProject, true);
  assert.ok(f.ctx.agentBridge);
  assert.equal(f.ctx.agentBridge.extraTools?.includes('web_search'), false);
  assert.equal(f.controller.agentBridgeCaller(f.ctx.agentBridge.token)!.webSearch, undefined);
  f.release();
});

test('initial search prohibitions never receive a search grant', async (t) => {
  const f = await fixture(t, { ...base, content: 'Do not use web search. Read local docs.' }, true);
  assert.ok(f.ctx.agentBridge);
  assert.equal(f.controller.agentBridgeCaller(f.ctx.agentBridge.token)?.webSearch, undefined);
});

test('auto-steer defaults on; switching it off queues unless the message explicitly steers', async (t) => {
  const f = await fixture(t);
  assert.equal(f.controller.settings.steerOnSend, true);
  const received: string[] = [];
  f.ctx.registerSteer?.(async (prompt) => {
    received.push(prompt);
  });
  f.controller.settings.steerOnSend = false;
  const queued = await f.workspace.send(f.conversation.id, { ...base, content: 'Independent task.' });
  assert.notEqual(queued.workflow.id, f.first.workflow.id);
  assert.equal(queued.workflow.pendingSteer, undefined);
  assert.deepEqual(received, []);
  const correction = await f.workspace.send(f.conversation.id, { ...base, queue: false, content: 'Correction.' });
  assert.equal(correction.workflow.id, f.first.workflow.id);
  assert.equal(correction.message.steering?.status, 'accepted');
  assert.deepEqual(received, ['Correction.'].map(chineseSteeringPrompt));
  f.controller.settings.steerOnSend = true;
  f.conversation.queueingEnabled = false;
  f.workspace.store.save('conversation', f.conversation.id, f.project.id, f.conversation);
  const explicit = await f.workspace.send(f.conversation.id, { ...base, queue: true, content: 'Explicitly wait.' });
  assert.notEqual(explicit.workflow.id, f.first.workflow.id);
  assert.equal(explicit.workflow.pendingSteer, undefined);
  assert.deepEqual(received, ['Correction.'].map(chineseSteeringPrompt));
});

test('a permission change creates a successor with current progress and never upgrades the live session', async (t) => {
  const f = await fixture(t);
  const received: string[] = [];
  f.ctx.registerSteer?.(async (prompt) => {
    received.push(prompt);
  });
  const next = await f.workspace.send(f.conversation.id, {
    ...base,
    mode: 'build',
    permissionMode: 'workspace-write',
    content: '那你倒是移动啊',
  });
  assert.equal(next.workflow.parentWorkflowId, f.first.workflow.id);
  assert.equal(next.workflow.input.permissionMode, 'workspace-write');
  assert.equal(f.ctx.input.permissionMode, 'read-only');
  assert.equal(f.ctx.signal.aborted, false);
  assert.deepEqual(received, []);
  assert.equal(f.launches(), 1);
  assert.match('notice' in next ? next.notice! : '', /只读.*保留进度/);
  assert.equal(next.message.content, '那你倒是移动啊');
  assert.match(next.workflow.input.content, /Explain the synthetic project/);
  let successor: ExecuteContext | undefined;
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    successor = ctx;
    return { output: 'Synthetic remaining work complete.' };
  });
  f.release();
  await until(() => f.flow(f.first.workflow.id).status === 'completed' && f.controller.active.size === 0);
  await f.workspace.tickQueue();
  await until(() => !!successor);
  assert.match(successor!.input.prompt, /Synthetic result/);
  assert.match(successor!.input.prompt, /那你倒是移动啊/);
  assert.equal(successor!.nativeSessionId, undefined);
});

test('an executor change creates a linked successor while keeping the live task selection', async (t) => {
  const f = await fixture(t);
  f.controller.targets.push({ ...f.controller.targets[0]!, id: 'replacement' });
  f.controller.snapshots.push({ ...snapshot(), id: 'replacement' });
  f.ctx.registerSteer?.(async () => {
    throw new Error('Must not deliver to the old executor');
  });
  const next = await f.workspace.send(f.conversation.id, {
    ...base,
    runtimeId: 'replacement',
    content: 'Use the next executor.',
  });
  assert.equal(next.workflow.parentWorkflowId, f.first.workflow.id);
  assert.equal(next.workflow.input.runtimeId, 'replacement');
  assert.equal(f.flow(f.first.workflow.id).input.runtimeId, 'mock');
  assert.equal(f.ctx.signal.aborted, false);
  assert.match('notice' in next ? next.notice! : '', /执行器.*保留进度/);
});

test('ordinary composer default schedule permits immediate steering', async (t) => {
  const f = await fixture(t);
  const received: string[] = [];
  f.ctx.registerSteer?.(async (prompt) => {
    received.push(prompt);
  });
  const next = await f.workspace.send(f.conversation.id, {
    ...base,
    content: 'Add the synthetic comparison.',
    schedule: { priority: 'normal', preferExpiringQuota: true },
  });
  assert.equal(next.workflow.id, f.first.workflow.id);
  assert.equal(next.message.steering?.status, 'accepted');
  assert.ok(Number.isFinite(Date.parse(next.message.steering?.acceptedAt ?? '')));
  assert.deepEqual(received, ['Add the synthetic comparison.'].map(chineseSteeringPrompt));
  assert.equal(f.launches(), 1);
});

test('scoped prohibitions neither stop a writable task nor prevent direct or queued steering', async (t) => {
  for (const queued of [false, true]) {
    await t.test(queued ? 'queued' : 'direct', async (t) => {
      const writable: MessageInput = {
        ...base,
        content: 'Implement the synthetic feature and add tests.',
        mode: 'build',
        permissionMode: 'workspace-write',
      };
      const f = await fixture(t, writable);
      const received: string[] = [];
      f.ctx.registerSteer?.(async (prompt) => {
        received.push(prompt);
      });
      if (queued) f.ctx.registerSteer?.(undefined, { state: 'waiting' });
      const content = `Fix the bug but don't modify the public API.
Do not edit src/shared/i18n/en.json. Never delete through the junctions.
Do not commit. Do not build or restart the app.
把登录页改好看，但别动 config 文件。`;
      const next = await f.workspace.send(f.conversation.id, { ...writable, content });
      if (queued) {
        assert.equal(next.workflow.input.permissionMode, 'workspace-write');
        f.ctx.registerSteer?.(async (prompt) => {
          received.push(prompt);
        });
        await f.workspace.steerQueued(next.workflow.id);
      } else {
        assert.equal(next.workflow.id, f.first.workflow.id);
      }
      assert.equal(f.message(next.message.id).steering?.status, 'accepted');
      assert.equal(f.ctx.signal.aborted, false);
      assert.equal(f.flow(f.first.workflow.id).input.permissionMode, 'workspace-write');
      assert.deepEqual(received, [content].map(chineseSteeringPrompt));
      assert.equal(f.launches(), 1);
    });
  }
});

test('a standalone scope remark steers into the writer directly or from the queue', async (t) => {
  for (const content of [
    'don' + "'t delete the originals",
    '别' + '删原文件',
    'Stop deleting originals, continue sorting.',
  ]) {
    for (const queued of [false, true]) {
      await t.test(`${content}: ${queued ? 'queued' : 'direct'}`, async (t) => {
        const writable: MessageInput = {
          ...base,
          mode: 'auto',
          permissionMode: 'workspace-write',
          explicitWrite: true,
          content: 'Move synthetic files into their archive.',
        };
        const f = await fixture(t, writable);
        const received: string[] = [];
        const steer = async (prompt: string) => {
          received.push(prompt);
        };
        f.ctx.registerSteer?.(steer);
        if (queued) f.ctx.registerSteer?.(undefined, { state: 'waiting' });
        const next = await f.workspace.send(f.conversation.id, { ...writable, content });
        if (queued) {
          f.ctx.registerSteer?.(steer);
          await f.workspace.steerQueued(next.workflow.id);
        } else assert.equal(next.workflow.id, f.first.workflow.id);
        assert.equal(f.message(next.message.id).steering?.status, 'accepted');
        assert.equal(f.ctx.signal.aborted, false);
        assert.equal(f.flow(f.first.workflow.id).input.permissionMode, 'workspace-write');
        assert.ok(f.flow(f.first.workflow.id).input.intentText?.includes(content));
        assert.deepEqual(received, [chineseSteeringPrompt(content)]);
        assert.equal(f.launches(), 1);
      });
    }
  }
});

test('whole-message stops cancel even with the writable chip and auto-steering switched off', async (t) => {
  for (const content of [
    '停止',
    '别做了',
    'STOP!',
    'cancel',
    '只看' + '不改',
    '只给方案',
    '只给出方案',
    '只读',
    '不要改' + '任何文件',
    'don' + "'t change anything",
    'read-only please',
  ]) {
    await t.test(content, async (t) => {
      const writable: MessageInput = {
        ...base,
        mode: 'auto',
        permissionMode: 'workspace-write',
        explicitWrite: true,
        content: 'Move synthetic files into their archive.',
      };
      const f = await fixture(t, writable);
      f.controller.settings.steerOnSend = false;
      const received: string[] = [];
      f.ctx.registerSteer?.(async (prompt) => {
        received.push(prompt);
      });
      const next = await f.workspace.send(f.conversation.id, { ...writable, content });
      assert.equal(f.ctx.signal.aborted, true);
      await until(() => f.flow(f.first.workflow.id).status === 'cancelled');
      assert.equal(f.flow(f.first.workflow.id).status, 'cancelled');
      assert.equal(f.flow(f.first.workflow.id).input.permissionMode, 'read-only');
      assert.equal(next.workflow.input.permissionMode, 'read-only');
      assert.deepEqual(received, []);
    });
  }
});

test('queued conversion reuses its original message, locks mutations and is idempotent', async (t) => {
  const f = await fixture(t);
  const queued = await manualQueue(f);
  queued.message.createdAt = '2026-01-01T00:00:00.000Z';
  f.workspace.store.save('message', queued.message.id, f.conversation.id, queued.message);
  const transaction = f.workspace.store.transaction.bind(f.workspace.store);
  let committed = false;
  t.mock.method(f.workspace.store, 'transaction', <T>(fn: () => T) => {
    assert.equal(f.controller.store.db.prepare('PRAGMA synchronous').get()!.synchronous, committed ? 1 : 2);
    const result = transaction(fn);
    committed = true;
    return result;
  });
  const received: string[] = [];
  let acknowledge!: () => void;
  f.ctx.registerSteer?.(async (prompt) => {
    assert.ok(committed, 'pending steering is committed before native submission');
    assert.equal(f.controller.store.db.prepare('PRAGMA synchronous').get()!.synchronous, 1);
    received.push(prompt);
    await new Promise<void>((done) => {
      acknowledge = done;
    });
  });
  const before = f.workspace.store.allMessages(f.conversation.id).length;
  const first = f.workspace.steerQueued(queued.workflow.id);
  const second = f.workspace.steerQueued(queued.workflow.id);
  await until(() => !!acknowledge);
  assert.equal(f.workspace.canEditQueued(queued.workflow.id), false);
  assert.throws(() => f.workspace.cancel(queued.workflow.id), /正在投递/);
  assert.throws(() => f.workspace.updateSchedule(queued.workflow.id, {}), /正在投递/);
  assert.throws(() => f.workspace.deleteWorkflow(queued.workflow.id), /正在投递/);
  await assert.rejects(f.workspace.continue(queued.workflow.id), /正在投递/);
  const acknowledgedAfter = Date.now();
  acknowledge();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.message.id, queued.message.id);
  assert.equal(b.message.id, queued.message.id);
  assert.equal(a.workflow.id, f.first.workflow.id);
  assert.equal(f.flow(queued.workflow.id).status, 'cancelled');
  assert.deepEqual(f.flow(queued.workflow.id).followUp?.workflowId, f.first.workflow.id);
  assert.equal(f.message(queued.message.id).steering?.status, 'accepted');
  assert.equal(f.message(queued.message.id).createdAt, '2026-01-01T00:00:00.000Z');
  assert.ok(Date.parse(f.message(queued.message.id).steering?.acceptedAt ?? '') >= acknowledgedAfter);
  assert.equal(f.workspace.store.queuedWorkflows().length, 0);
  assert.equal(f.workspace.store.allMessages(f.conversation.id).length, before);
  await f.workspace.steerQueued(queued.workflow.id);
  assert.deepEqual(received, [queued.message.content].map(chineseSteeringPrompt));
  assert.equal(f.launches(), 1);
});

test('startup-only candidates automatically steer in durable queue order when ready', async (t) => {
  const f = await fixture(t);
  const a = await f.workspace.send(f.conversation.id, { ...base, content: 'Synthetic correction A.' });
  const b = await f.workspace.send(f.conversation.id, { ...base, content: 'Synthetic correction B.' });
  assert.ok(a.workflow.pendingSteer?.runId);
  assert.equal(a.workflow.pendingSteer?.workflowId, f.first.workflow.id);
  a.workflow.queueOrder = 2;
  b.workflow.queueOrder = 1;
  f.workspace.store.save('workflow', a.workflow.id, f.conversation.id, a.workflow);
  f.workspace.store.save('workflow', b.workflow.id, f.conversation.id, b.workflow);
  const received: string[] = [];
  f.ctx.registerSteer?.(async (prompt) => {
    received.push(prompt);
  });
  await until(() => f.message(a.message.id).steering?.status === 'accepted');
  assert.deepEqual(received, ['Synthetic correction B.', 'Synthetic correction A.'].map(chineseSteeringPrompt));
  assert.equal(f.flow(b.workflow.id).followUp?.workflowId, f.first.workflow.id);
  assert.equal(f.launches(), 1);
});

test('a slow receipt in one conversation does not delay ready steering in another', async (t) => {
  const f = await fixture(t);
  let otherContext!: ExecuteContext;
  t.mock.method(codexAdapter, 'execute', async (context: ExecuteContext) => {
    otherContext = context;
    await new Promise<void>((done) => context.signal.addEventListener('abort', () => done(), { once: true }));
    return { output: 'Synthetic second conversation result' };
  });
  const other = f.workspace.createConversation(f.project.id);
  await f.workspace.send(other.id, base);
  await f.workspace.tickQueue();
  await until(() => !!otherContext);
  const first = await f.workspace.send(f.conversation.id, { ...base, content: 'Held synthetic correction.' });
  let acknowledge!: () => void;
  f.ctx.registerSteer?.(async () => {
    await new Promise<void>((done) => {
      acknowledge = done;
    });
  });
  try {
    await until(() => !!acknowledge);
    const second = await f.workspace.send(other.id, { ...base, content: 'Independent synthetic correction.' });
    const received: string[] = [];
    otherContext.registerSteer?.(async (prompt) => {
      received.push(prompt);
    });
    await until(() => f.message(second.message.id).steering?.status === 'accepted');
    assert.deepEqual(received, ['Independent synthetic correction.'].map(chineseSteeringPrompt));
    assert.equal(f.message(first.message.id).steering?.status, 'pending');
    assert.equal(f.controller.active.size, 2);
  } finally {
    acknowledge?.();
  }
  await until(() => f.message(first.message.id).steering?.status === 'accepted');
});

test('ready during enqueue still consumes the startup candidate without another CLI', async (t) => {
  const f = await fixture(t);
  const received: string[] = [];
  const originalSave = f.workspace.store.save.bind(f.workspace.store);
  let registered = false;
  t.mock.method(f.workspace.store, 'save', (kind: string, id: string, owner: string, value: unknown) => {
    originalSave(kind, id, owner, value);
    if (kind === 'workflow' && (value as Workflow).pendingSteer && !registered) {
      registered = true;
      f.ctx.registerSteer?.(async (prompt) => {
        received.push(prompt);
      });
    }
  });
  const next = await f.workspace.send(f.conversation.id, { ...base, content: 'Synthetic enqueue race.' });
  await until(() => f.message(next.message.id).steering?.status === 'accepted');
  assert.deepEqual(received, ['Synthetic enqueue race.'].map(chineseSteeringPrompt));
  assert.equal(f.launches(), 1);
});

test('reordering while an acknowledgment is pending changes the next automatic delivery', async (t) => {
  const f = await fixture(t);
  const a = await f.workspace.send(f.conversation.id, { ...base, content: 'Synthetic order A.' });
  const b = await f.workspace.send(f.conversation.id, { ...base, content: 'Synthetic order B.' });
  const c = await f.workspace.send(f.conversation.id, { ...base, content: 'Synthetic order C.' });
  for (const [index, item] of [a, b, c].entries()) {
    item.workflow.queueOrder = index;
    f.workspace.store.save('workflow', item.workflow.id, f.conversation.id, item.workflow);
  }
  const received: string[] = [];
  let acknowledge!: () => void;
  f.ctx.registerSteer?.(async (prompt) => {
    received.push(prompt);
    if (received.length === 1)
      await new Promise<void>((done) => {
        acknowledge = done;
      });
  });
  await until(() => !!acknowledge);
  assert.equal(f.workspace.canEditQueued(a.workflow.id), false);
  assert.equal(f.workspace.canEditQueued(b.workflow.id), true);
  c.workflow.queueOrder = -1;
  f.workspace.store.save('workflow', c.workflow.id, f.conversation.id, c.workflow);
  f.workspace.notifyConversationChanged(f.conversation.id);
  acknowledge();
  await until(() => f.message(b.message.id).steering?.status === 'accepted');
  assert.deepEqual(
    received,
    ['Synthetic order A.', 'Synthetic order C.', 'Synthetic order B.'].map(chineseSteeringPrompt),
  );
  assert.equal(f.launches(), 1);
});

test('uncertain native acknowledgment blocks the original queued workflow and never replays it', async (t) => {
  const f = await fixture(t);
  const queued = await manualQueue(f);
  f.ctx.registerSteer?.(async () => {
    throw new Error('Synthetic acknowledgment timeout');
  });
  await assert.rejects(f.workspace.steerQueued(queued.workflow.id), /不会自动排队/);
  assert.equal(f.flow(queued.workflow.id).status, 'blocked');
  assert.equal(f.message(queued.message.id).steering?.status, 'failed');
  assert.equal(f.flow(queued.workflow.id).pendingSteer, undefined);
  f.release();
  await until(() => !f.controller.active.size);
  await f.workspace.tickQueue();
  assert.equal(f.launches(), 1);
  await assert.rejects(f.workspace.steerQueued(queued.workflow.id), /只能把/);
});

test('an unsubmitted late conversion restores the original queue item', async (t) => {
  const f = await fixture(t);
  const queued = await manualQueue(f);
  f.ctx.registerSteer?.(async () => {});
  t.mock.method(f.controller, 'steer', async () => false);
  await assert.rejects(f.workspace.steerQueued(queued.workflow.id), /插话未发送/);
  assert.equal(f.flow(queued.workflow.id).status, queued.workflow.status);
  assert.equal(f.message(queued.message.id).steering, undefined);
  assert.equal(f.workspace.canEditQueued(queued.workflow.id), true);
  assert.equal(f.launches(), 1);
});

test('restart leaves an in-flight queued conversion blocked with a failed original message', async (t) => {
  const f = await fixture(t);
  const queued = await manualQueue(f);
  await f.workspace.close();
  queued.workflow.status = 'blocked';
  queued.workflow.error = 'Synthetic interrupted acknowledgment';
  queued.message.steering = { runId: 'synthetic-lost-run', status: 'pending' };
  f.workspace.store.save('workflow', queued.workflow.id, queued.workflow.conversationId, queued.workflow);
  f.workspace.store.save('message', queued.message.id, queued.workflow.conversationId, queued.message);
  const restarted = new Workspace(f.controller, { autoTick: false });
  t.after(() => restarted.close());
  const workflow = restarted.store.get<Workflow>('workflow', queued.workflow.id)!;
  const message = restarted.store.get<ConversationMessage>('message', queued.message.id)!;
  assert.equal(workflow.status, 'blocked');
  assert.match(workflow.error ?? '', /无法确认插话是否送达/);
  assert.equal(message.steering?.status, 'failed');
  assert.equal(restarted.store.queuedWorkflows().length, 0);
});

test('queued steering rejects actual schedules, attachments, verification, delegation and configuration changes', async (t) => {
  const f = await fixture(t);
  const queued = await manualQueue(f);
  let received = 0;
  f.ctx.registerSteer?.(async () => {
    received++;
  });
  const mutations: Array<(workflow: Workflow) => void> = [
    (w) => {
      w.input.schedule = { priority: 'high' };
    },
    (w) => {
      w.input.schedule = { preferExpiringQuota: false };
    },
    (w) => {
      w.input.attachmentIds = ['synthetic-attachment'];
    },
    (w) => {
      w.input.verificationCommand = 'synthetic-check';
    },
    (w) => {
      w.originalIntent!.verificationCommand = 'synthetic-check';
    },
    (w) => {
      w.input.runtimeId = 'other';
    },
    (w) => {
      w.input.provider = 'grok';
    },
    (w) => {
      w.input.model = 'other';
    },
    (w) => {
      w.input.effort = 'high';
    },
    (w) => {
      w.input.executionPolicy = 'api-only';
    },
    (w) => {
      w.input.excludeProviders = ['codex'];
    },
    (w) => {
      w.input.permissionMode = 'workspace-write';
      w.originalIntent = { mode: 'build', permissionMode: 'workspace-write' };
    },
    (w) => {
      w.parentWorkflowId = f.first.workflow.id;
    },
    (w) => {
      w.delegation = { parentId: f.first.workflow.id, role: 'scout', requestId: 'synthetic' };
    },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(queued.workflow);
    mutate(changed);
    f.workspace.store.save('workflow', changed.id, changed.conversationId, changed);
    await assert.rejects(f.workspace.steerQueued(changed.id));
    assert.equal(f.message(queued.message.id).steering, undefined);
  }
  assert.equal(received, 0);
  assert.equal(f.launches(), 1);
});

test('manual conversion respects changed approval and native account identity', async (t) => {
  const f = await fixture(t);
  const queued = await manualQueue(f);
  let received = 0;
  f.ctx.registerSteer?.(async () => {
    received++;
  });
  f.controller.settings.toolApprovalMode = 'ask';
  await assert.rejects(f.workspace.steerQueued(queued.workflow.id), /审批/);
  f.controller.settings.toolApprovalMode = 'auto';
  f.setIdentity('different-synthetic-account');
  await assert.rejects(f.workspace.steerQueued(queued.workflow.id), /无法确认补充是否送达/);
  assert.equal(received, 0);
  assert.equal(f.message(queued.message.id).steering?.status, 'failed');
  assert.equal(f.flow(queued.workflow.id).status, 'blocked');
});

test('ending an anchored startup run leaves its candidate queued rather than steering another task', async (t) => {
  const f = await fixture(t);
  const next = await f.workspace.send(f.conversation.id, { ...base, content: 'Synthetic later question.' });
  assert.ok(next.workflow.pendingSteer);
  f.release();
  await until(() => !f.controller.active.size);
  f.workspace.notifyConversationChanged(f.conversation.id);
  await until(() => !f.flow(next.workflow.id).pendingSteer);
  assert.equal(f.message(next.message.id).steering, undefined);
  assert.ok(['queued', 'waiting-resource'].includes(f.flow(next.workflow.id).status));
  assert.equal(f.launches(), 1);
});

test('manual waiting candidates do not auto-steer and queue-off keeps unsent composer input out of history', async (t) => {
  const f = await fixture(t);
  f.conversation.queueingEnabled = false;
  f.workspace.store.save('conversation', f.conversation.id, f.project.id, f.conversation);
  const before = f.workspace.store.allMessages(f.conversation.id).length;
  await assert.rejects(
    f.workspace.send(f.conversation.id, { ...base, content: 'Synthetic not-ready correction.' }),
    /关闭排队/,
  );
  assert.equal(f.workspace.store.allMessages(f.conversation.id).length, before);
  assert.equal(f.workspace.store.queuedWorkflows().length, 0);
  f.ctx.registerSteer?.(async () => {});
  const delivered = await f.workspace.send(f.conversation.id, { ...base, content: 'Synthetic ready correction.' });
  assert.equal(delivered.message.steering?.status, 'accepted');
  assert.equal(f.launches(), 1);
});

test('queue-off late not-delivered race saves a visible failed message instead of an orphan queue', async (t) => {
  const f = await fixture(t);
  f.conversation.queueingEnabled = false;
  f.workspace.store.save('conversation', f.conversation.id, f.project.id, f.conversation);
  f.ctx.registerSteer?.(async () => {});
  t.mock.method(f.controller, 'steer', async () => false);
  await assert.rejects(
    f.workspace.send(f.conversation.id, { ...base, content: 'Synthetic delivery race.' }),
    /关闭排队/,
  );
  const messages = f.workspace.store.allMessages(f.conversation.id);
  const failed = messages.find((message) => message.content === 'Synthetic delivery race.');
  assert.equal(failed?.steering?.status, 'failed');
  assert.match(failed?.steering?.error ?? '', /未送达/);
  assert.equal(failed?.steering?.runId, [...f.controller.active.keys()][0]);
  assert.equal(f.workspace.store.queuedWorkflows().length, 0);
});

test('a converted message cannot create a follow-up cycle when the active result is blocked', async (t) => {
  const f = await fixture(t);
  const queued = await manualQueue(f);
  f.ctx.registerSteer?.(async () => {});
  await f.workspace.steerQueued(queued.workflow.id);
  const running = f.flow(f.first.workflow.id);
  running.status = 'blocked';
  f.workspace.store.save('workflow', running.id, running.conversationId, running);
  // Exercise the same bounded repair invoked when publishing an unfinished task.
  (f.workspace as unknown as { repairWorkflowFollowUps: (conversationId: string) => void }).repairWorkflowFollowUps(
    f.conversation.id,
  );
  assert.equal(f.flow(running.id).followUp, undefined);
  assert.equal(f.flow(queued.workflow.id).followUp?.workflowId, running.id);
});

test('with routing rules, a queued message steers on what the user picked, not the model and effort the rules filled in', async (t) => {
  const f = await fixture(t);
  const conversation = f.workspace.store.get<import('../src/shared/types.ts').Conversation>(
    'conversation',
    f.conversation.id,
  )!;
  conversation.routing = {
    text: '',
    rules: [{ topic: 'adult', target: { provider: 'grok' }, strict: true }],
    chapterAgents: false,
    mask: false,
    updatedAt: new Date().toISOString(),
  };
  f.workspace.store.save('conversation', conversation.id, conversation.projectId, conversation);
  const queued = await manualQueue(f, 'Make the dialogue sound more natural.');
  // Legacy queued tasks may have rule-filled effort; steering still compares the user's own pick.
  const changed = structuredClone(f.flow(queued.workflow.id));
  changed.input.effort = 'high';
  f.workspace.store.save('workflow', changed.id, changed.conversationId, changed);
  const received: string[] = [];
  f.ctx.registerSteer?.(async (prompt) => {
    received.push(prompt);
  });
  await f.workspace.steerQueued(queued.workflow.id);
  assert.deepEqual(received, ['Make the dialogue sound more natural.'].map(chineseSteeringPrompt));
  // Explicit user pins win even over a strict content rule.
  f.ctx.registerSteer?.(undefined, { state: 'waiting', reason: 'Synthetic temporary pause' });
  const adult = await f.workspace.send(f.conversation.id, { ...base, queue: true, content: '写一段情色描写' });
  f.ctx.registerSteer?.(async (prompt) => {
    received.push(prompt);
  });
  await f.workspace.steerQueued(adult.workflow.id);
  assert.equal(received[1], chineseSteeringPrompt('写一段情色描写'));
  assert.equal(f.message(adult.message.id).steering?.status, 'accepted');
  // Without a pin, the strict rule still prevents steering into the wrong executor.
  f.ctx.registerSteer?.(undefined, { state: 'waiting', reason: 'Synthetic temporary pause' });
  const automatic = await f.workspace.send(f.conversation.id, {
    ...base,
    runtimeId: undefined,
    model: undefined,
    effort: undefined,
    queue: true,
    content: '写一段情色描写',
  });
  assert.equal(automatic.workflow.input.runtimeId, undefined, 'a routing rule must not become a pin');
  assert.equal(automatic.workflow.input.provider, undefined, 'a routing rule must not become a pin');
  f.ctx.registerSteer?.(async (prompt) => {
    received.push(prompt);
  });
  await assert.rejects(f.workspace.steerQueued(automatic.workflow.id), /路由规则要求交给“Grok”/);
  assert.equal(f.message(automatic.message.id).steering, undefined);
  assert.equal(f.flow(automatic.workflow.id).status, 'queued');
  assert.equal(received.length, 2);
  assert.equal(f.launches(), 1);
});

test('a queued message with quotes steers with its numbered quotes', async (t) => {
  const f = await fixture(t);
  f.ctx.registerSteer?.(undefined, { state: 'waiting', reason: 'Synthetic temporary pause' });
  const queued = await f.workspace.send(f.conversation.id, {
    ...base,
    content: 'Rewrite these lines.',
    quotes: [{ text: 'A stiff synthetic line.', note: 'Make it sound natural.' }],
  });
  // The conversation shows what the user typed; the executor gets the quotes as well.
  assert.equal(f.message(queued.message.id).content, 'Rewrite these lines.');
  const received: string[] = [];
  f.ctx.registerSteer?.(async (prompt) => {
    received.push(prompt);
  });
  await f.workspace.steerQueued(queued.workflow.id);
  assert.equal(received.length, 1);
  assert.match(
    received[0]!,
    /\[引用 1\]\n> A stiff synthetic line\.\n对引用 1 的要求：Make it sound natural\.[\s\S]*Rewrite these lines\./,
  );
  assert.equal(f.message(queued.message.id).steering?.status, 'accepted');
});
