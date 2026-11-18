// Synthetic data only: no executors, accounts or providers are contacted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { contextFromEvent } from '../src/shared/context-usage.ts';
import {
  contextDrops,
  contextParts,
  diffParts,
  estimateTokens,
  partGroup,
  type ContextPart,
} from '../src/shared/context-trace.ts';
import { runSentParts } from '../src/shared/conversation-trace.ts';
import { parseRequestObservation, RequestLedger } from '../src/server/usage-requests.ts';
import { commandProgram, ToolOperationIndex } from '../src/server/tool-operations.ts';
import { TraceContext, type TraceContextDeps } from '../src/server/trace-context.ts';
import { WorkspaceStore } from '../src/server/workspace-store.ts';
import type { RunEvent, RunRecord, Workflow } from '../src/shared/types.ts';

const at = (seconds: number) => new Date(Date.UTC(2026, 10, 1, 10) + seconds * 1000).toISOString();
const run = (id: string, extra: Partial<RunRecord> = {}): RunRecord => ({
  id,
  prompt: '',
  projectPath: '/synthetic',
  kind: 'routine',
  status: 'completed',
  route: { runtimeId: 'pi-card', model: 'synthetic/model', kind: 'routine', reasons: [], warnings: [] },
  startedAt: at(0),
  endedAt: at(60),
  output: '',
  events: [],
  ...extra,
});
const piUsage = (id: string, input: number, extra: Record<string, unknown> = {}): RunEvent => ({
  type: 'usage',
  at: at(10),
  data: {
    source: 'Pi RPC',
    cumulative: false,
    scope: 'assistant-message',
    eventId: id,
    input,
    output: 40,
    cacheRead: 1000,
    cacheWrite: 0,
    totalTokens: input + 1040,
    costUsd: 0.002,
    contextWindow: 200000,
    requestStartedAt: at(8),
    ...extra,
  },
});

test('Pi assistant messages give context occupancy and a full request row; Grok reports nothing', () => {
  const event = piUsage('pi-1', 500);
  assert.deepEqual(contextFromEvent('pi', 'synthetic/model', event), { tokens: 1500, window: 200000, at: at(10) });
  const parsed = parseRequestObservation('pi', 'synthetic/model', event)!;
  assert.equal(parsed.source, 'pi-assistant-message');
  assert.equal(parsed.scope, 'request');
  assert.equal(parsed.startedAt, at(8));
  assert.equal(parsed.endedAt, at(10));
  assert.equal(parsed.contextTokens, 1500);
  assert.equal(parsed.usage?.inputTokens, 500);
  assert.equal(parsed.usage?.cacheReadTokens, 1000);
  assert.equal(parsed.usage?.costUsd, 0.002);
  assert.equal(parsed.usage?.reasoningOutputTokens, null, 'unreported reasoning stays null, not zero');
  // A Pi message without cache buckets is not turned into a context total.
  const partial = parseRequestObservation('pi', 'm', piUsage('pi-2', 10, { cacheRead: undefined }))!;
  assert.equal(partial.contextTokens, null);
  assert.equal(
    parseRequestObservation('grok', 'm', { type: 'usage', at: at(1), data: { input_tokens: 5, output_tokens: 1 } }),
    undefined,
  );
});

