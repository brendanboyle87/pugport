import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConversationTurn, ToolRow } from '../src/ui/ConversationTurn.tsx';
import { buildConversationPresentation } from '../src/server/conversation-presentation.ts';
import { projectStartNotice, type ConversationPresentation } from '../src/shared/conversation-presentation.ts';
import { toolFailureReason } from '../src/shared/activity-vocabulary.ts';
import { localizeNoticeDetails } from '../src/shared/system-notices.ts';
import type { RunRecord, Workflow } from '../src/shared/types.ts';
import type { TrajectoryRow } from '../src/shared/trajectory.ts';

const stamp = '2026-11-01T12:00:00.000Z';
const workflow = (patch: Partial<Workflow> = {}): Workflow => ({
  id: 'w',
  conversationId: 'conversation',
  projectId: 'project',
  userMessageId: 'user-w',
  input: { content: 'Synthetic request', mode: 'build', permissionMode: 'read-only', executionPolicy: 'cli-first' },
  status: 'running',
  phase: 'route',
  plan: [],
  runIds: [],
  memoryRevision: 0,
  memoryExcerpt: '',
  createdAt: stamp,
  updatedAt: stamp,
  startedAt: stamp,
  ...patch,
});
const run = (id: string, patch: Partial<RunRecord> = {}): RunRecord => ({
  id,
  workflowId: 'w',
  prompt: 'Synthetic request',
  projectPath: '',
  kind: 'routine',
  status: 'running',
  route: { runtimeId: 'codex', model: 'model-large', effort: 'high', kind: 'routine', reasons: [], warnings: [] },
  account: { id: 'a', label: 'Work card', provider: 'codex' },
  startedAt: stamp,
  output: '',
  events: [],
  ...patch,
});
const empty: ConversationPresentation = { version: 1, workflowId: 'w', needsDetail: false, items: [] };
const tail = (task: Workflow, runs: RunRecord[], projection: ConversationPresentation = empty) => {
  const html = renderToStaticMarkup(
    createElement(ConversationTurn, {
      workflow: task,
      runs,
      projection,
      loadDetail: async () => projection,
      inspect() {},
      renderText: (value: string) => value,
    }),
  );
  const match = /<div class="turn-tail" role="status">([\s\S]*?)<\/div>/.exec(html);
  return (match?.[1] ?? '').replace(/<[^>]+>/g, '');
};

test('before a run exists the tail says the task is being routed, without the generic start sentence', () => {
  const task = workflow({
    scheduling: { reason: projectStartNotice, estimatedMinutes: 1, lastEvaluatedAt: stamp },
  });
  const projection = buildConversationPresentation(task, []);
  assert.equal(projection.waiting, undefined);
  const text = tail(task, [], projection);
  assert.match(text, /^正在判断交给谁，用时 /);
  assert.doesNotMatch(text, /已取得项目执行权/);
  // A specific reason (reading a video) still shows after the stage.
  const video = workflow({
    scheduling: { reason: '正在读取视频信息和字幕…', estimatedMinutes: 1, lastEvaluatedAt: stamp },
  });
  assert.match(tail(video, [], buildConversationPresentation(video, [])), /正在判断交给谁.*· 正在读取视频信息和字幕…/);
});

test('once routed and before the first word the tail names the account, model and effort', () => {
  const task = workflow({ runIds: ['r'], phase: 'execute' });
  assert.match(tail(task, [run('r')]), /^已交给 Work card · model-large · high，正在启动，用时 /);
  // The model the executor confirmed replaces the requested one.
  assert.match(
    tail(task, [run('r', { effectiveModel: { model: 'model-confirmed', effort: 'medium', source: 'session' } })]),
    /^已交给 Work card · model-confirmed · medium，正在启动/,
  );
  // Without an account label the routed target names it.
  const html = renderToStaticMarkup(
    createElement(ConversationTurn, {
      workflow: task,
      runs: [run('r', { account: undefined, route: { ...run('r').route, effort: undefined } })],
      projection: empty,
      targets: [{ id: 'codex', label: 'Target card' }],
      loadDetail: async () => empty,
      inspect() {},
      renderText: (value: string) => value,
    }),
  );
  assert.match(html, /已交给 Target card · model-large，正在启动/);
});

test('after the first output the tail returns to the working line', () => {
  const task = workflow({ runIds: ['r'], phase: 'execute' });
  assert.match(tail(task, [run('r', { output: 'Hello' })]), /^Work card 处理中，用时 /);
  assert.match(tail(task, [run('r', { reasoning: '**Plan**\nBody' })]), /^Work card 处理中/);
  const withItems = { ...empty, items: [{ key: 'g', kind: 'activity-group' as const, runId: 'r', calls: [] }] };
  assert.match(tail(task, [run('r')], withItems), /^Work card 处理中/);
});

