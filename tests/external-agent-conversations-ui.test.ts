import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { ComposerSession } from '../src/ui/composer-session.ts';
import { externalAgentCatalog, externalAgentIds } from '../src/shared/external-agents.ts';
import { findNode, nextTurn, text, uiBundle, uiHarness } from './helpers/ui-harness.ts';

let studioCode: string, workspaceCode: string;
before(async () => {
  studioCode = await uiBundle('src/ui/Studio.tsx', true);
  workspaceCode = await uiBundle('src/ui/Workspace.tsx');
});
const button = (tree: unknown, label: string) =>
  findNode(
    tree,
    (node) => node.type === 'button' && (node.props['aria-label'] === label || text(node).trim() === label),
  )!;
const stamp = '2026-10-29T12:00:00Z';
const chat = (agentId: (typeof externalAgentIds)[number]) => ({
  id: `${agentId}-chat`,
  projectId: 'synthetic-project',
  title: externalAgentCatalog[agentId].name,
  createdAt: stamp,
  updatedAt: stamp,
  pinnedAt: stamp,
  defaultExternalAgentId: agentId,
});
const state = () => ({
  app: { name: 'Fixture', version: 'test', platform: 'win32', dataDir: 'synthetic' },
  projects: [],
  conversations: [] as any[],
  conversationMessages: [],
  runs: [],
  workflows: [],
  targets: [],
  runtimes: [],
  approvals: [],
  plugins: [],
  settings: { toolApprovalMode: 'auto', executionPolicy: 'cli-first' },
});
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

for (const agentId of externalAgentIds) {
  test(`${agentId} composer callback prevents duplicate requests and opens the saved chat without pinned shortcuts`, async () => {
    let resolve!: (value: unknown) => void;
    const response = new Promise((done) => {
      resolve = done;
    });
    const calls: unknown[][] = [];
    const backend = {
      state: state(),
      connection: 'connected',
      reload: async () => {},
      api: async (path: string, body?: unknown, method = 'POST') => {
        if (path === '/api/conversations/external-agent') {
          calls.push([path, body, method]);
          return response;
        }
        return {};
      },
    };
    const h = uiHarness(studioCode, { __backend: backend });
    try {
      const render = () => h.render('default');
      assert.equal(button(render(), '打开 Grok Bot 对话'), undefined);
      assert.equal(button(render(), '打开 Muse 对话'), undefined);
      const workspaceProps = () => {
        const split = findNode(render(), (node) => node.type?.name === 'SplitView')!;
        return split.props.children(split.props.ids[0], 0).props;
      };
      workspaceProps().onNewExternalChat(agentId);
      workspaceProps().onNewExternalChat(agentId);
      await nextTurn();
      assert.deepEqual(plain(calls), [['/api/conversations/external-agent', { agentId }, 'POST']]);
      resolve(chat(agentId));
      await nextTurn();
      const split = findNode(render(), (node) => node.type?.name === 'SplitView')!;
      assert.equal(split.props.ids[0], chat(agentId).id);
      const workspace = split.props.children(split.props.ids[0], 0);
      assert.equal(workspace?.props.conversation?.id, chat(agentId).id);
      assert.equal(workspace?.props.conversation?.defaultExternalAgentId, agentId);
    } finally {
      h.unmount();
    }
  });

  test(`${agentId} composer chip names the receiver and unbinds once without dropping the draft`, async () => {
    const conversation: any = chat(agentId);
    const live = state();
    live.conversations = [conversation];
    const session = new ComposerSession();
    const scope = `conversation:${conversation.id}`;
    session.changeDraft(scope, (draft) => ({ ...draft, content: 'Keep this synthetic draft' }));
    const calls: unknown[][] = [];
    let finish!: () => void;
    const pending = new Promise<void>((done) => {
      finish = done;
    });
    const h = uiHarness(workspaceCode);
    const props: any = {
      state: live,
      conversation,
      composerSession: session,
      reload: async () => {},
      api: async (path: string, body?: unknown, method = 'POST') => {
        if (path === '/api/external-agents')
          return { agents: [{ id: agentId, name: conversation.title, added: true, enabled: true, available: true }] };
        if (method === 'PATCH') {
          calls.push([path, body, method]);
          await pending;
          const { defaultExternalAgentId: _binding, ...unbound } = conversation;
          return unbound;
        }
        return { messages: [], workflows: [] };
      },
      notify() {},
      onConversation: (updated: unknown) => {
        props.conversation = updated;
      },
      onAddProject() {},
      onMemory() {},
      onInspect() {},
    };
    const render = () => h.render('ConversationWorkspace', props);
    try {
      render();
      await nextTurn();
      assert.match(text(render()), new RegExp(`发送给 ${conversation.title}`));
      const unbind = button(render(), '解除绑定');
      unbind.props.onClick();
      unbind.props.onClick();
      assert.equal(button(render(), '解除绑定').props.disabled, true);
      assert.deepEqual(plain(calls), [
        [`/api/conversations/${conversation.id}`, { defaultExternalAgentId: null }, 'PATCH'],
      ]);
      finish();
      await nextTurn();
      assert.equal(button(render(), '解除绑定'), undefined);
      assert.equal(session.getSnapshot().drafts[scope]?.content, 'Keep this synthetic draft');
      assert.equal(props.conversation.pinnedAt, stamp);
    } finally {
      h.unmount();
      session.dispose();
    }
  });
}