test('Claude snapshots, Codex last usage and Cursor occupancy are recorded with their own scope', () => {
  const claude = parseRequestObservation('claude', 'claude-opus[1m]', {
    type: 'status',
    at: at(3),
    data: {
      messageUsage: { input_tokens: 10, cache_read_input_tokens: 20000, cache_creation_input_tokens: 300 },
      messageId: 'msg_1',
    },
  })!;
  assert.equal(claude.requestId, 'msg_1');
  assert.equal(claude.contextTokens, 20310);
  assert.equal(claude.contextWindow, 1_000_000);
  assert.equal(claude.usage?.outputTokens, null);
  const codex = parseRequestObservation('codex', 'gpt', {
    type: 'usage',
    at: at(4),
    data: {
      eventId: 'tokens-1',
      last: {
        totalTokens: 900,
        inputTokens: 800,
        cachedInputTokens: 600,
        outputTokens: 100,
        reasoningOutputTokens: 20,
      },
      modelContextWindow: 272000,
    },
  })!;
  assert.equal(codex.contextTokens, 880);
  assert.equal(codex.usage?.inputTokens, 200, 'Codex input includes cache; the row stores uncached input');
  assert.equal(
    parseRequestObservation('codex', 'gpt', {
      type: 'usage',
      at: at(4),
      data: { baseline: true, last: { totalTokens: 1 } },
    }),
    undefined,
    'a resumed session baseline is not a request',
  );
  const cursor = parseRequestObservation('cursor', 'auto', {
    type: 'status',
    at: at(5),
    data: { contextTokens: 4000, contextWindow: 128000 },
  })!;
  assert.equal(cursor.scope, 'occupancy');
  assert.equal(cursor.usage, null);
});

test('request ledger upserts idempotently, batches writes and keeps ordinals across restarts', () => {
  const db = new DatabaseSync(':memory:');
  const ledger = new RequestLedger(db, { batchSize: 1000, flushDelayMs: 60_000 });
  const owner = run('r1');
  ledger.observe(owner, 'pi', piUsage('pi-a', 100));
  ledger.observe(owner, 'pi', piUsage('pi-b', 200));
  ledger.observe(owner, 'pi', piUsage('pi-a', 150)); // replay of the first message with newer figures
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM usage_requests').get() as { n: number }).n, 0, 'batched');
  assert.equal(ledger.flush(), 2);
  const page = ledger.page('r1');
  assert.equal(page.total, 2);
  assert.deepEqual(
    page.items.map((item) => [item.requestId, item.ordinal, item.contextTokens]),
    [
      ['pi-a', 1, 1150],
      ['pi-b', 2, 1200],
    ],
  );
  const restarted = new RequestLedger(db);
  restarted.observe(owner, 'pi', piUsage('pi-a', 175));
  restarted.observe(owner, 'pi', piUsage('pi-c', 300));
  const after = restarted.page('r1').items;
  assert.deepEqual(
    after.map((item) => [item.requestId, item.ordinal]),
    [
      ['pi-a', 1],
      ['pi-b', 2],
      ['pi-c', 3],
    ],
  );
  const summary = restarted.summary('r1');
  assert.equal(summary.coverage, 'per-request');
  assert.equal(summary.last?.contextTokens, 1300);
  assert.equal(summary.last?.contextWindow, 200000);
  assert.equal(restarted.indexed('r1'), 'live');
  // A stored run is rebuilt once from retained events; a second call adds nothing.
  assert.equal(restarted.backfill('old', 'pi', 'm', [piUsage('x', 1), piUsage('y', 2)]), 2);
  assert.equal(restarted.backfill('old', 'pi', 'm', [piUsage('z', 3)]), 0);
  assert.equal(restarted.indexed('old'), 'retained-events');
  assert.equal(restarted.summary('never').coverage, 'not-reported');
});

const tool = (data: Record<string, unknown>, seconds = 1): RunEvent => ({ type: 'tool', at: at(seconds), data });

