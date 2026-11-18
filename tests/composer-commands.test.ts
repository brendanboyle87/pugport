import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { insertFileReference } from '../src/ui/FileMentions.tsx';
import { mentionPrefixAt } from '../src/shared/mentions.ts';
import { filterSlashCommands, slashCommands } from '../src/ui/SlashCommands.tsx';
import { composerEnterAction } from '../src/shared/composer-enter.ts';
import { ComposerSession } from '../src/ui/composer-session.ts';
import type { CalledParticipant } from '../src/shared/participants.ts';
import { findNode, nextTurn, text, uiBundle, uiHarness } from './helpers/ui-harness.ts';

let code: string;
before(async () => {
  code = await uiBundle('src/ui/Workspace.tsx');
});
const stamp = '2026-10-13T12:00:00Z';
const chat = { id: 'chat', projectId: 'project', title: 'Fixture', createdAt: stamp, updatedAt: stamp };
function mount(settings: any = {}, running = false, globals: Record<string, unknown> = {}) {
  const writes: any[] = [],
    notices: any[] = [],
    selected: any[] = [];
  const harness = uiHarness(code, {
    setTimeout: (fn: () => void, ms: number) => (ms === 120 ? setTimeout(fn, ms) : 0),
    clearTimeout,
    ...globals,
  });
  const props: any = {
    state: {
      app: { name: 'Fixture', version: 'test', platform: 'win32', dataDir: 'fixture' },
      projects: [{ id: 'project', path: 'C:/Fixture', name: 'Fixture' }],
      conversations: [chat],
      targets: [],
      runtimes: [],
      // A running task with an open steering channel: the send tooltip shows Enter/Ctrl+Enter shortcuts.
      runs: running
        ? [
            {
              id: 'run-1',
              workflowId: 'run',
              stepId: 'step',
              status: 'running',
              steerAvailable: true,
              toolApprovalMode: 'auto',
              startedAt: stamp,
              events: [],
              output: '',
            },
          ]
        : [],
      approvals: [],
      plugins: [],
      workflows: running
        ? [
            {
              id: 'run',
              conversationId: 'chat',
              status: 'running',
              phase: 'execute',
              createdAt: stamp,
              updatedAt: stamp,
              input: {},
              runIds: ['run-1'],
              steps: [],
            },
          ]
        : [],
      conversationMessages: [
        { id: 'old', conversationId: 'chat', role: 'user', content: 'Last sent text', createdAt: stamp },
      ],
      settings: { toolApprovalMode: 'auto', executionPolicy: 'cli-first', ...settings },
    },
    conversation: chat,
    api: async (path: string, body: any, method: string) => {
      if (body !== undefined) writes.push({ path, body: structuredClone(body), method });
      if (path.includes('/files?'))
        return [
          { path: 'src/with spaces.ts', kind: 'file' },
          { path: 'src', kind: 'folder' },
        ];
      if (path.endsWith('/messages') && body)
        return {
          message: { id: 'sent', conversationId: 'chat', role: 'user', content: body.content, createdAt: stamp },
        };
      if (path === '/api/conversations') return { ...chat, id: 'new' };
      return { messages: [] };
    },
    notify: (notice: any) => notices.push(notice),
    reload: async () => {},
    onConversation: (value: any) => selected.push(value),
    onAddProject() {},
    onMemory() {},
    onInspect() {},
  };
  const render = () => harness.render('ConversationWorkspace', props);
  const node = (check: Parameters<typeof findNode>[1]) => {
    const value = findNode(render(), check);
    assert.ok(value);
    return value;
  };
  const input = () => node((n) => n.props.id === 'conversation-input');
  return {
    harness,
    props,
    writes,
    notices,
    selected,
    render,
    node,
    input,
    type(value: string, caret = value.length) {
      input().props.onChange({ target: { value, selectionStart: caret } });
    },
    key(key: string, extra: any = {}) {
      let prevented = false;
      input().props.onKeyDown({
        key,
        shiftKey: false,
        ctrlKey: false,
        nativeEvent: {},
        preventDefault() {
          prevented = true;
        },
        ...extra,
      });
      return prevented;
    },
  };
}

