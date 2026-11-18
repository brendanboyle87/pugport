import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { RuntimeTarget } from '../src/shared/types.ts';
import { createGrokAdapter } from '../src/server/adapters/grok.ts';
import { createClaudeAdapter } from '../src/server/adapters/claude.ts';
import { createCodexAdapter } from '../src/server/adapters/codex.ts';

const runtime = (provider: RuntimeTarget['provider']): RuntimeTarget => ({
  id: `fixture-${provider}`,
  provider,
  label: provider,
  command: 'fixture',
  environment: 'native',
  enabled: true,
});

function peer(receive: (packet: Record<string, unknown>, send: (packet: unknown) => void) => void) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null as number | null,
    signalCode: null,
  });
  let buffer = '';
  const send = (packet: unknown) => child.stdout.write(Buffer.from(JSON.stringify(packet) + '\n'));
  child.stdin.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    let boundary: number;
    while ((boundary = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 1);
      if (line) receive(JSON.parse(line), send);
    }
  });
  child.stdin.on('finish', () => {
    child.exitCode = 0;
    child.emit('close', 0);
  });
  return child as unknown as ChildProcessWithoutNullStreams;
}

test('Grok starts the model listing while version metadata is still pending', async () => {
  let versionPending = false;
  const commands: string[] = [];
  const adapter = createGrokAdapter({
    capture: async (_target, args) => {
      commands.push(args[0]!);
      if (args[0] === '--version') {
        versionPending = true;
        await Promise.resolve();
        versionPending = false;
        return { stdout: 'grok 0.2.93', exitCode: 0 };
      }
      assert.equal(versionPending, true, 'model discovery must not wait for the other CLI cold start');
      return { stdout: 'You are logged in with grok.com.\n - grok-4.7', exitCode: 0 };
    },
    quota: async () => ({ status: 'known', source: 'fixture', observedAt: null, windows: [] }),
  });
  // The ACP handshake already passed for this version; otherwise discovery would start a real Grok.
  const snapshot = await adapter.discover(runtime('grok'), { grokHandshake: { lastPassedVersion: '0.2.93' } });
  assert.equal(snapshot.status, 'ready');
  assert.equal(snapshot.models[0]?.id, 'grok-4.7');
  assert.deepEqual(commands, ['--version', 'models']);
});

test('Claude queries usage without waiting for an independent model catalog response', async () => {
  let catalogPending = false;
  const requests: string[] = [];
  const child = peer((packet, send) => {
    const request = packet.request as Record<string, unknown>;
    const subtype = String(request.subtype);
    requests.push(subtype);
    const respond = (response: unknown) =>
      send({ type: 'control_response', response: { request_id: packet.request_id, subtype: 'success', response } });
    if (subtype === 'list_models') {
      catalogPending = true;
      queueMicrotask(() => {
        catalogPending = false;
        respond({ models: [{ value: 'sonnet' }] });
      });
    } else if (subtype === 'get_usage') {
      assert.equal(catalogPending, true);
      respond({ rate_limits_available: true, rate_limits: { five_hour: { utilization: 20 } } });
    } else respond({});
  });
  const adapter = createClaudeAdapter({
    spawn: async () => child,
    capture: async () => ({ stdout: JSON.stringify({ loggedIn: true }), exitCode: 0 }),
    terminate: async () => undefined,
  });
  const snapshot = await adapter.discover(runtime('claude'));
  assert.equal(snapshot.status, 'ready');
  assert.equal(snapshot.quota.windows[0]?.usedPercent, 20);
  assert.deepEqual(requests, ['initialize', 'list_models', 'get_usage']);
});

test('Codex starts paginated model discovery before account metadata returns, without starting a turn', async () => {
  let accountPending = false;
  const requests: string[] = [];
  const child = peer((packet, send) => {
    const method = String(packet.method);
    requests.push(method);
    const params = (packet.params ?? {}) as Record<string, unknown>;
    const respond = (result: unknown) => send({ id: packet.id, result });
    if (method === 'initialized') return;
    if (method === 'account/read') {
      accountPending = true;
      queueMicrotask(() => {
        accountPending = false;
        respond({ account: { type: 'chatgpt', planType: 'plus' } });
      });
    } else if (method === 'model/list') {
      if (!params.cursor) assert.equal(accountPending, true);
      respond({ data: [{ model: params.cursor ? 'model-two' : 'model-one' }], nextCursor: params.cursor ? null : '2' });
    } else if (method === 'account/rateLimits/read') {
      assert.equal(accountPending, false, 'subscription quota still waits for the actual authentication mode');
      respond({ rateLimits: { primary: { usedPercent: 30 } } });
    } else if (method === 'initialize') respond({});
    else assert.fail(`Unexpected inference or control request: ${method}`);
  });
  const adapter = createCodexAdapter({
    spawn: async () => child,
    terminate: async () => {
      child.stdin.end();
    },
  });
  const snapshot = await adapter.discover(runtime('codex'));
  assert.equal(snapshot.status, 'ready');
  assert.deepEqual(
    snapshot.models.map((model) => model.id),
    ['model-one', 'model-two'],
  );
  assert.equal(snapshot.quota.windows[0]?.usedPercent, 30);
  assert.ok(!requests.some((method) => method.startsWith('thread/') || method.startsWith('turn/')));
});
