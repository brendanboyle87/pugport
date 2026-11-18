import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cleanReasoning,
  deriveTimelineGeometry,
  deriveTrajectory,
  isProtocolTrajectoryRow,
  type TrajectoryRow,
} from '../src/shared/trajectory.ts';
import type { RunEvent, RunRecord } from '../src/shared/types.ts';

const at = (seconds: number) => `2026-10-08T12:00:${String(seconds).padStart(2, '0')}.000Z`;
const run = (events: RunEvent[], patch: Partial<RunRecord> = {}): RunRecord => ({
  id: 'run',
  prompt: 'Read the file',
  projectPath: 'C:/fixture',
  kind: 'general',
  status: 'running',
  route: { runtimeId: 'native', model: 'model', kind: 'general', reasons: [], warnings: [] },
  startedAt: at(0),
  output: '',
  events,
  ...patch,
});
const tool = (
  id: string | undefined,
  status: string | undefined,
  time: string,
  data: Record<string, unknown> = {},
): RunEvent => ({
  type: 'tool',
  at: time,
  text: 'Read file',
  data: { toolCallId: id, status, ...data },
});
const tools = (record: RunRecord) => deriveTrajectory(record).rows.filter((row) => row.lane === 'tools');

test('model reply segments carry observed end times and duration and draw spans', () => {
  const record = run(
    [
      { type: 'text', at: at(1), text: 'First ' },
      { type: 'text', at: at(5), text: 'reply' },
      tool('a', 'started', at(6)),
      { type: 'text', at: at(8), text: 'Second ' },
      { type: 'text', at: at(9), text: 'reply' },
    ],
    { endedAt: at(10), status: 'completed' },
  );
  const rows = deriveTrajectory(record).rows.filter((row) => row.label === 'Model reply');
  assert.deepEqual(
    rows.map((row) => [row.text, row.startedAt, row.endedAt, row.durationMs]),
    [
      ['First reply', at(1), at(5), 4000],
      ['Second reply', at(8), at(9), 1000],
    ],
  );
  assert.deepEqual(
    deriveTimelineGeometry(rows, record).marks.map((mark) => [mark.leftPercent, mark.widthPercent]),
    [
      [10, 40],
      [80, 10],
    ],
  );
});

test('each reply segment is redacted once after all its deltas have been joined', () => {
  const prefix = 'Unique segment fixture ';
  const record = run([
    { type: 'text', at: at(1), text: `${prefix}api_key=sk-split` },
    ...Array.from({ length: 500 }, (_, index): RunEvent => ({
      type: 'text',
      at: at(2),
      text: index === 0 ? 'Secret visible ' : 'word ',
    })),
    tool('close', 'started', at(3)),
    { type: 'text', at: at(4), text: `${prefix}tail` },
  ]);
  const originalReplace = String.prototype.replace;
  let cleanPasses = 0;
  String.prototype.replace = function (this: string, pattern: string | RegExp, replacement: string): string {
    if (String(this).startsWith(prefix) && pattern instanceof RegExp && pattern.source.startsWith('<(?:system|'))
      cleanPasses++;
    return Reflect.apply(originalReplace, this, [pattern, replacement]) as string;
  } as typeof String.prototype.replace;
  let projection: ReturnType<typeof deriveTrajectory>;
  try {
    projection = deriveTrajectory(record);
  } finally {
    String.prototype.replace = originalReplace;
  }
  assert.equal(cleanPasses, 2);
  assert.doesNotMatch(JSON.stringify(projection), /sk-split|Secret/);
  assert.match(projection.rows.find((row) => row.label === 'Model reply')!.detail!, /visible/);
});

test('single-chunk model replies keep their event time without a zero duration', () => {
  const projection = deriveTrajectory(run([{ type: 'text', at: at(12), text: 'Done.' }]));
  const reply = projection.rows.find((row) => row.label === 'Model reply')!;
  assert.equal(reply.startedAt, at(12));
  assert.equal(reply.endedAt, at(12));
  assert.equal(reply.durationMs, undefined);
});

test('Pi assistant-message usage attaches only to an open reply, including tool-only messages', () => {
  const record = run([
    { type: 'text', at: at(1), text: 'Calling a tool' },
    {
      type: 'usage',
      at: at(2),
      data: { source: 'Pi RPC', scope: 'assistant-message', input: 12, output: 3, costUsd: 0.01 },
    },
    tool('a', 'started', at(3)),
    {
      type: 'usage',
      at: at(4),
      data: { source: 'Pi RPC', scope: 'assistant-message', input: 18, output: 0, costUsd: 0 },
    },
    { type: 'text', at: at(5), text: 'Finished' },
    { type: 'status', at: at(6), text: 'Boundary' },
    { type: 'usage', at: at(7), data: { source: 'Pi RPC', scope: 'assistant-message', input: 21, output: 2 } },
    { type: 'usage', at: at(8), data: { inputTokens: 4, outputTokens: 1 } },
  ]);
  const projection = deriveTrajectory(record);
  const models = projection.rows.filter((row) => row.lane === 'model');
  assert.deepEqual(
    models.map((row) => [row.label, row.usage?.inputTokens]),
    [
      ['Model reply', 12],
      ['模型调用（无文字）', 18],
      ['Model reply', undefined],
      ['模型调用（无文字）', 21],
    ],
  );
  assert.equal(models[0].endedAt, at(1));
  assert.equal(models[0].usage?.estimatedCostUsd, 0.01);
  assert.equal(models[1].usage?.outputTokens, 0);
  assert.equal(models[1].usage?.estimatedCostUsd, 0);
  assert.deepEqual(
    models[0].sourceEvents?.map((event) => event.type),
    ['text', 'usage'],
  );
  assert.ok(models.every((row) => !isProtocolTrajectoryRow(row)));
  assert.equal(projection.rows.filter(isProtocolTrajectoryRow).length, 1);
  assert.equal(projection.usage.inputTokens, 55);
  assert.equal(deriveTimelineGeometry(projection.rows, record).protocolCount, 1);
});

