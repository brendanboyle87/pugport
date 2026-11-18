import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Controller } from '../src/server/controller.ts';
import { Workspace } from '../src/server/workspace.ts';
import { ConversationActions } from '../src/server/conversation-actions.ts';
import { AgentBridge, agentBridgeToolNames } from '../src/server/agent-bridge.ts';
import { codexAdapter } from '../src/server/adapters/codex.ts';
import { claudeAdapter, agentBridgeTools } from '../src/server/adapters/claude.ts';
import { grokAdapter } from '../src/server/adapters/grok.ts';
import type {
  ExecuteContext,
  ExecuteResult,
  MessageInput,
  RuntimeSnapshot,
  RuntimeTarget,
  Workflow,
} from '../src/shared/types.ts';

type Behavior = (ctx: ExecuteContext, steered: string[]) => Promise<string>;

const card = (id: string, provider: RuntimeTarget['provider'], label: string): RuntimeTarget => ({
  id,
  provider,
  label,
  command: 'unused',
  environment: 'native',
  enabled: true,
});

function fixture(t: TestContext) {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'multi-agent-test-')));
  const oldMemory = process.env.COMBORUNNER_MEMORY_DIR;
  process.env.COMBORUNNER_MEMORY_DIR = join(directory, 'memory');
  const controller = new Controller(directory, join(directory, 'data'));
  clearInterval(controller.timer);
  controller.settings.decisionMode = 'auto';
  controller.settings.routePreferencesEnabled = true;
  controller.settings.architectureProvider = 'codex';
  controller.settings.routineProvider = 'codex';
  controller.settings.designProvider = 'codex';
  controller.agentBridgeUrl = 'http://127.0.0.1:0/mcp';
  controller.targets = [
    card('codex', 'codex', 'Codex B'),
    card('claude', 'claude', 'Claude · 本机'),
    card('grok', 'grok', 'Grok · 本机'),
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
  const calls: ExecuteContext[] = [];
  const behavior: Partial<Record<RuntimeTarget['provider'], Behavior>> = {};
  const execute = async (ctx: ExecuteContext): Promise<ExecuteResult> => {
    calls.push(ctx);
    // The model's collection turn integrates existing work instead of replaying the original delegation script.
    if (ctx.input.prompt.includes('已收集子任务结果')) return { output: 'Collected and checked the child results.' };
    // Every executor accepts messages into its running session, as the native steering channel does.
    const steered: string[] = [];
    ctx.registerSteer?.(async (prompt) => {
      steered.push(prompt);
    });
    const run = behavior[ctx.target.provider];
    const output = run ? await run(ctx, steered) : `${ctx.target.label} answer`;
    return { output, nativeSessionId: `session-${calls.length}` };
  };
  t.mock.method(codexAdapter, 'execute', execute);
  t.mock.method(claudeAdapter, 'execute', execute);
  t.mock.method(grokAdapter, 'execute', execute);
  const workspace = new Workspace(controller, { autoTick: false });
  const bridge = new AgentBridge(workspace, controller);
  t.after(async () => {
    await workspace.close();
    await controller.close();
    if (oldMemory === undefined) delete process.env.COMBORUNNER_MEMORY_DIR;
    else process.env.COMBORUNNER_MEMORY_DIR = oldMemory;
    const absolute = resolve(directory);
    assert.ok(
      absolute.startsWith(realpathSync.native(tmpdir()) + sep) && basename(absolute).startsWith('multi-agent-test-'),
    );
    rmSync(absolute, { recursive: true, force: true });
  });
  return { workspace, controller, calls, behavior, bridge, directory };
}

// Waits poll for the expected state; the deadline only ends a genuine hang. Parent and child turns, persistence and
// the workspace's 1.5 s result-delivery grace can take far longer on a busy machine, so no happy path should beat it.
const GUARD_MS = 60_000;

async function finish(workspace: Workspace, id: string) {
  const end = Date.now() + GUARD_MS;
  while (Date.now() <= end) {
    await workspace.tickQueue();
    const workflow = workspace.store.get<Workflow>('workflow', id)!;
    if (['completed', 'blocked', 'cancelled', 'failed'].includes(workflow.status)) return workflow;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error('fixture workflow did not finish');
}

async function until(check: () => boolean, ms = GUARD_MS) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('condition not reached');
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
}

