import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { Controller } from '../src/server/controller.ts';
import { Workspace } from '../src/server/workspace.ts';
import { WorkspaceStore } from '../src/server/workspace-store.ts';
import { AgentBridge } from '../src/server/agent-bridge.ts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConversationHistory } from '../src/ui/Workspace.tsx';
import { QuestionCard } from '../src/ui/QuestionCard.tsx';
import type {
  AppState,
  Conversation,
  ConversationMessage,
  MessageInput,
  Project,
  Workflow,
} from '../src/shared/types.ts';

const at = '2026-10-10T08:00:00.000Z';
function task(id: string, overrides: Partial<Workflow> = {}): Workflow {
  return {
    id,
    projectId: 'project',
    conversationId: 'conversation',
    userMessageId: `message-${id}`,
    input: {
      content: `Synthetic request ${id}`,
      mode: 'build',
      permissionMode: 'workspace-write',
      executionPolicy: 'cli-first',
    },
    status: 'running',
    phase: 'execute',
    runIds: [`run-${id}`],
    plan: [],
    memoryRevision: 0,
    memoryExcerpt: '',
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

/** A bridge over a store-backed workspace; steer calls are captured, nothing runs. */
function fixture(t: TestContext, records: Workflow[]) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const store = new WorkspaceStore(db, { recoverInterrupted: false });
  store.save('project', 'project', '', { id: 'project', path: 'C:/synthetic/rules' });
  store.save('project', 'other-project', '', { id: 'other-project', path: 'C:/synthetic/other' });
  store.save('conversation', 'conversation', 'project', { id: 'conversation', projectId: 'project' });
  for (const workflow of records) store.save('workflow', workflow.id, workflow.conversationId, workflow);
  const active = new Map(
    records
      .filter((workflow) => workflow.status === 'running')
      .map((workflow) => [workflow.id, { abort: new AbortController(), pendingStart: false, workflow }]),
  );
  const steered: Array<{ runId: string; text: string; source?: string }> = [];
  const controller = {
    targets: [
      { id: 'codex-b', provider: 'codex', label: 'Codex B', enabled: true, environment: 'native', command: 'unused' },
    ],
    snapshots: [],
    settings: {},
    activeRunFor: (id: string) => (active.has(id) ? `run-${id}` : undefined),
    steerInterrupts: () => false,
    steer: async (runId: string, text: string, sender: { source?: string }) => {
      steered.push({ runId, text, source: sender.source });
      return true;
    },
    recordRunEvent: () => {},
    broadcast: () => {},
    run: () => undefined,
  };
  const workspace = Object.create(Workspace.prototype) as Workspace;
  Object.assign(workspace, {
    store,
    controller,
    active,
    notices: new Map(),
    memoryExports: { schedule() {} },
    clock: () => Date.parse('2026-10-10T09:00:00Z'),
    requireConversation: (id: string) => store.get('conversation', id),
    requireProject: (id: string) => store.get('project', id),
    wake: () => {},
  });
  const bridge = Object.create(AgentBridge.prototype) as AgentBridge;
  Object.assign(bridge, { workspace, controller, questions: new Map(), awaited: new Map() });
  const caller = {
    run: { id: 'run-root', workflowId: 'root' },
    target: controller.targets[0],
    delegate: true,
    child: false,
    recycle: false,
    write: true,
    signal: new AbortController().signal,
  };
  const internal = bridge as unknown as {
    message(caller: unknown, request: unknown): Promise<any>;
    call(caller: unknown, name: string, args: Record<string, unknown>): Promise<any>;
  };
  const tools = async (who: unknown) =>
    ((await internal.message(who, { id: 1, method: 'tools/list' })).result.tools as { name: string }[]).map(
      (tool) => tool.name,
    );
  let order = 0;
  const say = (content: string, options: { human?: boolean; extra?: Partial<ConversationMessage> } = {}) => {
    const message = {
      id: `said-${++order}`,
      conversationId: 'conversation',
      role: 'user',
      content,
      createdAt: `2026-10-10T08:0${order}:00.000Z`,
      ...options.extra,
    } as ConversationMessage;
    store.save('message', message.id, 'conversation', message);
    if (options.human !== false) store.save('human-message', message.id, 'conversation', { id: message.id });
    return message;
  };
  return { store, workspace, internal, caller, tools, steered, say };
}

const question = { question: '先修登录页还是先补测试？', options: ['先修登录页', '先补测试'] };

for (const human of [false, true]) {
  test(`a lane question routes to ${human ? 'the owner' : 'the coordinator'} based on its user message`, async (t) => {
    const f = fixture(t, [task('root')]);
    f.store.save('conversation', 'parent', 'project', { id: 'parent', projectId: 'project', title: 'Coordinator' });
    f.store.save('conversation', 'conversation', 'project', {
      id: 'conversation',
      projectId: 'project',
      lane: { parentConversationId: 'parent' },
    });
    if (human) f.store.save('human-message', 'message-root', 'conversation', { id: 'message-root' });
    const listed = (await f.internal.message(f.caller, { id: 1, method: 'tools/list' })).result.tools;
    const description = listed.find((tool: { name: string }) => tool.name === 'ask_user').description;
    const reply = await f.internal.call(f.caller, 'ask_user', question);
    const saved = f.store.get<Workflow>('workflow', 'root')!.userQuestion!;
    if (human) {
      assert.match(description, /需要用户做决定/);
      assert.equal(saved.relay, undefined);
      assert.match(reply, /答复下方/);
    } else {
      assert.match(description, /协调对话/);
      assert.deepEqual(saved.relay, { conversationId: 'parent', title: 'Coordinator' });
      assert.match(reply, /协调对话/);
    }
    const background = { ...f.caller, background: true, network: true };
    const backgroundTools = await f.tools(background);
    for (const tool of ['ask_user', 'push_branch', 'open_branch_pull_request', 'merge_branch_pull_request']) {
      assert.ok(!backgroundTools.includes(tool), tool);
    }
    await assert.rejects(f.internal.call(background, 'ask_user', question), /只有在前台运行的主任务/);
  });
}

test('ask_user is offered to a foreground root task, saves the question and returns at once', async (t) => {
  const f = fixture(t, [task('root')]);
  assert.ok((await f.tools(f.caller)).includes('ask_user'));
  assert.ok((await f.tools(f.caller)).includes('add_project_rule'));
  const reply = await f.internal.call(f.caller, 'ask_user', question);
  assert.match(reply, /最终答复/);
  const saved = f.store.get<Workflow>('workflow', 'root')!.userQuestion!;
  assert.equal(saved.text, question.question);
  assert.deepEqual(saved.options, question.options);
  assert.ok(saved.askedAt && !saved.answeredMessageId);
  await assert.rejects(f.internal.call(f.caller, 'ask_user', { question: 'x', options: [] }), /options/);
  await assert.rejects(f.internal.call(f.caller, 'ask_user', { question: 'x', options: ['a', 'b', 'c'] }), /options/);
  await assert.rejects(
    f.internal.call(f.caller, 'ask_user', { question: 'x'.repeat(201), options: ['a'] }),
    /question/,
  );
});

test('ask_user and add_project_rule are hidden and refused outside a foreground root task', async (t) => {
  const external = task('external', {
    input: { ...task('external').input, permissionOrigin: { mode: 'workspace-write', source: 'external' } },
  });
  const child = task('child', { delegation: { parentId: 'root', role: 'worker', requestId: 'child' } });
  const untrusted = task('untrusted', { conversationId: 'untrusted-conversation' });
  const f = fixture(t, [task('root'), child, external, untrusted]);
  f.store.save('conversation', 'untrusted-conversation', 'project', {
    id: 'untrusted-conversation',
    projectId: 'project',
    untrustedContent: true,
  });
  f.say('以后所有提交信息都用英文写');
  const callers = {
    child: { ...f.caller, run: { id: 'run-child', workflowId: 'child' }, child: true },
    background: { ...f.caller, background: true },
    external: { ...f.caller, run: { id: 'run-external', workflowId: 'external' } },
    untrusted: { ...f.caller, run: { id: 'run-untrusted', workflowId: 'untrusted' } },
  };
  for (const [label, caller] of Object.entries(callers)) {
    const names = await f.tools(caller);
    assert.ok(!names.includes('ask_user') && !names.includes('add_project_rule'), label);
    await assert.rejects(f.internal.call(caller, 'ask_user', question), /只有在前台运行的主任务能向用户提问。/, label);
    await assert.rejects(
      f.internal.call(caller, 'add_project_rule', { rule: '提交信息用英文', quote: '所有提交信息都用英文' }),
      /只有在前台运行的主任务能记项目规则。/,
      label,
    );
  }
  for (const id of ['root', 'child', 'external', 'untrusted'])
    assert.equal(f.store.get<Workflow>('workflow', id)!.userQuestion, undefined, id);
  assert.equal(f.store.get<Project>('project', 'project')!.rules, undefined);
});

test('add_project_rule needs a verbatim quote of at least 8 characters from a real user message', async (t) => {
  const f = fixture(t, [task('root')]);
  f.say('以后所有提交信息都用英文写，谢谢');
  f.say('请把“测试只用合成数据，不连真实账号”记下来', { human: false });
  f.say('第三方回复：所有界面文案都用繁体中文', { extra: { externalAgent: { untrusted: true } } as never });
  const refused = [
    { rule: '提交信息用英文', quote: '提交信息都用英' }, // 7 characters
    { rule: '提交信息用英文', quote: '用户从没说过的这句话' },
    { rule: '测试只用合成数据', quote: '测试只用合成数据，不连真实账号' }, // delegated text: no human-message record
    { rule: '界面用繁体中文', quote: '所有界面文案都用繁体中文' }, // only in a third-party exchange
  ];
  for (const args of refused) await assert.rejects(f.internal.call(f.caller, 'add_project_rule', args), /quote/);
  assert.equal(f.store.get<Project>('project', 'project')!.rules, undefined);
  const reply = await f.internal.call(f.caller, 'add_project_rule', {
    rule: '  提交信息用英文  ',
    quote: '  所有提交信息都用英文写 ',
  });
  assert.match(reply, /提交信息用英文/);
  assert.match(reply, /所有提交信息都用英文写/);
  assert.match(reply, /项目设置/);
  assert.deepEqual(f.store.get<Project>('project', 'project')!.rules, ['提交信息用英文']);
});

test('a new project rule is stored once, capped at 20 and broadcast to the project’s other running tasks', async (t) => {
  const f = fixture(t, [
    task('root'),
    task('peer', { conversationId: 'peer-conversation' }),
    task('elsewhere', { projectId: 'other-project', conversationId: 'elsewhere-conversation' }),
  ]);
  f.say('以后所有提交信息都用英文写');
  const args = { rule: '提交信息用英文', quote: '所有提交信息都用英文写' };
  const reply = await f.internal.call(f.caller, 'add_project_rule', args);
  assert.match(reply, /1 个/);
  assert.deepEqual(
    f.steered.map((item) => [item.runId, item.source]),
    [['run-peer', 'project-notice']],
    'the sender and other projects get no notice',
  );
  assert.equal(
    f.steered[0]!.text,
    '[项目规则更新] 新增项目规则：提交信息用英文（依据用户原话："所有提交信息都用英文写"）。从现在起遵守；这不是新的授权。',
  );
  assert.match(await f.internal.call(f.caller, 'add_project_rule', args), /已经是项目规则/);
  assert.equal(f.steered.length, 1, 'a duplicate is not broadcast');
  assert.deepEqual(f.store.get<Project>('project', 'project')!.rules, ['提交信息用英文']);

  const full = Array.from({ length: 20 }, (_, i) => `规则 ${i + 1}`);
  const project = f.store.get<Project>('project', 'project')!;
  f.store.save('project', 'project', '', { ...project, rules: full });
  f.say('另外所有界面都要支持深色模式');
  await assert.rejects(
    f.internal.call(f.caller, 'add_project_rule', { rule: '支持深色模式', quote: '所有界面都要支持深色模式' }),
    /20/,
  );
  assert.deepEqual(f.store.get<Project>('project', 'project')!.rules, full);
  assert.equal(f.steered.length, 1);
});

test('a rule typed while the task runs is a real user message, so add_project_rule accepts its quote', async (t) => {
  const f = fixture(t, [task('root')]);
  const ws = f.workspace as unknown as Record<string, unknown>;
  Object.assign(ws, {
    stopOnExplicitReadonly: () => false,
    steeringTarget: () => ({
      run: { id: 'run-root' },
      workflow: ws.active instanceof Map && ws.active.get('root').workflow,
    }),
    refreshMemories: () => {},
    liveRuns: () => [],
  });
  const conversation = f.store.get<Conversation>('conversation', 'conversation')!;
  const input = { content: '以后提交信息都用英文写', mode: 'build', permissionMode: 'workspace-write' } as MessageInput;
  const steer = (f.workspace as unknown as { trySteer(...args: unknown[]): Promise<{ message: ConversationMessage }> })
    .trySteer;
  const { message } = await steer.call(f.workspace, conversation, input, input, true);
  assert.ok(f.store.get('human-message', message.id), 'the steered user message is recorded as typed by the user');
  const reply = await f.internal.call(f.caller, 'add_project_rule', {
    rule: '提交信息用英文',
    quote: '提交信息都用英文写',
  });
  assert.match(reply, /提交信息用英文/);
  assert.deepEqual(f.store.get<Project>('project', 'project')!.rules, ['提交信息用英文']);
  assert.equal(f.store.get('delegation-human-update', 'root') !== undefined, true, 'delegation sees the human update');
});

async function realFixture(t: TestContext) {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'coordinator-questions-')));
  const memory = realpathSync.native(mkdtempSync(join(tmpdir(), 'coordinator-questions-memory-')));
  const prior = process.env.COMBORUNNER_MEMORY_DIR;
  process.env.COMBORUNNER_MEMORY_DIR = memory;
  const controller = new Controller(directory, join(directory, 'data'));
  clearInterval(controller.timer);
  controller.settings.taskJudgment = 'local';
  const workspace = new Workspace(controller);
  t.mock.method(workspace, 'wake', () => {});
  t.after(async () => {
    await workspace.close();
    await controller.close();
    for (const path of [directory, memory]) {
      const target = resolve(path);
      assert.ok(
        target.startsWith(realpathSync.native(tmpdir()) + sep) && basename(target).startsWith('coordinator-questions-'),
      );
      rmSync(target, { recursive: true, force: true });
    }
    if (prior === undefined) delete process.env.COMBORUNNER_MEMORY_DIR;
    else process.env.COMBORUNNER_MEMORY_DIR = prior;
  });
  const project = await workspace.createProject(directory, 'Fixture');
  const conversation = workspace.createConversation(project.id);
  return { workspace, conversation };
}

