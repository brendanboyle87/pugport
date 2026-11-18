import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { Controller } from '../src/server/controller.ts';
import { Workspace } from '../src/server/workspace.ts';
import { AgentBridge } from '../src/server/agent-bridge.ts';
import { codexAdapter } from '../src/server/adapters/codex.ts';
import { claudeAdapter } from '../src/server/adapters/claude.ts';
import {
  routedDelegation,
  routedMessage,
  routingInstructions,
  upgradeRouting,
} from '../src/server/conversation-routing.ts';
import { candidateInputs } from '../src/server/routing-rules.ts';
import { memberAllowance } from '../src/server/member-allocation.ts';
import { managedAgentLimits } from '../src/shared/swarm.ts';
import {
  maxActiveChildAgents,
  parseLegacyRoutingText as parseRoutingText,
  routingLines,
  type RoutingCard,
} from '../src/shared/conversation-routing.ts';
import type {
  Conversation,
  LegacyConversationRouting as ConversationRouting,
  ExecuteContext,
  ExecuteResult,
  MessageInput,
  RuntimeSnapshot,
  RuntimeTarget,
  Workflow,
} from '../src/shared/types.ts';

const cards: RoutingCard[] = [
  { id: 'grok-native', label: 'Grok · 本机', provider: 'grok' },
  { id: 'grok-b', label: 'Grok B', provider: 'grok' },
  { id: 'claude-native', label: 'Claude · 本机', provider: 'claude' },
  { id: 'cursor-native', label: 'Cursor · 本机', provider: 'cursor' },
];

test('the user’s own sentence becomes split, adult, other and merge rules plus the chapter and mask options', () => {
  const parsed = parseRoutingText(
    '我想写一部长篇武侠小说，那就是把这个大纲拆解一下，可以先让grok做扫描，或者cursor的gork，然后理解并拆分，后续的话分别建立子agent，每个章节一个子agent，然后成人内容由grok处理，非成人的用适合的选择的，然后后续的内容的话由grok合并，或者是做上mask',
    cards,
  );
  assert.deepEqual(parsed.rules, [
    { topic: 'split', target: { provider: 'grok' }, strict: false },
    { topic: 'adult', target: { provider: 'grok' }, strict: true },
    { topic: 'other', target: {}, strict: false },
    { topic: 'merge', target: { provider: 'grok' }, strict: false },
  ]);
  assert.equal(parsed.chapterAgents, true);
  assert.equal(parsed.mask, true);
  assert.deepEqual(routingLines({ ...parsed, updatedAt: '' }, cards).slice(0, 4), [
    '拆分与理解 → Grok（优先）',
    '成人内容 → Grok（强制，由应用执行）',
    '其余内容 → 自动选择（优先）',
    '合并统稿 → Grok（优先）',
  ]);
  // A card's own name wins over its provider, "Grok bot" is not the card "Grok B", and Cursor running Grok is Cursor.
  assert.deepEqual(parseRoutingText('Grok bot 不用管，成人内容必须交给 Grok B，其他用 Claude', cards).rules, [
    { topic: 'adult', target: { runtimeId: 'grok-b', provider: 'grok' }, strict: true },
    { topic: 'other', target: { provider: 'claude' }, strict: false },
  ]);
  assert.deepEqual(parseRoutingText('先用 cursor 的 grok 拆分', cards).rules, [
    { topic: 'split', target: { provider: 'cursor' }, strict: false },
  ]);
  assert.deepEqual(parseRoutingText('今天天气不错', cards), {
    text: '今天天气不错',
    rules: [],
    chapterAgents: false,
    mask: false,
  });
});

const routing = (patch: Partial<ConversationRouting> = {}): ConversationRouting => ({
  text: '',
  rules: [
    { topic: 'split', target: { provider: 'claude' }, strict: false },
    { topic: 'adult', target: { runtimeId: 'grok-b', provider: 'grok' }, strict: true },
  ],
  chapterAgents: true,
  mask: false,
  updatedAt: '',
  ...patch,
});
const message = (content: string, patch: Partial<MessageInput> = {}): MessageInput => ({
  content,
  mode: 'build',
  permissionMode: 'workspace-write',
  executionPolicy: 'cli-first',
  ...patch,
});

test('messages: user pins always win; content rules stay automatic while coordinator roles are retained', () => {
  assert.deepEqual(
    [routedMessage(message('写一章情色小说', { provider: 'codex', model: 'gpt-x' }), routing(), cards)].map((input) => [
      input.runtimeId,
      input.provider,
      input.model,
    ]),
    [[undefined, 'codex', 'gpt-x']],
  );
  const relaxed = routing({ rules: [{ topic: 'adult', target: { provider: 'grok' }, strict: false }] });
  assert.equal(routedMessage(message('写一章情色小说', { provider: 'codex' }), relaxed, cards).provider, 'codex');
  assert.equal(routedMessage(message('写一章情色小说'), relaxed, cards).provider, undefined);
  assert.equal(routedMessage(message('整理第一章的结构'), routing(), cards).provider, 'claude');
  assert.equal(
    routedMessage(message('整理第一章的结构', { runtimeId: 'cursor-native' }), routing(), cards).runtimeId,
    'cursor-native',
  );
  // Content rules are resolved by route(), not converted to user pins here.
  assert.equal(routedMessage(message('写一章情色小说'), routing(), cards.slice(2)).provider, undefined);
  assert.equal(routedMessage(message('x'), undefined, cards).provider, undefined);
});

