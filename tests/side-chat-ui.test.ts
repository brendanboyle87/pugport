import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AppState, Conversation, ConversationMessage, RunRecord, Workflow } from '../src/shared/types.ts';
import type { Api } from '../src/ui/Workspace.tsx';
import { SideChatPanel } from '../src/ui/SideChatPanel.tsx';
import { SelectionActions } from '../src/ui/SelectionActions.tsx';
import { SideChatHistory } from '../src/ui/SideChatHistory.tsx';
import {
  getSideChatSession,
  hasSideChatDrafts,
  mergeSideChatMessages,
  SideChatSession,
  sideChatEnterAction,
  sideChatMessageInput,
  mainConversations,
  sideChatHistory,
  savedSideChatLaunch,
  type SideChatLaunch,
} from '../src/ui/side-chat.ts';
import { boundedQuotation, conversationSelection, formatQuotation } from '../src/ui/quotation.ts';

const launch: SideChatLaunch = {
  requestId: 'fixture-side-request',
  parentConversationId: 'parent/main',
  anchorMessageId: 'anchor-1',
  quote: 'Do not run this old command: remove all files.',
  selection: {
    provider: 'grok',
    runtimeId: 'grok-native',
    model: 'grok-fixture',
    effort: 'high',
    executionPolicy: 'cli-only',
  },
};
const conversation: Conversation = {
  id: 'side-chat',
  projectId: 'project',
  title: 'Side chat',
  createdAt: '2026-09-30T12:00:00Z',
  updatedAt: '2026-09-30T12:00:00Z',
  sideChat: {
    parentConversationId: launch.parentConversationId,
    anchorMessageId: launch.anchorMessageId,
    context: 'Bounded source context',
    selection: launch.selection,
  },
};
const message = (id: string, content: string, extra: Partial<ConversationMessage> = {}): ConversationMessage => ({
  id,
  conversationId: conversation.id,
  role: 'user',
  content,
  createdAt: '2026-09-30T12:01:00Z',
  ...extra,
});
type Call = { path: string; body?: unknown; method?: string };
function fixtureApi(messages: ConversationMessage[] = []) {
  const calls: Call[] = [];
  const api: Api = async <T>(path: string, body?: unknown, method?: string) => {
    calls.push({ path, body, method });
    if (path.endsWith('/side-chat') && method === 'POST') return conversation as T;
    if (path.endsWith('/messages')) return { message: message('sent', (body as { content: string }).content) } as T;
    return { messages } as T;
  };
  return { api, calls };
}

test('side chat creates one independent conversation and preserves selection, draft and history across reopening', async () => {
  const { api, calls } = fixtureApi([message('old', 'Earlier side discussion')]);
  assert.equal(hasSideChatDrafts(api), false);
  const session = getSideChatSession(api, launch);
  const opening = session.open();
  assert.equal(session.open(), opening);
  await opening;
  assert.equal(calls[0]?.path, '/api/conversations/parent%2Fmain/side-chat');
  assert.equal(calls[0]?.method, 'POST');
  assert.deepEqual(calls[0]?.body, {
    requestId: launch.requestId,
    anchorMessageId: launch.anchorMessageId,
    quote: launch.quote,
    selection: launch.selection,
  });
  assert.equal(calls[1]?.path, '/api/conversations/side-chat');
  assert.equal(calls[1]?.method, 'GET');
  session.setDraft('  Explain the selected code.  ');
  assert.equal(hasSideChatDrafts(api), true);
  const reopened = getSideChatSession(api, { ...launch });
  assert.equal(reopened, session);
  assert.equal(reopened.getSnapshot().draft, '  Explain the selected code.  ');
  const sent = await reopened.send();
  assert.equal(hasSideChatDrafts(api), false);
  assert.equal(sent.message.content, 'Explain the selected code.');
  const body = calls.find((call) => call.path.endsWith('/messages'))?.body;
  assert.deepEqual(body, {
    content: 'Explain the selected code.',
    mode: 'chat',
    permissionMode: 'read-only',
    executionPolicy: 'cli-only',
    autoEscalate: false,
    provider: 'grok',
    runtimeId: 'grok-native',
    model: 'grok-fixture',
    effort: 'high',
  });
  assert.deepEqual(
    session.getSnapshot().messages.map((item) => item.id),
    ['old', 'sent'],
  );
  await reopened.open();
  assert.equal(calls.filter((call) => call.path.endsWith('/side-chat') && call.method === 'POST').length, 1);
  assert.ok(!calls.some((call) => /cancel|resume|run|reset|handoff/.test(call.path)));
});

