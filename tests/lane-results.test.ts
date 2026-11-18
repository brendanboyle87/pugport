import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { ConversationAutomation, type ConversationMail } from '../src/server/conversation-automation.ts';
import { callConversationWork } from '../src/server/conversation-work-tools.ts';
import { saveMemberResult } from '../src/server/member-results.ts';
import { readLaneEvents } from '../src/server/lane-events.ts';
import { Workspace } from '../src/server/workspace.ts';
import { WorkspaceStore } from '../src/server/workspace-store.ts';
import { conversationActivity } from '../src/ui/queue-utils.ts';
import type { Conversation, MessageInput, Project, Workflow } from '../src/shared/types.ts';

function fixture(t: TestContext) {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'pugport-lane-results-')));
  const db = new DatabaseSync(':memory:');
  const store = new WorkspaceStore(db, { recoverInterrupted: false });
  const at = '2026-10-27T12:00:00.000Z';
  const project = { id: randomUUID(), path: directory, createdAt: at, updatedAt: at } as Project;
  store.save('project', project.id, project.id, project);
  const parent = {
    id: randomUUID(),
    projectId: project.id,
    title: 'Coordinator',
    createdAt: at,
    updatedAt: at,
  } as Conversation;
  const lane = {
    ...parent,
    id: randomUUID(),
    title: 'Worker',
    lane: { parentConversationId: parent.id, branch: 'synthetic/lane' },
  } as Conversation;
  for (const c of [parent, lane]) store.save('conversation', c.id, project.id, c);
  const root = {
    id: randomUUID(),
    conversationId: parent.id,
    projectId: project.id,
    status: 'running',
    input: { content: 'Synthetic', mode: 'auto', permissionMode: 'read-only' },
    runIds: [],
    createdAt: at,
    updatedAt: at,
  } as unknown as Workflow;
  store.save('workflow', root.id, parent.id, root);
  const active = new Map([[root.id, 'coordinator-run']]);
  const steers: Array<{ text: string; sender: { source?: string } }> = [];
  const notices: string[] = [];
  const requests: MessageInput[] = [];
  let interrupt = false;
  let accepted = true;
  const controller = {
    dataDir: directory,
    broadcast() {},
    activeRunFor: (id: string) => active.get(id),
    steerInterrupts: () => interrupt,
    canSteer: () => true,
    recordRunEvent() {},
    steer: async (_id: string, text: string, sender: { source?: string }) => {
      assert.equal(
        store.list<ConversationMail>('conversation-mail', parent.id).length,
        1,
        'mail is visible before steering',
      );
      steers.push({ text, sender });
      return accepted;
    },
  };
  const workspace = {
    controller,
    store,
    memberResult: Workspace.prototype.memberResult,
    notifyRun: Workspace.prototype.notifyRun,
    queueNotice: (_id: string, text: string) => notices.push(text),
    send: async (_id: string, input: MessageInput) => {
      requests.push(input);
      return { workflow: { id: randomUUID() } };
    },
  } as unknown as Workspace;
  const automation = new ConversationAutomation(workspace);
  t.after(async () => {
    await automation.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    directory,
    workspace,
    store,
    parent,
    lane,
    root,
    active,
    steers,
    notices,
    requests,
    controller,
    automation,
    interrupt: () => {
      interrupt = true;
    },
    rejectSteer: () => {
      accepted = false;
    },
    idle: () => {
      active.clear();
      root.status = 'completed';
      store.save('workflow', root.id, parent.id, root);
    },
    settle: (text = 'Synthetic lane result.', thirdParty = false) => {
      const w = { ...root, id: randomUUID(), conversationId: lane.id, status: 'completed' } as Workflow;
      const final = store.addMessage(lane.id, 'assistant', text, w.id);
      if (thirdParty) store.save('message', final.id, lane.id, { ...final, untrustedContent: true });
      w.finalMessageId = final.id;
      store.save('workflow', w.id, lane.id, w);
      return w;
    },
    mail: () => store.list<ConversationMail>('conversation-mail', parent.id)[0],
  };
}