const chat: MessageInput = {
  content: 'Synthetic question',
  mode: 'chat',
  permissionMode: 'read-only',
  executionPolicy: 'cli-only',
};

test('the user’s next message answers the question; a scheduled dispatch does not', async (t) => {
  const { workspace, conversation } = await realFixture(t);
  const first = await workspace.send(conversation.id, chat, undefined, undefined, { incomingUserMessage: true });
  const settle = (id: string, status: Workflow['status']) => {
    const saved = workspace.store.get<Workflow>('workflow', id)!;
    workspace.store.save('workflow', id, conversation.id, { ...saved, status });
  };
  settle(first.workflow.id, 'completed');
  workspace.setUserQuestion(first.workflow.id, { text: 'Which one?', options: ['A', 'B'], askedAt: at });
  const question = () => workspace.store.get<Workflow>('workflow', first.workflow.id)!.userQuestion!;

  const scheduled = await workspace.send(conversation.id, { ...chat, content: 'Scheduled synthetic check' });
  settle(scheduled.workflow.id, 'completed');
  assert.equal(question().answeredMessageId, undefined, 'no user message yet');

  const answer = await workspace.send(conversation.id, { ...chat, content: 'A' }, undefined, undefined, {
    incomingUserMessage: true,
  });
  assert.equal(question().answeredMessageId, answer.message.id);

  settle(answer.workflow.id, 'failed');
  workspace.setUserQuestion(answer.workflow.id, { text: 'Retry?', options: ['Yes'], askedAt: at });
  settle(scheduled.workflow.id, 'failed');
  await workspace.continue(scheduled.workflow.id, 'Review fix', {}, { automatic: true });
  assert.equal(
    workspace.store.get<Workflow>('workflow', answer.workflow.id)!.userQuestion!.answeredMessageId,
    undefined,
    'a host-started follow-up is not an answer',
  );
  const continued = await workspace.continue(answer.workflow.id, 'Continue with A');
  assert.equal(
    workspace.store.get<Workflow>('workflow', answer.workflow.id)!.userQuestion!.answeredMessageId,
    continued.message.id,
  );
  assert.equal(question().answeredMessageId, answer.message.id, 'an answered question keeps its answer');
});

