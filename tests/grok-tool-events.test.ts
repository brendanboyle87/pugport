import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { ExecuteContext, RunEvent } from '../src/shared/types.ts';
import { createGrokAdapter } from '../src/server/adapters/grok.ts';
import { executeGrokAcp } from '../src/server/adapters/grok-acp.ts';
import { safeToolEventValue, toolEventDetails } from '../src/shared/tool-event-data.ts';
import {
  auditNativeProcess,
  auditUnmappedSessionUpdate,
  safeExecutionArgs,
} from '../src/server/adapters/execution-audit.ts';

const child = () =>
  Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
  }) as unknown as ChildProcessWithoutNullStreams;
const context = (events: RunEvent[]): ExecuteContext => ({
  target: {
    id: 'fixture-grok',
    provider: 'grok',
    label: 'Fixture',
    command: 'fixture',
    environment: 'native',
    enabled: true,
  },
  input: { prompt: 'User task', projectPath: process.cwd(), kind: 'general', permissionMode: 'read-only' },
  route: { runtimeId: 'fixture-grok', model: 'grok-4.7', effort: 'medium', kind: 'general', reasons: [], warnings: [] },
  signal: new AbortController().signal,
  emit: (event) => events.push(event),
  approve: async () => false,
});

test('native process audit observes close separately from EOF and never exposes credential argv', () => {
  const process = child(),
    events: RunEvent[] = [],
    ctx = context(events);
  Object.defineProperty(process, 'pid', { value: 4123 });
  const args = [
    '--model',
    'grok-4.7',
    '--api-key',
    'OPAQUE_KEY',
    '--headers=Authorization:OPAQUE_HEADER',
    '--mcp-config',
    '{"url":"http://127.0.0.1/mcp/OPAQUE_BRIDGE"}',
    'http://127.0.0.1/mcp/OPAQUE_URL',
    '--prompt-file',
    'C:/tmp/prompt.txt',
  ];
  assert.deepEqual(safeExecutionArgs(args), [
    '--model',
    'grok-4.7',
    '--api-key',
    '[redacted]',
    '--headers=[redacted]',
    '--mcp-config',
    '[redacted]',
    '[redacted: URL argument]',
    '--prompt-file',
    'C:/tmp/prompt.txt',
  ]);
  auditNativeProcess(ctx, process, args, 'acp');
  assert.equal(events[0].data?.kind, 'process-start');
  assert.deepEqual((events[0].data?.detail as Record<string, unknown>).pid, 4123);
  assert.equal((events[0].data?.detail as Record<string, unknown>).commandSource, 'configured');
  process.stdout.emit('end');
  assert.equal(events.length, 1, 'EOF is not a process exit');
  process.emit('close', null, 'SIGTERM');
  process.emit('close', 0, null);
  assert.equal(events.length, 2, 'only the observed first close is recorded');
  assert.equal(events[1].data?.kind, 'process-exit');
  assert.equal((events[1].data?.detail as Record<string, unknown>).signal, 'SIGTERM');
  assert.equal((events[1].data?.detail as Record<string, unknown>).exitCode, null);
  assert.ok(!JSON.stringify(events).includes('OPAQUE_'));
});

test('unmapped native updates record only a safe discriminant, method and field names', () => {
  const events: RunEvent[] = [],
    ctx = context(events);
  auditUnmappedSessionUpdate(ctx, 'session/update', {
    sessionUpdate: 'tool_call_update',
    rawInput: 'PRIVATE_ARGUMENT',
  });
  auditUnmappedSessionUpdate(ctx, 'session/update', { rawInput: 'PRIVATE_ARGUMENT' });
  assert.equal(events.length, 0);
  auditUnmappedSessionUpdate(ctx, 'session/update', {
    sessionUpdate: 'new_native_variant',
    rawInput: 'PRIVATE_ARGUMENT',
    _meta: { system: 'PRIVATE_SYSTEM' },
    rawOutput: 'PRIVATE_RESULT',
  });
  assert.deepEqual(events[0].data, {
    source: 'native',
    kind: 'protocol-unmapped',
    detail: {
      executor: 'Fixture',
      provider: 'grok',
      runtimeId: 'fixture-grok',
      variant: 'new_native_variant',
      method: 'session/update',
      keys: ['sessionUpdate', 'rawInput', '_meta', 'rawOutput'],
    },
  });
  assert.ok(!JSON.stringify(events).includes('PRIVATE_'));
});

