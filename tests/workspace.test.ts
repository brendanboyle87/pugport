import { idleMachineReading } from './helpers/machine-reading.ts';
import { localComputer } from '../src/server/platform/computer-context.ts';
import { saveAttachment } from './helpers/attachments.ts';
import { settledWorkflow as finish, workflowState, fixtureSignal } from './helpers/workflow-state.ts';
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { Controller } from '../src/server/controller.ts';
import { Workspace } from '../src/server/workspace.ts';
import { HandoffTracker } from '../src/server/handoff-tracker.ts';
import { WorkspaceStore } from '../src/server/workspace-store.ts';
import { parsePlan, parsePlannerDecline, planDeclinesTask, plannerOutputDeclinesTask } from '../src/server/planning.ts';
import { codexAdapter } from '../src/server/adapters/codex.ts';
import { grokAdapter } from '../src/server/adapters/grok.ts';
import { claudeAdapter } from '../src/server/adapters/claude.ts';
import { piAdapter } from '../src/server/adapters/pi.ts';
import { memoryConversationPaths } from '../src/server/local-memory.ts';
import { taskOutcomeInstruction } from '../src/server/task-outcome.ts';
import { desktopPermissionChange } from '../src/server/permission-change.ts';
import { retrieveLocalMemory } from '../src/server/memory-retrieval.ts';
import { assessLocalMemoryEvidence } from '../src/server/memory-evidence.ts';
import { localTaskJudgment } from '../src/server/task-judgment.ts';
import { TaskJudge } from '../src/server/task-judgment.ts';
import { LayaRuntime } from '../src/server/laya-runtime.ts';
import { LayaTrainingUpload } from '../src/server/laya-training-upload.ts';
import { extensions } from '../src/server/extensions.ts';
import type {
  Conversation,
  ConversationMessage,
  ExecuteContext,
  MessageInput,
  Project,
  RuntimeSnapshot,
  Workflow,
} from '../src/shared/types.ts';
const base: MessageInput = {
  content: 'Explain this project',
  mode: 'chat',
  permissionMode: 'read-only',
  executionPolicy: 'cli-first',
  autoEscalate: true,
};

test('private conversations never send cloud or Jev judgments', async (t) => {
  const { workspace, controller, directory } = fixture(t);
  let requests = 0;
  const fakeFetch: typeof fetch = async () => {
    requests++;
    return Response.json({});
  };
  const cloud = new LayaRuntime({ root: directory, settings: () => controller.settings.laya, fetch: fakeFetch });
  const jev = new TaskJudge({ enabled: () => true, credential: () => 'synthetic-key', fetch: fakeFetch });
  t.after(() => cloud.close());
  t.mock.method(controller.laya, 'predict', cloud.predict.bind(cloud));
  t.mock.method(controller.taskJudge, 'judge', jev.judge.bind(jev));
  t.mock.method(codexAdapter, 'execute', async () => ({ output: 'Synthetic answer' }));
  const project = await workspace.createProject(directory);
  for (const mode of ['cloud', 'jev'] as const) {
    controller.settings.laya = { mode, recordTraining: false };
    for (const privacy of ['memory-off', 'project-off', 'incognito'] as const) {
      project.localMemory = { exportEnabled: privacy !== 'project-off', cliEnabled: false };
      workspace.store.save('project', project.id, project.id, project);
      const conversation = workspace.createConversation(project.id, 'Synthetic', privacy === 'incognito');
      if (privacy === 'memory-off')
        workspace.store.save('conversation', conversation.id, project.id, { ...conversation, memory: 'off' });
      const sent = await workspace.send(conversation.id, { ...base, content: 'Explain a synthetic cache.' });
      const flow = await finish(workspace, sent.workflow.id);
      assert.equal(flow.status, 'completed', `${mode} ${privacy}: ${flow.error}`);
      assert.deepEqual([flow.laya?.inference.status, flow.laya?.inference.reason], ['skipped', 'not_recorded']);
      if (mode === 'jev') assert.equal(flow.taskJudgment?.reason, 'not_recorded');
      assert.equal(requests, 0, `${mode} ${privacy}`);
    }
  }
  for (const mode of ['cloud', 'jev'] as const) {
    controller.settings.laya = { mode, recordTraining: false };
    const chat = await workspace.createGeneralConversation();
    const chatProject = workspace.store.get<Project>('project', chat.projectId)!;
    chatProject.localMemory = { exportEnabled: false, cliEnabled: false };
    workspace.store.save('project', chatProject.id, chatProject.id, chatProject);
    const before = requests;
    const sent = await workspace.send(chat.id, { ...base, content: 'Explain a synthetic cache.' });
    const flow = await finish(workspace, sent.workflow.id);
    assert.notEqual(flow.laya?.inference.reason, 'not_recorded');
    assert.equal(requests, before + 1, `chat scope remains eligible in ${mode}`);
  }
});

test('cloud judgment and training sample retain user history only', async (t) => {
  const { workspace, controller, directory } = fixture(t);
  controller.settings.laya = { mode: 'cloud', shareTraining: false, recordTraining: true };
  const bodies: string[] = [];
  const cloud = new LayaRuntime({
    root: directory,
    settings: () => controller.settings.laya,
    fetch: async (_url, init) => {
      bodies.push(String(init?.body));
      return Response.json({});
    },
  });
  t.after(() => cloud.close());
  t.mock.method(controller.laya, 'predict', cloud.predict.bind(cloud));
  t.mock.method(codexAdapter, 'execute', async () => ({ output: 'Synthetic answer' }));
  const project = await workspace.createProject(directory);
  project.localMemory = { exportEnabled: true, cliEnabled: false };
  workspace.store.save('project', project.id, project.id, project);
  const conversation = workspace.createConversation(project.id);
  workspace.store.addMessage(conversation.id, 'user', 'USER_HISTORY_SENTINEL');
  workspace.store.addMessage(conversation.id, 'assistant', 'ASSISTANT_PRIVATE_SENTINEL');
  const sent = await workspace.send(conversation.id, { ...base, content: 'Explain a synthetic cache.' });
  assert.equal((await finish(workspace, sent.workflow.id)).status, 'completed');
  assert.equal(bodies.length, 1);
  assert.match(bodies[0]!, /USER_HISTORY_SENTINEL/);
  assert.doesNotMatch(bodies[0]!, /ASSISTANT_PRIVATE_SENTINEL/);
  let records = await controller.layaReviews.list({});
  for (let i = 0; (!records.length || records[0]!.outcome?.status !== 'completed') && i < 100; i++) {
    await new Promise((resolve) => setTimeout(resolve, 30));
    records = await controller.layaReviews.list({});
  }
  assert.equal(records.length, 1);
  assert.match(records[0]!.state.recent_context, /USER_HISTORY_SENTINEL/);
  assert.doesNotMatch(records[0]!.state.recent_context, /ASSISTANT_PRIVATE_SENTINEL/);
  const samples: string[] = [];
  const upload = new LayaTrainingUpload({
    dataDir: join(directory, 'synthetic-upload'),
    appVersion: 'synthetic',
    settings: () => ({ mode: 'cloud', shareTraining: true }),
    region: () => 'other',
    eligible: () => true,
    config: { url: 'https://synthetic.invalid', publishableKey: 'sb_publishable_synthetic' },
    fetch: async (_url, init) => {
      samples.push(String(init?.body));
      return Response.json('00000000-0000-4000-8000-000000000001');
    },
  });
  t.after(() => upload.stop());
  await upload.enqueue(records[0]!);
  await upload.flush();
  assert.equal(samples.length, 1);
  assert.match(samples[0]!, /USER_HISTORY_SENTINEL/);
  assert.doesNotMatch(samples[0]!, /ASSISTANT_PRIVATE_SENTINEL/);
});

test('local and rules judgments retain their behavior for conversations with memory off', async (t) => {
  const { workspace, controller, directory } = fixture(t);
  const seen: string[] = [];
  t.mock.method(controller.laya, 'predict', async (state: Parameters<LayaRuntime['predict']>[0]) => {
    seen.push(state.recent_context);
    return { status: 'fallback', reason: 'synthetic', modelVersion: 'pugport-laya-v4', latencyMs: 0 };
  });
  t.mock.method(codexAdapter, 'execute', async () => ({ output: 'Synthetic answer' }));
  const project = await workspace.createProject(directory);
  project.localMemory = { exportEnabled: false, cliEnabled: false };
  workspace.store.save('project', project.id, project.id, project);
  for (const mode of ['local', 'rules'] as const) {
    controller.settings.laya = { mode, recordTraining: false };
    const conversation = workspace.createConversation(project.id);
    workspace.store.save('conversation', conversation.id, project.id, { ...conversation, memory: 'off' });
    workspace.store.addMessage(conversation.id, 'assistant', 'LOCAL_ASSISTANT_SENTINEL');
    const sent = await workspace.send(conversation.id, { ...base, content: 'Explain a synthetic cache.' });
    const flow = await finish(workspace, sent.workflow.id);
    assert.equal(flow.laya?.inference.reason, 'synthetic');
    assert.match(seen.at(-1)!, /LOCAL_ASSISTANT_SENTINEL/);
  }
  assert.equal(seen.length, 2);
  project.localMemory = { exportEnabled: true, cliEnabled: false };
  workspace.store.save('project', project.id, project.id, project);
  controller.settings.laya = { mode: 'local', recordTraining: true };
  const recorded = workspace.createConversation(project.id);
  workspace.store.addMessage(recorded.id, 'user', 'LOCAL_USER_SENTINEL');
  workspace.store.addMessage(recorded.id, 'assistant', 'LOCAL_ASSISTANT_SENTINEL');
  const sent = await workspace.send(recorded.id, { ...base, content: 'Explain a synthetic cache.' });
  await finish(workspace, sent.workflow.id);
  assert.match(seen.at(-1)!, /LOCAL_ASSISTANT_SENTINEL/);
  let records = await controller.layaReviews.list({});
  for (let i = 0; !records.length && i < 100; i++) {
    await new Promise((resolve) => setTimeout(resolve, 30));
    records = await controller.layaReviews.list({});
  }
  assert.equal(records.length, 1);
  assert.match(records[0]!.state.recent_context, /LOCAL_USER_SENTINEL/);
  assert.doesNotMatch(records[0]!.state.recent_context, /LOCAL_ASSISTANT_SENTINEL/);
});

test('steering a private workflow never sends cloud or Jev requests', async (t) => {
  const { workspace, controller, directory } = fixture(t);
  controller.settings.steerOnSend = true;
  let requests = 0;
  const fakeFetch: typeof fetch = async () => {
    requests++;
    return Response.json({});
  };
  const cloud = new LayaRuntime({ root: directory, settings: () => controller.settings.laya, fetch: fakeFetch });
  const jev = new TaskJudge({ enabled: () => true, credential: () => 'synthetic-key', fetch: fakeFetch });
  t.after(() => cloud.close());
  t.mock.method(controller.laya, 'predict', cloud.predict.bind(cloud));
  t.mock.method(controller.taskJudge, 'judge', jev.judge.bind(jev));
  let release!: () => void;
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    ctx.registerSteer?.(async () => {});
    await new Promise<void>((resolve) => {
      release = resolve;
      queueMicrotask(() => controller.broadcast());
      ctx.signal.addEventListener('abort', () => resolve(), { once: true });
    });
    return { output: 'Synthetic answer' };
  });
  const project = await workspace.createProject(directory);
  for (const mode of ['cloud', 'jev'] as const) {
    controller.settings.laya = { mode, recordTraining: false };
    for (const privacy of ['memory-off', 'project-off'] as const) {
      project.localMemory = { exportEnabled: privacy !== 'project-off', cliEnabled: false };
      workspace.store.save('project', project.id, project.id, project);
      const conversation = workspace.createConversation(project.id);
      if (privacy === 'memory-off')
        workspace.store.save('conversation', conversation.id, project.id, { ...conversation, memory: 'off' });
      const first = await workspace.send(conversation.id, { ...base, content: 'Explain a synthetic cache.' });
      try {
        await workflowState(workspace, () =>
          [...controller.active.values()].some((entry) => controller.canSteer(entry.run.id)),
        );
        const next = await workspace.send(conversation.id, { ...base, content: 'Add a synthetic detail.' });
        assert.equal(next.message.steering?.status, 'accepted');
        assert.equal(next.workflow.id, first.workflow.id);
        assert.equal(requests, 0, `${mode} ${privacy}`);
      } finally {
        release();
      }
      assert.equal((await finish(workspace, first.workflow.id)).laya?.inference.reason, 'not_recorded');
      assert.equal(requests, 0);
    }
  }
});
test('workspace timer archives expired dispatches at most once per ten minutes', async (t) => {
  let now = Date.parse('2026-01-01T00:00:00.000Z');
  const interval = 1234567;
  let timerCallback: (() => void) | undefined;
  const originalSetInterval = globalThis.setInterval;
  const timerMock = t.mock.method(globalThis, 'setInterval', ((callback: () => void, delay?: number) => {
    if (delay === interval) timerCallback = callback;
    return originalSetInterval(callback, delay);
  }) as typeof setInterval);
  const { workspace } = fixture(t, 'codex', undefined, { now: () => now, retryMs: interval });
  timerMock.mock.restore();
  await workspace.startupMaintenanceDone;
  assert.ok(timerCallback, 'workspace registered its periodic callback');
  const project: Project = {
    id: 'synthetic-timer-project',
    name: 'Synthetic',
    path: 'C:/synthetic-timer',
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
  };
  workspace.store.save('project', project.id, project.id, project);
  const conversation = workspace.createConversation(project.id, 'Synthetic dispatch');
  workspace.store.save('external-conversation', conversation.id, conversation.id, { dispatched: true });
  const workflow: Workflow = {
    id: 'synthetic-timer-workflow',
    projectId: project.id,
    conversationId: conversation.id,
    userMessageId: 'synthetic-timer-message',
    status: 'completed',
    phase: 'execute',
    input: base,
    plan: [],
    runIds: [],
    memoryRevision: 0,
    memoryExcerpt: '',
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
  };
  workspace.store.save('workflow', workflow.id, conversation.id, workflow);
  const sweep = t.mock.method(workspace, 'archiveSettledDispatches');
  now += 7 * 86400000;
  timerCallback();
  await workspace.startupMaintenanceDone;
  assert.ok(workspace.requireConversation(conversation.id).archivedAt);
  assert.equal(sweep.mock.callCount(), 1);
  now += 599999;
  timerCallback();
  assert.equal(sweep.mock.callCount(), 1);
  now += 1;
  timerCallback();
  await workspace.startupMaintenanceDone;
  assert.equal(sweep.mock.callCount(), 2);
});
test('workspace state shows effective trust without storing it', async (t) => {
  const { controller, workspace } = fixture(t);
  const project: Project = {
    id: 'trust-fixture',
    name: 'Fixture',
    path: resolve('trust-fixture'),
    createdAt: '',
    updatedAt: '',
  };
  workspace.store.save('project', project.id, project.id, project);
  assert.equal(workspace.state().projects?.find((item) => item.id === project.id)?.trusted, true);
  assert.equal(workspace.store.get<Project>('project', project.id)?.trusted, undefined);
});
const snap = (): RuntimeSnapshot => ({
  id: 'mock',
  provider: 'codex',
  label: 'Mock',
  environment: 'native',
  installed: true,
  status: 'ready',
  accountFingerprint: 'synthetic-native-account',
  models: [{ id: 'mock-model', label: 'Mock', efforts: ['low', 'medium', 'high'] }],
  quota: {
    status: 'known',
    source: 'test',
    observedAt: new Date().toISOString(),
    windows: [{ id: 'week', label: 'week', usedPercent: 10, resetsAt: new Date(Date.now() + 3600000).toISOString() }],
  },
  capabilities: { execute: true, resume: true, cancel: true, approvals: true },
  refreshedAt: new Date().toISOString(),
});
function fixture(
  t: TestContext,
  provider: 'codex' | 'pi' | 'grok' | 'claude' = 'codex',
  seed?: (store: WorkspaceStore, directory: string) => void,
  options?: ConstructorParameters<typeof Workspace>[1],
) {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'studio-workspace-test-'))),
    data = join(directory, 'data');
  const memoryDirectory = realpathSync.native(mkdtempSync(join(tmpdir(), 'studio-workspace-memory-')));
  const previousMemoryDirectory = process.env.COMBORUNNER_MEMORY_DIR;
  process.env.COMBORUNNER_MEMORY_DIR = memoryDirectory;
  const controller = new Controller(directory, data, { readAccountIdentity: () => 'synthetic-native-account' });
  clearInterval(controller.timer);
  t.mock.method(controller, 'machineReading', idleMachineReading);
  // Pi stands in for a generic API harness here; the product keeps direct Pi locked by default.
  if (provider === 'pi') controller.settings.allowDirectPiApi = true;
  controller.targets = [
    { id: 'mock', provider, label: 'Mock', command: 'unused', environment: 'native', enabled: true },
  ];
  controller.snapshots = [{ ...snap(), provider }];
  t.mock.method(
    { codex: codexAdapter, pi: piAdapter, grok: grokAdapter, claude: claudeAdapter }[provider],
    'discover',
    async () => ({ ...snap(), provider }),
  );
  if (seed) seed(new WorkspaceStore(controller.store.db), directory);
  const workspace = new Workspace(controller, options);
  // The app's HTTP server keeps unref'd memory jobs alive; this isolated fixture needs a bounded lifetime too.
  const keepAlive = setTimeout(() => assert.fail('Workspace fixture timed out after 60 seconds'), 60_000);
  t.after(async () => {
    await workspace.close();
    await controller.close();
    // Only remove the unique temporary workspace that this fixture created.
    const cleanup = resolve(directory);
    assert.ok(
      cleanup.startsWith(realpathSync.native(tmpdir()) + sep) && basename(cleanup).startsWith('studio-workspace-test-'),
    );
    rmSync(cleanup, { recursive: true, force: true });
    const privateCleanup = realpathSync.native(memoryDirectory);
    assert.ok(privateCleanup.startsWith(realpathSync.native(tmpdir()) + sep));
    assert.ok(basename(privateCleanup).startsWith('studio-workspace-memory-'));
    rmSync(privateCleanup, { recursive: true, force: true });
    if (previousMemoryDirectory === undefined) delete process.env.COMBORUNNER_MEMORY_DIR;
    else process.env.COMBORUNNER_MEMORY_DIR = previousMemoryDirectory;
  });
  t.after(() => clearTimeout(keepAlive));
  return { directory, controller, workspace };
}

function memoryPaths(workspace: Workspace, project: Project, conversationId: string) {
  const files = memoryConversationPaths(workspace.controller.dataDir, project.id, conversationId);
  return {
    history: files.historyPath,
    handoff: files.handoffPath,
    index: files.indexPath,
    latest: files.latestPath,
  };
}

