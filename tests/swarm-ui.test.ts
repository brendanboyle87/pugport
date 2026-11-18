import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AppState, Conversation, ConversationMessage, RunRecord, Workflow } from '../src/shared/types.ts';
import type { SwarmMessage } from '../src/shared/swarm.ts';
import type { Api } from '../src/ui/Workspace.tsx';
import { avatarText, avatarTone } from '../src/ui/avatar.tsx';
import {
  SwarmChatLineView,
  SwarmWorkspace,
  SwarmWorkspaceView,
  sendSwarmMessage,
  swarmChatLines,
  swarmCommunications,
  swarmContentPreview,
  swarmMemberMessages,
  swarmMembers,
  swarmRunRecords,
} from '../src/ui/SwarmWorkspace.tsx';
import { findNode, nextTurn, uiBundle, uiHarness } from './helpers/ui-harness.ts';

const at = '2026-10-09T12:00:00.000Z';
const conversation: Conversation = {
  id: 'main/chat',
  projectId: 'project',
  title: 'Swarm test',
  createdAt: at,
  updatedAt: at,
};
function workflow(id: string, extra: Partial<Workflow> = {}): Workflow {
  return {
    id,
    conversationId: conversation.id,
    projectId: 'project',
    userMessageId: `${id}-input`,
    input: { content: `Original task ${id}`, mode: 'chat', permissionMode: 'read-only', executionPolicy: 'cli-only' },
    status: 'running',
    phase: 'execute',
    plan: [],
    runIds: [`${id}-run`],
    memoryRevision: 0,
    memoryExcerpt: '',
    createdAt: at,
    updatedAt: at,
    ...extra,
  };
}
function run(id: string, extra: Partial<RunRecord> = {}): RunRecord {
  return {
    id: `${id}-run`,
    workflowId: id,
    prompt: 'ASSEMBLED_PRIVATE_PROMPT',
    projectPath: 'C:/synthetic',
    kind: 'general',
    status: 'running',
    route: {
      runtimeId: 'fixture-grok',
      model: 'launch-model',
      effort: 'high',
      kind: 'general',
      reasons: [],
      warnings: [],
    },
    effectiveModel: { model: 'effective-model', effort: 'low', source: 'fixture-runtime' },
    startedAt: at,
    output: 'Native output',
    reasoning: 'PRIVATE_REASONING_MUST_NOT_APPEAR',
    events: [],
    ...extra,
  };
}
const root = workflow('root');
const child = workflow('child', { delegation: { parentId: root.id, requestId: 'one', role: 'scout' } });
const grandchild = workflow('grandchild', { delegation: { parentId: child.id, requestId: 'two', role: 'reviewer' } });
const tasks = [root, child, grandchild];
const records = tasks.map((task) => run(task.id));
const state = {
  projects: [{ id: 'project' }],
  targets: [{ id: 'fixture-grok', label: 'Grok B' }],
  runs: [],
  workflows: [],
} as unknown as AppState;
const message = (id: string, workflowId: string, content: string): ConversationMessage => ({
  id,
  workflowId,
  conversationId: conversation.id,
  role: 'assistant',
  content,
  createdAt: at,
});
const members = () => swarmMembers(tasks, records, state.targets);

test('ordinary, removed and missing project conversations do not render or fetch a child workspace', async () => {
  const code = await uiBundle('src/ui/SwarmWorkspace.tsx');
  for (const projects of [[{ id: 'project', scope: 'chat' }], [{ id: 'project', removedAt: at }], []]) {
    const h = uiHarness(code),
      calls: string[] = [];
    const view = h.render('SwarmWorkspace', {
      state: { ...state, projects },
      conversation,
      api: async (path: string) => {
        calls.push(path);
        return { workflows: tasks };
      },
      reload: async () => {},
      notify() {},
      onInspect() {},
    });
    assert.equal(view, null);
    await nextTurn();
    assert.deepEqual(calls, []);
    h.unmount();
  }
});

test('member creation, delivery and recovery target only the selected logical member', async () => {
  const calls: string[] = [];
  let finish!: (value: any) => void;
  const api: Api = async <T>(path: string) => {
    if (path.endsWith('/delivery') || path.endsWith('/continue')) {
      calls.push(path);
      return new Promise((resolve) => {
        finish = resolve;
      }) as Promise<T>;
    }
    if (path.endsWith('/swarm')) return { workflows: tasks } as T;
    if (path.endsWith('/execution-record')) return { workflow: root, runs: [], relatedRuns: [] } as T;
    return { messages: [] } as T;
  };
  const h = uiHarness(await uiBundle('src/ui/SwarmWorkspace.tsx'));
  const props = { state, conversation, api, reload: async () => {}, notify() {}, onInspect() {} };
  const render = () => h.render('SwarmWorkspace', props);
  render();
  await nextTurn();
  render().props.onSelect(child.id);
  await nextTurn();
  render().props.onCreateChild();
  assert.equal(render().props.childDialog.props.parent.id, child.id);
  render().props.childDialog.props.onClose();
  render().props.onDeliver();
  render().props.onDeliver();
  assert.deepEqual(calls, ['/api/workflows/child/delivery']);
  assert.equal(render().props.memberActionPending, true);
  render().props.onSelect(grandchild.id);
  finish({ workflow: child });
  await nextTurn();
  assert.equal(render().props.selectedId, grandchild.id);
  render().props.onContinue();
  assert.deepEqual(calls, ['/api/workflows/child/delivery', '/api/workflows/grandchild/continue']);
  finish({ workflow: grandchild });
  await nextTurn();
  render().props.onCreateChild();
  assert.equal(render().props.childDialog.props.parent.id, grandchild.id);
  props.conversation = { ...conversation, id: 'another-chat' };
  assert.equal(render().props.childDialog, false, 'a create form cannot target the previous conversation');
  props.conversation = conversation;
  assert.equal(render().props.childDialog, false, 'returning to the old conversation does not reopen a stale parent');
  h.unmount();
});

