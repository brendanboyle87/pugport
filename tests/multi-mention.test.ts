import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { builtinAgentPresets } from '../src/shared/agent-presets.ts';
import { findMentions, mentionPrefixAt, withoutMentionName } from '../src/shared/mentions.ts';
import {
  calledFields,
  namedIn,
  stillNamed,
  withParticipant,
  withoutCalledName,
  type CalledParticipant,
} from '../src/shared/participants.ts';
import { ComposerSession } from '../src/ui/composer-session.ts';
import { MentionMenu, mentionItems, mentionSections, type MentionItem } from '../src/ui/Mentions.tsx';
import { mentionItems as terminalItems, PugAutocomplete } from '../src/cli/mentions.ts';
import { ConversationHistory } from '../src/ui/Workspace.tsx';
import { swarmMemberMessages } from '../src/ui/SwarmWorkspace.tsx';
import type { AppState, ConversationMessage, RuntimeTarget, Workflow } from '../src/shared/types.ts';
import { findNode, nextTurn, uiBundle, uiHarness } from './helpers/ui-harness.ts';

// Synthetic only: fixture roles, cards, agents and devices; nothing is sent anywhere.
const role = (id: string, name: string): CalledParticipant => ({ kind: 'role', id, name });
const card = (id: string, provider: RuntimeTarget['provider'], label: string): RuntimeTarget => ({
  id,
  provider,
  label,
  command: 'unused',
  environment: 'native',
  enabled: true,
});

test('tiered parser respects boundaries, longest names and minimum tiers', () => {
  const candidates = [
    { name: 'Claude', minTier: 1 as const, id: 'executor' },
    { name: 'Claude B', minTier: 1 as const, id: 'long-executor' },
    { name: 'Claude', minTier: 2 as const, id: 'device' },
    { name: 'Mac-mini', minTier: 2 as const, id: 'mac' },
    { name: 'Muse', minTier: 2 as const, id: 'muse' },
    { name: 'Grok Bot', minTier: 2 as const, id: 'bot' },
    { name: '代码审查', minTier: 1 as const, id: 'role' },
  ];
  const cases: [string, string[]][] = [
    ['请@Claude 看', ['executor']],
    ['请@@Claude 看', ['device']],
    ['@@@Claude', ['device']],
    ['@@Claude B 看', ['long-executor']],
    ['，@@Mac-mini 跑', ['mac']],
    ['@@代码审查 看', ['role']],
    ['@@Muse 查 @@Grok Bot 看', ['muse', 'bot']],
    ['@Muse 那个功能挺好', []],
    ['@@@@Claude', []],
    ['@Claude的方案', []],
    ['mail@Claude', []],
    ['path/@Claude', []],
    ['`@@Muse`', []],
    ['"@@Muse"', []],
    ['user:pass@Claude', []],
    ['@@@fixture-vps', []],
  ];
  for (const [input, expected] of cases)
    assert.deepEqual(
      findMentions(input, candidates).map(({ item }) => item.id),
      expected,
      input,
    );
  assert.deepEqual(mentionPrefixAt('请@@Mac', 6), { start: 1, tier: 2, query: 'Mac' });
  assert.equal(mentionPrefixAt('@@@@', 4), undefined);
  assert.equal(mentionPrefixAt('path/@x', 7), undefined);
  assert.equal(withoutMentionName('请@@Mac-mini 跑', 'Mac-mini'), '请跑');
  assert.equal(withoutMentionName('path/@@Mac-mini 跑', 'Mac-mini'), 'path/@@Mac-mini 跑');
  const device = { kind: 'device' as const, id: 'device:mac', name: 'Mac-mini' };
  assert.deepEqual(stillNamed([device], '@Mac-mini 跑'), []);
  assert.deepEqual(stillNamed([device], '@@Mac-mini 跑'), [device]);
});