test('unmapped control updates retain public operational fields without exposing catalogs or thought bodies', () => {
  const events: RunEvent[] = [],
    ctx = context(events);
  for (const update of [
    {
      sessionUpdate: 'plan',
      entries: [
        {
          content: 'Read files token=OPAQUE_SECRET',
          status: 'in_progress',
          priority: 'high',
          _meta: { thinking: 'PRIVATE_PLAN' },
        },
        { type: 'thinking', content: 'PRIVATE_THOUGHT' },
      ],
    },
    {
      sessionUpdate: 'current_mode_update',
      currentModeId: 'code',
      modeId: 'code',
      _meta: { instructions: 'PRIVATE_MODE' },
    },
    { sessionUpdate: 'session_info_update', title: 'Review folder', _meta: { system: 'PRIVATE_SYSTEM' } },
    { sessionUpdate: 'config_option_update', configOptions: [{ id: 'model', currentValue: 'PRIVATE_CONFIGURATION' }] },
    {
      sessionUpdate: 'available_commands_update',
      availableCommands: [{ name: 'run', description: 'PRIVATE_COMMAND_DEFINITION' }],
    },
    {
      sessionUpdate: 'usage_update',
      used: 23,
      size: 100,
      inputTokens: 20,
      outputTokens: 3,
      cost: { amount: 0.01, currency: 'USD', token: 'PRIVATE_COST' },
    },
    { sessionUpdate: 'user_message_chunk', content: { text: 'PRIVATE_USER_BODY' } },
    { sessionUpdate: 'agent_thought_chunk', content: { text: 'PRIVATE_REASONING' } },
  ])
    auditUnmappedSessionUpdate(ctx, 'session/update', update);
  assert.equal(
    events.length,
    7,
    'every unrendered control variant produces an observation; thought updates remain private',
  );
  assert.ok(events.every((event) => event.data?.kind === 'protocol-observation'));
  const details = events.map((event) => event.data?.detail as Record<string, unknown>);
  assert.ok(
    details.every(
      (detail) => detail.executor === 'Fixture' && detail.provider === 'grok' && detail.runtimeId === 'fixture-grok',
    ),
  );
  assert.deepEqual(details[0].entries, [
    { content: 'Read files token=[redacted]', priority: 'high', status: 'in_progress' },
    {},
  ]);
  assert.equal(details[0].entryCount, 2);
  assert.equal(details[1].currentModeId, 'code');
  assert.equal(details[2].title, 'Review folder');
  assert.equal(details[3].optionCount, 1);
  assert.equal(details[4].commandCount, 1);
  assert.equal(details[5].inputTokens, 20);
  assert.deepEqual(details[5].cost, { amount: 0.01, currency: 'USD' });
  assert.equal(details[6].content, undefined);
  assert.ok(!JSON.stringify(events).includes('PRIVATE_'));
  assert.ok(!JSON.stringify(events).includes('OPAQUE_SECRET'));
});

test('safe tool fields preserve actual task instructions while excluding secrets, private native fields and binaries', () => {
  const value = safeToolEventValue({
    task: 'Review code',
    prompt: 'Actual child task',
    instructions: 'Read first',
    api_key: 'SECRET_VALUE',
    nested: { password: 'PASSWORD_VALUE', command: 'echo token=TOKEN_VALUE' },
    system_prompt: 'HIDDEN_SYSTEM',
    thinking: 'HIDDEN_REASONING',
    privateField: 'PRIVATE_MARKED_FIELD',
    _meta: { reasoning: 'PRIVATE_PROTOCOL' },
    image: { type: 'image', data: 'BINARY_PAYLOAD' },
  });
  const serialized = JSON.stringify(value);
  assert.match(serialized, /Review code|Actual child task|Read first/);
  for (const secret of [
    'SECRET_VALUE',
    'PASSWORD_VALUE',
    'TOKEN_VALUE',
    'HIDDEN_SYSTEM',
    'HIDDEN_REASONING',
    'PRIVATE_MARKED_FIELD',
    'PRIVATE_PROTOCOL',
    'BINARY_PAYLOAD',
  ])
    assert.ok(!serialized.includes(secret), secret);
  const large = {
    content: 'x'.repeat(100000) + 'FULL_OUTPUT_END',
    deep: { value: 'y'.repeat(100000) + 'NESTED_END' },
    rows: Array.from({ length: 2000 }, (_, id) => ({ id, name: `entry-${id}` })),
  };
  assert.deepEqual(safeToolEventValue(large), large);
  const prototypeKey = JSON.parse('{"__proto__":{"safe":"actual user argument"}}');
  assert.deepEqual(safeToolEventValue(prototypeKey), prototypeKey);
  assert.equal(Object.getPrototypeOf(safeToolEventValue(prototypeKey)), Object.prototype);
  assert.match(String(safeToolEventValue('x'.repeat(4 * 1024 * 1024 + 1))), /capture truncated: text size limit/);
  const text = toolEventDetails({ output: 'COMBORUNNER_AGENT_TOKEN=0123456789abcdef HASH_OK:' + 'a'.repeat(64) });
  assert.ok(!JSON.stringify(text).includes('0123456789abcdef'));
  assert.ok(JSON.stringify(text).includes('a'.repeat(64)), 'ordinary hashes remain readable');
  assert.deepEqual(
    toolEventDetails({
      rawInput: { path: 'file.txt' },
      rawOutput: { exit_code: 1, is_error: true },
      prompt: 'hidden envelope',
    }),
    { input: { path: 'file.txt' }, output: { exit_code: 1, is_error: true }, exitCode: 1, isError: true },
  );
});