test('sub-tasks: adult material is redirected under a strict or masking rule, and minors go nowhere', () => {
  const claude = { label: 'Claude · 本机', provider: 'claude' as const, runtimeId: 'claude-native' };
  assert.deepEqual(routedDelegation(claude, '写第二章的性爱描写', routing(), cards), {
    agent: { label: 'Grok B', provider: 'grok', runtimeId: 'grok-b' },
    redirected: true,
  });
  assert.equal(routedDelegation(claude, '润色第三章的对白', routing(), cards).redirected, false);
  const preference = routing({ rules: [{ topic: 'adult', target: { provider: 'grok' }, strict: false }] });
  assert.equal(routedDelegation(claude, '写第二章的性爱描写', preference, cards).redirected, false);
  assert.equal(
    routedDelegation(claude, '写第二章的性爱描写', { ...preference, mask: true }, cards).agent.provider,
    'grok',
  );
  assert.throws(() => routedDelegation(claude, '色情 未成年', routing(), cards), /未成年/);
  assert.throws(() => routedDelegation(claude, '色情 未成年', undefined, cards), /未成年/);
});

test('the coordinator is told the rules, chapter limits, masking and who merges; a sub-agent only its part', () => {
  const coordinator = routingInstructions(routing({ mask: true, text: '原话' }), cards, false);
  assert.match(coordinator, /成人内容 → Grok B（强制，由应用执行）/);
  // The long-form process: say what changes, one writer, one editor who may approve, state after each chapter.
  assert.match(coordinator, /先说清这次要改什么或写什么[\s\S]*书目录下的「细纲\/第N章\.md」/);
  assert.match(coordinator, /书目录下「状态\/」里的文件/);
  assert.match(
    coordinator,
    /交给一个写手[\s\S]*前两章摘要[\s\S]*只改有问题的段落和前后衔接；只有整章结构失控时才整章重写/,
  );
  assert.match(coordinator, /一位编辑（只读）通读整章[\s\S]*可以直接说「这一版可以了」[\s\S]*只作提示，不作结论/);
  assert.match(coordinator, /只有涉及复杂时间线、医学或法律细节时，才另派一个只读的专项检查/);
  assert.match(coordinator, /最多两轮。两轮后还有分歧，就把分歧写清楚交给用户决定/);
  assert.match(
    coordinator,
    /章节摘要\.md[\s\S]*人物状态\.md[\s\S]*读者已知\.md[\s\S]*伏笔与时间线\.md[\s\S]*不要另建别的状态目录/,
  );
  assert.match(coordinator, /写新章节要一章接一章地写/);
  assert.match(coordinator, new RegExp(`最多 ${managedAgentLimits.active} 个写手同时写`));
  assert.match(coordinator, /不要自己决定批量重写全书/);
  assert.match(coordinator, /写作技能（如 story-deslop）只当写法参考[\s\S]*不要运行它自带的流程、状态文件或脚本/);
  // Without chapters, the same two rules in short.
  const plain = routingInstructions(routing({ chapterAgents: false }), cards, false);
  assert.match(plain, /只让它指出问题[\s\S]*不要让它给改写句子/);
  assert.match(plain, /一章交给一个负责写作的执行器：先通读整章/);
  assert.doesNotMatch(plain, /细纲/);
  assert.match(coordinator, /【场景1】/);
  assert.match(coordinator, /由你合并统稿/);
  assert.match(coordinator, /向用户汇报时用大白话/);
  assert.match(coordinator, /用户原话（参考）：原话/);
  const child = routingInstructions(routing({ mask: true }), cards, true);
  assert.match(child, /只完成交给你的这一部分/);
  assert.match(child, /让你审稿时，只指出问题[\s\S]*不要写改好的句子/);
  assert.doesNotMatch(child, /delegate/);
});

const card = (id: string, provider: RuntimeTarget['provider'], label: string): RuntimeTarget => ({
  id,
  provider,
  label,
  command: 'unused',
  environment: 'native',
  enabled: true,
});

function fixture(t: TestContext) {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'conversation-routing-test-')));
  const controller = new Controller(directory, join(directory, 'data'), { readAccountIdentity: () => 'synthetic' });
  clearInterval(controller.timer);
  controller.settings.decisionMode = 'auto';
  controller.agentBridgeUrl = 'http://127.0.0.1:0/mcp';
  controller.targets = [
    card('codex', 'codex', 'Codex B'),
    card('claude', 'claude', 'Claude · 本机'),
    card('claude-b', 'claude', 'Claude B'),
  ];
  const snapshot = (target: RuntimeTarget): RuntimeSnapshot => ({
    ...target,
    installed: true,
    status: 'ready',
    models: [{ id: 'test-model', label: 'Test model', efforts: ['low', 'medium', 'high'] }],
    quota: {
      status: 'known',
      source: 'fixture',
      observedAt: new Date().toISOString(),
      windows: [
        { id: 'week', label: 'week', usedPercent: 10, resetsAt: new Date(Date.now() + 3_600_000).toISOString() },
      ],
    },
    capabilities: { execute: true, resume: true, cancel: true, approvals: true },
    refreshedAt: new Date().toISOString(),
  });
  controller.snapshots = controller.targets.map(snapshot);
  t.mock.method(controller, 'refresh', async () => {});
  // A roomy synthetic computer: the quota shares under test decide, not this machine's free memory.
  t.mock.method(controller, 'machineReading', () => ({
    totalBytes: 64 * 1024 ** 3,
    availableMemoryBytes: 32 * 1024 ** 3,
    cpus: 32,
  }));
  const calls: ExecuteContext[] = [];
  const behavior: Record<string, (ctx: ExecuteContext) => Promise<string>> = {};
  const execute = async (ctx: ExecuteContext): Promise<ExecuteResult> => {
    calls.push(ctx);
    // The model's collection turn integrates existing work instead of replaying the original delegation script.
    if (ctx.input.prompt.includes('已收集子任务结果')) return { output: 'Collected and checked the child results.' };
    const output = behavior[ctx.target.id] ? await behavior[ctx.target.id]!(ctx) : `${ctx.target.label} answer`;
    return { output, nativeSessionId: `session-${calls.length}` };
  };
  t.mock.method(codexAdapter, 'execute', execute);
  t.mock.method(claudeAdapter, 'execute', execute);
  const workspace = new Workspace(controller, { autoTick: false });
  const bridge = new AgentBridge(workspace, controller);
  t.after(async () => {
    await workspace.close();
    await controller.close();
    const absolute = resolve(directory);
    assert.ok(
      absolute.startsWith(realpathSync.native(tmpdir()) + sep) &&
        basename(absolute).startsWith('conversation-routing-test-'),
    );
    // Windows can hold a just-closed database file for a moment; retry instead of failing the test.
    rmSync(absolute, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return { workspace, controller, calls, behavior, bridge, directory };
}

async function finish(workspace: Workspace, id: string) {
  for (let i = 0; i < 1000; i++) {
    await workspace.tickQueue();
    const workflow = workspace.store.get<Workflow>('workflow', id)!;
    if (['completed', 'blocked', 'cancelled', 'failed'].includes(workflow.status)) return workflow;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error('fixture workflow did not finish');
}
const call = (name: string, args: Record<string, unknown>, id = 1) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name, arguments: args },
});