test('the question card sits under the final reply, or under the task card when there is no reply, until answered', () => {
  const state = (workflows: Workflow[]) =>
    ({ targets: [], runtimes: [], runs: [], workflows, settings: {} }) as unknown as AppState;
  const userQuestion = { text: '先修登录页还是先补测试？', options: ['先修登录页', '先补测试'], askedAt: at };
  const messages: ConversationMessage[] = [
    {
      id: 'user-root',
      conversationId: 'conversation',
      workflowId: 'root',
      role: 'user',
      content: 'Ask',
      createdAt: at,
    },
    { id: 'reply-root', conversationId: 'conversation', role: 'assistant', content: 'FINAL_REPLY', createdAt: at },
  ];
  const html = (workflow: Workflow, list = messages) =>
    renderToStaticMarkup(
      createElement(ConversationHistory, {
        messages: list,
        workflows: [workflow],
        state: state([workflow]),
        api: async <T>() => ({}) as T,
        notify() {},
        onInspect() {},
        onAnswer() {},
      }),
    );
  const answered = task('root', { status: 'completed', finalMessageId: 'reply-root', userQuestion });
  const shown = html(answered);
  assert.equal((shown.match(/<button[^>]*class="button (primary|secondary)"[^>]*>先/g) ?? []).length, 2);
  assert.match(shown, /class="button primary"[^>]*>先修登录页<\/button>/);
  assert.ok(shown.indexOf('FINAL_REPLY') < shown.indexOf('先修登录页还是先补测试？'), 'under the final reply');
  const failed = html(task('root', { status: 'failed', userQuestion }), messages.slice(0, 1));
  assert.match(failed, /先修登录页还是先补测试？/, 'a task with no reply shows it under its card');
  assert.ok(failed.indexOf('id="workflow-root"') < failed.indexOf('先修登录页还是先补测试？'));
  const gone = html({ ...answered, userQuestion: { ...userQuestion, answeredMessageId: 'user-next' } });
  assert.doesNotMatch(gone, /先修登录页还是先补测试？/);
  const delegated = html({ ...answered, delegation: { parentId: 'other', role: 'worker', requestId: 'x' } });
  assert.doesNotMatch(delegated, /先修登录页还是先补测试？/, 'a sub-task never asks the user');
});

test('a question card button sends its option and is disabled while the composer holds a draft', () => {
  const question = { text: 'Which one?', options: ['A', 'B'], askedAt: at };
  const sent: string[] = [];
  const card = QuestionCard({ question, onAnswer: (text) => sent.push(text) });
  const buttons = card.props.children[1].props.children as { props: { onClick(): void; disabled: boolean } }[];
  buttons[1]!.props.onClick();
  assert.deepEqual(sent, ['B']);
  assert.match(renderToStaticMarkup(createElement(QuestionCard, { question })), /disabled=""[^>]*>A</);
});

test('external-origin callers cannot discover answer_lane_question', async (t) => {
  const f = fixture(t, [task('root')]);
  Object.assign(f.workspace, { conversationAutomation: {} });
  assert.ok((await f.tools(f.caller)).includes('answer_lane_question'));
  const workflow = task('root', {
    input: { ...task('root').input, permissionOrigin: { mode: 'workspace-write', source: 'external' } },
  });
  f.store.save('workflow', workflow.id, workflow.conversationId, workflow);
  assert.ok(!(await f.tools(f.caller)).includes('answer_lane_question'));
});