test('a server participant remains called only with three at signs', () => {
  const server = { kind: 'device' as const, id: 'device:server', name: 'fixture-server', tier: 3 as const };
  const called = withParticipant([], server);
  assert.deepEqual(stillNamed(called, '@@fixture-server run'), []);
  assert.deepEqual(stillNamed(called, '@@@fixture-server run'), [server]);
});

test('the called list keeps the picking order, never twice, and a name deleted from the text drops its call', () => {
  let called = withParticipant([], role('code-review', '代码审查'));
  called = withParticipant(called, { kind: 'executor', id: 'codex-b', name: 'Codex B' });
  called = withParticipant(called, { kind: 'executor', id: 'codex', name: 'Codex' });
  called = withParticipant(called, role('code-review', '代码审查'));
  assert.deepEqual(
    called.map((item) => item.id),
    ['code-review', 'codex-b', 'codex'],
  );
  const text = '@代码审查 先看一遍，@Codex B 再改';
  // "@Codex B" is in the text; a separately called "Codex" is not, even though "@Codex" appears inside it.
  assert.deepEqual(
    stillNamed(called, text).map((item) => item.id),
    ['code-review', 'codex-b'],
  );
  assert.deepEqual(
    stillNamed(called, `${text}，@Codex 最后检查`).map((item) => item.id),
    ['code-review', 'codex-b', 'codex'],
    'order stays the picking order',
  );
  assert.deepEqual(stillNamed(called, '先看一遍'), []);
  assert.equal(stillNamed(called, '@代码审查员 看看').length, 0, 'a longer word is not the name');
  assert.equal(withoutCalledName('@代码审查 先看，@Codex B 再改', 'Codex B'), '@代码审查 先看，再改');
  assert.equal(withoutCalledName('@代码审查 先看 @Codex B 再改', 'Codex B'), '@代码审查 先看 再改');
  assert.equal(withoutCalledName('@代码审查 先看', '代码审查'), '先看');
  assert.equal(withoutCalledName('请@代码审查 先看', '代码审查'), '请先看', 'right after Chinese text too');
  assert.equal(withoutCalledName('mail@代码审查 先看', '代码审查'), 'mail@代码审查 先看', 'never inside an address');
  assert.equal(withoutCalledName('@Codex B 改，@Codex 查', 'Codex', called), '@Codex B 改，查');
});

test('one called answers by itself exactly as before; two or more are sent as one list for a coordinator', () => {
  assert.deepEqual(calledFields([]), {});
  assert.deepEqual(calledFields([role('code-review', '代码审查')]), { agentPresetId: 'code-review' });
  assert.deepEqual(calledFields([{ kind: 'executor', id: 'grok', name: 'Grok' }]), { runtimeId: 'grok' });
  assert.deepEqual(calledFields([{ kind: 'external', id: 'grok-bot', name: 'Grok Bot' }]), {
    externalAgentId: 'grok-bot',
  });
  const device = { kind: 'device' as const, id: 'device:6f9619ff-8b86-4d11-b42d-00c04fc964ff', name: 'box' };
  assert.deepEqual(calledFields([device]), { deviceId: '6f9619ff-8b86-4d11-b42d-00c04fc964ff' });
  assert.deepEqual(
    calledFields([role('code-review', '代码审查'), { kind: 'external', id: 'muse', name: 'Muse' }, device]),
    {
      participants: [
        { kind: 'role', id: 'code-review' },
        { kind: 'external', id: 'muse' },
        { kind: 'device', id: '6f9619ff-8b86-4d11-b42d-00c04fc964ff' },
      ],
    },
  );
});

const everyone = (): MentionItem[] =>
  mentionItems(
    builtinAgentPresets,
    [card('grok-native', 'grok', 'Grok · 本机'), card('codex-b', 'codex', 'Codex B')],
    [
      {
        id: 'grok-bot',
        name: 'Grok Bot',
        kind: 'web',
        description: '通过它的网页版提问',
        enabled: true,
        available: true,
      },
    ],
    [{ id: '6f9619ff-8b86-4d11-b42d-00c04fc964ff', name: 'box', address: 'box', online: true }] as never,
  );