test('executor checklist: the real planner and executor both avoid global unchecked Claude', async (t) => {
  const f = fixture(t);
  f.controller.settings.excludedExecutors = ['claude', 'claude-b'];
  const project = await f.workspace.createProject(f.directory);
  const conversation = f.workspace.createConversation(project.id);
  f.behavior.codex = async (context) =>
    context.input.prompt.includes('You plan tasks for a local agent workbench')
      ? JSON.stringify({
          steps: [{ id: 'one', title: 'Implement', instruction: 'Implement the requested schema', kind: 'design' }],
        })
      : 'Completed the requested schema.';
  const { workflow } = await f.workspace.send(conversation.id, {
    content: 'Implement a database schema and an API',
    mode: 'build',
    permissionMode: 'workspace-write',
    executionPolicy: 'cli-only',
  });
  const done = await finish(f.workspace, workflow.id);
  // A legacy planner without a write declaration gets a soft note, not a failed verdict.
  assert.equal(done.status, 'completed');
  assert.equal(done.error, undefined);
  assert.equal(done.planning?.strategy, 'model');
  assert.ok(f.calls.length >= 2);
  assert.ok(f.calls.some((context) => context.input.prompt.includes('You plan tasks for a local agent workbench')));
  assert.ok(f.calls.every((context) => context.target.id === 'codex'));
  assert.ok(f.calls.every((context) => context.route.reasons.some((reason) => reason.startsWith('已按勾选排除：'))));
});

test('stopped executor reports save their full answer alongside the notice', async (t) => {
  const f = fixture(t);
  f.controller.settings.excludedExecutors = ['claude', 'claude-b'];
  const project = await f.workspace.createProject(f.directory);
  const conversation = f.workspace.createConversation(project.id);
  const answer = 'Synthetic B200 answer. '.repeat(130);
  for (const status of ['partial', 'blocked']) {
    f.behavior.codex = async (context) =>
      context.input.prompt.includes('You plan tasks for a local agent workbench')
        ? JSON.stringify({ steps: [{ id: 'one', title: 'Answer', instruction: 'Give the answer', kind: 'general' }] })
        : `${answer}\nCOMBORUNNER_TASK_RESULT: ${JSON.stringify({ status, summary: 'Some prices could not be verified.' })}`;
    const { workflow } = await f.workspace.send(conversation.id, {
      content: 'Give the synthetic B200 price report',
      mode: 'build',
      permissionMode: 'read-only',
      executionPolicy: 'cli-only',
    });
    const done = await finish(f.workspace, workflow.id);
    assert.equal(done.status, 'blocked');
    const saved = f.workspace.store.get<import('../src/shared/types.ts').ConversationMessage>(
      'message',
      done.finalMessageId!,
    )!;
    assert.equal(saved.content, answer.trimEnd());
    assert.ok(saved.systemNotice?.text);
    assert.equal(saved.systemNotice?.stop?.reason, 'Some prices could not be verified.');
  }
});

test('executor checklist: swarm coordinator, members and cross-review stay in the automatic pool', async (t) => {
  const f = fixture(t);
  f.controller.settings.excludedExecutors = ['claude', 'claude-b'];
  f.controller.settings.maxConcurrentRuns = 0;
  const project = await f.workspace.createProject(f.directory);
  const conversation = f.workspace.createConversation(project.id);
  const children: Workflow[] = [];
  f.behavior.codex = async (context) => {
    if (context.input.agentChild) return 'Independent review completed.';
    const parent = context.input.workflowId!;
    children.push(
      (await f.workspace.delegateToAgent(parent, { label: 'Automatic member' }, 'Explain the parser')).workflow,
    );
    children.push(
      (await f.workspace.delegate(parent, 'reviewer', 'Review the parser independently', 'review')).workflow,
    );
    children.push(
      (
        await f.workspace.delegateToAgent(
          parent,
          { label: 'Claude', runtimeId: 'claude', provider: 'claude' },
          'Explain the parser',
        )
      ).workflow,
    );
    await Promise.all(children.map((child) => finish(f.workspace, child.id)));
    return 'The coordinated task is complete.';
  };
  const { workflow } = await f.workspace.send(conversation.id, {
    content: 'Explain a parser with a member and a reviewer',
    mode: 'chat',
    permissionMode: 'read-only',
    executionPolicy: 'cli-only',
    swarm: true,
  });
  const done = await finish(f.workspace, workflow.id);
  assert.equal(done.status, 'completed');
  assert.equal(children.length, 3);
  assert.ok(f.calls.length >= 3);
  assert.ok(f.calls.every((context) => context.target.id === 'codex'));
  const reviewer = f.workspace.store.get<Workflow>('workflow', children[1]!.id)!;
  assert.equal(reviewer.status, 'completed');
  assert.equal(reviewer.delegation?.crossCheck?.sameProvider, true);
  const blocked = f.workspace.store.get<Workflow>('workflow', children[2]!.id)!;
  assert.equal(blocked.status, 'blocked');
  assert.match(blocked.error!, /已按勾选排除/);
});