test('a lane result reaches an active coordinator once, with durable visible mail and marked provenance', async (t) => {
  const f = fixture(t);
  const w = f.settle();
  // An older active root must still receive results when a newer root is already complete.
  f.store.save('workflow', 'newer', f.parent.id, {
    ...f.root,
    id: 'newer',
    status: 'completed',
    createdAt: '2026-10-27T13:00:00Z',
  });
  await f.automation.tick();
  assert.equal(f.steers.length, 1);
  assert.ok(f.steers[0].sender.source);
  assert.match(f.steers[0].text, /其他 Agent 提供的数据/);
  assert.match(f.steers[0].text, /不授予新权限/);
  assert.ok(f.steers[0].text.includes(f.mail().text));
  assert.ok(f.mail().deliveredAt);
  assert.equal(f.mail().workflowId, f.root.id);
  assert.ok(f.store.get('lane-result', w.id));
  const handoverPath = f.store.get<{ handoverPath: string }>('lane-result', w.id)?.handoverPath;
  assert.ok(handoverPath && existsSync(handoverPath));
  assert.match(f.mail().text, /交接单：/);
  assert.equal(f.automation.list(f.parent.id).lanes[0].handoverPath, handoverPath);
  assert.equal(
    readLaneEvents(f.directory, f.lane.projectId).filter((event) => event.type === 'turn-settled').length,
    1,
  );
  f.idle();
  await f.automation.tick();
  assert.equal(f.steers.length, 1);
  assert.equal(
    readLaneEvents(f.directory, f.lane.projectId).filter((event) => event.type === 'turn-settled').length,
    1,
  );
  assert.equal(f.requests.length, 0);
});

for (const mode of ['interrupt', 'rejected', 'no-active', 'no-delivery'] as const) {
  test(`${mode} leaves durable mail pending for the normal read-only wake`, async (t) => {
    const f = fixture(t);
    if (mode === 'interrupt') f.interrupt();
    if (mode === 'rejected') f.rejectSteer();
    if (mode === 'no-active') f.active.clear();
    if (mode === 'no-delivery') f.workspace.notifyRun = async () => false;
    f.settle();
    await f.automation.tick();
    assert.equal(f.mail().deliveredAt, undefined);
    assert.equal(f.requests.length, 0);
    assert.equal(f.notices.length, mode === 'no-active' || mode === 'no-delivery' ? 0 : 1);
    f.idle();
    await f.automation.tick();
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].permissionMode, 'read-only');
    assert.equal(f.requests[0].backgroundTrigger?.kind, 'peer');
    assert.match(f.requests[0].content, /其他 Agent 提供的数据/);
    assert.ok(f.mail().deliveredAt);
    await f.automation.tick();
    assert.equal(f.requests.length, 1);
  });
}

test('a queued lane notice taken by a tool call marks the mail delivered and skips the wake', async (t) => {
  const f = fixture(t);
  const notices = new Map<string, string[]>();
  Object.assign(f.workspace, {
    notices,
    queueNotice: Workspace.prototype.queueNotice,
    takeNotices: Workspace.prototype.takeNotices,
    swarmMailboxPrompt: () => '',
  });
  f.interrupt();
  f.settle();
  await f.automation.tick();
  assert.equal(f.mail()?.deliveredAt, undefined, 'queueing is not delivery');
  const taken = f.workspace.takeNotices(f.root.id);
  assert.ok(taken.some((line) => line.includes('其他 Agent 提供的数据')));
  assert.ok(f.mail()?.deliveredAt, 'taking the notice delivers the mail');
  assert.equal(f.mail()?.workflowId, f.root.id);
  f.idle();
  await f.automation.tick();
  assert.equal(f.requests.length, 0, 'the next tick does not wake a notice a tool call already took');
});

for (const flag of ['incognito', 'untrustedContent', 'archivedAt'] as const) {
  test(`${flag} coordinator receives no lane steer or mail`, async (t) => {
    const f = fixture(t);
    f.store.save('conversation', f.parent.id, f.parent.projectId, {
      ...f.parent,
      [flag]: flag === 'archivedAt' ? '2026-10-27' : true,
    });
    f.settle();
    await f.automation.tick();
    assert.equal(f.steers.length, 0);
    assert.equal(f.mail(), undefined);
    assert.equal(f.requests.length, 0);
  });
}