test('a tool-only model call does not hide a retained final output fallback', () => {
  const projection = deriveTrajectory(
    run([{ type: 'usage', at: at(1), data: { source: 'Pi RPC', scope: 'assistant-message', input: 3 } }], {
      output: 'Retained final answer',
    }),
  );
  assert.equal(projection.rows.find((row) => row.label === 'Model reply')?.detail, 'Retained final answer');
});

test('Claude whole-turn assistant-message usage stays in run totals and never creates a model call', () => {
  for (const withBoundary of [false, true]) {
    const projection = deriveTrajectory(
      run([
        tool('a', 'completed', at(1)),
        { type: 'text', at: at(2), text: 'Done.' },
        ...(withBoundary ? [{ type: 'status' as const, at: at(3), text: 'Permission notice' }] : []),
        { type: 'usage', at: at(4), data: { source: 'Claude CLI', scope: 'assistant-message', inputTokens: 250000 } },
      ]),
    );
    const models = projection.rows.filter((row) => row.lane === 'model');
    assert.equal(models.length, 1);
    assert.equal(models[0].usage, undefined);
    assert.equal(projection.usage.inputTokens, 250000);
    assert.equal(projection.rows.filter(isProtocolTrajectoryRow).length, 1);
  }
});

test('reported thinking is redacted, untimed, and precedes the first model row', () => {
  const reasoning = '<thinking>Consider the fixture password=fixtureSecret</thinking><system>private</system>';
  const projection = deriveTrajectory(run([{ type: 'text', at: at(2), text: 'Answer' }], { reasoning }));
  const index = projection.rows.findIndex((row) => row.label === '思考');
  assert.ok(index >= 0);
  assert.equal(projection.rows[index + 1].label, 'Model reply');
  assert.equal(projection.rows[index].startedAt, undefined);
  assert.equal(projection.rows[index].endedAt, undefined);
  assert.equal(projection.rows[index].durationMs, undefined);
  assert.match(projection.rows[index].detail!, /Consider the fixture/);
  assert.doesNotMatch(projection.rows[index].detail!, /fixtureSecret|<thinking>|<system>private/);
  assert.equal(cleanReasoning('<reasoning>short thought</reasoning>', 5), 'short');
  assert.ok(
    !deriveTimelineGeometry(projection.rows, run([])).marks.some((mark) =>
      mark.rowKeys.includes(projection.rows[index].key),
    ),
  );
});

test('a long API-card run plots every tool and the input while counting all protocol and usage rows', () => {
  const start = Date.parse(at(0));
  const time = (milliseconds: number) => new Date(start + milliseconds).toISOString();
  const events: RunEvent[] = [];
  for (let index = 0; index < 30; index++) {
    const begin = index * 22000 + 1000;
    events.push(tool(`short-${index}`, 'started', time(begin)), tool(`short-${index}`, 'completed', time(begin + 9)));
  }
  for (let index = 0; index < 2500; index++)
    events.push({ type: 'status', at: time(index * 250), data: { source: 'native', kind: 'protocol-observation' } });
  for (let index = 0; index < 60; index++)
    events.push({ type: 'usage', at: time(index * 10000), data: { inputTokens: 1 } });
  const record = run(events, { endedAt: time(660000), status: 'completed' });
  const projection = deriveTrajectory(record, 'Input at the start');
  const geometry = deriveTimelineGeometry(projection.rows, record);
  const toolMarks = geometry.marks.filter((mark) => mark.lane === 'tools');
  assert.equal(toolMarks.length, 30);
  assert.ok(toolMarks.every((mark) => mark.widthPercent >= 100 / 240));
  assert.ok(geometry.marks.some((mark) => mark.rowKeys.includes('run:input') && mark.leftPercent === 0));
  assert.equal(geometry.protocolCount, 2560);
  assert.equal(geometry.elapsedMs, 660000);
  assert.ok(geometry.marks.every((mark) => !mark.rowKeys.some((key) => key.includes(':usage:'))));
});

test('timeline merges same-lane bucket marks with counts, preserves wide spans, and counts unknown times', () => {
  const rows: TrajectoryRow[] = [
    { key: 'one', lane: 'tools', label: 'Tool one', status: 'completed', startedAt: at(1), durationMs: 2000 },
    { key: 'two', lane: 'tools', label: 'Tool two', status: 'completed', startedAt: at(1), durationMs: 9 },
    { key: 'model', lane: 'model', label: 'Model reply', status: 'info', startedAt: at(1), durationMs: 4000 },
    { key: 'unknown', lane: 'status', label: 'Unknown', status: 'info' },
    { key: 'invalid', lane: 'status', label: 'Invalid', status: 'info', startedAt: 'invalid' },
    { key: 'end', lane: 'input', label: 'End', status: 'info', startedAt: at(10) },
  ];
  const before = JSON.stringify(rows);
  const geometry = deriveTimelineGeometry(rows, { startedAt: at(0), endedAt: at(10) });
  assert.equal(geometry.unknownTiming, 2);
  assert.equal(geometry.marks.length, 3);
  assert.deepEqual(geometry.marks[0].rowKeys, ['one', 'two']);
  assert.equal(geometry.marks[0].count, 2);
  assert.equal(geometry.marks[0].widthPercent, 20);
  assert.equal(geometry.marks[1].widthPercent, 40);
  assert.equal(geometry.marks[2].leftPercent + geometry.marks[2].widthPercent, 100);
  assert.ok(geometry.marks[2].widthPercent >= 100 / 240);
  assert.equal(JSON.stringify(rows), before);
  assert.equal(deriveTimelineGeometry(rows, { startedAt: 'invalid' }).marks.length, 0);
});

test('timeline excludes startup timing and both native protocol kinds without treating normal status as protocol', () => {
  const projection = deriveTrajectory(
    run([
      { type: 'status', at: at(1), data: { source: 'pugport', kind: 'startup-timing' } },
      { type: 'status', at: at(2), data: { source: 'native', kind: 'protocol-observation' } },
      { type: 'status', at: at(3), data: { source: 'native', kind: 'protocol-unmapped' } },
      { type: 'status', at: at(4), data: { source: 'native', kind: 'process-start' } },
    ]),
  );
  assert.equal(projection.rows.filter(isProtocolTrajectoryRow).length, 3);
  const geometry = deriveTimelineGeometry(projection.rows, { startedAt: at(0), endedAt: at(5) });
  assert.equal(geometry.protocolCount, 3);
  assert.ok(geometry.marks.some((mark) => mark.row.labelParts?.action === '启动进程'));
});