test('self-contained chat skips classification and memory searches but still runs the model with conversation context', async (t) => {
  t.mock.method(localComputer, 'summary', () => 'This computer: Synthetic CPU · 32 GB RAM');
  let semanticCalls = 0;
  let retrievalCalls = 0;
  const { workspace, controller, directory } = fixture(t, 'codex', undefined, {
    semanticCandidates: async () => {
      semanticCalls++;
      return [];
    },
    retrieveMemory: async () => {
      retrievalCalls++;
      return { context: '', excerpts: [], paths: [], elapsedMs: 0 };
    },
  });
  controller.settings.taskJudgment = 'jev';
  const judge = t.mock.method(controller.taskJudge, 'judge', async (text: string) =>
    localTaskJudgment(text, 'not-configured'),
  );
  const recall = t.mock.method(
    workspace.hindsightMemory,
    'recall',
    async (...[_input, memory]: Parameters<typeof workspace.hindsightMemory.recall>) => memory,
  );
  const calls: ExecuteContext[] = [];
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    calls.push(ctx);
    return { output: 'Synthetic model reply.' };
  });
  const project = await workspace.createProject(directory);
  for (const content of [
    '你好，请只回复一句简短的问候。不调用工具，不读取文件。',
    '再只回复两个字：收到。不调用工具，不读取文件。',
    'Hello!',
    '你好',
    'Please reply with exactly "Synthetic literal". Do not use tools or read files.',
  ]) {
    const conversation = workspace.createConversation(project.id);
    workspace.store.addMessage(conversation.id, 'user', 'Synthetic earlier conversation marker.');
    const sent = await workspace.send(conversation.id, {
      ...base,
      mode: 'auto',
      content,
      ...(content === 'Hello!' ? { runtimeId: 'mock' } : {}),
      model: 'mock-model',
      effort: 'high',
    });
    const result = await finish(workspace, sent.workflow.id);
    assert.equal(result.status, 'completed');
    assert.equal(
      result.taskJudgment?.reason,
      content === 'Hello!' ? 'manual-selection' : 'self-contained-chat',
      content,
    );
    assert.equal(result.taskJudgment?.requestAttempted, false);
    assert.equal(result.memoryRetrieval?.evidence?.reason, 'self-contained-chat');
    assert.match(calls.at(-1)!.input.prompt, /Synthetic earlier conversation marker/);
    assert.match(calls.at(-1)!.input.prompt, /This computer: Synthetic CPU · 32 GB RAM/);
    assert.equal(calls.at(-1)!.route.model, 'mock-model');
    assert.equal(calls.at(-1)!.route.effort, 'high');
    assert.equal(calls.at(-1)!.input.selfContainedChat, ['Hello!', '你好'].includes(content) ? undefined : true);
    assert.equal(calls.at(-1)!.input.latencySensitiveChat, true);
  }
  assert.equal(calls.length, 5);
  assert.equal(judge.mock.callCount(), 0);
  assert.equal(semanticCalls, 0);
  assert.equal(retrievalCalls, 0);
  assert.equal(recall.mock.callCount(), 0);
});

for (const revoke of [false, true])
  test(`optional context shares one deadline and retains only still-visible history; revoke=${revoke}`, async (t) => {
    let clock = performance.now();
    t.mock.method(performance, 'now', () => clock);
    const { workspace, controller, directory } = fixture(t, 'codex', undefined, {
      semanticCandidates: async () => {
        clock += 2500;
        return [];
      },
      retrieveMemory: async (store, input) => {
        const result = await retrieveLocalMemory(store, input, { inline: true, direct: true });
        clock += 2400;
        return result;
      },
    });
    const project = await workspace.createProject(directory);
    const source = workspace.createConversation(project.id);
    workspace.store.addMessage(source.id, 'assistant', 'Raven calibration uses SYNTHETIC_OPTIONAL_EVIDENCE.');
    const conversation = workspace.createConversation(project.id);
    const recall = t.mock.method(
      workspace.hindsightMemory,
      'recall',
      async (...[_input, local]: Parameters<typeof workspace.hindsightMemory.recall>) => {
        clock += 200;
        if (revoke) workspace.store.save('conversation', source.id, project.id, { ...source, memory: 'off' });
        return local;
      },
    );
    controller.settings.memoryEvidence = 'jev';
    const evidence = t.mock.method(
      controller.memoryEvidenceJudge,
      'assess',
      async (input: Parameters<typeof controller.memoryEvidenceJudge.assess>[0]) =>
        assessLocalMemoryEvidence(input.query, input.excerpts),
    );
    const calls: ExecuteContext[] = [];
    t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
      calls.push(ctx);
      return { output: 'Synthetic answer.' };
    });
    const sent = await workspace.send(conversation.id, {
      ...base,
      content: 'What did we decide about Raven calibration?',
    });
    const flow = await finish(workspace, sent.workflow.id);
    assert.equal(flow.status, 'completed', flow.error ?? 'Synthetic workflow should complete');
    assert.equal(recall.mock.callCount(), 1);
    assert.equal(evidence.mock.callCount(), 0, 'a new stage cannot reset the shared optional-context deadline');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.input.prompt.includes('SYNTHETIC_OPTIONAL_EVIDENCE'), !revoke);
    assert.ok(calls[0]!.input.prompt.includes('What did we decide about Raven calibration?'));
  });

test('cancelling optional retrieval stops execution and late semantic results do not reach the next request', async (t) => {
  let entered!: () => void;
  const started = new Promise<void>((resolve) => (entered = resolve));
  let release!: (value: []) => void;
  t.mock.method(localComputer, 'summary', () => 'This computer: Synthetic CPU · 32 GB RAM');
  let semanticCalls = 0;
  let retrievalCalls = 0;
  const { workspace, directory } = fixture(t, 'codex', undefined, {
    semanticCandidates: async () => {
      if (++semanticCalls > 1) return [];
      entered();
      return new Promise<[]>((resolve) => (release = resolve));
    },
    retrieveMemory: async () => {
      retrievalCalls++;
      return { context: '', excerpts: [], paths: [], elapsedMs: 0 };
    },
  });
  const calls: ExecuteContext[] = [];
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    calls.push(ctx);
    return { output: 'Synthetic answer.' };
  });
  const project = await workspace.createProject(directory);
  const first = await workspace.send(workspace.createConversation(project.id).id, {
    ...base,
    content: 'What did we decide about SYNTHETIC_CANCELLED_HISTORY?',
  });
  await started;
  workspace.cancel(first.workflow.id);
  assert.equal((await finish(workspace, first.workflow.id)).status, 'cancelled');
  assert.equal(retrievalCalls, 0);
  assert.equal(calls.length, 0);
  release([]);
  const second = await workspace.send(workspace.createConversation(project.id).id, {
    ...base,
    content: 'Explain the current request only.',
  });
  assert.equal((await finish(workspace, second.workflow.id)).status, 'completed');
  assert.equal(retrievalCalls, 1);
  assert.equal(calls.length, 1);
  assert.ok(!calls[0]!.input.prompt.includes('SYNTHETIC_CANCELLED_HISTORY'));
});

test('explicit no-tools conversation recall keeps native continuity without changing contextual preparation', async (t) => {
  let retrievalCalls = 0;
  const { workspace, directory } = fixture(t, 'claude', undefined, {
    semanticCandidates: async () => [],
    retrieveMemory: async () => {
      retrievalCalls++;
      return { context: '', excerpts: [], paths: [], elapsedMs: 0 };
    },
  });
  const calls: ExecuteContext[] = [];
  t.mock.method(claudeAdapter, 'execute', async (ctx: ExecuteContext) => {
    calls.push(ctx);
    return { output: '收到', nativeSessionId: ctx.nativeSessionId ?? `synthetic-session-${calls.length}` };
  });
  const project = await workspace.createProject(directory);
  const conversation = workspace.createConversation(project.id);
  const prompts = [
    '你好，请只回复一句简短的问候。不调用工具，不读取文件。',
    '再只回复两个字：收到。不调用工具，不读取文件。',
    '上一条我让你回复哪两个字？只回复那两个字。不调用工具，不读取文件。',
    '请读取 README.md',
  ];
  for (const content of prompts) {
    const sent = await workspace.send(conversation.id, { ...base, content, model: 'mock-model', effort: 'medium' });
    assert.equal((await finish(workspace, sent.workflow.id)).status, 'completed');
  }
  assert.equal(calls.length, 4);
  assert.equal(calls[2]!.input.explicitNoTools, true);
  assert.equal(calls[2]!.input.latencySensitiveChat, undefined);
  assert.equal(calls[2]!.input.selfContainedChat, undefined);
  assert.equal(calls[2]!.input.untrustedContent, undefined);
  assert.equal(calls[2]!.input.textOnly, undefined);
  assert.equal(calls[1]!.nativeSessionId, 'synthetic-session-1');
  assert.equal(calls[2]!.nativeSessionId, 'synthetic-session-1');
  assert.equal(calls[3]!.nativeSessionId, undefined);
  assert.equal(calls[3]!.input.explicitNoTools, undefined);
  assert.equal(retrievalCalls, 2);
  assert.ok(calls.every((ctx) => ctx.route.model === 'mock-model' && ctx.route.effort === 'medium'));
});

test('contextual chat, attachments and quotes keep normal preparation; memory-off still skips every retrieval', async (t) => {
  t.mock.method(localComputer, 'summary', () => 'This computer: Synthetic CPU · 32 GB RAM');
  let semanticCalls = 0;
  let retrievalCalls = 0;
  const { workspace, controller, directory } = fixture(t, 'codex', undefined, {
    semanticCandidates: async () => {
      semanticCalls++;
      return [];
    },
    retrieveMemory: async () => {
      retrievalCalls++;
      return { context: '', excerpts: [], paths: [], elapsedMs: 0 };
    },
  });
  controller.settings.taskJudgment = 'jev';
  const judge = t.mock.method(controller.taskJudge, 'judge', async (text: string) =>
    localTaskJudgment(text, 'not-configured'),
  );
  const recall = t.mock.method(
    workspace.hindsightMemory,
    'recall',
    async (...[_input, memory]: Parameters<typeof workspace.hindsightMemory.recall>) => memory,
  );
  const calls: ExecuteContext[] = [];
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    calls.push(ctx);
    return { output: 'Synthetic model reply.' };
  });
  const project = await workspace.createProject(directory);
  for (const kind of [
    'contextual',
    'file',
    'attachment',
    'quote',
    'recall-attachment',
    'recall-quote',
    'memory-off',
    'greeting-memory-off',
  ] as const) {
    const conversation = workspace.createConversation(project.id);
    workspace.store.addMessage(conversation.id, 'assistant', 'Synthetic context remains available.');
    const disabled = kind.endsWith('memory-off');
    if (disabled) workspace.store.save('conversation', conversation.id, project.id, { ...conversation, memory: 'off' });
    const attachment = kind.endsWith('attachment')
      ? await saveAttachment(workspace.attachments, conversation.id, {
          name: 'synthetic.txt',
          mimeType: 'text/plain',
          dataBase64: Buffer.from('Synthetic attached context').toString('base64'),
        })
      : undefined;
    const content = kind.startsWith('recall-')
      ? '刚才我说了什么？不使用工具。'
      : ['attachment', 'quote', 'greeting-memory-off'].includes(kind)
        ? 'Hello!'
        : kind === 'file'
          ? '你好，请读取 README.md'
          : '现在呢？';
    const before = [semanticCalls, retrievalCalls, recall.mock.callCount(), judge.mock.callCount()];
    const sent = await workspace.send(conversation.id, {
      ...base,
      content,
      ...(attachment ? { attachmentIds: [attachment.id] } : {}),
      ...(kind.endsWith('quote') ? { quotes: [{ text: 'Synthetic quoted context' }] } : {}),
    });
    const result = await finish(workspace, sent.workflow.id);
    assert.equal(result.status, 'completed', kind);
    assert.equal(judge.mock.callCount() - before[3]!, 0, kind);
    assert.equal(semanticCalls - before[0]!, Number(!disabled), kind);
    assert.equal(retrievalCalls - before[1]!, Number(!disabled), kind);
    assert.equal(recall.mock.callCount() - before[2]!, Number(!disabled), kind);
    assert.match(calls.at(-1)!.input.prompt, /Synthetic context remains available/);
    assert.equal(calls.at(-1)!.input.selfContainedChat, undefined);
    assert.equal(calls.at(-1)!.input.explicitNoTools, undefined);
    assert.equal(calls.at(-1)!.input.latencySensitiveChat, kind === 'greeting-memory-off' ? true : undefined);
    if (disabled) assert.equal(result.memoryRetrieval, undefined);
    else assert.notEqual(result.memoryRetrieval?.evidence?.reason, 'self-contained-chat');
  }
});

test('resolved role and conversation skills retain retrieval and exclude the native startup hint', async (t) => {
  let retrievalCalls = 0;
  const { workspace, directory } = fixture(t, 'codex', undefined, {
    semanticCandidates: async () => [],
    retrieveMemory: async () => {
      retrievalCalls++;
      return { context: '', excerpts: [], paths: [], elapsedMs: 0 };
    },
  });
  const calls: ExecuteContext[] = [];
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    calls.push(ctx);
    return { output: 'Synthetic model reply.' };
  });
  const project = await workspace.createProject(directory);
  for (const kind of ['plain', 'skills', 'role'] as const) {
    const conversation = workspace.createConversation(project.id);
    if (kind === 'skills')
      workspace.store.save('conversation', conversation.id, project.id, {
        ...conversation,
        skills: ['synthetic-skill'],
      });
    const sent = await workspace.send(conversation.id, {
      ...base,
      content: '你好，请只回复一句简短的问候。不调用工具，不读取文件。',
      ...(kind === 'role' ? { agentPresetId: 'investigation' } : {}),
    });
    assert.equal((await finish(workspace, sent.workflow.id)).status, 'completed', kind);
    assert.equal(calls.at(-1)!.input.selfContainedChat, kind === 'plain' ? true : undefined, kind);
    assert.equal(calls.at(-1)!.input.explicitNoTools, kind === 'plain' ? true : undefined, kind);
    assert.equal(calls.at(-1)!.input.latencySensitiveChat, kind === 'plain' ? true : undefined, kind);
    assert.equal(retrievalCalls, kind === 'plain' ? 0 : kind === 'skills' ? 1 : 2, kind);
  }
});

async function approveVerification(workspace: Workspace, projectId: string, command: string) {
  const change = { kind: 'verification', projectId, command };
  const description = await desktopPermissionChange(workspace, change, false);
  await desktopPermissionChange(workspace, change, true, description);
}

test('verification requires a desktop-approved exact command on the workflow project, including queued work', async (t) => {
  const { workspace, controller, directory } = fixture(t);
  t.mock.method(codexAdapter, 'execute', async () => ({ output: 'Synthetic explanation complete.' }));
  const verify = t.mock.method(controller, 'verify', async (command: string) => ({
    command,
    status: 'passed' as const,
    exitCode: 0,
    output: 'synthetic verified',
  }));
  const project = await workspace.createProject(directory);
  const otherDir = join(directory, 'other');
  mkdirSync(otherDir);
  const other = await workspace.createProject(otherDir);
  await approveVerification(workspace, project.id, 'synthetic exact');
  await approveVerification(workspace, project.id, 'synthetic exact');
  assert.deepEqual(workspace.store.get<Project>('project', project.id)?.approvedVerificationCommands, [
    'synthetic exact',
  ]);
  for (const [selected, command, approved, queue] of [
    [project, 'synthetic exact', true, false],
    [project, 'synthetic exact ', false, false],
    [other, 'synthetic exact', false, false],
    [project, 'synthetic other', false, true],
  ] as const) {
    const conversation = workspace.createConversation(selected.id);
    const before = verify.mock.callCount();
    const sent = await workspace.send(conversation.id, {
      ...base,
      mode: 'build',
      permissionMode: 'workspace-write',
      content: 'Explain the project in one sentence.',
      verificationCommand: command,
      queue,
    });
    const flow = await finish(workspace, sent.workflow.id);
    const run = controller.store.run(flow.runIds.at(-1)!)!;
    assert.equal(run.verification?.status, approved ? 'passed' : 'skipped');
    assert.equal(verify.mock.callCount(), before + Number(approved));
    if (!approved) {
      assert.equal(run.verification?.output, '验收命令未经桌面批准，已跳过');
      assert.ok(run.events.some((event) => event.text === '验收命令未经桌面批准，已跳过'));
    }
  }
});

test('scheduled and resumed work rechecks verification approval when the command would run', async (t) => {
  const { workspace, controller, directory } = fixture(t);
  t.mock.method(codexAdapter, 'execute', async () => ({
    output: 'Synthetic explanation.',
    nativeSessionId: 'synthetic-resume',
  }));
  const verify = t.mock.method(controller, 'verify', async (command: string) => ({
    command,
    status: 'passed' as const,
    exitCode: 0,
    output: 'synthetic verified',
  }));
  const project = await workspace.createProject(directory);
  const conversation = workspace.createConversation(project.id);
  const submitted = await workspace.send(conversation.id, {
    ...base,
    mode: 'build',
    permissionMode: 'workspace-write',
    content: 'Explain the project in one sentence.',
    verificationCommand: 'synthetic scheduled',
    schedule: { notBefore: new Date(Date.now() + 3600000).toISOString() },
  });
  await workspace.tickQueue();
  assert.equal(verify.mock.callCount(), 0);
  assert.deepEqual(workspace.store.get<Workflow>('workflow', submitted.workflow.id)?.runIds, []);
  workspace.updateSchedule(submitted.workflow.id, {});
  const scheduled = await finish(workspace, submitted.workflow.id);
  assert.equal(controller.store.run(scheduled.runIds.at(-1)!)?.verification?.status, 'skipped');
  const continued = await workspace.continue(scheduled.id, undefined, {
    mode: 'build',
    permissionMode: 'workspace-write',
    explicitWrite: true,
  });
  const unapproved = await finish(workspace, continued.workflow.id);
  assert.equal(controller.store.run(unapproved.runIds.at(-1)!)?.verification?.status, 'skipped');
  assert.equal(verify.mock.callCount(), 0);
  await approveVerification(workspace, project.id, 'synthetic scheduled');
  const approved = await workspace.continue(unapproved.id, undefined, {
    mode: 'build',
    permissionMode: 'workspace-write',
    explicitWrite: true,
  });
  const resumed = await finish(workspace, approved.workflow.id);
  assert.equal(controller.store.run(resumed.runIds.at(-1)!)?.verification?.status, 'passed');
  assert.equal(verify.mock.callCount(), 1);
});
function readMemoryHistory(path: string): ConversationMessage[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as ConversationMessage);
}
function writeWithReceipt(ctx: ExecuteContext, path: string, content: string) {
  writeFileSync(join(ctx.input.projectPath, path), content);
  ctx.emit({
    at: new Date().toISOString(),
    type: 'tool',
    data: {
      kind: 'fileChange',
      itemId: `write-${path}`,
      status: 'completed',
      input: { changes: [{ path, kind: { type: 'update' } }] },
    },
  });
}
test('approval rerun preserves the request and permissions, waits for each approval, and leaves other tasks automatic', async (t) => {
  const { workspace, controller, directory } = fixture(t);
  const calls: ExecuteContext[] = [];
  const decisions: boolean[] = [];
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    calls.push(ctx);
    if (ctx.approvalMode === 'ask') {
      decisions.push(await ctx.approve('Codex permissions', 'Synthetic network permission'));
      decisions.push(await ctx.approve('Codex command', 'Synthetic second permission'));
    } else {
      ctx.emit({
        at: new Date().toISOString(),
        type: 'status',
        data: { kind: 'native-denied', reason: 'Synthetic network permission' },
      });
    }
    return { output: 'Synthetic reply', nativeSessionId: `synthetic-session-${calls.length}` };
  });
  const project = await workspace.createProject(directory);
  const conversation = workspace.createConversation(project.id);
  const first = await workspace.send(conversation.id, { ...base, runtimeId: 'mock' });
  await finish(workspace, first.workflow.id);
  const rerun = await workspace.rerunWithApproval(first.workflow.id, 'en');
  assert.equal(rerun.workflow.input.toolApprovalMode, 'ask');
  assert.equal(rerun.workflow.input.permissionMode, first.workflow.input.permissionMode);
  assert.equal(rerun.message.content, '');
  assert.equal(rerun.message.resumed, true);
  assert.ok(rerun.workflow.input.content.includes(first.message.content));
  assert.equal(controller.settings.toolApprovalMode, 'auto');
  const duplicate = await workspace.rerunWithApproval(first.workflow.id);
  assert.equal(duplicate.workflow.id, rerun.workflow.id);
  for (const allow of [true, false]) {
    await workflowState(workspace, () => controller.approvals.size > 0);
    assert.equal(workspace.store.get<Workflow>('workflow', rerun.workflow.id)?.status, 'waiting-approval');
    const approval = [...controller.approvals.values()][0]!.value;
    assert.equal(controller.run(approval.runId)?.status, 'waiting-approval');
    controller.answerApproval(approval.id, allow);
  }
  await finish(workspace, rerun.workflow.id);
  assert.deepEqual(decisions, [true, false]);
  assert.equal(calls[1]?.input.toolApprovalMode, 'ask');
  assert.equal(calls[1]?.approvalMode, 'ask');
  assert.equal(calls[1]?.nativeSessionId, undefined, 'changed approval mode must start a fresh native session');
  assert.equal(calls[1]?.input.permissionMode, 'read-only');
  const other = await workspace.send(workspace.createConversation(project.id).id, { ...base, runtimeId: 'mock' });
  await finish(workspace, other.workflow.id);
  assert.equal(calls[2]?.input.toolApprovalMode, undefined);
  assert.equal(calls[2]?.approvalMode, 'auto');
  assert.equal(controller.settings.toolApprovalMode, 'auto');
  await assert.rejects(workspace.rerunWithApproval(rerun.workflow.id), /最近一次运行没有/);
});