const call = (name: string, args: Record<string, unknown>) => ({
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: { name, arguments: args },
});
// The model sees every text block of one tool result; queued notices ride along as their own block after it.
const text = (reply: { body?: unknown }) =>
  (reply.body as { result: { content: { text: string }[] } }).result.content.map((block) => block.text).join('\n\n');
const ask = (bridge: AgentBridge, ctx: ExecuteContext, name: string, args: Record<string, unknown>) =>
  bridge.handle(`Bearer ${ctx.agentBridge!.token}`, call(name, args)).then(text);
const taskIds = (reply: string) => [...reply.matchAll(/task_id: ([0-9a-f-]{36})/g)].map((match) => match[1]!);

const input: MessageInput = {
  content: '让 Claude 本机 和 Grok 本机 一起审查',
  mode: 'build',
  permissionMode: 'workspace-write',
  executionPolicy: 'cli-first',
  autoEscalate: false,
};

async function start(f: ReturnType<typeof fixture>, content = input.content) {
  const project = await f.workspace.createProject(f.directory);
  const conversation = f.workspace.createConversation(project.id);
  return f.workspace.send(conversation.id, { ...input, content });
}

test('Claude pre-approves core bridge tools; search and outcome reports use per-run grants', () => {
  assert.ok(agentBridgeTools.includes('mcp__pugport__read_run_detail'));
  assert.ok(agentBridgeTools.includes('mcp__pugport__ask_user') && agentBridgeToolNames.includes('add_project_rule'));
  assert.deepEqual(
    agentBridgeTools,
    [
      ...agentBridgeToolNames.filter((name) => !['web_search', 'web_fetch', 'report_outcome'].includes(name)),
      'run_remote_job',
      'remote_job_status',
      'cancel_remote_job',
      'answer_lane_question',
      'create_lane',
      'list_project_conversations',
      'send_conversation_message',
      'list_conversation_work',
      'schedule_work',
      'watch_pull_request',
      'pause_scheduled_work',
      'delete_scheduled_work',
      'commit_branch',
      'push_branch',
      'open_branch_pull_request',
      'merge_branch_pull_request',
      'list_remote_queries',
      'run_remote_query',
      'run_judge',
      'judge_result',
      'cancel_judge',
    ].map((name) => `mcp__pugport__${name}`),
  );
});

test('generic children choose independently of the parent account, model and effort', async (t) => {
  const f = fixture(t);
  let childId = '';
  f.behavior.codex = async (ctx) => {
    if (ctx.input.agentChild) return 'Synthetic child result';
    const child = await f.workspace.delegate(ctx.input.workflowId!, 'scout', '查找指定文件并返回路径', 'auto-child');
    childId = child.workflow.id;
    await until(() => f.workspace.store.get<Workflow>('workflow', childId)?.status === 'completed');
    return 'Synthetic parent result';
  };
  const project = await f.workspace.createProject(f.directory);
  const conversation = f.workspace.createConversation(project.id);
  const parent = await f.workspace.send(conversation.id, {
    ...input,
    runtimeId: 'codex',
    model: 'test-model',
    effort: 'high',
    content: 'Review architecture, authentication and security of the synthetic report',
  });
  const completed = await finish(f.workspace, parent.workflow.id);
  assert.equal(
    completed.status,
    'completed',
    JSON.stringify({
      parentError: completed.error,
      child: f.workspace.store.get<Workflow>('workflow', childId),
      calls: f.calls.map((ctx) => ({
        workflowId: ctx.input.workflowId,
        agentChild: ctx.input.agentChild,
        provider: ctx.target.provider,
      })),
    }),
  );
  const child = f.workspace.store.get<Workflow>('workflow', childId)!;
  assert.equal(child.input.runtimeId, undefined);
  assert.equal(child.input.provider, undefined);
  assert.equal(child.input.model, undefined);
  assert.equal(child.input.effort, undefined);
  const launch = f.calls.find((ctx) => ctx.input.workflowId === childId)!;
  assert.equal(launch.input.agentChild, true);
  assert.equal(launch.input.routingPrompt, '查找指定文件并返回路径');
  assert.equal(launch.route.effort, 'low', 'parent architecture context never inflates a small child to high');
});