test('merged timeline marks use the worst status and the widest span within the same status', () => {
  const row = (key: string, status: TrajectoryRow['status'], durationMs?: number): TrajectoryRow => ({
    key,
    lane: 'tools',
    label: key,
    status,
    startedAt: at(1),
    durationMs,
  });
  const ordered = [
    row('info', 'info', 9000),
    row('completed', 'completed', 8000),
    row('pending', 'pending', 7000),
    row('running', 'running', 6000),
    row('failed-point', 'failed'),
    row('failed-span', 'failed', 1000),
  ];
  for (let count = 2; count <= ordered.length; count++) {
    const rows = ordered.slice(0, count);
    for (const direction of [rows, [...rows].reverse()]) {
      const [mark] = deriveTimelineGeometry(direction, { startedAt: at(0), endedAt: at(20) }).marks;
      assert.equal(mark.count, count);
      assert.equal(mark.row.key, rows.at(-1)!.key);
      assert.equal(mark.row.status, rows.at(-1)!.status);
      assert.equal(mark.widthPercent, 45);
    }
  }
});

test('protocol classification uses the explicit row flag only', () => {
  assert.equal(
    isProtocolTrajectoryRow({
      key: 'plain',
      lane: 'status',
      label: 'Usage',
      status: 'info',
      labelParts: { executor: 'Native', action: '协议控制事件' },
      sourceEvents: [{ type: 'usage', sequence: 0, sequenceSource: 'event.seq', at: at(1) }],
    }),
    false,
  );
});

test('result-only tools keep a missing-start notice while plotting their observed end; thinking is intentionally untimed', () => {
  const record = run([tool('result-only', 'completed', at(5))], { reasoning: 'Reported thought', endedAt: at(10) });
  const projection = deriveTrajectory(record);
  const geometry = deriveTimelineGeometry(projection.rows, record);
  assert.equal(geometry.unknownTiming, 1);
  const mark = geometry.marks.find((item) => item.lane === 'tools')!;
  assert.equal(mark.leftPercent, 50);
  assert.equal(mark.widthPercent, 100 / 240);
  assert.equal(mark.row.startedAt, undefined);
  assert.equal(mark.row.endedAt, at(5));
  assert.ok(geometry.marks.every((item) => item.row.label !== '思考'));
});

test('pairs native tool events once, retains failure and stable scoped keys across appended updates', () => {
  const first = run([tool('a', 'pending', at(1)), tool('a', 'inProgress', at(2))]);
  const key = tools(first)[0].key;
  first.events.push(tool('a', 'failed', at(5), { detail: 'File missing' }), tool('a', 'completed', at(5)));
  const projection = deriveTrajectory(first);
  assert.equal(projection.toolsCount, 1);
  assert.equal(tools(first)[0].key, key);
  assert.equal(tools(first)[0].status, 'failed');
  assert.equal(tools(first)[0].durationMs, 4000);
  assert.match(tools(first)[0].detail!, /File missing/);
  assert.notEqual(tools({ ...first, id: 'other' })[0].key, key);
});

test('result-only, unknown phases, invalid times and reversed times never fabricate elapsed time', () => {
  const rows = tools(
    run([
      tool('result', 'completed', at(5)),
      tool('unknown', 'mystery', at(3)),
      tool('invalid', 'started', 'invalid'),
      tool('invalid', 'completed', at(4)),
      tool('reversed', 'started', at(9)),
      tool('reversed', 'completed', at(1)),
      tool(undefined, undefined, at(2)),
      tool(undefined, undefined, at(3)),
    ]),
  );
  assert.equal(rows.length, 6);
  assert.equal(rows[0].startedAt, undefined);
  assert.equal(rows[0].endedAt, at(5));
  assert.equal(rows[1].status, 'info');
  assert.equal(rows[1].startedAt, undefined);
  assert.ok(rows.every((row) => row.durationMs === undefined));
});

test('pairs result before start using actual times without downgrading terminal state', () => {
  const [row] = tools(run([tool('a', 'completed', at(6)), tool('a', 'started', at(1))]));
  assert.equal(row.durationMs, 5000);
  assert.equal(row.status, 'completed');
});
test('nonzero native exit status is a failure even when the command phase is completed', () => {
  const [row] = tools(run([tool('a', 'started', at(1)), tool('a', 'completed', at(4), { exitCode: 1 })]));
  assert.equal(row.status, 'failed');
  assert.equal(row.durationMs, 3000);
});
test('PugPort execution prompts are explicitly inspectable and distinct from original user input', () => {
  const record = run([], { workflowId: 'workflow', prompt: 'EXECUTOR INSTRUCTIONS password=promptsecret' });
  const context = deriveTrajectory(record).rows.find((row) => row.label === 'PugPort execution prompt')!;
  assert.equal(context.source, 'pugport');
  assert.match(context.detail!, /EXECUTOR INSTRUCTIONS/);
  assert.doesNotMatch(context.detail!, /promptsecret/);
  assert.equal(deriveTrajectory(record).rows[0].text, undefined);
  const projection = deriveTrajectory(record, 'User request password=fixtureSecret');
  assert.match(projection.rows[0].text!, /User request/);
  assert.ok(!JSON.stringify(projection).includes('fixtureSecret'));
});