test('approval rerun retains writable task scope and rejects a task still executing', async (t) => {
  const { workspace, controller, directory } = fixture(t);
  const calls: ExecuteContext[] = [];
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    calls.push(ctx);
    if (ctx.approvalMode === 'auto') {
      ctx.emit({
        at: new Date().toISOString(),
        type: 'status',
        data: { kind: 'native-denied', reason: 'Synthetic permission' },
      });
    } else {
      await ctx.approve('Codex command', 'Synthetic command');
    }
    return { output: 'Synthetic reply' };
  });
  const project = await workspace.createProject(directory);
  const conversation = workspace.createConversation(project.id);
  const first = await workspace.send(conversation.id, {
    ...base,
    mode: 'build',
    content: 'Fix the typo "recieve" to "receive" in README.md.',
    permissionMode: 'workspace-write',
    runtimeId: 'mock',
  });
  await finish(workspace, first.workflow.id);
  assert.equal(first.workflow.input.permissionMode, 'workspace-write');
  const rerun = await workspace.rerunWithApproval(first.workflow.id);
  await workflowState(workspace, () => controller.approvals.size > 0);
  assert.equal(rerun.workflow.input.permissionMode, 'workspace-write');
  assert.equal(calls[1]?.input.permissionMode, 'workspace-write');
  await assert.rejects(workspace.rerunWithApproval(rerun.workflow.id), /请先等待/);
  controller.answerApproval([...controller.approvals.values()][0]!.value.id, true);
  await finish(workspace, rerun.workflow.id);
  const next = await workspace.send(conversation.id, { ...base, runtimeId: 'mock' });
  await finish(workspace, next.workflow.id);
  assert.equal(calls[2]?.approvalMode, 'auto', 'a new message in the same conversation uses the global mode');
});

test('projects deduplicate canonical paths and project memory uses revision checks', async (t) => {
  const { workspace, directory } = fixture(t);
  const p = await workspace.createProject(directory, 'My project');
  assert.equal((await workspace.createProject(directory)).id, p.id);
  assert.equal(workspace.updateMemory(p.id, 'Use TypeScript', 0).revision, 1);
  assert.throws(() => workspace.updateMemory(p.id, 'lost update', 0), /重新读取/);
  assert.equal(workspace.memory(p.id).content, 'Use TypeScript');
});

test('project MCP selection persists by stable ID, resets inheritance and rejects invalid IDs atomically', async (t) => {
  const { workspace, directory } = fixture(t);
  t.mock.method(extensions, 'all', () => [
    {
      kind: 'mcp',
      id: 'installed',
      name: 'Installed',
      transport: 'http',
      url: 'http://127.0.0.1/never-connect',
      enabled: false,
      source: 'synthetic',
      installedAt: '',
    },
    {
      kind: 'skill',
      id: 'skill',
      name: 'Skill',
      path: directory,
      description: '',
      managed: false,
      enabled: true,
      source: 'synthetic',
      installedAt: '',
    },
  ]);
  const project = await workspace.createProject(directory, 'Scoped');
  assert.equal(project.mcpServers, undefined);
  workspace.updateProject(project.id, { mcpServers: ['installed'] });
  workspace.renameProject(project.id, 'Renamed');
  assert.deepEqual(workspace.store.get<Project>('project', project.id)?.mcpServers, ['installed']);
  assert.equal((await workspace.createProject(directory)).id, project.id);
  for (const ids of [['missing'], ['skill'], ['installed', 'installed']]) {
    assert.throws(() => workspace.updateProject(project.id, { name: 'Must not save', mcpServers: ids }));
    assert.equal(workspace.store.get<Project>('project', project.id)?.name, 'Renamed');
    assert.deepEqual(workspace.store.get<Project>('project', project.id)?.mcpServers, ['installed']);
  }
  workspace.updateProject(project.id, { mcpServers: [] });
  assert.deepEqual(workspace.store.get<Project>('project', project.id)?.mcpServers, []);
  workspace.updateProject(project.id, { mcpServers: null });
  assert.equal(workspace.store.get<Project>('project', project.id)?.mcpServers, undefined);
});
test('project trust persists, reaches execution for nested worktrees, and revokes on the next run', async (t) => {
  const { workspace, controller, directory } = fixture(t);
  // Keep the project beside the fixture's data directory, not above it.
  const projectPath = join(directory, 'project');
  mkdirSync(projectPath);
  const parent = await workspace.createProject(projectPath);
  const path = join(projectPath, '.claude', 'worktrees', 'synthetic-task');
  mkdirSync(path, { recursive: true });
  assert.equal(parent.trusted, undefined);
  assert.equal(controller.isTrustedProjectPath?.(path), false);
  workspace.updateProject(parent.id, { trusted: true });
  assert.equal(workspace.store.get<Project>('project', parent.id)?.trusted, true);
  assert.equal(controller.isTrustedProjectPath?.(path), true);
  const child = await workspace.createProject(path);
  assert.equal(controller.isTrustedProjectPath?.(path), false);
  workspace.updateProject(child.id, { trusted: true });
  assert.equal(controller.isTrustedProjectPath?.(directory + '-other'), false);
  workspace.renameProject(parent.id, 'Renamed');
  assert.equal(workspace.store.get<Project>('project', parent.id)?.trusted, true);
  const contexts: ExecuteContext[] = [];
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    contexts.push(ctx);
    return { output: 'Synthetic reply', nativeSessionId: 'synthetic-session' };
  });
  const conversation = workspace.createConversation(child.id);
  const first = await workspace.send(conversation.id, { ...base, runtimeId: 'mock' });
  assert.equal((await finish(workspace, first.workflow.id)).status, 'completed');
  assert.equal(contexts[0]?.trustedProject, true);
  assert.equal(contexts[0]?.input.permissionMode, 'read-only');
  workspace.updateProject(parent.id, { trusted: false });
  assert.equal(workspace.store.get<Project>('project', parent.id)?.trusted, false);
  workspace.updateProject(child.id, { trusted: false });
  const next = await workspace.send(conversation.id, {
    ...base,
    runtimeId: 'mock',
    content: 'Continue the discussion',
  });
  assert.equal((await finish(workspace, next.workflow.id)).status, 'completed');
  assert.equal(contexts.at(-1)?.trustedProject, false);
});

test('continuous chat injects selected project memory and prior conversation while preserving run links', async (t) => {
  const { workspace, directory } = fixture(t);
  const prompts: string[] = [];
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    prompts.push(ctx.input.prompt);
    return { output: prompts.length === 1 ? 'first reply' : 'second reply', nativeSessionId: 'native-session' };
  });
  const p = await workspace.createProject(directory);
  workspace.updateMemory(p.id, 'Project language: Chinese', 0);
  const c = workspace.createConversation(p.id);
  const clientMessageId = 'c2303f94-5c31-4ed3-943f-96fd3c499acd';
  const first = await workspace.send(c.id, { ...base, clientMessageId });
  assert.equal(first.message.clientMessageId, clientMessageId);
  assert.equal(
    workspace.store.messages(c.id).find((message) => message.id === first.message.id)?.clientMessageId,
    clientMessageId,
  );
  assert.equal((await finish(workspace, first.workflow.id)).status, 'completed');
  const savedReply = workspace.store.messages(c.id).find((message) => message.role === 'assistant')!;
  assert.equal(savedReply.replyIdentity?.automatic, true);
  assert.equal(savedReply.replyIdentity?.runs.length, 1);
  assert.equal(savedReply.replyIdentity?.runs[0]?.model, 'mock-model');
  const firstIdentity = structuredClone(savedReply.replyIdentity);
  const second = await workspace.send(c.id, { ...base, content: 'Continue the discussion' });
  const flow = await finish(workspace, second.workflow.id);
  assert.equal(flow.status, 'completed');
  assert.ok(prompts[1]!.includes('first reply'));
  assert.ok(prompts[1]!.includes('Project language: Chinese'));
  assert.equal(flow.memoryRevision, 1);
  assert.equal(workspace.store.messages(c.id).length, 4);
  assert.deepEqual(
    workspace.store.messages(c.id).find((message) => message.id === savedReply.id)?.replyIdentity,
    firstIdentity,
  );
  const runs = workspace.controller.store.runSummaries();
  assert.equal(runs.length, 2);
  assert.ok(runs.every((r) => r.workflowId && r.stepId === 'reply'));
  assert.equal(workspace.memory(p.id).recentWork.length, 2);
});

test('independent conversations start together while another message in the same conversation stays ordered', async (t) => {
  const { workspace, controller, directory } = fixture(t);
  const started: ExecuteContext[] = [];
  const releases: (() => void)[] = [];
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    started.push(ctx);
    await new Promise<void>((resolve) => {
      releases.push(resolve);
      ctx.signal.addEventListener('abort', () => resolve(), { once: true });
    });
    return { output: `Result ${ctx.input.routingPrompt}`, nativeSessionId: `session-${ctx.input.workflowId}` };
  });
  const project = await workspace.createProject(directory);
  const first = workspace.createConversation(project.id);
  const independent = workspace.createConversation(project.id);
  const held = await workspace.send(first.id, { ...base, runtimeId: 'mock', content: 'Inspect the first subject.' });
  await workflowState(workspace, () => started.length === 1);
  const ordered = await workspace.send(first.id, {
    ...base,
    runtimeId: 'mock',
    content: 'Continue the first subject.',
  });
  const hello = await workspace.send(independent.id, { ...base, runtimeId: 'mock', content: '你好' });
  await workflowState(workspace, () => started.length === 2);
  assert.deepEqual(
    started.map((ctx) => ctx.input.workflowId),
    [held.workflow.id, hello.workflow.id],
  );
  assert.equal(workspace.store.get<Workflow>('workflow', ordered.workflow.id)?.status, 'waiting-resource');
  assert.match(
    workspace.store.get<Workflow>('workflow', ordered.workflow.id)?.scheduling?.reason ?? '',
    /本对话上一条/,
  );
  releases[1]!();
  assert.equal((await finish(workspace, hello.workflow.id)).status, 'completed');
  assert.ok([...controller.active.values()].some((entry) => entry.run.workflowId === held.workflow.id));
  releases[0]!();
  assert.equal((await finish(workspace, held.workflow.id)).status, 'completed');
  await workflowState(workspace, () => started.length === 3);
  assert.equal(started[2]!.nativeSessionId, `session-${held.workflow.id}`);
  releases[2]!();
  assert.equal((await finish(workspace, ordered.workflow.id)).status, 'completed');
});

test('continuing an automatically routed reply preserves its display origin despite native-session pinning', async (t) => {
  const { workspace, directory } = fixture(t);
  t.mock.method(codexAdapter, 'execute', async () => ({
    output: 'A synthetic answer',
    nativeSessionId: 'fixture-session',
  }));
  const project = await workspace.createProject(directory);
  const conversation = workspace.createConversation(project.id);
  const submitted = await workspace.send(conversation.id, base);
  const original = await finish(workspace, submitted.workflow.id);
  original.status = 'blocked';
  workspace.store.save('workflow', original.id, conversation.id, original);
  const resumed = await workspace.continue(original.id);
  assert.equal(resumed.workflow.input.runtimeId, 'mock', 'continuation internally pins the prior executor');
  assert.equal(resumed.workflow.replyRouting, 'auto');
  const done = await finish(workspace, resumed.workflow.id);
  assert.equal(done.status, 'completed');
  assert.equal(
    workspace.store.get<ConversationMessage>('message', done.finalMessageId!)?.replyIdentity?.automatic,
    true,
  );
});

for (const provider of ['codex', 'pi', 'grok', 'claude'] as const)
  test(`${provider} accepts a mid-run correction in the same task without judgment, a new run or a queue item`, async (t) => {
    const { workspace, controller, directory } = fixture(t, provider);
    controller.settings.steerOnSend = true;
    let release!: () => void;
    const corrections: string[] = [];
    let launches = 0;
    t.mock.method(
      { codex: codexAdapter, pi: piAdapter, grok: grokAdapter, claude: claudeAdapter }[provider],
      'execute',
      async (ctx: ExecuteContext) => {
        launches++;
        ctx.registerSteer?.(async (prompt) => {
          corrections.push(prompt);
        });
        await new Promise<void>((resolve) => {
          release = resolve;
          queueMicrotask(() => workspace.controller.broadcast());
          ctx.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        ctx.registerSteer?.(undefined);
        return { output: 'Corrected result', nativeSessionId: 'same-session' };
      },
    );
    const project = await workspace.createProject(directory);
    const conversation = workspace.createConversation(project.id);
    const first = await workspace.send(conversation.id, { ...base, runtimeId: 'mock' });
    await workflowState(workspace, () =>
      [...controller.active.values()].some((entry) => controller.canSteer(entry.run.id)),
    );
    const correction = await workspace.send(conversation.id, {
      ...base,
      runtimeId: 'mock',
      content: 'Exclude FolderCinema; only inspect folders starting with digits.',
      uiLocale: 'en',
    });
    assert.equal(correction.workflow.id, first.workflow.id);
    assert.equal(correction.message.steering?.status, 'accepted');
    assert.equal(corrections.length, 1);
    assert.ok(corrections[0]!.startsWith('Exclude FolderCinema; only inspect folders starting with digits.'));
    assert.match(corrections[0]!, /面向用户的解释、分析和提问必须用英语写/);
    assert.match(corrections[0]!, /英文邮件或截图应给出英文草稿/);
    assert.equal(correction.workflow.input.uiLocale, 'en');
    assert.equal(workspace.state().workflows?.length, 1);
    assert.equal(controller.store.runSummaries().length, 1);
    assert.equal(launches, 1);
    release();
    const finished = await finish(workspace, first.workflow.id);
    assert.match(finished.input.content, /Exclude FolderCinema/);
    assert.equal(
      workspace.store.get<ConversationMessage>('message', correction.message.id)?.steering?.status,
      'accepted',
    );
    assert.equal(controller.store.runSummaries()[0]?.steerAvailable, false);
  });

test('an explicitly independent message waits in the queue until the user inserts it', async (t) => {
  const { workspace, controller, directory } = fixture(t, 'grok');
  let release!: () => void;
  const corrections: string[] = [];
  t.mock.method(grokAdapter, 'execute', async (ctx: ExecuteContext) => {
    ctx.registerSteer?.(async (prompt) => {
      corrections.push(prompt);
    });
    await new Promise<void>((resolve) => {
      release = resolve;
      queueMicrotask(() => workspace.controller.broadcast());
      ctx.signal.addEventListener('abort', () => resolve(), { once: true });
    });
    ctx.registerSteer?.(undefined);
    return { output: 'Done', nativeSessionId: 'same-session' };
  });
  const project = await workspace.createProject(directory);
  const conversation = workspace.createConversation(project.id);
  const first = await workspace.send(conversation.id, { ...base, runtimeId: 'mock' });
  await workflowState(workspace, () =>
    [...controller.active.values()].some((entry) => controller.canSteer(entry.run.id)),
  );
  const later = await workspace.send(conversation.id, {
    ...base,
    runtimeId: 'mock',
    content: 'Also sort the new folder.',
    uiLocale: 'en',
    queue: true,
  });
  // Queued, not delivered: nothing reached the running session.
  assert.notEqual(later.workflow.id, first.workflow.id);
  assert.equal(later.message.steering, undefined);
  assert.deepEqual(corrections, []);
  // The user decides to insert it now.
  const inserted = await workspace.steerQueued(later.workflow.id);
  assert.equal(inserted.workflow.id, first.workflow.id);
  assert.equal(corrections.length, 1);
  assert.ok(String(corrections[0]).startsWith('Also sort the new folder.'));
  assert.match(corrections[0]!, /面向用户的解释、分析和提问必须用英语写/);
  assert.match(corrections[0]!, /英文邮件或截图应给出英文草稿/);
  assert.equal(inserted.workflow.input.uiLocale, 'en');
  release();
  await finish(workspace, first.workflow.id);
});

test('a scope remark keeps the writable workflow running and persists the constraint', async (t) => {
  const { workspace, controller, directory } = fixture(t);
  const calls: ExecuteContext[] = [];
  const corrections: string[] = [];
  let release!: () => void;
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    calls.push(ctx);
    ctx.registerSteer?.(async (prompt) => {
      corrections.push(prompt);
    });
    await new Promise<void>((done) => {
      release = done;
      ctx.signal.addEventListener('abort', () => done(), { once: true });
      queueMicrotask(() => controller.broadcast());
    });
    return { output: 'Synthetic scope preserved', nativeSessionId: 'synthetic-scope-session' };
  });
  const project = await workspace.createProject(directory);
  const conversation = workspace.createConversation(project.id);
  const writable: MessageInput = {
    ...base,
    mode: 'auto',
    permissionMode: 'workspace-write',
    explicitWrite: true,
    content: 'Move the synthetic reports into their archive.',
    runtimeId: 'mock',
  };
  const first = await workspace.send(conversation.id, writable);
  await workflowState(workspace, () =>
    [...controller.active.values()].some((entry) => controller.canSteer(entry.run.id)),
  );
  const content = '别' + '删原文件';
  const next = await workspace.send(conversation.id, { ...writable, content });
  assert.equal(next.workflow.id, first.workflow.id);
  assert.equal(next.message.steering?.status, 'accepted');
  assert.equal(calls[0]!.signal.aborted, false);
  assert.equal(next.workflow.input.permissionMode, 'workspace-write');
  assert.ok(next.workflow.input.scopeNote?.includes(content));
  assert.ok(next.workflow.input.intentText?.includes(content));
  assert.equal(corrections.length, 1);
  assert.ok(corrections[0]!.startsWith(content));
  release();
  await finish(workspace, first.workflow.id);
  assert.equal(calls.length, 1);
});