test('the @@ list: 常用 first when something was called, then one group per kind, each by use and recency', () => {
  const items = everyone();
  const fresh = mentionSections(items, '', {});
  assert.deepEqual(
    fresh.map((section) => section.title),
    ['角色', '执行器', '设备', '外部智能体'],
    'no 常用 before anything was called',
  );
  const usage = {
    'executor:codex-b': { count: 5, last: 1 },
    'code-review': { count: 3, last: 9 },
    investigation: { count: 3, last: 4 },
    'external:grok-bot': { count: 1, last: 2 },
    'third-party-review': { count: 1, last: 8 },
  };
  const sections = mentionSections(items, '', usage);
  assert.deepEqual(
    sections.map((section) => section.title),
    ['常用', '角色', '执行器', '设备', '外部智能体'],
  );
  assert.deepEqual(
    sections[0]!.items.map((item) => item.name),
    ['Codex B', '代码审查', '只读调查', '第三方评审'],
    'at most four, across kinds; equal counts by recency',
  );
  const roles = sections.find((section) => section.id === 'role')!;
  assert.ok(!roles.items.some((item) => item.id === 'code-review'), 'what is in 常用 is not listed twice');
  assert.equal(sections.find((section) => section.id === 'executor')!.items[0]!.name, 'Grok');
  assert.equal(
    sections.find((section) => section.id === 'external')!.items[0]!.name,
    'Grok Bot',
    'Grok Bot was used, but 常用 was already full',
  );

  // Typing filters every group, and empty groups go away.
  const typed = mentionSections(items, 'grok', usage);
  assert.deepEqual(
    typed.map((section) => [section.title, section.items.map((item) => item.name)]),
    [
      ['常用', ['Grok Bot']],
      ['执行器', ['Grok']],
    ],
  );
  assert.deepEqual(mentionSections(items, 'zzz', usage), []);

  // Already called: not in 常用, last in its own group, so it can be marked there.
  const called = new Set(['executor:codex-b', 'role:investigation']);
  const marked = mentionSections(items, '', usage, called);
  assert.ok(!marked[0]!.items.some((item) => item.id === 'codex-b'));
  assert.equal(marked.find((section) => section.id === 'executor')!.items.at(-1)!.id, 'codex-b');
  assert.equal(marked.find((section) => section.id === 'role')!.items.at(-1)!.id, 'investigation');
});

test('the list shows group titles, avatars and one line each; a kind tag only in 常用; called rows marked', () => {
  const items = everyone();
  const sections = mentionSections(
    items,
    '',
    { 'executor:codex-b': { count: 2, last: 1 } },
    new Set(['role:code-review']),
  );
  const flat = sections.flatMap((section) => section.items);
  const html = renderToStaticMarkup(
    createElement(MentionMenu, {
      items: flat,
      frequent: sections[0]!.items.length,
      called: new Set(['role:code-review']),
      active: 0,
      onHover() {},
      onPick() {},
      onCreate() {},
    }),
  );
  for (const title of ['常用', '角色', '执行器', '设备', '外部智能体']) assert.match(html, new RegExp(`>${title}<`));
  assert.equal((html.match(/class="mention-kind"/g) ?? []).length, 1, 'only the 常用 row says what kind it is');
  assert.match(html, /class="avatar /);
  assert.match(html, /aria-disabled="true"[^>]*class="mention-row role[^"]*called/);
  assert.match(html, /已叫/);
  assert.match(html, /新建角色/);
  assert.equal((html.match(/aria-selected="true"/g) ?? []).length, 1);
  const empty = renderToStaticMarkup(
    createElement(MentionMenu, { items: [], active: -1, onHover() {}, onPick() {}, onCreate() {} }),
  );
  assert.match(empty, /没有匹配的角色或智能体/);
});

// ---- In the composer.

