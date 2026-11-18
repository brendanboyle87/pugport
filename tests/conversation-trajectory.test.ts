import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { conversationTrajectoryRunId } from '../src/ui/conversation-trajectory.ts';
import type { ConversationMessage, RunRecord, Workflow } from '../src/shared/types.ts';
import { findNode, nextTurn, uiBundle, uiHarness } from './helpers/ui-harness.ts';

const stamp = '2026-10-08T12:00:00Z';
function workflow(id: string, overrides: Partial<Workflow> = {}): Workflow {
  return {
    id,
    conversationId: 'own-chat',
    projectId: 'project',
    userMessageId: 'message',
    input: { content: 'Fixture', mode: 'auto', permissionMode: 'read-only', executionPolicy: 'cli-first' },
    status: 'completed',
    phase: 'summarize',
    plan: [],
    runIds: [id + '-run'],
    memoryRevision: 0,
    memoryExcerpt: '',
    createdAt: stamp,
    updatedAt: stamp,
    ...overrides,
  };
}
function run(id: string, startedAt = stamp): RunRecord {
  return {
    id,
    prompt: 'Fixture',
    projectPath: 'C:/Fixture',
    kind: 'routine',
    status: 'completed',
    route: { runtimeId: 'fixture', model: 'fixture', kind: 'routine', reasons: [], warnings: [] },
    startedAt,
    output: '',
    events: [],
  };
}

test('conversation entry excludes newer foreign, deleted and child tasks, and queued tasks without a run', () => {
  const workflows = [
    workflow('primary'),
    workflow('foreign', { conversationId: 'other-chat' }),
    workflow('deleted', { deletedAt: stamp }),
    workflow('child', { parentWorkflowId: 'primary' }),
    workflow('delegated', { delegation: { parentId: 'primary', role: 'worker', requestId: 'fixture' } }),
    workflow('queued', { status: 'queued', runIds: [] }),
  ];
  const runs = workflows.map((item) => run(item.id + '-run', item.id === 'primary' ? stamp : '2026-10-08T13:00:00Z'));
  assert.equal(conversationTrajectoryRunId('own-chat', workflows, runs), 'primary-run');
  assert.equal(conversationTrajectoryRunId('missing-chat', workflows, runs), undefined);
  assert.equal(conversationTrajectoryRunId(undefined, workflows, runs), undefined);
});

test('entry follows actual latest run time and retains historical IDs absent from bounded state', () => {
  const first = workflow('first', { updatedAt: '2026-10-08T16:00:00Z', runIds: ['old', 'continued'] });
  const second = workflow('second');
  assert.equal(
    conversationTrajectoryRunId(
      'own-chat',
      [first, second],
      [run('old'), run('continued', '2026-10-08T13:00:00Z'), run('second-run')],
    ),
    'continued',
  );
  assert.equal(conversationTrajectoryRunId('own-chat', [first], []), 'continued');
  assert.equal(
    conversationTrajectoryRunId(
      'own-chat',
      [first, second],
      [run('continued', '2026-10-08T13:00:00Z'), run('second-run')],
    ),
    'continued',
  );
  assert.equal(
    conversationTrajectoryRunId('own-chat', [workflow('only-child', { parentWorkflowId: 'primary' })], []),
    'only-child-run',
  );
});

let code: string;
before(async () => {
  code = await uiBundle('src/ui/Workspace.tsx');
});
const conversation = {
  id: 'own-chat',
  projectId: 'project',
  title: 'Fixture conversation',
  createdAt: stamp,
  updatedAt: stamp,
};
const state = {
  app: { name: 'Fixture', version: 'test', platform: 'win32', dataDir: 'fixture' },
  projects: [],
  conversations: [conversation],
  runs: [run('primary-run'), run('foreign-run', '2026-10-08T13:00:00Z')],
  workflows: [workflow('primary'), workflow('foreign', { conversationId: 'other-chat' })],
  conversationMessages: [],
  targets: [],
  runtimes: [],
  approvals: [],
  plugins: [],
  settings: { toolApprovalMode: 'auto', executionPolicy: 'cli-first' },
};
const entry = (tree: unknown) => findNode(tree, (node) => node.props['aria-label'] === '查看当前对话轨迹');