test('a bare stop or whole-message readonly phrase stops the writer even with an explicit grant', async (t) => {
  for (const content of ['停止', '只看' + '不改'])
    for (const withAttachment of [false, true])
      await t.test(`${content}: ${withAttachment ? 'with an attachment' : 'plain text'}`, async (t) => {
        const { workspace, controller, directory } = fixture(t);
        const calls: ExecuteContext[] = [];
        const steers: string[] = [];
        t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
          calls.push(ctx);
          queueMicrotask(() => workspace.controller.broadcast());
          if (calls.length === 1) {
            ctx.registerSteer?.(async (text) => {
              steers.push(text);
            });
            await new Promise<void>((resolve) => ctx.signal.addEventListener('abort', () => resolve(), { once: true }));
          }
          return {
            output: calls.length === 1 ? 'Partial work preserved' : 'Read-only inspection',
            nativeSessionId: `native-${calls.length}`,
          };
        });
        const project = await workspace.createProject(directory);
        const conversation = workspace.createConversation(project.id);
        const first = await workspace.send(conversation.id, {
          ...base,
          mode: 'build',
          permissionMode: 'workspace-write',
          runtimeId: 'mock',
          content: 'Move the synthetic report into its archive.',
        });
        await workflowState(workspace, () =>
          [...controller.active.values()].some((entry) => controller.canSteer(entry.run.id)),
        );
        const attachment = withAttachment
          ? await saveAttachment(workspace.attachments, conversation.id, {
              name: 'synthetic-note.txt',
              mimeType: 'text/plain',
              dataBase64: Buffer.from('Synthetic read-only inspection note').toString('base64'),
            })
          : undefined;
        const next = await workspace.send(conversation.id, {
          ...base,
          mode: 'auto',
          permissionMode: 'workspace-write',
          runtimeId: 'mock',
          explicitWrite: true,
          content,
          ...(attachment ? { attachmentIds: [attachment.id] } : {}),
        });
        assert.notEqual(next.workflow.id, first.workflow.id);
        assert.equal(next.message.steering, undefined);
        assert.deepEqual(steers, []);
        assert.equal((await finish(workspace, next.workflow.id)).status, 'completed');
        assert.equal(calls[0]?.signal.aborted, true);
        assert.equal(workspace.store.get<Workflow>('workflow', first.workflow.id)?.input.readOnlyTrigger, content);
        assert.equal(calls[1]?.input.permissionMode, 'read-only');
        assert.equal(calls[1]?.nativeSessionId, undefined);
        assert.match(calls[1]!.input.prompt, /Partial work preserved/);
      });
});

test('partial execution reports remain blocked and are never retried automatically', async (t) => {
  const { workspace, controller, directory } = fixture(t);
  let calls = 0;
  t.mock.method(codexAdapter, 'execute', async () => {
    calls++;
    return {
      output: 'Source files remain.\nCOMBORUNNER_TASK_RESULT: {"status":"blocked","summary":"The move has not run."}',
    };
  });
  const project = await workspace.createProject(directory);
  const conversation = workspace.createConversation(project.id);
  const submitted = await workspace.send(conversation.id, {
    ...base,
    mode: 'build',
    permissionMode: 'workspace-write',
    runtimeId: 'mock',
    content: 'Move the synthetic report into its archive.',
  });
  const result = await finish(workspace, submitted.workflow.id);
  assert.equal(result.status, 'blocked');
  assert.match(result.error!, /move has not run/);
  assert.equal(calls, 1);
  assert.equal(controller.store.runSummaries()[0]?.taskOutcome?.status, 'blocked');
});

test('a manually selected writable Grok task can complete the requested review without mutations', async (t) => {
  const { workspace, controller, directory } = fixture(t, 'grok');
  const calls: ExecuteContext[] = [];
  const content = '再看看这个项目，还有什么需要改动的或者重复的';
  t.mock.method(grokAdapter, 'execute', async (ctx: ExecuteContext) => {
    calls.push(ctx);
    queueMicrotask(() => workspace.controller.broadcast());
    return {
      output:
        '已完成检查并列出问题，没有修改文件。\nCOMBORUNNER_TASK_RESULT: {"status":"completed","summary":"已交付本轮要求的检查结果；未执行未请求的修改。"}',
    };
  });
  const project = await workspace.createProject(directory);
  const conversation = workspace.createConversation(project.id);
  const submitted = await workspace.send(conversation.id, {
    ...base,
    mode: 'build',
    permissionMode: 'workspace-write',
    runtimeId: 'mock',
    content,
  });
  const result = await finish(workspace, submitted.workflow.id);
  assert.equal(result.status, 'completed');
  assert.equal(calls.length, 1);
  assert.ok(calls[0]!.input.prompt.includes(content));
  assert.ok(calls[0]!.input.prompt.includes(taskOutcomeInstruction('deliver')));
  assert.equal(calls[0]!.input.reportTaskOutcome, true);
  assert.equal(calls[0]!.input.permissionMode, 'workspace-write');
  const run = controller.store.run(result.runIds[0]!)!;
  assert.equal(run.taskOutcome?.status, 'completed');
  const reply = workspace.store.get<ConversationMessage>('message', result.finalMessageId!)!;
  assert.match(reply.content, /已完成检查/);
  assert.ok(!reply.content.includes('COMBORUNNER_TASK_RESULT'));
  assert.equal(reply.replyIdentity?.automatic, false);
  assert.equal(reply.replyIdentity?.runs[0]?.runId, run.id);
  assert.equal(result.error, undefined);
});

test('a completed inspection step does not block the separately requested modification step', async (t) => {
  const { workspace, controller, directory } = fixture(t);
  const steps: string[] = [];
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    if (!ctx.input.stepId)
      return {
        output: JSON.stringify({
          steps: [
            { id: 'inspect', title: 'Inspect', instruction: 'Only inspect the architecture and report findings.' },
            {
              id: 'apply',
              title: 'Apply',
              instruction: 'Implement the requested architecture changes.',
              dependsOn: ['inspect'],
            },
          ],
        }),
      };
    steps.push(ctx.input.stepId);
    assert.ok(ctx.input.prompt.includes(taskOutcomeInstruction(ctx.input.stepId === 'inspect' ? 'check' : 'deliver')));
    if (ctx.input.stepId === 'apply') writeWithReceipt(ctx, 'architecture.txt', 'Requested architecture changes.');
    return {
      output:
        (ctx.input.stepId === 'inspect' ? 'Inspection delivered; no files changed.' : 'Requested changes delivered.') +
        '\nCOMBORUNNER_TASK_RESULT: {"status":"completed","summary":"The requested current step is complete."}',
    };
  });
  const project = await workspace.createProject(directory);
  const conversation = workspace.createConversation(project.id);
  const submitted = await workspace.send(conversation.id, {
    ...base,
    mode: 'build',
    permissionMode: 'workspace-write',
    content: 'Implement a complex architecture change after inspecting the current architecture.',
  });
  const result = await finish(workspace, submitted.workflow.id);
  assert.equal(result.status, 'completed');
  assert.deepEqual(steps, ['inspect', 'apply']);
  assert.ok(result.plan.every((step) => step.status === 'completed'));
  assert.equal(controller.store.runSummaries().filter((run) => run.taskOutcome?.status === 'completed').length, 2);
  const identity = workspace.store.get<ConversationMessage>('message', result.finalMessageId!)?.replyIdentity;
  assert.equal(identity?.runs.length, 2, 'the planner is not an author of the combined reply');
  assert.ok(identity?.runs.every((source) => !!controller.run(source.runId)?.stepId));
});

test('a paused workflow and its assistant reply preserve the concrete native refusal reason', async (t) => {
  const { workspace, controller, directory } = fixture(t, 'grok');
  let launches = 0;
  const detail =
    'Auto mode blocked this action (The current request only asks for review; moving files is unrequested).';
  t.mock.method(grokAdapter, 'execute', async (ctx: ExecuteContext) => {
    launches++;
    ctx.emit({
      at: new Date().toISOString(),
      type: 'error',
      data: { executionBlocked: true, reason: 'permission', detail },
    });
    return {
      output: 'Reviewed the files.\nCOMBORUNNER_TASK_RESULT: {"status":"partial","summary":"No files were moved."}',
    };
  });
  const project = await workspace.createProject(directory);
  const conversation = workspace.createConversation(project.id);
  const submitted = await workspace.send(conversation.id, {
    ...base,
    mode: 'build',
    permissionMode: 'workspace-write',
    runtimeId: 'mock',
    content: 'Move the synthetic report into its archive.',
  });
  const result = await finish(workspace, submitted.workflow.id);
  assert.equal(result.status, 'blocked');
  assert.equal(launches, 1);
  assert.ok(result.error?.includes(detail));
  const notice = workspace.store.get<ConversationMessage>('message', result.finalMessageId!)!;
  assert.ok(notice.systemNotice?.details?.includes(detail));
  assert.doesNotMatch(notice.content, /Auto mode blocked/);
  assert.equal(
    workspace.store.get<ConversationMessage>('message', result.finalMessageId!)?.replyIdentity?.kind,
    'system',
  );
  assert.ok(controller.store.run(result.runIds[0]!)?.error?.includes(detail));
});

test('a late steering acknowledgment settles before the next planned step consumes task scope', async (t) => {
  const { workspace, controller, directory } = fixture(t);
  controller.settings.steerOnSend = true;
  let nativeDone!: () => void;
  let acknowledge!: () => void;
  const calls: ExecuteContext[] = [];
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    calls.push(ctx);
    queueMicrotask(() => workspace.controller.broadcast());
    if (!ctx.input.stepId)
      return {
        output: JSON.stringify({
          steps: [
            { id: 'one', title: 'Inspect', instruction: 'Inspect the task' },
            { id: 'two', title: 'Apply', instruction: 'Apply the changes', dependsOn: ['one'] },
          ],
        }),
      };
    if (ctx.input.stepId === 'one') {
      ctx.registerSteer?.(
        () =>
          new Promise<void>((resolve) => {
            acknowledge = resolve;
            ctx.signal.addEventListener('abort', () => resolve(), { once: true });
            queueMicrotask(() => workspace.controller.broadcast());
          }),
      );
      await new Promise<void>((resolve) => {
        nativeDone = resolve;
        queueMicrotask(() => workspace.controller.broadcast());
        ctx.signal.addEventListener('abort', () => resolve(), { once: true });
      });
    }
    if (ctx.input.stepId === 'two') writeWithReceipt(ctx, 'numbered-reports.txt', 'Only numbered report directories.');
    return { output: 'Synthetic result', nativeSessionId: `session-${ctx.input.stepId}` };
  });
  const project = await workspace.createProject(directory);
  const conversation = workspace.createConversation(project.id);
  const first = await workspace.send(conversation.id, {
    ...base,
    mode: 'build',
    permissionMode: 'workspace-write',
    content: 'Implement a complex architecture change.',
  });
  await workflowState(workspace, () =>
    [...controller.active.values()].some((entry) => controller.canSteer(entry.run.id)),
  );
  const sending = workspace.send(conversation.id, {
    ...base,
    mode: 'auto',
    permissionMode: 'workspace-write',
    content: 'Only include numbered report directories.',
    clientMessageId: 'f8f5caf2-390a-4f18-bf8c-dea40f745719',
  });
  await workflowState(workspace, () => !!acknowledge);
  assert.equal(
    workspace.store.messages(conversation.id).at(-1)?.clientMessageId,
    'f8f5caf2-390a-4f18-bf8c-dea40f745719',
  );
  nativeDone();
  await workflowState(
    workspace,
    () =>
      controller.run(workspace.store.get<Workflow>('workflow', first.workflow.id)!.runIds.at(-1)!)?.steeringStatus
        ?.state === 'finishing',
  );
  assert.equal(calls.filter((ctx) => ctx.input.stepId === 'two').length, 0);
  acknowledge();
  const delivered = await sending;
  assert.equal(delivered.message.steering?.status, 'accepted');
  assert.equal((await finish(workspace, first.workflow.id)).status, 'completed');
  assert.match(
    calls.find((ctx) => ctx.input.stepId === 'two')!.input.prompt,
    /Only include numbered report directories/,
  );
});

test('an uncertain steering acknowledgment is saved and never replayed as a queued task', async (t) => {
  const { workspace, controller, directory } = fixture(t);
  controller.settings.steerOnSend = true;
  let release!: () => void;
  let deliveries = 0;
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    ctx.registerSteer?.(async () => {
      deliveries++;
      throw new Error('runtime-protocol-timeout');
    });
    await new Promise<void>((resolve) => {
      release = resolve;
      queueMicrotask(() => workspace.controller.broadcast());
      ctx.signal.addEventListener('abort', () => resolve(), { once: true });
    });
    return { output: 'Original result' };
  });
  const project = await workspace.createProject(directory);
  const conversation = workspace.createConversation(project.id);
  const first = await workspace.send(conversation.id, { ...base, runtimeId: 'mock' });
  await workflowState(workspace, () =>
    [...controller.active.values()].some((entry) => controller.canSteer(entry.run.id)),
  );
  const correction = await workspace.send(conversation.id, {
    ...base,
    runtimeId: 'mock',
    content: 'Narrow the current scope.',
  });
  assert.equal(correction.message.steering?.status, 'failed');
  assert.match(correction.message.steering?.error ?? '', /不会自动排队/);
  assert.equal(deliveries, 1);
  assert.equal(workspace.state().workflows?.length, 1);
  release();
  await finish(workspace, first.workflow.id);
  assert.equal(controller.store.runSummaries().length, 1);
});

test('steering that ends before delivery creates one normal follow-up without duplicating its message', async (t) => {
  const { workspace, controller, directory } = fixture(t);
  let release!: () => void;
  let launches = 0;
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    launches++;
    ctx.registerSteer?.(async () => {});
    if (launches === 1)
      await new Promise<void>((resolve) => {
        release = resolve;
        queueMicrotask(() => workspace.controller.broadcast());
        ctx.signal.addEventListener('abort', () => resolve(), { once: true });
      });
    return { output: `Result ${launches}` };
  });
  const project = await workspace.createProject(directory);
  const conversation = workspace.createConversation(project.id);
  const first = await workspace.send(conversation.id, { ...base, runtimeId: 'mock' });
  await workflowState(workspace, () =>
    [...controller.active.values()].some((entry) => controller.canSteer(entry.run.id)),
  );
  t.mock.method(controller, 'steer', async () => false);
  const next = await workspace.send(conversation.id, { ...base, runtimeId: 'mock', content: 'Late correction.' });
  assert.notEqual(next.workflow.id, first.workflow.id);
  assert.equal(next.message.steering, undefined);
  assert.equal(workspace.store.allMessages(conversation.id).filter((m) => m.content === 'Late correction.').length, 1);
  release();
  await finish(workspace, next.workflow.id);
  assert.equal(launches, 2);
});

test('a restart marks a pending steer uncertain and does not replay it', async (t) => {
  let pendingId = '';
  const { workspace } = fixture(t, 'codex', (store, directory) => {
    const at = new Date().toISOString();
    const project: Project = {
      id: '12345678-1234-4234-8234-123456789abc',
      name: 'Synthetic',
      path: directory,
      createdAt: at,
      updatedAt: at,
    };
    const conversation: Conversation = {
      id: '22345678-1234-4234-8234-123456789abc',
      projectId: project.id,
      title: 'Synthetic',
      createdAt: at,
      updatedAt: at,
    };
    store.save('project', project.id, project.id, project);
    store.save('conversation', conversation.id, project.id, conversation);
    const message = store.addMessage(conversation.id, 'user', 'Possibly delivered input.');
    message.steering = { runId: 'lost-live-run', status: 'pending' };
    pendingId = message.id;
    store.save('message', message.id, conversation.id, message);
  });
  const message = workspace.store.get<ConversationMessage>('message', pendingId)!;
  assert.equal(message.steering?.status, 'failed');
  assert.match(message.steering?.error ?? '', /无法确认/);
  assert.equal(workspace.state().workflows?.length, 0);
});

test('switching the model creates a linked successor without changing the live turn', async (t) => {
  const { workspace, controller, directory } = fixture(t);
  let release!: () => void;
  const corrections: string[] = [];
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    ctx.registerSteer?.(async (prompt) => {
      corrections.push(prompt);
    });
    await new Promise<void>((resolve) => {
      release = resolve;
      queueMicrotask(() => workspace.controller.broadcast());
      ctx.signal.addEventListener('abort', () => resolve(), { once: true });
    });
    return { output: 'Original result' };
  });
  const project = await workspace.createProject(directory);
  const conversation = workspace.createConversation(project.id);
  const first = await workspace.send(conversation.id, { ...base, runtimeId: 'mock' });
  await workflowState(workspace, () =>
    [...controller.active.values()].some((entry) => controller.canSteer(entry.run.id)),
  );
  const next = await workspace.send(conversation.id, {
    ...base,
    runtimeId: 'mock',
    model: 'another-model',
    content: 'New task.',
  });
  assert.notEqual(next.workflow.id, first.workflow.id);
  assert.equal(next.workflow.parentWorkflowId, first.workflow.id);
  assert.match(next.workflow.input.content, /Explain this project/);
  assert.match(next.workflow.input.content, /New task\./);
  assert.match('notice' in next ? next.notice! : '', /模型.*保留进度/);
  assert.equal(workspace.store.get<Workflow>('workflow', first.workflow.id)?.input.model, undefined);
  assert.equal(next.message.steering, undefined);
  assert.deepEqual(corrections, []);
  workspace.cancel(next.workflow.id);
  release();
  await finish(workspace, first.workflow.id);
});

test('a selected native CLI handles a complex build in one call with old local path evidence', async (t) => {
  const { workspace, controller, directory } = fixture(t);
  const calls: ExecuteContext[] = [];
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    calls.push(ctx);
    queueMicrotask(() => workspace.controller.broadcast());
    writeWithReceipt(ctx, 'classification-report.md', 'Synthetic classification report; original files retained.');
    return {
      output: 'Native CLI inspected files, arranged the work and completed the requested task.',
      nativeSessionId: 'native-build',
    };
  });
  t.mock.method(controller.taskJudge, 'judge', async () => assert.fail('Pinned CLI must not call Jev.'));
  const project = await workspace.createProject(directory);
  const conversation = workspace.createConversation(project.id);
  const download = join(directory, '迅雷下载');
  mkdirSync(download);
  workspace.store.addMessage(conversation.id, 'assistant', `工具结果：迅雷下载的准确目录是 "${download}"。`);
  for (let index = 0; index < 80; index++)
    workspace.store.addMessage(conversation.id, 'assistant', `Unrelated archived item ${index}`);
  const submitted = await workspace.send(conversation.id, {
    ...base,
    content: '创建迅雷下载文件的分类报告，然后核对已有记录，保留原文件。',
    mode: 'build',
    permissionMode: 'workspace-write',
    runtimeId: 'mock',
    model: 'mock-model',
    effort: 'high',
  });
  const result = await finish(workspace, submitted.workflow.id);
  assert.equal(result.status, 'completed');
  assert.equal(result.planning?.strategy, 'native');
  assert.equal(result.runIds.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.input.permissionMode, 'workspace-write');
  assert.equal(calls[0]!.route.effort, 'high');
  assert.ok(calls[0]!.input.prompt.includes(download));
  assert.match(calls[0]!.input.prompt, /存在，目录/);
  assert.ok(!calls[0]!.input.prompt.includes('Return ONLY one JSON'));
});

