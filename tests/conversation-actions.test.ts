import assert from 'node:assert/strict';
import { chineseSteeringPrompt } from './helpers/steering-expectations.ts';
import { settledWorkflow } from './helpers/workflow-state.ts';
import test, { type TestContext } from 'node:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { basename, join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Controller } from '../src/server/controller.ts';
import { Workspace } from '../src/server/workspace.ts';
import { ConversationActions } from '../src/server/conversation-actions.ts';
import { compareQueuedWorkflows } from '../src/server/task-queue.ts';
import { retrieveLocalMemory } from '../src/server/memory-retrieval.ts';
import { codexAdapter } from '../src/server/adapters/codex.ts';
import { quotedContent } from '../src/shared/quotes.ts';
import type { ConversationMessage, ExecuteContext, MessageInput, RunRecord, Workflow } from '../src/shared/types.ts';

const input: MessageInput = {
  content: 'Explain the synthetic report.',
  mode: 'chat',
  permissionMode: 'read-only',
  executionPolicy: 'cli-only',
  runtimeId: 'mock',
  model: 'mock-model',
  effort: 'low',
};
async function fixture(t: TestContext) {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'studio-conversation-actions-')));
  const oldMemoryDir = process.env.COMBORUNNER_MEMORY_DIR;
  process.env.COMBORUNNER_MEMORY_DIR = join(directory, 'private-memory');
  const controller = new Controller(directory, join(directory, 'data'), { readAccountIdentity: () => 'synthetic' });
  clearInterval(controller.timer);
  controller.targets = [
    { id: 'mock', provider: 'codex', label: 'Mock', command: 'synthetic', enabled: true, environment: 'native' },
  ];
  const observed = {
    id: 'mock',
    provider: 'codex' as const,
    label: 'Mock',
    environment: 'native' as const,
    installed: true,
    status: 'ready' as const,
    authMode: 'chatgpt' as const,
    accountFingerprint: 'synthetic',
    models: [{ id: 'mock-model', label: 'Mock', efforts: ['low'] }],
    quota: {
      status: 'known' as const,
      source: 'mock',
      observedAt: new Date().toISOString(),
      windows: [
        {
          id: 'synthetic-week',
          label: 'week',
          usedPercent: 10,
          resetsAt: new Date(Date.now() + 3600000).toISOString(),
        },
      ],
    },
    capabilities: { execute: true, resume: true, cancel: true, approvals: true, steer: true },
    refreshedAt: new Date().toISOString(),
  };
  controller.snapshots = [observed];
  t.mock.method(codexAdapter, 'discover', async () => observed);
  t.mock.method(codexAdapter, 'execute', async () => {
    throw new Error('Test must not invoke a real CLI.');
  });
  const workspace = new Workspace(controller, {
    autoTick: false,
    retrieveMemory: (store, value) => retrieveLocalMemory(store, value, { inline: true }),
  });
  const actions = new ConversationActions(workspace);
  const project = await workspace.createProject(directory, 'Synthetic');
  const conversation = workspace.createConversation(project.id);
  t.after(async () => {
    await workspace.close();
    await controller.close();
    assert.ok(directory.startsWith(realpathSync.native(tmpdir()) + sep));
    assert.ok(basename(directory).startsWith('studio-conversation-actions-'));
    rmSync(directory, { recursive: true, force: true });
    if (oldMemoryDir === undefined) delete process.env.COMBORUNNER_MEMORY_DIR;
    else process.env.COMBORUNNER_MEMORY_DIR = oldMemoryDir;
  });
  return { workspace, controller, actions, project, conversation };
}

test('swarm creation requires a project while a legacy ordinary chat can disable it', async (t) => {
  const f = await fixture(t);
  assert.equal(f.actions.setSwarm(f.conversation.id, true).swarm, true);
  f.project.scope = 'chat';
  f.workspace.store.save('project', f.project.id, f.project.id, f.project);
  assert.throws(() => f.actions.setSwarm(f.conversation.id, true), /只有项目对话/);
  assert.equal(f.actions.setSwarm(f.conversation.id, false).swarm, false);
  delete f.project.scope;
  f.workspace.store.save('project', f.project.id, f.project.id, f.project);
  assert.equal(f.actions.setSwarm(f.conversation.id, true).swarm, true);
  f.project.removedAt = new Date().toISOString();
  f.workspace.store.save('project', f.project.id, f.project.id, f.project);
  assert.throws(() => f.actions.setSwarm(f.conversation.id, true), /只有项目对话/);
});