test('typed native Bash bytes become safe UTF-8 output while unrelated numeric arrays stay numeric', () => {
  const bytes = [
    ...Buffer.from(
      'CLI输出\nBearer OPAQUE_BEARER\napi_key=OPAQUE_API_KEY\n<thinking>PRIVATE_THOUGHT</thinking>',
      'utf8',
    ),
  ];
  const native = { type: 'Bash', output: bytes, exit_code: 0 };
  const details = toolEventDetails({ rawOutput: native });
  assert.deepEqual(details.output, {
    type: 'Bash',
    output: 'CLI输出\n[redacted]\napi_key=[redacted]\n[private content omitted]',
    exit_code: 0,
    outputEncoding: 'utf-8',
    outputByteLength: bytes.length,
  });
  assert.doesNotMatch(JSON.stringify(details), /OPAQUE_|PRIVATE_THOUGHT/);
  assert.deepEqual(native.output, bytes, 'source packet is never mutated');
  assert.deepEqual(safeToolEventValue({ type: 'Read', output: [65, 66] }), { type: 'Read', output: [65, 66] });
  assert.deepEqual(safeToolEventValue({ type: 'Bash', output: [65, 256] }), { type: 'Bash', output: [65, 256] });
  assert.deepEqual(safeToolEventValue({ type: 'Bash', output: [0xff, 0xfe, 65] }), {
    type: 'Bash',
    output: '[binary native Bash output omitted: invalid UTF-8]',
    outputEncoding: 'binary-omitted',
    outputByteLength: 3,
  });
});