test('same account conversation resumes natively with a smaller turn prompt and a new conversation gets a new session', async (t) => {
  const { workspace, directory } = fixture(t);
  const calls: ExecuteContext[] = [];
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    calls.push(ctx);
    queueMicrotask(() => workspace.controller.broadcast());
    return { output: `Reply ${calls.length}`, nativeSessionId: ctx.nativeSessionId ?? `session-${calls.length}` };
  });
  const project = await workspace.createProject(directory);
  const conversation = workspace.createConversation(project.id);
  for (let index = 0; index < 20; index++)
    workspace.store.addMessage(conversation.id, 'assistant', `Old unrelated material ${index} ${'x'.repeat(2500)}`);
  const first = await workspace.send(conversation.id, {
    ...base,
    runtimeId: 'mock',
    content: 'Explain the synthetic module.',
  });
  assert.equal((await finish(workspace, first.workflow.id)).status, 'completed');
  const second = await workspace.send(conversation.id, {
    ...base,
    runtimeId: 'mock',
    content: 'Explain one other example.',
  });
  const resumed = await finish(workspace, second.workflow.id);
  assert.equal(resumed.status, 'completed');
  assert.equal(calls[1]!.nativeSessionId, 'session-1');
  assert.ok(calls[1]!.input.prompt.length < calls[0]!.input.prompt.length / 2);
  assert.match(calls[1]!.input.prompt, /Explain one other example/);
  const fresh = workspace.createConversation(project.id);
  const third = await workspace.send(fresh.id, { ...base, runtimeId: 'mock', content: '你好' });
  assert.equal((await finish(workspace, third.workflow.id)).status, 'completed');
  assert.equal(calls[2]!.nativeSessionId, undefined);
});
test('switching Grok, Codex and Claude keeps conversation context without copying native sessions', async (t) => {
  const { workspace, controller, directory } = fixture(t);
  const grok = { ...snap(), id: 'grok-b', provider: 'grok' as const, label: 'Grok B' };
  const claude = { ...snap(), id: 'claude-native', provider: 'claude' as const, label: 'Claude' };
  controller.targets.push(
    { id: grok.id, provider: 'grok', label: grok.label, command: 'unused', environment: 'native', enabled: true },
    { id: claude.id, provider: 'claude', label: claude.label, command: 'unused', environment: 'native', enabled: true },
  );
  controller.snapshots.push(grok, claude);
  t.mock.method(grokAdapter, 'discover', async () => ({ ...grok }));
  t.mock.method(claudeAdapter, 'discover', async () => ({ ...claude }));
  const calls: ExecuteContext[] = [];
  for (const adapter of [grokAdapter, codexAdapter, claudeAdapter])
    t.mock.method(adapter, 'execute', async (ctx: ExecuteContext) => {
      calls.push(ctx);
      queueMicrotask(() => workspace.controller.broadcast());
      return { output: `Synthetic saved result from ${ctx.target.id}`, nativeSessionId: `session-${ctx.target.id}` };
    });
  t.mock.method(controller.taskJudge, 'judge', async () => {
    assert.fail('An explicit executor must not call Jev while continuing the conversation.');
  });
  const project = await workspace.createProject(directory);
  workspace.updateMemory(project.id, 'Synthetic project preference: keep existing filenames.', 0);
  const conversation = workspace.createConversation(project.id);
  const unrelated = workspace.createConversation(project.id);
  workspace.store.addMessage(unrelated.id, 'user', 'Unrelated conversation secret marker');
  for (const runtimeId of [grok.id, 'mock', claude.id, grok.id]) {
    const result = await workspace.send(conversation.id, {
      ...base,
      runtimeId,
      content: calls.length ? 'Continue the same task from the saved result.' : 'Explain the synthetic project first.',
    });
    assert.equal((await finish(workspace, result.workflow.id)).status, 'completed');
  }
  assert.deepEqual(
    calls.map((call) => call.target.id),
    [grok.id, 'mock', claude.id, grok.id],
  );
  for (const [index, call] of calls.entries()) {
    assert.equal(call.input.projectPath, project.path);
    assert.equal(call.input.permissionMode, 'read-only');
    assert.equal(call.input.resumeRunId, undefined);
    assert.equal(call.nativeSessionId, index === 3 ? `session-${grok.id}` : undefined);
    assert.ok(call.input.prompt.includes('Synthetic project preference: keep existing filenames.'));
    assert.ok(call.input.prompt.includes(memoryPaths(workspace, project, conversation.id).history));
    assert.ok(!call.input.prompt.includes('Unrelated conversation secret marker'));
    for (const earlier of calls.slice(0, index))
      assert.ok(call.input.prompt.includes(`Synthetic saved result from ${earlier.target.id}`));
  }
  assert.equal(workspace.store.messages(conversation.id).length, 8);
});

test('a different provider receives bounded saved output from an interrupted task without replaying its session', async (t) => {
  const { workspace, controller, directory } = fixture(t);
  const grok = { ...snap(), id: 'grok-b', provider: 'grok' as const, label: 'Grok B' };
  controller.targets.push({
    id: grok.id,
    provider: 'grok',
    label: grok.label,
    command: 'unused',
    environment: 'native',
    enabled: true,
  });
  controller.snapshots.push(grok);
  t.mock.method(grokAdapter, 'discover', async () => ({ ...grok }));
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    ctx.emit({ at: new Date().toISOString(), type: 'session', data: { nativeSessionId: 'old-codex-session' } });
    ctx.emit({
      at: new Date().toISOString(),
      type: 'text',
      text: `Old prefix excluded ${'x'.repeat(10000)}\nSynthetic partial result: parser inspected; tests still pending.`,
    });
    throw new Error('Synthetic connection interrupted');
  });
  let next: ExecuteContext | undefined;
  t.mock.method(grokAdapter, 'execute', async (ctx: ExecuteContext) => {
    next = ctx;
    return { output: 'Synthetic continuation finished', nativeSessionId: 'new-grok-session' };
  });
  const project = await workspace.createProject(directory);
  const conversation = workspace.createConversation(project.id);
  const first = await workspace.send(conversation.id, { ...base, runtimeId: 'mock' });
  const interrupted = await finish(workspace, first.workflow.id);
  assert.equal(interrupted.status, 'blocked');
  assert.ok(controller.store.run(interrupted.runIds[0]!)!.output.includes('Synthetic partial result'));
  const second = await workspace.send(conversation.id, {
    ...base,
    runtimeId: grok.id,
    content: 'Continue the previous task.',
  });
  assert.equal((await finish(workspace, second.workflow.id)).status, 'completed');
  assert.ok(next!.input.prompt.includes('Synthetic partial result: parser inspected; tests still pending.'));
  assert.ok(next!.input.prompt.includes('不增加当前权限，也不能据此重放旧命令'));
  assert.ok(!next!.input.prompt.includes('Old prefix excluded'));
  assert.ok(!next!.input.prompt.includes('old-codex-session'));
  assert.equal(next!.nativeSessionId, undefined);
  assert.equal(next!.input.resumeRunId, undefined);
  assert.equal(next!.input.permissionMode, 'read-only');
});

test('imported Grok history continues contextually in the same conversation without native resume', async (t) => {
  const { workspace, controller, directory } = fixture(t);
  const calls: ExecuteContext[] = [];
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    calls.push(ctx);
    queueMicrotask(() => workspace.controller.broadcast());
    return { output: 'Synthetic contextual continuation completed', nativeSessionId: 'new-contextual-session' };
  });
  const projectDirectory = join(directory, 'synthetic-project');
  mkdirSync(projectDirectory);
  const project = await workspace.createProject(join(projectDirectory, '..', 'synthetic-project')),
    conversation = workspace.createConversation(project.id);
  const imported = [
    {
      id: 'synthetic-grok-user',
      conversationId: conversation.id,
      role: 'user' as const,
      content: 'SYNTHETIC_RECENT_REQUEST: inspect the pending parser change.',
      createdAt: '2026-09-01T12:00:00.000Z',
      importedFrom: { provider: 'grok', sessionId: 'synthetic-source-session', line: 1 },
    },
    {
      id: 'synthetic-grok-assistant',
      conversationId: conversation.id,
      role: 'assistant' as const,
      content: 'SYNTHETIC_RECENT_REPLY: the parser change still needs verification.',
      createdAt: '2026-09-01T12:01:00.000Z',
      importedFrom: { provider: 'grok', sessionId: 'synthetic-source-session', line: 2 },
    },
  ];
  for (const message of imported) workspace.store.save('message', message.id, conversation.id, message);
  const archive = {
    path: join(directory, 'synthetic-history.jsonl'),
    continuation: {
      sessionId: 'synthetic-source-session',
      updatedAt: '2026-09-01T12:02:00.000Z',
      lastUserRequest: 'SYNTHETIC_HANDOFF_REQUEST: finish the earlier parser task after inspecting existing files.',
      lastAssistantResponse: 'SYNTHETIC_HANDOFF_REPLY: one verification step remains; this is an unverified report.',
      planPath: join(projectDirectory, 'synthetic-plan.md'),
    },
  };
  workspace.store.save('history-archive', project.id, project.id, archive);
  const input: MessageInput = { ...base, content: '继续之前未完成的任务', runtimeId: 'mock' };
  const submitted = await workspace.send(conversation.id, input);
  const flow = await finish(workspace, submitted.workflow.id);
  assert.equal(flow.status, 'completed');
  assert.equal(flow.conversationId, conversation.id);
  assert.equal(flow.projectId, project.id);
  assert.equal(submitted.message.conversationId, conversation.id);
  assert.equal(flow.input.mode, input.mode);
  assert.equal(flow.input.permissionMode, input.permissionMode);
  assert.equal(calls.length, 1);
  const call = calls[0]!;
  assert.equal(call.input.projectPath, realpathSync.native(projectDirectory));
  assert.equal(call.input.permissionMode, input.permissionMode);
  assert.equal(call.input.resumeRunId, undefined);
  assert.equal(call.nativeSessionId, undefined);
  assert.equal(call.route.runtimeId, 'mock');
  for (const message of imported) {
    assert.ok(call.input.prompt.includes(message.content));
    assert.deepEqual(workspace.store.get('message', message.id), message);
  }
  for (const context of [
    archive.path,
    archive.continuation.lastUserRequest,
    archive.continuation.lastAssistantResponse,
    archive.continuation.planPath,
  ]) {
    assert.ok(flow.memoryExcerpt.includes(context));
    assert.ok(call.input.prompt.includes(context));
  }
  assert.deepEqual(workspace.store.get('history-archive', project.id), archive);
  assert.equal(workspace.store.allMessages(conversation.id).length, imported.length + 2);
  assert.equal(flow.runIds.length, 1);
  assert.equal(controller.store.run(flow.runIds[0]!)?.workflowId, flow.id);
  assert.equal(controller.store.run(flow.runIds[0]!)?.parentRunId, undefined);
});
test('local memory startup exports existing conversations without modifying imported records or executing tasks', async (t) => {
  let project!: Project,
    conversation!: Conversation,
    imported!: ConversationMessage,
    executions = 0;
  t.mock.method(codexAdapter, 'execute', async () => {
    executions++;
    return { output: 'Unexpected synthetic execution' };
  });
  const { workspace } = fixture(t, 'codex', (store, directory) => {
    const path = join(directory, 'synthetic-existing-project');
    mkdirSync(path);
    project = {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Synthetic existing project',
      path: realpathSync.native(path),
      createdAt: '2026-09-01T12:00:00.000Z',
      updatedAt: '2026-09-01T12:00:00.000Z',
    };
    conversation = {
      id: '22222222-2222-4222-8222-222222222222',
      projectId: project.id,
      title: 'Synthetic archived conversation',
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    };
    imported = {
      id: 'synthetic-startup-imported-message',
      conversationId: conversation.id,
      role: 'assistant',
      content: 'SYNTHETIC_STARTUP_HISTORY: the earlier task is unfinished.',
      createdAt: project.createdAt,
      importedFrom: { provider: 'grok', sessionId: 'synthetic-original-session', line: 7, timestampKind: 'exact' },
    };
    store.save('project', project.id, project.id, project);
    store.save('conversation', conversation.id, project.id, conversation);
    store.save('message', imported.id, conversation.id, imported);
  });
  assert.deepEqual(await workspace.flushLocalMemory(), []);
  const paths = memoryPaths(workspace, project, conversation.id);
  assert.ok(existsSync(paths.history), 'opening Workspace must export existing visible conversations');
  assert.ok(existsSync(paths.handoff));
  assert.deepEqual(readMemoryHistory(paths.history), [imported]);
  assert.ok(readFileSync(paths.handoff, 'utf8').includes(imported.content));
  assert.ok(readFileSync(paths.index, 'utf8').includes(conversation.id));
  assert.deepEqual(workspace.store.get('message', imported.id), imported);
  assert.deepEqual(workspace.store.get('conversation', conversation.id), conversation);
  assert.equal(workspace.store.workflows(conversation.id).length, 0);
  assert.equal(executions, 0);
});
test('local memory lifecycle automatically exports new conversations and completed assistant replies', async (t) => {
  const { workspace, directory } = fixture(t);
  const calls: ExecuteContext[] = [];
  const reply = 'SYNTHETIC_EXPORTED_REPLY: completed the current explanation.';
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    calls.push(ctx);
    queueMicrotask(() => workspace.controller.broadcast());
    return { output: reply };
  });
  const projectDirectory = join(directory, 'synthetic-new-project');
  mkdirSync(projectDirectory);
  const project = await workspace.createProject(projectDirectory),
    conversation = workspace.createConversation(project.id, 'Synthetic newly created conversation'),
    paths = memoryPaths(workspace, project, conversation.id);
  await workspace.flushLocalMemory(project.id);
  assert.ok(existsSync(paths.history), 'conversation creation must create its own history export');
  assert.ok(existsSync(paths.handoff));
  assert.deepEqual(readMemoryHistory(paths.history), []);
  assert.ok(readFileSync(paths.index, 'utf8').includes(conversation.id));
  assert.equal(calls.length, 0);
  const sent = await workspace.send(conversation.id, { ...base, content: 'Synthetic current explanation request' });
  const flow = await finish(workspace, sent.workflow.id);
  assert.equal(flow.status, 'completed');
  assert.equal(calls.length, 1);
  await workspace.flushLocalMemory(project.id);
  assert.deepEqual(readMemoryHistory(paths.history), workspace.store.allMessages(conversation.id));
  assert.deepEqual(
    readMemoryHistory(paths.history).map((message) => message.content),
    [sent.message.content, reply],
  );
  const handoff = readFileSync(paths.handoff, 'utf8');
  assert.ok(handoff.includes(reply));
  assert.ok(handoff.includes(flow.id));
  assert.ok(handoff.includes('completed'));
  assert.ok(flow.memoryExcerpt.includes(paths.history));
  assert.ok(flow.memoryExcerpt.includes(paths.handoff));
  assert.ok(calls[0]!.input.prompt.includes(paths.history));
  assert.ok(calls[0]!.input.prompt.includes(paths.handoff));
});
test('local memory task context uses its own conversation and excludes other conversation or project handoffs', async (t) => {
  const { workspace, controller, directory } = fixture(t);
  const calls: ExecuteContext[] = [];
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    calls.push(ctx);
    queueMicrotask(() => workspace.controller.broadcast());
    return { output: 'Synthetic own-conversation reply' };
  });
  const firstDirectory = join(directory, 'synthetic-own-project'),
    secondDirectory = join(directory, 'synthetic-other-project');
  mkdirSync(firstDirectory);
  mkdirSync(secondDirectory);
  const ownProject = await workspace.createProject(firstDirectory),
    otherProject = await workspace.createProject(secondDirectory),
    ownConversation = workspace.createConversation(ownProject.id, 'Synthetic own conversation'),
    otherConversation = workspace.createConversation(ownProject.id, 'Synthetic other conversation'),
    otherProjectConversation = workspace.createConversation(otherProject.id, 'Synthetic other-project conversation');
  const imported: ConversationMessage = {
    id: 'synthetic-own-imported-history',
    conversationId: ownConversation.id,
    role: 'user',
    content: 'SYNTHETIC_OWN_IMPORT: inspect the parser state before continuing.',
    createdAt: '2026-09-01T12:00:00.000Z',
    importedFrom: { provider: 'grok', sessionId: 'synthetic-own-source', line: 1, timestampKind: 'exact' },
  };
  workspace.store.save('message', imported.id, ownConversation.id, imported);
  workspace.store.addMessage(otherConversation.id, 'user', 'SYNTHETIC_OTHER_CONVERSATION_SECRET');
  workspace.store.addMessage(otherProjectConversation.id, 'assistant', 'SYNTHETIC_OTHER_PROJECT_SECRET');
  const unrelatedDirectory = join(controller.dataDir, 'synthetic-other-history');
  mkdirSync(unrelatedDirectory);
  const unrelatedArchive = join(unrelatedDirectory, 'history.jsonl');
  writeFileSync(unrelatedArchive, '{"synthetic":"SYNTHETIC_OTHER_NATIVE_HISTORY"}\n');
  workspace.store.save('history-archive', ownProject.id, ownProject.id, {
    path: unrelatedArchive,
    conversationId: otherConversation.id,
    continuation: {
      sessionId: 'synthetic-other-source',
      updatedAt: '2026-09-29T12:00:00.000Z',
      lastUserRequest: 'SYNTHETIC_OTHER_NATIVE_HANDOFF',
    },
  });
  const ownPaths = memoryPaths(workspace, ownProject, ownConversation.id),
    otherPaths = memoryPaths(workspace, ownProject, otherConversation.id),
    otherProjectPaths = memoryPaths(workspace, otherProject, otherProjectConversation.id);
  const sent = await workspace.send(ownConversation.id, { ...base, content: 'Explain my own pending task' });
  const flow = await finish(workspace, sent.workflow.id);
  assert.equal(flow.status, 'completed');
  await workspace.flushLocalMemory(ownProject.id);
  assert.equal(calls.length, 1);
  for (const context of [flow.memoryExcerpt, calls[0]!.input.prompt]) {
    assert.ok(context.includes(ownPaths.history));
    assert.ok(context.includes(ownPaths.handoff));
    for (const excluded of [
      otherPaths.history,
      otherPaths.handoff,
      otherProjectPaths.history,
      otherProjectPaths.handoff,
      unrelatedArchive,
      'SYNTHETIC_OTHER_CONVERSATION_SECRET',
      'SYNTHETIC_OTHER_PROJECT_SECRET',
      'SYNTHETIC_OTHER_NATIVE_HANDOFF',
    ])
      assert.ok(!context.includes(excluded), `task context must not contain unrelated context: ${excluded}`);
  }
  assert.ok(calls[0]!.input.prompt.includes(imported.content));
  assert.deepEqual(workspace.store.get('message', imported.id), imported);
  assert.deepEqual(readMemoryHistory(ownPaths.history)[0], imported);
});
test('local memory rename and deletion refresh the index while preserving conversation archives', async (t) => {
  const { workspace, directory } = fixture(t);
  let executions = 0;
  t.mock.method(codexAdapter, 'execute', async () => {
    executions++;
    return { output: 'Unexpected synthetic execution' };
  });
  const projectDirectory = join(directory, 'synthetic-index-project');
  mkdirSync(projectDirectory);
  const project = await workspace.createProject(projectDirectory),
    first = workspace.createConversation(project.id, 'Synthetic old title'),
    second = workspace.createConversation(project.id, 'Synthetic retained title'),
    paths = memoryPaths(workspace, project, first.id),
    secondPaths = memoryPaths(workspace, project, second.id);
  const imported: ConversationMessage = {
    id: 'synthetic-preserved-deleted-history',
    conversationId: first.id,
    role: 'assistant',
    content: 'SYNTHETIC_PRESERVED_HISTORY',
    createdAt: '2026-09-01T12:00:00.000Z',
    importedFrom: { provider: 'grok', sessionId: 'synthetic-preserved-source', line: 9, timestampKind: 'exact' },
  };
  workspace.store.save('message', imported.id, first.id, imported);
  workspace.renameConversation(first.id, 'Synthetic renamed title');
  assert.equal(workspace.requireConversation(first.id).titleSource, 'user');
  await workspace.flushLocalMemory(project.id);
  const renamedIndex = readFileSync(paths.index, 'utf8');
  assert.ok(renamedIndex.includes('Synthetic renamed title'));
  assert.ok(!renamedIndex.includes('Synthetic old title'));
  assert.ok(readFileSync(paths.handoff, 'utf8').includes('Synthetic renamed title'));
  assert.deepEqual(readMemoryHistory(paths.history), [imported]);
  const savedHistory = readFileSync(paths.history),
    savedHandoff = readFileSync(paths.handoff);
  workspace.deleteConversation(first.id);
  await workspace.flushLocalMemory(project.id);
  const survivingIndex = readFileSync(paths.index, 'utf8');
  assert.ok(!survivingIndex.includes(first.id));
  assert.ok(survivingIndex.includes(second.id));
  assert.ok(!readFileSync(paths.latest, 'utf8').includes(first.id));
  assert.deepEqual(readFileSync(paths.history), savedHistory);
  assert.deepEqual(readFileSync(paths.handoff), savedHandoff);
  assert.deepEqual(workspace.store.get('message', imported.id), imported);
  assert.ok(workspace.store.get<Conversation>('conversation', first.id)?.deletedAt);
  workspace.deleteConversation(second.id);
  await workspace.flushLocalMemory(project.id);
  const emptyIndex = readFileSync(paths.index, 'utf8');
  assert.ok(!emptyIndex.includes(first.id));
  assert.ok(!emptyIndex.includes(second.id));
  assert.ok(!readFileSync(paths.latest, 'utf8').includes(second.id));
  assert.ok(existsSync(secondPaths.history));
  assert.ok(existsSync(secondPaths.handoff));
  assert.deepEqual(readFileSync(paths.history), savedHistory);
  assert.equal(executions, 0);
});
test('a referenced brief counts toward routing; an unreadable one gets the strong fallback', async (t) => {
  const { workspace, directory } = fixture(t);
  const calls: ExecuteContext[] = [];
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    calls.push(ctx);
    queueMicrotask(() => workspace.controller.broadcast());
    if (!ctx.input.stepId)
      return {
        output: JSON.stringify({
          steps: [{ id: 'one', title: 'Implement', instruction: 'Implement step 1', kind: 'general' }],
        }),
      };
    writeWithReceipt(ctx, 'feature.txt', 'Implemented.');
    return { output: 'done' };
  });
  mkdirSync(join(directory, '.design'), { recursive: true });
  const files = Array.from({ length: 12 }, (_, index) => `src/module-${index}.ts`).join('\n');
  writeFileSync(join(directory, '.design', 'brief-x.md'), `# Brief\nChange these files and their tests:\n${files}\n`);
  const p = await workspace.createProject(directory);
  const send = (content: string) =>
    workspace.send(workspace.createConversation(p.id).id, {
      ...base,
      mode: 'build',
      content,
      permissionMode: 'workspace-write',
    });
  const briefed = await finish(workspace, (await send('请按 .design/brief-x.md 实现')).workflow.id);
  assert.equal(briefed.laya?.policy.needsAssessment, undefined);
  const step = calls.find((call) => call.input.stepId)!;
  assert.match(step.input.taskRoutingPrompt ?? '', /src\/module-11\.ts/);
  assert.equal(step.route.effort, 'high');
  assert.match(step.route.reasons.join('\n'), /目标高能力档/);
  const missing = await send('请按 .design/brief-missing.md 实现');
  const flow = workspace.store.get<Workflow>('workflow', missing.workflow.id)!;
  await workflowState(workspace, () => !!workspace.store.get<Workflow>('workflow', flow.id)?.laya);
  const policy = workspace.store.get<Workflow>('workflow', flow.id)!.laya!.policy;
  assert.deepEqual([policy.needsAssessment, policy.suggestedTier, policy.suggestedEffort], [true, 'strong', 'high']);
  await finish(workspace, flow.id);
});