test('a routing profile selection persists only in its chat and automatic restores the existing local rules', async (t) => {
  const { workspace, controller, actions, project, conversation } = await fixture(t);
  const other = workspace.createConversation(project.id);
  const id = randomUUID();
  controller.updateSettings({
    routingProfiles: [
      {
        id,
        name: 'Fast questions',
        rules: { version: 2, text: 'Use mock', rules: [], unparsed: [], updatedAt: new Date().toISOString() },
      },
    ],
  });
  actions.setRoutingProfile(conversation.id, id);
  assert.equal(
    workspace.store.get<{ routingProfileId?: string }>('conversation', conversation.id)?.routingProfileId,
    id,
  );
  assert.equal(
    workspace.store.get<{ routingProfileId?: string }>('conversation', other.id)?.routingProfileId,
    undefined,
  );
  assert.throws(() => actions.setRoutingProfile(other.id, randomUUID()), /不存在/);
  actions.setRoutingProfile(conversation.id, null);
  assert.equal(
    workspace.store.get<{ routingProfileId?: string }>('conversation', conversation.id)?.routingProfileId,
    null,
  );
  actions.setRoutingProfile(conversation.id, id);
  actions.setRouting(conversation.id, {
    version: 2,
    text: '',
    rules: [],
    unparsed: [],
    chapterAgents: false,
    mask: false,
  });
  assert.equal(
    workspace.store.get<{ routingProfileId?: string }>('conversation', conversation.id)?.routingProfileId,
    null,
  );
});

test('project routing defaults affect future inherited tasks only, with explicit chat automatic and profile overrides', async (t) => {
  const { workspace, controller, actions, project, conversation } = await fixture(t);
  const id = randomUUID(),
    override = randomUUID();
  const definition = (id: string, name: string) => ({
    id,
    name,
    rules: {
      version: 2 as const,
      text: name,
      rules: [],
      unparsed: [],
      updatedAt: name,
    },
  });
  controller.updateSettings({ routingProfiles: [definition(id, 'Project'), definition(override, 'Chat')] });
  const otherProject = await workspace.createProject(join(project.path, 'other'), 'Other', true);
  const otherChat = workspace.createConversation(otherProject.id);
  actions.setProjectRoutingProfile(project.id, id);
  const first = await workspace.send(conversation.id, { ...input, queue: true });
  assert.equal(first.workflow.routingContext?.profile?.id, id);
  const other = await workspace.send(otherChat.id, { ...input, queue: true });
  assert.equal(other.workflow.routingContext?.profile, undefined);
  actions.setRoutingProfile(conversation.id, null);
  const automatic = await workspace.send(conversation.id, { ...input, queue: true });
  assert.equal(automatic.workflow.routingContext?.profile, undefined);
  actions.setRoutingProfile(conversation.id, override);
  const explicit = await workspace.send(conversation.id, { ...input, queue: true });
  assert.equal(explicit.workflow.routingContext?.profile?.id, override);
  actions.inheritRoutingProfile(conversation.id);
  controller.updateSettings({ routingProfiles: [definition(id, 'Edited'), definition(override, 'Chat')] });
  const inherited = await workspace.send(conversation.id, { ...input, queue: true });
  assert.equal(inherited.workflow.routingContext?.profile?.updatedAt, 'Edited');
  assert.equal(
    workspace.store.get<Workflow>('workflow', first.workflow.id)?.routingContext?.profile?.updatedAt,
    'Project',
  );
  assert.throws(() => actions.setProjectRoutingProfile(project.id, randomUUID()), /不存在/);
  actions.setProjectRoutingProfile(project.id, null);
  const cleared = await workspace.send(conversation.id, { ...input, queue: true });
  assert.equal(cleared.workflow.routingContext?.profile, undefined);
  assert.equal(controller.active.size, 0);
});

test('queued tasks keep their captured routing profile while later messages use the edited definition', async (t) => {
  const { workspace, controller, actions, conversation } = await fixture(t);
  controller.targets.push(
    { ...controller.targets[0]!, id: 'before', label: 'before' },
    { ...controller.targets[0]!, id: 'after', label: 'after' },
  );
  const id = randomUUID();
  const definition = (runtimeId: string) => ({
    id,
    name: 'Saved route',
    rules: {
      version: 2 as const,
      text: 'Use the selected account',
      rules: [
        {
          id: 'main',
          category: 'other',
          candidates: [{ runtimeId }],
          enabled: true,
          strict: true,
          source: 'manual' as const,
        },
      ],
      unparsed: [],
      updatedAt: runtimeId,
    },
  });
  controller.updateSettings({ routingProfiles: [definition('before')] });
  actions.setRoutingProfile(conversation.id, id);
  const first = await workspace.send(conversation.id, { ...input, queue: true });
  controller.updateSettings({ routingProfiles: [definition('after')] });
  const second = await workspace.send(conversation.id, { ...input, queue: true });
  const saved = workspace.store.get<Workflow>('workflow', first.workflow.id)!;
  assert.equal(saved.routingContext?.routingRules?.rules[0]?.candidates[0]?.runtimeId, 'before');
  assert.equal(saved.routingContext?.profile?.updatedAt, 'before');
  assert.equal(second.workflow.routingContext?.routingRules?.rules[0]?.candidates[0]?.runtimeId, 'after');
  const child = await workspace.send(conversation.id, { ...input, queue: true }, undefined, {
    parentId: first.workflow.id,
    role: 'scout',
    requestId: 'snapshot-child',
  });
  assert.match(child.workflow.memoryExcerpt, /before/);
  assert.doesNotMatch(child.workflow.memoryExcerpt, /after/);
  assert.equal(controller.active.size, 0);
});

