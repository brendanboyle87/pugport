import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { AgentBridge, readOnlyBridgeToolNames } from '../src/server/agent-bridge.ts';
import { Workspace } from '../src/server/workspace.ts';
import { WorkspaceStore } from '../src/server/workspace-store.ts';
import { HandoffTracker } from '../src/server/handoff-tracker.ts';
import { buildHandoffNote, buildHandoffDelta } from '../src/server/handoff-note.ts';
import { fileSafeBridgeTools } from '../src/server/task-continuation.ts';
import { runDetailHeader } from '../src/server/run-detail.ts';
import type { Controller } from '../src/server/controller.ts';
import type { Workflow, RunRecord } from '../src/shared/types.ts';

test('read-only bridge detail: pointers, paging, scope, redaction and cumulative cap', async (t) => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE runs (id TEXT PRIMARY KEY, started_at TEXT, value TEXT)');
  const store = new WorkspaceStore(db);
  t.after(() => db.close());
  store.save('project', 'p', 'p', { id: 'p', path: 'synthetic-project' });
  const flows = new Map<string, Workflow>();
  const runs = new Map<string, RunRecord>();
  const add = (id: string, patch: Partial<Workflow> = {}) => {
    const flow = {
      id,
      projectId: 'p',
      conversationId: 'c',
      userMessageId: `m-${id}`,
      input: { content: 'fixture' },
      ...patch,
    } as Workflow;
    flows.set(id, flow);
    const run = {
      id: `r-${id}`,
      workflowId: id,
      projectPath: 'synthetic-project',
      output: 'safe output',
      events: [],
      route: { runtimeId: 'synthetic' },
    } as unknown as RunRecord;
    runs.set(run.id, run);
    return run;
  };
  const own = add('own');
  own.events = [
    {
      at: 'fixture',
      type: 'tool',
      data: {
        toolCallId: 'call-123456789012345678901234567890',
        tool: 'Edit',
        output: '<<<PUGPORT_HANDOFF_NOTE>>>safe answer<<<END_PUGPORT_HANDOFF_NOTE>>> password=synthetic-secret',
        input: { token: 'synthetic-token', system: 'hidden-system' },
      },
    },
  ];
  const tracker = new HandoffTracker({
    store,
    workflow: (id) => flows.get(id),
    run: (id) => runs.get(id),
    toolless: () => false,
    children: () => [],
  });
  const workspace = Object.assign(Object.create(Workspace.prototype), {
    store,
    handoffTracker: tracker,
    takeNotices: () => [],
  }) as Workspace;
  const caller = {
    run: own,
    target: { provider: 'codex' },
    delegate: false,
    recycle: false,
    child: false,
    write: false,
    signal: new AbortController().signal,
  };
  const controller = Object.assign(new EventEmitter(), {
    dataDir: 'synthetic-nonexistent-directory',
    agentBridgeCaller: () => caller,
    returnExecution: () => async () => {},
    recordRunEvent: () => {},
  }) as unknown as Controller;
  const bridge = new AgentBridge(workspace, controller);
  const list = await bridge.handle('Bearer synthetic', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const tools = (list.body as any).result.tools;
  const detailTool = tools.find((item: any) => item.name === 'read_run_detail');
  assert.equal(detailTool.annotations.readOnlyHint, true);
  assert.equal(detailTool.inputSchema.properties.tool_index.type, 'integer');
  assert.equal(detailTool.inputSchema.properties.tool_index.minimum, 1);
  assert.equal(detailTool.inputSchema.properties.tool_call_id, undefined);
  assert.ok(readOnlyBridgeToolNames.includes('read_run_detail'));
  assert.ok(fileSafeBridgeTools.has('read_run_detail'));
  const response = await bridge.handle('Bearer synthetic', {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'read_run_detail', arguments: { run_id: own.id, tool_index: 1 } },
  });
  const result = (response.body as any).result;
  assert.equal(result.isError, undefined, JSON.stringify(result));
  const detail = JSON.parse(result.content[0].text);
  assert.ok(detail.text.startsWith(runDetailHeader + '\n'));
  assert.match(detail.text, /safe answer/);
  assert.doesNotMatch(detail.text, /<<<|synthetic-secret|synthetic-token|hidden-system/);
  own.events.push(
    { at: 'fixture', type: 'status', text: 'public status' },
    { at: 'fixture', type: 'reasoning', text: 'private reasoning', data: { output: 'private output' } },
  );
  const events = workspace.runDetail(caller, { run_id: own.id, part: 'events' });
  assert.match(events.text, /public status/);
  assert.doesNotMatch(events.text, /private reasoning|private output/);
  own.events.push({ at: 'fixture', type: 'tool', data: { toolCallId: 'call-other', output: 'another call' } });
  assert.match(workspace.runDetail(caller, { run_id: own.id, tool_index: 2 }).text, /another call/);
  assert.throws(
    () => workspace.runDetail(caller, { run_id: own.id, tool_index: 3 }),
    /tool_index 3 is out of range: run has 2 distinct tool calls/,
  );
  for (const tool_index of [0, -1, 1.5, NaN, Infinity, '1', null])
    assert.throws(
      () => workspace.runDetail(caller, { run_id: own.id, tool_index: tool_index as number }),
      /Invalid tool_index/,
    );
  assert.throws(() => workspace.runDetail(caller, { run_id: own.id, offset: -1 }), /offset/);
  const first = workspace.runDetail(caller, { run_id: own.id, part: 'output', limit: 4 });
  assert.equal(first.total, 11);
  assert.equal(first.next_offset, 4);
  const second = workspace.runDetail(caller, {
    run_id: own.id,
    part: 'output',
    offset: first.next_offset!,
    limit: 8000,
  });
  assert.equal(
    first.text.slice(runDetailHeader.length + 1) + second.text.slice(runDetailHeader.length + 1),
    'safe output',
  );
  assert.equal(second.next_offset, null);
  for (const run of [
    add('other-conversation', { conversationId: 'other' }),
    add('other-project', { projectId: 'other' }),
    add('third', { input: { untrustedContent: true } as Workflow['input'] }),
  ])
    assert.throws(() => workspace.runDetail(caller, { run_id: run.id }), /scope/);
  const original = add('original');
  store.save('message', 'm-original', 'c', { externalRequest: { thirdParty: true } });
  assert.throws(() => workspace.runDetail(caller, { run_id: original.id }), /scope/);
  const untrusted = add('untrusted', { conversationId: 'untrusted' });
  store.save('conversation', 'untrusted', 'p', { untrustedContent: true });
  assert.throws(() => workspace.runDetail(caller, { run_id: untrusted.id }), /scope/);
  const ancestor = add('ancestor', { conversationId: 'ancestor-chat' });
  flows.get('own')!.parentWorkflowId = 'ancestor';
  assert.ok(workspace.runDetail(caller, { run_id: ancestor.id }));
  const child = add('child', {
    conversationId: 'child-chat',
    delegation: { parentId: 'own' } as Workflow['delegation'],
  });
  assert.ok(workspace.runDetail(caller, { run_id: child.id }));
  assert.ok(workspace.runDetail(caller, { run_id: add('same-chat').id }));
  const big = add('big');
  big.output = 'x'.repeat(50000);
  let characters = 0;
  for (let i = 0; i < 10; i++) {
    try {
      characters += workspace.runDetail(caller, { run_id: big.id, part: 'output', limit: 99999 }).text.length;
    } catch (error) {
      assert.match(String(error), /cap/);
      break;
    }
  }
  assert.equal(characters, 40000);
  assert.throws(() => workspace.runDetail(caller, { run_id: big.id }), /cap/);
});