test('actual PugPort execution context supersedes the older run prompt and preserves only explicit application fields', () => {
  const record = run(
    [
      {
        type: 'status',
        at: at(1),
        data: {
          source: 'pugport',
          kind: 'execution-context',
          detail: {
            prompt: 'Actual hint <system>app instruction</system> api_key=sk-secretFixture',
            instructions: 'Explicit app instruction',
            permissionMode: 'read-only',
            nativeSystemPrompt: 'not-reported',
            reasoning: 'HIDDEN_THOUGHT',
          },
          raw: 'HIDDEN_PACKET',
        },
      },
      {
        type: 'status',
        at: at(2),
        data: {
          source: 'pugport',
          kind: 'routing',
          detail: {
            runtimeId: 'actual-runtime',
            model: 'actual-model',
            reasons: ['quota available'],
            warnings: ['limited'],
          },
        },
      },
      { type: 'status', at: at(3), data: { kind: 'execution-context', detail: { prompt: 'NATIVE_HIDDEN_PROMPT' } } },
    ],
    {
      prompt: 'OLD_CONTEXT',
      route: { runtimeId: 'old-runtime', model: 'old-model', kind: 'general', reasons: [], warnings: [] },
    },
  );
  const projected = deriveTrajectory(record),
    serialized = JSON.stringify(projected);
  assert.equal(projected.rows.filter((row) => row.label === 'PugPort execution context').length, 1);
  assert.equal(projected.rows.filter((row) => row.label === 'PugPort routing').length, 1);
  for (const text of ['Actual hint', 'app instruction', 'Explicit app instruction', 'actual-model', 'quota available'])
    assert.ok(serialized.includes(text));
  for (const text of [
    'OLD_CONTEXT',
    'old-model',
    'HIDDEN_THOUGHT',
    'HIDDEN_PACKET',
    'NATIVE_HIDDEN_PROMPT',
    'sk-secretFixture',
  ])
    assert.ok(!serialized.includes(text), text);
});

test('same-name native and PugPort tools remain distinct even when their independent IDs collide', () => {
  const record = run([
    tool('same', 'started', at(1), { tool: 'read_file', source: 'native', arguments: { file: 'native.txt' } }),
    tool('same', 'started', at(2), {
      tool: 'read_file',
      source: 'pugport',
      kind: 'pugportToolCall',
      arguments: { file: 'bridge.txt' },
      handler: 'agent-bridge',
      origin: 'pugport',
    }),
    tool('same', 'completed', at(3), { source: 'native', result: 'native result' }),
    tool('same', 'completed', at(4), {
      source: 'pugport',
      result: 'bridge result',
      steps: [{ name: 'read', status: 'completed' }],
    }),
  ]);
  const rows = tools(record);
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((row) => row.source),
    ['native', 'pugport'],
  );
  assert.notEqual(rows[0].key, rows[1].key);
  assert.match(rows[0].detail!, /native.txt/);
  assert.doesNotMatch(rows[0].detail!, /bridge.txt/);
  assert.match(rows[1].detail!, /bridge.txt|agent-bridge|read/);
  assert.doesNotMatch(rows[1].detail!, /native.txt/);
});

test('explicit bridge-to-native linkage combines calls while retaining separate observed arguments and results', () => {
  const record = run([
    tool('native-a', 'started', at(1), { tool: 'read_file', input: 'native input' }),
    tool('bridge-a', 'started', at(2), {
      source: 'pugport',
      nativeToolCallId: 'native-a',
      tool: 'read_file',
      arguments: { file: 'bridge input' },
      handler: 'reader',
    }),
    tool('bridge-a', 'completed', at(3), {
      source: 'pugport',
      nativeToolCallId: 'native-a',
      result: 'bridge result',
      journal: [{ path: 'old.txt' }],
      moved: ['new.txt'],
    }),
    tool('native-a', 'completed', at(4), { output: 'native result' }),
  ]);
  const [row] = tools(record);
  assert.equal(deriveTrajectory(record).toolsCount, 1);
  assert.equal(row.source, 'linked');
  assert.equal(row.nativeToolId, 'native-a');
  assert.equal(row.toolCallId, 'bridge-a');
  for (const value of [
    'native input',
    'bridge input',
    'bridge result',
    'native result',
    'old.txt',
    'new.txt',
    'reader',
  ])
    assert.ok(row.detail!.includes(value), value);
});

test('recorded application communications and internal steps retain explicit relations and redact secrets', () => {
  const projection = deriveTrajectory(
    run([
      {
        type: 'status',
        at: at(1),
        text: 'Assigned child',
        data: {
          source: 'pugport',
          kind: 'communication',
          detail: {
            fromRunId: 'parent',
            toRunId: 'child',
            text: 'Review code password=secret123',
            status: 'delivered',
          },
        },
      },
      {
        type: 'status',
        at: at(2),
        data: {
          source: 'pugport',
          kind: 'internal-step',
          parentToolCallId: 'bridge-parent',
          stepId: 'step-read',
          detail: { name: 'read', label: 'Read source', status: 'completed', detail: { files: ['a.ts'] } },
        },
      },
    ]),
  );
  const communication = projection.rows.find((row) => row.label === 'PugPort communication')!;
  const step = projection.rows.find((row) => row.label === 'Read source')!;
  assert.match(communication.detail!, /parent|child|Review code|delivered/);
  assert.doesNotMatch(communication.detail!, /secret123/);
  assert.match(step.detail!, /bridge-parent|step-read|a.ts/);
  assert.match(step.text!, /父调用未知.*bridge-parent/);
});

test('legacy tool events with no captured display fields are explicitly marked missing', () => {
  const [row] = tools(run([tool('a', 'completed', at(1))]));
  assert.equal(row.detailMissing, true);
});
test('Pi native numeric usage aliases are retained without converting text to numbers', () => {
  const projection = deriveTrajectory(
    run([
      {
        type: 'usage',
        at: at(1),
        data: { input: 3, output: 4, cacheRead: 0, cacheWrite: '1', totalTokens: 7, costUsd: 0.01 },
      },
    ]),
  );
  assert.equal(projection.usage.inputTokens, 3);
  assert.equal(projection.usage.outputTokens, 4);
  assert.equal(projection.usage.cacheReadTokens, 0);
  assert.equal(projection.usage.cacheWriteTokens, null);
  assert.equal(projection.usage.estimatedCostUsd, 0.01);
});

test('Codex item IDs and Claude tool IDs stay separate from workflow metadata', () => {
  const record = run(
    [
      tool(undefined, 'inProgress', at(1), { itemId: 'native', kind: 'commandExecution' }),
      tool(undefined, 'completed', at(4), { itemId: 'native', exitCode: 0 }),
    ],
    { parentRunId: 'parent', workflowId: 'workflow', stepId: 'step' },
  );
  const projection = deriveTrajectory(record);
  assert.equal(projection.toolsCount, 1);
  assert.equal(projection.rows.find((row) => row.lane === 'tools')!.durationMs, 3000);
  assert.deepEqual(projection.metadata, { parentRunId: 'parent', workflowId: 'workflow', stepId: 'step' });
  assert.ok(projection.rows.every((row) => row.nativeToolId !== 'parent'));
});