test('a named child account keeps its runtime when that platform has several accounts', async (t) => {
  const f = fixture(t);
  const other = { ...f.controller.targets[1]!, id: 'claude-other', label: 'Claude C' };
  f.controller.targets.push(other);
  f.controller.snapshots.push({ ...structuredClone(f.controller.snapshots[1]!), id: other.id, label: other.label });
  let childId = '';
  f.behavior.codex = async (ctx) => {
    const child = await f.workspace.delegateToAgent(
      ctx.input.workflowId!,
      { label: 'Claude · 本机', provider: 'claude', runtimeId: 'claude' },
      'Review the synthetic files',
    );
    childId = child.workflow.id;
    await until(() => f.workspace.store.get<Workflow>('workflow', childId)?.status === 'completed');
    return 'Synthetic parent result';
  };
  const parent = await start(f);
  assert.equal((await finish(f.workspace, parent.workflow.id)).status, 'completed');
  const child = f.workspace.store.get<Workflow>('workflow', childId)!;
  assert.equal(child.input.runtimeId, 'claude');
  assert.equal(child.input.provider, undefined);
  assert.equal(f.calls.find((ctx) => ctx.input.workflowId === childId)!.target.id, 'claude');
});

test('a generic child provider still selects among its available accounts', async (t) => {
  const f = fixture(t);
  const other = { ...f.controller.targets[1]!, id: 'claude-other', label: 'Claude C' };
  f.controller.targets.push(other);
  f.controller.snapshots.push({ ...structuredClone(f.controller.snapshots[1]!), id: other.id, label: other.label });
  let childId = '';
  f.behavior.codex = async (ctx) => {
    const child = await f.workspace.delegateToAgent(
      ctx.input.workflowId!,
      { label: 'Claude · 自动选择账号', provider: 'claude' },
      'Review the synthetic files',
    );
    childId = child.workflow.id;
    await until(() => f.workspace.store.get<Workflow>('workflow', childId)?.status === 'completed');
    return 'Synthetic parent result';
  };
  const parent = await start(f);
  assert.equal((await finish(f.workspace, parent.workflow.id)).status, 'completed');
  const child = f.workspace.store.get<Workflow>('workflow', childId)!;
  assert.equal(child.input.runtimeId, undefined);
  assert.equal(child.input.provider, 'claude');
  assert.equal(f.calls.find((ctx) => ctx.input.workflowId === childId)!.target.provider, 'claude');
});

test('one call fans a task out to several executors and returns every result', async (t) => {
  const f = fixture(t);
  const entered = new Set<string>();
  for (const provider of ['claude', 'grok'] as const)
    f.behavior[provider] = async (ctx) => {
      assert.equal(ctx.input.permissionMode, 'read-only');
      entered.add(provider);
      await until(() => entered.size === 2);
      return `${ctx.target.label} answer`;
    };
  let reply = '';
  f.behavior.codex = async (ctx) => {
    if (!ctx.agentBridge) return 'no bridge';
    assert.match(ctx.input.prompt, /agents 可同时交给多个执行器/);
    reply = await ask(f.bridge, ctx, 'delegate', {
      agents: ['claude 本机', 'grok本机'],
      task: 'Review the change',
      wait_seconds: 30,
    });
    return 'merged';
  };
  const parent = await start(f);
  assert.equal((await finish(f.workspace, parent.workflow.id)).status, 'completed');
  assert.match(reply, /Claude · 本机 已完成[\s\S]*Claude · 本机 answer/);
  assert.match(reply, /Grok · 本机 已完成[\s\S]*Grok · 本机 answer/);
  assert.equal(taskIds(reply).length, 2);
  assert.equal(entered.size, 2, 'read-only children can execute concurrently in the same project');
  assert.ok(f.calls.some((ctx) => ctx.target.provider === 'grok' && ctx.input.permissionMode === 'read-only'));
});