test('a queued profile B message cannot be steered into a profile A task after the chat switches back', async (t) => {
  const { workspace, controller, actions, conversation } = await fixture(t);
  const idA = randomUUID(),
    idB = randomUUID();
  const profile = (id: string) => ({
    id,
    name: id,
    rules: { version: 2 as const, text: '', rules: [], unparsed: [], updatedAt: 'revision-1' },
  });
  controller.updateSettings({ routingProfiles: [profile(idA), profile(idB)] });
  let started = false,
    steerCalls = 0;
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    started = true;
    ctx.emit({ at: new Date().toISOString(), type: 'text', text: 'Synthetic active task' });
    await new Promise<void>((resolve) => {
      ctx.signal.addEventListener('abort', () => resolve(), { once: true });
      if (ctx.signal.aborted) resolve();
    });
    return { output: 'Synthetic stopped' };
  });
  t.mock.method(controller, 'canSteer', () => true);
  t.mock.method(controller, 'steer', async () => {
    steerCalls++;
    return true;
  });
  actions.setRoutingProfile(conversation.id, idA);
  await workspace.send(conversation.id, { ...input, queue: true });
  await workspace.tickQueue();
  for (let i = 0; i < 600 && !started; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(started, true);
  actions.setRoutingProfile(conversation.id, idB);
  const queued = await workspace.send(conversation.id, { ...input, queue: true });
  actions.setRoutingProfile(conversation.id, idA);
  await assert.rejects(workspace.steerQueued(queued.workflow.id), /不同的路由方案/);
  assert.equal(steerCalls, 0);
  assert.equal(workspace.store.get<Workflow>('workflow', queued.workflow.id)?.status, 'queued');
});

test('whole-message stops narrow queued writers and cancel them for stop', async (t) => {
  for (const content of ['只读', '停止']) {
    const { workspace, conversation } = await fixture(t);
    const writer = await workspace.send(conversation.id, {
      ...input,
      mode: 'build',
      permissionMode: 'workspace-write',
      explicitWrite: true,
    });
    await workspace.send(conversation.id, {
      ...input,
      content,
      explicitWrite: true,
      permissionReauthorized: content === '停止',
      permissionMode: 'workspace-write',
    });
    const saved = workspace.store.get<Workflow>('workflow', writer.workflow.id)!;
    assert.equal(saved.input.permissionMode, 'read-only');
    assert.equal(saved.input.explicitWrite, false);
    assert.equal(saved.status, content === '停止' ? 'cancelled' : 'queued');
  }
});

test('agreement only resumes a failed task when it is the latest task', async (t) => {
  const { workspace, conversation } = await fixture(t);
  const old = await workspace.send(conversation.id, input);
  old.workflow.status = 'failed';
  workspace.store.save('workflow', old.workflow.id, conversation.id, old.workflow);
  const recent = await workspace.send(conversation.id, { ...input, content: 'Explain the next question.' });
  recent.workflow.status = 'completed';
  workspace.store.save('workflow', recent.workflow.id, conversation.id, recent.workflow);
  const reply = await workspace.send(conversation.id, {
    ...input,
    content: '我同意',
    permissionMode: 'workspace-write',
    explicitWrite: true,
  });
  assert.equal(reply.workflow.parentWorkflowId, undefined);
  assert.equal(reply.workflow.input.content, '我同意');
  reply.workflow.status = 'failed';
  workspace.store.save('workflow', reply.workflow.id, conversation.id, reply.workflow);
  const continued = await workspace.send(conversation.id, { ...input, content: '我同意' });
  assert.equal(continued.workflow.parentWorkflowId, reply.workflow.id);
});

test('editing a waiting message changes its original record without adding messages or granting write access', async (t) => {
  const { workspace, actions, conversation } = await fixture(t);
  const original = await workspace.send(conversation.id, input);
  const edited = actions.editQueued(original.workflow.id, '  Explain only the numbered reports.  ');
  assert.equal(edited.message.id, original.message.id);
  assert.equal(edited.workflow.id, original.workflow.id);
  assert.equal(edited.message.content, 'Explain only the numbered reports.');
  assert.equal(edited.workflow.input.permissionMode, 'read-only');
  assert.equal(edited.workflow.input.runtimeId, 'mock');
  assert.equal(workspace.store.allMessages(conversation.id).length, 1);
  edited.workflow.startedAt = new Date().toISOString();
  workspace.store.save('workflow', edited.workflow.id, conversation.id, edited.workflow);
  assert.throws(() => actions.editQueued(edited.workflow.id, 'Replace an executing input.'), /尚未开始/);
});

