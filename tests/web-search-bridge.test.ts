import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { EventEmitter } from 'node:events';
import { AgentBridge } from '../src/server/agent-bridge.ts';
import { webSearchAllowed, webSearchCommand } from '../src/shared/web-search.ts';
import { extensions } from '../src/server/extensions.ts';
import type { Controller } from '../src/server/controller.ts';
import type { Workspace } from '../src/server/workspace.ts';
import type { RunEvent } from '../src/shared/types.ts';
import { testDirectory } from '../src/server/platform/under-test.ts';
import { claudeExecutionArgs } from '../src/server/adapters/claude.ts';
import type { ExecuteContext } from '../src/shared/types.ts';

test('direct search commands are explicit and common network prohibitions deny search', () => {
  assert.deepEqual(webSearchCommand('/搜索 最近更新'), { query: '最近更新' });
  assert.deepEqual(webSearchCommand('/SEARCH release notes'), { query: 'release notes' });
  assert.deepEqual(webSearchCommand('/搜索'), { query: '' });
  for (const text of ['请解释 /搜索 这个命令', '“/搜索 测试”', '/searching something'])
    assert.equal(webSearchCommand(text), undefined);
  for (const text of [
    '不联网',
    '不搜索，只读本地文件',
    '不要联网',
    '不要进行联网搜索，只分析本地文件',
    '禁止使用网页搜索',
    '仅使用本地资料',
    'Do not use web search',
    "Don't browse the internet",
    'Work offline',
    'without searching the web',
  ])
    assert.equal(webSearchAllowed(text), false, text);
  assert.equal(webSearchAllowed('Search the official release notes'), true);
});

test('Claude confirmation mode can call granted readonly search without approving an unrelated write tool', () => {
  const ctx = {
    target: { provider: 'claude' },
    input: { permissionMode: 'read-only' },
    route: { model: 'sonnet' },
    approvalMode: 'ask',
    agentBridge: { extraTools: ['web_search', 'web_fetch', 'untrusted_write'] },
  } as unknown as ExecuteContext;
  const args = claudeExecutionArgs(ctx, 'synthetic-config.json');
  const allowed = args[args.indexOf('--allowedTools') + 1];
  assert.ok(allowed.includes('mcp__pugport__web_search'));
  assert.ok(allowed.includes('mcp__pugport__web_fetch'));
  assert.ok(!allowed.includes('untrusted_write'));
  assert.equal(args[args.indexOf('--tools') + 1], 'Read,Glob,Grep');
});

function fixture(t: TestContext) {
  const events: RunEvent[] = [];
  const cancellation = new AbortController();
  const parentCancellation = new AbortController();
  const state = {
    enabled: true,
    granted: true,
    valid: true,
    query: 'Read current docs',
    intent: '',
    parent: undefined as string | undefined,
    calls: 0,
    input: undefined as { query: string; englishQuery?: string; count?: number } | undefined,
    receivedSignal: undefined as AbortSignal | undefined,
    block: false,
  };
  t.mock.method(extensions, 'bridgeTools', () => []);
  const controller = Object.assign(new EventEmitter(), {
    dataDir: testDirectory(),
    webSearch: {
      available: () => state.enabled,
      search: async (input: { query: string }, context: { signal: AbortSignal }) => {
        state.input = input;
        state.calls++;
        state.receivedSignal = context.signal;
        if (state.block)
          await new Promise<void>((_resolve, reject) =>
            context.signal.addEventListener('abort', () => reject(new Error('Search cancelled')), { once: true }),
          );
        return {
          query: input.query,
          results: [{ title: 'Docs', url: 'https://example.com/docs', summary: 'Untrusted content' }],
          requestId: 'search-one',
          durationMs: 5,
          estimatedCostCny: 0.005,
          truncated: false,
        };
      },
    },
    agentBridgeCaller: () =>
      state.valid
        ? {
            run: { id: 'run', workflowId: 'flow' },
            target: { provider: 'codex' },
            write: false,
            delegate: false,
            child: false,
            recycle: false,
            webSearch: state.granted,
            webSearchSignal: cancellation.signal,
            signal: new AbortController().signal,
          }
        : undefined,
    searchCancellation: (id: string) => (id === 'parent' ? [parentCancellation.signal] : []),
    recordRunEvent: (_id: string, event: RunEvent) => events.push(event),
    returnExecution: () => async () => {},
  }) as unknown as Controller;
  const workspace = {
    store: {
      get: (kind: string, id: string) =>
        kind === 'workflow'
          ? {
              id,
              projectId: 'project',
              conversationId: 'chat',
              input: { content: id === 'parent' ? state.parent : state.query, intentText: state.intent },
              ...(id === 'flow' && state.parent ? { parentWorkflowId: 'parent' } : {}),
            }
          : kind === 'project'
            ? { id: 'project', rules: [] }
            : undefined,
    },
    takeNotices: () => [],
  } as unknown as Workspace;
  const bridge = new AgentBridge(workspace, controller, 'unused');
  t.after(() => bridge.close());
  const request = async (method: string, params?: object) =>
    (await bridge.handle('Bearer synthetic', { jsonrpc: '2.0', id: 1, method, params })) as {
      status: number;
      body: { result: { tools: { name: string }[]; content: { text: string }[]; isError?: boolean } };
    };
  return { state, events, cancellation, parentCancellation, request };
}