test('a multi-step task shows which step runs and who runs it', () => {
  const step = (id: string, runIds: string[]) => ({
    id,
    title: id,
    instruction: id,
    kind: 'auto' as const,
    transport: 'auto' as const,
    dependsOn: [],
    status: 'pending' as const,
    runIds,
    acceptance: '',
  });
  const task = workflow({
    runIds: ['p', 'r1', 'r2'],
    phase: 'execute',
    plan: [step('one', ['r1']), step('two', ['r2']), step('three', [])],
  });
  const runs = [
    run('p', { status: 'completed', output: 'Plan', account: { id: 'x', label: 'Planner card', provider: 'claude' } }),
    run('r1', { status: 'completed', output: 'Done' }),
    run('r2', { account: { id: 'y', label: 'Second card', provider: 'claude' }, route: { ...run('r').route } }),
  ];
  const text = tail(task, runs);
  assert.match(text, /^第 2\/3 步 · 已交给 Second card · model-large · high，正在启动/);
  assert.doesNotMatch(text, /Planner card/);
  runs[2]!.output = 'Working';
  assert.match(tail(task, runs), /^第 2\/3 步 · Second card 处理中/);
});

test('failed tools say a short local reason and never the raw error or address', () => {
  const tool = (label: string, output: string): TrajectoryRow => ({
    key: `r:tool:${label}`,
    lane: 'tools',
    label,
    status: 'failed',
    detail: JSON.stringify({ native: { arguments: { url: 'https://example.test/private?token=synthetic' }, output } }),
  });
  const rows = [
    tool('WebFetch', 'fetch failed: connect ECONNREFUSED 10.0.0.1:443'),
    tool('WebSearch', 'Request timed out after 30000ms'),
    tool('web_fetch', 'HTTP 403 Forbidden from https://example.test/private'),
    tool('WebFetch', 'Something unexpected'),
  ];
  const smalls = rows.map((row) => {
    const html = renderToStaticMarkup(createElement(ToolRow, { row, inspect() {} }));
    return /<\/span><small translate="no">([^<]*)<\/small><\/summary>/.exec(html)?.[1];
  });
  assert.deepEqual(smalls, ['没连上', '已超时', '被拒绝', '失败']);
  // A command keeps its exit code; a completed tool shows nothing.
  const command: TrajectoryRow = {
    key: 'r:tool:exec',
    lane: 'tools',
    label: 'exec_command',
    status: 'failed',
    detail: JSON.stringify({ native: { command: 'false', exitCode: 2, output: 'timed out' } }),
  };
  assert.match(renderToStaticMarkup(createElement(ToolRow, { row: command, inspect() {} })), /退出码 2<\/small>/);
  assert.match(
    renderToStaticMarkup(createElement(ToolRow, { row: { ...rows[0]!, status: 'completed' }, inspect() {} })),
    /<small translate="no"><\/small><\/summary>/,
  );
});

test('the failure classifier keeps to its own sentences', () => {
  assert.equal(toolFailureReason('getaddrinfo ENOTFOUND example.test'), '没连上');
  assert.equal(toolFailureReason('ETIMEDOUT'), '已超时');
  assert.equal(toolFailureReason('Permission to use WebFetch has been denied'), '被拒绝');
  assert.equal(toolFailureReason('429 Too Many Requests'), '被拒绝');
  assert.equal(toolFailureReason('404 Not Found'), '找不到');
  assert.equal(toolFailureReason(''), '失败');
});

test('notice details translate PugPort codes and prefixes but keep executor words', () => {
  const english: Record<string, string> = {
    '原因：': 'Reason: ',
    执行器响应超时: 'The executor timed out',
    '结果未确认：': 'Result unconfirmed:',
    '原生工具拒绝原因：': 'Native tool denial reason: ',
    '验收命令失败。可以提高 effort 后续接，或交接给另一执行器。': 'Verification command failed.',
    设置: 'Settings',
  };
  const translate = (text: string) => english[text];
  const details = [
    'runtime-timeout',
    '结果未确认：执行器说文件已写好',
    '原生工具拒绝原因：Bash blocked',
    '验收命令失败。可以提高 effort 后续接，或交接给另一执行器。',
    '设置：执行器自己的话',
    'Raw socket error',
    'some-unknown-code',
  ].join('\n');
  assert.equal(
    localizeNoticeDetails(details, translate),
    [
      'Reason: The executor timed out',
      'Result unconfirmed: 执行器说文件已写好',
      'Native tool denial reason: Bash blocked',
      'Verification command failed.',
      '设置：执行器自己的话',
      'Raw socket error',
      'some-unknown-code',
    ].join('\n'),
  );
  // Without a table (Simplified Chinese) the code still becomes words; nothing else changes.
  assert.equal(
    localizeNoticeDetails('runtime-timeout\n\nRaw', () => undefined),
    '原因：执行器响应超时\n\nRaw',
  );
});
