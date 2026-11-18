import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { McpConnection } from '../src/server/mcp-client.ts';
import type { McpExtension } from '../src/shared/extensions.ts';
import { listenForFetch } from './helpers/fetch-port.ts';

const base = {
  kind: 'mcp',
  id: 'cancellation-test',
  name: 'fixture',
  source: 'fixture',
  enabled: true,
  installedAt: '',
} as const;

test('SSE progress events have independent size budgets', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const message = JSON.parse(String(init?.body));
    if (message.id === undefined) return new Response(null, { status: 202 });
    if (message.method === 'initialize')
      return Response.json({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18' } });
    const encoder = new TextEncoder();
    const chunks = [
      ': progress\n\n',
      ': progress\n\n',
      ': progress\n\n',
      `data: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [] } })}\n\n`,
    ];
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(chunks.join('')));
          controller.close();
        },
      }),
      { headers: { 'content-type': 'text/event-stream', 'content-length': String(chunks.join('').length) } },
    );
  };
  const connection = new McpConnection(
    { ...base, transport: 'http', url: 'http://example.invalid' },
    { maxResponseBytes: 80 },
  );
  try {
    assert.deepEqual((await connection.callTool('progress', {})).content, []);
  } finally {
    await connection.close();
    globalThis.fetch = original;
  }
});

test('invalid UTF-8 in earlier SSE events cannot bypass the remaining event limit', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const message = JSON.parse(String(init?.body));
    if (message.id === undefined) return new Response(null, { status: 202 });
    if (message.method === 'initialize')
      return Response.json({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18' } });
    const events = Buffer.concat([
      ...Array.from({ length: 30 }, () => Buffer.from([255, 10, 10])),
      Buffer.alloc(140, 120),
    ]);
    return new Response(events, { headers: { 'content-type': 'text/event-stream' } });
  };
  const connection = new McpConnection(
    { ...base, transport: 'http', url: 'http://example.invalid' },
    { maxResponseBytes: 128, callTimeoutMs: 100 },
  );
  try {
    await assert.rejects(connection.callTool('invalid', {}), /内容过大/);
  } finally {
    await connection.close();
    globalThis.fetch = original;
  }
});