test('@ opens the tier-one menu; selected paths are relative references', () => {
  assert.equal(mentionPrefixAt('mail@host', 9), undefined);
  assert.equal(mentionPrefixAt('@@Codex', 7)?.query, 'Codex');
  assert.deepEqual(mentionPrefixAt('@Muse', 5), { start: 0, tier: 1, query: 'Muse' });
  assert.equal(mentionPrefixAt('@@@@Muse', 8), undefined);
  assert.deepEqual(mentionPrefixAt('@', 1), { start: 0, tier: 1, query: '' });
  assert.equal(
    insertFileReference('read @sr now', { start: 5, query: 'sr' }, { path: 'src/my file.ts', kind: 'file' }).text,
    'read "src/my file.ts"  now',
  );
  assert.equal(
    insertFileReference('@src', { start: 0, query: 'src' }, { path: 'src', kind: 'folder' }).text,
    '"src/" ',
  );
});

test('/plan applies only to the next message, forces build and preserves read-only permission', async () => {
  assert.deepEqual(
    slashCommands.map((item) => item.id),
    ['搜索', 'plan', 'side', 'new'],
  );
  assert.equal(filterSlashCommands('/plan')[0]?.id, 'plan');
  const view = mount();
  view.node((n) => n.props['aria-label'] === '添加和更多').props.onClick();
  view.node((n) => n.props.role === 'menuitemcheckbox' && text(n) === '只读').props.onClick();
  view.type('/plan');
  view.key('Enter');
  view.type('Inspect the project');
  view.key('Enter');
  await nextTurn();
  const first = view.writes.find((write) => write.path.endsWith('/messages')).body;
  assert.equal(first.planFirst, true);
  assert.equal(first.mode, 'build');
  assert.equal(first.permissionMode, 'read-only');
  view.type('Next ordinary message');
  view.key('Enter');
  await nextTurn();
  assert.equal(view.writes.filter((write) => write.path.endsWith('/messages')).at(-1).body.planFirst, undefined);
  view.harness.unmount();
});

test('/plan is ignored and the toggle is hidden in a swarm', async () => {
  const view = mount();
  view.props.conversation = { ...chat, swarm: true };
  view.node((n) => n.props['aria-label'] === '调度选项').props.onClick();
  view.node((n) => n.props.className?.startsWith('chip-more') && n.props['aria-expanded'] === false).props.onClick();
  view.type('/plan');
  view.key('Enter');
  view.type('Coordinated request');
  view.key('Enter');
  await nextTurn();
  assert.equal(view.writes.find((write) => write.path.endsWith('/messages')).body.planFirst, undefined);
  assert.equal(
    findNode(view.render(), (node) => node.type === 'input' && node.props['aria-label'] === '先计划'),
    undefined,
  );
  view.harness.unmount();
});

test('the plan toggle preserves write permission and resets after sending', async () => {
  const view = mount();

  view.node((n) => n.props['aria-label'] === '调度选项').props.onClick();
  view.node((n) => n.props.className?.startsWith('chip-more') && n.props['aria-expanded'] === false).props.onClick();
  const toggle = () => view.node((n) => n.type === 'input' && n.props['aria-label'] === '先计划');
  toggle().props.onChange({ target: { checked: true } });
  assert.equal(toggle().props.checked, true);
  view.type('Inspect the project');
  view.key('Enter');
  await nextTurn();
  const body = view.writes.find((write) => write.path.endsWith('/messages')).body;
  assert.equal(body.planFirst, true);
  assert.equal(body.mode, 'build');
  assert.equal(body.permissionMode, 'workspace-write');
  assert.equal(toggle().props.checked, false);
  view.harness.unmount();
});

test('devices, external agents and multiple called participants hide and ignore planFirst', async () => {
  const participants: CalledParticipant[][] = [
    [{ kind: 'device', id: 'fixture-device', name: 'Device' }],
    [{ kind: 'external', id: 'fixture-external', name: 'External' }],
    [
      { kind: 'executor', id: 'a', name: 'A' },
      { kind: 'executor', id: 'b', name: 'B' },
    ],
  ];
  for (const called of participants) {
    const view = mount();
    const session = new ComposerSession();
    view.props.composerSession = session;
    session.changeDraft('conversation:chat', (draft) => ({
      ...draft,
      planFirst: true,
      called,
      content: called.map((item) => `@${item.name}`).join(' ') + ' Inspect the project',
    }));
    view.node((n) => n.props['aria-label'] === '调度选项').props.onClick();
    view.node((n) => n.props.className?.startsWith('chip-more') && n.props['aria-expanded'] === false).props.onClick();
    assert.equal(
      findNode(view.render(), (n) => n.type === 'input' && n.props['aria-label'] === '先计划'),
      undefined,
    );
    view.key('Enter');
    await nextTurn();
    assert.equal(view.writes.find((write) => write.path.endsWith('/messages')).body.planFirst, undefined);
    view.harness.unmount();
    session.dispose();
  }
});