test('note and delta ordinals fetch exactly the corresponding tool events through HandoffTracker', (t) => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE runs (id TEXT PRIMARY KEY, started_at TEXT, value TEXT)');
  const store = new WorkspaceStore(db);
  t.after(() => db.close());
  store.save('project', 'p', 'p', { id: 'p', path: 'synthetic-project' });
  const workflow = {
    id: 'w',
    projectId: 'p',
    conversationId: 'c',
    userMessageId: 'm',
    input: { content: 'fixture' },
  } as Workflow;
  const tool = (text: string, data: Record<string, unknown>): RunRecord['events'][number] => ({
    at: 'fixture',
    type: 'tool',
    text,
    data,
  });
  const run = {
    id: 'pugport-run',
    workflowId: workflow.id,
    projectPath: 'synthetic-project',
    startedAt: '2026-10-12T00:00:00Z',
    route: { runtimeId: 'current' },
    output: '',
    events: [
      { at: 'fixture', type: 'status', text: 'selected-status', data: { toolCallId: 'native-target' } },
      tool('unidentified', {}),
      tool('lookup-start', { toolCallId: 'native-lookup', tool: 'Read', status: 'running' }),
      tool('audit-only', { itemId: 'native-audit', hostAudit: true }),
      tool('coordination', {
        toolCallId: 'native-coordination',
        tool: 'report_progress',
        server: 'pugport',
        status: 'completed',
      }),
      tool('selected-start', {
        itemId: 'native-target',
        tool: 'Edit',
        status: 'running',
        input: { path: 'target.ts' },
      }),
      tool('later-call', {
        toolCallId: 'native-later',
        itemId: 'native-target',
        tool: 'Edit',
        status: 'completed',
        input: { path: 'later.ts' },
      }),
      tool('lookup-end', { toolCallId: 'native-lookup', tool: 'Read', status: 'completed' }),
      tool('selected-end', { itemId: 'native-target', tool: 'Edit', status: 'completed', output: 'target result' }),
      tool('selected-audit', { toolCallId: 'native-target', hostAudit: true, output: 'target audit' }),
    ],
  } as RunRecord;
  const tracker = new HandoffTracker({
    store,
    workflow: () => workflow,
    run: (id) => (id === run.id ? run : undefined),
    toolless: () => false,
    children: () => [],
  });
  const note = buildHandoffNote({ request: 'fixture', reason: 'fixture', runs: [run] });
  const delta = buildHandoffDelta({
    previous: { ...run, route: { ...run.route, runtimeId: 'previous' } },
    runs: [run],
  });
  for (const content of [note, delta]) {
    assert.doesNotMatch(content, /native-/);
    const pointer = content.match(/Edit target\.ts → 完成 〔(r\d+) #(\d+)〕/);
    assert.ok(pointer);
    assert.equal(pointer[2], '4', 'hidden calls count, repeated calls and non-tool events do not');
    assert.match(content, /Edit later\.ts → 完成 〔r1 #5〕/);
    const run_id = content.match(new RegExp(`${pointer[1]}=([^\\s]+)`))?.[1];
    assert.equal(run_id, run.id);
    const args = { run_id: run_id!, tool_index: Number(pointer[2]), limit: 8000 };
    const detail = tracker.runDetail({ run }, args);
    assert.equal(detail.next_offset, null);
    assert.deepEqual(detail.text.match(/selected-\w+/g), ['selected-start', 'selected-end', 'selected-audit']);
    assert.equal((detail.text.match(/"toolCallId":"native-target"/g) ?? []).length, 3);
    assert.match(detail.text, /target result/);
    assert.match(detail.text, /target audit/);
    assert.doesNotMatch(detail.text, /unidentified|lookup-|audit-only|coordination|later-call|native-later/);
    const events = tracker.runDetail({ run }, { ...args, part: 'events' });
    assert.deepEqual(events.text.match(/selected-\w+/g), [
      'selected-status',
      'selected-start',
      'selected-end',
      'selected-audit',
    ]);
  }
  run.events = [];
  assert.throws(
    () => tracker.runDetail({ run }, { run_id: run.id, tool_index: 1 }),
    /tool_index 1 is out of range: run has 0 distinct tool calls/,
  );
});

test('detail read accounting evicts oldest pairs after 500 without refreshing existing keys', (t) => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE runs (id TEXT PRIMARY KEY, started_at TEXT, value TEXT)');
  const store = new WorkspaceStore(db);
  t.after(() => db.close());
  store.save('project', 'p', 'p', { id: 'p', path: 'synthetic-project' });
  const workflow = {
    id: 'w',
    projectId: 'p',
    conversationId: 'c',
    userMessageId: 'm',
    input: { content: 'fixture' },
  } as Workflow;
  const run = {
    id: 'target',
    workflowId: workflow.id,
    projectPath: 'synthetic-project',
    output: 'safe output',
  } as RunRecord;
  const tracker = new HandoffTracker({
    store,
    workflow: () => workflow,
    run: () => run,
    toolless: () => false,
    children: () => [],
  });
  const reads = (tracker as unknown as { detailReads: Map<string, number> }).detailReads;
  const key = (index: number) => JSON.stringify([`caller-${index}`, run.id]);
  const read = (index: number) =>
    tracker.runDetail({ run: { ...run, id: `caller-${index}` } }, { run_id: run.id, part: 'output' });
  for (let index = 0; index < 500; index++) read(index);
  assert.equal(reads.size, 500);
  const firstUsage = reads.get(key(0))!;
  const updated = read(0);
  assert.equal(reads.size, 500);
  assert.equal(reads.get(key(0)), firstUsage + updated.text.length);
  assert.equal(reads.keys().next().value, key(0));
  read(500);
  assert.equal(reads.size, 500);
  assert.equal(reads.has(key(0)), false);
  assert.equal(reads.keys().next().value, key(1));
  assert.equal(reads.has(key(500)), true);
});