test('a detached sub-task reports back by itself, and a child asks its caller and waits for the answer', async (t) => {
  const f = fixture(t);
  const parentLog: string[] = [];
  let childId = '';
  let childGot = '';
  f.behavior.claude = async (ctx) => {
    if (!ctx.agentBridge) return 'no bridge';
    assert.match(ctx.input.prompt, /message_parent/);
    // A child can finish a bounded independent helper before asking its own caller a question.
    assert.match(await ask(f.bridge, ctx, 'delegate', { agent: 'grok', task: 'x' }), /已完成/);
    // A question holds the child's turn open until the caller answers.
    childGot = await ask(f.bridge, ctx, 'message_parent', { text: 'Which file first?' });
    return 'Reviewed README first';
  };
  f.behavior.codex = async (ctx, steered) => {
    if (!ctx.agentBridge) return 'no bridge';
    const reply = await ask(f.bridge, ctx, 'delegate', { agent: 'claude', task: 'Review', wait_seconds: 0 });
    parentLog.push(reply);
    childId = taskIds(reply)[0]!;
    // A caller waiting on the result is released as soon as the child asks, instead of deadlocking.
    const started = Date.now();
    parentLog.push(await ask(f.bridge, ctx, 'get_result', { task_id: childId, wait_seconds: 60 }));
    assert.ok(Date.now() - started < 20_000);
    // The waiting call carried the question, so no duplicate push reached the session.
    assert.ok(!steered.some((prompt) => prompt.includes('在等你回复')));
    parentLog.push(await ask(f.bridge, ctx, 'message_task', { task_id: childId, text: 'Start with README' }));
    // The result arrives in the session without polling.
    await until(() => steered.some((prompt) => prompt.startsWith('[子任务结果]')));
    parentLog.push(steered.find((prompt) => prompt.startsWith('[子任务结果]'))!);
    return 'parent done';
  };
  const parent = await start(f, '让 Claude 本机 审查');
  assert.equal((await finish(f.workspace, parent.workflow.id)).status, 'completed');
  assert.match(parentLog[0]!, /仍在处理.*完成后结果会自动发给你/);
  assert.match(parentLog[1]!, /Claude · 本机（task_id: .*）在等你回复：\nWhich file first\?/);
  assert.match(parentLog[2]!, /已回复 Claude · 本机/);
  assert.equal(childGot, '调用方回复：\nStart with README');
  assert.match(
    parentLog[3]!,
    new RegExp(`\\[子任务结果\\] Claude · 本机（task_id: ${childId}）已完成：[\\s\\S]*Reviewed README first`),
  );
});

test('a progress note to the caller does not wait for an answer', async (t) => {
  const f = fixture(t);
  let note = '';
  let received = '';
  f.behavior.claude = async (ctx) => {
    note = await ask(f.bridge, ctx, 'message_parent', { text: 'Half done', expect_reply: false });
    return 'done';
  };
  f.behavior.codex = async (ctx, steered) => {
    if (!ctx.agentBridge) return 'no bridge';
    await ask(f.bridge, ctx, 'delegate', { agent: 'claude', task: 'Review', wait_seconds: 0 });
    await until(() => steered.some((prompt) => prompt.includes('Half done')));
    received = steered.find((prompt) => prompt.includes('Half done'))!;
    return 'parent done';
  };
  const parent = await start(f, '让 Claude 本机 审查');
  assert.equal((await finish(f.workspace, parent.workflow.id)).status, 'completed');
  assert.match(note, /已发给调用方/);
  assert.match(received, /\[子任务 Claude · 本机.*的消息\]\nHalf done/);
});

test('a Claude caller is never interrupted: news rides along with its next tool result', async (t) => {
  const f = fixture(t);
  let pushed: string[] = [];
  let later = '';
  let finalResult = '';
  let asking = false;
  f.behavior.codex = async (ctx) => {
    asking = true;
    const answer = await ask(f.bridge, ctx, 'message_parent', { text: 'Which file first?' });
    return `Reviewed after: ${answer}`;
  };
  f.behavior.claude = async (ctx, steered) => {
    if (!ctx.agentBridge) return 'no bridge';
    assert.match(ctx.input.prompt, /之后用 get_result 取结果/);
    const id = taskIds(await ask(f.bridge, ctx, 'delegate', { agent: 'Codex B', task: 'Review', wait_seconds: 0 }))[0]!;
    // Doing other work: the question must not be pushed into this session.
    await until(() => asking);
    await new Promise((resolveWait) => setTimeout(resolveWait, 300));
    pushed = [...steered];
    later = await ask(f.bridge, ctx, 'list_agents', {});
    await ask(f.bridge, ctx, 'message_task', { task_id: id, text: 'README' });
    finalResult = await ask(f.bridge, ctx, 'get_result', { task_id: id, wait_seconds: 30 });
    return 'parent done';
  };
  const project = await f.workspace.createProject(f.directory);
  const conversation = f.workspace.createConversation(project.id);
  const parent = await f.workspace.send(conversation.id, { ...input, content: '让 Codex B 审查', runtimeId: 'claude' });
  assert.equal((await finish(f.workspace, parent.workflow.id)).status, 'completed');
  assert.deepEqual(pushed, []);
  assert.match(later, /——\n\[子任务 Codex B（task_id: .*）在等你回复\]\nWhich file first\?/);
  assert.match(finalResult, /Codex B 已完成[\s\S]*Reviewed after: 调用方回复：\nREADME/);
});