test('file menu picks a reference sent to the executor, while Escape preserves lone @ and ordinary @Muse', async () => {
  const view = mount();
  view.type('@');
  view.render();
  assert.equal(view.input().props.value, '@');
  view.key('Escape');
  assert.equal(view.input().props.value, '@');
  view.type('@Muse');
  view.key('Escape');
  assert.equal(view.input().props.value, '@Muse');
  view.type('@src');
  view.render();
  await new Promise((resolve) => setTimeout(resolve, 150));
  const menu = view.node((node) => node.type?.name === 'MentionMenu');
  assert.equal(menu.props.items.length, 0, 'no participant matches the file query');
  assert.equal(menu.props.files[0].path, 'src/with spaces.ts');
  view.key('Enter');
  assert.equal(view.input().props.value, '"src/with spaces.ts" ');
  view.key('Enter');
  await nextTurn();
  assert.equal(view.writes.find((write) => write.path.endsWith('/messages')).body.content, '"src/with spaces.ts"');
  view.harness.unmount();
});

test('slash menu selects new conversation without sending command text', async () => {
  assert.deepEqual(
    filterSlashCommands('/').map((item) => item.id),
    ['搜索', 'plan', 'side', 'new'],
  );
  assert.equal(filterSlashCommands('text /pin').length, 0);
  const view = mount();
  view.type('/new');
  view.key('Enter');
  await nextTurn();
  assert.deepEqual(view.writes.at(-1).body, { projectId: 'project' });
  assert.equal(view.selected.at(-1).id, 'new');
  assert.equal(
    view.writes.some((write) => write.path.endsWith('/messages')),
    false,
  );
  view.harness.unmount();
});
test('Ctrl and Command+Enter preserve IME safety and map send/steer/queue for both auto-steer settings', async () => {
  const idle = { active: false, endedAt: -Infinity };
  assert.equal(composerEnterAction({ key: 'Enter', shiftKey: false }, idle, 100, 'ctrl-enter'), 'newline');
  assert.equal(composerEnterAction({ key: 'Enter', shiftKey: true, ctrlKey: true }, idle, 100, 'ctrl-enter'), 'send');
  assert.equal(
    composerEnterAction({ key: 'Enter', shiftKey: false, ctrlKey: true, isComposing: true }, idle, 100, 'ctrl-enter'),
    'composition',
  );
  for (const modifier of ['ctrlKey', 'metaKey'])
    for (const steerOnSend of [true, false])
      for (const shiftKey of [true, false]) {
        const view = mount({ composerSendKey: 'ctrl-enter', steerOnSend }, true);
        view.type('Next message');
        assert.equal(view.key('Enter'), false);
        assert.equal(view.writes.length, 0);
        view.key('Enter', { [modifier]: true, shiftKey });
        await nextTurn();
        assert.equal(
          view.writes.find((write) => write.path.endsWith('/messages')).body.queue,
          steerOnSend ? shiftKey : !shiftKey,
        );
        view.harness.unmount();
      }
});

test('Command+Enter queues in Enter mode on Mac and the composer shows Mac shortcuts', async () => {
  const view = mount({ steerOnSend: true }, true);
  view.props.state.app.platform = 'darwin';
  view.type('Next message');
  view.key('Enter', { metaKey: true });
  await nextTurn();
  assert.equal(view.writes.find((write) => write.path.endsWith('/messages')).body.queue, true);
  assert.match(view.node((node) => node.props.className === 'send-button').props.title, /Cmd\+/);
  assert.equal(
    findNode(view.render(), (node) => node.props.className === 'composer-shortcuts'),
    undefined,
  );
  view.harness.unmount();
});