test('search tools require a live grant and enabled connection and retain audited result/fee', async (t) => {
  const f = fixture(t);
  assert.ok((await f.request('tools/list')).body.result.tools.some((tool) => tool.name === 'web_search'));
  const result = await f.request('tools/call', { name: 'web_search', arguments: { query: 'release' } });
  assert.match(result.body.result.content[0].text, /外部网页资料/);
  assert.match(result.body.result.content[0].text, /https:\/\/example.com\/docs/);
  assert.equal(f.state.calls, 1);
  assert.ok(
    f.events.some(
      (event) =>
        event.type === 'tool' &&
        event.data?.status === 'completed' &&
        JSON.stringify(event.data.result).includes('estimatedCostCny'),
    ),
  );
  f.state.enabled = false;
  assert.ok(!(await f.request('tools/list')).body.result.tools.some((tool) => tool.name === 'web_search'));
  assert.equal(
    (await f.request('tools/call', { name: 'web_search', arguments: { query: 'release' } })).body.result.isError,
    true,
  );
  assert.equal(f.state.calls, 1);
  f.state.valid = false;
  assert.equal((await f.request('tools/list')).status, 401);
});

test('the bridge passes both queries and per-side count to the shared search service', async (t) => {
  const f = fixture(t);
  const input = { query: '最新研究', englishQuery: 'latest research', count: 3 };
  const result = await f.request('tools/call', { name: 'web_search', arguments: input });
  assert.equal(result.body.result.isError, undefined);
  assert.deepEqual(f.state.input, input);
});

test('parent task restrictions hide and deny child search and cancel an active child search', async (t) => {
  const f = fixture(t);
  f.state.parent = 'Do not use web search';
  assert.ok(!(await f.request('tools/list')).body.result.tools.some((tool) => tool.name === 'web_search'));
  assert.equal(
    (await f.request('tools/call', { name: 'web_search', arguments: { query: 'release' } })).body.result.isError,
    true,
  );
  assert.equal(f.state.calls, 0);
  f.state.parent = 'Use current docs';
  f.state.block = true;
  const pending = f.request('tools/call', { name: 'web_search', arguments: { query: 'release' } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  f.parentCancellation.abort();
  assert.equal((await pending).body.result.isError, true);
  assert.equal(f.state.receivedSignal?.aborted, true);
  assert.equal(
    (await f.request('tools/call', { name: 'web_search', arguments: { query: 'again' } })).body.result.isError,
    true,
  );
  assert.equal(f.state.calls, 1);
});

test('persisted queued-steering intent keeps search disabled after a new grant', async (t) => {
  const f = fixture(t);
  f.state.intent = 'Do not use web search';
  assert.ok(!(await f.request('tools/list')).body.result.tools.some((tool) => tool.name === 'web_search'));
  assert.equal(
    (await f.request('tools/call', { name: 'web_search', arguments: { query: 'release' } })).body.result.isError,
    true,
  );
  assert.equal(f.state.calls, 0);
});