test('drag order changes actual scheduling order while keeping chat history and other conversations untouched', async (t) => {
  const { workspace, actions, project, conversation } = await fixture(t);
  const first = await workspace.send(conversation.id, input);
  const second = await workspace.send(conversation.id, {
    ...input,
    content: 'Second',
    schedule: { priority: 'normal', preferExpiringQuota: true },
  });
  const third = await workspace.send(conversation.id, { ...input, content: 'Third' });
  const other = workspace.createConversation(project.id);
  const foreign = await workspace.send(other.id, { ...input, content: 'Foreign' });
  const scheduled = await workspace.send(conversation.id, {
    ...input,
    content: 'Later',
    schedule: { notBefore: new Date(Date.now() + 3600000).toISOString() },
  });
  actions.reorder(conversation.id, [third.workflow.id, first.workflow.id, second.workflow.id]);
  assert.deepEqual(
    workspace.store
      .queuedWorkflows()
      .filter((value) => value.conversationId === conversation.id && value.id !== scheduled.workflow.id)
      .sort(compareQueuedWorkflows)
      .map((value) => value.id),
    [third.workflow.id, first.workflow.id, second.workflow.id],
  );
  assert.equal(workspace.store.get<Workflow>('workflow', foreign.workflow.id)?.queueOrder, undefined);
  assert.deepEqual(
    workspace.store.allMessages(conversation.id).map((value) => value.id),
    [first.message.id, second.message.id, third.message.id, scheduled.message.id],
  );
  assert.throws(
    () => actions.reorder(conversation.id, [third.workflow.id, first.workflow.id, foreign.workflow.id]),
    /已变化/,
  );
  assert.throws(
    () => actions.reorder(conversation.id, [third.workflow.id, first.workflow.id, first.workflow.id]),
    /已变化/,
  );
});

test('queued edits rebuild user intent and preserve quoted references and the explicit write grant with scope notes', async (t) => {
  const { workspace, actions, conversation } = await fixture(t);
  const quotes = [{ text: '不要改。只是旧报告中的说明。', note: '修复 synthetic 报告。' }];
  const sent = await workspace.send(conversation.id, {
    ...input,
    mode: 'build',
    permissionMode: 'workspace-write',
    content: '先修复这一份。',
    quotes,
  });
  const edited = actions.editQueued(sent.workflow.id, '更新第二份 synthetic 报告。');
  assert.equal(edited.workflow.input.permissionMode, 'workspace-write');
  assert.equal(edited.workflow.input.intentText, '修复 synthetic 报告。\n更新第二份 synthetic 报告。');
  assert.equal(edited.workflow.input.content, quotedContent(edited.message.content, quotes));
  const revoked = actions.editQueued(sent.workflow.id, '不要改，只查看第二份报告。');
  assert.equal(revoked.workflow.input.permissionMode, 'workspace-write');
  assert.match(revoked.workflow.input.scopeNote!, /不要改/);
  assert.equal(revoked.workflow.input.readOnlyTrigger, undefined);
  assert.match(revoked.workflow.input.intentText!, /不要改，只查看/);
  assert.equal(revoked.workflow.input.content, quotedContent(revoked.message.content, quotes));
});

test('queued scope remarks retain the writer; only an anchored whole-message stop cancels it', async (t) => {
  for (const anchored of [false, true])
    await t.test(anchored ? 'anchored supplement' : 'independent earlier task', { timeout: 60000 }, async (t) => {
      const { workspace, controller, actions, conversation } = await fixture(t);
      controller.settings.steerOnSend = anchored;
      let running!: ExecuteContext;
      let markStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
        running = ctx;
        markStarted();
        await new Promise<void>((resolve) => {
          ctx.signal.addEventListener('abort', () => resolve(), { once: true });
          if (ctx.signal.aborted) resolve();
        });
        return { output: 'Synthetic result' };
      });
      const writable = { ...input, mode: 'build' as const, permissionMode: 'workspace-write' as const };
      const earlier = anchored
        ? undefined
        : await workspace.send(conversation.id, { ...writable, content: '更新独立报告 A。' });
      const main = await workspace.send(conversation.id, { ...writable, content: '更新当前报告 B。' });
      if (earlier) actions.reorder(conversation.id, [main.workflow.id, earlier.workflow.id]);
      await workspace.tickQueue();
      await started;
      assert.ok(running);
      const editable = earlier ?? (await workspace.send(conversation.id, { ...writable, content: '接着更新报告 C。' }));
      assert.equal(!!editable.workflow.pendingSteer, anchored);
      const edited = actions.editQueued(editable.workflow.id, '不要改，只查看这份报告。');
      assert.equal(edited.workflow.input.permissionMode, 'workspace-write');
      assert.match(edited.workflow.input.scopeNote!, /不要改/);
      assert.equal(running.signal.aborted, false);
      assert.equal(
        workspace.store.get<Workflow>('workflow', main.workflow.id)!.input.permissionMode,
        'workspace-write',
      );
      actions.editQueued(editable.workflow.id, '只看不改');
      assert.equal(running.signal.aborted, anchored);
      const saved = workspace.store.get<Workflow>('workflow', main.workflow.id)!;
      assert.equal(saved.input.permissionMode, anchored ? 'read-only' : 'workspace-write');
      assert.equal(saved.input.intentText!.includes('只看不改'), anchored);
    });
});