test('side chat automatic reply identity defaults on and honors explicit opt-out', async () => {
  const saved = message('automatic-reply', 'Saved side answer', {
    role: 'assistant',
    replyIdentity: {
      automatic: true,
      kind: 'model',
      runs: [
        {
          runId: 'saved-run',
          runtimeId: 'codex-b',
          accountLabel: 'Codex B',
          model: 'gpt-5.6-terra',
          effort: 'high',
          confirmed: true,
        },
      ],
    },
  });
  const { api } = fixtureApi([saved]);
  await getSideChatSession(api, launch).open();
  for (const enabled of [undefined, true, false]) {
    const state = {
      projects: [],
      conversations: [conversation],
      conversationMessages: [],
      workflows: [],
      runs: [],
      settings: { showAutomaticReplyIdentity: enabled },
    } as unknown as AppState;
    const html = renderToStaticMarkup(createElement(SideChatPanel, { state, api, launch, onClose() {}, notify() {} }));
    if (enabled === false) assert.doesNotMatch(html, /reply-identity/);
    else assert.match(html, /reply-identity[\s\S]*Codex B[\s\S]*gpt-5.6-terra[\s\S]*高/);
  }
});

test('side chat retries an unknown creation outcome with the same idempotency request and surfaces delivery errors', async () => {
  const calls: Call[] = [];
  let creations = 0;
  const api: Api = async <T>(path: string, body?: unknown, method?: string) => {
    calls.push({ path, body, method });
    if (path.endsWith('/side-chat') && method === 'POST') {
      if (++creations === 1) throw new Error('Temporary create transport failure');
      return conversation as T;
    }
    if (path.endsWith('/messages')) throw new Error('Native input is finishing');
    return { messages: [] } as T;
  };
  const session = new SideChatSession(api, launch);
  await assert.rejects(session.open(), /Temporary create/);
  assert.match(session.getSnapshot().error ?? '', /Temporary create/);
  await session.open();
  assert.deepEqual(calls[0]?.body, calls[1]?.body);
  session.setDraft('Keep my unsent question');
  await assert.rejects(session.send(), /Native input is finishing/);
  assert.equal(session.getSnapshot().draft, 'Keep my unsent question');
  assert.equal(session.getSnapshot().sending, false);
  assert.match(session.getSnapshot().deliveryError ?? '', /Native input/);
});

test('side chat prevents duplicate concurrent sends and preserves text typed while sending', async () => {
  const base = fixtureApi();
  let finish: ((value: unknown) => void) | undefined;
  let sends = 0;
  const api: Api = <T>(path: string, body?: unknown, method?: string) => {
    if (!path.endsWith('/messages')) return base.api<T>(path, body, method);
    sends++;
    return new Promise<T>((resolve) => {
      finish = (value) => resolve(value as T);
    });
  };
  const session = getSideChatSession(api, launch);
  await session.open();
  session.setDraft('First question');
  const pending = session.send();
  assert.equal(session.send(), pending);
  session.setDraft('');
  assert.equal(hasSideChatDrafts(api), true, 'a pending send protects reload even after clearing the next draft');
  session.setDraft('Next question');
  assert.ok(finish);
  finish({
    message: message('first', 'First question', {
      steering: { runId: 'side-run', status: 'failed', error: 'No matching native delivery receipt' },
    }),
  });
  await pending;
  assert.equal(sends, 1);
  assert.equal(session.getSnapshot().draft, 'Next question');
  assert.equal(session.getSnapshot().messages[0]?.steering?.status, 'failed');
  assert.match(session.getSnapshot().deliveryError ?? '', /receipt/);
  session.setDraft('');
  assert.equal(hasSideChatDrafts(api), false);
});

test('side chat rejects an invalid main conversation response before allowing a message', async () => {
  const { api: original, calls } = fixtureApi();
  const api: Api = async <T>(path: string, body?: unknown, method?: string) =>
    path.endsWith('/side-chat')
      ? ({ ...conversation, id: launch.parentConversationId } as T)
      : original<T>(path, body, method);
  const session = new SideChatSession(api, launch);
  await assert.rejects(session.open(), /无效的会话/);
  session.setDraft('Question');
  await assert.rejects(session.send(), /尚未连接/);
  assert.equal(calls.length, 0);
});

