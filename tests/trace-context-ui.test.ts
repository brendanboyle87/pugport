// Synthetic rows only; no executor, account or provider is contacted.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ContextPart, RunContextDetail, TraceContextPage, TraceContextRun } from '../src/shared/context-trace.ts';
import { meteringContract } from '../src/shared/context-trace.ts';
import type { Workflow } from '../src/shared/types.ts';
import { compact, Did, Handoff, Reported, WhatWentIn, Why } from '../src/ui/TraceContext.tsx';
import { findNode, nextTurn, text, uiBundle, uiHarness, type UiNode } from './helpers/ui-harness.ts';

const at = (seconds: number) => new Date(Date.UTC(2026, 10, 1, 10) + seconds * 1000).toISOString();
const part = (key: string, title: string, group: ContextPart['group'], chars: number): ContextPart => ({
  key,
  title,
  group,
  chars,
  tokens: Math.ceil(chars / 4),
  method: 'estimate',
});
function row(patch: Partial<TraceContextRun> = {}): TraceContextRun {
  const parts = patch.parts ?? [
    part('a', '此前工作记录', 'memory', 9870),
    part('b', 'PugPort 指令', 'instructions', 3912),
    part('c', '原始需求', 'request', 1240),
  ];
  return {
    runId: 'run-2',
    workflowId: 'task',
    depth: 0,
    attempt: 2,
    label: null,
    executor: 'Claude Code — Max',
    runtimeId: 'claude',
    provider: 'claude',
    transport: 'cli',
    status: 'completed',
    startedAt: at(0),
    endedAt: at(702),
    relay: null,
    error: null,
    sessionMode: null,
    carriedTools: null,
    unconfirmedTools: null,
    textOnly: false,
    toolless: false,
    promptRecorded: true,
    parts,
    sent: {
      chars: parts.reduce((sum, item) => sum + item.chars, 0),
      tokens: parts.reduce((sum, item) => sum + item.tokens, 0),
      method: 'estimate',
    },
    transcript: null,
    reported: { contextTokens: 58400, contextWindow: 200000, at: at(700), source: 'claude-message-usage' },
    requests: { count: 3, coverage: 'per-request', sources: ['claude-message-usage'] },
    usage: {
      inputTokens: 6214,
      outputTokens: 9402,
      cacheReadTokens: 412608,
      cacheWriteTokens: 38140,
      reasoningOutputTokens: null,
      totalTokens: null,
      estimatedCostUsd: null,
      accountingMode: 'subscription',
    },
    tools: { count: 37, coverage: 'live' },
    partialHistory: false,
    route: { reasons: [], warnings: [], targetTier: null, shortQuotaLeft: null, shortQuotaWindow: null },
    measuredFiles: ['src/upload/retry.ts'],
    ...patch,
  };
}
const html = (element: unknown) => renderToStaticMarkup(element as never);

test('compact figures keep the precision the design shows', () => {
  assert.equal(compact(58400), '58.4k');
  assert.equal(compact(272000), '272k');
  assert.equal(compact(1_000_000), '1M');
  assert.equal(compact(388), '388');
});

