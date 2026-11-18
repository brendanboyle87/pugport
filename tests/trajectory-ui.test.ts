import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { RunRecord } from '../src/shared/types.ts';
import { TrajectoryPanel, TrajectoryDetailDialog } from '../src/ui/Trajectory.tsx';
import { findNode, uiBundle, uiHarness } from './helpers/ui-harness.ts';

const at = (seconds: number) => new Date(Date.UTC(2026, 9, 8) + seconds * 1000).toISOString();
function run(patch: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'run-main',
    prompt: 'Inspect the source',
    projectPath: 'C:/project',
    kind: 'routine',
    status: 'completed',
    startedAt: at(0),
    endedAt: at(20),
    output: 'The review is complete.',
    route: { runtimeId: 'codex', model: 'test', kind: 'routine', reasons: [], warnings: [] },
    events: [],
    ...patch,
  };
}
const render = (record: RunRecord, relatedRuns: RunRecord[] = [], inspect = false) =>
  renderToStaticMarkup(
    createElement(TrajectoryPanel, { run: record, relatedRuns, ...(inspect ? { onInspectRun() {} } : {}) }),
  );

test('temporary visual assistance is inspectable in both directions without impersonating a native parent session', () => {
  const visual = run({ id: 'visual-run', visualAssistant: true });
  const primary = run({ visualContext: { fromRunId: visual.id, sourceAttachments: ['picture-1'] } });
  const primaryHtml = render(primary, [visual], true);
  assert.match(primaryHtml, /读图辅助/);
  assert.doesNotMatch(primaryHtml, /父运行/);
  const visualHtml = render(visual, [primary], true);
  assert.match(visualHtml, /交回主任务/);
  assert.doesNotMatch(visualHtml, /子运行/);
});

test('tool rows start collapsed with input and result summaries, and one click reveals safe details', async () => {
  const record = run({
    reasoning: 'Public thinking password=PRIVATE_REASONING',
    events: [
      { at: at(1), type: 'reasoning', text: 'PRIVATE_REASONING' },
      { at: at(2), type: 'text', text: 'PRIVATE_SYSTEM', data: { role: 'system' } },
      {
        at: at(3),
        type: 'tool',
        data: {
          tool: 'read_file',
          toolCallId: 'call-a',
          status: 'started',
          arguments: { path: 'hello.ts', password: 'PRIVATE_PASSWORD', system: 'PRIVATE_HIDDEN_PROMPT' },
          raw: 'PRIVATE_NATIVE_PACKET',
          command: 'UNEXPANDED_COMMAND',
        },
      },
      {
        at: at(4),
        type: 'tool',
        data: {
          tool: 'read_file',
          toolCallId: 'call-a',
          status: 'completed',
          result: 'UNEXPANDED_RESULT',
        },
      },
    ],
  });
  const html = render(record);
  assert.match(html, /read_file/);
  assert.match(html, /1 条工具记录/);
  assert.match(html, /aria-expanded="false"/);
  assert.doesNotMatch(html, /PRIVATE_/);
  assert.doesNotMatch(html, /UNEXPANDED_COMMAND/);
  assert.match(html, /path: hello.ts/);
  assert.match(html, /UNEXPANDED_RESULT/);
  assert.doesNotMatch(html, /aria-expanded="true"|trajectory-row-detail/);
  assert.match(html, /aria-label="轨迹筛选"/);
  assert.match(html, /aria-pressed="true"/);
  const harness = uiHarness(await uiBundle('src/ui/Trajectory.tsx'));
  let tree = harness.render('TrajectoryPanel', { run: record });
  const row = findNode(tree, (node) => node.type === 'article' && JSON.stringify(node.props).includes('read_file'))!;
  findNode(row, (node) => node.props.className === 'trajectory-row-heading')!.props.onClick();
  tree = harness.render('TrajectoryPanel', { run: record });
  assert.match(JSON.stringify(tree), /UNEXPANDED_COMMAND/);
  assert.match(JSON.stringify(tree), /UNEXPANDED_RESULT/);
  assert.doesNotMatch(JSON.stringify(tree), /PRIVATE_/);
  harness.unmount();
});