test('Up recalls only in an empty composer and stays scoped to the conversation', () => {
  const view = mount();
  view.key('ArrowUp');
  assert.equal(view.input().props.value, 'Last sent text');
  view.type('Editing');
  view.key('ArrowUp');
  assert.equal(view.input().props.value, 'Editing');
  view.props.conversation = { ...chat, id: 'other' };
  view.key('ArrowUp');
  assert.equal(view.input().props.value, '');
  view.harness.unmount();
});

test('/side opens the existing conversation', async () => {
  const view = mount();
  view.type('/side');
  view.key('Enter');
  assert.ok(findNode(view.render(), (n) => n.type?.name === 'SideChatPanel'));
  view.harness.unmount();
});

test('Up skips coordinator instructions and find preserves expanded history beyond 500 rows', () => {
  const view = mount({}, true);
  view.props.state.workflows[0].delegation = { parentId: 'parent', role: 'worker', requestId: 'part' };
  view.props.state.conversationMessages.push({
    id: 'delegated',
    conversationId: 'chat',
    workflowId: 'run',
    role: 'user',
    content: 'Coordinator instruction',
    createdAt: '2026-10-14T00:00:00Z',
  });
  view.key('ArrowUp');
  assert.equal(view.input().props.value, 'Last sent text');
  view.node((node) => node.type?.name === 'FindBar').props.onOpenChange(true);
  assert.equal(view.node((node) => node.props.limit !== undefined).props.limit, 500);
  view.node((node) => node.type?.name === 'FindBar').props.onOpenChange(false);
  view.node((node) => node.props.className === 'conversation-scroll').props.ref.current = {
    scrollHeight: 1000,
    scrollTop: 0,
    querySelector: () => ({}),
  };
  for (let i = 0; i < 8; i++) {
    view.node((node) => node.props.limit !== undefined).props.onShowEarlier();
  }
  const expanded = view.node((node) => node.props.limit !== undefined).props.limit;
  assert.ok(expanded > 500);
  view.node((node) => node.type?.name === 'FindBar').props.onOpenChange(true);
  assert.equal(view.node((node) => node.props.limit !== undefined).props.limit, expanded);
  view.harness.unmount();
});

test('new file queries cancel the previous request and ignore its late results', async () => {
  const view = mount();
  const requests: Array<{ signal: AbortSignal; resolve: (value: unknown) => void }> = [];
  view.props.api = (path: string, _body: unknown, _method: string, signal: AbortSignal) =>
    path.includes('/files?')
      ? new Promise((resolve) => requests.push({ signal, resolve }))
      : Promise.resolve({ messages: [] });
  view.type('@old');
  view.render();
  await new Promise((resolve) => setTimeout(resolve, 150));
  view.type('@new');
  view.render();
  assert.equal(requests[0].signal.aborted, true);
  await new Promise((resolve) => setTimeout(resolve, 150));
  requests[1].resolve([{ path: 'src/new.ts', kind: 'file' }]);
  await nextTurn();
  view.render();
  requests[0].resolve([{ path: 'src/old.ts', kind: 'file' }]);
  await nextTurn();
  const menu = view.node((node) => node.type?.name === 'MentionMenu');
  assert.equal(menu.props.files[0].path, 'src/new.ts');
  view.type('@third');
  const nextMenu = view.node((node) => node.type?.name === 'MentionMenu');
  assert.equal(nextMenu.props.files.length, 0, 'the previous query is hidden immediately');
  view.type('@@@@');
  assert.equal(
    findNode(view.render(), (node) => node.type?.name === 'MentionMenu'),
    undefined,
  );
  view.harness.unmount();
});

test('incognito slash commands hide side chat', () => {
  assert.equal(filterSlashCommands('/side', true).length, 0);
  assert.equal(filterSlashCommands('/side')[0]?.id, 'side');
});

test('search slash menu accepts Chinese and English and prepares a query without sending', () => {
  for (const command of ['/搜', '/搜索', '/sea', '/search']) assert.equal(filterSlashCommands(command)[0]?.id, '搜索');
  assert.equal(filterSlashCommands('quoted /搜索').length, 0);
  const view = mount();
  view.type('/搜索');
  view.key('Enter');
  assert.equal(view.input().props.value, '/搜索 ');
  assert.equal(view.writes.length, 0);
  view.harness.unmount();
});

