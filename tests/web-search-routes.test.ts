import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { webSearchRoutes } from '../src/server/web-search-routes.ts';
import type { WebSearchService } from '../src/server/web-search.ts';
import { listenForFetch } from './helpers/fetch-port.ts';

test('search connection HTTP accepts zero budget, keeps auth and parser errors private, and never searches on save', async (t) => {
  const writes: unknown[] = [];
  const view = {
    provider: 'deepseek',
    enabled: false,
    configured: false,
    monthlyLimitCny: 5,
    month: '2026-10',
    usage: { requests: 0, billableRequests: 0, uncertainRequests: 0, estimatedCostCny: 0, reservedCny: 0 },
  };
  const service = {
    view: () => view,
    update: async (input: object) => {
      writes.push(input);
      return view;
    },
    search: () => {
      throw new Error('Settings must not search');
    },
  } as unknown as WebSearchService;
  const app = express();
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.headers['x-agent-token'] !== 'fixture') {
      res.sendStatus(403);
      return;
    }
    next();
  });
  webSearchRoutes(app, service);
  const server = await listenForFetch(app);
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/api/web-search`;
  const request = (body: string, token = 'fixture') =>
    fetch(url, { method: 'PUT', headers: { 'content-type': 'application/json', 'x-agent-token': token }, body });
  assert.equal((await request('{}', 'wrong')).status, 403);
  assert.equal((await request('{"monthlyLimitCny":0}')).status, 200);
  assert.deepEqual(writes, [{ monthlyLimitCny: 0 }]);
  const secret = 'SYNTHETIC_SEARCH_KEY_SENTINEL';
  for (const body of [
    `{"key":"${secret}"`,
    JSON.stringify({ key: secret, enabled: 'bad' }),
    JSON.stringify({ key: secret.repeat(1000) }),
  ]) {
    const response = await request(body);
    assert.ok([400, 413].includes(response.status));
    assert.ok(!(await response.text()).includes(secret));
  }
  assert.equal(writes.length, 1);
  assert.deepEqual(await (await fetch(url)).json(), view);
});