test('stdio cancellation is delivered to the server and the shared connection remains usable', async () => {
  const root = mkdtempSync(join(tmpdir(), 'comborunner-mcp-cancel-'));
  const script = join(root, 'server.cjs');
  writeFileSync(
    script,
    `
    const readline = require('node:readline');
    const pending = new Map(); let cancelled = 0, effects = 0;
    const reply = (id, result) => process.stdout.write(JSON.stringify({jsonrpc:'2.0', id, result})+'\\n');
    readline.createInterface({input:process.stdin}).on('line', line => {
      const m = JSON.parse(line);
      if (m.method === 'initialize') reply(m.id, {protocolVersion:'2025-06-18'});
      if (m.method === 'notifications/cancelled') {
        clearTimeout(pending.get(m.params.requestId)); pending.delete(m.params.requestId); cancelled++;
      }
      if (m.method === 'tools/call') {
        if (m.params.name === 'slow') {
          process.stdout.write(JSON.stringify({jsonrpc:'2.0', method:'started'})+'\\n');
          pending.set(m.id, setTimeout(() => { effects++; reply(m.id, {content:[]}); }, 500));
        } else reply(m.id, {content:[{type:'text', text:JSON.stringify({cancelled,effects})}]});
      }
    });
  `,
  );
  const connection = new McpConnection({ ...base, transport: 'stdio', command: process.execPath, args: [script] });
  try {
    await connection.start();
    const abort = new AbortController();
    const call = connection.callTool('slow', {}, abort.signal);
    const rejected = assert.rejects(call, /已取消/);
    // start() is already complete; the request is written in the next microtask, before this timer.
    await new Promise((done) => setTimeout(done, 40));
    abort.abort();
    await rejected;
    const result = await connection.callTool('stats', {});
    assert.deepEqual(JSON.parse(String(result.content[0]!.text)), { cancelled: 1, effects: 0 });
    await new Promise((done) => setTimeout(done, 550));
    const after = await connection.callTool('stats', {});
    assert.deepEqual(JSON.parse(String(after.content[0]!.text)), { cancelled: 1, effects: 0 });
  } finally {
    await connection.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('HTTP timeout sends cancellation and aborts the ongoing response stream', async () => {
  const messages: Array<Record<string, any>> = [];
  let responseClosed!: () => void, cancellationSeen!: () => void;
  const closed = new Promise<void>((done) => {
    responseClosed = done;
  });
  const cancelled = new Promise<void>((done) => {
    cancellationSeen = done;
  });
  const server = createServer(async (request, response) => {
    let text = '';
    for await (const chunk of request) text += chunk;
    const m = JSON.parse(text);
    messages.push(m);
    if (m.method === 'tools/call') {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(': waiting\n\n');
      response.once('close', responseClosed);
    } else if (m.id !== undefined) {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18' } }));
    } else {
      response.writeHead(202).end();
      if (m.method === 'notifications/cancelled') cancellationSeen();
    }
  });
  await listenForFetch(server);
  const address = server.address() as { port: number };
  const connection = new McpConnection(
    { ...base, transport: 'http', url: `http://127.0.0.1:${address.port}` },
    { callTimeoutMs: 150 },
  );
  try {
    await assert.rejects(connection.callTool('slow', {}), /没有回应/);
    await Promise.race([
      Promise.all([closed, cancelled]),
      new Promise((_, reject) => setTimeout(() => reject(new Error('remote cancellation missing')), 2000)),
    ]);
    const call = messages.find((m) => m.method === 'tools/call')!;
    const cancel = messages.find((m) => m.method === 'notifications/cancelled')!;
    assert.equal(cancel.params.requestId, call.id);
    assert.ok(!messages.some((m) => m.method === 'notifications/cancelled' && m.params.requestId === messages[0]!.id));
  } finally {
    await connection.close();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
});

test('an already cancelled tool call never starts a server', async () => {
  const connection = new McpConnection({
    ...base,
    transport: 'stdio',
    command: 'a-command-that-does-not-exist',
  } as McpExtension);
  const abort = new AbortController();
  abort.abort(new Error('fixture cancelled'));
  await assert.rejects(connection.callTool('slow', {}, abort.signal), /fixture cancelled/);
  await connection.close();
});

test('cancelling during shared initialization ends only this wait and never sends its tool call', async () => {
  let releaseInitialize!: () => void, initializeSeen!: () => void;
  const initialized = new Promise<void>((done) => {
    initializeSeen = done;
  });
  const calls: string[] = [];
  const server = createServer(async (request, response) => {
    let text = '';
    for await (const chunk of request) text += chunk;
    const m = JSON.parse(text);
    response.setHeader('content-type', 'application/json');
    const reply = (result: unknown) => response.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }));
    if (m.method === 'initialize') {
      releaseInitialize = () => reply({ protocolVersion: '2025-06-18' });
      initializeSeen();
    } else if (m.method === 'tools/call') {
      calls.push(m.params.name);
      reply({ content: [] });
    } else response.writeHead(202).end();
  });
  await listenForFetch(server);
  const address = server.address() as { port: number };
  const connection = new McpConnection({ ...base, transport: 'http', url: `http://127.0.0.1:${address.port}` });
  try {
    const abort = new AbortController();
    const abandoned = connection.callTool('abandoned', {}, abort.signal);
    const rejected = assert.rejects(abandoned, /fixture cancelled/);
    let scopeAllowed = true;
    const guarded = connection.callTool('revoked', {}, undefined, () => {
      if (!scopeAllowed) throw new Error('project scope revoked');
    });
    const scopeRejected = assert.rejects(guarded, /project scope revoked/);
    await initialized;
    abort.abort(new Error('fixture cancelled'));
    await Promise.race([
      rejected,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('still initializing')), 1000)),
    ]);
    assert.deepEqual(calls, []);
    scopeAllowed = false;
    releaseInitialize();
    await scopeRejected;
    await connection.callTool('kept', {});
    assert.deepEqual(calls, ['kept']);
  } finally {
    releaseInitialize?.();
    await connection.close();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
});

test(
  'an unacknowledged HTTP cancellation remains bounded while the local slot and connection are reusable',
  { timeout: 10_000 },
  async () => {
    let slowSeen!: () => void, cancellationSeen!: () => void, cancellationClosed!: () => void;
    const slow = new Promise<void>((done) => {
      slowSeen = done;
    });
    const cancelled = new Promise<void>((done) => {
      cancellationSeen = done;
    });
    const closed = new Promise<void>((done) => {
      cancellationClosed = done;
    });
    const server = createServer(async (request, response) => {
      let text = '';
      for await (const chunk of request) text += chunk;
      const message = JSON.parse(text);
      if (message.method === 'notifications/cancelled') {
        response.once('close', cancellationClosed);
        cancellationSeen();
        // This peer deliberately never acknowledges cancellation. Only the client's deadline closes it.
      } else if (message.method === 'tools/call' && message.params.name === 'slow') {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write(': waiting\n\n');
        slowSeen();
      } else if (message.id !== undefined) {
        response.setHeader('content-type', 'application/json');
        response.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result:
              message.method === 'initialize'
                ? { protocolVersion: '2025-06-18' }
                : { content: [{ type: 'text', text: 'ready' }] },
          }),
        );
      } else response.writeHead(202).end();
    });
    await listenForFetch(server);
    const connection = new McpConnection({
      ...base,
      transport: 'http',
      url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    });
    const bounded = async <T>(promise: Promise<T>, ms: number): Promise<T> => {
      let timer: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([
          promise,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('local cancellation exceeded its deadline')), ms);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    };
    try {
      const abort = new AbortController();
      const abandoned = connection.callTool('slow', {}, abort.signal);
      const rejection = assert.rejects(abandoned, /已取消/);
      await bounded(slow, 2000);
      abort.abort();
      await bounded(rejection, 1000);
      assert.equal((connection as unknown as { pending: Map<number, unknown> }).pending.size, 0);
      assert.equal((await bounded(connection.callTool('kept', {}), 1000)).content[0]!.text, 'ready');
      await bounded(cancelled, 1000);
      await bounded(closed, 4500);
      assert.equal((connection as unknown as { pending: Map<number, unknown> }).pending.size, 0);
    } finally {
      await connection.close();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    }
  },
);

