import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { ExecuteContext, RunEvent } from '../src/shared/types.ts';
import { executeGrokAcp } from '../src/server/adapters/grok-acp.ts';
import { grokBuildBalanceFailure, grokBuildBillingMessage } from '../src/server/grok-billing-failure.ts';

type Packet = Record<string, any>;
type Boundary = 'rpc' | 'extension' | 'update' | 'prompt';

async function failureFixture(boundary: Boundary, failure: unknown) {
  const events: RunEvent[] = [];
  const child = Object.assign(new EventEmitter(), {
    pid: 123,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  }) as unknown as ChildProcessWithoutNullStreams;
  const send = (packet: Packet) =>
    (child.stdout as PassThrough).write(JSON.stringify({ jsonrpc: '2.0', ...packet }) + '\n');
  let buffer = '';
  let sessionId = '';
  child.stdin.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    let at: number;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const packet: Packet = JSON.parse(buffer.slice(0, at));
      buffer = buffer.slice(at + 1);
      queueMicrotask(() => {
        if (!packet.method) return;
        if (packet.method === 'initialize') {
          if (boundary === 'rpc') send({ id: packet.id, error: failure });
          else
            send({
              id: packet.id,
              result: {
                protocolVersion: 1,
                agentCapabilities: { loadSession: true },
                authMethods: [{ id: 'cached_token' }],
                _meta: { defaultAuthMethodId: 'cached_token' },
              },
            });
        } else if (packet.method === '_x.ai/interject')
          send({ id: packet.id, error: { code: -32602, message: 'Invalid params' } });
        else if (packet.method === 'session/new') {
          sessionId = packet.params._meta.sessionId;
          send({ id: packet.id, result: { sessionId } });
          send({ method: '_x.ai/mcp_initialized', params: { sessionId } });
        } else if (packet.method === '_x.ai/session/info')
          send({
            id: packet.id,
            result:
              boundary === 'extension' ? { error: failure } : { result: { sessionId, agentName: 'comborunner-grok' } },
          });
        else if (packet.method === 'session/prompt') {
          const object = failure !== null && typeof failure === 'object' ? (failure as Packet) : undefined;
          const causes = {
            agentResult: object?.message ?? failure,
            errorKind: object?.data,
          };
          if (boundary === 'update')
            send({
              method: '_x.ai/session/update',
              params: {
                sessionId,
                update: {
                  type: 'turn_completed',
                  promptId: packet.params._meta.promptId,
                  stopReason: 'error',
                  ...causes,
                },
              },
            });
          else send({ id: packet.id, result: { stopReason: 'error', ...causes } });
        } else send({ id: packet.id, result: {} });
      });
    }
  });
  const ctx: ExecuteContext = {
    target: {
      id: 'grok',
      provider: 'grok',
      label: 'Grok',
      command: 'never-executed',
      environment: 'native',
      enabled: true,
    },
    input: { prompt: 'Synthetic task', projectPath: 'C:/synthetic', kind: 'general', permissionMode: 'read-only' },
    route: { runtimeId: 'grok', model: 'grok-4.7', kind: 'general', reasons: [], warnings: [] },
    signal: new AbortController().signal,
    approvalMode: 'auto',
    emit: (event) => events.push(event),
    approve: async () => {
      throw new Error('No approval is expected');
    },
    registerSteer: () => {},
  };
  let error: unknown;
  try {
    await executeGrokAcp(ctx, {
      spawn: async () => child,
      terminate: async () => {
        child.emit('close', 1, null);
      },
      timeoutMs: 1000,
    });
    assert.fail('A native failure must not complete successfully');
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof Error);
  return { error, events };
}

