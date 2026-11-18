import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test, type TestContext } from 'node:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Controller } from '../src/server/controller.ts';
import { Workspace } from '../src/server/workspace.ts';
import { codexAdapter } from '../src/server/adapters/codex.ts';
import { claudeAdapter } from '../src/server/adapters/claude.ts';
import { grokAdapter } from '../src/server/adapters/grok.ts';
import { cursorAdapter } from '../src/server/adapters/cursor.ts';
import { openTopic, withPreferences, writingRequest, writingTopic } from '../src/server/taste-test.ts';
import type {
  Conversation,
  LegacyConversationRouting as ConversationRouting,
  ExecuteContext,
  ExecuteResult,
  MessageInput,
  Project,
  RuntimeSnapshot,
  RuntimeTarget,
  TasteTest,
  WritingPreference,
  Workflow,
} from '../src/shared/types.ts';

const routing = (rules: ConversationRouting['rules']): ConversationRouting => ({
  text: '',
  rules,
  chapterAgents: true,
  mask: false,
  updatedAt: '2026-10-04T00:00:00.000Z',
});
const preference = (patch: Partial<WritingPreference> = {}): WritingPreference => ({
  topic: 'prose',
  provider: 'claude',
  model: 'opus',
  effort: 'xhigh',
  label: 'Claude · Opus · xhigh',
  chosenAt: '2026-10-04T00:00:00.000Z',
  testId: 'test',
  tested: [],
  ...patch,
});

test('a writing preference fills in only where the rules leave the writer open', () => {
  assert.ok(writingRequest('续写第三章，两人在雨里碰面'));
  assert.ok(writingRequest('把这段对白改得像真人说话'));
  assert.ok(!writingRequest('帮我看下这个报错，测试为什么失败'));
  assert.equal(writingTopic('写一段情色描写'), 'adult');
  assert.equal(writingTopic('写一段雨夜的描写'), 'prose');
  const open = routing([
    { topic: 'adult', target: { provider: 'grok' }, strict: true, model: 'grok-4.7', effort: 'xhigh' },
    { topic: 'other', target: {}, strict: false },
  ]);
  assert.ok(openTopic(open, 'prose'));
  assert.ok(!openTopic(open, 'adult'), 'the user named the adult writer');
  const filled = withPreferences(open, [preference(), preference({ topic: 'adult', provider: 'cursor' })], true)!;
  assert.deepEqual(filled.rules.find((rule) => rule.category === 'writing')?.candidates, [
    { provider: 'claude', model: 'opus', effort: 'xhigh' },
  ]);
  assert.deepEqual(filled.rules.find((rule) => rule.category === 'adult')?.candidates[0], {
    provider: 'grok',
    model: 'grok-4.7',
    effort: 'xhigh',
  });
  // Cursor's rule keeps the exact variant as well as its effort, so thinking/fast survive replay.
  const cursor = withPreferences(
    undefined,
    [preference({ provider: 'cursor', model: 'claude-opus-5-thinking-high' })],
    true,
  )!;
  assert.equal(cursor.rules[0]?.category, 'writing');
  assert.deepEqual(cursor.rules[0]?.candidates, [
    { provider: 'cursor', model: 'claude-opus-5-thinking-high', effort: 'high' },
  ]);
  const cleared = { ...cursor, rules: [{ ...cursor.rules[0]!, candidates: [] }] };
  assert.deepEqual(
    withPreferences(cleared, [preference()], true)?.rules,
    cleared.rules,
    'an explicit cleared writing rule is still an owner choice',
  );
  // Without rules of its own, a conversation gets the preference only for a writing request.
  assert.equal(withPreferences(undefined, [preference()], false), undefined);
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
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'taste-test-')));
  // Conversation memory goes to a throwaway folder, never the user's own data directory.
  const memoryDirectory = realpathSync.native(mkdtempSync(join(tmpdir(), 'taste-test-memory-')));
  const previousMemoryDirectory = process.env.COMBORUNNER_MEMORY_DIR;
  process.env.COMBORUNNER_MEMORY_DIR = memoryDirectory;
  const controller = new Controller(directory, join(directory, 'data'), { readAccountIdentity: () => 'synthetic' });
  clearInterval(controller.timer);
  controller.settings.decisionMode = 'auto';
  controller.targets = [
    card('codex', 'codex', 'Codex B'),
    card('claude', 'claude', 'Claude · 本机'),
    card('grok', 'grok', 'Grok · 本机'),
  ];
  controller.snapshots = controller.targets.map((target): RuntimeSnapshot => ({
    ...target,
    installed: true,
    status: 'ready',
    models: [{ id: `${target.provider}-top`, label: `${target.label} top`, efforts: ['low', 'medium', 'high'] }],
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
  }));
  t.mock.method(controller, 'refresh', async () => {});
  const calls: ExecuteContext[] = [];
  const execute = async (ctx: ExecuteContext): Promise<ExecuteResult> => {
    calls.push(ctx);
    return { output: `${ctx.target.label} 写的一段`, nativeSessionId: `session-${calls.length}` };
  };
  t.mock.method(codexAdapter, 'execute', execute);
  t.mock.method(claudeAdapter, 'execute', execute);
  t.mock.method(grokAdapter, 'execute', execute);
  const workspace = new Workspace(controller, { autoTick: false });
  t.after(async () => {
    await workspace.close();
    await controller.close();
    rmSync(directory, { recursive: true, force: true });
    rmSync(memoryDirectory, { recursive: true, force: true });
    if (previousMemoryDirectory === undefined) delete process.env.COMBORUNNER_MEMORY_DIR;
    else process.env.COMBORUNNER_MEMORY_DIR = previousMemoryDirectory;
  });
  return { workspace, controller, calls, directory };
}