const trace = (tree: unknown) => findNode(tree, (node) => node.type?.name === 'ConversationTrace');

test('trajectory sits in the toolbar actions outside scrolling history and opens the chat trace on its own task', async () => {
  const inspected: string[] = [];
  const harness = uiHarness(code);
  const props = {
    state,
    conversation,
    api: async () => ({ messages: [] }),
    notify() {},
    onConversation() {},
    onAddProject() {},
    onMemory() {},
    onInspect: (id: string) => inspected.push(id),
  };
  let tree = harness.render('ConversationWorkspace', props);
  await nextTurn();
  tree = harness.render('ConversationWorkspace', props);
  const titleLine = findNode(tree, (node) => node.props.className === 'conversation-title-line');
  assert.ok(titleLine);
  assert.equal(entry(titleLine), undefined);
  const toolbar = findNode(tree, (node) => node.props.className === 'toolbar-actions');
  assert.ok(entry(toolbar));
  assert.equal(String(entry(toolbar)?.props.children?.props?.['aria-hidden']), 'true');
  const scroll = findNode(tree, (node) => node.props.className === 'conversation-scroll');
  assert.equal(entry(scroll), undefined);
  assert.equal(scroll?.props.inert, false);
  assert.equal(trace(tree), undefined);
  entry(toolbar)!.props.onClick();
  tree = harness.render('ConversationWorkspace', props);
  assert.equal(trace(tree)?.props.initialRunId, 'primary-run');
  assert.equal(entry(tree)?.props['aria-pressed'], true);
  assert.equal(findNode(tree, (node) => node.props.className === 'conversation-scroll')?.props.inert, true);
  // The overlay covers the message list only; the header button closes it again.
  assert.ok(findNode(tree, (node) => node.props.className === 'conversation-scroll-wrap' && Boolean(trace(node))));
  entry(tree)!.props.onClick();
  tree = harness.render('ConversationWorkspace', props);
  assert.equal(trace(tree), undefined);
  assert.equal(findNode(tree, (node) => node.props.className === 'conversation-scroll')?.props.inert, false);
  assert.deepEqual(inspected, []);
  harness.unmount();
});

test('open Trace fills the column: the composer, task dock and stats hide but stay mounted with the draft', async () => {
  const harness = uiHarness(code);
  const props = {
    state,
    conversation,
    api: async () => ({ messages: [] }),
    notify() {},
    onConversation() {},
    onAddProject() {},
    onMemory() {},
    onInspect() {},
  };
  harness.render('ConversationWorkspace', props);
  await nextTurn();
  let tree = harness.render('ConversationWorkspace', props);
  const wrap = (value: unknown) => findNode(value, (node) => node.props.className === 'conversation-composer-wrap');
  const input = (value: unknown) => findNode(value, (node) => node.props.id === 'conversation-input');
  input(tree)!.props.onChange({ target: { value: 'half-written draft', selectionStart: 18 } });
  tree = harness.render('ConversationWorkspace', props);
  assert.equal(wrap(tree)?.props.hidden, false);
  entry(tree)!.props.onClick();
  tree = harness.render('ConversationWorkspace', props);
  assert.ok(trace(tree));
  // Hidden, never unmounted: the dock, stats row and draft are all still inside the hidden wrap.
  assert.equal(wrap(tree)?.props.hidden, true);
  assert.ok(findNode(wrap(tree), (node) => node.type?.name === 'ConversationTaskDock' && node.props.stats));
  assert.equal(input(wrap(tree))?.props.value, 'half-written draft');
  entry(tree)!.props.onClick();
  tree = harness.render('ConversationWorkspace', props);
  assert.equal(trace(tree), undefined);
  assert.equal(wrap(tree)?.props.hidden, false);
  assert.equal(input(tree)?.props.value, 'half-written draft');
  harness.unmount();
});