test('What went in groups by size, diffs against the previous attempt and keeps dropped parts visible', () => {
  const previous = row({
    attempt: 1,
    parts: [
      part('x', '此前工作记录', 'memory', 7730),
      part('y', 'PugPort 指令', 'instructions', 3912),
      part('z', '最近未完成任务', 'memory', 1730),
    ],
  });
  const current = row({
    parts: [...row().parts, part('h', '交接条', 'handoff', 4612)],
  });
  const markup = html(createElement(WhatWentIn, { row: current, previous, onView() {} }));
  assert.match(markup, /尝试 2 对比 1/);
  assert.match(markup, /发送了什么/);
  assert.ok(markup.indexOf('记忆与历史') < markup.indexOf('交接材料'), 'larger groups come first');
  assert.match(markup, /\+2,140/);
  assert.match(markup, /相同/);
  assert.match(markup, /新加入/);
  assert.match(markup, /class="struck">最近未完成任务/);
  assert.match(markup, /已移除/);
  assert.match(markup, /原生 CLI 自己的系统提示 PugPort 看不到/);
  const api = html(createElement(WhatWentIn, { row: row({ transport: 'api' }), onView() {} }));
  assert.equal(api.split('Pi 的内置系统提示未上报。').length - 1, 1);
  assert.doesNotMatch(api, /class="badge /, 'a single attempt shows no diff badges');
  const older = html(createElement(WhatWentIn, { row: row({ promptRecorded: false, parts: [] }), onView() {} }));
  assert.match(older, /这条较早的记录没有保留发送内容/);
  assert.doesNotMatch(older, /完整执行提示词/);
});

test('Reported shows occupancy split, usage and per-request drops without asserting a cause', () => {
  const detail: RunContextDetail = {
    runId: 'run-2',
    partialHistory: false,
    requests: {
      total: 4,
      offset: 0,
      limit: 200,
      coverage: 'per-request',
      items: [14800, 33000, 14100, 58400].map((tokens, index) => ({
        runId: 'run-2',
        requestId: `m${index}`,
        ordinal: index + 1,
        startedAt: null,
        endedAt: null,
        observedAt: at(index),
        usage: null,
        contextTokens: tokens,
        contextWindow: 200000,
        scope: 'request' as const,
        source: 'claude-message-usage' as const,
      })),
    },
    tools: {
      total: 0,
      offset: 0,
      limit: 50,
      coverage: 'live',
      items: [],
      topTools: [],
      topCommands: [],
      commandCount: 0,
      filesRead: [],
      filesEdited: [],
    },
  };
  const markup = html(createElement(Reported, { row: row(), detail, executor: 'Claude Code — Max' }));
  assert.match(markup, /Claude Code — Max 的报告/);
  assert.match(markup, /58.4k/);
  assert.match(markup, /\/ 200k 已用/);
  assert.match(markup, /29%/);
  assert.match(markup, /412,608 · 98.5%/);
  assert.match(markup, /订阅/);
  assert.match(markup, /第 3 次请求缩小了 18.9k/);
  assert.equal((markup.match(/data-drop/g) ?? []).length, 1);
  assert.doesNotMatch(markup, /推理输出/, 'unreported reasoning is omitted, not shown as zero');
  const grok = html(
    createElement(Reported, {
      row: row({
        executor: 'Grok',
        reported: null,
        usage: null,
        requests: { count: 0, coverage: 'not-reported', sources: [] },
      }),
      executor: 'Grok',
    }),
  );
  assert.match(grok, /Grok 没有报告这次运行的 token 用量。/);
  assert.equal((grok.match(/未报告/g) ?? []).length, 5);
  assert.match(grok, /这个执行器没有逐次请求的上下文数据/);
  const api = html(
    createElement(Reported, {
      row: row({ usage: { ...row().usage!, accountingMode: 'usage', estimatedCostUsd: 0.42 } }),
      executor: 'Pi',
    }),
  );
  assert.match(api, /\$0.42 计费/);
});

test('Handoff names the session change, carried tools and part changes in characters', () => {
  const from = row({
    attempt: 1,
    parts: [part('x', '最近未完成任务', 'memory', 1730), part('y', '原始需求', 'request', 1240)],
  });
  const to = row({
    relay: { fromRunId: 'run-1', fromRuntimeId: 'codex', reason: 'quota' },
    sessionMode: 'fresh',
    carriedTools: 9,
    parts: [part('h', '交接条', 'handoff', 4612), part('y2', '原始需求', 'request', 1240)],
  });
  const markup = html(createElement(Handoff, { from, to, executor: 'Claude Code — Max' }));
  assert.match(markup, /交接点/);
  assert.match(markup, /额度用完/);
  assert.match(markup, /新会话 · Claude Code — Max · 带过去 9 个工具结果 · 变化按字符计/);
  assert.match(markup, /交接条<\/span><span translate="no"> 4.6k/);
  assert.match(markup, /class="chip drop"><b>−<\/b><span>最近未完成任务/);
});

test('Why summarises judgment, route and memory and opens the raw payloads', () => {
  const shown: [unknown, string][] = [];
  const workflow = {
    id: 'task',
    memoryRevision: 23,
    handlingSource: 'laya',
    input: { permissionMode: 'workspace-write', routeDecision: { handling: 'task' } },
    taskJudgment: { kind: 'general', complexity: 'complex', intent: 'action', reason: 'accepted' },
    memoryRetrieval: { status: 'found', excerpts: 6, verifiedPaths: ['a', 'b', 'c'], elapsedMs: 412 },
    planning: { strategy: 'model', reason: 'Synthetic planning' },
  } as unknown as Workflow;
  const element = createElement(Why, {
    row: row({ route: { ...row().route, reasons: ['Synthetic route reason'], warnings: ['Synthetic warning'] } }),
    workflow,
    state: { targets: [], runtimes: [] },
    onShow: (title, value) => shown.push([title, value]),
  });
  const markup = html(element);
  assert.match(markup, /通用 · 困难 · 要执行操作 · 可写入/);
  assert.match(markup, /由 Task Router 判断/);
  assert.match(markup, /Synthetic route reason Synthetic warning/);
  assert.match(markup, /6 条摘录 · 3 个路径已核实 · 412 ms/);
  assert.match(markup, /项目记忆版本 23/);
  assert.match(markup, /模型规划/);
  const none = html(
    createElement(Why, {
      row: row(),
      workflow: { id: 'x', memoryRevision: 1, input: {} } as unknown as Workflow,
      state: { targets: [], runtimes: [] },
      onShow() {},
    }),
  );
  assert.match(none, /没有记录任务判断/);
  assert.match(none, /没有记录选路理由/);
  assert.match(none, /这个任务没有检索记忆/);
});

test('What it did tallies tools, programs and files, and says when a run had no tools', () => {
  const detail: RunContextDetail = {
    runId: 'run-2',
    partialHistory: false,
    requests: { total: 0, offset: 0, limit: 200, coverage: 'not-reported', items: [] },
    tools: {
      total: 37,
      offset: 0,
      limit: 50,
      coverage: 'retained-events',
      items: [],
      topTools: [
        { name: 'Bash', count: 21 },
        { name: 'Read', count: 9 },
      ],
      topCommands: [{ name: 'npm', count: 8 }],
      commandCount: 21,
      filesRead: [
        { name: 'src/upload/queue.ts', count: 3 },
        { name: 'C:\\repo\\src\\upload\\retry.ts', count: 1 },
      ],
      filesEdited: [],
    },
  };
  const markup = html(createElement(Did, { row: row(), detail, executor: 'Claude Code', onOpenCalls() {} }));
  assert.match(markup, /尝试 2 · 来自 Claude Code 的记录/);
  assert.match(markup, /Bash/);
  assert.match(markup, /npm/);
  assert.match(markup, /2 个文件 · 1 个改动/, 'each file is counted once');
  assert.match(markup, /src\/upload\/retry.ts/);
  assert.match(markup, /读取 ×3/);
  assert.match(markup, /已改动 · 读取 ×1/, 'a changed file says how often it was read on its own row');
  assert.doesNotMatch(markup, /repo/, 'the changed file is not listed again as read');
  assert.equal(markup.split('读取 ×').length - 1, 2);
  assert.match(markup, /这条记录的工具来自保留的事件，可能不完整。/);
  const none = html(
    createElement(Did, { row: row({ toolless: true }), detail, executor: 'Claude Code', onOpenCalls() {} }),
  );
  assert.match(none, /这次运行没有使用工具。/);
});

let code: string;
before(async () => {
  code = await uiBundle('src/ui/TraceContext.tsx');
});
const page = (runs: TraceContextRun[]): TraceContextPage => ({
  workflowId: 'task',
  contract: meteringContract,
  scope: { attempts: runs.filter((item) => item.depth === 0).length, subtasks: 1, handoffs: 1 },
  total: runs.length,
  offset: 0,
  limit: 40,
  runs,
});
function nodes(tree: unknown, check: (node: UiNode) => boolean): UiNode[] {
  const result: UiNode[] = [];
  findNode(tree, (node) => {
    if (check(node)) result.push(node);
    return false;
  });
  return result;
}

test('the ladder loads once per open, selects the latest attempt and follows row and keyboard selection', async () => {
  const rows = [
    row({ runId: 'run-1', attempt: 1, reported: null, executor: 'Grok' }),
    row({ relay: { fromRunId: 'run-1', fromRuntimeId: 'grok', reason: 'quota' } }),
    row({ runId: 'child-run', workflowId: 'child', depth: 1, attempt: 1, label: 'Review', transport: 'api' }),
  ];
  const requests: string[] = [];
  const selected: string[] = [];
  const props = {
    api: async <T>(path: string) => {
      requests.push(path);
      return (path.startsWith('/api/workflows/') ? page(rows) : { runId: path.split('/')[3] }) as T;
    },
    workflow: { id: 'task' } as Workflow,
    workflows: [],
    runs: [],
    state: { targets: [], runtimes: [] },
    refresh: 'a',
    live: false,
    onSelectAttempt: (id: string) => selected.push(id),
    onOpenCalls() {},
    onOpenRecord() {},
    onShow() {},
  };
  const ui = uiHarness(code);
  ui.render('TraceContext', props);
  await nextTurn();
  let tree = ui.render('TraceContext', props);
  await nextTurn();
  tree = ui.render('TraceContext', props);
  assert.deepEqual(requests, ['/api/workflows/task/context?limit=40', '/api/runs/run-2/context']);
  const options = nodes(tree, (node) => node.props.role === 'option');
  assert.deepEqual(
    options.map((node) => [node.props['data-run-id'], node.props['aria-selected']]),
    [
      ['run-1', false],
      ['run-2', true],
      ['child-run', false],
    ],
  );
  assert.match(text(tree), /这个 CLI 没有报告总量/);
  assert.equal(findNode(tree, (node) => node.type?.name === 'Handoff')?.props.to.runId, 'run-2');
  assert.equal(findNode(tree, (node) => node.type?.name === 'WhatWentIn')?.props.previous.runId, 'run-1');
  options[2]!.props.onClick();
  tree = ui.render('TraceContext', props);
  assert.deepEqual(selected, [], 'a sub-task row does not change the parent attempt');
  assert.equal(findNode(tree, (node) => node.type?.name === 'Reported')?.props.row.runId, 'child-run');
  findNode(tree, (node) => node.props.role === 'listbox')!.props.onKeyDown({
    key: 'ArrowUp',
    preventDefault() {},
    currentTarget: { querySelectorAll: () => [] },
  });
  tree = ui.render('TraceContext', props);
  assert.deepEqual(selected, ['run-2']);
  findNode(tree, (node) => node.type === 'button' && text(node) === 'PugPort 部分')!.props.onClick();
  tree = ui.render('TraceContext', props);
  assert.doesNotMatch(text(tree), /这个 CLI 没有报告总量/, 'the sent-only scale draws no reported totals');
  await nextTurn();
  ui.render('TraceContext', props);
  assert.equal(
    requests.filter((path) => path.startsWith('/api/workflows/')).length,
    1,
    'switching scale reuses the page',
  );
  ui.unmount();
});

test('the ladder reports failures with retry and an honest empty state', async () => {
  let fail = true;
  const props = {
    api: async <T>() => {
      if (fail) throw new Error('Synthetic failure');
      return page([]) as T;
    },
    workflow: { id: 'task' } as Workflow,
    workflows: [],
    runs: [],
    state: { targets: [], runtimes: [] },
    refresh: 'a',
    live: false,
    onSelectAttempt() {},
    onOpenCalls() {},
    onOpenRecord() {},
    onShow() {},
  };
  const ui = uiHarness(code);
  ui.render('TraceContext', props);
  await nextTurn();
  let tree = ui.render('TraceContext', props);
  assert.match(text(tree), /上下文加载失败/);
  fail = false;
  findNode(tree, (node) => node.type === 'button' && text(node) === '重试')!.props.onClick();
  ui.render('TraceContext', props);
  await nextTurn();
  tree = ui.render('TraceContext', props);
  assert.match(text(tree), /还没有发送任何内容/);
  ui.unmount();
});

test('the detail is read once for a finished run and follows the ladder only while the run is active', async () => {
  let current = [row({ status: 'completed' })];
  const requests: string[] = [];
  const base = {
    api: async <T>(path: string) => {
      requests.push(path);
      return (path.startsWith('/api/workflows/') ? page(current) : { runId: path.split('/')[3] }) as T;
    },
    workflow: { id: 'task' } as Workflow,
    workflows: [],
    runs: [],
    state: { targets: [], runtimes: [] },
    live: false,
    onSelectAttempt() {},
    onOpenCalls() {},
    onOpenRecord() {},
    onShow() {},
  };
  const details = () => requests.filter((path) => path.startsWith('/api/runs/')).length;
  const ui = uiHarness(code);
  const settle = async (refresh: string) => {
    ui.render('TraceContext', { ...base, refresh });
    await nextTurn();
    ui.render('TraceContext', { ...base, refresh });
    await nextTurn();
    return ui.render('TraceContext', { ...base, refresh });
  };
  await settle('a');
  assert.equal(details(), 1);
  // Each ladder poll returns a new page object; a finished run's detail is not read again.
  await settle('b');
  await settle('c');
  assert.equal(requests.filter((path) => path.startsWith('/api/workflows/')).length, 3);
  assert.equal(details(), 1, 'no detail refetch on a ladder poll for a finished run');
  // An active run: unchanged counts reuse the detail, new tool calls or a finished status refresh it.
  current = [row({ status: 'running', endedAt: null, tools: { count: 3, coverage: 'live' } })];
  await settle('d');
  assert.equal(details(), 2);
  await settle('e');
  assert.equal(details(), 2, 'an active run with nothing new is not re-read');
  current = [row({ status: 'running', endedAt: null, tools: { count: 4, coverage: 'live' } })];
  await settle('f');
  assert.equal(details(), 3);
  current = [row({ status: 'completed', tools: { count: 4, coverage: 'live' } })];
  await settle('g');
  assert.equal(details(), 4, 'one last read when the run finishes');
  await settle('h');
  assert.equal(details(), 4);
  ui.unmount();
});

test('a partially rebuilt history says so above the selected run', async () => {
  const props = {
    api: async <T>(path: string) =>
      (path.startsWith('/api/workflows/') ? page([row({ partialHistory: true })]) : { runId: 'run-2' }) as T,
    workflow: { id: 'task' } as Workflow,
    workflows: [],
    runs: [],
    state: { targets: [], runtimes: [] },
    refresh: 'a',
    live: false,
    onSelectAttempt() {},
    onOpenCalls() {},
    onOpenRecord() {},
    onShow() {},
  };
  const ui = uiHarness(code);
  ui.render('TraceContext', props);
  await nextTurn();
  let tree = ui.render('TraceContext', props);
  await nextTurn();
  tree = ui.render('TraceContext', props);
  assert.match(text(tree), /部分历史：/);
  ui.unmount();
  const complete = uiHarness(code);
  const full = {
    ...props,
    api: async <T>(path: string) => (path.startsWith('/api/workflows/') ? page([row()]) : { runId: 'run-2' }) as T,
  };
  complete.render('TraceContext', full);
  await nextTurn();
  tree = complete.render('TraceContext', full);
  assert.doesNotMatch(text(tree), /部分历史/);
  complete.unmount();
});