test('tool operations join start, updates and end; bridge events join their native call', () => {
  const db = new DatabaseSync(':memory:');
  const index = new ToolOperationIndex(db, { batchSize: 1000, flushDelayMs: 60_000 });
  index.observe(
    'r',
    tool({ toolCallId: 'c1', tool: 'bash', status: 'inProgress', input: { command: 'cd app && npm test' } }, 1),
  );
  index.observe('r', tool({ toolCallId: 'c1', tool: 'bash', status: 'inProgress', partial: true, output: 'x' }, 2));
  index.observe('r', tool({ toolCallId: 'c1', tool: 'bash', status: 'completed', exitCode: 1, output: 'failing' }, 3));
  index.observe('r', tool({ toolCallId: 'c1', tool: 'bash', status: 'completed', output: 'replayed ok' }, 4));
  index.observe('r', tool({ toolCallId: 'c2', tool: 'read', status: 'inProgress', input: { path: 'src/a.ts' } }, 5));
  index.observe('r', tool({ toolCallId: 'c2', tool: 'read', status: 'completed', output: 'abc' }, 6));
  index.observe(
    'r',
    tool({ source: 'pugport', toolCallId: 'p9', nativeToolCallId: 'c2', tool: 'read', status: 'completed' }, 6),
  );
  index.observe('r', tool({ tool: 'Edit', status: 'completed', input: { file_path: 'src/b.ts' } }, 7));
  index.observe(
    'r',
    tool(
      {
        itemId: 'c3',
        kind: 'commandExecution',
        command: '"C:/tools/pwsh.exe" -Command "rg retry src"',
        status: 'completed',
        exitCode: 0,
      },
      8,
    ),
  );
  index.observe(
    'r',
    tool({ toolCallId: 'c4', tool: 'Bash', status: 'completed', input: { command: 'cat src/a.ts | head' } }, 9),
  );
  assert.equal(index.flush(), 5);
  const ops = index.page('r').items;
  assert.equal(ops.length, 5, 'updates and the bridge observation never add calls');
  const bash = ops.find((op) => op.callId === 'native:c1')!;
  assert.equal(bash.status, 'failed', 'a replayed success never erases a failure');
  assert.equal(bash.exitCode, 1);
  assert.equal(bash.program, 'npm');
  assert.equal(bash.coverage, 'paired');
  assert.equal(bash.updates, 4);
  const read = ops.find((op) => op.callId === 'native:c2')!;
  assert.equal(read.kind, 'read');
  assert.deepEqual(read.paths, ['src/a.ts']);
  const edit = ops.find((op) => op.name === 'Edit')!;
  assert.equal(edit.coverage, 'unpaired');
  assert.equal(edit.kind, 'write');
  assert.equal(ops.find((op) => op.callId === 'native:c3')!.program, 'rg');
  const totals = index.aggregates('r');
  assert.deepEqual(totals.topCommands, [
    { name: 'cat', count: 1 },
    { name: 'npm', count: 1 },
    { name: 'rg', count: 1 },
  ]);
  assert.equal(totals.commandCount, 3);
  assert.deepEqual(totals.filesEdited, ['src/b.ts']);
  assert.deepEqual(totals.filesRead, [{ name: 'src/a.ts', count: 2 }]);
  // A later process merges new events into the stored call instead of creating a duplicate.
  const restarted = new ToolOperationIndex(db);
  restarted.observe('r', tool({ toolCallId: 'c2', tool: 'read', status: 'completed', output: 'abcdef' }, 10));
  assert.equal(restarted.summary('r').count, 5);
  assert.equal(restarted.page('r').items.find((op) => op.callId === 'native:c2')!.resultChars, 6);
});

test('command programs skip wrappers, cd and shells', () => {
  assert.equal(commandProgram('FOO=1 sudo node build.js'), 'node');
  assert.equal(commandProgram("bash -lc 'cd x && git status'"), 'git');
  assert.equal(commandProgram('cmd /c "npm.cmd run lint"'), 'npm');
  assert.equal(commandProgram('Set-Location app; .\\scripts\\check.ps1'), 'check');
  assert.equal(commandProgram('   '), null);
});