test('collapsed tool rows summarize arrays of text blocks', () => {
  const html = render(
    run({
      events: [
        {
          at: at(1),
          type: 'tool',
          data: {
            tool: 'Read',
            toolCallId: 'array-result',
            status: 'completed',
            result: [
              { type: 'text', text: 'Error:\n  file not found' },
              { type: 'image', text: 'NON_TEXT_BLOCK' },
              { type: 'text', text: 'Try\t another path' },
            ],
          },
        },
      ],
    }),
  );
  assert.match(html, /Error: file not found Try another path/);
  assert.doesNotMatch(html, /NON_TEXT_BLOCK|aria-expanded="true"|trajectory-row-detail/);
});

test('collapsed file tools summarize Grok target_file and Claude file_path arguments', () => {
  for (const key of ['target_file', 'file_path']) {
    const html = render(
      run({
        events: [
          {
            type: 'tool',
            at: at(1),
            data: {
              tool: 'read_file',
              toolCallId: 'file-call',
              status: 'started',
              arguments: { [key]: 'C:/fixture/notes.md' },
            },
          },
        ],
      }),
    );
    assert.match(html, new RegExp(`${key}: C:/fixture/notes.md`));
    assert.match(html, /trajectory-tool-summary/);
    assert.doesNotMatch(html, /aria-expanded="true"|trajectory-row-detail/);
  }
});