test('members preserve nested assignments and report effective child effort without inheriting the main launch effort', () => {
  const result = members();
  assert.deepEqual(
    result.map((member) => [member.id, member.parentId, member.depth]),
    [
      ['root', undefined, 0],
      ['child', 'root', 1],
      ['grandchild', 'child', 2],
    ],
  );
  assert.match(result[1]!.executor, /Grok B · effective-model · low/);
  assert.doesNotMatch(result[1]!.executor, /launch-model|high/);
  assert.equal(result[1]!.task, 'Original task child');
  assert.doesNotMatch(result[1]!.task, /ASSEMBLED_PRIVATE_PROMPT/);
});

test('continuations stay in one logical member and retain every old workflow id while invalid chains fail closed', () => {
  const previous = {
    ...child,
    status: 'interrupted' as const,
    followUp: { workflowId: 'resumed', kind: 'continue' as const, at },
  };
  const resumed = workflow('resumed', {
    parentWorkflowId: child.id,
    delegation: child.delegation,
    createdAt: '2026-10-09T13:00:00Z',
  });
  const invalid = workflow('outside', {
    projectId: 'other',
    delegation: { parentId: root.id, requestId: 'outside', role: 'worker' },
  });
  const result = swarmMembers(
    [root, previous, grandchild, resumed, invalid],
    [...records, run('resumed')],
    state.targets,
  );
  assert.equal(result.length, 3);
  const member = result.find((value) => value.id === 'child')!;
  assert.equal(member.workflow.id, resumed.id);
  assert.deepEqual(member.workflowIds, ['child', 'resumed']);
  assert.equal(result.find((value) => value.id === 'grandchild')?.parentId, child.id);
});

test('message edges require actual typed events, deduplicate both sides and preserve full recorded text', () => {
  const text = 'Recorded peer message '.repeat(700);
  const event = {
    at,
    type: 'status' as const,
    data: {
      kind: 'communication',
      detail: { messageId: 'shared', fromRunId: 'root-run', toWorkflowId: child.id, text, status: 'received' },
    },
  };
  const rootRun = run(root.id, {
    events: [
      event,
      { at, type: 'text', text: 'I sent a message to grandchild' },
      { at, type: 'tool', data: { tool: 'message_task' } },
    ],
  });
  const childRun = run(child.id, { events: [event] });
  const result = swarmCommunications(members(), [rootRun, childRun, run(grandchild.id)]);
  assert.equal(result.length, 1);
  assert.deepEqual([result[0]!.from, result[0]!.to], [root.id, child.id]);
  assert.equal(result[0]!.text, text);
  assert.equal(result[0]!.status, 'received');
});

test('member history keeps full original/final messages and excludes siblings in the same conversation', () => {
  const text = 'FULL_REPLY '.repeat(900);
  const chosen = members()[1]!;
  const result = swarmMemberMessages(chosen, [
    message('root-output', root.id, 'OTHER_ROOT'),
    message('child-output', child.id, text),
    message('grandchild-output', grandchild.id, 'OTHER_CHILD'),
  ]);
  assert.deepEqual(
    result.map((item) => item.id),
    ['child-output'],
  );
  assert.equal(result[0]!.content, text);
});

test('persistent peer messages complete graph history while archived events and live new events both survive', () => {
  const oldEvent = { seq: 1, at, type: 'status' as const, text: 'Recorded old event' };
  const currentEvent = { seq: 2, at: '2026-10-09T13:00:00Z', type: 'status' as const, text: 'Recorded live event' };
  const all = swarmRunRecords([run(root.id, { events: [oldEvent] })], [run(root.id, { events: [currentEvent] })]);
  assert.deepEqual(
    all[0]?.events.map((event) => event.seq),
    [1, 2],
  );
  const peer: SwarmMessage = {
    id: 'durable-peer',
    rootWorkflowId: root.id,
    source: 'agent',
    fromWorkflowId: root.id,
    toWorkflowId: child.id,
    text: 'FULL_PERSISTENT_PEER',
    createdAt: at,
    status: 'queued',
  };
  const human: SwarmMessage = { ...peer, id: 'human', source: 'human', fromWorkflowId: undefined };
  const communications = swarmCommunications(members(), [], [peer, human]);
  assert.equal(communications.length, 1);
  assert.equal(communications[0]?.text, peer.text);
  assert.equal(communications[0]?.status, 'queued');
});