let code: string;
before(async () => {
  code = await uiBundle('src/ui/Workspace.tsx');
});
const stamp = '2026-10-11T12:00:00Z';
const conversation = { id: 'a', projectId: 'project', title: 'a', createdAt: stamp, updatedAt: stamp };
const state = {
  app: { name: 'Fixture', version: 'test', platform: 'win32', dataDir: 'fixture' },
  projects: [],
  conversations: [conversation],
  runs: [],
  workflows: [],
  conversationMessages: [],
  targets: [card('grok-native', 'grok', 'Grok · 本机')],
  runtimes: [],
  approvals: [],
  plugins: [],
  settings: { toolApprovalMode: 'auto', executionPolicy: 'cli-first' },
};
const key = (name: string, extra: Record<string, unknown> = {}) => ({
  key: name,
  shiftKey: false,
  altKey: false,
  repeat: false,
  preventDefault() {},
  nativeEvent: { isComposing: false, keyCode: 0 },
  ...extra,
});

function composer(bodies: any[], remoteServers: unknown[] = []) {
  const session = new ComposerSession();
  const api = async (path: string, body: any) => {
    if (path.endsWith('/messages')) {
      bodies.push(body);
      return {
        message: {
          id: `m${bodies.length}`,
          conversationId: 'a',
          role: 'user',
          content: body.content,
          createdAt: stamp,
        },
      };
    }
    if (path === '/api/external-agents')
      return {
        agents: [{ id: 'muse', name: 'Muse', kind: 'web', description: '网页版', enabled: true, available: true }],
      };
    if (path === '/api/devices') return { devices: [] };
    if (path === '/api/remote-servers' || path === '/api/remote-servers?refresh=instabox')
      return { servers: remoteServers };
    return { messages: [] };
  };
  const harness = uiHarness(code);
  const props = {
    state,
    api,
    conversation,
    composerSession: session,
    notify() {},
    onConversation() {},
    onAddProject() {},
    onMemory() {},
    onInspect() {},
  };
  const render = () => harness.render('ConversationWorkspace', props);
  const node = (check: Parameters<typeof findNode>[1]) => findNode(render(), check);
  const input = () => node((value) => value.type === 'textarea' && value.props.id === 'conversation-input')!;
  const menu = () => node((value) => value.type?.name === 'MentionMenu');
  return {
    session,
    harness,
    input,
    menu,
    node,
    type(text: string) {
      input().props.onChange({ target: { value: text, selectionStart: text.length } });
    },
    press(name: string) {
      input().props.onKeyDown(key(name));
    },
    submit() {
      node((value) => value.type === 'form' && value.props.className.includes('conversation-composer'))!.props.onSubmit(
        {
          preventDefault() {},
        },
      );
    },
    draft: () => session.getSnapshot().drafts['conversation:a']!,
  };
}

test('in the composer: several called with @@, shown as tags, sent together as one coordinated message', async () => {
  const bodies: any[] = [];
  const view = composer(bodies);
  view.type('@代码');
  view.menu()!.props.onPick(view.menu()!.props.items.find((item: MentionItem) => item.id === 'code-review'));
  view.type(`${view.input().props.value}先审查，@Gr`);
  const grok = view.menu()!.props.items.find((item: MentionItem) => item.kind === 'executor');
  view.menu()!.props.onPick(grok);
  assert.equal(view.input().props.value, '@代码审查 先审查，@Grok ');
  view.type('@代码审查 先审查，@Grok 再修 @@');
  await nextTurn();
  view.input();
  // The agent list arrives a moment after the list opens.
  await nextTurn();
  const open = view.menu()!;
  assert.deepEqual([...open.props.called], ['role:code-review', 'executor:grok-native'], 'called ones are marked');
  const muse = open.props.items.find((item: MentionItem) => item.id === 'muse');
  assert.ok(!open.props.items.some((item: MentionItem) => item.id === 'code-review'), 'roles are not shown in tier 2');
  view.menu()!.props.onPick(muse);
  assert.deepEqual(
    Array.from(view.draft().called!, (item) => item.name),
    ['代码审查', 'Grok', 'Muse'],
  );
  const text = '@代码审查 先审查，@Grok 再修，@@Muse 起个标题';
  view.type(text);
  const tag = view.node(
    (value) =>
      value.props?.className === 'composer-tag mention' &&
      value.props.children?.[0]?.props?.translate === 'no' &&
      value.props.children[0].props.children?.[1] === 'Muse',
  );
  assert.ok(tag, 'every called one has its tag');
  view.submit();
  await nextTurn();
  assert.deepEqual(JSON.parse(JSON.stringify(bodies[0].participants)), [
    { kind: 'role', id: 'code-review' },
    { kind: 'executor', id: 'grok-native' },
    { kind: 'external', id: 'muse' },
  ]);
  assert.equal(bodies[0].agentPresetId, undefined, 'no single role pin');
  assert.equal(bodies[0].runtimeId, undefined, 'no single executor pin');
  assert.equal(bodies[0].externalAgentId, undefined);
  assert.equal(bodies[0].content, text);
  assert.equal(view.draft().called, undefined, 'the calls are used up');
  view.harness.unmount();
  view.session.dispose();
});