test('changing chats unmounts Trace before the next chat can request a record', async () => {
  const other = { ...conversation, id: 'other-chat', title: 'Another chat' };
  const harness = uiHarness(code);
  const props = {
    state: { ...state, conversations: [conversation, other] },
    conversation,
    api: async () => ({ messages: [] }),
    notify() {},
    onConversation() {},
    onAddProject() {},
    onMemory() {},
    onInspect() {},
  };
  harness.render('ConversationWorkspace', props);
  await nextTurn();
  let tree = harness.render('ConversationWorkspace', props);
  entry(tree)!.props.onClick();
  tree = harness.render('ConversationWorkspace', props);
  assert.equal(trace(tree)?.props.conversation.id, conversation.id);
  tree = harness.render('ConversationWorkspace', { ...props, conversation: other });
  assert.equal(trace(tree), undefined, 'No new-chat Trace mounts, so its request effect cannot fire');
  assert.equal(entry(tree)?.props['aria-pressed'], false);
  assert.equal(findNode(tree, (node) => node.props.className === 'conversation-scroll')?.props.inert, false);
  tree = harness.render('ConversationWorkspace', props);
  assert.equal(trace(tree), undefined, 'Returning to the old chat does not reopen Trace');
  harness.unmount();
});

test('empty conversation hides the trace entry, and loaded older history reveals it', async () => {
  const harness = uiHarness(code);
  const inspected: string[] = [];
  const props = {
    state: { ...state, runs: [], workflows: [] },
    conversation,
    api: async () => ({ messages: [], workflows: [workflow('historical')] }),
    notify() {},
    onConversation() {},
    onAddProject() {},
    onMemory() {},
    onInspect: (id: string) => inspected.push(id),
  };
  let tree = harness.render('ConversationWorkspace', props);
  assert.equal(entry(tree), undefined);
  assert.deepEqual(inspected, []);
  await nextTurn();
  tree = harness.render('ConversationWorkspace', props);
  assert.ok(entry(tree));
  entry(tree)!.props.onClick();
  tree = harness.render('ConversationWorkspace', props);
  assert.equal(trace(tree)?.props.initialRunId, 'historical-run');
  assert.deepEqual(inspected, []);
  harness.unmount();
});

test('a card opens its own workflow and latest run even when another task is newer', async () => {
  const harness = uiHarness(code);
  const older = workflow('older', { runIds: ['first-attempt', 'older-retry'] });
  const newer = workflow('newer', { createdAt: '2026-10-08T14:00:00Z' });
  const messages = [
    { id: 'message', conversationId: conversation.id, role: 'user', content: 'Synthetic task', createdAt: stamp },
  ];
  const props = {
    state: {
      ...state,
      workflows: [older, newer],
      conversationMessages: messages,
      runs: [run('newer-run', '2026-10-08T14:00:00Z')],
    },
    conversation,
    api: async () => ({ messages }),
    notify() {},
    onConversation() {},
    onAddProject() {},
    onMemory() {},
    onInspect() {},
  };
  harness.render('ConversationWorkspace', props);
  await nextTurn();
  let tree = harness.render('ConversationWorkspace', props);
  findNode(
    tree,
    (node) => typeof node.props.onTrace === 'function' && Array.isArray(node.props.messages),
  )!.props.onTrace(older);
  tree = harness.render('ConversationWorkspace', props);
  assert.equal(trace(tree)?.props.initialWorkflowId, 'older');
  assert.equal(trace(tree)?.props.initialRunId, 'older-retry');
  trace(tree)!.props.onClose();
  tree = harness.render('ConversationWorkspace', props);
  entry(tree)!.props.onClick();
  tree = harness.render('ConversationWorkspace', props);
  assert.equal(trace(tree)?.props.initialWorkflowId, undefined);
  assert.equal(trace(tree)?.props.initialRunId, 'newer-run');
  harness.unmount();
});