test('inserting a slash before an existing question opens commands and search preserves the whole draft', () => {
  for (const [prefix, suffix] of [
    ['/', '给我网址，和成本'],
    ['/sea', 'AWS Solutions Architect\n比较培训成本'],
    ['/搜', '  保留这些空格和换行\n下一行'],
  ]) {
    const view = mount();
    view.type(suffix!);
    view.type(prefix! + suffix!, prefix!.length);
    const menu = view.node((node) => node.type?.name === 'SlashCommands');
    assert.equal(menu.props.text, prefix);
    menu.props.onRun('搜索');
    assert.equal(view.input().props.value, '/搜索 ' + suffix);
    assert.equal(view.writes.length, 0);
    view.harness.unmount();
  }
});

test('moving the caret updates slash suggestions and non-search actions keep the following text', async () => {
  const view = mount();
  const body = '保留正文\n还有下一行';
  view.type('/plan' + body, '/plan'.length);
  view.input().props.onSelect({ currentTarget: { value: '/plan' + body, selectionStart: 2 } });
  assert.equal(view.node((node) => node.type?.name === 'SlashCommands').props.text, '/p');
  view.input().props.onSelect({ currentTarget: { value: '/plan' + body, selectionStart: 5 } });
  view.key('Enter');
  await nextTurn();
  assert.equal(view.input().props.value, body);
  view.type('网址 https://example.com/', 24);
  assert.equal(
    findNode(view.render(), (node) => node.type?.name === 'SlashCommands'),
    undefined,
  );
  view.harness.unmount();
});

test('explicit search sends original command without runtime, plan or verification actions', async () => {
  const view = mount();
  const session = new ComposerSession();
  view.props.composerSession = session;
  session.changeDraft('conversation:chat', (draft) => ({
    ...draft,
    content: '/搜索 Typescript 2026',
    planFirst: true,
    writer: { runtimeId: 'unavailable', model: 'missing', effort: 'high', label: 'Unavailable' },
  }));
  assert.equal(view.node((n) => n.props['aria-label'] === '发送消息').props.disabled, false);
  view.key('Enter', { nativeEvent: { isComposing: true } });
  assert.equal(view.writes.length, 0);
  view.key('Enter');
  await nextTurn();
  const body = view.writes.find((write) => write.path.endsWith('/messages')).body;
  assert.equal(body.content, '/搜索 Typescript 2026');
  for (const key of ['runtimeId', 'model', 'effort', 'planFirst', 'verificationCommand', 'schedule'])
    assert.equal(body[key], undefined);
  view.type('/search official docs');
  view.key('Enter');
  await nextTurn();
  assert.equal(
    view.writes.filter((write) => write.path.endsWith('/messages')).at(-1).body.content,
    '/search official docs',
  );
  view.type('Ordinary chat');
  session.changeDraft('conversation:chat', (draft) => ({
    ...draft,
    writer: { runtimeId: 'unavailable', model: 'missing', effort: 'high', label: 'Unavailable' },
  }));
  assert.equal(view.node((n) => n.props['aria-label'] === '发送消息').props.disabled, true);
  const count = view.writes.length;
  view.key('Enter');
  await nextTurn();
  assert.equal(view.writes.length, count);
  assert.match(view.notices.at(-1).message, /不可用/);
  view.harness.unmount();
  session.dispose();
});

test('direct search accepts quoted text and keeps its note and source in the original request', async () => {
  const view = mount();
  const session = new ComposerSession();
  view.props.composerSession = session;
  session.changeDraft('conversation:chat', (draft) => ({
    ...draft,
    content: '/搜索 给我网址，和成本',
    planFirst: true,
    writer: { runtimeId: 'unavailable', model: 'missing', effort: 'high', label: 'Unavailable' },
    quotes: [
      { id: 'quote', text: '云厂商认证（AWS Solutions Architect、Azure、GCP）', note: '查官方资料', messageId: 'old' },
    ],
  }));
  view.key('Enter');
  await nextTurn();
  const body = view.writes.find((write) => write.path.endsWith('/messages')).body;
  assert.equal(body.content, '/搜索 给我网址，和成本');
  assert.deepEqual(body.quotes, [
    { text: '云厂商认证（AWS Solutions Architect、Azure、GCP）', note: '查官方资料', messageId: 'old' },
  ]);
  for (const key of ['runtimeId', 'model', 'effort', 'planFirst', 'verificationCommand', 'schedule'])
    assert.equal(body[key], undefined);
  assert.equal(session.getSnapshot().drafts['conversation:chat'].quotes?.length ?? 0, 0);
  view.harness.unmount();
  session.dispose();
});