test('swarm view shows a member strip and the opened member in a side sheet, keeping model reasoning and assembled prompts out', () => {
  const fullReply = `Start ${'long reply '.repeat(900)} FULL_REPLY_END`;
  const html = renderToStaticMarkup(
    createElement(SwarmWorkspaceView, {
      members: members(),
      communications: [],
      selectedId: child.id,
      messages: [message('output', child.id, fullReply)],
      loading: false,
      sending: false,
      draft: '',
      onSelect() {},
      onRefresh() {},
      onDraft() {},
      onSend() {},
      onInspect() {},
    }),
  );
  assert.match(html, /role="toolbar" aria-label="蜂群成员"/);
  assert.match(html, /class="side-sheet swarm-member-sheet" role="dialog" aria-label="成员 调查"/);
  assert.match(html, /Grok B · effective-model · low/);
  assert.doesNotMatch(html, /swarm-topology|协作图/, 'no graph: the conversation itself shows who said what');
  assert.doesNotMatch(
    html,
    /FULL_REPLY_END/,
    'A long result must not render its entire hidden body before it is expanded.',
  );
  assert.match(html, /<details class="swarm-message-content">/);
  assert.match(html, /展开详情/);
  assert.match(html, /查看全文/);
  assert.doesNotMatch(html, /PRIVATE_REASONING|ASSEMBLED_PRIVATE_PROMPT|内容已截断/);
});

test('long replies stay folded until requested and retain their expansion across streaming updates', async () => {
  const original = 'Preview of a complete long reply. '.repeat(80) + 'COMPLETE_REPLY_END';
  assert.equal(swarmContentPreview(original).length, 161);
  const harness = uiHarness(await uiBundle('src/ui/SwarmWorkspace.tsx'));
  const props = {
    members: members(),
    communications: [],
    selectedId: child.id,
    messages: [message('stream', child.id, original)],
    loading: false,
    sending: false,
    draft: '',
    onSelect() {},
    onRefresh() {},
    onDraft() {},
    onSend() {},
    onInspect() {},
  };
  let tree = harness.render('SwarmWorkspaceView', props);
  let disclosure = findNode(
    tree,
    (node) => node.type === 'details' && node.props.className === 'swarm-message-content',
  );
  assert.ok(disclosure);
  assert.equal(disclosure.props.open, false);
  disclosure.props.onToggle({ currentTarget: { open: true } });
  tree = harness.render('SwarmWorkspaceView', props);
  disclosure = findNode(tree, (node) => node.type === 'details' && node.props.className === 'swarm-message-content');
  assert.equal(disclosure?.props.open, true);
  assert.match(JSON.stringify(disclosure?.props.children), /COMPLETE_REPLY_END/);
  for (let i = 1; i <= 4; i++) {
    tree = harness.render('SwarmWorkspaceView', {
      ...props,
      messages: [message('stream', child.id, original + ' New streamed text.'.repeat(i))],
    });
    disclosure = findNode(tree, (node) => node.type === 'details' && node.props.className === 'swarm-message-content');
    assert.equal(disclosure?.props.open, true, 'Refreshing the same message must preserve the user expansion choice.');
    const updates = findNode(tree, (node) => node.props.className?.includes?.('swarm-new-content'));
    assert.match(JSON.stringify(updates?.props.children), /1 条记录更新/);
    assert.doesNotMatch(JSON.stringify(updates?.props.children), /[2-9] 条记录更新|条新记录/);
  }
  disclosure!.props.onToggle({ currentTarget: { open: false } });
  tree = harness.render('SwarmWorkspaceView', {
    ...props,
    messages: [message('stream', child.id, original + ' Last update.')],
  });
  assert.equal(findNode(tree, (node) => node.props.className === 'swarm-message-content')?.props.open, false);
  harness.unmount();
});

test('new member content preserves the reading anchor and scrolls only when the reader requests it', async () => {
  const harness = uiHarness(await uiBundle('src/ui/SwarmWorkspace.tsx'));
  let selections = 0,
    scrollTop = 136;
  let ids = ['message:first'];
  const viewport = {
    get scrollTop() {
      return scrollTop;
    },
    set scrollTop(value: number) {
      scrollTop = value;
    },
    getBoundingClientRect: () => ({ top: 40 }),
    querySelectorAll: () =>
      ids.map((id, index) => ({
        dataset: { swarmMessage: id },
        getBoundingClientRect: () => ({
          top: 40 + index * 500 - scrollTop,
          bottom: 40 + (index + 1) * 500 - scrollTop,
        }),
      })),
  };
  const first = message('first', child.id, 'Already reading this long reply. '.repeat(60));
  const second = message('second', child.id, 'A newly arrived result. '.repeat(60));
  const props = {
    members: members(),
    communications: [],
    selectedId: child.id,
    messages: [first],
    loading: false,
    sending: false,
    draft: '',
    onSelect() {
      selections++;
    },
    onRefresh() {},
    onDraft() {},
    onSend() {},
    onInspect() {},
  };
  let tree = harness.render('SwarmWorkspaceView', props);
  const history = findNode(tree, (node) => node.props.className === 'swarm-member-history');
  assert.ok(history);
  history.props.ref.current = viewport;
  history.props.onScroll();
  ids = ['message:first', 'message:second'];
  const updated = { ...props, messages: [first, second] };
  tree = harness.render('SwarmWorkspaceView', updated);
  assert.equal(scrollTop, 136, 'Receiving another result must not move the reader to the bottom.');
  assert.equal(selections, 0, 'A result must not switch the currently selected member.');
  const update = findNode(tree, (node) => node.props.className?.includes?.('swarm-new-content'));
  assert.ok(update);
  assert.match(JSON.stringify(update.props.children), /1 条新记录/);
  update.props.onClick();
  tree = harness.render('SwarmWorkspaceView', updated);
  assert.equal(scrollTop, 500);
  assert.equal(
    findNode(tree, (node) => node.props.className?.includes?.('swarm-new-content')),
    undefined,
  );
  harness.render('SwarmWorkspaceView', { ...updated, selectedId: root.id, messages: [] });
  assert.equal(scrollTop, 0);
  harness.render('SwarmWorkspaceView', updated);
  assert.equal(scrollTop, 500, 'Returning to the member restores the last reading position.');
  harness.unmount();
});