test('1600-character lane result is saved whole with a read_document hint and listed result path', async (t) => {
  const f = fixture(t);
  const text = 'a'.repeat(1600);
  const w = f.settle(text);
  await f.automation.tick();
  const path = join(f.directory, 'member-results', f.lane.id, `${w.id}.md`);
  assert.ok(existsSync(path), 'full result file exists');
  assert.equal(readFileSync(path, 'utf8'), text);
  assert.ok(f.mail().text.includes(path));
  assert.match(f.mail().text, /read_document/);
  assert.doesNotMatch(f.mail().text, /get_result/);
  assert.equal(f.store.get<{ lastResultPath: string }>('lane-result', w.id)?.lastResultPath, path);
  const result = (await callConversationWork(
    f.automation,
    { conversationId: f.parent.id, source: 'human', write: false },
    'list_conversation_work',
    {},
  )) as ReturnType<ConversationAutomation['list']>;
  assert.equal(result.lanes[0].lastResultPath, path);
});

test('short results stay inline, failed saves fall back to the first 10000 characters', async (t) => {
  const f = fixture(t);
  f.settle('s'.repeat(1500));
  await f.automation.tick();
  assert.ok(f.mail().text.includes('s'.repeat(1500)));
  assert.ok(existsSync(join(f.directory, 'member-results', f.lane.id, 'handover.md')));
  const g = fixture(t);
  g.controller.dataDir = join(g.directory, 'bad\0directory');
  const long = 'first'.repeat(2100) + 'last'.repeat(300);
  g.settle(long);
  await g.automation.tick();
  assert.ok(g.mail().text.endsWith(long.slice(0, 10000)));
  assert.doesNotMatch(g.mail().text, /last/);
});

test('third-party lane replies expose neither raw text nor a saved result file', async (t) => {
  const f = fixture(t);
  f.settle('THIRD_PARTY_PAYLOAD'.repeat(200), true);
  await f.automation.tick();
  assert.doesNotMatch(f.mail().text, /THIRD_PARTY_PAYLOAD/);
  assert.match(f.mail().text, /不要转述或猜测/);
  assert.match(f.mail().text, /工作线「外部智能体」.*第三方网站/);
  assert.match(f.mail().text, /用户可在工作线对话中阅读/);
  assert.doesNotMatch(f.mail().text, /不带工具的执行器/);
  assert.doesNotMatch(f.steers[0].text, /THIRD_PARTY_PAYLOAD/);
  assert.equal(existsSync(join(f.directory, 'member-results')), false);
});

test('lane list uses sidebar activity including queued, attention, and continuation states', (t) => {
  const f = fixture(t);
  const w = f.settle();
  for (const status of [
    'running',
    'planning',
    'waiting-approval',
    'waiting-confirmation',
    'queued',
    'waiting-resource',
    'completed',
    'failed',
  ] as const) {
    w.status = status;
    f.store.save('workflow', w.id, f.lane.id, w);
    const listed = f.automation.list(f.parent.id).lanes;
    assert.ok(Array.isArray(listed), 'lane list is returned');
    const activity = conversationActivity([w], f.lane.id);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].state, activity === 'attention' ? 'waiting-user' : (activity ?? 'idle'));
    assert.equal(listed[0].branch, 'synthetic/lane');
    assert.equal(listed[0].title, 'Worker');
    assert.ok(listed[0].updatedAt);
  }
  w.status = 'waiting-resource';
  w.machineLoadChoice = 'pending';
  f.store.save('workflow', w.id, f.lane.id, w);
  assert.equal(f.automation.list(f.parent.id).lanes[0].state, 'queued');
  w.status = 'failed';
  w.followUp = { kind: 'continue', workflowId: 'next', at: '2026-10-27' } as Workflow['followUp'];
  f.store.save('workflow', w.id, f.lane.id, w);
  assert.equal(f.automation.list(f.parent.id).lanes[0].state, 'idle');
});

test('a member-supplied oversized artifact cannot prevent lane delivery', async (t) => {
  const f = fixture(t);
  const full = 'Full result: /' + 'a'.repeat(13000);
  const w = f.settle(full);
  await f.automation.tick();
  assert.ok(f.mail(), 'oversized member artifact does not reject durable mail');
  assert.equal(f.steers.length, 1);
  assert.ok(f.mail().text.length < 12000);
  assert.equal(readFileSync(join(f.directory, 'member-results', f.lane.id, w.id + '.md'), 'utf8'), full);
});