test('a side chat snapshots the source through its anchor and creates only one isolated conversation on retry', async (t) => {
  const { workspace, actions, project, conversation } = await fixture(t);
  const old = workspace.store.addMessage(conversation.id, 'assistant', 'Earlier evidence.');
  const anchor = workspace.store.addMessage(conversation.id, 'assistant', 'Selected evidence.');
  workspace.store.addMessage(conversation.id, 'assistant', 'Later content must be excluded.');
  const other = workspace.createConversation(project.id);
  workspace.store.addMessage(other.id, 'assistant', 'Foreign private content.');
  const request = {
    requestId: randomUUID(),
    anchorMessageId: anchor.id,
    quote: 'Selected evidence.',
    selection: { runtimeId: 'mock', model: 'mock-model', effort: 'low', executionPolicy: 'cli-only' as const },
  };
  const side = actions.sideChat(conversation.id, request);
  const repeated = actions.sideChat(conversation.id, request);
  assert.equal(side.id, repeated.id);
  assert.notEqual(side.id, conversation.id);
  assert.equal(side.projectId, project.id);
  assert.equal(side.sideChat?.parentConversationId, conversation.id);
  assert.match(side.sideChat!.context, /Earlier evidence/);
  assert.match(side.sideChat!.context, /Selected evidence/);
  assert.doesNotMatch(side.sideChat!.context, /Later content|Foreign private content/);
  assert.equal(workspace.store.allMessages(side.id).length, 0);
  assert.equal(workspace.controller.store.runSummaries().length, 0);
  assert.equal(workspace.store.get<ConversationMessage>('message', old.id)?.content, 'Earlier evidence.');
  assert.throws(() => actions.sideChat(other.id, request), /复用于其他对话/);
  assert.throws(() => actions.sideChat(other.id, { ...request, requestId: randomUUID() }), /不属于这个对话/);
});

test('side chat execution inherits model and context without resuming the main native session, writing only when asked', async (t) => {
  const { workspace, controller, actions, conversation } = await fixture(t);
  const calls: ExecuteContext[] = [];
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    calls.push(ctx);
    return { output: 'Synthetic answer', nativeSessionId: 'side-native-session' };
  });
  workspace.store.addMessage(conversation.id, 'assistant', 'The main chat explains its design.');
  const side = actions.sideChat(conversation.id, {
    requestId: randomUUID(),
    selection: { runtimeId: 'mock', model: 'mock-model', effort: 'low', executionPolicy: 'cli-only' },
  });
  const sent = await workspace.send(side.id, {
    ...input,
    runtimeId: undefined,
    model: undefined,
    effort: undefined,
    mode: 'build',
    permissionMode: 'workspace-write',
    content: 'Explain the design tradeoff.',
  });
  await settledWorkflow(workspace, sent.workflow.id);
  assert.equal(workspace.store.get<Workflow>('workflow', sent.workflow.id)?.status, 'completed');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.route.runtimeId, 'mock');
  assert.equal(calls[0]?.route.model, 'mock-model');
  assert.equal(calls[0]?.route.effort, 'low');
  // The user explicitly chose 可写 for this side chat, so it may write (still under the directory lock).
  assert.equal(calls[0]?.input.permissionMode, 'workspace-write');
  assert.equal(calls[0]?.nativeSessionId, undefined);
  assert.match(calls[0]!.input.prompt, /main chat explains its design/);
  assert.equal(controller.store.runSummaries().length, 1);
});