test('long explicit call and runtime IDs remain visible correlation metadata', () => {
  const id = 'tool-call-a12b34c5-d67e-8901-a23b-456c789d012e';
  const runtimeId = 'grok-account-a12b34c5-d67e-8901-a23b-456c789d012e';
  const record = run([tool(id, 'started', at(1)), tool(id, 'completed', at(2))]);
  record.route.runtimeId = runtimeId;
  const projection = deriveTrajectory(record);
  assert.equal(projection.rows.find((row) => row.lane === 'tools')!.nativeToolId, id);
  assert.match(projection.rows.find((row) => row.label === 'PugPort routing')!.detail!, new RegExp(runtimeId));
});

test('redacts secrets across deltas and objects and omits native reasoning/private protocol contents', () => {
  const projection = deriveTrajectory(
    run(
      [
        { type: 'text', at: at(1), text: 'api_key=sk-fixture' },
        { type: 'text', at: at(2), text: 'Secret123 and hello' },
        { type: 'reasoning', at: at(2), text: 'hidden thought' },
        { type: 'text', at: at(3), text: 'keep talking' },
        { type: 'text', at: at(3), text: 'private role', data: { role: 'developer' } },
        tool('a', 'started', at(4), {
          arguments: {
            api_key: 'nestedsecret',
            safe: 'visible',
            nested: { password: 'othersecret', system: 'system contents' },
          },
          result: [{ role: 'system', content: 'private conversation' }],
          protocol: { secret: 'private protocol' },
          detail: 'Authorization: Bearer bearerSecret123 token="quotedsecret" ghp_thisIsATestSecret123',
        }),
      ],
      {
        prompt: 'password=promptsecret do work',
        reasoning: 'reported thought password=reasoningSecret',
        output: 'result Bearer outputsecret <thinking>private final thought</thinking>',
      },
    ),
  );
  const serialized = JSON.stringify(projection);
  for (const secret of [
    'sk-fixture',
    'Secret123',
    'hidden thought',
    'private role',
    'nestedsecret',
    'othersecret',
    'system contents',
    'private conversation',
    'private protocol',
    'bearerSecret123',
    'quotedsecret',
    'ghp_thisIsATestSecret123',
    'promptsecret',
    'reasoningSecret',
    'outputsecret',
    'private final thought',
  ])
    assert.ok(!serialized.includes(secret), secret);
  assert.match(serialized, /visible/);
  assert.match(projection.rows.find((row) => row.label === '思考')!.text!, /reported thought/);
  assert.equal(projection.rows.filter((row) => row.label === 'Model reply').length, 1);
  assert.match(projection.rows.find((row) => row.label === 'Model reply')!.text!, /hello.*keep talking/);
});

test('bounds previews while retaining full reply/output, handles cyclic details and leaves source record unchanged', () => {
  const cyclic: Record<string, unknown> = { safe: 'x'.repeat(10000) };
  cyclic.self = cyclic;
  const record = run(
    [tool('a', 'started', at(1), { arguments: cyclic }), { type: 'text', at: at(2), text: 'readable '.repeat(10000) }],
    { output: 'readable '.repeat(10000) },
  );
  const projection = deriveTrajectory(record);
  assert.ok(projection.outputSummary.length <= 4000);
  assert.match(projection.rows.find((row) => row.lane === 'tools')!.detail!, /capture truncated/);
  assert.ok(projection.rows.find((row) => row.lane === 'model')!.text!.length <= 4000);
  assert.equal(projection.outputDetail.length, record.output.length);
  assert.equal(projection.rows.find((row) => row.lane === 'model')!.detail!.length, 90000);
  assert.equal(record.events.length, 2);
  assert.equal(record.events[0].data!.arguments, cyclic);
});

test('full captured prompts, tool input/result and model output retain long-content tail markers', () => {
  const record = run(
    [
      tool('a', 'started', at(1), { input: 'input paragraph '.repeat(9000) + 'TOOL_INPUT_TAIL' }),
      tool('a', 'completed', at(3), { output: 'result paragraph '.repeat(9000) + 'TOOL_OUTPUT_TAIL' }),
      { type: 'text', at: at(4), text: 'model paragraph '.repeat(9000) + 'STREAM_TAIL' },
    ],
    {
      prompt: 'application instruction '.repeat(9000) + 'APP_PROMPT_TAIL',
      output: 'final response '.repeat(10000) + 'OUTPUT_TAIL',
    },
  );
  const projection = deriveTrajectory(record);
  assert.match(projection.rows.find((row) => row.label === 'PugPort execution prompt')!.detail!, /APP_PROMPT_TAIL$/);
  const [call] = tools(record);
  assert.match(call.detail!, /TOOL_INPUT_TAIL/);
  assert.match(call.detail!, /TOOL_OUTPUT_TAIL/);
  assert.match(projection.rows.find((row) => row.lane === 'model')!.detail!, /STREAM_TAIL$/);
  assert.match(projection.outputDetail, /OUTPUT_TAIL$/);
  assert.equal(projection.outputSummary.length, 4000);
});

test('long user commands, status and error records retain their tails in full details', () => {
  const body = 'ordinary captured paragraph '.repeat(5000);
  const projection = deriveTrajectory(
    run([
      { at: at(1), type: 'status', text: body + 'STATUS_DETAIL_TAIL' },
      { at: at(2), type: 'error', text: body + 'ERROR_DETAIL_TAIL' },
    ]),
    body + 'USER_COMMAND_TAIL',
  );
  assert.match(projection.rows.find((row) => row.label === 'User input')!.detail!, /USER_COMMAND_TAIL$/);
  assert.match(projection.rows.find((row) => row.label === 'Status')!.detail!, /STATUS_DETAIL_TAIL$/);
  assert.match(projection.rows.find((row) => row.label === 'Error')!.detail!, /ERROR_DETAIL_TAIL$/);
  assert.ok(projection.rows.find((row) => row.label === 'Status')!.text!.length <= 4000);
  const fallback = deriveTrajectory(run([], { error: body + 'FALLBACK_ERROR_TAIL' }));
  assert.match(fallback.rows.find((row) => row.label === 'Error')!.detail!, /FALLBACK_ERROR_TAIL$/);
});