test('prompt parts group by kind with title overrides; diffs match by title and order', () => {
  assert.equal(partGroup({ title: '上次尝试', kind: 'prompt' }), 'handoff');
  assert.equal(partGroup({ title: '原始需求', kind: 'prompt' }), 'request');
  assert.equal(partGroup({ title: '此前对话', kind: 'memory' }), 'memory');
  assert.equal(partGroup({ title: 'PugPort 指令', kind: 'prompt' }), 'instructions');
  assert.equal(estimateTokens('abcd'.repeat(10)), 10);
  assert.equal(estimateTokens('你好世界'), 4);
  const prompt =
    '你在用户的工作台中完成任务。\n\n此前对话（较长内容仅保留最近片段）：\nolder chat\n\n<原始需求>\nFix it\n</原始需求>';
  const sent = runSentParts(
    run('p', {
      prompt,
      events: [
        {
          type: 'status',
          at: at(0),
          data: { source: 'pugport', kind: 'execution-context', detail: { prompt, transport: 'api' } },
        },
      ],
    }),
  );
  const { recorded, parts } = contextParts([
    { key: 'user', title: '用户原文', kind: 'user', text: 'Fix it', chars: 6 },
    ...sent,
  ]);
  assert.equal(recorded, true);
  assert.deepEqual(
    parts.map((part) => [part.title, part.group, part.method]),
    [
      ['PugPort 指令', 'instructions', 'estimate'],
      ['此前对话', 'memory', 'estimate'],
      ['原始需求', 'request', 'estimate'],
    ],
    'the full prompt, environment and the separately shown request are not counted twice',
  );
  assert.deepEqual(contextParts([{ key: 'user', title: '用户原文', kind: 'user', text: 'x', chars: 1 }]), {
    recorded: false,
    parts: [],
  });
  const part = (key: string, title: string, chars: number): ContextPart => ({
    key,
    title,
    group: 'memory',
    chars,
    tokens: chars / 4,
    method: 'estimate',
  });
  const diff = diffParts(
    [part('a', 'A', 10), part('b', 'B', 5), part('c', 'C', 7)],
    [part('x', 'A', 12), part('y', 'B', 5), part('z', 'D', 1)],
  );
  assert.deepEqual(diff.changes.get('x'), { kind: 'changed', delta: 2 });
  assert.deepEqual(diff.changes.get('y'), { kind: 'same' });
  assert.deepEqual(diff.changes.get('z'), { kind: 'new' });
  assert.deepEqual(
    diff.dropped.map((item) => item.title),
    ['C'],
  );
  assert.deepEqual(
    contextDrops([
      { ordinal: 1, contextTokens: 30000 },
      { ordinal: 2, contextTokens: null },
      { ordinal: 3, contextTokens: 9000 },
      { ordinal: 4, contextTokens: 8500 },
    ]),
    [{ ordinal: 3, shrankBy: 21000 }],
  );
});