test('server-confirmed queued human input is visible without pretending the member already received it', () => {
  const queued: SwarmMessage = {
    id: 'queued',
    rootWorkflowId: root.id,
    source: 'human',
    toWorkflowId: child.id,
    text: 'Read these latest requirements.',
    createdAt: at,
    status: 'queued',
  };
  const html = renderToStaticMarkup(
    createElement(SwarmWorkspaceView, {
      members: members(),
      communications: [],
      selectedId: child.id,
      messages: [],
      memberMessages: [queued],
      loading: false,
      sending: false,
      draft: '',
      onSelect() {},
      onRefresh() {},
      onDraft() {},
      onSend() {},
      onInspect() {},
    }),
  );
  assert.match(html, /你的留言 · 已排队/);
  assert.match(html, /Read these latest requirements/);
  assert.doesNotMatch(html, /你的留言 · 已送达/);
});

test('empty swarm uses the existing task composer and performs no API mutation during render', () => {
  let calls = 0;
  const api: Api = async <T>() => {
    calls++;
    return {} as T;
  };
  const html = renderToStaticMarkup(
    createElement(SwarmWorkspace, { state, conversation, api, reload: async () => {}, notify() {}, onInspect() {} }),
  );
  assert.match(html, /正在读取蜂群…/);
  assert.equal(calls, 0);
  assert.doesNotMatch(html, /textarea|发送成员消息/);
});

test('member-message submission preserves scope and distinguishes delivered, queued and missing acknowledgements', async () => {
  const calls: unknown[][] = [];
  const api: Api = async <T>(...args: [string, unknown?, string?]) => {
    calls.push(args);
    return { ok: true, delivery: 'queued', workflowId: 'child/new' } as T;
  };
  const original = '\n  Check these facts.  \r\n';
  const result = await sendSwarmMessage(api, 'child/old', original);
  assert.equal(result.delivery, 'queued');
  assert.deepEqual(calls, [['/api/workflows/child%2Fold/swarm-message', { text: original }, 'POST']]);
  await assert.rejects(sendSwarmMessage(api, child.id, ' '), /消息不能为空/);
  await assert.rejects(sendSwarmMessage(api, child.id, 'x'.repeat(8001)), /8000/);
  assert.equal(calls.length, 1);
  const missing: Api = async <T>() => ({ ok: true, workflowId: child.id }) as T;
  await assert.rejects(sendSwarmMessage(missing, child.id, 'Keep this input.'), /尚未确认/);
  const denied: Api = async () => {
    throw new Error('Member no longer belongs to this swarm.');
  };
  await assert.rejects(sendSwarmMessage(denied, child.id, 'Keep this input.'), /no longer belongs/);
});

test('swarm loads full durable descendants and conversation history instead of relying on bounded live state', async () => {
  const calls: string[] = [];
  const api: Api = async <T>(path: string) => {
    calls.push(path);
    if (path.endsWith('/swarm')) return { workflows: tasks } as T;
    if (path.endsWith('/execution-record'))
      return { workflow: root, runs: [records[0]], relatedRuns: records.slice(1) } as T;
    return { messages: [message('root-final', root.id, 'Full root result')] } as T;
  };
  const harness = uiHarness(await uiBundle('src/ui/SwarmWorkspace.tsx'));
  const props = { state, conversation, api, reload: async () => {}, notify() {}, onInspect() {} };
  harness.render('SwarmWorkspace', props);
  await nextTurn();
  harness.render('SwarmWorkspace', props);
  await nextTurn();
  let view = harness.render('SwarmWorkspace', props);
  // The swarm opens on the conversation itself, but the family record is read at once so the list shows executors.
  assert.equal(view.props.selectedId, undefined);
  assert.ok(calls.includes('/api/workflows/root/execution-record'));
  assert.match(view.props.members[1].executor, /effective-model · low/);
  view.props.onSelect(root.id);
  harness.render('SwarmWorkspace', props);
  await nextTurn();
  view = harness.render('SwarmWorkspace', props);
  assert.equal(view.props.members.length, 3);
  assert.equal(view.props.messages[0].content, 'Full root result');
  assert.match(view.props.members[1].executor, /effective-model · low/);
  assert.ok(calls.includes('/api/conversations/main%2Fchat/swarm'));
  assert.ok(calls.includes('/api/conversations/main%2Fchat'));
  assert.ok(calls.includes('/api/workflows/root/execution-record'));
  assert.ok(calls.every((path) => !/cancel|resume|handoff/.test(path)));
  harness.unmount();
});

