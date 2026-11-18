import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import express from 'express';
import type { Response } from 'express';
import { localApiGuard, ownerApiGuard } from '../src/server/local-api-guard.ts';
import { sendStateResponse, timeStateRequest } from '../src/server/state-response.ts';
import { listenForFetch } from './helpers/fetch-port.ts';
import type { AppState } from '../src/shared/types.ts';

test('slow HTTP diagnostics separate build, JSON, synchronous send and flush without logging state', (t) => {
  let now = 10;
  t.mock.method(performance, 'now', () => now);
  const warnings = t.mock.method(console, 'warn', () => {});
  const headers = new Map();
  const res = Object.assign(new EventEmitter(), {
    locals: { stateRequestStarted: 0 },
    setHeader: (key: string, value: string) => headers.set(key, value),
    getHeader: () => 42,
    type() {
      return this;
    },
    send(body: string) {
      assert.equal(body, 'synthetic-private-state');
      now = 100;
    },
  });
  sendStateResponse(
    res as unknown as Response,
    {
      recentState: () => {
        now = 60;
        return {} as AppState;
      },
      recentStateJson: () => {
        now = 80;
        return 'synthetic-private-state';
      },
    },
    () => {
      now = 30;
    },
  );
  now = 1100;
  res.emit('finish');
  assert.equal(warnings.mock.callCount(), 1);
  assert.deepEqual(JSON.parse(warnings.mock.calls[0]!.arguments[0].slice('[slow-state-http] '.length)), {
    middleware: 10,
    folders: 20,
    state: 30,
    json: 20,
    send: 20,
    flush: 1000,
    total: 1100,
    bytes: 42,
  });
});

test('8.3 MB state: measure serialization, guarded Express send and full client read', async (t) => {
  const state = { runs: Array.from({ length: 3000 }, (_, id) => ({ id, output: 'synthetic中'.repeat(230) })) };
  let start = performance.now();
  const json = JSON.stringify(state);
  const stringifyMs = performance.now() - start;
  const bytes = Buffer.byteLength(json);
  assert.ok(bytes > 8_300_000);
  const app = express();
  const hosts = new Set<string>();
  app.use(timeStateRequest);
  app.use(localApiGuard('synthetic', hosts, new Set()));
  app.use(ownerApiGuard('synthetic-owner'));
  app.use(express.json({ limit: '256kb' }));
  let refreshes = 0;
  let sendMs = 0;
  app.get('/api/state', (_req, res) => {
    start = performance.now();
    sendStateResponse(
      res,
      {
        recentState: () => state as unknown as AppState,
        recentStateJson: () => json,
      },
      () => {
        refreshes++;
      },
    );
    sendMs = performance.now() - start;
  });
  app.get('/api/legacy', (_req, res) => {
    start = performance.now();
    res.json(state);
    sendMs = performance.now() - start;
  });
  const server = await listenForFetch(app);
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const host = `127.0.0.1:${address.port}`;
  hosts.add(host);
  for (const path of ['/api/legacy', '/api/state', '/api/state']) {
    const requestAt = performance.now();
    const response = await fetch(`http://${host}${path}`, { headers: { 'x-agent-token': 'synthetic' } });
    const headersMs = performance.now() - requestAt;
    const body = await response.text();
    const readMs = performance.now() - requestAt;
    assert.equal(response.status, 200);
    assert.equal(body, json);
    assert.equal(Number(response.headers.get('content-length')), bytes);
    if (path === '/api/state')
      assert.match(response.headers.get('server-timing')!, /middleware;dur=.*state;dur=.*json;dur=/);
    assert.ok(readMs < 3000, `8.3 MB HTTP read took ${readMs} ms`);
    t.diagnostic(
      JSON.stringify({
        path,
        bytes,
        stringifyMs,
        sendMs,
        headersMs,
        readMs,
        phases: response.headers.get('server-timing'),
      }),
    );
  }
  assert.equal(refreshes, 2);
});