const workflow = (id: string, extra: Partial<Workflow> = {}): Workflow =>
  ({
    id,
    conversationId: 'chat',
    projectId: 'project',
    userMessageId: `${id}-m`,
    input: { content: `${id} request`, mode: 'auto', permissionMode: 'read-only', executionPolicy: 'cli-first' },
    status: 'completed',
    phase: 'summarize',
    plan: [],
    runIds: [],
    memoryRevision: 1,
    memoryExcerpt: '',
    createdAt: at(0),
    updatedAt: at(100),
    ...extra,
  }) as Workflow;

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(
    'CREATE TABLE run_audit_events (run_id TEXT NOT NULL, seq INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY(run_id,seq))',
  );
  const prompt = (memory: string) =>
    `你在用户的工作台中完成任务。\n\n此前对话（较长内容仅保留最近片段）：\n${memory}\n\n<原始需求>\nFix the retry\n</原始需求>`;
  const context = (text: string, transport: 'api' | 'cli'): RunEvent => ({
    type: 'status',
    at: at(0),
    seq: 1,
    data: { source: 'pugport', kind: 'execution-context', detail: { prompt: text, transport } },
  });
  const runs = new Map<string, RunRecord>([
    [
      'a1',
      run('a1', {
        workflowId: 'parent',
        route: { runtimeId: 'codex-1', model: 'gpt', kind: 'routine', reasons: ['Selected'], warnings: [] },
        executionKind: 'cli',
        status: 'failed',
        prompt: prompt('short'),
        events: [context(prompt('short'), 'cli')],
        context: { tokens: 41000, window: 272000, at: at(50) },
        nativeSessionId: 's1',
      }),
    ],
    [
      'a2',
      run('a2', {
        workflowId: 'parent',
        startedAt: at(70),
        route: { runtimeId: 'grok-1', model: 'grok', kind: 'routine', reasons: [], warnings: [] },
        executionKind: 'cli',
        prompt: prompt('a much longer memory section'),
        events: [context(prompt('a much longer memory section'), 'cli')],
        relay: { fromRunId: 'a1', fromRuntimeId: 'codex-1', reason: 'quota' },
        handoffCheckpoint: {
          version: 1,
          source: 'native-tool-results',
          safe: true,
          observedAt: at(69),
          completedToolIds: ['t1', 't2'],
          unconfirmedTools: [],
        },
      }),
    ],
    [
      'c1',
      run('c1', {
        workflowId: 'child',
        startedAt: at(80),
        executionKind: 'api',
        output: 'review done',
        prompt: prompt('child memory'),
        events: [
          context(prompt('child memory'), 'api'),
          { ...piUsage('m1', 100), seq: 2 },
          { ...piUsage('m2', 400), seq: 3 },
          { ...tool({ toolCallId: 'k', tool: 'read', status: 'completed', output: 'x'.repeat(400) }), seq: 4 },
        ],
      }),
    ],
  ]);
  for (const item of runs.values())
    for (const event of item.events)
      db.prepare('INSERT INTO run_audit_events VALUES(?,?,?)').run(item.id, event.seq!, JSON.stringify(event));
  const workflows = new Map([
    ['parent', workflow('parent', { runIds: ['a2', 'a1'] })],
    [
      'child',
      workflow('child', {
        createdAt: at(75),
        runIds: ['c1'],
        delegation: {
          parentId: 'parent',
          role: 'reviewer',
          requestId: 'q',
          agent: { label: 'Reviewer' },
        } as Workflow['delegation'],
      }),
    ],
  ]);
  let fullReads = 0;
  const deps: TraceContextDeps = {
    db,
    workflow: (id) => workflows.get(id),
    delegatedWorkflows: (_conversation, parentId) =>
      [...workflows.values()].filter((item) => item.delegation?.parentId === parentId),
    requireConversation: () => undefined,
    run: (id) => {
      fullReads++;
      return runs.get(id);
    },
    runSummary: (id) => {
      const value = runs.get(id);
      return value && { ...value, events: [], summary: true };
    },
    isActive: () => false,
    runUsage: () => undefined,
    executorLabel: (item) => item.route.runtimeId,
    provider: (item) =>
      item.executionKind === 'api' ? 'pi' : item.route.runtimeId.startsWith('grok') ? 'grok' : 'codex',
    requests: new RequestLedger(db),
    tools: new ToolOperationIndex(db),
  };
  return { trace: new TraceContext(deps), reads: () => fullReads };
}

test('trace context orders attempts with nested sub-tasks and keeps the three scopes apart', () => {
  const { trace, reads } = fixture();
  const page = trace.page('parent');
  assert.deepEqual(
    page.runs.map((row) => [row.runId, row.depth, row.attempt]),
    [
      ['a1', 0, 1],
      ['a2', 0, 2],
      ['c1', 1, 1],
    ],
  );
  assert.deepEqual(page.scope, { attempts: 2, subtasks: 1, handoffs: 1 });
  const [first, second, child] = page.runs;
  assert.equal(first!.reported?.source, 'run-context-snapshot');
  assert.equal(first!.requests.coverage, 'snapshot');
  assert.equal(first!.transcript, null, 'CLI runs never show transcript estimates');
  assert.equal(second!.reported, null, 'Grok reported nothing and nothing is fabricated');
  assert.equal(second!.requests.coverage, 'not-reported');
  assert.equal(second!.sessionMode, 'fresh');
  assert.equal(second!.carriedTools, 2);
  assert.ok(second!.sent.chars > first!.sent.chars);
  assert.ok(second!.parts.every((part) => part.method === 'estimate'));
  assert.equal(child!.label, 'Reviewer');
  assert.equal(child!.transport, 'api');
  assert.equal(child!.requests.count, 2);
  assert.equal(child!.requests.coverage, 'per-request');
  assert.equal(child!.reported?.contextTokens, 1400);
  assert.equal(child!.transcript?.toolResults.chars, 400);
  assert.equal(child!.transcript?.replies.chars, 11);
  const detail = trace.detail('c1');
  assert.equal(detail.requests.items.length, 2);
  assert.equal(detail.tools.topTools[0]?.name, 'read');
  // Finished runs keep their composition; a second read parses no full records.
  const before = reads();
  trace.page('parent');
  assert.equal(reads(), before);
  const paged = trace.page('parent', 1, 1);
  assert.equal(paged.total, 3);
  assert.deepEqual(
    paged.runs.map((row) => row.runId),
    ['a2'],
  );
});