test('refreshing the selected member keeps its readable history mounted until new records arrive', async () => {
  let pending = false;
  const complete = message(
    'readable-final',
    root.id,
    'The existing reply must remain readable during a refresh. '.repeat(90),
  );
  const api: Api = async <T>(path: string) => {
    if (path.endsWith('/swarm')) return { workflows: tasks } as T;
    if (path.endsWith('/execution-record')) {
      if (pending) return new Promise<T>(() => {});
      return { workflow: root, runs: [records[0]], relatedRuns: records.slice(1), messages: [complete] } as T;
    }
    return { messages: [complete] } as T;
  };
  const harness = uiHarness(await uiBundle('src/ui/SwarmWorkspace.tsx'));
  const props = { state, conversation, api, reload: async () => {}, notify() {}, onInspect() {} };
  harness.render('SwarmWorkspace', props);
  await nextTurn();
  let view = harness.render('SwarmWorkspace', props);
  view.props.onSelect(root.id);
  harness.render('SwarmWorkspace', props);
  await nextTurn();
  view = harness.render('SwarmWorkspace', props);
  assert.equal(view.props.messages[0].content, complete.content);
  pending = true;
  view.props.onRefresh();
  view = harness.render('SwarmWorkspace', props);
  await nextTurn();
  view = harness.render('SwarmWorkspace', props);
  assert.equal(view.props.loading, true);
  assert.equal(view.props.messages[0].content, complete.content);
  assert.equal(view.props.selectedId, root.id);
  harness.unmount();
});

test('family archive independently preserves complete member inputs and replies while shared history ids are deduplicated', async () => {
  const bundle = await uiBundle('src/ui/SwarmWorkspace.tsx');
  const input = {
    ...message('member-input', child.id, '\n  Exact original member input.  \r\n'),
    role: 'user' as const,
  };
  const reply = {
    ...message('member-final', child.id, 'Complete archived member reply. '.repeat(900) + 'ARCHIVE_FULL_END'),
    createdAt: '2026-10-09T12:01:00.000Z',
  };
  const archived = [input, reply];
  for (const history of [[], archived]) {
    const api: Api = async <T>(path: string) => {
      if (path.endsWith('/swarm')) return { workflows: tasks } as T;
      if (path.endsWith('/execution-record'))
        return { workflow: root, runs: [records[0]], relatedRuns: records.slice(1), messages: archived } as T;
      return { messages: history } as T;
    };
    const harness = uiHarness(bundle);
    const props = { state, conversation, api, reload: async () => {}, notify() {}, onInspect() {} };
    harness.render('SwarmWorkspace', props);
    await nextTurn();
    let view = harness.render('SwarmWorkspace', props);
    await nextTurn();
    view = harness.render('SwarmWorkspace', props);
    view.props.onSelect(child.id);
    harness.render('SwarmWorkspace', props);
    await nextTurn();
    view = harness.render('SwarmWorkspace', props);
    assert.equal(view.props.messages.length, 2, 'A shared history/archive message id must be shown exactly once.');
    assert.equal(view.props.messages[0].role, 'user');
    assert.equal(view.props.messages[0].content, input.content);
    assert.equal(view.props.messages[1].content, reply.content);
    assert.match(view.props.messages[1].content, /ARCHIVE_FULL_END$/);
    harness.unmount();
  }
});

test('selecting a member opens its complete text and trace without displaying private reasoning', async () => {
  const harness = uiHarness(await uiBundle('src/ui/SwarmWorkspace.tsx'));
  const inspected: string[] = [];
  const text = 'Synthetic complete member final answer '.repeat(300);
  const props = {
    members: members(),
    communications: [],
    selectedId: child.id,
    messages: [message('child-output', child.id, text)],
    loading: false,
    sending: false,
    draft: '',
    onSelect() {},
    onRefresh() {},
    onDraft() {},
    onSend() {},
    onInspect(id: string) {
      inspected.push(id);
    },
  };
  let tree = harness.render('SwarmWorkspaceView', props);
  const trace = findNode(
    tree,
    (node) => node.type === 'button' && node.props.children?.some?.((item: unknown) => item === '轨迹'),
  );
  assert.ok(trace);
  trace.props.onClick();
  assert.deepEqual(inspected, ['child-run']);
  const more = findNode(tree, (node) => node.type === 'button' && node.props.children === '查看全文');
  assert.ok(more);
  more.props.onClick();
  tree = harness.render('SwarmWorkspaceView', props);
  const dialog = findNode(tree, (node) => node.type?.name === 'TrajectoryDetailDialog');
  assert.ok(dialog);
  assert.equal(dialog.props.text, text);
  harness.unmount();
});