test('a side chat starts an independent read-only CLI while the same account main writer remains active', async (t) => {
  const { workspace, controller, actions, conversation } = await fixture(t);
  t.mock.method(controller, 'machineReading', () => ({
    totalBytes: 32 * 1024 ** 3,
    availableMemoryBytes: 16 * 1024 ** 3,
    cpus: 16,
    cpuPercent: 10,
  }));
  const calls: ExecuteContext[] = [];
  let releaseMain!: () => void;
  let releaseSide!: () => void;
  const waitFor = async (predicate: () => boolean, description: string) => {
    for (let i = 0; i < 300; i++) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail(
      `${description} ${JSON.stringify(workspace.state().workflows?.map(({ id, status, error, scheduling }) => ({ id, status, error, scheduling })))}`,
    );
  };
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    calls.push(ctx);
    const main = calls.length === 1;
    const nativeSessionId = main ? 'held-synthetic-main-session' : 'independent-synthetic-side-session';
    ctx.emit({ at: new Date().toISOString(), type: 'session', data: { nativeSessionId } });
    if (main) ctx.emit({ at: new Date().toISOString(), type: 'text', text: 'Synthetic main writer remains active.' });
    await new Promise<void>((resolve) => {
      if (main) releaseMain = resolve;
      else releaseSide = resolve;
      // Fixture shutdown can always settle either held process, including after
      // an assertion failure. No native process or provider request is made.
      ctx.signal.addEventListener('abort', () => resolve(), { once: true });
      if (ctx.signal.aborted) resolve();
    });
    return { output: 'Synthetic answer', nativeSessionId };
  });
  assert.equal(controller.settings.maxConcurrentRuns, 0);
  assert.equal(controller.settings.maxRunsPerAccount, 0);
  const main = await workspace.send(conversation.id, {
    ...input,
    content: 'Create the synthetic report.',
    mode: 'build',
    permissionMode: 'workspace-write',
    autoEscalate: false,
  });
  await workspace.tickQueue();
  await waitFor(() => calls.length === 1, 'Main writer should start before opening the side chat.');
  const mainRun = [...controller.active.values()].find((entry) => entry.run.workflowId === main.workflow.id)!.run;
  assert.equal(mainRun.nativeSessionId, 'held-synthetic-main-session');
  const side = actions.sideChat(conversation.id, {
    requestId: randomUUID(),
    selection: { runtimeId: 'mock', model: 'mock-model', effort: 'low', executionPolicy: 'cli-only' },
  });
  const sent = await workspace.send(side.id, { ...input, content: 'Explain the current main task progress.' });
  await workspace.tickQueue();
  await waitFor(() => calls.length === 2, 'Side CLI should start while the main CLI is still held.');
  const sideRun = [...controller.active.values()].find((entry) => entry.run.workflowId === sent.workflow.id)!.run;
  assert.equal(controller.active.size, 2);
  assert.notEqual(side.id, conversation.id);
  assert.notEqual(sideRun.id, mainRun.id);
  assert.equal(sideRun.route.runtimeId, mainRun.route.runtimeId);
  assert.equal(sideRun.route.accountFingerprint, 'synthetic');
  assert.equal(sideRun.route.accountFingerprint, mainRun.route.accountFingerprint);
  assert.equal(sideRun.route.model, mainRun.route.model);
  assert.equal(sideRun.route.effort, mainRun.route.effort);
  assert.equal(calls[0]!.input.permissionMode, 'workspace-write');
  assert.equal(calls[1]!.input.permissionMode, 'read-only');
  assert.equal(calls[1]!.nativeSessionId, undefined);
  assert.equal(sideRun.parentRunId, undefined);
  assert.equal(sideRun.nativeSessionId, 'independent-synthetic-side-session');
  assert.match(calls[1]!.input.prompt, /Synthetic main writer remains active/);
  assert.equal(calls[0]!.signal.aborted, false);
  assert.equal(controller.run(mainRun.id)!.status, 'running');
  releaseSide();
  await waitFor(
    () => workspace.store.get<Workflow>('workflow', sent.workflow.id)?.status === 'completed',
    'Side task should finish without releasing the main writer.',
  );
  assert.equal(controller.run(mainRun.id)!.status, 'running');
  assert.equal(calls[0]!.signal.aborted, false);
  assert.equal(workspace.store.get<Workflow>('workflow', main.workflow.id)?.status, 'running');
  releaseMain();
  await waitFor(
    () => workspace.store.get<Workflow>('workflow', main.workflow.id)?.status === 'completed',
    'Main writer should finish after its own release.',
  );
  assert.equal(calls.length, 2);
});