test('executor checklist: a swarm member explicitly called with @@ can use unchecked Claude', async (t) => {
  const f = fixture(t);
  f.controller.settings.excludedExecutors = ['claude', 'claude-b'];
  f.controller.settings.maxConcurrentRuns = 0;
  const project = await f.workspace.createProject(f.directory);
  const conversation = f.workspace.createConversation(project.id);
  f.behavior.codex = async (context) => {
    const child = await f.workspace.delegateToAgent(
      context.input.workflowId!,
      { label: 'Claude · 本机', runtimeId: 'claude', provider: 'claude' },
      'Explain the parser',
    );
    assert.equal((await finish(f.workspace, child.workflow.id)).status, 'completed');
    return 'Both called participants have answered.';
  };
  const { workflow } = await f.workspace.send(conversation.id, {
    content: '@@Codex B @@Claude · 本机 Explain the parser',
    mode: 'chat',
    permissionMode: 'read-only',
    executionPolicy: 'cli-only',
    swarm: true,
    participants: [
      { kind: 'executor', id: 'codex', name: 'Codex B', agent: 'Codex B' },
      { kind: 'executor', id: 'claude', name: 'Claude · 本机', agent: 'Claude · 本机' },
    ],
  });
  assert.equal((await finish(f.workspace, workflow.id)).status, 'completed');
  assert.ok(f.calls.some((context) => context.target.id === 'claude' && context.input.agentChild));
});
const text = (reply: { body?: unknown }) => {
  const body = reply.body as { result?: { content: { text: string }[] }; error?: { message: string } };
  return body.result?.content[0]?.text ?? body.error?.message ?? '';
};

async function waitForSignal(signal: Promise<void>, label: string) {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      signal,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`fixture timed out waiting for ${label}`)), 10_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test('a routed conversation: the coordinator gets the rules, adult sub-tasks are redirected, chapters respect account and ordinary family caps', async (t) => {
  const f = fixture(t);
  // Claude B has 90% left, resetting within the hour: by quota it takes this many chapters at once.
  const share = memberAllowance({
    headroom: 90,
    resetAt: Date.now() + 3_600_000,
    reservePercent: 10,
    now: Date.now(),
  }).members;
  assert.ok(share > 1 && share < maxActiveChildAgents);
  const effectiveShare = Math.min(share, managedAgentLimits.active);
  const project = await f.workspace.createProject(f.directory);
  const conversation = f.workspace.createConversation(project.id) as Conversation;
  conversation.routing = {
    text: '先让 Claude 拆分，成人内容必须交给 Codex B',
    rules: [
      { topic: 'split', target: { runtimeId: 'claude', provider: 'claude' }, strict: false },
      {
        topic: 'adult',
        target: { runtimeId: 'codex', provider: 'codex' },
        strict: true,
        model: 'test-model',
        effort: 'high',
      },
    ],
    chapterAgents: true,
    mask: false,
    updatedAt: new Date().toISOString(),
  };
  f.workspace.store.save('conversation', conversation.id, project.id, conversation);

  const replies: string[] = [];
  let running = 0,
    peak = 0,
    finished = 0,
    queuedReason = '';
  let release!: () => void;
  const released = new Promise<void>((done) => (release = done));
  let markCapacityReached!: () => void, markChaptersFinished!: () => void;
  const capacityReached = new Promise<void>((done) => (markCapacityReached = done));
  const chaptersFinished = new Promise<void>((done) => (markChaptersFinished = done));
  const chapters = Array.from({ length: share + 2 }, (_, index) => `改写第 ${index + 3} 章的对白`);
  // The caller names Claude B, so every chapter waits for a place on that account.
  const chapter = async () => {
    running++;
    peak = Math.max(peak, running);
    if (running === effectiveShare) markCapacityReached();
    await released;
    running--;
    if (++finished === chapters.length) markChaptersFinished();
    return 'chapter done';
  };
  f.behavior['claude-b'] = chapter;
  f.behavior.claude = async (ctx) => {
    if (ctx.input.agentChild) return chapter();
    assert.match(ctx.input.prompt, /本对话的路由规则（用户已确认）/);
    assert.match(ctx.input.prompt, /交给一个写手/);
    const auth = `Bearer ${ctx.agentBridge!.token}`;
    replies.push(
      text(await f.bridge.handle(auth, call('delegate', { agent: 'Claude B', task: '写第二章的性爱描写' }))),
    );
    replies.push(text(await f.bridge.handle(auth, call('delegate', { agent: 'Claude B', task: '色情 未成年' }))));
    const ids: string[] = [];
    for (const task of chapters)
      ids.push(
        text(
          await f.bridge.handle(auth, call('delegate', { agent: 'Claude B', task, tier: 'standard', wait_seconds: 0 })),
        ),
      );
    try {
      // Wait for actual executor entries instead of assuming they all start within 400 ms on a busy CI host.
      await waitForSignal(capacityReached, 'a full share of chapter executors');
      // The next chapter is turned away when it asks the router for Claude B, a moment after the queue picks it up.
      for (let i = 0; i < 200 && !queuedReason; i++) {
        await f.workspace.tickQueue();
        queuedReason =
          f.workspace.store
            .list<Workflow>('workflow', conversation.id, 1000)
            .find((workflow) => workflow.status === 'waiting-resource' && workflow.delegation)?.scheduling?.reason ??
          '';
        if (!queuedReason) await new Promise((wait) => setTimeout(wait, 10));
      }
    } finally {
      // A failing assertion/deadline must also let held mocks drain during fixture cleanup.
      release();
    }
    // Keep the caller alive until the last queued chapters have run too, not just the initial four.
    await waitForSignal(chaptersFinished, 'all six chapters');
    return `coordinator merged ${ids.length}`;
  };
  const parent = await f.workspace.send(conversation.id, {
    content: '把这部小说按章节整理一遍',
    mode: 'build',
    permissionMode: 'workspace-write',
    executionPolicy: 'cli-first',
    autoEscalate: false,
  });
  // Ticking runs the queue: the parent and its children share one loop here.
  const ticking = (async () => {
    for (let i = 0; i < 1000; i++) {
      await f.workspace.tickQueue();
      const status = f.workspace.store.get<Workflow>('workflow', parent.workflow.id)!.status;
      if (['completed', 'blocked', 'cancelled', 'failed'].includes(status)) return;
      await new Promise((wait) => setTimeout(wait, 5));
    }
  })();
  await ticking;
  assert.equal((await finish(f.workspace, parent.workflow.id)).status, 'completed');
  // The automatic message went to the coordinator named by the split rule.
  assert.equal(f.calls[0]!.target.id, 'claude');
  assert.match(replies[0]!, /已按本对话的路由规则改交给“Codex B”（原定“Claude B”）/);
  const adultChild = f.calls.find((ctx) => ctx.target.id === 'codex' && /性爱描写/.test(ctx.input.prompt));
  // The adult rule's model and effort go with the redirected sub-task.
  assert.equal(adultChild?.route.model, 'test-model');
  assert.equal(adultChild?.route.effort, 'high');
  assert.match(replies[1]!, /涉及未成年人的性内容不能交给任何执行器/);
  // The stricter ordinary-family limit wins over a well-funded account's larger allowance.
  assert.equal(peak, effectiveShare);
  assert.equal(finished, chapters.length);
  assert.match(queuedReason, new RegExp(`同一任务已有 ${managedAgentLimits.active} 个子任务正在执行`));
});