test('in the composer: deleting a name drops its call, the tag × removes it, and one left answers by itself', async () => {
  const bodies: any[] = [];
  const view = composer(bodies);
  view.type('@代码');
  view.menu()!.props.onPick(view.menu()!.props.items.find((item: MentionItem) => item.id === 'code-review'));
  view.type(`${view.input().props.value}@Gr`);
  view.menu()!.props.onPick(view.menu()!.props.items.find((item: MentionItem) => item.kind === 'executor'));
  view.type('@代码审查 @Grok 看看');
  assert.equal(view.draft().called!.length, 2);
  view.type('@代码审查 看看');
  assert.deepEqual(
    Array.from(view.draft().called!, (item) => item.id),
    ['code-review'],
  );
  view.type(`${view.input().props.value} @Gr`);
  view.menu()!.props.onPick(view.menu()!.props.items.find((item: MentionItem) => item.kind === 'executor'));
  const remove = view.node((value) => value.type === 'button' && value.props['aria-label'] === '不叫 代码审查')!;
  remove.props.onClick();
  assert.equal(view.input().props.value, '看看 @Grok ');
  assert.deepEqual(
    Array.from(view.draft().called!, (item) => item.id),
    ['grok-native'],
  );
  view.submit();
  await nextTurn();
  assert.equal(bodies[0].runtimeId, 'grok-native', 'one executor answers by itself, as before');
  assert.equal(bodies[0].participants, undefined);
  view.harness.unmount();
  view.session.dispose();
});

test('in the composer: arrows move across groups past called rows, Enter picks, Esc closes', async () => {
  const view = composer([]);
  view.type('@');
  const first = view.menu()!;
  assert.equal(first.props.active, 0);
  const names = first.props.items.map((item: MentionItem) => item.name);
  view.press('ArrowDown');
  assert.equal(view.menu()!.props.active, 1);
  view.press('Enter');
  assert.equal(view.draft().called![0]!.name, names[1]);
  view.type(`${view.input().props.value}@`);
  assert.equal(view.menu()!.props.active, 0);
  // The called row now sits last among the roles, marked; the arrows step over it.
  const rows = view.menu()!.props.items as MentionItem[];
  const taken = rows.findIndex((item) => item.name === names[1]);
  assert.ok(taken > 0 && rows[taken + 1], 'it is still in the list, with rows after it');
  view.menu()!.props.onHover(taken - 1);
  view.press('ArrowDown');
  assert.equal(view.menu()!.props.active, taken + 1, 'the called row is stepped over going down');
  view.press('ArrowUp');
  assert.equal(view.menu()!.props.active, taken - 1, 'and going up');
  view.menu()!.props.onHover(0);
  view.press('ArrowUp');
  assert.equal(view.menu()!.props.active, rows.length - 1, 'up from the top wraps to the end');
  view.press('Enter');
  assert.equal(view.draft().called!.length, 2);
  view.type(`${view.input().props.value}，@`);
  assert.ok(view.menu(), 'right after Chinese punctuation @@ opens the list too');
  view.press('Escape');
  assert.equal(view.menu(), undefined);
  view.harness.unmount();
  view.session.dispose();
});