test('Grok headless captures documented type-tagged tools and enriches streamed JSON input by native ID', async () => {
  const process = child(),
    events: RunEvent[] = [];
  const fullInput = { path: 'second.txt', content: 'x'.repeat(100000) + 'ARGUMENT_END' };
  const fullOutput = 'y'.repeat(100000) + 'RESULT_END';
  process.stdin.on('finish', () => {
    for (const packet of [
      {
        type: 'tool_call',
        toolCallId: 'headless-read',
        toolName: 'read_file',
        kind: 'read',
        status: 'in_progress',
        rawInput: { path: 'file.txt', token: 'SECRET_VALUE' },
      },
      {
        type: 'tool_call_update',
        toolCallId: 'headless-read',
        status: 'completed',
        rawOutput: { lines: 42, text: fullOutput },
      },
      {
        method: '_x.ai/session/update',
        params: {
          _meta: { promptId: 'native-prompt', eventId: 'native-event-1', hidden: 'PRIVATE_PROTOCOL' },
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'wrapped-read',
            rawInput: { tool_name: 'pugport__read_file', tool_input: { path: 'wrapped.txt' } },
            _meta: { 'x.ai/tool': { name: 'use_tool', kind: 'use_tool' } },
          },
        },
      },
      {
        method: '_x.ai/session/update',
        params: {
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'wrapped-read',
            kind: 'other',
            title: 'Read wrapped.txt',
            rawInput: { variant: 'UseTool', tool_name: 'pugport__read_file', tool_input: { path: 'wrapped.txt' } },
          },
        },
      },
      {
        method: '_x.ai/session/update',
        params: {
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'wrapped-read',
            status: 'completed',
            rawOutput: 'wrapped result',
          },
        },
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'stream-read', name: 'Read', input: {} },
        },
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(fullInput).slice(0, 50000) },
        },
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(fullInput).slice(50000) },
        },
      },
      { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'stream-read', name: 'Read', input: fullInput }] },
      },
      {
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'stream-read', content: [{ type: 'text', text: 'actual result' }] },
          ],
        },
      },
      { type: 'result', subtype: 'success', result: 'Done' },
    ])
      (process.stdout as PassThrough).write(JSON.stringify(packet) + '\n');
    process.emit('close', 0);
  });
  await createGrokAdapter({
    spawn: async () => process,
    targetPath: async (_target, path) => path,
    terminate: async () => {},
  }).execute(context(events));
  const tools = events.filter((event) => event.type === 'tool');
  assert.deepEqual(
    events
      .filter((event) => ['process-start', 'process-exit'].includes(String(event.data?.kind)))
      .map((event) => event.data?.kind),
    ['process-start', 'process-exit'],
  );
  const headless = tools.filter((event) => event.data?.toolCallId === 'headless-read');
  assert.deepEqual(
    headless.map((event) => event.data?.status),
    ['in_progress', 'completed'],
  );
  assert.equal(headless[1].data?.tool, 'read_file');
  assert.deepEqual(headless[0].data?.input, { path: 'file.txt', token: '[redacted]' });
  assert.deepEqual(headless[1].data?.output, { lines: 42, text: fullOutput });
  const wrapped = tools.filter((event) => event.data?.toolCallId === 'wrapped-read');
  assert.deepEqual(
    wrapped.map((event) => event.data?.status),
    ['pending', 'pending', 'completed'],
  );
  assert.ok(wrapped.every((event) => event.data?.kind === 'use_tool' && event.data?.tool === 'pugport__read_file'));
  assert.equal(wrapped[2].data?.nativeTool, 'use_tool');
  assert.equal(wrapped[1].data?.title, 'Read wrapped.txt');
  assert.equal(wrapped[0].data?.nativePromptId, 'native-prompt');
  assert.equal(wrapped[0].data?.nativeEventId, 'native-event-1');
  assert.equal(wrapped[2].data?.output, 'wrapped result');
  assert.ok(!JSON.stringify(tools).includes('PRIVATE_PROTOCOL'));
  const streamed = tools.filter((event) => event.data?.toolCallId === 'stream-read');
  assert.equal(streamed.length, 3, 'initial start, enriched input and result, without full-message duplicate');
  assert.deepEqual(streamed[1].data?.input, fullInput);
  assert.deepEqual(streamed[2].data?.output, [{ type: 'text', text: 'actual result' }]);
  assert.ok(tools.every((event) => Number.isFinite(Date.parse(event.at))));
  assert.ok(!JSON.stringify(tools).includes('SECRET_VALUE'));
});