const efforts = ['low', 'medium', 'high', 'xhigh', 'max'];
test('v2 delegation classifies all categories, preserves a named candidate and respects a user pin', () => {
  const rule = {
    id: 'code',
    category: 'code',
    candidates: [{ provider: 'grok' as const }, { provider: 'claude' as const, model: 'opus', effort: 'high' }],
    strict: true,
    enabled: true,
    source: 'manual' as const,
  };
  const rules = {
    version: 2 as const,
    text: '',
    rules: [rule],
    unparsed: [],
    updatedAt: '',
    chapterAgents: false,
    mask: false,
  };
  const cursor = { label: 'Cursor', provider: 'cursor' as const };
  assert.equal(routedDelegation(cursor, 'refactor code', rules, cards).agent.provider, 'grok');
  const claude = { label: 'Claude', provider: 'claude' as const };
  assert.deepEqual(routedDelegation(claude, 'refactor code', rules, cards), {
    agent: claude,
    redirected: false,
    model: 'opus',
    effort: 'high',
  });
  assert.equal(routedDelegation(cursor, 'refactor code', rules, cards, { pinned: true }).agent, cursor);
  rule.strict = false;
  assert.equal(routedDelegation(cursor, 'refactor code', rules, cards).agent, cursor);
});

test('children inherit the parent rule snapshot, classify their own text, and reviewers inherit its category', async (t) => {
  const f = fixture(t);
  const project = await f.workspace.createProject(f.directory);
  const conversation = f.workspace.createConversation(project.id);
  f.controller.settings.routingRules = {
    version: 2,
    text: '',
    unparsed: [],
    updatedAt: '',
    rules: [
      {
        id: 'code',
        category: 'code',
        candidates: [{ provider: 'codex' }, { provider: 'claude' }],
        strict: true,
        enabled: true,
        source: 'manual',
      },
      {
        id: 'translation',
        category: 'translation',
        candidates: [{ provider: 'claude', model: 'test-model', effort: 'high' }],
        strict: true,
        enabled: true,
        source: 'manual',
      },
    ],
  };
  let childId = '';
  f.behavior.codex = async (ctx) => {
    if (ctx.input.agentChild) return 'child done';
    // Live global edits must not change rules inside a task already in progress.
    f.controller.settings.routingRules = { ...f.controller.settings.routingRules!, rules: [] };
    const child = await f.workspace.delegateToAgent(
      ctx.input.workflowId!,
      { label: 'Codex B', provider: 'codex', runtimeId: 'codex' },
      'Translate this sentence.',
    );
    childId = child.workflow.id;
    await finish(f.workspace, childId);
    return 'parent done';
  };
  const parent = await f.workspace.send(conversation.id, {
    ...message('refactor code'),
    mode: 'chat',
    autoEscalate: false,
  });
  assert.equal((await finish(f.workspace, parent.workflow.id)).status, 'completed');
  const child = f.calls.find((ctx) => ctx.input.workflowId === childId)!;
  assert.equal(child.target.provider, 'claude');
  assert.equal(child.input.category?.id, 'translation');
  assert.equal(child.route.routeRule?.id, 'translation');
  assert.equal(child.route.effort, 'high');
  const review = await f.workspace.delegate(parent.workflow.id, 'reviewer', 'Check the result.', 'rule-review');
  assert.equal((await finish(f.workspace, review.workflow.id)).status, 'completed');
  const reviewer = f.calls.find((ctx) => ctx.input.workflowId === review.workflow.id)!;
  assert.equal(reviewer.input.category?.id, 'code');
  assert.equal(reviewer.route.routeRule?.id, 'code');
  assert.equal(reviewer.target.provider, 'claude', 'cross-review stays inside the strict candidates');
  assert.equal(review.workflow.delegation?.crossCheck?.sameProvider, undefined);
});