test('a child waiting for an answer is released as soon as its caller ends', async (t) => {
  const f = fixture(t);
  let answer = '';
  let waited = 0;
  f.behavior.claude = async (ctx) => {
    const started = Date.now();
    answer = await ask(f.bridge, ctx, 'message_parent', { text: 'Which file?' });
    waited = Date.now() - started;
    return 'child done';
  };
  f.behavior.codex = async (ctx) => {
    if (!ctx.agentBridge) return 'no bridge';
    await ask(f.bridge, ctx, 'delegate', { agent: 'claude', task: 'Review', wait_seconds: 0 });
    await until(() => f.calls.some((call) => call.target.provider === 'claude'));
    return 'parent finished without answering';
  };
  const parent = await start(f, '让 Claude 本机 审查');
  await finish(f.workspace, parent.workflow.id);
  await until(() => answer !== '');
  assert.match(answer, /暂时没有回复/);
  assert.ok(waited < 10_000);
});

test('a caller without native steering receives child notices through tool responses and is told to poll', async (t) => {
  const f = fixture(t);
  let asking = false,
    reply = '',
    notice = '',
    answer = '',
    finalResult = '';
  f.behavior.claude = async (ctx) => {
    asking = true;
    answer = await ask(f.bridge, ctx, 'message_parent', { text: 'Which source should I verify?' });
    return `Verified ${answer}`;
  };
  f.behavior.codex = async (ctx, steered) => {
    ctx.registerSteer?.(undefined, { state: 'unsupported' });
    reply = await ask(f.bridge, ctx, 'delegate', { agent: 'Claude', task: 'Review', wait_seconds: 0 });
    const id = taskIds(reply)[0]!;
    await until(() => asking);
    await new Promise((done) => setTimeout(done, 100));
    notice = await ask(f.bridge, ctx, 'list_agents', {});
    assert.deepEqual(steered, []);
    await ask(f.bridge, ctx, 'message_task', { task_id: id, text: 'README' });
    finalResult = await ask(f.bridge, ctx, 'get_result', { task_id: id, wait_seconds: 30 });
    return 'merged';
  };
  const project = await f.workspace.createProject(f.directory);
  const conversation = f.workspace.createConversation(project.id);
  const parent = await f.workspace.send(conversation.id, {
    ...input,
    content: '让 Claude 本机 审查',
    runtimeId: 'codex',
  });
  const result = await finish(f.workspace, parent.workflow.id);
  assert.equal(result.status, 'completed', result.error ?? 'workflow should complete');
  assert.match(reply, /稍后用 get_result/);
  assert.doesNotMatch(reply, /完成后结果会自动发给你/);
  assert.match(notice, /Which source should I verify/);
  assert.equal(answer, '调用方回复：\nREADME');
  assert.match(finalResult, /已完成[\s\S]*Verified/);
});

