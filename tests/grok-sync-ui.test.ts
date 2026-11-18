import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AppState, Conversation, ConversationMessage } from '../src/shared/types.ts';
import {
  ConversationWorkspace,
  GrokHistorySync,
  syncWorkspaceGrokHistory,
  type Api,
  type GrokHistorySyncResult,
} from '../src/ui/Workspace.tsx';

const conversation: Conversation = {
  id: 'grok-history',
  projectId: 'project-a',
  title: 'Grok 历史记录',
  createdAt: '2026-09-29T10:00:00Z',
  updatedAt: '2026-09-29T12:00:00Z',
  grokHistory: { syncedAt: '2026-09-29T11:00:00Z', sessions: 3, messages: 125 },
};
const state: AppState = {
  app: { name: 'PugPort', version: 'test', platform: 'test', dataDir: 'fixture' },
  targets: [],
  runtimes: [],
  runs: [],
  approvals: [],
  plugins: [],
  refreshing: false,
  settings: {
    refreshSeconds: 60,
    reservePercent: 10,
    maxQuotaAgeSeconds: 120,
    preferCli: true,
    designProvider: 'claude',
    architectureProvider: 'codex',
    routineProvider: 'codex',
    unknownQuotaPolicy: 'manual-only',
    defaultProjectPath: 'C:/Fixture',
    maxConcurrentRuns: 1,
  },
  conversationMessages: [
    {
      id: 'latest',
      conversationId: conversation.id,
      role: 'assistant',
      content: 'Latest broadcast message',
      createdAt: conversation.updatedAt,
    },
  ],
};
const actions = {
  api: async <T>() => ({}) as T,
  notify() {},
  onConversation() {},
  onAddProject() {},
  onMemory() {},
  onInspect() {},
};
const result: GrokHistorySyncResult = {
  conversationId: conversation.id,
  sessions: 3,
  addedMessages: 5,
  retainedMessages: 2,
  incompleteLines: 1,
  changed: true,
  warnings: ['会话 fixture 的最后一行尚未写完。'],
};

test('only imported Grok conversations expose sync, with archived counts and the sync timestamp', () => {
  const imported = renderToStaticMarkup(createElement(ConversationWorkspace, { ...actions, state, conversation }));
  assert.match(imported, /同步 Grok 记录/);
  assert.match(imported, /dateTime="2026-09-29T11:00:00Z"/);
  assert.match(imported, /3 个会话 · 125 条记录/);
  // The sync tip shows the sync time, not the latest message's (message headings carry their own <time>).
  const syncTip = /上次同步[\s\S]*?<\/small>/.exec(imported)?.[0] ?? '';
  assert.match(syncTip, /dateTime="2026-09-29T11:00:00Z"/);
  assert.doesNotMatch(syncTip, /dateTime="2026-09-29T12:00:00Z"/);
  assert.doesNotMatch(imported, /已同步。继续输入任务/);
  assert.match(imported, /<textarea/);

  const ordinary = renderToStaticMarkup(
    createElement(ConversationWorkspace, {
      ...actions,
      state,
      conversation: { ...conversation, grokHistory: undefined },
    }),
  );
  assert.doesNotMatch(ordinary, /同步 Grok 记录|上次同步/);
  const fresh = renderToStaticMarkup(createElement(ConversationWorkspace, { ...actions, state }));
  assert.doesNotMatch(fresh, /同步 Grok 记录|上次同步/);
});

test('sync control exposes pending state, observed result counts, warnings and readable errors', () => {
  const pending = renderToStaticMarkup(createElement(GrokHistorySync, { conversation, pending: true, onSync() {} }));
  assert.match(pending, /disabled="" aria-busy="true"/);
  assert.match(pending, /正在同步 Grok 记录…/);

  const success = renderToStaticMarkup(createElement(GrokHistorySync, { conversation, result, onSync() {} }));
  assert.match(success, /新增 5 条记录/);
  assert.match(success, /保留 2 条消息/);
  assert.match(success, /暂跳过 1 行未完成记录/);
  assert.match(success, /最后一行尚未写完/);
  assert.doesNotMatch(success, /正在同步|role="alert"/);

  const unchanged = renderToStaticMarkup(
    createElement(GrokHistorySync, {
      conversation,
      result: { ...result, changed: false, addedMessages: 0, incompleteLines: 0, warnings: [] },
      onSync() {},
    }),
  );
  assert.match(unchanged, /记录没有变化/);
  assert.doesNotMatch(unchanged, /新增|暂跳过|最后一行尚未写完/);
  const failure = renderToStaticMarkup(
    createElement(GrokHistorySync, { conversation, error: '无法读取记录。现有记录已保留，请重试同步。', onSync() {} }),
  );
  assert.match(failure, /role="alert">无法读取记录。现有记录已保留，请重试同步。/);
  assert.match(failure, /125 条记录/);
});

test('sync reads complete history after a local-only POST and never submits a model task', async () => {
  const messages: ConversationMessage[] = Array.from({ length: 125 }, (_, index) => ({
    id: `message-${index}`,
    conversationId: 'grok/history',
    role: index % 2 ? 'assistant' : 'user',
    content: `Fixture history ${index}`,
    createdAt: conversation.createdAt,
  }));
  const calls: { path: string; body?: unknown; method?: string }[] = [];
  const api: Api = async <T>(path: string, body?: unknown, method?: string) => {
    calls.push({ path, body, method });
    if (calls.length === 1) return { ...result, conversationId: 'grok/history' } as T;
    return { messages } as T;
  };
  const synced = await syncWorkspaceGrokHistory(api, 'project/a');
  assert.deepEqual(calls, [
    { path: '/api/projects/project%2Fa/grok-history/sync', body: {}, method: 'POST' },
    { path: '/api/conversations/grok%2Fhistory', body: undefined, method: 'GET' },
  ]);
  assert.equal(synced.messages.length, 125);
  assert.equal(synced.messages[0].content, 'Fixture history 0');
  assert.equal(synced.messages.at(-1)?.content, 'Fixture history 124');
  assert.deepEqual(synced.result, { ...result, conversationId: 'grok/history' });
});

test('failed import does not fetch history; failed refresh distinguishes successful import from unread history', async () => {
  let calls = 0;
  const importFailure: Api = async () => {
    calls++;
    throw new Error('Grok records unavailable');
  };
  await assert.rejects(syncWorkspaceGrokHistory(importFailure, 'project-a'), /Grok records unavailable/);
  assert.equal(calls, 1);
  const refreshFailure: Api = async <T>(_path: string, _body?: unknown, method?: string) => {
    if (method === 'POST') return result as T;
    throw new Error('Local service interrupted');
  };
  await assert.rejects(
    syncWorkspaceGrokHistory(refreshFailure, 'project-a'),
    /Grok 记录已同步，但完整历史读取失败：Local service interrupted/,
  );
});