test('side chat SSR displays only its messages, native stream and receipt failures without creating requests', async () => {
  const ownMessage = message('side-user', 'Side question', { workflowId: 'side-workflow' });
  const { api, calls } = fixtureApi([ownMessage]);
  await getSideChatSession(api, launch).open();
  const workflow: Workflow = {
    id: 'side-workflow',
    conversationId: conversation.id,
    projectId: conversation.projectId,
    userMessageId: ownMessage.id,
    input: sideChatMessageInput(launch, ownMessage.content),
    status: 'running',
    phase: 'execute',
    plan: [],
    runIds: ['older-side-run', 'side-run'],
    memoryRevision: 0,
    memoryExcerpt: '',
    createdAt: ownMessage.createdAt,
    updatedAt: ownMessage.createdAt,
  };
  const run: RunRecord = {
    id: 'side-run',
    workflowId: workflow.id,
    stepId: 'side-step',
    prompt: ownMessage.content,
    projectPath: 'C:/Fixture',
    kind: 'general',
    status: 'running',
    route: {
      runtimeId: 'grok-native',
      model: 'grok-fixture',
      effort: 'high',
      kind: 'general',
      reasons: [],
      warnings: [],
    },
    startedAt: ownMessage.createdAt,
    output:
      'Streaming side reply <script>\n\n| 目录 | 文件 |\n| --- | --- |\n| `图片` | [a.jpg](<C:/Fixture/图片/a.jpg>) |',
    reasoning: 'Side thinking',
    events: [],
    steerAvailable: true,
    steeringStatus: { state: 'ready' },
    steeringProgress: { id: 'steer', phase: 'received', mode: 'interrupt', at: ownMessage.createdAt },
    toolApprovalMode: 'auto',
  };
  const state: AppState = {
    app: { name: 'PugPort', version: 'test', platform: 'win32', dataDir: 'fixture' },
    projects: [
      {
        id: conversation.projectId,
        name: 'Fixture',
        path: 'C:/Fixture',
        createdAt: ownMessage.createdAt,
        updatedAt: ownMessage.createdAt,
      },
    ],
    targets: [],
    runtimes: [],
    runs: [
      { ...run, id: 'main-run', workflowId: 'main-workflow', output: 'SECRET_MAIN_STREAM' },
      run,
      { ...run, id: 'older-side-run', status: 'completed', output: 'STALE_OLDER_STREAM', reasoning: undefined },
    ],
    approvals: [],
    plugins: [],
    refreshing: false,
    settings: {
      refreshSeconds: 60,
      reservePercent: 10,
      maxQuotaAgeSeconds: 120,
      preferCli: true,
      designProvider: 'codex',
      architectureProvider: 'claude',
      routineProvider: 'grok',
      unknownQuotaPolicy: 'manual-only',
      defaultProjectPath: 'C:/Fixture',
      maxConcurrentRuns: 0,
      toolApprovalMode: 'auto',
    },
    workflows: [{ ...workflow, id: 'main-workflow', conversationId: launch.parentConversationId }, workflow],
    conversationMessages: [
      message('main-user', 'SECRET_MAIN_MESSAGE', { conversationId: launch.parentConversationId }),
      message('failed-steer', 'A correction', {
        steering: { runId: run.id, status: 'failed', error: 'Delivery was not confirmed' },
      }),
      message('accepted-steer', 'Another correction', {
        steering: { runId: run.id, status: 'accepted' },
      }),
    ],
  };
  const requestCount = calls.length;
  const html = renderToStaticMarkup(createElement(SideChatPanel, { state, api, launch, onClose() {}, notify() {} }));
  assert.match(html, /独立侧聊/);
  assert.match(html, /只读/);
  assert.doesNotMatch(html, /side-chat-context|仅 CLI|独立会话，可读取|只读：只回答/);
  assert.match(html, /grok-fixture/);
  assert.match(html, /high/);
  assert.match(html, /Side thinking/);
  assert.match(html, /Streaming side reply &lt;script&gt;/);
  assert.match(html, /data-relative-path="图片"/);
  assert.match(html, /data-local-path="C:\/Fixture\/图片\/a.jpg"/);
  assert.match(html, /可补充消息/);
  assert.match(html, /Delivery was not confirmed/);
  assert.match(html, /执行器已接收补充（steer）/);
  assert.match(html, /执行器已接收补充，等待后续输出/);
  assert.doesNotMatch(html, /已开始处理补充/);
  assert.match(html, /关闭侧聊，保留任务与记录/);
  assert.ok(!html.includes('SECRET_MAIN'));
  assert.ok(!html.includes('STALE_OLDER_STREAM'));
  assert.equal(calls.length, requestCount);
  assert.equal(
    renderToStaticMarkup(
      createElement(SelectionActions, { containerRef: { current: null }, onQuote() {}, onSideChat() {} }),
    ),
    '',
  );
});