test('short follow-ups inherit write task difficulty only with current intent and permission', async (t) => {
  const { workspace, directory } = fixture(t);
  const calls: ExecuteContext[] = [];
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    calls.push(ctx);
    queueMicrotask(() => workspace.controller.broadcast());
    if (!ctx.input.stepId)
      return {
        output: JSON.stringify({
          steps: [{ id: 'one', title: 'Implement', instruction: 'Implement the parser', kind: 'routine' }],
        }),
      };
    if (ctx.input.permissionMode === 'workspace-write') writeWithReceipt(ctx, 'feature.txt', 'Implemented.');
    return { output: 'done' };
  });
  const project = await workspace.createProject(directory);
  const conversation = workspace.createConversation(project.id);
  const send = async (content: string, options: Partial<MessageInput> = {}, conversationId = conversation.id) => {
    const start = calls.length;
    const sent = await workspace.send(conversationId, { ...base, content, queue: true, ...options });
    const flow = await finish(workspace, sent.workflow.id);
    assert.equal(flow.status, 'completed', flow.error ?? 'workflow failed');
    return { flow, calls: calls.slice(start) };
  };
  const original = 'Implement src/a.ts src/b.ts src/c.ts src/d.ts src/e.ts and their tests';
  const first = await send(original, { mode: 'build', permissionMode: 'workspace-write' });
  for (const call of first.calls) {
    assert.match(call.route.reasons.join('\n'), /目标高能力档/);
    assert.equal(call.route.effort, 'high');
  }
  for (const content of [
    '还需要补上遗漏的验证。',
    'continue the previous task',
    '被重启打断，请从头完成上一条消息里的全部任务',
  ]) {
    const next = await send(content, { permissionMode: 'workspace-write', explicitWrite: true });
    assert.match(next.flow.priorTaskRouting?.prompt ?? '', /src\/e\.ts/);
    for (const call of next.calls) {
      assert.match(call.input.taskRoutingPrompt ?? '', /src\/e\.ts/);
      assert.match(call.route.reasons.join('\n'), /目标高能力档/);
      assert.equal(call.route.effort, 'high');
      assert.equal(call.input.permissionMode, 'workspace-write');
      assert.equal(call.input.model, undefined);
      assert.equal(call.input.effort, undefined);
    }
  }
  const pinned = await send('继续上一条任务', {
    permissionMode: 'workspace-write',
    explicitWrite: true,
    model: 'mock-model',
    effort: 'low',
  });
  assert.match(pinned.flow.priorTaskRouting?.prompt ?? '', /src\/e\.ts/);
  assert.equal(pinned.calls.at(-1)!.route.effort, 'low');
  for (const content of ['谢谢', '改完了吗？']) {
    await send(original, { mode: 'build', permissionMode: 'workspace-write' });
    const next = await send(content, { permissionMode: 'workspace-write' });
    assert.equal(next.flow.priorTaskRouting, undefined, content);
    assert.notEqual(next.flow.laya?.policy.suggestedTier, 'strong', content);
    for (const call of next.calls) assert.doesNotMatch(call.route.reasons.join('\n'), /目标高能力档/, content);
  }
  await send('Explain M6');
  const chat = await send('我们继续聊 M6', { permissionMode: 'workspace-write' });
  assert.equal(chat.flow.priorTaskRouting, undefined);
  const independent = await send('Please explain the weather. '.repeat(12));
  assert.equal(independent.flow.priorTaskRouting, undefined);
  const unrelated = await send('Hello there');
  assert.equal(unrelated.flow.priorTaskRouting, undefined);
  const isolated = await send('continue the previous task', {}, workspace.createConversation(project.id).id);
  assert.equal(isolated.flow.priorTaskRouting, undefined);
});

test('follow-ups keep the unknown-size fallback when the earlier brief cannot be read', async (t) => {
  const { workspace, directory } = fixture(t);
  const calls: ExecuteContext[] = [];
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    calls.push(ctx);
    queueMicrotask(() => workspace.controller.broadcast());
    if (!ctx.input.stepId)
      return {
        output: JSON.stringify({
          steps: [{ id: 'one', title: 'Implement', instruction: 'Implement the parser', kind: 'general' }],
        }),
      };
    if (ctx.input.permissionMode === 'workspace-write') writeWithReceipt(ctx, 'feature.txt', 'Implemented.');
    return { output: 'done' };
  });
  const project = await workspace.createProject(directory);
  const conversation = workspace.createConversation(project.id);
  await finish(
    workspace,
    (
      await workspace.send(conversation.id, {
        ...base,
        content: '请按 .design/brief-missing.md 实现',
        mode: 'build',
        permissionMode: 'workspace-write',
        queue: true,
      })
    ).workflow.id,
  );
  for (const content of ['继续上一条任务', 'resume the previous task']) {
    const start = calls.length;
    const flow = await finish(
      workspace,
      (
        await workspace.send(conversation.id, {
          ...base,
          content,
          permissionMode: 'workspace-write',
          explicitWrite: true,
          queue: true,
        })
      ).workflow.id,
    );
    assert.equal(flow.priorTaskRouting?.briefUnreadable, true);
    assert.equal(flow.laya?.policy.needsAssessment, true);
    assert.deepEqual([flow.laya?.policy.suggestedTier, flow.laya?.policy.suggestedEffort], ['strong', 'high']);
    assert.equal(calls[start]!.route.effort, 'high');
    assert.match(calls[start]!.route.reasons.join('\n'), /目标高能力档/);
  }
  for (const content of ['上一条为什么失败？', '请根据 .design/brief-missing.md 解释上一条为什么失败？']) {
    const start = calls.length;
    const flow = await finish(
      workspace,
      (await workspace.send(conversation.id, { ...base, content, queue: true })).workflow.id,
    );
    assert.equal(flow.priorTaskRouting, undefined);
    assert.notEqual(flow.laya?.policy.needsAssessment, true);
    assert.notEqual(flow.laya?.policy.suggestedTier, 'strong');
    for (const call of calls.slice(start)) assert.doesNotMatch(call.route.reasons.join('\n'), /目标高能力档/);
  }
});

test('short follow-ups retain numbered and bulleted list floors without making simple tasks strong', async (t) => {
  const { workspace, directory } = fixture(t);
  const calls: ExecuteContext[] = [];
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    calls.push(ctx);
    return { output: 'done' };
  });
  const project = await workspace.createProject(directory);
  for (const [content, expected] of [
    ['- Fix spelling\n* Rename the label', 'medium'],
    ['1. Fix spelling\n2. Rename the label', 'medium'],
    ['Fix spelling', 'low'],
  ]) {
    const conversation = workspace.createConversation(project.id);
    for (const text of [content!, 'continue the previous task']) {
      await finish(
        workspace,
        (await workspace.send(conversation.id, { ...base, content: text, queue: true })).workflow.id,
      );
      assert.equal(calls.at(-1)!.route.effort, text === content ? expected : 'medium', content);
    }
  }
});

test('build uses validated real planner output, executes dependencies, and escalates only failed verification', async (t) => {
  const { workspace, controller, directory } = fixture(t);
  const calls: ExecuteContext[] = [];
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    calls.push(ctx);
    queueMicrotask(() => workspace.controller.broadcast());
    if (calls.length === 1)
      return {
        output: JSON.stringify({
          steps: [
            { id: 'one', title: 'Inspect', instruction: 'Inspect project', kind: 'routine' },
            {
              id: 'two',
              title: 'Implement',
              instruction: 'Implement requested change',
              dependsOn: ['one'],
              kind: 'general',
            },
          ],
        }),
      };
    if (ctx.input.stepId === 'two')
      writeWithReceipt(ctx, 'feature.txt', `Implemented feature, attempt ${calls.length}.`);
    return { output: `result-${calls.length}`, nativeSessionId: 'native-session' };
  });
  let verifies = 0;
  t.mock.method(controller, 'verify', async () => ({
    command: 'test',
    status: ++verifies === 1 ? 'failed' : 'passed',
    exitCode: verifies === 1 ? 1 : 0,
    output: 'test evidence',
  }));
  const p = await workspace.createProject(directory);
  await approveVerification(workspace, p.id, 'test');
  const c = workspace.createConversation(p.id);
  const result = await workspace.send(c.id, {
    ...base,
    mode: 'build',
    content: 'Implement a small feature',
    permissionMode: 'workspace-write',
    verificationCommand: 'test',
  });
  const flow = await finish(workspace, result.workflow.id);
  assert.equal(flow.status, 'completed');
  assert.equal(flow.runIds.length, 4);
  assert.equal(flow.plan[1]!.runIds.length, 2);
  assert.deepEqual(
    calls.map((call) => call.input.plannerStep),
    [false, true, true, true],
  );
  // Each planned step is routed no lower than the whole request it belongs to.
  assert.deepEqual(
    calls.map((call) => call.input.taskRoutingPrompt),
    [undefined, 'Implement a small feature', 'Implement a small feature', 'Implement a small feature'],
  );
  assert.equal(calls[1]!.input.kind, 'routine');
  assert.equal(calls[0]!.input.permissionMode, 'read-only');
  assert.equal(calls[3]!.route.effort, 'high');
  assert.equal(calls[3]!.nativeSessionId, 'native-session');
  assert.equal(calls[3]!.input.permissionMode, 'workspace-write');
  assert.ok(flow.plan.every((s) => s.status === 'completed'));
});

for (const disabled of ['reader', 'source'] as const) {
  test(`mid-flight memory toggles during delta retract secrets from steps and continuation: ${disabled}`, async (t) => {
    const secrets = ['SECRET_RETRIEVAL', 'SECRET_PLANNING', 'SECRET_STEP', 'SECRET_CONTINUATION'];
    let sources: Conversation[] = [];
    const { workspace, controller, directory } = fixture(t, 'codex', undefined, {
      retrieveMemory: (store, value) =>
        retrieveLocalMemory(store, value, {
          inline: true,
          direct: true,
          inspectPath: async () => {
            // An actual async retrieval boundary, after candidates have been selected.
            await Promise.resolve();
            store.save('conversation', sources[0]!.id, value.projectId, { ...sources[0], memory: 'off' });
            return { exists: true, kind: 'file' };
          },
        }),
    });
    const project = await workspace.createProject(directory);
    const reader = workspace.createConversation(project.id);
    sources = secrets.map((secret) => {
      const source = workspace.createConversation(project.id);
      workspace.store.addMessage(source.id, 'assistant', `Raven calibration ${secret} in D:/synthetic/${secret}.txt`);
      return source;
    });
    const absent = (text: string, count: number) => {
      for (const secret of secrets.slice(0, count)) assert.ok(!text.includes(secret), `${secret} leaked`);
    };
    let evidenceCalls = 0;
    controller.settings.memoryEvidence = 'jev';
    t.mock.method(
      controller.memoryEvidenceJudge,
      'assess',
      async (value: Parameters<typeof controller.memoryEvidenceJudge.assess>[0]) => {
        evidenceCalls++;
        absent(JSON.stringify(value), 1);
        assert.ok(JSON.stringify(value).includes(secrets[1]!));
        return assessLocalMemoryEvidence(value.query, value.excerpts);
      },
    );
    t.mock.method(
      workspace.hindsightMemory,
      'recall',
      async (...[_request, memory]: Parameters<typeof workspace.hindsightMemory.recall>) => {
        await Promise.resolve();
        workspace.store.save('conversation', sources[1]!.id, project.id, { ...sources[1], memory: 'off' });
        return memory;
      },
    );
    let deltaToggles = 0;
    const delta = HandoffTracker.prototype.delta;
    t.mock.method(
      HandoffTracker.prototype,
      'delta',
      async function (this: HandoffTracker, ...args: Parameters<typeof delta>) {
        const result = await delta.apply(this, args);
        if (args[2].length) {
          // Suspend delta after finding the native session, before execute can build either prompt.
          await Promise.resolve();
          const switched = disabled === 'reader' ? reader : sources[3]!;
          workspace.store.save('conversation', switched.id, project.id, { ...switched, memory: 'off' });
          deltaToggles++;
        }
        return result;
      },
    );
    const calls: ExecuteContext[] = [];
    t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
      calls.push(ctx);
      if (calls.length === 1) {
        absent(ctx.input.prompt, 2);
        assert.ok(ctx.input.prompt.includes(secrets[2]!));
        workspace.store.save('conversation', sources[2]!.id, project.id, { ...sources[2], memory: 'off' });
        return {
          output: JSON.stringify({
            steps: [
              { id: 'one', title: 'Inspect', instruction: 'Inspect the synthetic calibration', kind: 'general' },
              {
                id: 'two',
                title: 'Summarize',
                instruction: 'Summarize the synthetic calibration',
                kind: 'general',
                dependsOn: ['one'],
              },
            ],
          }),
        };
      }
      absent(ctx.input.prompt, calls.length === 2 ? 3 : 4);
      if (calls.length === 2) {
        assert.ok(ctx.input.prompt.includes(secrets[3]!));
      } else {
        assert.ok(ctx.input.continuationPrompt, 'the second step must build a native continuation');
        assert.equal(ctx.nativeSessionId, 'synthetic-memory-session');
        absent(ctx.input.continuationPrompt!, 4);
      }
      return { output: 'Synthetic calibration inspected.', nativeSessionId: 'synthetic-memory-session' };
    });
    const submitted = await workspace.send(reader.id, {
      ...base,
      mode: 'build',
      content: 'Inspect and summarize the Raven calibration file history.',
      autoEscalate: false,
    });
    const completed = await finish(workspace, submitted.workflow.id);
    assert.equal(completed.status, 'completed', completed.error ?? 'Synthetic workflow should complete');
    assert.equal(deltaToggles, 1);
    absent(JSON.stringify(completed.memoryRetrieval), 2);
    assert.equal(evidenceCalls, 0);
    assert.equal(calls.length, 3);
  });
}

test('workflow project lease prevents direct competing tasks and cancellation stops its current child', async (t) => {
  const { workspace, controller, directory } = fixture(t);
  let aborted = false;
  let started = false;
  t.mock.method(
    codexAdapter,
    'execute',
    async (ctx: ExecuteContext) =>
      new Promise((_, reject) => {
        ctx.signal.addEventListener(
          'abort',
          () => {
            aborted = true;
            reject(new Error('operation-cancelled'));
          },
          { once: true },
        );
        started = true;
        queueMicrotask(() => workspace.controller.broadcast());
      }),
  );
  const p = await workspace.createProject(directory);
  const c = workspace.createConversation(p.id);
  const value = await workspace.send(c.id, { ...base, mode: 'build', permissionMode: 'workspace-write' });
  await workflowState(workspace, () => started);
  await assert.rejects(
    controller.start({ prompt: 'compete', projectPath: directory, kind: 'general' }),
    /工作流|并发容量/,
  );
  workspace.cancel(value.workflow.id);
  assert.equal((await finish(workspace, value.workflow.id)).status, 'cancelled');
  assert.equal(aborted, true);
});
test('generic failures are not automatically replayed after possible side effects', async (t) => {
  const { workspace, directory } = fixture(t);
  let calls = 0;
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    calls++;
    ctx.emit({ at: new Date().toISOString(), type: 'tool', text: 'write' });
    throw new Error('network error');
  });
  const p = await workspace.createProject(directory);
  const c = workspace.createConversation(p.id);
  const value = await workspace.send(c.id, base);
  assert.equal((await finish(workspace, value.workflow.id)).status, 'blocked');
  assert.equal(calls, 1);
});
test('planner rejects cyclic/forward dependencies, duplicates and excessive task counts', () => {
  assert.throws(() =>
    parsePlan(
      JSON.stringify({
        steps: [
          { id: 'a', title: 'A', instruction: 'a', dependsOn: ['b'] },
          { id: 'b', title: 'B', instruction: 'b' },
        ],
      }),
    ),
  );
  assert.throws(() =>
    parsePlan(
      JSON.stringify({
        steps: [
          { id: 'a', title: 'A', instruction: 'a' },
          { id: 'a', title: 'B', instruction: 'b' },
        ],
      }),
    ),
  );
  assert.throws(() =>
    parsePlan(
      JSON.stringify({ steps: Array.from({ length: 7 }, (_, i) => ({ id: String(i), title: 'A', instruction: 'a' })) }),
    ),
  );
  assert.equal(parsePlan('```json\n{"steps":[{"id":"a","title":"A","instruction":"a"}]}\n```').length, 1);
  const declined = parsePlan(
    JSON.stringify({
      steps: [
        {
          id: 'step1',
          title: '说明限制',
          instruction: '告知用户：因此不执行此次操作。',
          acceptance: '清楚说明无法执行的原因，不搜索素材、不修改文件。',
        },
      ],
    }),
  );
  assert.equal(planDeclinesTask(declined), true);
  assert.equal(
    planDeclinesTask(
      parsePlan(
        JSON.stringify({
          steps: [{ id: 'edit', title: 'Inspect', instruction: 'Check README.md and correct the requested spelling' }],
        }),
      ),
    ),
    false,
  );
});