test('an earlier conversation response cannot replace the currently opened swarm', async () => {
  let resolveEarlier!: (value: unknown) => void;
  const oldResponse = new Promise<unknown>((resolve) => {
    resolveEarlier = resolve;
  });
  const newer = { ...conversation, id: 'new-chat' };
  const newTask = workflow('new-root', { conversationId: newer.id });
  const api: Api = <T>(path: string) => {
    if (path === '/api/conversations/main%2Fchat/swarm') return oldResponse as Promise<T>;
    if (path.endsWith('/swarm')) return Promise.resolve({ workflows: [newTask] } as T);
    if (path.endsWith('/execution-record'))
      return Promise.resolve({ workflow: newTask, runs: [], relatedRuns: [] } as T);
    return Promise.resolve({ messages: [] } as T);
  };
  const harness = uiHarness(await uiBundle('src/ui/SwarmWorkspace.tsx'));
  const props = { state, conversation, api, reload: async () => {}, notify() {}, onInspect() {} };
  harness.render('SwarmWorkspace', props);
  harness.render('SwarmWorkspace', { ...props, conversation: newer });
  await nextTurn();
  harness.render('SwarmWorkspace', { ...props, conversation: newer });
  resolveEarlier({ workflows: tasks });
  await nextTurn();
  const current = harness.render('SwarmWorkspace', { ...props, conversation: newer });
  assert.deepEqual(
    Array.from(current.props.members, (member: { id: string }) => member.id),
    ['new-root'],
  );
  harness.unmount();
});

test('member send prevents concurrent duplicates and preserves draft edits while delivery is pending', async () => {
  let finishSend!: (value: unknown) => void;
  let submissions = 0,
    reloads = 0;
  const notices: Array<{ message: string }> = [];
  const api: Api = <T>(path: string, body?: unknown, method?: string) => {
    if (method === 'POST') {
      submissions++;
      assert.equal(path, '/api/workflows/root/swarm-message');
      assert.equal(
        JSON.stringify(body),
        JSON.stringify({ text: submissions === 1 ? 'Original directed input' : 'Second directed input' }),
      );
      return new Promise<T>((resolve) => {
        finishSend = resolve as (value: unknown) => void;
      });
    }
    if (path.endsWith('/swarm')) return Promise.resolve({ workflows: tasks } as T);
    if (path.endsWith('/execution-record'))
      return Promise.resolve({ workflow: root, runs: records.slice(0, 1), relatedRuns: records.slice(1) } as T);
    return Promise.resolve({ messages: [] } as T);
  };
  const harness = uiHarness(await uiBundle('src/ui/SwarmWorkspace.tsx'));
  const props = {
    state,
    conversation,
    api,
    reload: async () => {
      reloads++;
    },
    notify(notice: { message: string }) {
      notices.push(notice);
    },
    onInspect() {},
  };
  harness.render('SwarmWorkspace', props);
  await nextTurn();
  let view = harness.render('SwarmWorkspace', props);
  await nextTurn();
  view = harness.render('SwarmWorkspace', props);
  view.props.onSelect(root.id);
  view = harness.render('SwarmWorkspace', props);
  view.props.onDraft('Original directed input');
  view = harness.render('SwarmWorkspace', props);
  view.props.onSend();
  view.props.onSend();
  assert.equal(submissions, 1);
  assert.equal(notices.length, 0);
  view.props.onDraft('New draft while pending');
  finishSend({ ok: true, delivery: 'queued', workflowId: root.id });
  await nextTurn();
  view = harness.render('SwarmWorkspace', props);
  assert.equal(view.props.draft, 'New draft while pending');
  assert.match(view.props.delivery, /已排队/);
  assert.equal(reloads, 1);
  assert.equal(notices.length, 1);
  view.props.onDraft('Second directed input');
  view = harness.render('SwarmWorkspace', props);
  view.props.onSend();
  view.props.onSelect(child.id);
  harness.render('SwarmWorkspace', props);
  finishSend({ ok: true, delivery: 'delivered', workflowId: root.id });
  await nextTurn();
  view = harness.render('SwarmWorkspace', props);
  assert.equal(view.props.selectedId, child.id);
  assert.equal(
    view.props.delivery,
    undefined,
    'The previous member acknowledgement must not label the newly selected member.',
  );
  harness.unmount();
});