test('Grok audits unknown structured and textual native causes at every response boundary without copying diagnostics', async () => {
  const cases = [
    {
      code: -32000,
      data: { reason: 'content-policy', authorization: 'Bearer synthetic-secret', path: 'C:/synthetic-hidden' },
    },
    { message: 'I cannot assist with this request because of content policy. synthetic-secret C:/synthetic-hidden' },
    { message: 'quota exceeded', data: { reason: 'unknown cause', authorization: 'Bearer synthetic-secret' } },
    { message: { reason: 'unparsed object', token: 'synthetic-secret' } },
  ];
  for (const boundary of ['rpc', 'extension', 'update', 'prompt'] as const)
    for (const failure of cases) {
      const { events } = await failureFixture(boundary, failure);
      const marker = events.find((event) => event.data?.relayBlocked === true);
      assert.ok(marker, `${boundary}: structured or unmapped causes need a durable blocker`);
      assert.equal(marker.data?.source, 'native');
      assert.equal(marker.data?.kind, 'protocol-unmapped');
      assert.equal(
        (marker.data?.detail as Packet).boundary,
        { rpc: 'json-rpc-error', extension: 'extension-result', update: 'turn-completed', prompt: 'prompt-result' }[
          boundary
        ],
      );
      const serialized = JSON.stringify(events);
      for (const privateValue of ['synthetic-secret', 'C:/synthetic-hidden', 'content-policy', 'unparsed object'])
        assert.ok(!serialized.includes(privateValue), `${boundary}: raw diagnostic must stay private`);
    }
});

test('Grok keeps reliable typed auth and quota reports classified without adding an opaque-cause blocker', async () => {
  for (const boundary of ['rpc', 'extension'] as const)
    for (const [message, expected] of [
      ['Authentication required', 'authentication-required'],
      ['Rate limit exceeded', 'quota-or-rate-limit'],
    ]) {
      const { error, events } = await failureFixture(boundary, { code: -32000, message });
      assert.equal(error.message, expected);
      assert.ok(!events.some((event) => event.data?.relayBlocked === true));
    }
});

test('canonical generic native failures carry no invented cause while unknown primitive causes stay blocked', async () => {
  for (const boundary of ['rpc', 'extension', 'update', 'prompt'] as const) {
    const canonical = await failureFixture(boundary, { code: -32000, message: 'runtime-request-failed' });
    assert.equal(canonical.error.message, 'runtime-request-failed');
    assert.ok(!canonical.events.some((event) => event.data?.relayBlocked === true), boundary);
    const opaque = await failureFixture(boundary, { message: 123 });
    assert.equal(opaque.error.message, 'runtime-request-failed');
    assert.ok(
      opaque.events.some((event) => event.data?.relayBlocked === true),
      boundary,
    );
  }
});

const balanceEnvelope = {
  code: -32603,
  message: 'Internal error',
  data: {
    http_status: 402,
    message: 'API error (status 402 Payment Required): Grok Build usage balance exhausted',
    promptUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, numTurns: 0, usageIsIncomplete: true },
  },
};
test('official structured 402 Build balance reports are typed and readable at all Grok failure boundaries', async () => {
  for (const boundary of ['rpc', 'extension', 'update', 'prompt'] as const) {
    const { error, events } = await failureFixture(boundary, balanceEnvelope);
    assert.equal(error.message, 'quota-or-rate-limit', boundary);
    assert.ok(!events.some((event) => event.data?.relayBlocked === true), boundary);
    assert.ok(
      events.some((event) => event.data?.billingSource === 'grok-build' && event.text === grokBuildBillingMessage),
    );
    assert.ok(!JSON.stringify(events).includes('promptUsage'), 'the diagnostic copies no raw envelope');
  }
});
test('Build billing classification rejects 403, unknown shapes and competing content or permission causes', () => {
  assert.equal(grokBuildBalanceFailure(balanceEnvelope), true);
  for (const code of [-32000, -32602, -32601, 403])
    assert.equal(grokBuildBalanceFailure({ ...balanceEnvelope, code }), false);
  for (const data of [
    { ...balanceEnvelope.data, http_status: 403 },
    { ...balanceEnvelope.data, reason: 'content-policy' },
    { ...balanceEnvelope.data, details: 'Permission denied' },
    { ...balanceEnvelope.data, extra: { opaque: true } },
    { ...balanceEnvelope.data, promptUsage: { unknown: true } },
    { http_status: 402, message: 'Payment Required' },
    { http_status: 402, message: 'Unknown request failure' },
  ])
    assert.equal(grokBuildBalanceFailure({ ...balanceEnvelope, data }), false);
});