test('the latest saved path survives more than 200 later short results', (t) => {
  const f = fixture(t);
  f.store.save('lane-result', 'old-file', f.lane.id, { at: '2026-10-25', lastResultPath: 'old.md' });
  f.store.save('lane-result', 'new-file', f.lane.id, { at: '2026-10-26', lastResultPath: 'new.md' });
  for (let i = 0; i < 201; i++) f.store.save('lane-result', 'short-' + i, f.lane.id, { at: '2026-10-27' });
  assert.equal(f.automation.list(f.parent.id).lanes[0].lastResultPath, 'new.md');
});

test('saving a new result with the same byte length refreshes the full text', (t) => {
  const f = fixture(t);
  const path = saveMemberResult(f.directory, f.lane.id, 'same-length', 'a'.repeat(1600));
  assert.ok(path);
  assert.equal(saveMemberResult(f.directory, f.lane.id, 'same-length', 'b'.repeat(1600)), path);
  assert.equal(readFileSync(path, 'utf8'), 'b'.repeat(1600));
});

for (const relay of [true, false]) {
  test(`a settled lane's ${relay ? 'relayed' : 'owner'} question is delivered with the right audience`, async (t) => {
    const f = fixture(t);
    const w = f.settle('LANE_RESULT');
    w.userQuestion = {
      text: 'Synthetic choice?',
      options: ['Alpha', 'Beta'],
      askedAt: w.createdAt,
      ...(relay ? { relay: { conversationId: f.parent.id, title: f.parent.title } } : {}),
    };
    f.store.save('workflow', w.id, f.lane.id, w);
    f.store.save('conversation', f.lane.id, f.lane.projectId, {
      ...f.lane,
      lane: { ...f.lane.lane, sourceWorkflowId: f.root.id, planItem: 'step' },
    });
    const finished: unknown[][] = [];
    f.workspace.finishPlanItem = (...args) => {
      finished.push(args);
    };
    await f.automation.tick();
    const text = f.mail().text;
    if (relay) {
      for (const part of [
        '在等你回答',
        'Synthetic choice?',
        'Alpha / Beta',
        'answer_lane_question',
        'question_id: ' + w.id,
        'lane_id: ' + f.lane.id,
      ]) {
        assert.ok(text.includes(part), part);
        assert.ok(text.indexOf(part) < text.indexOf('LANE_RESULT'), part);
      }
      assert.equal(finished.length, 0);
      assert.match(f.steers[0].text, /其他 Agent 提供的数据/);
    } else {
      assert.match(text, /已交付答复/);
      assert.doesNotMatch(text, /answer_lane_question/);
      assert.equal(finished.length, 1);
    }
  });
}

function questionFixture(t: TestContext, write = false, askerWrite = true) {
  const f = fixture(t);
  const w = f.settle('Waiting for a synthetic choice.');
  w.input = { ...w.input, permissionMode: askerWrite ? 'workspace-write' : 'read-only' };
  w.userQuestion = {
    text: 'Synthetic choice?',
    options: ['Alpha', 'Beta'],
    askedAt: w.createdAt,
    relay: { conversationId: f.parent.id, title: f.parent.title },
  };
  f.store.save('workflow', w.id, f.lane.id, w);
  f.root.input = {
    ...f.root.input,
    permissionMode: write ? 'workspace-write' : 'read-only',
    ...(write ? {} : { backgroundTrigger: { kind: 'peer', id: 'wake' } }),
  };
  f.store.save('workflow', f.root.id, f.parent.id, f.root);
  Object.assign(f.workspace, {
    active: new Map(),
    publish: (workflow: Workflow) => f.store.save('workflow', workflow.id, workflow.conversationId, workflow),
    answerUserQuestions: Workspace.prototype.answerUserQuestions,
    send: async (
      conversationId: string,
      input: MessageInput,
      _parent: unknown,
      _delegation: unknown,
      options: { userMessage?: { content: string; resumed?: true } },
    ) => {
      f.requests.push(input);
      const taskId = randomUUID();
      const message = f.store.addMessage(conversationId, 'user', options.userMessage?.content ?? input.content, taskId);
      if (options.userMessage?.resumed) message.resumed = true;
      message.clientMessageId = input.clientMessageId;
      f.store.save('message', message.id, conversationId, message);
      const workflow = {
        ...w,
        id: taskId,
        userMessageId: message.id,
        input,
        userQuestion: undefined,
        finalMessageId: undefined,
        status: 'queued',
        createdAt: message.createdAt,
      } as Workflow;
      f.store.save('workflow', taskId, conversationId, workflow);
      return { message, workflow };
    },
  });
  const actor = { conversationId: f.parent.id, workflowId: f.root.id, source: 'agent' as const, write };
  const args = { lane_id: f.lane.id, question_id: w.id, answer: 'Alpha' };
  const answer = (overrides = {}) =>
    callConversationWork(f.automation, actor, 'answer_lane_question', { ...args, ...overrides });
  return { ...f, w, actor, args, answer };
}

