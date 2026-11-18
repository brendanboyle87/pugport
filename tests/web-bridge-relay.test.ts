import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { OwnedBackend } from '../src/electron/backend.ts';
import { APP_NAME, APP_VERSION } from '../src/shared/identity.ts';
import { desktopWebBridge, handleWebAgentReply } from '../src/server/external-agents/web-bridge-client.ts';

// The IPC between the backend and the desktop app's web bridge, with in-memory stand-ins for both ends.
class Child extends EventEmitter {
  connected = true;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  pid = 4242;
  stdout = { resume() {} };
  stderr = { resume() {} };
  messages: Record<string, unknown>[] = [];
  send(message: Record<string, unknown>, callback?: (error: Error | null) => void) {
    this.messages.push(message);
    callback?.(null);
    return true;
  }
}

async function started(webAgent?: (request: unknown) => Promise<unknown>) {
  const child = new Child();
  const dataDir = resolve(tmpdir(), 'pugport-web-bridge-relay-unit');
  const backend = new OwnedBackend({
    healthFetch: async () => {
      throw new Error('synthetic offline probe');
    },
    root: resolve('.'),
    port: 54322,
    dataDir,
    startupMs: 500,
    launch: () => child as unknown as ChildProcess,
    terminate: async () => {},
    ...(webAgent ? { webAgent } : {}),
  });
  const ready = backend.start();
  child.emit('message', { type: 'ready', name: APP_NAME, version: APP_VERSION, port: 54322, dataDir });
  await ready;
  return child;
}

test('the desktop app answers a web agent request from the backend with the same request id', async () => {
  const seen: unknown[] = [];
  const child = await started(async (request) => {
    seen.push(request);
    return { ok: true, reply: 'fake reply' };
  });
  child.emit('message', { type: 'web-agent', requestId: 9, request: { action: 'send', agentId: 'grok-bot' } });
  await new Promise((done) => setImmediate(done));
  assert.deepEqual(seen, [{ action: 'send', agentId: 'grok-bot' }]);
  assert.deepEqual(child.messages.at(-1), {
    type: 'web-agent-result',
    requestId: 9,
    result: { ok: true, reply: 'fake reply' },
  });
});

test('without a web bridge the desktop app says web agents are unavailable', async () => {
  const child = await started();
  child.emit('message', { type: 'web-agent', requestId: 3, request: {} });
  await new Promise((done) => setImmediate(done));
  const answer = child.messages.at(-1) as { requestId: number; result: { ok: boolean; code: string } };
  assert.equal(answer.requestId, 3);
  assert.equal(answer.result.ok, false);
  assert.equal(answer.result.code, 'unavailable');
});

test('the backend side waits for the matching answer, and is unavailable outside the desktop app', async (t) => {
  const previous = { env: process.env.PUGPORT_WEB_BRIDGE, send: process.send, connected: process.connected };
  t.after(() => {
    if (previous.env === undefined) delete process.env.PUGPORT_WEB_BRIDGE;
    else process.env.PUGPORT_WEB_BRIDGE = previous.env;
    process.send = previous.send;
    Object.defineProperty(process, 'connected', { value: previous.connected, configurable: true, writable: true });
  });
  delete process.env.PUGPORT_WEB_BRIDGE;
  assert.equal(desktopWebBridge.available(), false);
  const offline = await desktopWebBridge.request(
    { action: 'open', agentId: 'muse', name: 'Muse', url: 'https://x.test' },
    1000,
  );
  assert.equal(offline.code, 'unavailable');

  process.env.PUGPORT_WEB_BRIDGE = '1';
  Object.defineProperty(process, 'connected', { value: true, configurable: true, writable: true });
  const sent: Array<{ requestId: number }> = [];
  process.send = ((message: { requestId: number }) => {
    sent.push(message);
    return true;
  }) as typeof process.send;
  assert.equal(desktopWebBridge.available(), true);
  const pending = desktopWebBridge.request(
    { action: 'open', agentId: 'muse', name: 'Muse', url: 'https://x.test' },
    5000,
  );
  assert.equal(
    handleWebAgentReply({ type: 'web-agent-result', requestId: sent[0]!.requestId + 100, result: { ok: true } }),
    true,
  );
  assert.equal(handleWebAgentReply({ type: 'page-test-result', requestId: 1 }), false, 'other messages are left alone');
  handleWebAgentReply({
    type: 'web-agent-result',
    requestId: sent[0]!.requestId,
    result: { ok: true, message: 'opened' },
  });
  assert.deepEqual(await pending, { ok: true, message: 'opened' });
  const late = await desktopWebBridge.request(
    { action: 'open', agentId: 'muse', name: 'Muse', url: 'https://x.test' },
    20,
  );
  assert.equal(late.code, 'timeout', 'no answer in time is a plain timeout, not a hang');
  const sendTimedOut = await desktopWebBridge.request(
    { action: 'send', agentId: 'muse', name: 'Muse', url: 'https://x.test', text: 'Question' },
    20,
  );
  assert.equal(sendTimedOut.code, 'timeout');
  assert.deepEqual((sent.at(-1) as { request?: unknown })?.request, {
    action: 'cancel',
    agentId: 'muse',
    name: 'Muse',
    url: 'https://x.test',
  });
});