test('the bound composer exposes not-added, disabled, unavailable and lookup-failure reasons', async () => {
  for (const fixture of [
    { agents: [], reason: '尚未添加' },
    { agents: [{ id: 'muse', added: true, enabled: false, available: false, reason: '已关闭' }], reason: '已关闭' },
    {
      agents: [{ id: 'muse', added: true, enabled: true, available: false, reason: 'Synthetic offline' }],
      reason: 'Synthetic offline',
    },
    { agents: [], fail: true, reason: '无法读取智能体状态' },
  ]) {
    const conversation = chat('muse');
    const live = state();
    live.conversations = [conversation];
    const session = new ComposerSession();
    const h = uiHarness(workspaceCode);
    const props = {
      state: live,
      conversation,
      composerSession: session,
      api: async (path: string) => {
        if (path === '/api/external-agents') {
          if (fixture.fail) throw Error('Synthetic lookup failure');
          return { agents: fixture.agents };
        }
        return { messages: [], workflows: [] };
      },
      notify() {},
      onConversation() {},
      onAddProject() {},
      onMemory() {},
      onInspect() {},
    };
    try {
      h.render('ConversationWorkspace', props);
      await nextTurn();
      assert.ok(text(h.render('ConversationWorkspace', props)).includes(`Muse 当前不可用：${fixture.reason}`));
      assert.ok(button(h.render('ConversationWorkspace', props), '解除绑定'));
    } finally {
      h.unmount();
      session.dispose();
    }
  }
});

test('the composer plus menu keeps both Bot chats and the project folder action reachable', () => {
  const h = uiHarness(workspaceCode);
  const opened: string[] = [];
  let linked = 0;
  const props = {
    state: state(),
    api: async () => ({ messages: [], workflows: [] }),
    notify() {},
    onConversation() {},
    onMemory() {},
    onInspect() {},
    onNewExternalChat: (id: string) => opened.push(id),
    onAddProject: () => linked++,
  };
  const render = () => h.render('ConversationWorkspace', props);
  try {
    for (const agentId of externalAgentIds) {
      findNode(render(), (node) => node.props.className?.includes?.('composer-plus'))!.props.onClick();
      button(render(), `打开 ${externalAgentCatalog[agentId].name} 对话`).props.onClick();
    }
    assert.deepEqual(opened, [...externalAgentIds]);
    findNode(render(), (node) => node.props.className?.includes?.('composer-plus'))!.props.onClick();
    button(render(), '关联项目文件夹').props.onClick();
    assert.equal(linked, 1);
  } finally {
    h.unmount();
  }
});

test('external chat labels use the approved English Chat term and preserve placeholders', () => {
  const en = JSON.parse(readFileSync(new URL('../src/shared/i18n/en.json', import.meta.url), 'utf8'));
  for (const [key, value] of Object.entries({
    '打开 Grok Bot 对话': 'Open Grok Bot chat',
    '打开 Muse 对话': 'Open Muse chat',
    '发送给 {0}': 'Sending to {0}',
    解除绑定: 'Unbind',
    '{0} 当前不可用：{1}': '{0} is unavailable: {1}',
  }))
    assert.equal(en[key], value);
});

test('an open bound chat refreshes availability and cancels polling when it unmounts', async () => {
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let nextTimer = 0,
    enabled = true,
    requests = 0;
  const h = uiHarness(workspaceCode, {
    setTimeout: (fn: () => void, ms: number) => {
      const id = ++nextTimer;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimeout: (id: number) => timers.delete(id),
  });
  const conversation = chat('muse');
  const live = state();
  live.conversations = [conversation];
  const session = new ComposerSession();
  const props = {
    state: live,
    conversation,
    composerSession: session,
    api: async (path: string) => {
      if (path === '/api/external-agents') {
        requests++;
        return {
          agents: [{ id: 'muse', added: true, enabled, available: enabled, reason: enabled ? undefined : '已关闭' }],
        };
      }
      return { messages: [], workflows: [] };
    },
    notify() {},
    onConversation() {},
    onAddProject() {},
    onMemory() {},
    onInspect() {},
  };
  const render = () => h.render('ConversationWorkspace', props);
  try {
    render();
    await nextTurn();
    assert.ok(text(render()).includes('发送给 Muse'));
    for (const next of [false, true]) {
      enabled = next;
      const [id, timer] = [...timers].find(([, timer]) => timer.ms === 5000)!;
      timers.delete(id);
      timer.fn();
      await nextTurn();
      assert.ok(text(render()).includes(next ? '发送给 Muse' : 'Muse 当前不可用：已关闭'));
    }
    assert.equal(requests, 3);
    h.unmount();
    assert.equal(
      [...timers.values()].some((timer) => timer.ms === 5000),
      false,
    );
  } finally {
    h.unmount();
    session.dispose();
  }
});