test('side chat Enter respects Shift newline and Windows IME candidate confirmation', () => {
  const enter = { key: 'Enter', shiftKey: false };
  const idle = { active: false, endedAt: -Infinity };
  assert.equal(sideChatEnterAction(enter, idle, 1000), 'send');
  assert.equal(sideChatEnterAction({ ...enter, shiftKey: true }, idle, 1000), 'newline');
  assert.equal(sideChatEnterAction({ ...enter, isComposing: true }, idle, 1000), 'composition');
  assert.equal(sideChatEnterAction({ ...enter, keyCode: 229 }, idle, 1000), 'composition');
  assert.equal(sideChatEnterAction(enter, { active: true, endedAt: -Infinity }, 1000), 'composition');
  assert.equal(sideChatEnterAction(enter, { active: false, endedAt: 950 }, 1000), 'ignore');
  assert.equal(sideChatEnterAction({ ...enter, repeat: true }, idle, 1000), 'ignore');
});

test('failed side chat receipts show one inline error in the message history', async () => {
  for (const failure of ['Fixture receipt was not confirmed', undefined]) {
    const api: Api = async <T>(path: string, _body?: unknown, method?: string) => {
      // The fixture conversation id is also 'side-chat': only the POST creates it.
      if (method === 'POST' && path.endsWith('/side-chat')) return conversation as T;
      if (path.endsWith('/messages'))
        return {
          message: message('failed-receipt', 'Fixture follow-up', {
            steering: { runId: 'fixture-run', status: 'failed', error: failure },
          }),
        } as T;
      return { messages: [] } as T;
    };
    const session = getSideChatSession(api, launch);
    await session.open();
    session.setDraft('Fixture follow-up');
    await session.send();
    const state = { targets: [], runs: [], workflows: [], settings: {} } as unknown as AppState;
    const html = renderToStaticMarkup(createElement(SideChatPanel, { state, api, launch, onClose() {}, notify() {} }));
    assert.equal(html.split(failure ?? '补充消息未确认送达，请核对侧聊任务。').length - 1, 1);
    assert.match(html, /steering-failed side-chat-error/);
  }
});