for (const [write, askerWrite] of [
  [false, true],
  [true, true],
  [true, false],
]) {
  test(`a lane answer continues once with coordinator write=${write}, asker write=${askerWrite}`, async (t) => {
    const f = questionFixture(t, write, askerWrite);
    const result = (await f.answer()) as { ok: boolean; laneId: string; taskId: string };
    assert.equal(result.ok, true);
    assert.equal(result.laneId, f.lane.id);
    assert.equal(f.requests.length, 1);
    const input = f.requests[0];
    assert.deepEqual(input.backgroundTrigger, { kind: 'lane-answer', id: f.w.id });
    assert.equal(input.permissionMode, write && askerWrite ? 'workspace-write' : 'read-only');
    assert.equal(input.clientMessageId, 'lane-answer:' + f.w.id);
    assert.match(input.content, /Synthetic choice\?/);
    assert.match(input.content, /回答：Alpha/);
    assert.match(input.content, /不授予新的权限/);
    const continued = f.store.get<Workflow>('workflow', result.taskId)!;
    const display = f.store.allMessages(f.lane.id).find((message) => message.id === continued.userMessageId)!;
    assert.equal(display.resumed, true);
    assert.equal(display.content, '');
    assert.equal(f.store.get<Workflow>('workflow', f.w.id)!.userQuestion!.answeredMessageId, continued.userMessageId);
    for (const name of ['create_lane', 'schedule_work']) {
      await assert.rejects(
        callConversationWork(
          f.automation,
          {
            conversationId: f.lane.id,
            workflowId: continued.id,
            source: 'agent',
            write: write && askerWrite,
          },
          name,
          {},
        ),
        /后台唤醒不能/,
      );
    }
    assert.deepEqual(await f.answer(), result);
    await assert.rejects(f.answer({ answer: 'Beta' }), /这个问题已经回答过了/);
    assert.equal(f.requests.length, 1);
  });
}

for (const refusal of [
  'external',
  'delegation',
  'other-lane',
  'archived',
  'closed',
  'new-root',
  'owner-question',
  'answered',
]) {
  test(`lane answers refuse ${refusal}`, async (t) => {
    const f = questionFixture(t);
    if (refusal === 'external') f.root.input.permissionOrigin = { source: 'external', mode: 'read-only' };
    if (refusal === 'delegation') f.root.delegation = { parentId: 'parent-task', role: 'worker', requestId: 'child' };
    f.store.save('workflow', f.root.id, f.parent.id, f.root);
    if (refusal === 'other-lane')
      f.store.save('conversation', f.lane.id, f.lane.projectId, {
        ...f.lane,
        lane: { ...f.lane.lane, parentConversationId: 'other' },
      });
    if (refusal === 'archived' || refusal === 'closed')
      f.store.save('conversation', f.lane.id, f.lane.projectId, {
        ...f.lane,
        [refusal === 'archived' ? 'archivedAt' : 'closedAt']: '2026-10-28T00:00:00Z',
      });
    if (refusal === 'new-root')
      f.store.save('workflow', 'new-root', f.lane.id, {
        ...f.w,
        id: 'new-root',
        createdAt: '2099-01-01T00:00:00Z',
      });
    if (refusal === 'owner-question') delete f.w.userQuestion!.relay;
    if (refusal === 'answered') f.w.userQuestion!.answeredMessageId = 'owner-answer';
    f.store.save('workflow', f.w.id, f.lane.id, f.w);
    const error =
      refusal === 'external'
        ? /外部派来的任务不能回答工作线的问题/
        : refusal === 'delegation'
          ? /子任务不能回答工作线的问题/
          : refusal === 'other-lane'
            ? /这不是本对话的工作线/
            : refusal === 'archived' || refusal === 'closed'
              ? /已经归档或关闭/
              : refusal.startsWith('new-')
                ? /工作线已经开始了新的一轮/
                : /这个问题已经回答过了/;
    await assert.rejects(f.answer(), error);
    assert.equal(f.requests.length, 0);
  });
}

