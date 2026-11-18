import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  codexCommandOutputDelta,
  codexMcpToolProgress,
  codexProtocolObservation,
  codexToolEventDetails,
} from '../src/server/adapters/codex.ts';
import { cursorToolEventData } from '../src/server/adapters/cursor.ts';
import { commandCheck } from '../src/server/command-check.ts';

test('Codex retains sanitized failure messages and recognizes limited command checks', () => {
  const data = codexToolEventDetails({
    type: 'fileChange',
    error: { message: 'Failed to write file: EACCES open C:\\synthetic\\x.ts token=abc' },
  });
  assert.match(String(data.failureMessage), /EACCES.*synthetic/);
  assert.ok(!String(data.failureMessage).includes('token=abc'));
  assert.ok(data.failureDetail);
  assert.equal(
    commandCheck({ kind: 'commandExecution', status: 'failed', failureMessage: 'listen EACCES' })?.limited,
    true,
  );
});

// Official app-server ThreadItem examples and ACP fragments. No native executable or model is called.
test('Codex dynamic tool args and contentItems survive completion with explicit failure and safe media omission', () => {
  const data = codexToolEventDetails({
    type: 'dynamicToolCall',
    arguments: { path: 'workspace.txt', api_key: 'synthetic-private-key' },
    contentItems: [
      { type: 'inputText', text: 'Full result line 1\nFull result line 2' },
      { type: 'inputImage', imageUrl: 'data:image/png;base64,SYNTHETIC_IMAGE' },
    ],
    success: false,
    durationMs: 14,
  });
  assert.deepEqual(data.input, { path: 'workspace.txt', api_key: '[redacted]' });
  assert.deepEqual(data.output, {
    contentItems: [
      { type: 'inputText', text: 'Full result line 1\nFull result line 2' },
      { type: 'inputImage', omitted: 'Non-text tool content' },
    ],
    success: false,
  });
  assert.equal(data.isError, true);
  assert.equal(data.durationMs, 14);
  assert.ok(!JSON.stringify(data).includes('SYNTHETIC_IMAGE'));
});

test('Codex web and collaboration calls retain operation-specific inputs and observed results', () => {
  const search = codexToolEventDetails({
    type: 'webSearch',
    query: 'official protocol',
    action: { type: 'search', queries: ['official protocol'] },
    results: [{ title: 'Document', url: 'https://example.test/document', text: 'Result text' }],
  });
  assert.deepEqual(search.input, {
    query: 'official protocol',
    action: { type: 'search', queries: ['official protocol'] },
  });
  assert.deepEqual(search.output, [{ title: 'Document', url: 'https://example.test/document', text: 'Result text' }]);
  const collaboration = codexToolEventDetails({
    type: 'collabAgentToolCall',
    prompt: 'Inspect this module.',
    receiverThreadIds: ['child-1'],
    agentsStates: { 'child-1': { status: 'completed', message: 'Observed result', reasoning: 'private-content' } },
  });
  assert.deepEqual(collaboration.input, { prompt: 'Inspect this module.', receiverThreadIds: ['child-1'] });
  assert.deepEqual(collaboration.output, { 'child-1': { status: 'completed', message: 'Observed result' } });
  assert.ok(!JSON.stringify(collaboration).includes('private-content'));
});

test('Codex command output deltas preserve exact item identity and boundaries without inventing a terminal state', () => {
  const deltas = ['line one\n', 'line two\n'].map((delta) => codexCommandOutputDelta({ itemId: 'cmd-1', delta }));
  assert.deepEqual(
    deltas.map((data) => data.itemId),
    ['cmd-1', 'cmd-1'],
  );
  assert.deepEqual(
    deltas.map((data) => data.output),
    ['line one\n', 'line two\n'],
  );
  assert.ok(deltas.every((data) => data.outputMode === 'delta' && data.status === undefined));
  const completion = codexToolEventDetails({
    type: 'commandExecution',
    command: 'echo hello',
    cwd: 'workspace',
    aggregatedOutput: 'line one\nline two\n',
  });
  assert.deepEqual(completion.input, { command: 'echo hello', cwd: 'workspace' });
  assert.equal(completion.output, 'line one\nline two\n');
});