test('summary copies request detail; sparse full records do not pretend observed tool activity', () => {
  const summary = deriveTrajectory(run([], { summary: true, output: 'preview' }));
  assert.equal(summary.needsDetail, true);
  assert.deepEqual(summary.rows, []);
  const full = deriveTrajectory(run([], { output: 'answer', hadToolActivity: true }));
  assert.equal(full.needsDetail, false);
  assert.equal(full.toolsCount, 0);
  assert.equal(full.rows.find((row) => row.lane === 'model')!.startedAt, undefined);
});

test('numeric-only live usage preserves zero, subtracts explicit baselines and deduplicates', () => {
  const usage = (data: Record<string, unknown>, seconds = 1): RunEvent => ({ type: 'usage', at: at(seconds), data });
  const projection = deriveTrajectory(
    run([
      usage({ scope: 'session-cumulative', total: { inputTokens: 100, outputTokens: 5 }, baseline: true }),
      usage({ scope: 'session-cumulative', total: { inputTokens: 120, outputTokens: 5 }, eventId: 'live' }, 2),
      usage({ scope: 'session-cumulative', total: { inputTokens: 120, outputTokens: 5 }, eventId: 'live' }, 3),
      usage({ cacheReadTokens: '99', totalTokens: NaN, estimatedCostUsd: Infinity }),
    ]),
  );
  assert.equal(projection.usage.inputTokens, 20);
  assert.equal(projection.usage.outputTokens, 0);
  assert.equal(projection.usage.cacheReadTokens, null);
  assert.equal(projection.usage.totalTokens, null);
  assert.equal(projection.usage.estimatedCostUsd, null);
  assert.ok(projection.rows.filter((row) => row.label === 'Usage').every(isProtocolTrajectoryRow));
  assert.equal(
    deriveTrajectory(run([usage({ scope: 'session-cumulative', inputTokens: 500 })])).usage.inputTokens,
    null,
  );
  assert.equal(
    deriveTrajectory(run([usage({ scope: 'session-cumulative', inputTokens: 500, freshSession: true })])).usage
      .inputTokens,
    500,
  );
});

test('usage deltas add once while cumulative snapshots replace rather than multiply', () => {
  const projection = deriveTrajectory(
    run([
      { type: 'usage', at: at(1), data: { inputTokens: 2, eventId: 'one' } },
      { type: 'usage', at: at(2), data: { inputTokens: 3, eventId: 'two' } },
      { type: 'usage', at: at(3), data: { estimatedCostUsd: 0.2, cumulative: true } },
      { type: 'usage', at: at(4), data: { estimatedCostUsd: 0.4, cumulative: true } },
    ]),
  );
  assert.equal(projection.usage.inputTokens, 5);
  assert.equal(projection.usage.estimatedCostUsd, 0.4);
});

test('retained event sequence keys survive window trimming and expose missing history', () => {
  const event: RunEvent = { type: 'status', seq: 9, at: at(1), text: 'Running' };
  const first = deriveTrajectory(run([{ type: 'status', seq: 8, at: at(0) }, event], { eventsDropped: 0 }));
  const next = deriveTrajectory(run([event], { eventsDropped: 1 }));
  assert.equal(
    first.rows.find((row) => row.text === 'Running')!.key,
    next.rows.find((row) => row.text === 'Running')!.key,
  );
  assert.equal(next.eventsDropped, 1);
});

test('approval outcomes, errors and run lifecycle retain observed status without closing incomplete tools', () => {
  const projection = deriveTrajectory(
    run(
      [
        tool('a', 'started', at(1)),
        { type: 'approval', at: at(2), text: 'Denied', data: { status: 'denied' } },
        { type: 'error', at: at(3), text: 'password=errorsecret failed' },
      ],
      { status: 'failed', endedAt: at(5) },
    ),
  );
  assert.equal(projection.rows.find((row) => row.lane === 'tools')!.status, 'info');
  assert.match(projection.rows.find((row) => row.lane === 'tools')!.text!, /completion was not observed/);
  assert.equal(projection.rows.find((row) => row.label === 'Approval')!.status, 'failed');
  assert.equal(projection.rows.find((row) => row.label === 'Run status')!.durationMs, 5000);
  assert.ok(!JSON.stringify(projection).includes('errorsecret'));
});
test('tool start inputs and terminal outputs both survive pairing and remain sanitized', () => {
  const record = run([
    tool('a', 'started', at(1), {
      command: 'read fixture.txt',
      arguments: { file: 'fixture.txt', token: 'startsecret' },
    }),
    tool('a', 'completed', at(3), { output: 'Read 10 lines password=endsecret', exitCode: 0 }),
    tool('a', 'completed', at(3), { output: 'Read 10 lines password=endsecret', exitCode: 0 }),
  ]);
  const [row] = tools(record);
  assert.match(row.detail!, /read fixture.txt/);
  assert.match(row.detail!, /fixture.txt/);
  assert.match(row.detail!, /Read 10 lines/);
  assert.ok(!row.detail!.includes('startsecret'));
  assert.ok(!row.detail!.includes('endsecret'));
  assert.equal(row.status, 'completed');
  assert.equal(deriveTrajectory(record).toolsCount, 1);
  const [long] = tools(
    run([
      tool('long', 'started', at(1), { input: Array.from({ length: 30 }, () => 'Start detail '.repeat(1000)) }),
      tool('long', 'completed', at(3), { output: 'Terminal result remains visible' }),
    ]),
  );
  assert.ok(long.detail!.length > 0);
  assert.match(long.detail!, /Start detail/);
  assert.match(long.detail!, /Terminal result remains visible/);
});
test('an ended run reports missing tool completion as unknown without inventing tool end times', () => {
  for (const status of ['completed', 'failed', 'cancelled', 'interrupted'] as const) {
    const [row] = tools(run([tool('a', 'started', at(1))], { status, endedAt: at(5) }));
    assert.equal(row.status, 'info');
    assert.match(row.text!, /completion was not observed/);
    assert.equal(row.endedAt, undefined);
    assert.equal(row.durationMs, undefined);
  }
  const [live] = tools(run([tool('a', 'started', at(1))]));
  assert.equal(live.status, 'running');
});