test('renders the most recent 50 rows while keeping total observed tool count', () => {
  const events: RunRecord['events'] = [];
  for (let i = 0; i < 80; i++)
    events.push({ at: at(i), type: 'tool', data: { tool: `tool-${i}`, toolCallId: `call-${i}`, status: 'started' } });
  const html = render(run({ events, output: '', endedAt: at(100) }));
  assert.equal((html.match(/<article class="trajectory-row /g) ?? []).length, 50);
  assert.match(html, /80 条工具记录/);
  assert.match(html, /加载更早的记录（剩余 34 条）/);
  assert.match(html, /tool-79/);
  assert.doesNotMatch(html.split('aria-label="轨迹记录"')[1]!, /tool-0(?:<| ·)/);
  assert.match(html, /aria-label="tool-0 ·/);
});

test('shows missing timing explicitly and never invents a duration bar for a result-only tool', () => {
  const html = render(
    run({
      output: '',
      events: [{ at: at(4), type: 'tool', data: { tool: 'result-only', toolCallId: 'a', status: 'completed' } }],
    }),
  );
  assert.match(html, /result-only/);
  assert.match(html, /1 条记录未报告时间/);
  assert.match(html, /时间未知/);
  assert.doesNotMatch(html, /class="trajectory-marker[^" ]*(?: [^"]*)?trajectory-span/);
  assert.doesNotMatch(html, /耗时 4/);
});

test('duration bars represent explicit paired tool observations; other lanes stay as event markers', () => {
  const html = render(
    run({
      events: [
        { at: at(2), type: 'tool', data: { tool: 'read', toolCallId: 'a', status: 'started' } },
        { at: at(5), type: 'tool', data: { tool: 'read', toolCallId: 'a', status: 'completed' } },
        { at: at(6), type: 'text', text: 'Answer' },
      ],
    }),
  );
  assert.equal((html.match(/class="trajectory-marker [^"]*trajectory-span"/g) ?? []).length, 1);
  assert.match(html, /耗时 3.0s/);
  assert.match(html, /left:min\(10%, calc\(100% - 3px\)\);width:15%/);
});

test('summary records show loading and unknown usage instead of a complete empty history', () => {
  const html = render(run({ summary: true, eventsDropped: 3 }));
  assert.match(html, /正在加载完整运行记录/);
  assert.match(html, /轨迹可能不完整/);
  assert.match(html, /用量未报告/);
  assert.match(html, /输出摘要/);
  assert.equal((html.match(/<article /g) ?? []).length, 0);
});

test('usage is numeric and only reported metrics appear, including a genuine zero', () => {
  const html = render(run({ events: [{ at: at(5), type: 'usage', data: { inputTokens: 0, outputTokens: 12 } }] }));
  assert.match(html, /输入 token: 0/);
  assert.match(html, /输出 token: 12/);
  assert.doesNotMatch(html, /estimatedCostUsd:|totalTokens:|用量未报告/);
});

test('related runs use explicit parent and relay metadata and expose accessible inspect controls', () => {
  const html = render(
    run({
      parentRunId: 'parent',
      relay: { fromRunId: 'previous', fromRuntimeId: 'claude', reason: 'quota' },
      workflowId: 'wf',
      stepId: 'step',
    }),
    [
      run({ id: 'child', parentRunId: 'run-main' }),
      run({ id: 'next', relay: { fromRunId: 'run-main', fromRuntimeId: 'codex', reason: 'quota' } }),
      run({ id: 'unrelated' }),
    ],
    true,
  );
  for (const text of [
    '父运行 · parent',
    '接力来源 · previous',
    '子运行 · child',
    '接力后续 · next',
    '工作流 wf',
    '步骤 step',
  ])
    assert.ok(html.includes(text));
  assert.match(html, /title="子运行 child"/);
  assert.doesNotMatch(html, /unrelated/);
});

test('bounded previews never dump enormous output strings into the panel', () => {
  const html = render(
    run({
      prompt: 'paragraph text '.repeat(2000),
      output: 'output text '.repeat(2000),
      events: [{ at: at(2), type: 'text', text: 'model text '.repeat(2000) }],
    }),
  );
  assert.ok(html.length < 14000);
  assert.match(html, /查看详细记录/);
  assert.doesNotMatch(html, /(?:paragraph text ){23}|(?:model text ){30}|(?:output text ){43}/);
});

test('execution context is clearly attributed and can be expanded without revealing native hidden prompts', async () => {
  const record = run({
    workflowId: 'workflow',
    prompt: 'PUGPORT_ACTUAL_INSTRUCTION password=fixture-secret',
    events: [{ type: 'status', at: at(1), data: { role: 'system', prompt: 'NATIVE_PRIVATE_PROMPT' } }],
  });
  const harness = uiHarness(await uiBundle('src/ui/Trajectory.tsx'));
  let tree = harness.render('TrajectoryPanel', { run: record });
  const row = findNode(
    tree,
    (node) => node.type === 'article' && JSON.stringify(node.props).includes('PugPort 执行提示词'),
  )!;
  const toggle = findNode(row, (node) => node.type === 'button' && node.props.className === 'trajectory-row-heading')!;
  assert.equal(toggle.props['aria-expanded'], false);
  toggle.props.onClick();
  tree = harness.render('TrajectoryPanel', { run: record });
  assert.match(JSON.stringify(tree), /PUGPORT_ACTUAL_INSTRUCTION/);
  assert.match(JSON.stringify(tree), /原生 CLI 自身的系统提示未报告/);
  assert.doesNotMatch(JSON.stringify(tree), /fixture-secret|NATIVE_PRIVATE_PROMPT/);
  harness.unmount();
});

test('expanded tool details show live outputs and remain collapsible through prop updates', async () => {
  const record = run({
    status: 'running',
    events: [
      {
        type: 'tool',
        at: at(1),
        data: {
          source: 'pugport',
          tool: 'read_file',
          toolCallId: 'bridge-a',
          status: 'started',
          arguments: { file: 'hello.ts' },
          handler: 'file-reader',
        },
      },
    ],
  });
  let tick: (() => void) | undefined;
  const harness = uiHarness(await uiBundle('src/ui/Trajectory.tsx'), {
    setInterval(fn: () => void) {
      tick = fn;
      return 1;
    },
  });
  let tree = harness.render('TrajectoryPanel', { run: record });
  assert.match(JSON.stringify(tree), /file: hello.ts/);
  assert.doesNotMatch(JSON.stringify(tree), /file-reader/);
  const toolRow = (tree: unknown) =>
    findNode(tree, (node) => node.type === 'article' && JSON.stringify(node.props).includes('read_file'))!;
  const heading = (tree: unknown) =>
    findNode(toolRow(tree), (node) => node.props.className === 'trajectory-row-heading')!;
  assert.equal(heading(tree).props['aria-expanded'], false);
  heading(tree).props.onClick();
  tree = harness.render('TrajectoryPanel', { run: record });
  assert.match(JSON.stringify(tree), /file-reader/);
  record.events.push({
    type: 'tool',
    at: at(3),
    data: {
      source: 'pugport',
      tool: 'read_file',
      toolCallId: 'bridge-a',
      status: 'completed',
      result: { message: 'LIVE_RESULT' },
    },
  });
  tick!();
  tree = harness.render('TrajectoryPanel', { run: record });
  assert.match(JSON.stringify(tree), /LIVE_RESULT/);
  const row = findNode(tree, (node) => node.type === 'article' && JSON.stringify(node.props).includes('read_file'))!;
  const toggle = findNode(row, (node) => node.type === 'button' && node.props.className === 'trajectory-row-heading')!;
  assert.equal(toggle.props['aria-expanded'], true);
  toggle.props.onClick();
  tree = harness.render('TrajectoryPanel', { run: record });
  assert.match(JSON.stringify(tree), /LIVE_RESULT/, 'the result summary stays visible');
  assert.doesNotMatch(JSON.stringify(tree), /file-reader|trajectory-row-detail/);
  harness.unmount();
});

test('short tool previews open a large modal containing complete input/result tail markers', async () => {
  const record = run({
    events: [
      {
        type: 'tool',
        at: at(1),
        data: {
          tool: 'read_file',
          toolCallId: 'a',
          status: 'started',
          input: 'input paragraph '.repeat(9000) + 'INPUT_MODAL_TAIL',
        },
      },
      {
        type: 'tool',
        at: at(3),
        data: { toolCallId: 'a', status: 'completed', output: 'result paragraph '.repeat(9000) + 'RESULT_MODAL_TAIL' },
      },
    ],
  });
  const preview = render(record);
  assert.doesNotMatch(preview, /INPUT_MODAL_TAIL|RESULT_MODAL_TAIL/);
  assert.ok(preview.length < 20000);
  const harness = uiHarness(await uiBundle('src/ui/Trajectory.tsx'));
  let tree = harness.render('TrajectoryPanel', { run: record });
  const row = findNode(tree, (node) => node.type === 'article' && JSON.stringify(node.props).includes('read_file'))!;
  findNode(row, (node) => node.type === 'button' && node.props.className === 'trajectory-read-more')!.props.onClick();
  tree = harness.render('TrajectoryPanel', { run: record });
  const modal = findNode(tree, (node) => node.type?.name === 'TrajectoryDetailDialog')!;
  assert.match(modal.props.text, /INPUT_MODAL_TAIL/);
  assert.match(modal.props.text, /RESULT_MODAL_TAIL/);
  // The title is an element made by the in-memory renderer, which React cannot render; the text is what matters here.
  const html = renderToStaticMarkup(createElement(TrajectoryDetailDialog, { ...modal.props, title: 'read_file' }));
  assert.match(html, /role="dialog" aria-modal="true"/);
  assert.match(html, /trajectory-full-text/);
  assert.match(html, /INPUT_MODAL_TAIL/);
  assert.match(html, /RESULT_MODAL_TAIL/);
  assert.match(html, /复制全文/);
  assert.match(html, /源端缺失或已截短的内容无法恢复/);
  harness.unmount();
});

test('full model output modal uses retained run output beyond the short event preview', async () => {
  const record = run({
    output: 'final response '.repeat(10000) + 'OUTPUT_MODAL_TAIL',
    events: [{ type: 'text', at: at(1), text: 'short retained chunk' }],
  });
  const harness = uiHarness(await uiBundle('src/ui/Trajectory.tsx'));
  let tree = harness.render('TrajectoryPanel', { run: record });
  const output = findNode(tree, (node) => node.type === 'p' && node.props.className === 'trajectory-output')!;
  findNode(output, (node) => node.type === 'button')!.props.onClick();
  tree = harness.render('TrajectoryPanel', { run: record });
  const modal = findNode(tree, (node) => node.type?.name === 'TrajectoryDetailDialog')!;
  assert.match(modal.props.text, /OUTPUT_MODAL_TAIL$/);
  assert.equal(modal.props.text.length, record.output.length);
  harness.unmount();
});

test('full audit retrieval is an explicit local action with loading feedback, unavailable for legacy records', async () => {
  const harness = uiHarness(await uiBundle('src/ui/Trajectory.tsx'));
  let calls = 0;
  const props = {
    run: run({ auditVersion: 1, eventsDropped: 12 }),
    onLoadFullAudit() {
      calls++;
    },
  };
  let tree = harness.render('TrajectoryPanel', props);
  assert.equal(calls, 0);
  const retrieve = findNode(tree, (node) => node.type === 'button' && node.props.children === '读取完整事件记录')!;
  assert.ok(retrieve);
  retrieve.props.onClick();
  assert.equal(calls, 1);
  tree = harness.render('TrajectoryPanel', { ...props, auditLoading: true });
  assert.equal(
    findNode(tree, (node) => node.type === 'button' && node.props.children === '正在读取完整事件记录…')!.props.disabled,
    true,
  );
  tree = harness.render('TrajectoryPanel', { ...props, run: run({ eventsDropped: 12 }) });
  assert.equal(
    findNode(tree, (node) => node.type === 'button' && node.props.children === '读取完整事件记录'),
    undefined,
  );
  harness.unmount();
});

test('loading a full audit resets its pagination baseline instead of mounting the entire archive', async () => {
  const harness = uiHarness(await uiBundle('src/ui/Trajectory.tsx'));
  harness.render('TrajectoryPanel', { run: run({ auditVersion: 1, eventsDropped: 50 }) });
  const events: RunRecord['events'] = Array.from({ length: 90 }, (_, index) => ({
    type: 'tool' as const,
    at: at(index),
    data: { tool: `read-${index}`, toolCallId: `call-${index}`, status: 'completed', output: 'captured result' },
  }));
  const tree = harness.render('TrajectoryPanel', { run: run({ auditVersion: 1, eventsDropped: 0, events }) });
  const walk = (value: unknown): number =>
    Array.isArray(value)
      ? value.reduce((count, child) => count + walk(child), 0)
      : value && typeof value === 'object'
        ? ((value as { type?: unknown }).type === 'article' ? 1 : 0) +
          walk((value as { props?: { children?: unknown } }).props?.children)
        : 0;
  assert.equal(walk(tree), 50);
  assert.ok(findNode(tree, (node) => node.type === 'button' && node.props.className === 'trajectory-earlier'));
  harness.unmount();
});

test('tool rows stay primary while explicit stages open their complete observed history', async () => {
  const record = run({
    events: [
      {
        type: 'status',
        at: at(0),
        data: { source: 'pugport', kind: 'routing', detail: { provider: 'grok', executor: 'Grok B' } },
      },
      {
        type: 'tool',
        at: at(1),
        data: {
          source: 'pugport',
          tool: 'find_files',
          toolCallId: 'bridge-a',
          status: 'started',
          arguments: { folder: 'D:/fixture', query: 'target' },
        },
      },
      {
        type: 'status',
        at: at(2),
        text: 'Validate scope',
        data: {
          source: 'pugport',
          kind: 'internal-step',
          parentToolCallId: 'bridge-a',
          stepId: 'scope',
          status: 'running',
          detail: { label: 'Validate scope', detail: { note: 'START_MARKER' } },
        },
      },
      {
        type: 'status',
        at: at(4),
        text: 'Validate scope',
        data: {
          source: 'pugport',
          kind: 'internal-step',
          parentToolCallId: 'bridge-a',
          stepId: 'scope',
          status: 'completed',
          detail: {
            label: 'Validate scope',
            detail: { note: 'readable paragraph '.repeat(9000) + 'STAGE_END_TAIL', password: 'hidden-secret' },
          },
        },
      },
      {
        type: 'tool',
        at: at(5),
        data: { source: 'pugport', toolCallId: 'bridge-a', status: 'completed', result: { count: 3 } },
      },
    ],
  });
  const html = render(record);
  assert.match(html, /Grok CLI \/ <span translate="no">Grok B/);
  assert.match(html, /find_files/);
  assert.match(html, /query: target/);
  assert.match(html, /count: 3/);
  assert.doesNotMatch(html, /trajectory-stages|Validate scope|父调用/);
  assert.doesNotMatch(html, /PugPort 内部步骤|STAGE_END_TAIL|hidden-secret/);
  const harness = uiHarness(await uiBundle('src/ui/Trajectory.tsx'));
  let tree = harness.render('TrajectoryPanel', { run: record });
  const row = findNode(tree, (node) => node.type === 'article' && JSON.stringify(node.props).includes('find_files'))!;
  findNode(row, (node) => node.props.className === 'trajectory-row-heading')!.props.onClick();
  tree = harness.render('TrajectoryPanel', { run: record });
  assert.match(JSON.stringify(tree), /trajectory-stages/);
  assert.match(JSON.stringify(tree), /Validate scope/);
  assert.match(JSON.stringify(tree), /父调用/);
  assert.match(JSON.stringify(tree), /2.0s/);
  findNode(tree, (node) => node.type === 'button' && node.props.children === '查看阶段完整记录')!.props.onClick();
  tree = harness.render('TrajectoryPanel', { run: record });
  const modal = findNode(tree, (node) => node.type?.name === 'TrajectoryDetailDialog')!;
  assert.match(modal.props.text, /START_MARKER/);
  assert.match(modal.props.text, /STAGE_END_TAIL/);
  assert.match(modal.props.text, /running/);
  assert.match(modal.props.text, /completed/);
  assert.doesNotMatch(modal.props.text, /hidden-secret/);
  harness.unmount();
});

test('reply details show each source event reference and its complete redacted contiguous segment', async () => {
  const record = run({
    output: 'whole final response',
    events: [
      { type: 'text', at: at(1), seq: 120, text: 'api_key=sk-fixture' },
      {
        type: 'text',
        at: at(2),
        seq: 124,
        text: 'SecretValue public paragraph ' + 'readable '.repeat(9000) + 'REPLY_SEGMENT_TAIL',
      },
      { type: 'status', at: at(3), seq: 125, text: 'boundary' },
      { type: 'text', at: at(4), seq: 126, text: 'later segment' },
    ],
  });
  const harness = uiHarness(await uiBundle('src/ui/Trajectory.tsx'));
  let tree = harness.render('TrajectoryPanel', { run: record });
  const row = findNode(
    tree,
    (node) => node.type === 'article' && JSON.stringify(node.props).includes('public paragraph'),
  )!;
  findNode(row, (node) => node.type === 'button' && node.props.className === 'trajectory-read-more')!.props.onClick();
  tree = harness.render('TrajectoryPanel', { run: record });
  const modal = findNode(tree, (node) => node.type?.name === 'TrajectoryDetailDialog')!;
  assert.match(modal.props.text, /sourceEvents/);
  assert.match(modal.props.text, /120/);
  assert.match(modal.props.text, /124/);
  assert.match(modal.props.text, /event.seq/);
  assert.match(modal.props.text, /length/);
  assert.match(modal.props.text, /REPLY_SEGMENT_TAIL$/);
  assert.doesNotMatch(modal.props.text, /sk-fixture|SecretValue|later segment|whole final response/);
  harness.unmount();
});

test('full audit gap accounting controls completeness independently of the live cap', async () => {
  const harness = uiHarness(await uiBundle('src/ui/Trajectory.tsx'));
  const record = run({
    auditVersion: 1,
    auditCapture: 'public-events',
    auditEventsMissing: 0,
    eventsDropped: 120,
    events: [
      { type: 'tool', at: at(1), data: { toolCallId: 'call', tool: 'read_file', status: 'completed', result: 'done' } },
    ],
  });
  let tree = harness.render('TrajectoryPanel', { run: record });
  const row = findNode(tree, (node) => node.type === 'article' && JSON.stringify(node.props).includes('read_file'))!;
  findNode(row, (node) => node.type === 'button' && node.props.className === 'trajectory-read-more')!.props.onClick();
  tree = harness.render('TrajectoryPanel', { run: record });
  assert.equal(findNode(tree, (node) => node.type?.name === 'TrajectoryDetailDialog')!.props.incomplete, false);
  tree = harness.render('TrajectoryPanel', { run: { ...record, auditEventsMissing: 47 } });
  assert.equal(findNode(tree, (node) => node.type?.name === 'TrajectoryDetailDialog')!.props.incomplete, true);
  assert.match(JSON.stringify(tree), /缺少.*47/);
  harness.unmount();
});

test('loading verified full audit resets pagination even when live-cap metadata remains unchanged', async () => {
  const harness = uiHarness(await uiBundle('src/ui/Trajectory.tsx'));
  harness.render('TrajectoryPanel', { run: run({ auditVersion: 1, eventsDropped: 50 }) });
  const events: RunRecord['events'] = Array.from({ length: 90 }, (_, index) => ({
    type: 'tool',
    at: at(index),
    data: { tool: `read-${index}`, toolCallId: `call-${index}`, status: 'completed', output: 'result' },
  }));
  const tree = harness.render('TrajectoryPanel', {
    run: run({ auditVersion: 1, auditEventsMissing: 0, eventsDropped: 50, events }),
  });
  const walk = (value: unknown): number =>
    Array.isArray(value)
      ? value.reduce((count, child) => count + walk(child), 0)
      : value && typeof value === 'object'
        ? ((value as { type?: unknown }).type === 'article' ? 1 : 0) +
          walk((value as { props?: { children?: unknown } }).props?.children)
        : 0;
  assert.equal(walk(tree), 50);
  harness.unmount();
});

test('long API-card time view keeps every tool and input while protocol rows collapse once', async () => {
  const events: RunRecord['events'] = [];
  for (let i = 0; i < 30; i++) {
    events.push({
      type: 'tool',
      at: at(i * 22 + 1),
      data: { tool: `tool-${i}`, toolCallId: `call-${i}`, status: 'started' },
    });
    events.push({
      type: 'tool',
      at: at(i * 22 + 1.009),
      data: { toolCallId: `call-${i}`, status: 'completed', result: 'ok' },
    });
  }
  for (let i = 0; i < 2500; i++)
    events.push({
      type: 'status',
      at: at(659),
      text: `packet-${i}`,
      data: { source: 'native', kind: 'protocol-observation', detail: { type: `packet-${i}` } },
    });
  for (let i = 0; i < 60; i++) events.push({ type: 'usage', at: at(660), data: { inputTokens: i } });
  const record = run({ events, endedAt: at(660), output: '', eventsDropped: 0, auditVersion: 1 });
  const html = render(record);
  assert.equal((html.match(/data-lane="tools"/g) ?? []).length, 30);
  assert.match(html, /left:min\(0%, calc\(100% - 3px\)\)[^"]*" data-lane="input"/);
  assert.match(html, /另有 2560 条协议事件/);
  assert.equal((html.match(/class="trajectory-protocol-toggle"/g) ?? []).length, 1);
  assert.doesNotMatch(html, /packet-2499/);
  const harness = uiHarness(await uiBundle('src/ui/Trajectory.tsx'));
  let tree = harness.render('TrajectoryPanel', { run: record });
  findNode(tree, (node) => node.props.className === 'trajectory-protocol-toggle')!.props.onClick();
  tree = harness.render('TrajectoryPanel', { run: record });
  assert.match(JSON.stringify(tree), /packet-0/);
  assert.doesNotMatch(JSON.stringify(tree), /packet-2499/);
  assert.match(JSON.stringify(tree), /显示更多协议事件/);
  const tools = findNode(tree, (node) => node.type === 'button' && node.props.children === '工具')!;
  tools.props.onClick();
  tree = harness.render('TrajectoryPanel', { run: record });
  assert.equal(
    findNode(tree, (node) => node.props['data-lane'] === 'input'),
    undefined,
  );
  assert.equal(
    findNode(tree, (node) => node.props.className === 'trajectory-protocol-toggle'),
    undefined,
  );
  harness.unmount();
});

test('context rows can be hidden without hiding calls or thinking, and early markers open full details', async () => {
  const record = run({
    userInput: 'Inspect the source',
    reasoning: 'A visible thought',
    events: Array.from({ length: 80 }, (_, i) => ({ type: 'text' as const, at: at(i), text: `reply-${i}\n` })),
  });
  const html = renderToStaticMarkup(createElement(TrajectoryPanel, { run: record, hideContextRows: true }));
  assert.doesNotMatch(html, /任务输入|PugPort 执行提示词|PugPort 路由|data-lane="input"/);
  assert.match(html, /思考|A visible thought/);
  assert.match(html, /trajectory-span/);
  const harness = uiHarness(await uiBundle('src/ui/Trajectory.tsx'));
  let tree = harness.render('TrajectoryPanel', { run: record, userInput: record.userInput });
  findNode(tree, (node) => node.props['data-lane'] === 'input')!.props.onClick();
  tree = harness.render('TrajectoryPanel', { run: record, userInput: record.userInput });
  assert.match(
    findNode(tree, (node) => node.type?.name === 'TrajectoryDetailDialog')!.props.text,
    /Inspect the source/,
  );
  harness.unmount();
});