test('side executions and native continuation receive fresh main context without sharing main records or session', async (t) => {
  const { workspace, controller, actions, conversation } = await fixture(t);
  const calls: ExecuteContext[] = [];
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    calls.push(ctx);
    return { output: 'Synthetic independent side response.', nativeSessionId: 'independent-side-session' };
  });
  workspace.store.addMessage(conversation.id, 'assistant', 'Original main discussion.');
  const side = actions.sideChat(conversation.id, {
    requestId: randomUUID(),
    selection: { runtimeId: 'mock', model: 'mock-model', effort: 'low', executionPolicy: 'cli-only' },
  });
  workspace.store.addMessage(conversation.id, 'assistant', 'New main evidence after opening the side panel.');
  const first = await workspace.send(side.id, { ...input, content: 'Explain the newest main discussion.' });
  await workspace.tickQueue();
  for (let i = 0; i < 150 && workspace.store.get<Workflow>('workflow', first.workflow.id)?.status !== 'completed'; i++)
    await new Promise((done) => setTimeout(done, 10));
  assert.equal(workspace.store.get<Workflow>('workflow', first.workflow.id)?.status, 'completed');
  assert.match(calls[0]!.input.prompt, /New main evidence after opening/);
  assert.equal(calls[0]!.nativeSessionId, undefined);
  workspace.store.addMessage(conversation.id, 'assistant', 'Main update between side questions.');
  const second = await workspace.send(side.id, { ...input, content: 'Explain the main update now.' });
  await workspace.tickQueue();
  for (let i = 0; i < 150 && workspace.store.get<Workflow>('workflow', second.workflow.id)?.status !== 'completed'; i++)
    await new Promise((done) => setTimeout(done, 10));
  assert.equal(workspace.store.get<Workflow>('workflow', second.workflow.id)?.status, 'completed');
  assert.equal(calls.length, 2);
  assert.equal(calls[1]!.nativeSessionId, 'independent-side-session');
  assert.match(calls[1]!.input.prompt, /Main update between side questions/);
  assert.equal(workspace.store.allMessages(conversation.id).length, 3);
  assert.ok(
    workspace.store.allMessages(conversation.id).every((message) => !message.content.includes('side response')),
  );
  assert.equal(workspace.store.allMessages(side.id).length, 4);
  assert.equal(workspace.store.worklog(side.projectId).length, 0);
  assert.equal(controller.store.runSummaries().length, 2);
});

test('side live and queued steering refresh main reference without changing saved message text or launching again', async (t) => {
  const { workspace, controller, actions, conversation } = await fixture(t);
  controller.settings.steerOnSend = true;
  let context!: ExecuteContext;
  const received: string[] = [];
  let launches = 0;
  t.mock.method(codexAdapter, 'execute', async (ctx: ExecuteContext) => {
    context = ctx;
    launches++;
    ctx.registerSteer?.(async (prompt) => {
      received.push(prompt);
    });
    await new Promise<void>((done) => {
      ctx.signal.addEventListener('abort', () => done(), { once: true });
      if (ctx.signal.aborted) done();
    });
    return { output: 'Synthetic side result.' };
  });
  const side = actions.sideChat(conversation.id, {
    requestId: randomUUID(),
    selection: { runtimeId: 'mock', model: 'mock-model', effort: 'low', executionPolicy: 'cli-only' },
  });
  await workspace.send(side.id, input);
  await workspace.tickQueue();
  for (let i = 0; i < 150 && !context; i++) await new Promise((done) => setTimeout(done, 10));
  assert.ok(context);
  workspace.store.addMessage(conversation.id, 'assistant', 'Fresh main evidence before side steer.');
  const steered = await workspace.send(side.id, { ...input, content: 'Use the newest main detail.' });
  assert.equal('steered' in steered && steered.steered, true);
  assert.equal(steered.message.content, 'Use the newest main detail.');
  assert.match(received[0]!, /Fresh main evidence before side steer/);
  assert.ok(received[0]!.endsWith(chineseSteeringPrompt('Use the newest main detail.')));
  context.registerSteer?.(undefined, { state: 'waiting' });
  const queued = await workspace.send(side.id, { ...input, content: 'Explain the additional main evidence.' });
  workspace.store.addMessage(conversation.id, 'assistant', 'Additional main evidence before queued delivery.');
  context.registerSteer?.(async (prompt) => {
    received.push(prompt);
  });
  const delivered = await workspace.steerQueued(queued.workflow.id);
  assert.equal(delivered.message.content, 'Explain the additional main evidence.');
  assert.match(received[1]!, /Additional main evidence before queued delivery/);
  assert.ok(received[1]!.endsWith(chineseSteeringPrompt('Explain the additional main evidence.')));
  assert.equal(launches, 1);
  assert.equal(controller.active.size, 1);
  assert.equal(workspace.store.allMessages(conversation.id).length, 2);
});

test('turning off queueing does not erase waiting messages or start model requests', async (t) => {
  const { workspace, actions, conversation } = await fixture(t);
  const sent = await workspace.send(conversation.id, input);
  const changed = actions.setQueueing(conversation.id, false);
  assert.equal(changed.queueingEnabled, false);
  assert.equal(workspace.store.get<Workflow>('workflow', sent.workflow.id)?.status, 'queued');
  assert.equal(workspace.controller.store.runSummaries().length, 0);
});