test('the 「+」 menu has one item that puts @@ at the caret and opens the list', () => {
  const view = composer([]);
  view.type('帮我看看');
  view.node((value) => value.type === 'button' && value.props['aria-label'] === '添加和更多')!.props.onClick();
  const item = view.node(
    (value) =>
      value.props?.role === 'menuitem' && !!findNode(value, (child) => child.props.children === '叫一个角色或智能体'),
  );
  assert.ok(item, 'the item is in the 「+」 menu');
  item.props.onClick();
  assert.equal(view.input().props.value, '帮我看看 @', 'a space keeps @ at a word start');
  assert.ok(view.menu(), 'the list is open');
  assert.equal(
    view.node((value) => value.props?.className === 'composer-menu'),
    undefined,
    'the 「+」 menu closed',
  );
  view.menu()!.props.onPick(view.menu()!.props.items.find((entry: MentionItem) => entry.id === 'code-review'));
  assert.equal(view.input().props.value, '帮我看看 @代码审查 ');
  view.harness.unmount();
  view.session.dispose();
});

// ---- In the conversation.

const task = (id: string, patch: Partial<Workflow> = {}): Workflow => ({
  id,
  conversationId: 'a',
  projectId: 'project',
  userMessageId: `user-${id}`,
  input: { content: `Fixture ${id}`, mode: 'chat', permissionMode: 'read-only', executionPolicy: 'cli-first' },
  status: 'completed',
  phase: 'summarize',
  plan: [],
  runIds: [],
  memoryRevision: 0,
  memoryExcerpt: '',
  createdAt: stamp,
  updatedAt: stamp,
  ...patch,
});
const said = (id: string, role: 'user' | 'assistant', content: string, extra: Partial<ConversationMessage> = {}) =>
  ({ id, conversationId: 'a', role, content, createdAt: stamp, ...extra }) as ConversationMessage;
const participants = [
  { kind: 'role' as const, id: 'code-review', name: '代码审查', agent: '代码审查' },
  { kind: 'external' as const, id: 'grok-bot' as const, name: 'Grok Bot', agent: 'Grok Bot', thirdParty: true },
];

test('in the conversation: each part is labelled with who did it, and a web reply keeps its third-party panel', () => {
  const root = task('root', {
    input: { ...task('x').input, content: '@代码审查 审查，@Grok Bot 起口号', swarm: true, participants },
    finalMessageId: 'final',
  });
  const reviewer = task('reviewer', {
    delegation: {
      parentId: 'root',
      role: 'scout',
      requestId: 'r1',
      agent: { label: '代码审查', presetId: 'code-review' },
    },
    agentPreset: builtinAgentPresets.find((preset) => preset.id === 'code-review')!,
    finalMessageId: 'reviewer-answer',
  });
  const web = task('web', {
    delegation: {
      parentId: 'root',
      role: 'scout',
      requestId: 'r2',
      agent: { label: 'Grok Bot', externalAgentId: 'grok-bot' },
    },
    finalMessageId: 'web-answer',
  });
  const html = renderToStaticMarkup(
    createElement(ConversationHistory, {
      messages: [
        said('user-root', 'user', '@代码审查 审查，@Grok Bot 起口号', { workflowId: 'root' }),
        said('user-reviewer', 'user', '审查 parser', { workflowId: 'reviewer' }),
        said('reviewer-answer', 'assistant', '结论：没问题', { workflowId: 'reviewer' }),
        said('user-web', 'user', '起一句口号', { workflowId: 'web' }),
        said('web-answer', 'assistant', '口号在这里', {
          workflowId: 'web',
          externalAgent: {
            agentId: 'grok-bot',
            name: 'Grok Bot',
            status: 'done',
            request: '起一句口号',
            updatedAt: stamp,
            untrusted: true,
          },
        }),
        said('final', 'assistant', '## 代码审查\n没问题', { workflowId: 'root' }),
      ],
      workflows: [root, reviewer, web],
      state: { runs: [], workflows: [], targets: [], runtimes: [], settings: {} } as unknown as AppState,
      api: async <T>() => ({}) as T,
      notify() {},
      onInspect() {},
    }),
  );
  assert.match(html, /<strong translate="no">代码审查<\/strong>/, 'the role names its part');
  assert.match(html, /<strong translate="no">Grok Bot<\/strong>/);
  assert.match(html, /第三方回复/);
});