test('a caller can cancel a running sub-task and sees its progress', async (t) => {
  const f = fixture(t);
  let progress = '';
  let cancelled = '';
  f.behavior.claude = async (ctx) => {
    ctx.emit({ at: new Date().toISOString(), type: 'text', text: 'Scanning files…' });
    await new Promise((_resolve, reject) =>
      ctx.signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true }),
    );
    return 'never';
  };
  f.behavior.codex = async (ctx) => {
    if (!ctx.agentBridge) return 'no bridge';
    const id = taskIds(
      await ask(f.bridge, ctx, 'delegate', { agent: 'claude', task: 'Long review', wait_seconds: 0 }),
    )[0]!;
    await until(() => f.calls.some((call) => call.target.provider === 'claude'));
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    progress = await ask(f.bridge, ctx, 'get_result', { task_id: id, wait_seconds: 0 });
    cancelled = await ask(f.bridge, ctx, 'cancel_task', { task_id: id });
    await until(() => f.workspace.store.get<Workflow>('workflow', id)?.status === 'cancelled');
    return 'parent done';
  };
  const parent = await start(f, '让 Claude 本机 审查');
  assert.equal((await finish(f.workspace, parent.workflow.id)).status, 'completed');
  assert.match(progress, /仍在处理[\s\S]*最近输出：\nScanning files…/);
  assert.match(cancelled, /已取消 Claude · 本机/);
});

test('a sub-task requested from a side chat keeps the executor it names', async (t) => {
  const f = fixture(t);
  const project = await f.workspace.createProject(f.directory);
  const main = f.workspace.createConversation(project.id);
  const side = new ConversationActions(f.workspace).sideChat(main.id, {
    requestId: randomUUID(),
    selection: { runtimeId: 'codex', executionPolicy: 'cli-only' },
  });
  let reply = '';
  f.behavior.codex = async (ctx) => {
    if (!ctx.agentBridge) return 'no bridge';
    reply = await ask(f.bridge, ctx, 'delegate', { agent: 'Grok · 本机', task: 'Check', wait_seconds: 30 });
    return 'side answer';
  };
  const asked = await f.workspace.send(side.id, { ...input, content: '让 Grok 本机 检查' });
  assert.equal((await finish(f.workspace, asked.workflow.id)).status, 'completed');
  assert.match(reply, /Grok · 本机 已完成/);
  assert.ok(f.calls.some((ctx) => ctx.target.id === 'grok'));
});

for (const limit of [1, 2]) {
  test(`${limit} parents at a concurrency limit of ${limit} can await their delegated children`, async (t) => {
    const f = fixture(t);
    f.controller.settings.maxConcurrentRuns = limit;
    let entered = 0;
    const replies: string[] = [];
    f.behavior.codex = async (ctx) => {
      if (!ctx.agentBridge) return 'no bridge';
      entered++;
      await until(() => entered === limit);
      replies.push(await ask(f.bridge, ctx, 'delegate', { agent: 'claude', task: 'Review', wait_seconds: 30 }));
      return 'integrated';
    };
    const project = await f.workspace.createProject(f.directory);
    const parents = await Promise.all(
      Array.from({ length: limit }, async () => {
        const conversation = f.workspace.createConversation(project.id);
        return f.workspace.send(conversation.id, { ...input, runtimeId: 'codex', permissionMode: 'read-only' });
      }),
    );
    const finished = await Promise.all(parents.map((parent) => finish(f.workspace, parent.workflow.id)));
    assert.ok(finished.every((workflow) => workflow.status === 'completed'));
    assert.equal(replies.length, limit);
    assert.ok(replies.every((reply) => /Claude · 本机 已完成/.test(reply)));
  });
}

test('a child can ask its waiting parent and then continue with only one logical execution slot', async (t) => {
  const f = fixture(t);
  f.controller.settings.maxConcurrentRuns = 1;
  let received = '',
    result = '';
  f.behavior.claude = async (ctx) => {
    received = await ask(f.bridge, ctx, 'message_parent', { text: 'Which file?' });
    return 'checked README';
  };
  f.behavior.codex = async (ctx) => {
    if (!ctx.agentBridge) return 'no bridge';
    const delegated = await ask(f.bridge, ctx, 'delegate', { agent: 'claude', task: 'Review', wait_seconds: 30 });
    assert.match(delegated, /在等你回复/);
    const id = taskIds(delegated)[0]!;
    await ask(f.bridge, ctx, 'message_task', { task_id: id, text: 'README' });
    result = await ask(f.bridge, ctx, 'get_result', { task_id: id, wait_seconds: 30 });
    return 'integrated';
  };
  const parent = await start(f);
  assert.equal((await finish(f.workspace, parent.workflow.id)).status, 'completed');
  assert.equal(received, '调用方回复：\nREADME');
  assert.match(result, /已完成[\s\S]*checked README/);
});