test('a coordinator retry after a failed send never answers over the owner', async (t) => {
  const f = questionFixture(t);
  const send = f.workspace.send;
  // The first send stores its message, then fails before its turn exists.
  f.workspace.send = async (conversationId: string, input: MessageInput) => {
    const message = f.store.addMessage(conversationId, 'user', input.content);
    message.clientMessageId = input.clientMessageId;
    f.store.save('message', message.id, conversationId, message);
    throw new Error('Synthetic send failure');
  };
  await assert.rejects(f.answer(), /Synthetic send failure/);
  f.workspace.send = send;
  const owner = f.store.addMessage(f.lane.id, 'user', 'Beta');
  f.workspace.answerUserQuestions(f.lane.id, owner.id);
  await assert.rejects(f.answer(), /这个问题已经回答过了/);
  assert.equal(f.requests.length, 0);
});

test('lane answer arguments are strict and bounded', async (t) => {
  const f = questionFixture(t);
  for (const args of [{ answer: '' }, { answer: 'x'.repeat(2001) }, { extra: true }, { lane_id: 3 }]) {
    await assert.rejects(f.answer(args));
  }
  assert.equal(f.requests.length, 0);
});

test('a failed lane answer dispatch releases its claim', async (t) => {
  const f = questionFixture(t);
  const send = f.workspace.send;
  f.workspace.send = async () => {
    assert.equal(f.store.get<Workflow>('workflow', f.w.id)!.userQuestion!.answeredMessageId, 'lane-answer:' + f.w.id);
    throw new Error('Synthetic dispatch failure');
  };
  await assert.rejects(f.answer(), /Synthetic dispatch failure/);
  assert.equal(f.store.get<Workflow>('workflow', f.w.id)!.userQuestion!.answeredMessageId, undefined);
  f.workspace.send = send;
  await f.answer();
  assert.equal(f.requests.length, 1);
});

for (const idle of [false, true]) {
  test(`a settled lane-answer turn reports back to an ${idle ? 'idle' : 'active'} coordinator`, async (t) => {
    const f = fixture(t);
    if (idle) f.idle();
    const w = f.settle('ANSWER_RESULT');
    w.input = { ...w.input, backgroundTrigger: { kind: 'lane-answer', id: 'question' } };
    f.store.save('workflow', w.id, f.lane.id, w);
    await f.automation.tick();
    assert.match(f.mail()?.text ?? '', /ANSWER_RESULT/);
    assert.equal(f.mail().wake, true);
    assert.equal(idle ? f.requests.length : f.steers.length, 1);
  });
}

for (const ownerFirst of [true, false]) {
  test(`owner and coordinator answers race with ${ownerFirst ? 'owner' : 'coordinator'} first`, async (t) => {
    const f = questionFixture(t);
    Object.assign(f.workspace, {
      sendNow: f.workspace.send,
      send: Workspace.prototype.send,
      pendingMessages: new Map(),
      hindsightMemory: { yieldToForeground() {} },
      hindsightRuntime: { yieldToForeground() {} },
      foregroundSends: 0,
    });
    const owner = () =>
      f.workspace.send(
        f.lane.id,
        { content: 'Beta', mode: 'auto', permissionMode: 'read-only', executionPolicy: 'cli-first' },
        undefined,
        undefined,
        { incomingUserMessage: true },
      );
    const results = await Promise.allSettled(ownerFirst ? [owner(), f.answer()] : [f.answer(), owner()]);
    assert.equal(results[0].status, 'fulfilled', 'the first answer succeeds');
    if (ownerFirst) {
      // The coordinator never answers over the owner.
      assert.equal(results[1].status, 'rejected', 'the racing coordinator answer is refused');
      assert.equal(f.requests.length, 1);
    } else {
      // The owner can always write to the lane; their message simply follows the coordinator's answer.
      assert.equal(results[1].status, 'fulfilled', 'the owner is never refused');
      assert.equal(f.requests.length, 2);
      assert.equal(f.requests[0]!.clientMessageId, 'lane-answer:' + f.w.id);
    }
  });
}