test('a call whose run left the in-memory window still joins its stored start', () => {
  const db = new DatabaseSync(':memory:');
  const index = new ToolOperationIndex(db, { batchSize: 1000, flushDelayMs: 60_000 });
  index.observe('a', tool({ toolCallId: 'c1', tool: 'bash', status: 'inProgress', input: { command: 'npm test' } }, 1));
  for (let run = 0; run < 70; run++)
    index.observe(`other-${run}`, tool({ toolCallId: 'x', tool: 'read', status: 'completed' }, 2));
  index.observe('a', tool({ toolCallId: 'c1', tool: 'bash', status: 'completed', exitCode: 0 }, 3));
  const ops = index.page('a').items;
  assert.equal(ops.length, 1);
  assert.equal(ops[0]!.coverage, 'paired');
  assert.equal(ops[0]!.program, 'npm');
  const ledger = new RequestLedger(db, { batchSize: 1000, flushDelayMs: 60_000 });
  ledger.observe(run('a'), 'pi', piUsage('first', 1));
  for (let item = 0; item < 130; item++) ledger.observe(run(`r-${item}`), 'pi', piUsage('m', 1));
  ledger.observe(run('a'), 'pi', piUsage('second', 2));
  assert.deepEqual(
    ledger.page('a').items.map((item) => item.ordinal),
    [1, 2],
  );
});

test('a failed, aborted or empty Pi request stores no context, keeps run.context and is not a drop', () => {
  for (const stopReason of ['error', 'aborted'])
    assert.equal(contextFromEvent('pi', 'm', piUsage(`f-${stopReason}`, 500, { stopReason })), undefined, stopReason);
  assert.equal(contextFromEvent('pi', 'm', piUsage('empty', 0, { cacheRead: 0, cacheWrite: 0 })), undefined);
  const db = new DatabaseSync(':memory:');
  const ledger = new RequestLedger(db, { batchSize: 1000, flushDelayMs: 60_000 });
  const owner = run('failing');
  ledger.observe(owner, 'pi', piUsage('ok', 29_000));
  ledger.observe(
    owner,
    'pi',
    piUsage('aborted', 0, { cacheRead: 0, output: 0, totalTokens: 0, stopReason: 'aborted' }),
  );
  ledger.observe(owner, 'pi', piUsage('zero', 0, { cacheRead: 0, output: 0, totalTokens: 0 }));
  const items = ledger.page('failing').items;
  assert.deepEqual(
    items.map((item) => [item.requestId, item.contextTokens, item.contextWindow]),
    [
      ['ok', 30_000, 200_000],
      ['aborted', null, null],
      ['zero', null, null],
    ],
    'the request rows are kept, with context not reported',
  );
  assert.equal(items[1]!.usage?.inputTokens, 0, 'reported usage figures stay as reported');
  assert.equal(ledger.summary('failing').last?.contextTokens, 30_000, 'the last reported context is unchanged');
  assert.deepEqual(contextDrops(items), [], 'a failed request is not a context drop');
});