test('a queued chat without runs can still open its task trace', () => {
  const harness = uiHarness(code);
  const props = {
    state: { ...state, workflows: [workflow('queued', { status: 'queued', runIds: [] })], runs: [] },
    conversation,
    api: async () => ({ messages: [] }),
    notify() {},
    onConversation() {},
    onAddProject() {},
    onMemory() {},
    onInspect() {},
  };
  entry(harness.render('ConversationWorkspace', props))!.props.onClick();
  assert.ok(trace(harness.render('ConversationWorkspace', props)));
  harness.unmount();
});

test('message history inserts one local-day separator per shown day, including a limited history page', () => {
  const harness = uiHarness(code);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const messages = [yesterday, today, today].map((at, index) => ({
    id: `message-${index}`,
    conversationId: conversation.id,
    role: 'user',
    content: `Synthetic ${index}`,
    createdAt: at.toISOString(),
  }));
  const props = { messages, workflows: [], state, api: async () => ({}), notify() {}, onInspect() {} };
  const separators = (tree: unknown) => {
    const found: string[] = [];
    findNode(tree, (node) => {
      if (node.props.className === 'message-day') found.push(node.props.children);
      return false;
    });
    return found;
  };
  assert.deepEqual(separators(harness.render('ConversationHistory', props)), ['昨天', '今天']);
  assert.deepEqual(separators(harness.render('ConversationHistory', { ...props, limit: 1 })), ['今天']);
  harness.unmount();
});

test('main-chat participant replies keep a localized date and time on the heading tooltip', () => {
  for (const locale of ['en', 'zh-CN']) {
    const harness = uiHarness(code, { localStorage: { getItem: () => locale } });
    const message = {
      id: 'external-reply',
      conversationId: conversation.id,
      role: 'assistant',
      content: 'Synthetic reply',
      createdAt: stamp,
      externalAgent: {
        agentId: 'grok-bot',
        name: 'Synthetic bot',
        status: 'done',
        request: 'Synthetic request',
        updatedAt: stamp,
      },
    };
    const history = harness.render('ConversationHistory', {
      messages: [message],
      workflows: [],
      state,
      api: async () => ({}),
      notify() {},
      onInspect() {},
    });
    const messageNode = findNode(history, (node) => node.props.message?.id === message.id)!;
    harness.remount();
    harness.exports.SyntheticMessage = messageNode.type;
    const rendered = harness.render('SyntheticMessage', messageNode.props);
    const heading = findNode(rendered, (node) => node.props.className === 'message-participant-heading');
    assert.ok(heading);
    assert.equal(
      heading.props.title,
      new Date(stamp).toLocaleString(locale, {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }),
    );
    assert.ok(findNode(heading, (node) => node.type?.name === 'ParticipantHeading'));
    harness.unmount();
  }
});

test('completed chat card visibility preserves replies and follows run claims and limited checks', () => {
  const harness = uiHarness(code);
  const plain = workflow('primary', { input: { ...workflow('primary').input, mode: 'chat' }, finalMessageId: 'reply' });
  const messages = [
    {
      id: 'message',
      conversationId: conversation.id,
      workflowId: plain.id,
      role: 'user',
      content: 'Synthetic question',
      createdAt: stamp,
    },
    {
      id: 'reply',
      conversationId: conversation.id,
      workflowId: plain.id,
      role: 'assistant',
      content: 'Synthetic reply',
      createdAt: stamp,
    },
  ];
  const completedRun = { ...run('primary-run'), workflowId: plain.id };
  const props = {
    messages,
    workflows: [plain],
    state: { ...state, runs: [completedRun] },
    api: async () => ({}),
    notify() {},
    onInspect() {},
  };
  const card = (tree: unknown) => findNode(tree, (node) => node.type?.name === 'WorkflowTrace');
  let tree = harness.render('ConversationHistory', props);
  assert.ok(card(tree), 'completed plain chat keeps its execution record');
  assert.ok(findNode(tree, (node) => node.props.message?.id === 'reply'));
  for (const retained of [
    { ...plain, input: { ...plain.input, mode: 'build' } },
    { ...plain, review: { round: 1, status: 'passed', claims: [] } },
  ]) {
    assert.ok(card(harness.render('ConversationHistory', { ...props, workflows: [retained] })));
  }
  for (const taskOutcome of [
    { status: 'completed', source: 'executor-report', claims: [{ claim: 'Synthetic evidence' }] },
    {
      status: 'completed',
      source: 'file-receipts',
      verificationLimited: true,
      limitedChecks: [{ id: 'check', command: 'synthetic check', reason: 'Synthetic restriction' }],
    },
  ]) {
    tree = harness.render('ConversationHistory', {
      ...props,
      state: { ...props.state, runs: [{ ...completedRun, taskOutcome }] },
    });
    assert.ok(card(tree));
    assert.ok(findNode(tree, (node) => node.props.message?.id === 'reply'));
    assert.ok(card(harness.render('ConversationHistory', props)));
  }
  harness.unmount();
});