async function settled(workspace: Workspace, id: string) {
  for (let i = 0; i < 600; i++) {
    const test = workspace.store.get<TasteTest>('taste-test', id)!;
    if (test.status !== 'writing') return test;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('taste test did not settle');
}
async function settledWorkflow(workspace: Workspace, id: string) {
  for (let i = 0; i < 1000; i++) {
    await workspace.tickQueue();
    const workflow = workspace.store.get<Workflow>('workflow', id)!;
    if (['completed', 'blocked', 'failed', 'cancelled'].includes(workflow.status)) return workflow;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('writing workflow did not settle');
}
const input: MessageInput = {
  content: '',
  mode: 'chat',
  permissionMode: 'read-only',
  executionPolicy: 'cli-first',
  autoEscalate: false,
};

test('native confirmed settings reach the run, trial label and chosen preference without replacing the requested route', async (t) => {
  const f = fixture(t);
  const effectiveModel = {
    model: 'claude-actual',
    effort: 'medium',
    source: 'fixture native',
    parameters: { effort: 'medium' },
  };
  t.mock.method(claudeAdapter, 'execute', async (ctx: ExecuteContext): Promise<ExecuteResult> => {
    ctx.emit({ type: 'session', at: new Date().toISOString(), data: { effectiveModel } });
    return { output: 'A complete sample.', effectiveModel };
  });
  const project = await f.workspace.createProject(f.directory);
  const conversation = f.workspace.createConversation(project.id) as Conversation;
  const started = f.workspace.tastes.start(conversation, 'Write a short opening scene.', 'prose');
  const ready = await settled(f.workspace, started.id);
  const candidate = ready.candidates.find((item) => item.provider === 'claude')!;
  assert.equal(candidate.status, 'done');
  assert.equal(candidate.model, 'claude-actual');
  assert.equal(candidate.effort, 'medium');
  assert.match(candidate.label, /claude-actual.*medium/);
  const run = f.controller.run(candidate.runId!)!;
  assert.equal(run.route.model, 'claude-top');
  assert.deepEqual(run.effectiveModel, effectiveModel);
  f.workspace.tastes.choose(ready.id, candidate.key, { verdict: 'good', makeDefault: true });
  const saved = f.workspace.store.get<Project>('project', project.id)!;
  assert.equal(saved.writingPreferences?.[0]?.model, 'claude-actual');
  assert.equal(saved.writingPreferences?.[0]?.effort, 'medium');
});

test('Cursor trial preferences replay their confirmed flags through canonical catalogs while labels stay canonical', async (t) => {
  const f = fixture(t);
  f.controller.targets = f.controller.targets.filter((target) => target.provider !== 'claude');
  f.controller.snapshots = f.controller.snapshots.filter((snapshot) => snapshot.provider !== 'claude');
  const cursor = card('cursor', 'cursor', 'Cursor');
  f.controller.targets.push(cursor);
  f.controller.snapshots.push({
    ...f.controller.snapshots[0]!,
    ...cursor,
    models: [{ id: 'claude-opus-5', label: 'Claude Opus 5', efforts: ['medium', 'high'] }],
  });
  const effectiveModel = {
    model: 'claude-opus-5',
    effort: 'high',
    source: 'fixture Cursor ACP',
    parameters: { thinking: 'true', fast: 'false', reasoning: 'high' },
  };
  t.mock.method(cursorAdapter, 'execute', async (ctx: ExecuteContext): Promise<ExecuteResult> => {
    f.calls.push(ctx);
    ctx.emit({ type: 'session', at: new Date().toISOString(), data: { effectiveModel } });
    return { output: 'Cursor sample.', effectiveModel };
  });
  const project = await f.workspace.createProject(f.directory);
  const conversation = f.workspace.createConversation(project.id) as Conversation;
  const started = f.workspace.tastes.start(conversation, 'Write a short opening scene.', 'prose');
  const ready = await settled(f.workspace, started.id);
  const candidate = ready.candidates.find((item) => item.provider === 'cursor')!;
  assert.equal(candidate.status, 'done');
  assert.equal(candidate.model, 'claude-opus-5-thinking-high');
  assert.equal(candidate.effort, 'high');
  assert.equal(candidate.label, 'Cursor · Claude Opus 5 · high');
  assert.deepEqual(candidate.effectiveModel, effectiveModel);
  assert.equal(f.controller.run(candidate.runId!)?.route.model, 'claude-opus-5');
  f.workspace.tastes.choose(ready.id, candidate.key, { verdict: 'good', makeDefault: true });
  const saved = f.workspace.store.get<Project>('project', project.id)!;
  const rule = withPreferences(undefined, saved.writingPreferences, true)!;
  const selected = rule.rules.find((rule) => rule.category === 'writing')!.candidates[0]!;
  assert.equal(selected.model, 'claude-opus-5-thinking-high');
  assert.equal(selected.effort, 'high');
  assert.ok(
    saved.writingPreferences?.[0]?.tested.includes('cursor/claude-opus-5'),
    'A replay slug must not make the same catalog family look like an untested new model.',
  );
});

test('Cursor writing rules retain fast/thinking flags and explicit false variants', () => {
  for (const model of ['claude-opus-5-thinking-high-fast', 'claude-opus-5-high']) {
    const rules = withPreferences(undefined, [preference({ provider: 'cursor', model, effort: 'high' })], true)!;
    const message = rules.rules.find((rule) => rule.category === 'writing')!.candidates[0]!;
    assert.equal(message.model, model);
    assert.equal(message.effort, 'high');
  }
});

test('three executors write the same passage read-only; the blind pick routes later writing and its reason is kept', async (t) => {
  const f = fixture(t);
  const project = await f.workspace.createProject(f.directory);
  const conversation = f.workspace.createConversation(project.id) as Conversation;
  const started = f.workspace.tastes.start(conversation, '写第三章开头，两人在雨里碰面', 'prose');
  assert.deepEqual(
    started.candidates.map((candidate) => candidate.key),
    ['A', 'B', 'C'],
  );
  assert.deepEqual(
    new Set(started.candidates.map((candidate) => candidate.provider)),
    new Set(['claude', 'grok', 'codex']),
  );
  const ready = await settled(f.workspace, started.id);
  assert.equal(ready.status, 'ready');
  assert.ok(ready.candidates.every((candidate) => candidate.status === 'done' && /写的一段$/.test(candidate.text!)));
  assert.ok(f.calls.every((ctx) => ctx.input.permissionMode === 'read-only'));
  assert.ok(f.calls.every((ctx) => /文风试写对比[\s\S]*写第三章开头，两人在雨里碰面/.test(ctx.input.prompt)));
  // A second request for the same kind of writing returns the open test instead of another one.
  assert.equal(f.workspace.tastes.start(conversation, '再试一次', 'prose').id, started.id);

  const claude = ready.candidates.find((candidate) => candidate.provider === 'claude')!;
  const chosen = f.workspace.tastes.choose(started.id, claude.key, {
    verdict: 'good',
    makeDefault: true,
    reason: '对白要像真人说话，不要自问自答',
  });
  assert.equal(chosen.status, 'chosen');
  const saved = f.workspace.store.get<Project>('project', project.id)!;
  assert.deepEqual(
    saved.writingPreferences?.map(({ topic, provider, model, effort, reason }) => ({
      topic,
      provider,
      model,
      effort,
      reason,
    })),
    [
      {
        topic: 'prose',
        provider: 'claude',
        model: 'claude-top',
        effort: claude.effort,
        reason: '对白要像真人说话，不要自问自答',
      },
    ],
  );

  // Writing now goes to the chosen executor and model, and is told the reason; other requests are untouched.
  const writing = await f.workspace.send(conversation.id, { ...input, content: '续写第四章' });
  assert.equal(writing.workflow.input.provider, undefined, 'writing preferences stay automatic until route()');
  assert.equal((await settledWorkflow(f.workspace, writing.workflow.id)).status, 'completed');
  const routed = [...f.calls].reverse().find((call) => call.input.workflowId === writing.workflow.id)!;
  assert.equal(routed.target.provider, 'claude');
  assert.equal(routed.route.model, 'claude-top');
  assert.match(writing.workflow.memoryExcerpt, /对白要像真人说话，不要自问自答/);
  const other = await f.workspace.send(conversation.id, { ...input, content: '帮我看下这个报错' });
  assert.equal(other.workflow.input.provider, undefined);
  // The chosen preference already covers every candidate, so no new test starts.
  assert.equal(f.workspace.tastes.list().length, 1);
});

test('a writing request left to PugPort starts a test on its own, but not when the user chose or turned it off', async (t) => {
  const f = fixture(t);
  const project = await f.workspace.createProject(f.directory);
  const conversation = f.workspace.createConversation(project.id) as Conversation;
  // The user named an executor: their choice stands and nothing is tested.
  await f.workspace.send(conversation.id, { ...input, content: '续写第三章', runtimeId: 'codex' });
  assert.equal(f.workspace.tastes.list().length, 0);
  // Not writing at all.
  await f.workspace.send(conversation.id, { ...input, content: '这个测试为什么失败' });
  assert.equal(f.workspace.tastes.list().length, 0);
  await f.workspace.send(conversation.id, { ...input, content: '续写第三章' });
  const [auto] = f.workspace.tastes.list();
  assert.equal(auto?.topic, 'prose');
  await settled(f.workspace, auto!.id);
  // Skipped with "don't test on your own": no automatic test again, even for another kind of writing.
  f.workspace.tastes.dismiss(auto!.id, true);
  await f.workspace.send(conversation.id, { ...input, content: '续写第五章的对白' });
  assert.equal(f.workspace.tastes.list().length, 1);
  assert.equal(f.workspace.store.get<Project>('project', project.id)!.tasteTestsOff, true);
});

test('the card stays blind until the pick, then says who wrote which', async () => {
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { TasteTestCard } = await import('../src/ui/TasteTest.tsx');
  const candidate = (key: 'A' | 'B' | 'C', label: string) => ({
    key,
    provider: 'claude' as const,
    runtimeId: 'claude',
    model: 'claude-top',
    label,
    status: 'done' as const,
    text: `第${key}段\n雨落下来。`,
  });
  const base: TasteTest = {
    id: 'test',
    projectId: 'project',
    conversationId: 'conversation',
    topic: 'prose',
    brief: '写雨夜',
    status: 'ready',
    candidates: [
      candidate('A', 'Claude · 本机 · Opus'),
      candidate('B', 'Grok · 本机 · 4.7'),
      candidate('C', 'Codex B'),
    ],
    createdAt: '2026-10-04T00:00:00.000Z',
    updatedAt: '2026-10-04T00:00:00.000Z',
  };
  const render = (test: TasteTest) =>
    renderToStaticMarkup(
      createElement(TasteTestCard, { test, api: async <T>() => ({}) as T, notify() {}, onClose() {} }),
    );
  const ready = render(base);
  assert.match(ready, /你更喜欢哪一段[\s\S]*第A段[\s\S]*选 A[\s\S]*第B段[\s\S]*第C段/);
  assert.doesNotMatch(ready, /Claude|Grok|Codex/);
  const chosen = render({ ...base, status: 'chosen', chosen: 'B' });
  assert.match(chosen, /你选了 B：Grok · 本机 · 4\.7[\s\S]*class="chosen"><strong>B<\/strong>/);
  assert.match(chosen, /Claude · 本机 · Opus/);
});

test('only a request to write prose starts a test; a review of the chapters does not, and preambles are dropped', async (t) => {
  const { samplePassage } = await import('../src/server/taste-test.ts');
  assert.ok(!writingRequest('你再看看之前提到的问题，是否已经解决的，还存在什么问题，请你让子agent去审核不同的段落'));
  assert.ok(!writingRequest('写个脚本清理日志'));
  assert.ok(!writingRequest('修改代码里的bug'));
  assert.ok(writingRequest('润色第二章的开头'));
  assert.equal(
    samplePassage('我先看项目里已有的文稿，再按那个文风写一段示范。　　散场的门一开，她从人群那头挤过来。'),
    '散场的门一开，她从人群那头挤过来。',
  );
  assert.equal(samplePassage('这是她第一次见他。雨很大。'), '这是她第一次见他。雨很大。', 'a passage is kept whole');

  // In a conversation whose rules split chapters, a review request still starts nothing.
  const f = fixture(t);
  const project = await f.workspace.createProject(f.directory);
  const conversation = f.workspace.createConversation(project.id) as Conversation;
  const saved = f.workspace.store.get<Conversation>('conversation', conversation.id)!;
  saved.routing = routing([{ topic: 'other', target: {}, strict: false }]);
  f.workspace.store.save('conversation', saved.id, saved.projectId, saved);
  await f.workspace.send(conversation.id, { ...input, content: '请你让子agent去审核不同的段落，看看还有什么问题' });
  assert.equal(f.workspace.tastes.list().length, 0);

  // "None of them": another batch with other efforts of the same models.
  const first = await settled(f.workspace, f.workspace.tastes.start(saved, '续写第三章', 'prose').id);
  const second = f.workspace.tastes.retry(first.id);
  assert.equal(f.workspace.store.get<TasteTest>('taste-test', first.id)!.status, 'dismissed');
  const before = new Set(first.candidates.map((c) => `${c.provider}/${c.model}/${c.effort}`));
  assert.ok(second.candidates.length >= 2);
  assert.ok(second.candidates.every((c) => !before.has(`${c.provider}/${c.model}/${c.effort}`)));
  await settled(f.workspace, second.id);
});

test('a pick is the best of a batch, good enough, or the default; only the default is remembered', async (t) => {
  const f = fixture(t);
  const project = await f.workspace.createProject(f.directory);
  const conversation = f.workspace.createConversation(project.id) as Conversation;
  const first = await settled(f.workspace, f.workspace.tastes.start(conversation, '续写第三章', 'prose').id);
  // "The best of these, but still not good": nothing about the project changes, and the reason goes nowhere.
  f.workspace.tastes.choose(first.id, 'A', { reason: '都不好，感觉文笔很差' });
  assert.equal(f.workspace.store.get<TasteTest>('taste-test', first.id)!.verdict, 'better');
  assert.equal(f.workspace.store.get<Project>('project', project.id)!.writingPreferences, undefined);
  const second = await settled(f.workspace, f.workspace.tastes.start(conversation, '续写第四章', 'prose').id);
  assert.throws(
    () => f.workspace.tastes.choose(second.id, 'B', { makeDefault: true }),
    /只有满意的那一段才能设为默认写手/,
  );
  // Good enough this time is still not the default.
  f.workspace.tastes.choose(second.id, 'B', { verdict: 'good' });
  assert.equal(f.workspace.store.get<Project>('project', project.id)!.writingPreferences, undefined);
});

test('novel writing alone gets the writing tools; code and other requests never see them', async (t) => {
  const { fictionContext } = await import('../src/shared/fiction.ts');
  assert.ok(fictionContext({ routing: routing([]) }, {}));
  assert.ok(fictionContext({}, { manuscript: 'C:/book' }));
  assert.ok(fictionContext({}, {}, '续写第三章'));
  assert.ok(!fictionContext({}, {}, '修一下登录页面的 bug'));
  assert.ok(!fictionContext({ routing: { ...routing([]), chapterAgents: false } }, {}));

  // The bridge offers the style check only to a run that is novel writing.
  const { AgentBridge } = await import('../src/server/agent-bridge.ts');
  const caller = (fiction: boolean) => ({
    run: { id: 'run', workflowId: 'workflow', status: 'running', projectPath: tmpdir() },
    target: { id: 'codex', provider: 'codex' },
    delegate: false,
    recycle: false,
    child: false,
    write: false,
    ...(fiction ? { fiction: true } : {}),
    signal: new AbortController().signal,
  });
  const { directory, workspace } = fixture(t);
  const controller = Object.assign(new EventEmitter(), {
    dataDir: directory,
    agentBridgeCaller: (token: string) => caller(token === 'novel'),
    returnExecution: () => async () => {},
  }) as unknown as Controller;
  const bridge = new AgentBridge(workspace, controller);
  t.after(async () => {
    await bridge.close();
    assert.equal(controller.listenerCount('state'), 0);
  });
  const tools = async (token: string) => {
    const reply = (await bridge.handle(`Bearer ${token}`, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).body as {
      result?: { tools: { name: string }[] };
      error?: unknown;
    };
    assert.equal(reply.error, undefined, 'tools/list must return the authorized catalog');
    assert.ok(reply.result);
    return reply.result.tools.map((tool) => tool.name);
  };
  assert.ok((await tools('novel')).includes('check_style'));
  assert.ok(!(await tools('code')).includes('check_style'));
});

test('the style check reads the book the user named, and asks when the project holds several versions', async (t) => {
  const f = fixture(t);
  const { mkdirSync, writeFileSync } = await import('node:fs');
  for (const folder of ['书/正文', '书_修订']) {
    mkdirSync(join(f.directory, folder), { recursive: true });
    writeFileSync(join(f.directory, folder, '第01章.txt'), '第01章\n　　白不是雪。是霜。');
  }
  const project = await f.workspace.createProject(f.directory);
  const conversation = f.workspace.createConversation(project.id) as Conversation;
  await assert.rejects(f.workspace.styleCheck(conversation.id), /先在路由面板里选好这本书的正式正文文件夹/);
  await f.workspace.setManuscript(project.id, join(f.directory, '书', '正文'));
  assert.equal((await f.workspace.styleCheck(conversation.id)).chapters, 1);
  // Every task in the project is told where the book's text is.
  const sent = await f.workspace.send(conversation.id, { ...input, content: '看看第二章讲了什么' });
  assert.match(sent.workflow.memoryExcerpt, /这本书的正式正文在「[^」]*书[\\/]正文」/);
});

test('the extra review is skipped only when an editor read the chapter after its last revision', async (t) => {
  const f = fixture(t);
  const project = await f.workspace.createProject(f.directory);
  const conversation = f.workspace.createConversation(project.id) as Conversation;
  const saved = f.workspace.store.get<Conversation>('conversation', conversation.id)!;
  saved.routing = routing([{ topic: 'other', target: {}, strict: false }]);
  f.workspace.store.save('conversation', saved.id, saved.projectId, saved);
  const settle = async (id: string) => {
    let workflow = f.workspace.store.get<Workflow>('workflow', id)!;
    for (let i = 0; i < 400 && (workflow.status !== 'completed' || !workflow.review?.status); i++) {
      await f.workspace.tickQueue();
      await new Promise((resolve) => setTimeout(resolve, 10));
      workflow = f.workspace.store.get<Workflow>('workflow', id)!;
    }
    return workflow;
  };
  // A task in the novel conversation that had no editor (a code fix, research) is reviewed as usual.
  const plain = await f.workspace.send(conversation.id, { ...input, content: '看看第二章讲了什么', review: true });
  assert.equal((await settle(plain.workflow.id)).review?.status, 'reviewing');

  // A chapter written by one sub-task and then read by an editor needs no second review.
  const chapter = await f.workspace.send(conversation.id, { ...input, content: '看看第三章讲了什么', review: true });
  const child = (id: string, label: string, permissionMode: MessageInput['permissionMode'], createdAt: string) =>
    f.workspace.store.save('workflow', id, conversation.id, {
      ...chapter.workflow,
      id,
      status: 'completed',
      input: { ...chapter.workflow.input, permissionMode },
      delegation: {
        parentId: chapter.workflow.id,
        role: permissionMode === 'read-only' ? 'scout' : 'worker',
        requestId: id,
        agent: { label, provider: 'claude' },
      },
      createdAt,
      updatedAt: createdAt,
    });
  child('writer-1', 'Claude · 本机', 'workspace-write', '2026-10-05T01:00:00.000Z');
  child('editor-1', 'Codex B', 'read-only', '2026-10-05T01:05:00.000Z');
  const reviewed = await settle(chapter.workflow.id);
  assert.deepEqual(reviewed.review, {
    round: 0,
    status: 'stopped',
    reason: '「Codex B」已在最后一次修改之后通读过，不再另外审核。',
  });
});

test('software work that uses a fiction word is not novel writing; reviewing a chapter is novel work but not a request to write', async () => {
  const { novelRequest } = await import('../src/shared/fiction.ts');
  for (const text of ['帮我写一个登录场景的测试', '修改角色权限页面的按钮', '修一下登录页面的 bug']) {
    assert.ok(!writingRequest(text), text);
    assert.ok(!novelRequest(text), text);
  }
  assert.ok(!writingRequest('审核第三章的对白'));
  assert.ok(novelRequest('审核第三章的对白'));
  assert.ok(writingRequest('续写第四章') && novelRequest('续写第四章'));
});