test('a history longer than one backfill step stays partial and is completed by later reads', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(
    'CREATE TABLE run_audit_events (run_id TEXT NOT NULL, seq INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY(run_id,seq))',
  );
  const events: RunEvent[] = [];
  for (let call = 0; call < 7; call++) {
    events.push(tool({ toolCallId: `c${call}`, tool: 'read', status: 'inProgress', input: { path: `f${call}.ts` } }));
    events.push(piUsage(`m${call}`, 100 + call));
    events.push(tool({ toolCallId: `c${call}`, tool: 'read', status: 'completed', output: 'abc' }, 2));
  }
  events.forEach((event, index) =>
    db.prepare('INSERT INTO run_audit_events VALUES(?,?,?)').run('long', index + 1, JSON.stringify({ ...event })),
  );
  const long = run('long', { workflowId: 'w', executionKind: 'api', events: [] });
  const requests = new RequestLedger(db);
  const tools = new ToolOperationIndex(db);
  const trace = new TraceContext({
    db,
    workflow: (id) => (id === 'w' ? workflow('w', { runIds: ['long'] }) : undefined),
    delegatedWorkflows: () => [],
    requireConversation: () => undefined,
    run: () => long,
    runSummary: () => long,
    isActive: () => false,
    runUsage: () => undefined,
    executorLabel: () => 'Pi',
    provider: () => 'pi',
    requests,
    tools,
    backfillLimit: 5,
  });
  const first = trace.page('w').runs[0]!;
  assert.equal(first.partialHistory, true, 'truncated, not complete');
  assert.ok(first.tools.count < 7 && first.requests.count < 7);
  assert.equal(requests.indexed('long'), 'retained-events-partial');
  assert.equal(trace.detail('long').partialHistory, true);
  let steps = 2;
  while (steps < 10 && trace.page('w').runs[0]!.partialHistory) steps++;
  assert.equal(steps + 1, 5, '21 events in steps of 5 take five reads, each continuing where the last stopped');
  const done = trace.page('w').runs[0]!;
  assert.equal(done.partialHistory, false);
  assert.equal(done.requests.count, 7);
  assert.equal(done.tools.count, 7);
  assert.equal(requests.indexed('long'), 'retained-events');
  assert.equal(tools.indexed('long'), 'retained-events');
  const detail = trace.detail('long');
  assert.deepEqual(
    detail.requests.items.map((item) => item.ordinal),
    [1, 2, 3, 4, 5, 6, 7],
  );
  assert.ok(
    detail.tools.items.every((op) => op.coverage === 'paired' && op.updates === 2),
    'a call split across steps joins once and is never counted twice',
  );
  assert.equal(db.prepare('SELECT 1 FROM run_context_backfill WHERE run_id=?').get('long'), undefined);
});

test('sub-tasks are selected in SQL by delegation parent, excluding deleted ones and other chats', () => {
  const db = new DatabaseSync(':memory:');
  const store = new WorkspaceStore(db, { recoverInterrupted: false });
  const save = (id: string, owner: string, extra: Partial<Workflow>) =>
    store.save('workflow', id, owner, workflow(id, { conversationId: owner, ...extra }));
  const delegation = (parentId: string) =>
    ({ parentId, role: 'worker', requestId: `r-${parentId}` }) as Workflow['delegation'];
  save('parent', 'chat', {});
  save('child', 'chat', { delegation: delegation('parent') });
  save('removed', 'chat', { delegation: delegation('parent'), deletedAt: at(5) });
  save('cousin', 'chat', { delegation: delegation('other') });
  save('elsewhere', 'other-chat', { delegation: delegation('parent') });
  for (let index = 0; index < 50; index++) save(`unrelated-${index}`, 'chat', {});
  assert.deepEqual(
    store.delegatedWorkflows('chat', 'parent').map((item) => item.id),
    ['child'],
  );
});

test("'type' is not a file read: \`type node\` names a command", () => {
  const db = new DatabaseSync(':memory:');
  const index = new ToolOperationIndex(db);
  index.observe('t', tool({ toolCallId: 'a', tool: 'Bash', status: 'completed', input: { command: 'type node' } }));
  index.observe('t', tool({ toolCallId: 'b', tool: 'Bash', status: 'completed', input: { command: 'cat notes.md' } }));
  const totals = index.aggregates('t');
  assert.deepEqual(totals.filesRead, [{ name: 'notes.md', count: 1 }]);
  assert.deepEqual(index.page('t').items.find((op) => op.callId === 'native:a')?.paths, []);
});