test('two project submissions racing for one slot both complete without overlapping execution', async (t) => {
  const { workspace, controller, directory } = fixture(t);
  controller.updateSettings({ maxConcurrentRuns: 1 });
  const paths = [join(directory, 'project-a'), join(directory, 'project-b')];
  paths.forEach((path) => mkdirSync(path));
  const projects = await Promise.all(paths.map((path) => workspace.createProject(path)));
  const conversations = projects.map((project) => workspace.createConversation(project.id));
  const firstStarted = fixtureSignal();
  const releaseFirst = fixtureSignal();
  let executing = 0,
    maximum = 0;
  const executionPaths: string[] = [];
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    maximum = Math.max(maximum, ++executing);
    executionPaths.push(ctx.input.projectPath);
    try {
      if (executionPaths.length === 1) {
        firstStarted.resolve();
        await releaseFirst.promise;
      }
      return { output: 'Finished this project' };
    } finally {
      executing--;
    }
  });
  // Queue admission is serialized before Controller.start; both submissions remain durable.
  const originalStart = controller.start.bind(controller);
  let starts = 0;
  t.mock.method(controller, 'start', async (...args: Parameters<Controller['start']>) => {
    starts++;
    return originalStart(...args);
  });
  const submissions = await Promise.all(conversations.map((conversation) => workspace.send(conversation.id, base)));
  await firstStarted.promise;
  await workspace.tickQueue();
  releaseFirst.resolve();
  const flows = await Promise.all(submissions.map(({ workflow }) => finish(workspace, workflow.id)));
  assert.deepEqual(
    flows.map((flow) => flow.status),
    ['completed', 'completed'],
  );
  assert.equal(maximum, 1);
  assert.equal(executionPaths.length, 2);
  assert.deepEqual(new Set(executionPaths), new Set(projects.map((project) => project.path)));
  assert.equal(starts, 2, 'capacity waiting must not create failed execution attempts');
  for (const flow of flows) {
    assert.equal(flow.runIds.length, 1);
    assert.equal(controller.store.run(flow.runIds[0]!)?.workflowId, flow.id);
  }
});

test('long worklogs and conversation history preserve the complete user project memory', async (t) => {
  const { workspace, directory } = fixture(t);
  let prompt = '';
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    prompt = ctx.input.prompt;
    return { output: 'Memory verified' };
  });
  const project = await workspace.createProject(directory),
    conversation = workspace.createConversation(project.id);
  const memory = 'IMPORTANT_MEMORY_START\n' + 'm'.repeat(19900) + '\nIMPORTANT_MEMORY_END';
  workspace.updateMemory(project.id, memory, 0);
  for (let i = 0; i < 3; i++)
    workspace.store.save('worklog', `long-log-${i}`, project.id, {
      workflowId: `long-log-${i}`,
      summary: `WORKLOG_${i}:` + 'w'.repeat(7980),
      at: new Date(2020, 0, i + 1).toISOString(),
    });
  for (let i = 0; i < 12; i++) {
    const message = workspace.store.addMessage(
      conversation.id,
      i % 2 ? 'assistant' : 'user',
      'h'.repeat(5970) + `LATEST_HISTORY_${i}`,
    );
    message.createdAt = new Date(2020, 1, i + 1).toISOString();
    workspace.store.save('message', message.id, conversation.id, message);
  }
  const submitted = await workspace.send(conversation.id, {
    ...base,
    content: 'Use the project instructions and answer my question',
  });
  const flow = await finish(workspace, submitted.workflow.id);
  assert.equal(flow.status, 'completed');
  assert.equal(flow.memoryRevision, 1);
  assert.ok(flow.memoryExcerpt.includes(memory), 'workflow snapshot must retain user-authored memory');
  assert.ok(prompt.includes(memory), 'the actual executor prompt must retain all user-authored memory');
  assert.match(prompt, /WORKLOG_\d:/);
  assert.match(prompt, /LATEST_HISTORY_11/);
  assert.ok(prompt.length < 42000, 'logs and history must remain bounded independently of memory');
});

test('a user-pinned CLI or Pi executor handles the whole task in one session without independent planning', async (t) => {
  for (const provider of ['codex', 'pi'] as const)
    await t.test(provider, async (child) => {
      const { workspace, directory } = fixture(child, provider);
      const calls: ExecuteContext[] = [];
      child.mock.method(provider === 'pi' ? piAdapter : codexAdapter, 'execute', async (ctx: ExecuteContext) => {
        calls.push(ctx);
        queueMicrotask(() => workspace.controller.broadcast());
        return { output: 'Requested change completed' };
      });
      const project = await workspace.createProject(directory),
        conversation = workspace.createConversation(project.id);
      const submitted = await workspace.send(conversation.id, {
        ...base,
        mode: 'build',
        content: 'Make a small requested change',
        runtimeId: 'mock',
        permissionMode: 'workspace-write',
      });
      const flow = await finish(workspace, submitted.workflow.id);
      assert.equal(flow.status, 'completed');
      assert.equal(calls.length, 1);
      assert.equal(flow.plan.length, 1);
      assert.equal(flow.plan[0]!.transport, 'auto');
      assert.equal(calls[0]!.input.stepId, flow.plan[0]!.id);
      assert.ok(calls.every((call) => call.route.runtimeId === 'mock' && call.target.provider === provider));
      assert.equal(calls.at(-1)!.input.executionPolicy, 'cli-first');
      assert.equal(calls.at(-1)!.input.permissionMode, 'workspace-write');
    });
});

test('shutdown aborts the active executor, preserves its evidence, and leaves queued work unstarted', async (t) => {
  const { workspace, controller, directory } = fixture(t);
  let markStarted!: () => void,
    aborted = false;
  const started = new Promise<void>((resolveStarted) => {
    markStarted = resolveStarted;
  });
  t.mock.method(
    codexAdapter,
    'execute',
    async (ctx: ExecuteContext) =>
      new Promise((_, reject) => {
        ctx.emit({ at: new Date().toISOString(), type: 'tool', text: 'existing work evidence' });
        ctx.signal.addEventListener(
          'abort',
          () => {
            aborted = true;
            reject(new Error('operation-cancelled'));
          },
          { once: true },
        );
        markStarted();
      }),
  );
  const project = await workspace.createProject(directory),
    conversation = workspace.createConversation(project.id);
  const first = await workspace.send(conversation.id, base);
  await started;
  const pending = await workspace.send(conversation.id, { ...base, content: 'A later task' });
  await workspace.close();
  const active = workspace.store.get<Workflow>('workflow', first.workflow.id)!;
  const queued = workspace.store.get<Workflow>('workflow', pending.workflow.id)!;
  assert.equal(aborted, true);
  assert.equal(active.status, 'interrupted');
  assert.equal(active.runIds.length, 1);
  assert.ok(controller.store.run(active.runIds[0]!)?.events.some((event) => event.text === 'existing work evidence'));
  assert.ok(['queued', 'waiting-resource'].includes(queued.status));
  assert.equal(queued.startedAt, undefined);
  assert.deepEqual(queued.runIds, []);
  assert.equal(controller.active.size, 0);
});

test('a direct small build saves the planner call while preserving approvals, verification, pins and memory', async (t) => {
  const { workspace, controller, directory } = fixture(t);
  controller.updateSettings({ toolApprovalMode: 'ask' });
  const calls: ExecuteContext[] = [];
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    calls.push(ctx);
    queueMicrotask(() => workspace.controller.broadcast());
    assert.equal(await ctx.approve('mock-edit', 'Apply the requested spelling correction'), true);
    writeWithReceipt(ctx, 'README.md', 'receive');
    return { output: 'Corrected the specified spelling; mock verification follows.' };
  });
  const verify = t.mock.method(controller, 'verify', async (command: string, path: string, signal: AbortSignal) => {
    assert.equal(command, 'test');
    assert.equal(path, directory);
    assert.equal(signal.aborted, false);
    return { command, status: 'passed' as const, exitCode: 0, output: 'mock verification evidence' };
  });
  const project = await workspace.createProject(directory),
    conversation = workspace.createConversation(project.id);
  await approveVerification(workspace, project.id, 'test');
  workspace.updateMemory(
    project.id,
    'Architecture and authentication are earlier project context; retain this memory.',
    0,
  );
  workspace.store.addMessage(conversation.id, 'assistant', 'Earlier discussion remains visible.');
  const content = 'Fix the typo "recieve" to "receive" in README.md.';
  const submitted = await workspace.send(conversation.id, {
    ...base,
    mode: 'build',
    content,
    permissionMode: 'workspace-write',
    runtimeId: 'mock',
    model: 'mock-model',
    effort: 'high',
    verificationCommand: 'test',
  });
  assert.equal(submitted.workflow.planning?.strategy, 'direct');
  await workflowState(
    workspace,
    () => workspace.store.get<Workflow>('workflow', submitted.workflow.id)?.status === 'waiting-approval',
  );
  assert.equal(calls.length, 1);
  assert.equal(verify.mock.callCount(), 0);
  const approval = [...controller.approvals.values()][0]!.value;
  controller.answerApproval(approval.id, true);
  const flow = await finish(workspace, submitted.workflow.id);
  assert.equal(flow.status, 'completed');
  assert.equal(flow.runIds.length, 1);
  assert.equal(flow.plan.length, 1);
  assert.equal(flow.plan[0]!.kind, 'auto');
  assert.equal(flow.plan[0]!.status, 'completed');
  assert.match(flow.planning!.reason, /本地规则.*独立规划调用/);
  const call = calls[0]!;
  assert.equal(call.input.permissionMode, 'workspace-write');
  assert.equal(call.input.routingPrompt, content);
  assert.equal(call.route.runtimeId, 'mock');
  assert.equal(call.route.model, 'mock-model');
  assert.equal(call.route.effort, 'high');
  assert.equal(call.route.kind, 'routine', 'project memory must not alter task classification');
  assert.equal(call.input.plannerStep, false);
  assert.match(call.input.prompt, /retain this memory/);
  assert.match(call.input.prompt, /Earlier discussion remains visible/);
  assert.match(call.input.prompt, /验收依据/);
  assert.ok(!call.input.prompt.includes('You plan tasks'));
  assert.equal(verify.mock.callCount(), 1);
  assert.equal(controller.store.run(flow.runIds[0]!)?.verification?.status, 'passed');
  assert.equal(flow.memoryRevision, 1);
  assert.equal(workspace.memory(project.id).recentWork.length, 1);
  assert.ok(workspace.memory(project.id).recentWork[0]!.summary.includes(content));
});

test('a file task with already correct files completes after PugPort verification without writes', async (t) => {
  const { workspace, controller, directory } = fixture(t);
  t.mock.method(controller, 'verify', async (command: string, cwd: string) => {
    assert.equal(readFileSync(join(cwd, 'README.md'), 'utf8'), 'receive');
    return { command, status: 'passed', exitCode: 0, output: '' };
  });
  writeFileSync(join(directory, 'README.md'), 'receive');
  t.mock.method(codexAdapter, 'execute', async () => ({ output: 'README.md is already correct; no change needed.' }));
  const project = await workspace.createProject(directory);
  const conversation = workspace.createConversation(project.id);
  const verificationCommand =
    process.platform === 'win32'
      ? "if ((Get-Content -Raw README.md) -ne 'receive') { exit 1 }"
      : 'test "$(cat README.md)" = receive';
  await approveVerification(workspace, project.id, verificationCommand);
  const submitted = await workspace.send(conversation.id, {
    ...base,
    mode: 'build',
    content: 'Fix the typo "recieve" to "receive" in README.md.',
    permissionMode: 'workspace-write',
    runtimeId: 'mock',
    verificationCommand,
  });
  // This test launches a real verification shell; allow for PowerShell startup on Windows.
  const flow = await finish(workspace, submitted.workflow.id);
  assert.equal(flow.status, 'completed');
  assert.equal(flow.runIds.length, 1);
  const run = controller.store.run(flow.runIds[0]!)!;
  assert.equal(run.verification?.command, verificationCommand);
  assert.equal(run.verification?.status, 'passed');
  assert.equal(run.verification?.exitCode, 0);
  assert.equal(run.taskOutcome?.status, 'completed');
  assert.equal(run.taskOutcome?.source, 'file-receipts');
  assert.equal(run.measuredFileChanges?.paths.length ?? 0, 0);
  assert.equal(
    run.events.some((event) => event.type === 'tool'),
    false,
  );
  assert.equal(readFileSync(join(directory, 'README.md'), 'utf8'), 'receive');
});

test('host EPERM checks fail while read-only composer file hints complete with a soft note', async (t) => {
  for (const readonly of [true, false]) {
    await t.test(readonly ? 'read-only hint' : 'failed host check', async (t) => {
      const { workspace, controller, directory } = fixture(t);
      t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
        if (!readonly) writeWithReceipt(ctx, 'README.md', 'receive');
        return { output: 'Synthetic answer.\nCOMBORUNNER_TASK_RESULT: {"status":"completed","summary":"Finished"}' };
      });
      t.mock.method(controller, 'verify', async () => ({
        command: 'test',
        status: 'failed' as const,
        exitCode: 1,
        output: 'EPERM symlink',
      }));
      const project = await workspace.createProject(directory);
      await approveVerification(workspace, project.id, 'test');
      const conversation = workspace.createConversation(project.id);
      const sent = await workspace.send(conversation.id, {
        ...base,
        mode: 'build',
        permissionMode: readonly ? 'read-only' : 'workspace-write',
        explicitWrite: !readonly,
        content: 'Fix the typo in README.md',
        autoEscalate: false,
        verificationCommand: readonly ? undefined : 'test',
      });
      const flow = await finish(workspace, sent.workflow.id);
      const record = controller.run(flow.runIds.at(-1)!)!;
      if (readonly) {
        assert.equal(flow.status, 'completed');
        const message = workspace.store.get<ConversationMessage>('message', flow.finalMessageId!)!;
        assert.equal(message.content, 'Synthetic answer.');
        assert.match(message.systemNotice!.text, /没有检测到文件改动/);
      } else {
        assert.notEqual(flow.status, 'completed');
        assert.equal(record.status, 'failed');
        assert.equal(record.verification?.status, 'failed');
        assert.equal(record.taskOutcome?.verificationLimited, undefined);
      }
    });
  }
});

test('file evidence discloses environment limits without overriding executor outcomes', async (t) => {
  for (const scenario of [
    'limited-completed',
    'limited',
    'limited-partial',
    'unrelated-partial',
    'write-failed',
    'write-running',
    'unknown',
    'unknown-no-changes',
    'no-changes',
    'quota',
    'quota-write',
  ] as const) {
    await t.test(scenario, async (t) => {
      const { workspace, controller, directory } = fixture(t);
      if (scenario === 'limited-partial') {
        // Synthetic host snapshot: this tests outcome/continuation, not git snapshot collection.
        const withAudit = controller.runWithAudit.bind(controller);
        t.mock.method(controller, 'runWithAudit', (id: string) => {
          const record = withAudit(id);
          return (
            record && {
              ...record,
              measuredFileChanges: { source: 'pugport-scope-snapshot' as const, paths: ['README.md'] },
            }
          );
        });
      }
      t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
        if (scenario === 'limited-partial') writeFileSync(join(directory, 'README.md'), 'receive');
        else if (!['no-changes', 'unknown-no-changes'].includes(scenario))
          writeWithReceipt(ctx, 'README.md', 'receive');
        ctx.emit({
          at: new Date().toISOString(),
          type: 'tool',
          data: {
            kind: scenario.startsWith('write-') || scenario === 'quota-write' ? 'fileChange' : 'commandExecution',
            itemId: 'check',
            status: scenario === 'write-running' ? 'inProgress' : 'failed',
            exitCode: 1,
            input: { command: 'synthetic-check' },
            output: scenario.startsWith('unknown') ? 'AssertionError: incorrect value' : 'listen EACCES',
          },
        });
        if (scenario.startsWith('quota')) throw new Error('quota-or-rate-limit');
        if (scenario === 'limited-partial') {
          ctx.emit({
            at: new Date().toISOString(),
            type: 'tool',
            data: {
              kind: 'commandExecution',
              itemId: 'junction',
              status: 'completed',
              exitCode: 1,
              input: { command: 'synthetic-junction-check' },
              output: 'EPERM: junction',
            },
          });
          return {
            output: '检查受沙箱限制。\nCOMBORUNNER_TASK_RESULT: {"status":"partial","summary":"EPERM: junction"}',
          };
        }
        if (scenario === 'unrelated-partial')
          return {
            output: 'COMBORUNNER_TASK_RESULT: {"status":"partial","summary":"B not done because the install failed"}',
          };
        return {
          output:
            'Code updated.\nCOMBORUNNER_TASK_RESULT: ' +
            JSON.stringify({
              status: scenario === 'limited-completed' ? 'completed' : 'blocked',
              summary: 'check cannot run in the sandbox',
            }),
        };
      });
      const project = await workspace.createProject(directory);
      const conversation = workspace.createConversation(project.id);
      const submitted = await workspace.send(conversation.id, {
        ...base,
        mode: 'build',
        content: 'Fix the typo "recieve" to "receive" in README.md.',
        permissionMode: 'workspace-write',
        runtimeId: 'mock',
        autoEscalate: scenario === 'limited-partial',
      });
      // An environment-only quota stop now has a safe checkpoint and may wait for resources.
      // It must not complete, while a quota stop with an uncertain write must remain blocked.
      if (scenario === 'quota')
        await workflowState(
          workspace,
          () => workspace.store.get<Workflow>('workflow', submitted.workflow.id)?.status === 'waiting-resource',
        );
      const flow =
        scenario === 'quota'
          ? workspace.store.get<Workflow>('workflow', submitted.workflow.id)!
          : await finish(workspace, submitted.workflow.id);
      const recorded = controller.run(flow.runIds.at(-1)!)!;
      if (scenario === 'limited-completed') {
        assert.equal(flow.status, 'completed', `${scenario}: ${recorded.error ?? flow.error}`);
        assert.equal(recorded.taskOutcome?.verificationLimited, true);
        assert.equal(recorded.taskOutcome?.status, 'completed');
        assert.equal(recorded.status, 'completed');
        assert.equal(recorded.taskOutcome?.limitedChecks?.length, 1);
        assert.deepEqual(recorded.handoffCheckpoint?.unconfirmedTools, []);
        assert.doesNotMatch(recorded.error ?? '', /本轮有可写工具失败|变更结果尚未核实/);
        assert.equal(recorded.taskOutcome?.source, 'file-receipts');
        assert.equal(recorded.error, undefined);
        assert.equal(flow.error, undefined);
        assert.equal(
          workspace.store.get<ConversationMessage>('message', flow.finalMessageId!)?.systemNotice,
          undefined,
        );
      } else {
        assert.notEqual(flow.status, 'completed', scenario);
        assert.equal(recorded.taskOutcome?.verificationLimited, undefined, scenario);
        if (scenario.startsWith('limited')) {
          assert.equal(recorded.taskOutcome?.source, 'executor-report');
          assert.equal(recorded.taskOutcome?.status, scenario === 'limited-partial' ? 'partial' : 'blocked');
          assert.equal(recorded.taskOutcome?.limitedChecks?.length, scenario === 'limited-partial' ? 2 : 1);
          const message = workspace.store.get<ConversationMessage>('message', flow.finalMessageId!)!;
          assert.ok(message.systemNotice);
          assert.equal(message.content, scenario === 'limited-partial' ? '检查受沙箱限制。' : 'Code updated.');
        }
        if (scenario === 'unrelated-partial') {
          assert.equal(recorded.taskOutcome?.status, 'partial');
          assert.equal(recorded.taskOutcome?.limitedChecks?.length, 1);
        }
        if (scenario === 'quota-write') assert.match(recorded.error ?? '', /变更结果尚未核实/);
        if (scenario === 'unknown-no-changes') assert.ok(recorded.handoffCheckpoint?.unconfirmedTools.length);
      }
    });
  }
});