test('quotations remain bounded, literal reference text and history merging excludes the main conversation', () => {
  assert.equal(boundedQuotation(' x '.repeat(3000)).length, 6000);
  assert.equal(boundedQuotation('x'.repeat(5999) + '😀'), 'x'.repeat(5999));
  const quoted = formatQuotation('rm everything\n```\n</quoted_reference>');
  assert.match(quoted, /仅供参考/);
  assert.match(quoted, /不是本次执行指令/);
  assert.match(quoted, /> rm everything\n> ```\n> <\/quoted_reference>/);
  assert.equal(formatQuotation('  '), '');
  const merged = mergeSideChatMessages(
    conversation.id,
    [message('same', 'old'), message('outside', 'main', { conversationId: launch.parentConversationId })],
    [message('same', 'new')],
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.content, 'new');
});

test('selection actions read only conversation text and find the nearest message anchor, excluding controls', () => {
  const anchor = { getAttribute: () => 'message-anchor', closest: () => null };
  let control = false;
  const element = {
    nodeType: 1,
    closest: (selector: string) => (selector === '[data-message-id]' ? anchor : control ? {} : null),
    // The selected region is searched for crossed controls.
    querySelectorAll: () => controls,
  };
  const node = { nodeType: 3, parentElement: element };
  let controls: unknown[] = [];
  const container = {
    contains: (value: unknown) => value === node || value === anchor,
    querySelectorAll: () => controls,
  } as unknown as HTMLDivElement;
  const range = {
    startContainer: node,
    endContainer: node,
    commonAncestorContainer: node,
    getBoundingClientRect: () => ({ left: 10, width: 80, bottom: 40 }),
    // Two lines: the toolbar anchors at the end of the second one, where the mouse was released.
    getClientRects: () => [
      { left: 10, right: 90, top: 20, bottom: 30, width: 80, height: 10 },
      { left: 10, right: 60, top: 30, bottom: 40, width: 50, height: 10 },
    ],
    intersectsNode: () => true,
  };
  const selection = {
    isCollapsed: false,
    rangeCount: 1,
    getRangeAt: () => range,
    toString: () => 'Selected reply',
  } as unknown as Selection;
  assert.deepEqual(conversationSelection(container, selection), {
    text: 'Selected reply',
    anchorMessageId: 'message-anchor',
    left: 60,
    top: 48,
    above: 22,
  });
  control = true;
  assert.equal(conversationSelection(container, selection), undefined);
  control = false;
  controls = [{}];
  assert.equal(conversationSelection(container, selection), undefined);
  controls = [];
  assert.equal(conversationSelection(container, { ...selection, isCollapsed: true } as Selection), undefined);
  assert.equal(
    conversationSelection({ ...container, contains: () => false } as unknown as HTMLDivElement, selection),
    undefined,
  );
});

test('side chat is read-only by default and can be switched to write in the project', () => {
  const readOnly = sideChatMessageInput(launch, ' Question ');
  assert.equal(readOnly.permissionMode, 'read-only');
  assert.equal(readOnly.mode, 'chat');
  assert.equal(readOnly.content, 'Question');
  const writable = sideChatMessageInput(launch, 'Rename the files', 'workspace-write');
  assert.equal(writable.permissionMode, 'workspace-write');
  assert.equal(writable.mode, 'auto');
});

test('existing side discussions are excluded from ordinary conversations and grouped only under their parent history', () => {
  const main = { ...conversation, id: launch.parentConversationId, sideChat: undefined };
  const other = { ...main, id: 'other-main' };
  const newer = { ...conversation, id: 'newer-side', createdAt: '2026-10-01T12:00:00Z' };
  const otherSide = {
    ...conversation,
    id: 'other-side',
    sideChat: { ...conversation.sideChat!, parentConversationId: other.id },
  };
  const rows = [newer, main, otherSide, conversation, other];
  assert.deepEqual(
    mainConversations(rows).map((item) => item.id),
    [main.id, other.id],
  );
  assert.deepEqual(
    sideChatHistory(rows, main.id).map((item) => item.id),
    [conversation.id, newer.id],
  );
  assert.deepEqual(
    rows.map((item) => item.id),
    ['newer-side', main.id, 'other-side', conversation.id, other.id],
  );
  assert.throws(() => savedSideChatLaunch(otherSide, main.id), /不属于/);
  const html = renderToStaticMarkup(
    createElement(SideChatHistory, { conversations: sideChatHistory(rows, main.id), onOpen() {}, onNew() {} }),
  );
  assert.match(html, /aria-label="侧聊记录"/);
  assert.match(html, /侧聊记录 \(2\)/);
});

test('reopening saved side history after a fresh UI session reads only the existing conversation and does not submit a task', async () => {
  const calls: Call[] = [];
  const api: Api = async <T>(path: string, body?: unknown, method?: string) => {
    calls.push({ path, body, method });
    assert.equal(method, 'GET');
    assert.equal(path, '/api/conversations/side-chat');
    return {
      conversation,
      messages: [
        message('old-saved', 'Saved discussion'),
        message('main', 'Not side history', { conversationId: launch.parentConversationId }),
      ],
    } as T;
  };
  const saved = savedSideChatLaunch(conversation, launch.parentConversationId);
  const session = getSideChatSession(api, saved);
  await session.open();
  assert.equal(calls.length, 1);
  assert.equal(session.getSnapshot().conversation?.id, conversation.id);
  assert.deepEqual(
    session.getSnapshot().messages.map((item) => item.id),
    ['old-saved'],
  );
  assert.deepEqual(session.launch.selection, launch.selection);
  assert.equal(session.getSnapshot().permission, 'read-only');
});

test('switching between saved side records preserves the already-opened session draft and permission', async () => {
  const { api, calls } = fixtureApi();
  const original = getSideChatSession(api, launch);
  await original.open();
  original.setDraft('Unsent side draft');
  original.setPermission('workspace-write');
  const resumed = getSideChatSession(api, savedSideChatLaunch(conversation, launch.parentConversationId));
  assert.equal(resumed, original);
  assert.equal(resumed.getSnapshot().draft, 'Unsent side draft');
  assert.equal(resumed.getSnapshot().permission, 'workspace-write');
  await resumed.open();
  assert.equal(calls.filter((call) => call.method === 'POST').length, 1);
});

test('saved-history response with a wrong ID or another main parent is rejected before allowing any message', async () => {
  for (const invalid of [
    { ...conversation, id: 'other-side' },
    { ...conversation, sideChat: { ...conversation.sideChat!, parentConversationId: 'other-main' } },
  ]) {
    const api: Api = async <T>() => ({ conversation: invalid, messages: [] }) as T;
    const session = new SideChatSession(api, savedSideChatLaunch(conversation, launch.parentConversationId));
    await assert.rejects(session.open(), /无效的会话/);
    session.setDraft('Question');
    await assert.rejects(session.send(), /尚未连接/);
  }
});