test('Codex unsupported tool item remains explicit metadata evidence without copying hidden envelope fields', () => {
  const data = codexToolEventDetails({
    type: 'futureToolItem',
    id: 'unknown-1',
    reasoning: 'private-content',
    extra: 'unclassified',
  });
  assert.equal(data.captureState, 'metadata-only');
  assert.deepEqual(data.observedFields, ['type', 'id', 'reasoning', 'extra']);
  assert.ok(!JSON.stringify(data).includes('private-content'));
});

test('Codex protocol observation records real lifecycle coordinates and unknown field names without packet bodies', () => {
  const start = codexProtocolObservation('turn/started', {
    threadId: 'thread-1',
    turn: { id: 'turn-1', status: 'inProgress', reasoning: 'private-content' },
  });
  assert.equal(start.turnId, 'turn-1');
  assert.equal(start.status, 'inProgress');
  const unknown = codexProtocolObservation('future/notice', {
    threadId: 'thread-1',
    turnId: 'turn-1',
    payload: 'private-content',
  });
  assert.deepEqual(unknown.keys, ['threadId', 'turnId', 'payload']);
  assert.equal(unknown.method, 'future/notice');
  assert.ok(!JSON.stringify([start, unknown]).includes('private-content'));
  const fileDelta = codexCommandOutputDelta(
    { itemId: 'patch-1', delta: 'Applied file change.' },
    'item/fileChange/outputDelta',
  );
  assert.equal(fileDelta.kind, 'fileChange');
  assert.equal(fileDelta.source, 'native');
  assert.equal(fileDelta.observedPhase, 'output');
  assert.equal(fileDelta.status, undefined);
  const progress = codexMcpToolProgress({
    itemId: 'mcp-1',
    message: 'Examining item 2 of 3',
    reasoning: 'private-content',
  });
  assert.equal(progress.itemId, 'mcp-1');
  assert.equal(progress.output, 'Examining item 2 of 3');
  assert.equal(progress.outputMode, 'progress');
  assert.equal(progress.status, undefined);
  assert.ok(!JSON.stringify(progress).includes('private-content'));
});

test('Cursor partial tool updates preserve recorded identity/state while retaining each input and output', () => {
  const initial = cursorToolEventData({
    toolCallId: 'cursor-call-1',
    title: 'Read workspace file',
    toolName: 'read_file',
    kind: 'read',
    status: 'pending',
    rawInput: { path: 'workspace.txt' },
  });
  const enriched = cursorToolEventData(
    { toolCallId: 'cursor-call-1', rawInput: { path: 'workspace.txt', offset: 5 } },
    initial,
  );
  assert.equal(enriched.tool, 'read_file');
  assert.equal(enriched.title, 'Read workspace file');
  assert.equal(enriched.kind, 'read');
  assert.equal(enriched.status, 'pending');
  assert.deepEqual(enriched.input, { path: 'workspace.txt', offset: 5 });
  const final = cursorToolEventData(
    { toolCallId: 'cursor-call-1', status: 'completed', rawOutput: { text: 'Whole file result' } },
    enriched,
  );
  assert.equal(final.toolCallId, 'cursor-call-1');
  assert.equal(final.tool, 'read_file');
  assert.equal(final.status, 'completed');
  assert.deepEqual(final.output, { text: 'Whole file result' });
  assert.equal(final.input, undefined, 'each source event carries only its own observed input/output');
  const orphan = cursorToolEventData({ toolCallId: 'cursor-orphan', rawOutput: { text: 'Recoverable orphan result' } });
  assert.deepEqual(orphan.output, { text: 'Recoverable orphan result' });
  assert.equal(orphan.status, undefined, 'an output alone does not establish completion');
});