test('an ambiguous build still uses a separate read-only JSON planner before the normal execution chain', async (t) => {
  const { workspace, directory } = fixture(t);
  workspace.controller.settings.globalInstructions = 'SYNTHETIC_PERSONAL_PREFERENCE';
  const calls: ExecuteContext[] = [];
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    calls.push(ctx);
    queueMicrotask(() => workspace.controller.broadcast());
    if (calls.length === 1)
      return {
        output: JSON.stringify({
          steps: [
            {
              id: 'edit',
              title: 'Inspect the spelling request',
              instruction: 'Check README.md and correct the requested spelling',
              kind: 'general',
            },
          ],
        }),
      };
    writeWithReceipt(ctx, 'README.md', 'receive');
    return { output: 'Requested spelling work completed.' };
  });
  const project = await workspace.createProject(directory),
    conversation = workspace.createConversation(project.id);
  const submitted = await workspace.send(conversation.id, {
    ...base,
    mode: 'build',
    content: 'Fix the typo in README.md.',
    permissionMode: 'workspace-write',
  });
  const flow = await finish(workspace, submitted.workflow.id);
  assert.equal(flow.status, 'completed');
  assert.equal(flow.planning?.strategy, 'model');
  assert.match(flow.planning!.reason, /使用模型规划/);
  assert.equal(calls.length, 2);
  assert.equal(flow.runIds.length, 2);
  assert.match(calls[0]!.input.prompt, /Return ONLY one JSON/);
  assert.equal(calls[0]!.input.permissionMode, 'read-only');
  assert.equal(calls[1]!.input.permissionMode, 'workspace-write');
  assert.equal(flow.plan[0]!.id, 'edit');
  for (const call of calls) {
    assert.match(call.input.prompt, /^个人指令/);
    assert.match(call.input.prompt, /SYNTHETIC_PERSONAL_PREFERENCE/);
    assert.match(call.input.prompt, /项目规则优先/);
  }
});

for (const provider of ['codex', 'claude', 'grok', 'pi'] as const) {
  test(`${provider} receives personal instructions before project rules, including native continuations`, async (t) => {
    const { workspace, controller, directory } = fixture(t, provider);
    controller.settings.globalInstructions = 'SYNTHETIC_PERSONAL_PREFERENCE';
    const calls: ExecuteContext[] = [];
    t.mock.method(
      { codex: codexAdapter, claude: claudeAdapter, grok: grokAdapter, pi: piAdapter }[provider],
      'execute',
      async (ctx: ExecuteContext) => {
        calls.push(ctx);
        queueMicrotask(() => controller.broadcast());
        return { output: 'Synthetic answer', nativeSessionId: 'synthetic-personal-session' };
      },
    );
    const project = await workspace.createProject(directory);
    workspace.setProjectRules(project.id, ['SYNTHETIC_PROJECT_RULE']);
    const conversation = workspace.createConversation(project.id);
    for (const content of ['Explain the project.', 'Explain it in more detail.']) {
      const sent = await workspace.send(conversation.id, { ...base, provider, runtimeId: 'mock', content });
      assert.equal((await finish(workspace, sent.workflow.id)).status, 'completed');
    }
    assert.equal(calls.length, 2);
    for (const call of calls) {
      const prompt = call.input.prompt;
      assert.match(prompt, /^个人指令/);
      assert.match(prompt, /项目规则优先/);
      assert.equal(prompt.split('SYNTHETIC_PERSONAL_PREFERENCE').length - 1, 1);
      assert.ok(prompt.indexOf('SYNTHETIC_PROJECT_RULE') > prompt.indexOf('SYNTHETIC_PERSONAL_PREFERENCE'));
      if (call.input.continuationPrompt) {
        assert.match(call.input.continuationPrompt, /^个人指令/);
        assert.ok(
          call.input.continuationPrompt.indexOf('SYNTHETIC_PROJECT_RULE') >
            call.input.continuationPrompt.indexOf('SYNTHETIC_PERSONAL_PREFERENCE'),
        );
      }
    }
    assert.equal(
      calls[0]!.input.prompt.split('SYNTHETIC_PERSONAL_PREFERENCE')[0],
      calls[1]!.input.prompt.split('SYNTHETIC_PERSONAL_PREFERENCE')[0],
    );
  });
}

test('personal instructions are omitted for untrusted conversations and after clearing the setting', async (t) => {
  const { workspace, controller, directory } = fixture(t, 'pi');
  controller.snapshots[0]!.capabilities.toolless = true;
  t.mock.method(piAdapter, 'discover', async () => structuredClone(controller.snapshots[0]!));
  const calls: ExecuteContext[] = [];
  controller.settings.globalInstructions = 'PRIVATE_PERSONAL_PREFERENCE';
  t.mock.method(piAdapter, 'execute', async (ctx: ExecuteContext) => {
    calls.push(ctx);
    queueMicrotask(() => controller.broadcast());
    return { output: 'Synthetic answer' };
  });
  const project = await workspace.createProject(directory);
  for (const untrustedContent of [true, false]) {
    if (!untrustedContent) controller.settings.globalInstructions = '';
    const conversation = workspace.createConversation(project.id);
    const sent = await workspace.send(conversation.id, { ...base, runtimeId: 'mock', untrustedContent });
    assert.equal((await finish(workspace, sent.workflow.id)).status, 'completed');
  }
  assert.equal(calls.length, 2);
  for (const call of calls) assert.doesNotMatch(call.input.prompt, /PRIVATE_PERSONAL_PREFERENCE|个人指令/);
});

test('planner decline detection requires a whole-task instruction rather than read-only constraints', () => {
  const plan = (instruction: string, title = 'Inspect', acceptance = '') =>
    parsePlan(JSON.stringify({ steps: [{ id: 'a', title, instruction, acceptance }] }));
  for (const instruction of [
    'Inspect README.md and tell the user the result; do not execute commands.',
    '读取 README.md 并告诉用户摘要，不执行删除操作。',
    'Tell the user which commands are available; do not execute this task automatically.',
    'Tell the user that I cannot execute this task. Inspect the existing report instead.',
    '告知用户：不执行本次任务；读取 README 并汇报现状。',
  ])
    assert.equal(planDeclinesTask(plan(instruction)), false, instruction);
  assert.equal(
    planDeclinesTask(plan('Read README.md and summarize it.', '告诉用户', '不执行本次任务。')),
    false,
    'titles and acceptance constraints do not turn an executable instruction into a refusal',
  );
  for (const instruction of [
    '告知用户：因此不执行此次操作。',
    '告诉用户：无法执行本次任务。',
    '告知用户不能处理该请求，因此不执行这次操作。',
    '告知用户：不能完成所请求的搜索，因此不执行此次素材库找图。',
    'Tell the user that I cannot execute this task.',
    'Inform the user that we will not perform the requested operation.',
  ])
    assert.equal(planDeclinesTask(plan(instruction)), true, instruction);
});

test('plain planner refusal detection excludes quotes, local restrictions and mixed executable replies', () => {
  for (const output of ['I cannot execute that request.', '我无法执行该任务。'])
    assert.equal(plannerOutputDeclinesTask(output), true, output);
  for (const output of [
    'I cannot execute commands, but can inspect the file.',
    '我无法执行删除操作，但可以检查文件。',
    'I cannot execute that request. Read README instead.',
    'Parsing diagnostic: I cannot execute that request.',
    '"I cannot execute that request."',
    'Example response: I cannot execute that request.',
    '{"steps":[{"instruction":"I cannot execute that request."}]}',
  ])
    assert.equal(plannerOutputDeclinesTask(output), false, output);
});

test('the decline contract is recognized only for an explicit declined:true object', () => {
  assert.deepEqual(parsePlannerDecline('{"declined":true,"reason":"privacy"}'), { reason: 'privacy' });
  assert.deepEqual(
    parsePlannerDecline('```json\n{"declined":true}\n```'),
    { reason: '规划器返回 declined，未说明原因。' },
    'a missing reason falls back to an explicit notice',
  );
  for (const output of [
    '{"steps":[{"id":"a","title":"A","instruction":"a"}]}',
    '{"declined":false,"reason":"no"}',
    '{"declined":"true"}',
    'I cannot execute that request.',
    '',
  ])
    assert.equal(parsePlannerDecline(output), undefined, output);
});

test('a plain whole-task planner refusal preserves its output without a second execution call', async (t) => {
  for (const output of ['I cannot execute that request.', '我无法执行该任务。'])
    await t.test(output, async (t) => {
      const { workspace, directory } = fixture(t);
      const calls: ExecuteContext[] = [];
      t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
        calls.push(ctx);
        queueMicrotask(() => workspace.controller.broadcast());
        return { output };
      });
      const project = await workspace.createProject(directory),
        conversation = workspace.createConversation(project.id);
      const submitted = await workspace.send(conversation.id, {
        ...base,
        mode: 'build',
        content: 'Inspect README.md and summarize it.',
      });
      const flow = await finish(workspace, submitted.workflow.id);
      assert.equal(calls.length, 1);
      assert.equal(flow.runIds.length, 1);
      assert.equal(flow.status, 'completed');
      assert.deepEqual(flow.plan, []);
      assert.equal(calls[0]!.input.permissionMode, 'read-only');
      const reply = workspace.store.messages(conversation.id).find((message) => message.role === 'assistant');
      assert.equal(reply?.content, output);
      assert.match(flow.planning!.reason, /未再发起执行调用/);
    });
});

test('a planner that only declines does not start an execution call with that decline', async (t) => {
  for (const count of [1, 2])
    await t.test(`${count} refusal step(s)`, async (t) => {
      const { workspace, directory } = fixture(t);
      const calls: ExecuteContext[] = [];
      t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
        calls.push(ctx);
        queueMicrotask(() => workspace.controller.broadcast());
        return {
          output: JSON.stringify({
            steps: Array.from({ length: count }, (_, index) => ({
              id: `step${index + 1}`,
              title: `说明限制 ${index + 1}`,
              instruction: '告知用户：因此不执行此次操作。',
              kind: 'general',
              acceptance: '清楚说明无法执行的原因，不搜索素材、不修改文件。',
            })),
          }),
        };
      });
      const project = await workspace.createProject(directory),
        conversation = workspace.createConversation(project.id);
      const submitted = await workspace.send(conversation.id, {
        ...base,
        mode: 'build',
        content: 'Fix the typo in README.md.',
        permissionMode: 'workspace-write',
      });
      const flow = await finish(workspace, submitted.workflow.id);
      assert.equal(flow.status, 'completed');
      assert.equal(calls.length, 1);
      assert.equal(flow.runIds.length, 1);
      assert.equal(calls[0]!.input.permissionMode, 'read-only');
      assert.match(calls[0]!.input.prompt, /Return ONLY one JSON/);
      assert.ok(flow.plan.every((step) => step.status === 'skipped'));
      assert.match(flow.planning!.reason, /未再发起执行调用/);
      const reply = workspace.store.messages(conversation.id).find((message) => message.role === 'assistant');
      assert.match(reply?.content ?? '', /没有再发起执行/);
      assert.match(reply?.content ?? '', /因此不执行此次操作/);
      assert.doesNotMatch(reply?.content ?? '', /已执行 \d+ 个计划步骤/);
      assert.equal(
        calls.some((call) => call.input.prompt.includes('当前步骤')),
        false,
      );
    });
});

test('an explicit planner decline contract stops with the given reason before any execution', async (t) => {
  const { workspace, directory } = fixture(t);
  const calls: ExecuteContext[] = [];
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    calls.push(ctx);
    queueMicrotask(() => workspace.controller.broadcast());
    return { output: '{"declined":true,"reason":"privacy"}' };
  });
  const project = await workspace.createProject(directory),
    conversation = workspace.createConversation(project.id);
  const submitted = await workspace.send(conversation.id, {
    ...base,
    mode: 'build',
    content: 'Fix the typo in README.md.',
    permissionMode: 'workspace-write',
  });
  const flow = await finish(workspace, submitted.workflow.id);
  assert.equal(flow.status, 'completed');
  assert.equal(calls.length, 1);
  assert.equal(flow.runIds.length, 1);
  assert.equal(calls[0]!.input.permissionMode, 'read-only');
  assert.match(calls[0]!.input.prompt, /Return ONLY one JSON/);
  assert.match(calls[0]!.input.prompt, /declined/);
  assert.deepEqual(flow.plan, []);
  assert.match(flow.planning!.reason, /未再发起执行调用/);
  const reply = workspace.store.messages(conversation.id).find((message) => message.role === 'assistant');
  assert.match(reply?.content ?? '', /拒绝原因：privacy/);
  assert.equal(
    calls.some((call) => call.input.prompt.includes('当前步骤')),
    false,
    'the decline must not leak into an execution prompt',
  );
});

test('a read-only plan with a local prohibition still executes and preserves its permission scope', async (t) => {
  for (const instruction of [
    'Inspect README.md and tell the user the result; do not execute commands.',
    '读取 README.md 并告诉用户摘要，不执行删除操作。',
  ])
    await t.test(instruction, async (t) => {
      const { workspace, directory } = fixture(t);
      const calls: ExecuteContext[] = [];
      t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
        calls.push(ctx);
        queueMicrotask(() => workspace.controller.broadcast());
        return {
          output:
            calls.length === 1
              ? JSON.stringify({ steps: [{ id: 'inspect', title: 'Inspect README', instruction }] })
              : 'Synthetic README summary.',
        };
      });
      const project = await workspace.createProject(directory),
        conversation = workspace.createConversation(project.id);
      const submitted = await workspace.send(conversation.id, {
        ...base,
        mode: 'build',
        content: 'Inspect README.md and summarize it.',
      });
      const flow = await finish(workspace, submitted.workflow.id);
      assert.equal(flow.status, 'completed');
      assert.equal(calls.length, 2);
      assert.ok(calls.every((call) => call.input.permissionMode === 'read-only'));
      assert.equal(flow.plan[0]!.status, 'completed');
      const reply = workspace.store.messages(conversation.id).find((message) => message.role === 'assistant');
      assert.equal(reply?.content, 'Synthetic README summary.');
    });
});

test('a multistep plan shows the final answer and keeps each earlier output in the process record', async (t) => {
  const { workspace, controller, directory } = fixture(t);
  const calls: ExecuteContext[] = [];
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    calls.push(ctx);
    queueMicrotask(() => workspace.controller.broadcast());
    return {
      output:
        calls.length === 1
          ? JSON.stringify({
              steps: [
                { id: 'inspect', title: 'Inspect README', instruction: 'Read README.md and summarize it.' },
                {
                  id: 'report',
                  title: 'Report findings',
                  instruction: 'Tell the user the summary.',
                  dependsOn: ['inspect'],
                },
              ],
            })
          : `Synthetic step ${calls.length - 1} result.`,
    };
  });
  const project = await workspace.createProject(directory),
    conversation = workspace.createConversation(project.id);
  const submitted = await workspace.send(conversation.id, {
    ...base,
    mode: 'build',
    content: 'Inspect README.md and summarize it.',
  });
  const flow = await finish(workspace, submitted.workflow.id);
  assert.equal(calls.length, 3);
  assert.equal(flow.status, 'completed');
  assert.ok(flow.plan.every((step) => step.status === 'completed'));
  assert.ok(calls.every((call) => call.input.permissionMode === 'read-only'));
  const reply = workspace.store.messages(conversation.id).find((message) => message.role === 'assistant');
  assert.equal(reply?.content, 'Synthetic step 2 result.');
  for (const [index, step] of flow.plan.entries())
    assert.equal(controller.run(step.runIds.at(-1)!)!.output, `Synthetic step ${index + 1} result.`);
});

test('cancelling a direct build during resource discovery preserves the pre-launch abort signal', async (t) => {
  const { workspace, controller, directory } = fixture(t);
  let release!: (value: RuntimeSnapshot) => void,
    entered = false;
  const pending = new Promise<RuntimeSnapshot>((resolve) => {
    release = resolve;
    queueMicrotask(() => workspace.controller.broadcast());
  });
  t.mock.method(codexAdapter, 'discover', async () => {
    entered = true;
    queueMicrotask(() => workspace.controller.broadcast());
    return pending;
  });
  controller.snapshots = []; // Force discovery before admission, rather than the normal post-run refresh.
  const execute = t.mock.method(codexAdapter, 'execute', async () => ({ output: 'must not run' }));
  const verify = t.mock.method(controller, 'verify', async () => ({
    command: 'test',
    status: 'passed' as const,
    exitCode: 0,
    output: 'must not verify',
  }));
  const project = await workspace.createProject(directory),
    conversation = workspace.createConversation(project.id);
  const submitted = await workspace.send(conversation.id, {
    ...base,
    mode: 'build',
    content: 'Format src/utils.ts.',
    verificationCommand: 'test',
  });
  try {
    await workflowState(workspace, () => entered);
    workspace.cancel(submitted.workflow.id);
    release(snap());
    const flow = await finish(workspace, submitted.workflow.id);
    assert.equal(flow.status, 'cancelled');
    assert.equal(flow.planning?.strategy, 'direct');
    assert.deepEqual(flow.runIds, []);
    assert.equal(execute.mock.callCount(), 0);
    assert.equal(verify.mock.callCount(), 0);
    assert.equal(controller.active.size, 0);
  } finally {
    release(snap());
  }
});

test('device and server execution return through the remote entry without local computer context', async () => {
  for (const deviceId of ['synthetic-device', 'synthetic-server']) {
    const workflow = { input: { deviceId } };
    let remoteCalls = 0;
    const target = {
      executeOnDevice: async (received: unknown) => {
        assert.equal(received, workflow);
        remoteCalls++;
        return 'synthetic remote result';
      },
    };
    const execute = Reflect.get(Workspace.prototype, 'execute');
    assert.equal(await execute.call(target, workflow, {}, new AbortController().signal), 'synthetic remote result');
    assert.equal(remoteCalls, 1);
  }
});
