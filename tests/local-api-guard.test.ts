import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import { localApiGuard, reportSessionFileProblem } from '../src/server/local-api-guard.ts';
import { listenForFetch } from './helpers/fetch-port.ts';

test('API reads require the session token', async (t) => {
  const app = express();
  const hosts = new Set<string>();
  app.use(localApiGuard('synthetic-token', hosts, new Set()));
  app.use((_req, res) => res.json({ ok: true }));
  const server = await listenForFetch(app);
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const port = (server.address() as { port: number }).port;
  hosts.add(`127.0.0.1:${port}`);
  const base = `http://127.0.0.1:${port}`;
  for (const path of [
    '/api/state',
    '/api/events',
    '/api/external/conversations',
    '/api/external/tasks',
    '/api/session',
    '/API/STATE',
  ]) {
    assert.equal((await fetch(base + path)).status, 403, path);
    assert.equal((await fetch(base + path, { headers: { 'x-agent-token': 'synthetic-token' } })).status, 200, path);
  }
  const headers = { 'x-agent-token': 'synthetic-token' };
  assert.equal((await fetch(base + '/api/state', { method: 'HEAD' })).status, 403);
  assert.equal((await fetch(base + '/api/state', { method: 'HEAD', headers })).status, 200);
  assert.equal((await fetch(base + '/API/STATE', { headers })).headers.get('cache-control'), 'no-store');
  assert.equal((await fetch(base + '/api/state', { headers: { 'x-agent-token': 'wrong' } })).status, 403);
  // The token's length in characters but not in bytes.
  assert.equal((await fetch(base + '/api/state', { headers: { 'x-agent-token': 'synthetic-tokeé' } })).status, 403);
  for (const path of ['/api/health', '/api/connectors/oauth/callback?state=x&code=y', '/', '/assets/x.js'])
    assert.equal((await fetch(base + path)).status, 200);
  assert.equal((await fetch(base + '/api/health', { method: 'HEAD' })).status, 200);
  assert.equal((await fetch(base + '/api/anything', { method: 'POST' })).status, 403);
  for (const path of ['/mcp', '/api/external/grok-bot/replies'])
    assert.equal(
      (await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }))
        .status,
      200,
    );
  const error = async () => ((await (await fetch(base + '/api/state')).json()) as { error: string }).error;
  assert.match(await error(), /session token.*update/i);
  reportSessionFileProblem('C:/x/session-1.json: EPERM');
  try {
    assert.match(await error(), /session file.*EPERM/);
  } finally {
    reportSessionFileProblem(undefined);
  }
  assert.match(await error(), /session token.*update/i);
});