test('internal stages nest only under explicit bridge parents and preserve every observation', () => {
  const stage = (parent: string, phase: string, seconds: number): RunEvent => ({
    type: 'status',
    at: at(seconds),
    text: 'Validate scope',
    data: {
      source: 'pugport',
      kind: 'internal-step',
      parentToolCallId: parent,
      stepId: 'validate',
      status: phase,
      detail: { label: 'Validate scope', status: phase, detail: { message: phase, password: 'secretFixture' } },
    },
  });
  const record = run([
    stage('bridge', 'running', 1),
    tool('bridge', 'started', at(2), {
      source: 'pugport',
      tool: 'find_files',
      arguments: { folder: 'D:/fixture', query: 'target' },
    }),
    tool('bridge', 'started', at(2), { source: 'native', tool: 'find_files' }),
    stage('bridge', 'completed', 4),
    stage('missing', 'failed', 5),
    tool('bridge', 'completed', at(5), { source: 'pugport', result: { count: 3 } }),
  ]);
  const before = JSON.stringify(record);
  const projection = deriveTrajectory(record);
  assert.equal(projection.toolsCount, 2);
  const parent = projection.rows.find((row) => row.toolCallId === 'bridge')!;
  assert.equal(parent.children?.length, 1);
  assert.equal(parent.children![0].durationMs, 3000);
  assert.equal(parent.children![0].status, 'completed');
  assert.match(parent.children![0].detail!, /running.*|completed/);
  assert.match(parent.detail!, /observations/);
  assert.match(parent.argumentPreview!, /D:\/fixture.*target/);
  assert.match(parent.outcome!, /count: 3/);
  assert.equal(projection.rows.find((row) => row.nativeToolId === 'bridge')!.children, undefined);
  assert.equal(projection.rows.filter((row) => row.label === 'Validate scope').length, 1);
  assert.match(projection.rows.find((row) => row.label === 'Validate scope')!.text!, /父调用未知.*missing/);
  assert.doesNotMatch(JSON.stringify(projection), /secretFixture/);
  assert.equal(JSON.stringify(record), before);
});

test('many internal observations cannot evict primary tool records from pagination', () => {
  const events: RunEvent[] = [];
  for (let index = 0; index < 12; index++) {
    events.push(
      tool(`bridge-${index}`, 'started', at(1), {
        source: 'pugport',
        tool: 'search',
        arguments: { query: `query-${index}` },
      }),
    );
    for (let step = 0; step < 20; step++)
      events.push({
        type: 'status',
        at: at(2),
        text: `stage-${step}`,
        data: {
          source: 'pugport',
          kind: 'internal-step',
          parentToolCallId: `bridge-${index}`,
          stepId: `step-${step}`,
          status: 'completed',
        },
      });
  }
  const projection = deriveTrajectory(run(events));
  assert.equal(projection.toolsCount, 12);
  assert.equal(projection.rows.filter((row) => row.children?.length === 20).length, 12);
  assert.ok(projection.rows.length < 50);
  assert.equal(projection.rows.at(-1)?.label, 'Run status');
});

test('paired tool detail preserves ordered pending, enriched input, streamed output and completion observations', () => {
  const events = [
    tool('call', 'pending', at(1), { tool: 'run_terminal_command', input: { command: 'first' } }),
    tool('call', undefined, at(2), { input: { command: 'enriched', password: 'secretFixture' } }),
    tool('call', 'running', at(3), { output: 'partial output' }),
    tool('call', 'completed', at(4), { output: 'terminal output', exitCode: 0 }),
  ].map((event, index) => ({ ...event, seq: 100 + index }));
  const [row] = tools(run(events));
  const history = JSON.parse(row.detail!).observations;
  assert.equal(history.length, 4);
  assert.deepEqual(
    history.map((event: { sequence: number }) => event.sequence),
    [100, 101, 102, 103],
  );
  assert.deepEqual(
    history.map((event: { data: { status?: string } }) => event.data.status),
    ['pending', undefined, 'running', 'completed'],
  );
  assert.equal(history[0].data.input.command, 'first');
  assert.equal(history[1].data.input.command, 'enriched');
  assert.equal(history[2].data.output, 'partial output');
  assert.equal(history[3].data.output, 'terminal output');
  assert.doesNotMatch(row.detail!, /secretFixture/);
});

test('explicit native lifecycle and unmapped packets retain safe diagnostics and concrete source labels', () => {
  const projection = deriveTrajectory(
    run([
      {
        type: 'status',
        at: at(1),
        data: {
          source: 'native',
          kind: 'process-start',
          detail: {
            provider: 'grok',
            executor: 'Grok B',
            command: 'grok',
            args: ['--json'],
            cwd: 'C:/fixture',
            pid: 42,
            system: 'HIDDEN_SYSTEM',
            prompt: 'HIDDEN_NATIVE_PROMPT',
          },
        },
      },
      {
        type: 'status',
        at: at(2),
        data: {
          source: 'native',
          kind: 'protocol-unmapped',
          detail: { method: 'session/update', variant: 'NewPacket', fields: ['variant'] },
        },
      },
      {
        type: 'status',
        at: at(3),
        data: {
          source: 'native',
          kind: 'process-exit',
          detail: { provider: 'grok', executor: 'Grok B', exitCode: 1, signal: null },
        },
      },
    ]),
  );
  const start = projection.rows.find((row) => row.label.includes('启动进程'))!;
  assert.match(start.label, /Grok CLI \/ Grok B/);
  assert.match(start.detail!, /grok|--json|C:\/fixture|42/);
  assert.equal(start.source, 'native');
  assert.equal(start.status, 'running');
  assert.match(projection.rows.find((row) => row.label.includes('未映射协议事件'))!.detail!, /NewPacket/);
  assert.equal(projection.rows.find((row) => row.label.includes('进程退出'))!.status, 'failed');
  assert.doesNotMatch(JSON.stringify(projection), /HIDDEN_SYSTEM|HIDDEN_NATIVE_PROMPT/);
});

