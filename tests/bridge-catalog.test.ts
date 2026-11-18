import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { PassThrough, Writable } from 'node:stream';
import { test } from 'node:test';
import {
  deferredBridgeTools,
  deferredBridgeToolNames,
  searchBridgeTools,
  sortBridgeTools,
  type BridgeCatalogTool,
} from '../src/shared/bridge-catalog.ts';
import { claudeExecutionArgs } from '../src/server/adapters/claude.ts';
import { createCursorAdapter, cursorAccountFingerprint } from '../src/server/adapters/cursor.ts';
import type { ExecuteContext } from '../src/shared/types.ts';

const tool = (
  name: string,
  description = '',
  inputSchema: Record<string, unknown> = { type: 'object' },
): BridgeCatalogTool => ({
  name,
  description,
  inputSchema,
});

test('deferred catalog exposes only three wrappers with distinct read/write annotations', () => {
  assert.deepEqual(deferredBridgeToolNames, ['search_tools', 'call_read_only_tool', 'call_tool']);
  assert.deepEqual(
    deferredBridgeTools.map((entry) => entry.annotations?.readOnlyHint),
    [true, true, false],
  );
  for (const entry of deferredBridgeTools.slice(1)) {
    assert.deepEqual(entry.inputSchema.required, ['name', 'arguments']);
    assert.equal(entry.inputSchema.additionalProperties, false);
  }
});

test('catalog sorting preserves complete nested schemas, array order, metadata and original inputs', () => {
  const schema = {
    type: 'object',
    required: ['z', 'a'],
    properties: {
      z: { type: 'string', description: 'x'.repeat(5000), enum: ['z', 'a'] },
      a: {
        oneOf: [
          { type: 'number', minimum: 1 },
          { type: 'string', minLength: 3 },
        ],
      },
    },
  };
  const original = [
    tool('z'),
    { ...tool('a'), inputSchema: schema, annotations: { readOnlyHint: true, custom: 'kept' } },
  ];
  const before = JSON.stringify(original),
    sorted = sortBridgeTools(original);
  assert.deepEqual(
    sorted.map((entry) => entry.name),
    ['a', 'z'],
  );
  assert.deepEqual(Object.keys(sorted[0]!.inputSchema), ['properties', 'required', 'type']);
  assert.deepEqual(Object.keys(sorted[0]!.inputSchema.properties as object), ['a', 'z']);
  assert.deepEqual(sorted[0]!.inputSchema, schema);
  assert.deepEqual(sorted[0]!.annotations, { readOnlyHint: true, custom: 'kept' });
  assert.equal(JSON.stringify(original), before);
  assert.equal(JSON.stringify(sortBridgeTools([...original].reverse())), JSON.stringify(sorted));
});

test('catalog search ranks exact names then name terms before descriptions with deterministic ties', () => {
  const tools = [tool('z', 'find file'), tool('a', 'find file'), tool('find_file'), tool('find')];
  assert.deepEqual(
    searchBridgeTools(tools, { query: 'ＦＩＮＤ' }).tools.map((entry) => entry.name),
    ['find', 'find_file', 'a', 'z'],
  );
  assert.deepEqual(
    searchBridgeTools(tools.reverse(), { query: 'find file' }).tools.map((entry) => entry.name),
    ['find_file', 'a', 'z'],
  );
  assert.equal(searchBridgeTools([tool('read_document', '读取中文文档')], { query: '中文' }).total, 1);
  assert.equal(searchBridgeTools(tools, { query: 'find absent' }).total, 0);
});

test('external schemas reject excessive nesting and cycles instead of overflowing or silently truncating', () => {
  let schema: Record<string, unknown> = {};
  for (let depth = 0; depth < 64; depth++) schema = { child: schema };
  assert.doesNotThrow(() => sortBridgeTools([tool('at-limit', '', schema)]));
  assert.throws(() => sortBridgeTools([tool('too-deep', '', { child: schema })]), /schema.*nesting limit/);
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.throws(() => searchBridgeTools([tool('cycle', '', cyclic)], {}), /schema.*nesting limit/);
  assert.deepEqual(
    searchBridgeTools([tool('excluded', '', cyclic), tool('selected')], { names: ['selected'] }).tools.map(
      (entry) => entry.name,
    ),
    ['selected'],
  );
});

test('exact name filters intersect keyword queries and never fuzzy-match a requested identity', () => {
  const tools = [tool('read', 'file'), tool('read_more', 'file'), tool('READ', 'file')];
  assert.deepEqual(
    searchBridgeTools(tools, { names: ['read'], query: 'file' }).tools.map((entry) => entry.name),
    ['read'],
  );
  assert.equal(searchBridgeTools(tools, { names: ['rea'] }).total, 0);
  assert.equal(searchBridgeTools(tools, { names: ['read'], query: 'missing' }).total, 0);
});