test('a confirmed member message stays delivered or queued when the later workspace refresh fails', async () => {
  const bundle = await uiBundle('src/ui/SwarmWorkspace.tsx');
  for (const delivery of ['delivered', 'queued'] as const) {
    let submissions = 0,
      refreshes = 0;
    const notices: Array<{ tone: string; message: string }> = [];
    const original = '\n  Keep the exact member instruction.  \n';
    const api: Api = async <T>(path: string, body?: unknown, method?: string) => {
      if (method === 'POST') {
        submissions++;
        assert.equal(path, '/api/workflows/root/swarm-message');
        assert.equal(JSON.stringify(body), JSON.stringify({ text: original }));
        return { ok: true, delivery, workflowId: root.id } as T;
      }
      if (path.endsWith('/swarm')) return { workflows: tasks } as T;
      if (path.endsWith('/execution-record'))
        return { workflow: root, runs: [records[0]], relatedRuns: records.slice(1) } as T;
      return { messages: [] } as T;
    };
    const harness = uiHarness(bundle);
    const props = {
      state,
      conversation,
      api,
      reload: async () => {
        refreshes++;
        throw new Error('Synthetic refresh unavailable');
      },
      notify(notice: { tone: string; message: string }) {
        notices.push(notice);
      },
      onInspect() {},
    };
    harness.render('SwarmWorkspace', props);
    await nextTurn();
    let view = harness.render('SwarmWorkspace', props);
    await nextTurn();
    view = harness.render('SwarmWorkspace', props);
    view.props.onSelect(root.id);
    view = harness.render('SwarmWorkspace', props);
    view.props.onDraft(original);
    view = harness.render('SwarmWorkspace', props);
    view.props.onSend();
    await nextTurn();
    view = harness.render('SwarmWorkspace', props);
    assert.equal(view.props.sending, false);
    assert.equal(view.props.draft, '', 'An acknowledged instruction must not be restored for accidental resubmission.');
    assert.match(view.props.delivery, delivery === 'delivered' ? /已送达/ : /已排队/);
    assert.doesNotMatch(view.props.delivery, /刷新失败|Synthetic refresh/);
    assert.equal(refreshes, 1);
    assert.equal(submissions, 1);
    assert.deepEqual(
      Array.from(notices, (notice) => notice.tone),
      ['success', 'error'],
    );
    assert.match(notices[1]!.message, /刷新失败/);
    await nextTurn();
    harness.render('SwarmWorkspace', props);
    assert.equal(submissions, 1, 'A failed refresh must not retry an already acknowledged POST.');
    harness.unmount();
  }
});

for (const returnToOriginal of [false, true])
  test(`an older send acknowledgement cannot unlock or notify a pending send ${returnToOriginal ? 'after returning to the original conversation' : 'in the new conversation'}`, async () => {
    const newer = { ...conversation, id: 'new-chat' };
    const newTask = workflow('new-root', { conversationId: newer.id });
    const pending: Array<(value: unknown) => void> = [];
    const notices: Array<{ message: string }> = [];
    let submissions = 0;
    const api: Api = <T>(path: string, _body?: unknown, method?: string) => {
      if (method === 'POST') {
        submissions++;
        return new Promise<T>((resolve) => {
          pending.push(resolve as (value: unknown) => void);
        });
      }
      if (path.endsWith('/swarm'))
        return Promise.resolve({ workflows: path.includes('new-chat') ? [newTask] : [root] } as T);
      if (path.endsWith('/execution-record'))
        return Promise.resolve({ workflow: newTask, runs: [], relatedRuns: [] } as T);
      return Promise.resolve({ messages: [] } as T);
    };
    const harness = uiHarness(await uiBundle('src/ui/SwarmWorkspace.tsx'));
    const props = {
      state,
      conversation,
      api,
      reload: async () => {},
      notify(notice: { message: string }) {
        notices.push(notice);
      },
      onInspect() {},
    };
    harness.render('SwarmWorkspace', props);
    await nextTurn();
    let view = harness.render('SwarmWorkspace', props);
    await nextTurn();
    view = harness.render('SwarmWorkspace', props);
    view.props.onSelect(root.id);
    view = harness.render('SwarmWorkspace', props);
    view.props.onDraft('Old message');
    view = harness.render('SwarmWorkspace', props);
    view.props.onSend();
    const intermediateProps = { ...props, conversation: newer };
    harness.render('SwarmWorkspace', intermediateProps);
    if (returnToOriginal) harness.render('SwarmWorkspace', props);
    const nextProps = returnToOriginal ? props : intermediateProps;
    await nextTurn();
    view = harness.render('SwarmWorkspace', nextProps);
    await nextTurn();
    view = harness.render('SwarmWorkspace', nextProps);
    view.props.onSelect(returnToOriginal ? root.id : newTask.id);
    view = harness.render('SwarmWorkspace', nextProps);
    view.props.onDraft('New message');
    view = harness.render('SwarmWorkspace', nextProps);
    view.props.onSend();
    assert.equal(submissions, 2);
    pending[0]?.({ ok: true, delivery: 'queued', workflowId: root.id });
    await nextTurn();
    view = harness.render('SwarmWorkspace', nextProps);
    assert.equal(view.props.sending, true);
    assert.equal(view.props.delivery, undefined);
    assert.equal(notices.length, 0);
    view.props.onSend();
    assert.equal(submissions, 2);
    pending[1]?.({ ok: true, delivery: 'delivered', workflowId: returnToOriginal ? root.id : newTask.id });
    await nextTurn();
    view = harness.render('SwarmWorkspace', nextProps);
    assert.equal(view.props.sending, false);
    assert.match(view.props.delivery, /已送达/);
    assert.equal(notices.length, 1);
    harness.unmount();
  });