test('source references retain actual sequence IDs and label legacy indices without exposing individual text deltas', () => {
  const projection = deriveTrajectory(
    run([
      { type: 'text', at: at(1), seq: 201, text: 'api_key=sk-fixture' },
      { type: 'text', at: at(2), seq: 205, text: 'SecretValue public result' },
      {
        type: 'status',
        at: at(3),
        seq: 208,
        data: { source: 'native', kind: 'protocol-observation', detail: { variant: 'ToolCallsUpdate', toolCount: 2 } },
      },
      tool('legacy', 'started', at(4)),
    ]),
  );
  const reply = projection.rows.find((row) => row.lane === 'model')!;
  assert.deepEqual(
    reply.sourceEvents!.map((event) => event.sequence),
    [201, 205],
  );
  assert.ok(reply.sourceEvents!.every((event) => event.sequenceSource === 'event.seq'));
  assert.deepEqual(
    reply.sourceEvents!.map((event) => event.length),
    [18, 25],
  );
  assert.match(reply.detail!, /public result/);
  assert.doesNotMatch(JSON.stringify(projection), /sk-fixture|SecretValue/);
  const control = projection.rows.find((row) => row.label.includes('协议控制事件'))!;
  assert.match(control.detail!, /ToolCallsUpdate/);
  assert.equal(control.sourceEvents![0].sequence, 208);
  const legacy = projection.rows.find((row) => row.lane === 'tools')!;
  assert.equal(legacy.sourceEvents![0].sequence, 3);
  assert.equal(legacy.sourceEvents![0].sequenceSource, 'legacy-index');
  assert.equal(JSON.parse(legacy.detail!).observations[0].sequenceSource, 'legacy-index');
});

test('tool record counts describe native and PugPort observation layers including explicit links', () => {
  const projection = deriveTrajectory(
    run([
      tool('native', 'started', at(1)),
      tool('bridge', 'started', at(2), { source: 'pugport' }),
      tool('linked-native', 'started', at(3)),
      tool('linked-bridge', 'completed', at(4), { source: 'pugport', nativeToolCallId: 'linked-native' }),
    ]),
  );
  assert.equal(projection.toolsCount, 3);
  assert.equal(projection.nativeToolsCount, 2);
  assert.equal(projection.pugportToolsCount, 2);
});

test('Pi API model observations retain safe model identity without inventing tool or completion states', () => {
  const projection = deriveTrajectory(
    run([
      {
        type: 'status',
        at: at(1),
        data: {
          source: 'native',
          kind: 'model-request',
          detail: {
            provider: 'pi',
            executor: 'Pi API',
            requestedProvider: 'openai',
            model: 'requested-model',
            api_key: 'secret-fixture',
          },
        },
      },
      {
        type: 'status',
        at: at(2),
        data: {
          source: 'native',
          kind: 'model-confirmed',
          detail: {
            provider: 'pi',
            executor: 'Pi API',
            confirmedModel: { provider: 'openai', id: 'confirmed-model', name: 'Model name' },
          },
        },
      },
    ]),
  );
  assert.equal(projection.toolsCount, 0);
  const requested = projection.rows.find((row) => row.label.includes('请求 API 模型'))!;
  const confirmed = projection.rows.find((row) => row.label.includes('已确认 API 模型'))!;
  assert.equal(requested.status, 'info');
  assert.equal(confirmed.status, 'info');
  assert.match(confirmed.detail!, /confirmed-model|Model name/);
  assert.doesNotMatch(JSON.stringify(projection), /secret-fixture/);
});

test('explicit native diagnostic fields survive tool aggregation and each original observation', () => {
  const fields = {
    outputMode: 'delta',
    observedPhase: 'output',
    nativeMethod: 'item/commandExecution/outputDelta',
    captureState: 'metadata-only',
    observedFields: ['output'],
    failureDetail: { message: 'failed', password: 'secretFixture' },
    durationMs: 42,
    parentToolCallId: 'parent',
    partial: true,
    resultObserved: false,
    startUnknown: true,
    malformedErrorFlag: true,
  };
  const [row] = tools(run([tool('call', undefined, at(1), fields)]));
  const detail = JSON.parse(row.detail!);
  for (const key of Object.keys(fields)) {
    assert.ok(key in detail.native, key);
    assert.ok(key in detail.observations[0].data, key);
  }
  assert.equal(row.durationMs, undefined);
  assert.doesNotMatch(row.detail!, /secretFixture/);
});

test('native output deltas remain individual observations and cannot replace a retained full snapshot', () => {
  const [row] = tools(
    run([
      tool('call', 'started', at(1)),
      tool('call', undefined, at(2), { output: 'partial', outputMode: 'delta' }),
      tool('call', 'completed', at(3), { output: 'full final output' }),
      tool('call', undefined, at(4), { output: 'late replay delta', outputMode: 'delta' }),
    ]),
  );
  const detail = JSON.parse(row.detail!);
  assert.equal(detail.native.output, 'full final output');
  assert.equal(detail.native.outputMode, undefined);
  assert.equal(detail.observations[1].data.output, 'partial');
  assert.equal(detail.observations[3].data.output, 'late replay delta');
  assert.equal(detail.observations[3].data.outputMode, 'delta');
});

test('short tool summaries do not claim capture loss and full details retain their tails', () => {
  const command = `Get-Content ${'fixture/'.repeat(80)}command-tail.txt`;
  const message = `${'result '.repeat(80)}result-tail`;
  const [row] = tools(run([tool('call', 'completed', at(3), { input: { command }, output: { message } })]));
  assert.ok(row.argumentPreview?.endsWith('…'));
  assert.ok(row.outcome?.endsWith('…'));
  assert.doesNotMatch(`${row.argumentPreview} ${row.outcome}`, /capture truncated/);
  assert.match(row.detail!, /command-tail\.txt/);
  assert.match(row.detail!, /result-tail/);
});