test('catalog pagination preserves whole schemas and reports the next filtered offset', () => {
  const tools = Array.from({ length: 7 }, (_, index) =>
    tool(`tool_${index}`, `group ${index}`, { type: 'object', const: index }),
  );
  const first = searchBridgeTools(tools, {});
  assert.equal(first.tools.length, 5);
  assert.equal(first.total, 7);
  assert.equal(first.nextOffset, 5);
  const second = searchBridgeTools(tools, { offset: first.nextOffset });
  assert.deepEqual(
    second.tools.map((entry) => entry.name),
    ['tool_5', 'tool_6'],
  );
  assert.equal(second.nextOffset, undefined);
  assert.deepEqual(searchBridgeTools(tools, { offset: 20 }), { tools: [], total: 7 });
  assert.deepEqual(
    searchBridgeTools(tools, { query: 'group', limit: 1, offset: 2 }).tools[0]!.inputSchema,
    tools[2]!.inputSchema,
  );
});

for (const args of [
  { unknown: true },
  { names: 'read' },
  { names: [] },
  { names: [1] },
  { names: [''] },
  { names: Array.from({ length: 51 }, () => 'read') },
  { query: 1 },
  { query: 'x'.repeat(501) },
  { offset: -1 },
  { offset: 0.5 },
  { offset: '1' },
  { offset: Number.MAX_SAFE_INTEGER + 1 },
  { offset: null },
  { limit: 0 },
  { limit: 21 },
  { limit: NaN },
  { limit: '5' },
  { limit: null },
])
  test(`catalog rejects invalid search arguments ${JSON.stringify(args)}`, () => {
    assert.throws(() => searchBridgeTools([tool('read')], args), /Invalid tool search/);
  });

const context = (provider: 'claude' | 'cursor'): ExecuteContext => ({
  target: {
    id: 'synthetic',
    provider,
    label: 'Synthetic',
    command: 'never-spawned',
    environment: 'native',
    enabled: true,
  },
  input: { prompt: 'synthetic', projectPath: 'synthetic-unused', kind: 'routine', permissionMode: 'workspace-write' },
  route: {
    runtimeId: 'synthetic',
    model: provider === 'cursor' ? 'composer-2.5' : 'sonnet',
    kind: 'routine',
    reasons: [],
    warnings: [],
  },
  signal: new AbortController().signal,
  approvalMode: 'ask',
  agentBridge: { url: 'http://127.0.0.1:5555/agent', token: 'synthetic-not-a-credential' },
  emit: () => {},
  approve: async () => false,
});

test('Claude only preapproves deferred wrappers in addition to the unchanged manual built-ins and GitHub policy', () => {
  const ctx = context('claude');
  ctx.agentBridge!.extraTools = [...deferredBridgeToolNames, 'mcp_fixture__write', 'github_existing', 'use_skill'];
  const args = claudeExecutionArgs(ctx, 'synthetic-mcp-config'),
    allowed = args[args.indexOf('--allowedTools') + 1]!.split(',');
  for (const name of deferredBridgeToolNames) assert(allowed.includes(`mcp__pugport__${name}`));
  assert(allowed.includes('mcp__pugport__github_existing'));
  assert(allowed.includes('mcp__pugport__organize_files'));
  assert(!allowed.includes('mcp__pugport__mcp_fixture__write'));
  assert(!allowed.includes('mcp__pugport__use_skill'));
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'manual');
  ctx.approvalMode = 'auto';
  assert(claudeExecutionArgs(ctx, 'synthetic-mcp-config').join(' ').includes('mcp__pugport__mcp_fixture__write'));
});