test('a strict single-provider reviewer stays inside the rule and notes the same provider', async (t) => {
  const f = fixture(t);
  const project = await f.workspace.createProject(f.directory);
  const conversation = f.workspace.createConversation(project.id);
  f.controller.settings.routingRules = {
    version: 2,
    text: '',
    unparsed: [],
    updatedAt: '',
    rules: [
      {
        id: 'code',
        category: 'code',
        candidates: [{ provider: 'codex' }],
        strict: true,
        enabled: true,
        source: 'manual',
      },
    ],
  };
  const parent = await f.workspace.send(conversation.id, {
    ...message('refactor code'),
    mode: 'chat',
    autoEscalate: false,
  });
  await finish(f.workspace, parent.workflow.id);
  const review = await f.workspace.delegate(parent.workflow.id, 'reviewer', 'Check the result.', 'single-review');
  assert.equal(review.workflow.delegation?.crossCheck?.sameProvider, true);
  await finish(f.workspace, review.workflow.id);
  const reviewer = f.calls.find((ctx) => ctx.input.workflowId === review.workflow.id)!;
  assert.equal(reviewer.target.provider, 'codex');
  assert.equal(reviewer.route.routeRule?.id, 'code');
  assert.match(reviewer.input.prompt, /本次审查仍由/);
});

test('a conversation content rule reaches route() locally despite obsolete Jev settings', async (t) => {
  const f = fixture(t);
  const project = await f.workspace.createProject(f.directory);
  const conversation = f.workspace.createConversation(project.id) as Conversation;
  conversation.routing = upgradeRouting({
    text: '其他用 Claude',
    rules: [{ topic: 'other', target: { provider: 'claude' }, strict: false }],
    chapterAgents: false,
    mask: false,
    updatedAt: '',
  });
  f.workspace.store.save('conversation', conversation.id, project.id, conversation);
  f.controller.settings.taskJudgment = 'jev';
  let judgments = 0;
  t.mock.method(f.controller.taskJudge, 'judge', async (text: string) => {
    judgments++;
    const { localTaskJudgment } = await import('../src/server/task-judgment.ts');
    return {
      ...localTaskJudgment(text, 'disabled'),
      status: 'accepted' as const,
      source: 'jev' as const,
      reason: 'accepted' as const,
      intent: 'question' as const,
      kind: 'general' as const,
      complexity: 'standard' as const,
    };
  });
  const sent = await f.workspace.send(conversation.id, { ...message('Tell me a short fact'), mode: 'chat' });
  assert.equal(sent.workflow.input.provider, undefined);
  const completed = await finish(f.workspace, sent.workflow.id);
  assert.equal(completed.status, 'completed');
  assert.equal(judgments, 0);
  const call = f.calls.find((ctx) => ctx.input.workflowId === sent.workflow.id)!;
  assert.equal(call.target.provider, 'claude');
  assert.equal(call.input.taskJudgment?.source, 'local');
  assert.equal(call.route.routeRule?.derived, true);
  assert.match(call.route.reasons[0]!, /规则/);
  assert.doesNotMatch(call.route.reasons.join('\n'), /Jev/);
  assert.doesNotMatch(call.route.reasons.join('\n'), /用户锁定|跳过 Jev/);
});
const modelCards: RoutingCard[] = [
  {
    id: 'grok-native',
    label: 'Grok · 本机',
    provider: 'grok',
    models: [{ id: 'grok-4.7', label: 'grok-4.7', efforts: ['low', 'medium', 'high', 'xhigh'] }],
  },
  {
    id: 'claude-native',
    label: 'Claude · 本机',
    provider: 'claude',
    models: [
      { id: 'default', label: 'Default (recommended)', efforts },
      { id: 'opus', label: 'Opus 5.5', efforts },
      { id: 'claude-opus-5', label: 'Opus 5', efforts },
      { id: 'haiku', label: 'Haiku 4.5', efforts: [] },
    ],
  },
];

test('rules can name a model and effort: "Opus 5" is not "Opus 5.5", aliases need their label, effort can follow', () => {
  const rules = (text: string) => parseRoutingText(text, modelCards).rules;
  assert.deepEqual(rules('Grok 4.7 高强度拆分；其余内容交给 Claude Opus 5 high'), [
    { topic: 'split', target: { provider: 'grok' }, strict: false, model: 'grok-4.7', effort: 'high' },
    { topic: 'other', target: { provider: 'claude' }, strict: false, model: 'claude-opus-5', effort: 'high' },
  ]);
  assert.equal(rules('其余用 claude opus 5.5 最高强度')[0]!.model, 'opus');
  assert.equal(rules('其余用 claude opus 5.5 最高强度')[0]!.effort, 'max');
  assert.equal(rules('其余交给 claude-opus-5 xhigh')[0]!.effort, 'xhigh');
  assert.equal(rules('其余用 Claude Opus 5，高强度')[0]!.effort, 'high');
  // The bare alias "opus" names no model; a model without efforts takes none.
  assert.equal(rules('其余交给 Claude opus')[0]!.model, undefined);
  assert.equal(rules('其余交给 Claude Haiku 4.5 high')[0]!.effort, undefined);
  const parsed = parseRoutingText('其余内容交给 Claude Opus 5 high', modelCards);
  assert.deepEqual(routingLines({ ...parsed, updatedAt: '' }, modelCards), [
    '其余内容 → Claude（Opus 5 · high）（优先）',
  ]);
});