test('Grok ACP captures metadata tool names and actual input/output without persisting the packet', async () => {
  const process = child(),
    events: RunEvent[] = [],
    ctx = context(events);
  let buffer = '';
  let sessionId = '';
  const send = (packet: Record<string, unknown>) =>
    (process.stdout as PassThrough).write(JSON.stringify({ jsonrpc: '2.0', ...packet }) + '\n');
  process.stdin.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const packet = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      queueMicrotask(() => {
        if (packet.method === 'initialize')
          send({
            id: packet.id,
            result: {
              protocolVersion: 1,
              agentCapabilities: { loadSession: true },
              authMethods: [{ id: 'cached_token' }],
              _meta: { defaultAuthMethodId: 'cached_token' },
            },
          });
        else if (packet.method === '_x.ai/interject')
          send({ id: packet.id, error: { code: -32602, message: 'Invalid params' } });
        else if (packet.method === 'session/new') {
          sessionId = packet.params._meta.sessionId;
          send({ id: packet.id, result: { sessionId } });
        } else if (packet.method === '_x.ai/session/info')
          send({ id: packet.id, result: { result: { sessionId, agentName: 'comborunner-grok' } } });
        else if (packet.method === 'session/prompt') {
          for (const update of [
            {
              sessionUpdate: 'tool_call',
              toolCallId: 'native-list',
              rawInput: { target_directory: 'project' },
              _meta: { 'x.ai/tool': { name: 'list_dir', kind: 'list' }, hidden: 'PRIVATE_PROTOCOL' },
            },
            {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'native-list',
              status: 'completed',
              content: [{ type: 'content', content: { type: 'text', text: 'listed files' } }],
            },
            {
              sessionUpdate: 'tool_call',
              toolCallId: 'native-mcp',
              title: 'use_tool',
              rawInput: { tool_name: 'pugport__organize_files', tool_input: { paths: ['file.txt'] } },
              _meta: { 'x.ai/tool': { name: 'use_tool', kind: 'use_tool' }, privateField: 'PRIVATE_PROTOCOL' },
            },
            {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'native-mcp',
              kind: 'other',
              title: 'Organize file.txt',
              rawInput: {
                variant: 'UseTool',
                tool_name: 'pugport__organize_files',
                tool_input: { paths: ['file.txt'] },
              },
              _meta: { 'x.ai/tool': { name: 'use_tool', kind: 'use_tool' } },
            },
            {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'native-mcp',
              status: 'failed',
              rawOutput: {
                type: 'Bash',
                output: [...Buffer.from('结果\nBearer BYTE_BEARER_SECRET\nAPI_KEY=BYTE_API_SECRET', 'utf8')],
                message: 'Operation failed token=SECRET_VALUE',
                exit_code: 1,
              },
              _meta: { 'x.ai/tool': { name: 'use_tool', kind: 'use_tool' } },
            },
            {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'unobserved-call',
              rawOutput: 'independent result',
              _meta: { 'x.ai/tool': { name: 'use_tool' } },
            },
            {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'xai-SECRET_NATIVE_ID',
              status: 'completed',
              rawOutput: 'result without safe identity',
            },
          ])
            send({
              method: 'session/update',
              params: {
                sessionId,
                update,
                _meta: {
                  promptId: 'native-prompt',
                  eventId: `native-event-${events.length}`,
                  privateField: 'PRIVATE_PROTOCOL',
                },
              },
            });
          send({
            method: 'session/update',
            params: {
              sessionId,
              update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done' } },
            },
          });
          send({ id: packet.id, result: { stopReason: 'end_turn' } });
        } else if (packet.method && packet.id !== undefined) send({ id: packet.id, result: {} });
      });
    }
  });
  await executeGrokAcp(ctx, {
    spawn: async () => process,
    terminate: async () => {
      process.emit('close', 0);
    },
    timeoutMs: 1000,
  });
  assert.deepEqual(
    events
      .filter((event) => ['process-start', 'process-exit'].includes(String(event.data?.kind)))
      .map((event) => event.data?.kind),
    ['process-start', 'process-exit'],
  );
  const tools = events.filter((event) => event.type === 'tool');
  assert.equal(tools.length, 7);
  assert.equal(tools[0].data?.tool, 'list_dir');
  assert.equal(tools[0].data?.status, 'pending');
  assert.deepEqual(tools[0].data?.input, { target_directory: 'project' });
  assert.deepEqual(tools[1].data?.output, [{ type: 'content', content: { type: 'text', text: 'listed files' } }]);
  assert.equal(tools[3].data?.tool, 'pugport__organize_files');
  assert.deepEqual(
    tools.slice(2, 5).map((event) => event.data?.status),
    ['pending', 'pending', 'failed'],
  );
  assert.ok(tools.slice(2, 5).every((event) => event.data?.kind === 'use_tool'));
  assert.equal(tools[4].data?.tool, 'pugport__organize_files', 'wrapper completion cannot overwrite exact target');
  assert.equal(tools[4].data?.nativeTool, 'use_tool');
  assert.equal(tools[3].data?.title, 'Organize file.txt');
  assert.equal(tools[4].data?.exitCode, 1);
  const bashOutput = tools[4].data?.output as Record<string, unknown>;
  assert.equal(bashOutput.output, '结果\n[redacted]\nAPI_KEY=[redacted]');
  assert.equal(bashOutput.outputEncoding, 'utf-8');
  assert.equal(
    bashOutput.outputByteLength,
    Buffer.byteLength('结果\nBearer BYTE_BEARER_SECRET\nAPI_KEY=BYTE_API_SECRET', 'utf8'),
  );
  assert.ok(!Array.isArray(bashOutput.output), 'encoded secrets cannot remain in the persisted tool field');
  assert.doesNotMatch(JSON.stringify(tools), /BYTE_BEARER_SECRET|BYTE_API_SECRET/);
  assert.equal(tools[0].data?.nativePromptId, 'native-prompt');
  assert.match(String(tools[0].data?.nativeEventId), /^native-event-/);
  assert.equal(tools[5].data?.toolCallId, 'unobserved-call');
  assert.equal(tools[5].data?.tool, 'use_tool');
  assert.equal(tools[5].data?.status, undefined, 'another native ID cannot supply an unobserved lifecycle');
  assert.equal(tools[6].data?.toolCallId, undefined);
  assert.ok(JSON.stringify(tools).includes('[redacted]'));
  assert.ok(!JSON.stringify(tools).includes('PRIVATE_PROTOCOL'));
  assert.ok(!JSON.stringify(tools).includes('SECRET_VALUE'));
  assert.ok(!JSON.stringify(tools).includes('SECRET_NATIVE_ID'));
});