// A small in-memory peer drives the real adapter permission handler; no CLI, file or network is used.
async function permissionFixture(provider: 'cursor', grantedNames: string[]) {
  const identity = { isAuthenticated: true, userInfo: { userId: 'synthetic-user' } };
  const ctx = context(provider),
    outcomes: Array<{ outcome: string; optionId?: string }> = [];
  const requests = [
    ...deferredBridgeToolNames.map((name) => ({ kind: 'other', toolName: `mcp__pugport__${name}` })),
    { kind: 'other', toolName: 'mcp__pugport__delegate' },
    { kind: 'other', toolName: 'mcp__pugport__git' },
    { kind: 'other', toolName: 'mcp__foreign__call_tool' },
    { kind: 'other', title: 'mcp__pugport__call_tool' },
    { kind: 'edit', toolName: 'mcp__pugport__call_tool' },
    { kind: 'other', toolName: 'mcp__pugport__call_tool_suffix' },
    { kind: 'other', toolName: '\u001b[32mmcp__pugport__call_tool\u001b[0m' },
    { kind: 'other', toolName: ' mcp__pugport__call_tool ' },
    { kind: 'other', toolName: '\u200bmcp__pugport__call_tool' },
    { kind: 'other', toolName: 'foreign_tool', rawInput: { tool_name: 'mcp__pugport__call_tool' } },
    { kind: 'other', toolName: 123, rawInput: { tool_name: 'mcp__pugport__call_tool' } },
    { kind: 'other', toolName: '', rawInput: { tool_name: 'mcp__pugport__call_tool' } },
  ];
  let approvalCalls = 0,
    permissionIndex = 0,
    promptId: string | number | undefined,
    terminated = false;
  ctx.approve = async () => {
    approvalCalls++;
    return false;
  };
  ctx.route.accountFingerprint = provider === 'cursor' ? cursorAccountFingerprint(identity) : 'synthetic-fingerprint';
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  }) as unknown as ChildProcessWithoutNullStreams;
  const send = (packet: object) =>
    child.stdout.emit('data', Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...packet }) + '\n'));
  const nextPermission = () => {
    const toolCall = requests[permissionIndex++];
    if (!toolCall) {
      send({ id: promptId, result: { stopReason: 'end_turn' } });
      return;
    }
    send({
      id: `permission-${permissionIndex}`,
      method: 'session/request_permission',
      params: {
        sessionId: 'synthetic-session',
        toolCall,
        options: [
          { optionId: 'once', kind: 'allow_once' },
          { optionId: 'reject', kind: 'reject_once' },
        ],
      },
    });
  };
  child.stdin = new Writable({
    write(chunk, _encoding, done) {
      const packet = JSON.parse(String(chunk)) as {
        id: string | number;
        method?: string;
        result?: { outcome: { outcome: string; optionId?: string } };
      };
      if (!packet.method) {
        outcomes.push(packet.result!.outcome);
        done();
        queueMicrotask(nextPermission);
        return;
      }
      let result: object = {};
      switch (packet.method) {
        case 'initialize':
          result = { protocolVersion: 1, agentCapabilities: { mcpCapabilities: { http: true } } };
          break;
        case 'cursor/list_available_models':
          result = { models: [{ value: 'composer-2.5', name: 'Composer', configOptions: [] }] };
          break;
        case 'session/new':
          result = {
            sessionId: 'synthetic-session',
            modes: { availableModes: [{ id: 'agent' }, { id: 'default' }] },
            models: { currentModelId: ctx.route.model },
            configOptions: [
              {
                id: 'model',
                category: 'model',
                type: 'select',
                currentValue: ctx.route.model,
                options: [{ value: ctx.route.model }],
              },
            ],
          };
          break;
        case 'session/set_mode':
          break;
        case 'session/prompt':
          promptId = packet.id;
          done();
          queueMicrotask(nextPermission);
          return;
        default:
          assert.fail(`Unexpected synthetic ACP request ${packet.method}`);
      }
      send({ id: packet.id, result });
      done();
    },
  });
  const common = {
    spawn: async () => child,
    targetPath: async (_target: unknown, path: string) => path,
    bridgeTools: async () => grantedNames,
    terminate: async () => {
      terminated = true;
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    },
    requestTimeoutMs: 1000,
  };
  const adapter = createCursorAdapter({
    ...common,
    capture: async () => ({ stdout: JSON.stringify(identity), exitCode: 0 }),
  });
  await adapter.execute(ctx);
  assert.equal(terminated, true);
  return { outcomes, approvalCalls };
}

for (const provider of ['cursor'] as const) {
  test(`${provider} delegates only authenticated catalog wrappers to host approval; ordinary or forged tools still ask`, async () => {
    const result = await permissionFixture(provider, [...deferredBridgeToolNames, 'delegate', 'git']);
    assert.deepEqual(
      result.outcomes.map((outcome) => outcome.optionId),
      ['once', 'once', 'once', ...Array(12).fill('reject')],
    );
    assert.equal(result.approvalCalls, 12);
  });
  test(`${provider} never grants a wrapper name absent from the authenticated host catalog`, async () => {
    const result = await permissionFixture(provider, ['delegate', 'git']);
    assert(result.outcomes.every((outcome) => outcome.optionId === 'reject'));
    assert.equal(result.approvalCalls, 15);
  });
}