test('a rule’s model and effort apply to the messages and sub-tasks it routes, unless the user picked their own', () => {
  const routing: ConversationRouting = {
    text: '',
    rules: [
      { topic: 'split', target: { provider: 'grok' }, strict: false, model: 'grok-4.7', effort: 'high' },
      { topic: 'adult', target: { provider: 'grok' }, strict: true, model: 'grok-4.7', effort: 'xhigh' },
      {
        topic: 'other',
        target: { runtimeId: 'claude-native', provider: 'claude' },
        strict: false,
        model: 'claude-opus-5',
        effort: 'high',
      },
      { topic: 'merge', target: { provider: 'grok' }, strict: false, model: 'grok-4.7', effort: 'medium' },
    ],
    chapterAgents: true,
    mask: true,
    updatedAt: '',
  };
  const coordinator = routedMessage(message('整理第一章'), routing, modelCards);
  assert.deepEqual([coordinator.provider, coordinator.model, coordinator.effort], ['grok', 'grok-4.7', 'high']);
  const own = routedMessage(message('整理第一章', { provider: 'grok', model: 'grok-4.6' }), routing, modelCards);
  assert.equal(own.model, 'grok-4.6');
  const claude = { label: 'Claude · 本机', provider: 'claude' as const, runtimeId: 'claude-native' };
  const grok = { label: 'Grok', provider: 'grok' as const };
  assert.deepEqual(routedDelegation(claude, '改写第三章的对白', routing, modelCards), {
    agent: claude,
    redirected: false,
    model: 'claude-opus-5',
    effort: 'high',
  });
  const adult = routedDelegation(claude, '写第二章的性爱描写', routing, modelCards);
  assert.deepEqual(
    [adult.agent.provider, adult.model, adult.effort, adult.redirected],
    ['grok', 'grok-4.7', 'xhigh', true],
  );
  assert.deepEqual(
    [routedDelegation(grok, '把十章合并统稿', routing, modelCards)].map((r) => [r.model, r.effort]),
    [['grok-4.7', 'medium']],
  );
  // A model the executor no longer offers is dropped rather than failing the task.
  const stale = { ...routing, rules: [{ ...routing.rules[2]!, model: 'claude-opus-4-1' }] };
  assert.deepEqual(routedDelegation(claude, '改写第三章', stale, modelCards), { agent: claude, redirected: false });
});

test('a Cursor rule picks a model family and effort, and runs as Cursor’s own id for that pair', () => {
  const cursorCard: RoutingCard = {
    id: 'cursor-native',
    label: 'Cursor · 本机',
    provider: 'cursor',
    models: ['auto', 'grok-4.7-medium', 'grok-4.7-high', 'grok-4.7-high-fast', 'claude-opus-5-thinking-high'].map(
      (id) => ({
        id,
        label: id,
        efforts: [],
      }),
    ),
  };
  const parsed = parseRoutingText('其余内容交给 cursor 的 grok 4.7 high', [cursorCard]);
  assert.deepEqual(parsed.rules, [
    { topic: 'other', target: { provider: 'cursor' }, strict: false, model: 'grok-4.7', effort: 'high' },
  ]);
  const agent = { label: 'Cursor · 本机', provider: 'cursor' as const, runtimeId: 'cursor-native' };
  assert.deepEqual(routedDelegation(agent, '润色第五章', { ...parsed, updatedAt: '' }, [cursorCard]), {
    agent,
    redirected: false,
    model: 'grok-4.7-high',
  });
});

test('parameterized Cursor rules retain effort for messages and delegations, including stored variant pins', () => {
  const card: RoutingCard = {
    id: 'cursor-native',
    label: 'Cursor',
    provider: 'cursor',
    models: [{ id: 'grok-4.7', label: 'Grok 4.7', efforts: ['low', 'medium', 'high'] }],
  };
  const parsed = { ...parseRoutingText('其余内容交给 cursor 的 grok 4.7 high', [card]), updatedAt: '' };
  const selected = routedMessage(message('整理内容'), parsed, [card]);
  assert.deepEqual([selected.model, selected.effort], [undefined, undefined]);
  const agent = { label: 'Cursor', provider: 'cursor' as const, runtimeId: card.id };
  const delegated = routedDelegation(agent, '整理内容', parsed, [card]);
  assert.deepEqual([delegated.model, delegated.effort], ['grok-4.7', 'high']);
  parsed.rules[0]!.model = 'grok-4.7-high-fast';
  const stored = candidateInputs(upgradeRouting(parsed).rules[0]!, {
    prompt: '整理内容',
    projectPath: 'synthetic',
    kind: 'general',
  })[0]!;
  assert.deepEqual([stored.model, stored.effort], ['grok-4.7-high-fast', 'high']);
  parsed.rules[0]!.effort = 'max';
  const incompatible = candidateInputs(upgradeRouting(parsed).rules[0]!, {
    prompt: '整理内容',
    projectPath: 'synthetic',
    kind: 'general',
  })[0]!;
  assert.deepEqual(
    [incompatible.model, incompatible.effort],
    ['grok-4.7-high-fast', 'max'],
    'leave invalid pins for the router to reject instead of silently lowering them',
  );
});