test('in the conversation: a combined answer takes the coordinator’s place, which the swarm panel keeps', () => {
  const root = task('root', {
    input: { ...task('x').input, content: '@代码审查 审查，@Grok Bot 起口号', swarm: true, participants },
    finalMessageId: 'combined',
  });
  const messages = [
    said('user-root', 'user', '@代码审查 审查，@Grok Bot 起口号', { workflowId: 'root' }),
    said('own', 'assistant', '协调者自己的答复', { workflowId: 'root', replacedBy: 'combined' }),
    said('combined', 'assistant', '合并后的答复', { workflowId: 'root', combinedFrom: ['Grok Bot'] }),
  ];
  const html = renderToStaticMarkup(
    createElement(ConversationHistory, {
      messages,
      workflows: [root],
      state: { runs: [], workflows: [], targets: [], runtimes: [], settings: {} } as unknown as AppState,
      api: async <T>() => ({}) as T,
      notify() {},
      onInspect() {},
    }),
  );
  assert.doesNotMatch(html, /协调者自己的答复/);
  assert.match(html, /合并后的答复/);
  assert.match(html, /这条答复用到了 Grok Bot 的第三方回复/);
  const coordinator = { workflowIds: ['root'] } as Parameters<typeof swarmMemberMessages>[0];
  assert.deepEqual(
    swarmMemberMessages(coordinator, messages)
      .map((message) => message.id)
      .sort(),
    ['combined', 'own', 'user-root'],
  );
});

test('in the conversation: a message that called several shows its team as the swarm view does', () => {
  const root = task('root', { input: { ...task('x').input, swarm: true, participants } });
  const viewFor = (workflows: Workflow[], scope: 'project' | 'chat' = 'project') => {
    const harness = uiHarness(code);
    const project = {
      id: conversation.projectId,
      name: 'Synthetic project',
      path: 'C:/Synthetic',
      scope,
      createdAt: stamp,
      updatedAt: stamp,
    };
    const tree = harness.render('ConversationWorkspace', {
      state: { ...state, workflows, projects: [project] },
      api: async () => ({ messages: [], workflows }),
      project,
      conversation,
      composerSession: new ComposerSession(),
      notify() {},
      onConversation() {},
      onAddProject() {},
      onMemory() {},
      onInspect() {},
    });
    return findNode(tree, (node) => node.type?.name === 'SwarmWorkspace');
  };
  assert.ok(viewFor([root]), 'members, plan and member lines as in a swarm');
  assert.equal(viewFor([task('plain')]), undefined, 'an ordinary conversation stays as it is');
  assert.equal(
    viewFor([root], 'chat'),
    undefined,
    'an ordinary chat keeps legacy participant records without child UI',
  );
});

test('file-only mention results remain visible without an empty group heading', () => {
  const props = { items: [], active: 0, onHover() {}, onPick() {}, onCreate() {}, tier: 1 as const };
  const html = renderToStaticMarkup(
    createElement(MentionMenu, { ...props, files: [{ path: 'src/app.ts', kind: 'file' }] }),
  );
  assert.match(html, /composer-command-menu/);
  assert.match(html, /src\/app\.ts/);
  const empty = renderToStaticMarkup(createElement(MentionMenu, { ...props, files: [] }));
  assert.doesNotMatch(empty, /aria-label="\u9879\u76ee\u6587\u4ef6"/);
  assert.match(empty, /\u6ca1\u6709\u5339\u914d\u7684\u6587\u4ef6\u6216\u6587\u4ef6\u5939/);
});