test('a writing child and parent hand off the sole execution slot for a question and answer', async (t) => {
  const f = fixture(t);
  const origin = { mode: 'workspace-write' as const, source: 'caller' as const, unrestricted: false, note: 'Codex' };
  f.controller.settings.maxConcurrentRuns = 1;
  const file = join(f.directory, 'README.md');
  const timeline: string[] = [];
  let received = '',
    result = '',
    childContinued = false;
  f.behavior.claude = async (ctx) => {
    assert.equal(ctx.input.permissionMode, 'workspace-write');
    assert.deepEqual(ctx.input.permissionOrigin, origin);
    timeline.push('child starts');
    writeFileSync(file, 'child started\n');
    received = await ask(f.bridge, ctx, 'message_parent', { text: 'Which detail should I add?' });
    childContinued = true;
    timeline.push('child continues');
    writeFileSync(file, `${readFileSync(file, 'utf8')}child finished\n`);
    ctx.emit({
      at: new Date().toISOString(),
      type: 'tool',
      text: 'Synthetic write receipt',
      data: {
        toolCallId: 'child-write',
        nativeTool: 'Write',
        status: 'completed',
        input: { file_path: file },
      },
    });
    return 'updated README';
  };
  f.behavior.codex = async (ctx) => {
    if (!ctx.agentBridge) return 'no bridge';
    timeline.push('parent starts');
    const delegated = await ask(f.bridge, ctx, 'delegate', {
      agent: 'claude',
      task: 'Update README after checking the detail',
      write: true,
      files: ['README.md'],
      wait_seconds: 30,
    });
    assert.match(delegated, /在等你回复/);
    const id = taskIds(delegated)[0]!;
    timeline.push('parent answers');
    writeFileSync(file, `${readFileSync(file, 'utf8')}parent clarified\n`);
    await ask(f.bridge, ctx, 'message_task', { task_id: id, text: 'Add the setup command' });
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    assert.equal(childContinued, false, 'answering the child does not release the parent writer slot');
    result = await ask(f.bridge, ctx, 'get_result', { task_id: id, wait_seconds: 30 });
    timeline.push('parent completes');
    return 'integrated';
  };
  const parent = await start(f);
  parent.workflow.input.permissionOrigin = origin;
  f.workspace.store.save('workflow', parent.workflow.id, parent.workflow.conversationId, parent.workflow);
  assert.equal((await finish(f.workspace, parent.workflow.id)).status, 'completed');
  assert.equal(received, '调用方回复：\nAdd the setup command');
  assert.match(result, /已完成[\s\S]*updated README/);
  assert.deepEqual(timeline, [
    'parent starts',
    'child starts',
    'parent answers',
    'child continues',
    'parent completes',
  ]);
  assert.equal(readFileSync(file, 'utf8'), 'child started\nparent clarified\nchild finished\n');
});

// An approval wait must fail this test instead of leaving it blocked on steer.
test(
  'a result that cannot steer an approval-waiting parent is delivered with its next tool reply',
  { timeout: 30_000 },
  async (t) => {
    const f = fixture(t);
    f.controller.settings.toolApprovalMode = 'ask';
    let later = '';
    let attempted = false;
    t.mock.method(f.controller, 'steer', async () => {
      attempted = true;
      return false;
    });
    f.behavior.claude = async () => {
      await until(() => f.controller.approvals.size > 0);
      return 'review done';
    };
    f.behavior.codex = async (ctx) => {
      if (!ctx.agentBridge) return 'no bridge';
      await ask(f.bridge, ctx, 'delegate', { agent: 'claude', task: 'Review', wait_seconds: 0 });
      assert.equal(await ctx.approve('Write', 'Mock approval'), true);
      later = await ask(f.bridge, ctx, 'list_agents', {});
      return 'integrated';
    };
    const parent = await start(f);
    const finished = finish(f.workspace, parent.workflow.id);
    await until(() => attempted && f.controller.approvals.size > 0);
    f.controller.answerApproval([...f.controller.approvals.keys()][0]!, true);
    assert.equal((await finished).status, 'completed');
    assert.match(later, /\[子任务结果\] Claude · 本机[\s\S]*已完成/);
    assert.deepEqual(f.workspace.takeNotices(parent.workflow.id), []);
  },
);