test('a writing sub-task starts beside its still-working caller without bouncing; one whose caller was cancelled is dropped', async (t) => {
  const f = fixture(t);
  const project = await f.workspace.createProject(f.directory);
  const conversation = f.workspace.createConversation(project.id) as Conversation;
  const statuses = new Set<string>();
  let childId = '';
  let duringCaller: Workflow | undefined;
  const chapter = join(f.directory, 'chapter3.txt');
  f.behavior.codex = async (ctx) => {
    writeFileSync(chapter, 'Synthetic chapter 3\n');
    ctx.emit({
      at: new Date().toISOString(),
      type: 'tool',
      text: 'Synthetic edit receipt',
      data: {
        itemId: 'chapter-edit',
        kind: 'fileChange',
        status: 'completed',
        input: { changes: [{ path: chapter, kind: { type: 'update' } }] },
      },
    });
    return 'chapter updated';
  };
  f.behavior.claude = async (ctx) => {
    // Observe persisted transitions; coalesced UI snapshots can skip short-lived states.
    let markSettled!: () => void;
    const settled = new Promise<void>((done) => (markSettled = done));
    const observe = (workflow: Workflow) => {
      statuses.add(workflow.status);
      if (['completed', 'blocked', 'failed', 'cancelled', 'interrupted'].includes(workflow.status)) markSettled();
    };
    const save = f.workspace.store.save.bind(f.workspace.store);
    const saved = t.mock.method(f.workspace.store, 'save', (...args: Parameters<typeof save>) => {
      const [kind, id, owner, value] = args;
      save(kind, id, owner, value);
      if (kind === 'workflow' && (value as Workflow).delegation?.parentId === ctx.input.workflowId)
        observe(value as Workflow);
    });
    const auth = `Bearer ${ctx.agentBridge!.token}`;
    // Hand chapter 3 to Codex without waiting, then keep working here.
    const reply = text(
      await f.bridge.handle(
        auth,
        call('delegate', {
          agent: 'Codex B',
          task: '改写第三章',
          write: true,
          files: ['chapter3.txt'],
          wait_seconds: 0,
        }),
      ),
    );
    assert.doesNotMatch(reply, /错误|失败/);
    childId =
      f.workspace.store
        .list<Workflow>('workflow', conversation.id, 100)
        .find((workflow) => workflow.delegation?.parentId === ctx.input.workflowId)?.id ?? '';
    try {
      observe(f.workspace.store.get<Workflow>('workflow', childId)!);
      await waitForSignal(settled, 'the writing sub-task to settle');
    } finally {
      saved.mock.restore();
    }
    duringCaller = structuredClone(f.workspace.store.get<Workflow>('workflow', childId)!);
    return 'coordinator done';
  };
  const parent = await f.workspace.send(conversation.id, {
    content: '整理第三章',
    runtimeId: 'claude',
    mode: 'build',
    permissionMode: 'workspace-write',
    executionPolicy: 'cli-first',
    autoEscalate: false,
  });
  // Ticking runs the queue: the caller and the sub-task it handed off share one loop here.
  assert.equal((await finish(f.workspace, parent.workflow.id)).status, 'completed');
  // The sub-task finished while its caller was still working: started once, never turned away or parked.
  assert.equal(duringCaller?.status, 'completed');
  assert.equal(duringCaller?.runIds.length, 1);
  assert.equal(readFileSync(chapter, 'utf8'), 'Synthetic chapter 3\n');
  assert.ok(statuses.has('running'), [...statuses].join(', '));
  assert.ok(!statuses.has('waiting-resource'), [...statuses].join(', '));

  // A queued sub-task whose caller was cancelled is cancelled instead of waiting forever.
  const orphan = structuredClone(f.workspace.store.get<Workflow>('workflow', childId)!);
  orphan.id = '00000000-0000-4000-8000-000000000001';
  orphan.status = 'queued';
  orphan.phase = 'queue';
  orphan.runIds = [];
  orphan.delegation = { ...orphan.delegation!, requestId: 'orphan-request' };
  orphan.startedAt = undefined;
  orphan.finalMessageId = undefined;
  const cancelledParent = f.workspace.store.get<Workflow>('workflow', parent.workflow.id)!;
  cancelledParent.status = 'cancelled';
  f.workspace.store.save('workflow', cancelledParent.id, cancelledParent.conversationId, cancelledParent);
  f.workspace.store.save('workflow', orphan.id, orphan.conversationId, orphan);
  await f.workspace.tickQueue();
  assert.equal(f.workspace.store.get<Workflow>('workflow', orphan.id)!.status, 'cancelled');
});

for (const selection of [
  {
    // A named account is the preferred executor while it is available; generic providers still balance quota.
    agent: 'Claude B',
    runtimeId: 'claude-b',
    expected: 'claude-b',
    title: 'a caller that names an available account keeps that account as the preferred executor',
  },
  {
    agent: 'Claude',
    runtimeId: undefined,
    expected: 'claude',
    title: 'a provider-only child uses the account whose available quota resets sooner',
  },
])
  test(selection.title, async (t) => {
    const f = fixture(t);
    const hour = 3_600_000;
    const quota = (used: number, hours: number) => ({
      status: 'known' as const,
      source: 'fixture',
      observedAt: new Date().toISOString(),
      windows: [
        { id: 'week', label: 'week', usedPercent: used, resetsAt: new Date(Date.now() + hours * hour).toISOString() },
      ],
    });
    // Claude · 本机: half left, resetting within a day; Claude B: more left, for four more days.
    f.controller.snapshots = f.controller.snapshots.map((snapshot) =>
      snapshot.id === 'claude'
        ? { ...snapshot, quota: quota(50, 23) }
        : snapshot.id === 'claude-b'
          ? { ...snapshot, quota: quota(28, 95) }
          : snapshot,
    );
    const project = await f.workspace.createProject(f.directory);
    const conversation = f.workspace.createConversation(project.id) as Conversation;
    let reply = '';
    f.behavior.codex = async (ctx) => {
      reply = text(
        await f.bridge.handle(
          `Bearer ${ctx.agentBridge!.token}`,
          call('delegate', { agent: selection.agent, task: '审读第三章', wait_seconds: 30 }),
        ),
      );
      return 'done';
    };
    const parent = await f.workspace.send(conversation.id, {
      ...{ content: '安排审读', runtimeId: 'codex' },
      mode: 'chat',
      permissionMode: 'read-only',
      executionPolicy: 'cli-first',
      autoEscalate: false,
    } as MessageInput);
    assert.equal((await finish(f.workspace, parent.workflow.id)).status, 'completed');
    assert.match(reply, /已完成/);
    const child = f.calls.find((ctx) => ctx.input.agentChild);
    assert.equal(child?.target.id, selection.expected);
    assert.equal(child?.target.provider, 'claude');
    const workflow = f.workspace.store.get<Workflow>('workflow', child!.input.workflowId!)!;
    assert.equal(workflow.input.runtimeId, selection.runtimeId);
    if (!selection.runtimeId)
      assert.equal(
        workflow.input.provider,
        'claude',
        'the platform choice still constrains automatic account selection',
      );
  });