// ---- In the terminal.

test('terminal completion keeps tunnel devices on tier three', async () => {
  const items = terminalItems(
    [],
    [],
    [],
    [
      {
        id: 'server',
        name: 'fixture-server',
        address: '127.0.0.1',
        pairedAt: '',
        online: false,
        tunnel: { ssh: 'fixture', remotePort: 4318 },
      },
    ],
  );
  const menu = new PugAutocomplete([], () => items);
  assert.equal(await menu.getSuggestions(['@@fixture'], 0, 9), null);
  const result = await menu.getSuggestions(['@@@fixture'], 0, 10);
  assert.equal(result?.items[0]?.value, '@@@fixture-server');
});

test('server menu offers connected and unconnected servers as selectable rows', () => {
  const devices = [
    {
      id: 'server',
      name: 'fixture-server',
      address: '127.0.0.1',
      pairedAt: '',
      online: false,
      tunnel: { ssh: 'fixture', remotePort: 4318 },
    },
  ];
  const items = mentionItems([], [], [], devices);
  assert.equal(items[0]?.tier, 3);
  const html = renderToStaticMarkup(
    createElement(MentionMenu, {
      items,
      tier: 3,
      active: 0,
      onHover() {},
      onPick() {},
      onCreate() {},
      unconnectedServers: [{ name: 'other-server', ssh: 'other' }],
    }),
  );
  assert.match(html, /fixture-server/);
  assert.match(html, /other-server/);
  assert.match(html, /未接入/);
  assert.equal((html.match(/role="option"/g) ?? []).length, 2);
});

test('the terminal: several @names in one message are called in order and sent as one list', () => {
  const items = terminalItems([], [card('claude', 'claude', 'Claude · 本机'), card('codex-b', 'codex', 'Codex B')]);
  const one = namedIn('@Codex B 看看', items);
  assert.deepEqual(
    one.map((item) => item.id),
    ['codex-b'],
  );
  const many = namedIn('@代码审查 先看，然后 @@Codex B 改，最后 @claude 复查', items);
  assert.deepEqual(
    many.map((item) => item.id),
    ['code-review', 'codex-b', 'claude'],
  );
  assert.deepEqual(calledFields(many), {
    participants: [
      { kind: 'role', id: 'code-review' },
      { kind: 'executor', id: 'codex-b' },
      { kind: 'executor', id: 'claude' },
    ],
  });
  // One alone keeps its pin, as before.
  assert.equal(calledFields(one).runtimeId, 'codex-b');
});

test('unconnected server opens enrollment without inserting text and inserts it after success', async () => {
  const view = composer([], [{ name: 'box', ssh: 'fixture-box', purpose: 'synthetic purpose' }]);
  view.type('hello @@@');
  view.menu();
  await nextTurn();
  const menu = view.menu()!;
  assert.equal(menu.props.unconnectedServers.length, 1);
  menu.props.onPickServer(menu.props.unconnectedServers[0]);
  assert.equal(view.input().props.value, 'hello @@@');
  const card = view.node((node) => node.type?.name === 'ServerEnroll')!;
  assert.equal(card.props.server.purpose, 'synthetic purpose');
  card.props.onClose({ id: 'fake-id', name: 'box', tunnel: { ssh: 'fixture-box', remotePort: 4318 } });
  assert.equal(view.input().props.value, 'hello @@@box ');
  assert.equal(view.draft().called![0]!.id, 'device:fake-id');
  view.harness.unmount();
  view.session.dispose();
});

test('keyboard selects an unconnected server without editing the draft', async () => {
  const view = composer([], [{ name: 'box', ssh: 'fixture-box' }]);
  view.type('@@@');
  view.menu();
  await nextTurn();
  assert.equal(view.menu()!.props.active, 0);
  view.press('Enter');
  assert.equal(view.input().props.value, '@@@');
  assert.ok(view.node((node) => node.type?.name === 'ServerEnroll'));
  view.harness.unmount();
  view.session.dispose();
});