test('a quoted-only search submits the bare command and quote without executor or workflow overrides', async () => {
  for (const command of ['/搜索', '/search']) {
    const view = mount();
    const session = new ComposerSession();
    view.props.composerSession = session;
    const quote = {
      id: 'quote',
      text: '海外有没有类似的倒卖球鞋受罚或封店的新闻？',
      note: '给出来源',
      messageId: 'old',
    };
    session.changeDraft('conversation:chat', (draft) => ({
      ...draft,
      content: command,
      quotes: [quote],
      planFirst: true,
      writer: { runtimeId: 'unavailable', model: 'missing', effort: 'high', label: 'Unavailable' },
    }));
    assert.equal(view.node((node) => node.props['aria-label'] === '发送消息').props.disabled, false);
    view.key('Enter');
    await nextTurn();
    const body = view.writes.find((write) => write.path.endsWith('/messages'))?.body;
    assert.ok(body);
    assert.equal(body.content, command);
    assert.deepEqual(body.quotes, [{ text: quote.text, note: quote.note, messageId: quote.messageId }]);
    for (const key of ['runtimeId', 'model', 'effort', 'planFirst', 'verificationCommand', 'schedule'])
      assert.equal(body[key], undefined);
    assert.equal(session.getSnapshot().drafts['conversation:chat'].quotes?.length ?? 0, 0);
    view.harness.unmount();
    session.dispose();
  }
});

test('a full search paragraph crosses the composer request unchanged instead of imposing the provider query limit', async () => {
  const view = mount();
  const question = '步云的美国卖家仿冒纠纷背景。'.repeat(12) + 'Sneaker Weekly Stridewell Kicksboard 具体什么原因？';
  assert.ok(Array.from(question).length > 128);
  view.type('/搜索 ' + question);
  view.key('Enter');
  await nextTurn();
  const body = view.writes.find((write) => write.path.endsWith('/messages'))?.body;
  assert.ok(body);
  assert.equal(body.content, '/搜索 ' + question);
  assert.equal(view.notices.length, 0);
  view.harness.unmount();
});

test('direct search still preserves file and mixed quoted drafts with a clear attachment-only error', async () => {
  for (const quoted of [false, true]) {
    const view = mount();
    const session = new ComposerSession();
    view.props.composerSession = session;
    session.changeDraft('conversation:chat', (draft) => ({
      ...draft,
      content: '/搜索 docs',
      attachments: [{ id: 'file', file: new File(['fixture'], 'source.txt') }],
      ...(quoted ? { quotes: [{ id: 'quote', text: 'quoted evidence' }] } : {}),
    }));
    view.key('Enter');
    await nextTurn();
    assert.equal(view.writes.length, 0);
    assert.equal(view.input().props.value, '/搜索 docs');
    assert.match(view.notices.at(-1).message, /文件或图片附件/);
    assert.equal(session.getSnapshot().drafts['conversation:chat'].attachments?.length, 1);
    assert.equal(session.getSnapshot().drafts['conversation:chat'].quotes?.length ?? 0, Number(quoted));
    view.harness.unmount();
    session.dispose();
  }
});

test('sending a project draft waits for leaving confirmation and preserves a cancelled draft', async () => {
  const view = mount();
  view.props.conversation = undefined;
  view.props.project = view.props.state.projects[0];
  let confirm!: (allowed: boolean) => void;
  view.props.onBeforeSend = () =>
    new Promise<boolean>((resolve) => {
      confirm = resolve;
    });
  view.type('Synthetic project draft');
  view.key('Enter');
  await nextTurn();
  assert.equal(view.writes.length, 0);
  confirm(false);
  await nextTurn();
  assert.equal(view.writes.length, 0);
  assert.equal(view.input().props.value, 'Synthetic project draft');
  view.key('Enter');
  await nextTurn();
  assert.equal(view.writes.length, 0);
  confirm(true);
  await nextTurn();
  assert.deepEqual(
    view.writes.map((write) => write.path),
    ['/api/conversations', '/api/conversations/new/messages'],
  );
  assert.equal(view.writes[1].body.content, 'Synthetic project draft');
  view.harness.unmount();
});
