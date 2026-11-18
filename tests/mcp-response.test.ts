import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test, type TestContext } from 'node:test';
import type { Response } from 'express';
import { sendMcpReply } from '../src/server/mcp-response.ts';

class Reply extends EventEmitter {
  statusCode = 200;
  headers: Record<string, string> = {};
  headersSent = false;
  destroyed = false;
  writableEnded = false;
  chunks: string[] = [];
  jsonBody: unknown;
  status(code: number) {
    this.statusCode = code;
    return this;
  }
  setHeader(name: string, value: string) {
    this.headers[name] = value;
    return this;
  }
  flushHeaders() {
    this.headersSent = true;
  }
  write(chunk: string) {
    assert.equal(this.destroyed || this.writableEnded, false, 'No writes after close or end');
    this.chunks.push(chunk);
    return true;
  }
  end(chunk?: string) {
    if (chunk !== undefined) this.write(chunk);
    this.headersSent = this.writableEnded = true;
    return this;
  }
  json(body: unknown) {
    this.jsonBody = body;
    return this.end();
  }
  close() {
    this.destroyed = true;
    this.emit('close');
  }
}

const body = { jsonrpc: '2.0', id: 'synthetic', result: { content: [{ type: 'text', text: '精确\nreply' }] } };
function pending(t: TestContext, accept: string | undefined = 'application/json, text/event-stream') {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const res = new Reply();
  let resolve!: (reply: { status: number; body?: unknown }) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<{ status: number; body?: unknown }>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  const reply = { promise, resolve, reject };
  let signal!: AbortSignal;
  const done = sendMcpReply(
    res as unknown as Response,
    accept,
    (activeSignal) => {
      signal = activeSignal;
      return reply.promise;
    },
    { streamAfterMs: 10, keepaliveMs: 25 },
  );
  return { res, reply, done, signal };
}

test('fast MCP replies preserve status, JSON and empty notification responses', async (t) => {
  for (const reply of [{ status: 200, body }, { status: 401, body: { error: 'synthetic' } }, { status: 202 }]) {
    const f = pending(t);
    f.reply.resolve(reply);
    await f.done;
    t.mock.timers.tick(100);
    assert.equal(f.res.statusCode, reply.status);
    assert.deepEqual(f.res.jsonBody, reply.body);
    assert.deepEqual(f.res.headers, {});
    assert.deepEqual(f.res.chunks, []);
    assert.equal(f.res.writableEnded, true);
    t.mock.timers.reset();
  }
});

test('slow MCP SSE replies flush headers, keep alive periodically and send the exact final JSON', async (t) => {
  const f = pending(t);
  t.mock.timers.tick(9);
  assert.equal(f.res.headersSent, false);
  t.mock.timers.tick(1);
  assert.equal(f.res.headersSent, true, 'Headers arrive while the call is still pending');
  assert.equal(f.res.writableEnded, false);
  assert.equal(f.res.statusCode, 200);
  assert.deepEqual(f.res.headers, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  assert.deepEqual(f.res.chunks, [': keepalive\n\n']);
  t.mock.timers.tick(25);
  assert.deepEqual(f.res.chunks, [': keepalive\n\n', ': keepalive\n\n']);
  f.reply.resolve({ status: 200, body });
  await f.done;
  assert.equal(f.res.chunks.at(-1), `event: message\ndata: ${JSON.stringify(body)}\n\n`);
  assert.equal(f.res.jsonBody, undefined);
  assert.equal(f.res.writableEnded, true);
  t.mock.timers.tick(100);
  assert.equal(f.res.chunks.length, 3, 'Completion stops the heartbeat');
});

test('slow MCP replies without event-stream acceptance retain plain JSON', async (t) => {
  for (const accept of ['', 'application/json', '*/*']) {
    const f = pending(t, accept);
    t.mock.timers.tick(100);
    assert.equal(f.res.headersSent, false);
    assert.deepEqual(f.res.chunks, []);
    f.reply.resolve({ status: 201, body });
    await f.done;
    assert.equal(f.res.statusCode, 201);
    assert.deepEqual(f.res.jsonBody, body);
    assert.deepEqual(f.res.headers, {});
    t.mock.timers.reset();
  }
});

for (const closeAt of [0, 10]) {
  test(`MCP client close at ${closeAt} aborts the call and stops all writes`, async (t) => {
    const f = pending(t);
    t.mock.timers.tick(closeAt);
    assert.equal(f.signal.aborted, false);
    f.res.close();
    assert.equal(f.signal.aborted, true);
    const chunks = [...f.res.chunks];
    t.mock.timers.tick(100);
    f.reply.resolve({ status: 200, body });
    await f.done;
    assert.deepEqual(f.res.chunks, chunks);
    assert.equal(f.res.writableEnded, false);
  });
}

test('MCP call rejection propagates and stops stream timers', async (t) => {
  const f = pending(t);
  t.mock.timers.tick(10);
  const rejected = assert.rejects(f.done, /synthetic failure/);
  f.reply.reject(new Error('synthetic failure'));
  await rejected;
  const chunks = [...f.res.chunks];
  t.mock.timers.tick(100);
  assert.deepEqual(f.res.chunks, chunks);
});