test('an unresolved side chat does not silently fall back to a paid API', async (t) => {
  const { actions, conversation } = await fixture(t);
  const auto = actions.sideChat(conversation.id, {
    requestId: randomUUID(),
    selection: { executionPolicy: 'cli-first' },
  });
  assert.equal(auto.sideChat?.selection.executionPolicy, 'cli-only');
  const api = actions.sideChat(conversation.id, {
    requestId: randomUUID(),
    selection: { executionPolicy: 'api-only' },
  });
  assert.equal(api.sideChat?.selection.executionPolicy, 'api-only');
});

test('native input lifecycle is broadcast truthfully and approval changes still block steering', async (t) => {
  const { controller, project } = await fixture(t);
  let ctx!: ExecuteContext;
  let release!: () => void;
  const phases: string[] = [];
  let readiness = 0;
  controller.on('state', (state) => {
    const run = state.runs.find((run: RunRecord) => run.workflowId === 'synthetic-workflow');
    if (run?.steeringStatus) phases.push(run.steeringStatus.state);
  });
  controller.on('steering-ready', () => readiness++);
  t.mock.method(codexAdapter, 'execute', async (value: ExecuteContext) => {
    ctx = value;
    await new Promise<void>((resolve) => {
      release = resolve;
      value.signal.addEventListener('abort', () => resolve(), { once: true });
    });
    return { output: 'Synthetic finish' };
  });
  const run = await controller.start({
    prompt: 'Synthetic input',
    projectPath: project.path,
    kind: 'general',
    runtimeId: 'mock',
    model: 'mock-model',
    effort: 'low',
    permissionMode: 'read-only',
    workflowId: 'synthetic-workflow',
    stepId: 'one',
  });
  assert.equal(run.steeringStatus?.state, 'starting');
  assert.equal(controller.canSteer(run.id), false);
  await new Promise((resolve) => setTimeout(resolve, 350));
  ctx.registerSteer?.(async () => {});
  assert.equal(controller.canSteer(run.id), true);
  assert.equal(run.steeringStatus?.state, 'ready');
  await new Promise((resolve) => setTimeout(resolve, 350));
  ctx.registerSteer?.(undefined, { state: 'waiting', reason: 'Native transition' });
  assert.equal(controller.canSteer(run.id), false);
  assert.equal(run.steeringStatus?.state, 'waiting');
  await new Promise((resolve) => setTimeout(resolve, 350));
  ctx.registerSteer?.(async () => {});
  controller.settings.toolApprovalMode = 'ask';
  assert.equal(controller.canSteer(run.id), false);
  controller.settings.toolApprovalMode = 'auto';
  assert.equal(controller.canSteer(run.id), true);
  release();
  for (let i = 0; i < 100 && run.status === 'running'; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(run.status, 'completed');
  assert.equal(run.steeringStatus?.state, 'finishing');
  assert.equal(controller.canSteer(run.id), false);
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.ok(
    phases.includes('starting') &&
      phases.includes('waiting') &&
      phases.includes('ready') &&
      phases.includes('finishing'),
  );
  assert.equal(readiness, 2);
});

test('Navigator turns a project chat into a swarm and an everyday chat into collaboration, and restores both', async (t) => {
  const f = await fixture(t);
  const id = f.conversation.id;
  const saved = () => f.workspace.store.get<import('../src/shared/types.ts').Conversation>('conversation', id)!;
  const entered = f.actions.setWorkMode(id, 'navigator');
  assert.equal(entered.swarm, true);
  assert.equal(entered.collaborationEnabled, undefined);
  f.actions.setWorkMode(id, 'navigator');
  assert.equal(saved().swarm, true, 'choosing it again changes nothing');
  f.actions.setWorkMode(id, 'mods-author');
  assert.equal(saved().swarm, undefined, 'leaving puts back what was there before');
  assert.equal(saved().navigatorRestore, undefined);
  f.actions.setSwarm(id, true);
  f.actions.setWorkMode(id, 'navigator');
  f.actions.setWorkMode(id, null);
  assert.equal(saved().swarm, true, 'a chat that was already a swarm stays one');
  // Everyday chats: collaboration with the smaller 12/3 family limits instead of a swarm.
  const chat = await f.workspace.createGeneralConversation('Everyday');
  const everyday = f.actions.setWorkMode(chat.id, 'navigator');
  assert.equal(everyday.collaborationEnabled, true);
  assert.equal(everyday.swarm, undefined);
  assert.equal(f.actions.setWorkMode(chat.id, null).collaborationEnabled, undefined);
  const hidden = await f.workspace.createGeneralConversation('Private', true);
  assert.throws(() => f.actions.setWorkMode(hidden.id, 'navigator'), /隐身对话不能使用领航模式/);
  f.actions.setNavigatorRoute(id, { runtimeId: 'mock', model: 'mock-model', effort: 'high' });
  assert.deepEqual(saved().navigatorRoute, { runtimeId: 'mock', model: 'mock-model', effort: 'high' });
  f.actions.setNavigatorRoute(id, null);
  assert.equal('navigatorRoute' in saved(), false);
});