test('the swarm sits above the conversation as a strip of avatars, with an example when nobody has joined yet', () => {
  const examples: string[] = [];
  const view = (props: Partial<Parameters<typeof SwarmWorkspaceView>[0]>) =>
    renderToStaticMarkup(
      createElement(SwarmWorkspaceView, {
        members: members(),
        communications: [],
        messages: [],
        loading: false,
        sending: false,
        draft: '',
        onSelect() {},
        onDraft() {},
        onSend() {},
        onInspect() {},
        onExample: (text: string) => examples.push(text),
        ...props,
      }),
    );
  const html = view({});
  assert.match(html, /3 位成员 · 3 位在干活/);
  assert.equal((html.match(/class="swarm-avatar running /g) ?? []).length, 3);
  assert.doesNotMatch(html, /side-sheet|textarea/, 'nothing is open: the conversation keeps its own composer');
  assert.match(html, /aria-label="主 agent · /, 'the main agent is in the strip too');
  const empty = view({ members: [] });
  assert.match(empty, /蜂群已开/);
  assert.match(empty, /给主 agent 布置任务，它会按需要拉成员进来/);
  assert.match(empty, /class="swarm-example"/);
});

test('a member shows what it heard from and said to other members, in time order with the replies', () => {
  const at = (minute: number) => `2026-10-09T12:0${minute}:00.000Z`;
  const html = renderToStaticMarkup(
    createElement(SwarmWorkspaceView, {
      members: members(),
      communications: [
        { id: 'in', from: root.id, to: child.id, text: 'Please also check the tests.', at: at(1), runId: 'root-run' },
        {
          id: 'out',
          from: child.id,
          to: grandchild.id,
          text: 'Read the parser for me.',
          at: at(2),
          runId: 'child-run',
        },
        { id: 'other', from: root.id, to: grandchild.id, text: 'NOT_FOR_THIS_MEMBER', at: at(3), runId: 'root-run' },
      ],
      selectedId: child.id,
      messages: [{ ...message('reply', child.id, 'Done, two issues found.'), createdAt: at(4) }],
      loading: false,
      sending: false,
      draft: '',
      onSelect() {},
      onRefresh() {},
      onDraft() {},
      onSend() {},
      onInspect() {},
    }),
  );
  const order = ['来自 主 agent', '发给 审查', '成员答复'].map((label) => html.indexOf(label));
  assert.ok(
    order.every((index) => index >= 0),
    order.join(),
  );
  assert.deepEqual(
    [...order].sort((a, b) => a - b),
    order,
    'messages and replies read in the order they happened',
  );
  assert.doesNotMatch(
    html.slice(html.indexOf('swarm-member-history')),
    /NOT_FOR_THIS_MEMBER<\/p><\/div><\/article>/,
    'a message between two other members is not part of this member’s history',
  );
});

test('avatars show one Chinese character or a few letters of an English name, with a stable colour per name', () => {
  assert.equal(avatarText('后端审查'), '后');
  assert.equal(avatarText('Test Review'), 'TR');
  assert.equal(avatarText('Codex B'), 'CB');
  assert.equal(avatarText('Grok'), 'Grok');
  assert.equal(avatarText('Claude'), 'Cla');
  assert.equal(avatarText('  '), '?');
  assert.equal(avatarTone('后端审查'), avatarTone('后端审查'));
});

test('member messages appear inside the conversation like group-chat lines, between the rows by time', () => {
  const lines = swarmChatLines(members(), [
    { id: 'm', from: root.id, to: child.id, text: 'Please also check the tests.', at: at, runId: 'root-run' },
  ]);
  assert.deepEqual(
    lines.map((line) => [line.from, line.to, line.text]),
    [['主 agent', '调查', 'Please also check the tests.']],
  );
  const short = renderToStaticMarkup(createElement(SwarmChatLineView, { line: lines[0]! }));
  assert.match(short, /class="swarm-chat-line"/);
  assert.match(short, /主 agent.*→.*调查/s);
  const long = renderToStaticMarkup(
    createElement(SwarmChatLineView, { line: { ...lines[0]!, text: 'Long finding. '.repeat(40) } }),
  );
  assert.match(long, /<details class="swarm-chat-line">/, 'a long message folds to one line');
});

test('opening a member slides its sheet over the conversation, which stays in place underneath', async () => {
  const reported: number[] = [];
  const api: Api = async <T>(path: string) => {
    if (path.endsWith('/swarm')) return { workflows: tasks } as T;
    if (path.endsWith('/execution-record')) return { workflow: root, runs: [], relatedRuns: [] } as T;
    return { messages: [] } as T;
  };
  const harness = uiHarness(await uiBundle('src/ui/SwarmWorkspace.tsx'));
  const props = {
    state,
    conversation,
    api,
    reload: async () => {},
    notify() {},
    onInspect() {},
    onLines: (lines: unknown[]) => reported.push(lines.length),
  };
  harness.render('SwarmWorkspace', props);
  await nextTurn();
  let view = harness.render('SwarmWorkspace', props);
  view.props.onSelect(child.id);
  view = harness.render('SwarmWorkspace', props);
  assert.equal(view.props.selectedId, child.id);
  view.props.onSelect(undefined);
  view = harness.render('SwarmWorkspace', props);
  assert.equal(view.props.selectedId, undefined);
  assert.ok(reported.length > 0, 'the conversation is told which member lines to show');
  harness.unmount();
});