for (const steered of [false, true]) {
  test(`completed chat retains its ${steered ? 'steered' : 'streamed'} reply until the saved final arrives`, () => {
    const history = uiHarness(code),
      card = uiHarness(code);
    const at = (seconds: number) => new Date(Date.parse(stamp) + seconds * 1000).toISOString();
    const original = workflow('stream', {
      status: 'running',
      phase: 'execute',
      input: { ...workflow('stream').input, mode: 'chat' },
      activeStepId: 'reply',
      plan: [
        {
          id: 'reply',
          title: 'Synthetic reply',
          instruction: '',
          kind: 'routine',
          transport: 'auto',
          dependsOn: [],
          status: 'running',
          runIds: ['stream-run'],
        },
      ],
    });
    const firstText = steered ? '当前补充后的回答。' : '你好，这是第一段回答。';
    const fullText = `${firstText} 第二段正在继续。`;
    const liveRun: RunRecord = {
      ...run('stream-run'),
      workflowId: original.id,
      stepId: 'reply',
      status: 'running',
      output: `${steered ? 'OLD_STAGE_MARKER' : ''}${firstText}`,
      events: steered
        ? [
            { type: 'text', at: at(1), text: 'OLD_STAGE_MARKER' },
            { type: 'text', at: at(4), text: firstText },
          ]
        : [],
    };
    const user: ConversationMessage = {
      id: 'message',
      conversationId: conversation.id,
      workflowId: original.id,
      role: 'user',
      content: 'Synthetic question',
      createdAt: stamp,
    };
    const messages: ConversationMessage[] = [user];
    if (steered)
      messages.push(
        { ...user, id: 'earlier-answer', role: 'assistant', content: 'Earlier saved answer', createdAt: at(1) },
        {
          ...user,
          id: 'correction',
          content: 'Synthetic correction',
          createdAt: at(2),
          steering: { runId: liveRun.id, status: 'accepted', acceptedAt: at(3) },
        },
      );
    const props = {
      messages,
      workflows: [original],
      state: { ...state, runs: [liveRun] },
      api: async () => ({}),
      notify() {},
      onInspect() {},
    };
    const render = () => {
      const tree = history.render('ConversationHistory', props);
      const node = findNode(tree, (item) => item.type?.name === 'WorkflowTrace');
      const rendered = node && card.render('WorkflowTrace', node.props);
      const reply = findNode(rendered, (item) => item.props.className?.includes('live-main-reply'));
      const output = findNode(reply, (item) => typeof item.props.text === 'string')?.props.text;
      return { tree, node, rendered, reply, output };
    };
    try {
      const first = render();
      assert.equal(first.output, firstText);
      props.state = {
        ...props.state,
        runs: [
          {
            ...liveRun,
            output: `${steered ? 'OLD_STAGE_MARKER' : ''}${fullText}`,
            events: steered ? [...liveRun.events, { type: 'text', at: at(5), text: ' 第二段正在继续。' }] : [],
          },
        ],
      };
      assert.equal(render().output, fullText);
      props.workflows = [{ ...original, status: 'completed', phase: 'summarize', finalMessageId: 'final' }];
      props.state = {
        ...props.state,
        runs: [
          { ...props.state.runs[0]!, status: 'completed', summary: true, events: [], output: 'TRIMMED_TAIL_MARKER' },
        ],
      };
      props.messages = [
        ...messages,
        {
          ...user,
          id: 'notice',
          role: 'assistant',
          content: 'Synthetic relay notice',
          systemNotice: { text: 'Synthetic relay notice' },
          createdAt: at(6),
        },
      ];
      const pending = render();
      assert.equal(pending.node?.key, first.node?.key, 'completion keeps the same mounted stream');
      assert.equal(pending.output, fullText, 'a summary broadcast keeps the untrimmed displayed text');
      assert.equal(pending.node?.props.stage?.messageId, steered ? 'correction' : undefined);
      const order: string[] = [];
      findNode(pending.tree, (item) => {
        if (item.props.message?.id) order.push(item.props.message.id);
        if (item.type?.name === 'WorkflowTrace') order.push(item.key!);
        return false;
      });
      assert.equal(order.at(-1), first.node?.key, 'pending reply remains after messages and steering receipts');
      const final: ConversationMessage = {
        ...user,
        id: 'final',
        role: 'assistant',
        content: fullText,
        createdAt: at(7),
      };
      for (const invalid of [
        { ...final, conversationId: 'other-chat' },
        { ...final, workflowId: 'other-task' },
        { ...final, role: 'user' as const },
      ]) {
        props.messages = [...messages, invalid];
        assert.equal(render().output, fullText, 'an invalid final pointer cannot suppress the current answer');
      }
      for (const saved of [final, { ...final, systemNotice: { text: 'Synthetic final notice' } }]) {
        // Prime both reply caches before each final-message handoff.
        const completedState = props.state;
        props.messages = messages;
        props.state = { ...props.state, runs: [{ ...liveRun, output: fullText, events: [] }] };
        if (steered) props.state.runs[0]!.events = [{ type: 'text', at: at(5), text: fullText }];
        assert.equal(render().output, fullText);
        props.state = completedState;
        props.messages = [...messages, saved];
        const finished = render();
        assert.ok(finished.node, 'saved final keeps the execution record');
        assert.equal(findNode(finished.rendered, (item) => item.type === 'details')?.props.open, false);
        assert.ok(findNode(finished.rendered, (item) => item.props.className === 'workflow-status'));
        assert.equal(
          findNode(finished.rendered, (item) => item.props.className === 'reply-identity'),
          undefined,
        );
        assert.equal(finished.reply, undefined, 'the record must not render the streamed or cached reply');
        assert.equal(
          findNode(finished.rendered, (item) => item.props.text === fullText),
          undefined,
          'the saved reply text must not also appear inside the record',
        );
        let replies = 0;
        findNode(finished.tree, (item) => {
          if (item.props.message?.id === final.id) replies++;
          return false;
        });
        assert.equal(replies, 1, 'saved final reply or notice takes over exactly once');
      }
    } finally {
      card.unmount();
      history.unmount();
    }
  });
}

test('a Trace request from Run history opens this chat trace on that run', async () => {
  const harness = uiHarness(code);
  const props = {
    state,
    conversation,
    api: async () => ({ messages: [] }),
    notify() {},
    onConversation() {},
    onAddProject() {},
    onMemory() {},
    onInspect() {},
    traceRequest: { runId: 'primary-run', nonce: 1 },
  };
  harness.render('ConversationWorkspace', props);
  await nextTurn();
  const tree = harness.render('ConversationWorkspace', props);
  assert.equal(findNode(tree, (node) => node.type?.name === 'ConversationTrace')?.props.initialRunId, 'primary-run');
  harness.unmount();
});