test(
  'an uncooperative stdio peer cannot restore a cancelled pending request with a late reply',
  { timeout: 10_000 },
  async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'comborunner-mcp-late-')));
    const script = join(root, 'server.cjs'),
      log = join(root, 'calls.txt');
    writeFileSync(
      script,
      `
const readline = require('node:readline');
const { appendFileSync } = require('node:fs');
const log = ${JSON.stringify(log)};
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') reply(message.id, { protocolVersion: '2025-06-18' });
  if (message.method === 'notifications/cancelled') appendFileSync(log, 'cancelled\\n');
  if (message.method === 'tools/call') {
    if (message.params.name === 'slow') {
      appendFileSync(log, 'started\\n');
      setTimeout(() => { reply(message.id, { content: [{ type: 'text', text: 'late' }] }); appendFileSync(log, 'late-sent\\n'); }, 200);
    } else reply(message.id, { content: [{ type: 'text', text: message.params.name }] });
  }
});
`,
    );
    const connection = new McpConnection({ ...base, transport: 'stdio', command: process.execPath, args: [script] });
    const waitFor = async (text: string) => {
      const until = Date.now() + 2000;
      while (!existsSync(log) || !readFileSync(log, 'utf8').includes(text)) {
        assert.ok(Date.now() < until, `synthetic peer did not emit ${text}`);
        await new Promise((done) => setTimeout(done, 10));
      }
    };
    try {
      await connection.start();
      const abort = new AbortController();
      const abandoned = connection.callTool('slow', {}, abort.signal);
      const rejection = assert.rejects(abandoned, /已取消/);
      await waitFor('started');
      abort.abort();
      await rejection;
      assert.equal((connection as unknown as { pending: Map<number, unknown> }).pending.size, 0);
      assert.equal((await connection.callTool('kept', {})).content[0]!.text, 'kept');
      await waitFor('late-sent');
      await new Promise((done) => setTimeout(done, 20));
      assert.equal((connection as unknown as { pending: Map<number, unknown> }).pending.size, 0);
      assert.equal((await connection.callTool('after-late', {})).content[0]!.text, 'after-late');
      assert.match(readFileSync(log, 'utf8'), /cancelled/);
    } finally {
      await connection.close();
      const absolute = resolve(root);
      assert.ok(
        absolute.startsWith(realpathSync.native(tmpdir()) + sep) &&
          basename(absolute).startsWith('comborunner-mcp-late-'),
      );
      rmSync(absolute, { recursive: true, force: true });
    }
  },
);

test('oversized HTTP JSON, SSE, and newline-terminated stdio responses are rejected before parsing', async () => {
  const server = createServer(async (request, response) => {
    let text = '';
    for await (const chunk of request) text += chunk;
    const message = JSON.parse(text);
    if (message.method === 'initialize') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18' } }));
      return;
    }
    if (message.method !== 'tools/call') {
      response.writeHead(202).end();
      return;
    }
    const payload = 'x'.repeat(600);
    if (message.params.name === 'json-stream') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: payload }] } }),
      );
    } else if (message.params.name === 'json-header') {
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': '999999' });
      response.write('{}');
    } else if (message.params.name === 'sse') {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(
        `data: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: payload }] } })}\n\n`,
      );
      response.end();
    }
  });
  await listenForFetch(server);
  const port = (server.address() as { port: number }).port;
  const httpConn = new McpConnection(
    { ...base, transport: 'http', url: `http://127.0.0.1:${port}` },
    { maxResponseBytes: 256 },
  );
  const root = mkdtempSync(join(tmpdir(), 'comborunner-mcp-size-'));
  const script = join(root, 'stdio-oversized.cjs');
  writeFileSync(
    script,
    `
    const readline = require('node:readline');
    const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
    readline.createInterface({ input: process.stdin }).on('line', line => {
      const m = JSON.parse(line);
      if (m.method === 'initialize') reply(m.id, { protocolVersion: '2025-06-18' });
      if (m.method === 'tools/call') reply(m.id, { content: [{ type: 'text', text: 'y'.repeat(600) }] });
    });
  `,
  );
  const stdioConn = new McpConnection(
    { ...base, transport: 'stdio', command: process.execPath, args: [script] },
    { maxResponseBytes: 256 },
  );
  try {
    await assert.rejects(httpConn.callTool('json-header', {}), /内容过大/);
    await assert.rejects(httpConn.callTool('json-stream', {}), /内容过大/);
    await assert.rejects(httpConn.callTool('sse', {}), /内容过大/);
    await assert.rejects(stdioConn.callTool('big-line', {}), /内容过大/);
  } finally {
    await httpConn.close();
    await stdioConn.close();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    rmSync(root, { recursive: true, force: true });
  }
});
