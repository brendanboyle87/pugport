import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type { AddressInfo } from 'node:net';
import express, { type ErrorRequestHandler } from 'express';
import { ConnectorService } from '../src/server/connectors.ts';
import { connectorRoutes } from '../src/server/connector-routes.ts';
import type { Workspace } from '../src/server/workspace.ts';
import { listenForFetch } from './helpers/fetch-port.ts';

const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'pugport-connector-routes-'));
  const service = new ConnectorService({
    file: join(dir, 'private.json'),
    fetch: (async (url) => {
      if (String(url).endsWith('/token'))
        return json({
          access_token: 'SYNTHETIC_ACCESS',
          refresh_token: 'SYNTHETIC_REFRESH',
          token_type: 'Bearer',
          expires_in: 3600,
          scope: 'https://www.googleapis.com/auth/gmail.readonly',
        });
      return json({ sub: 'synthetic-user', email: 'test@example.com', name: 'Test' });
    }) as typeof fetch,
  });
  const selections: { id: string; ids: string[] }[] = [];
  const workspace = {
    setConversationConnectors: (id: string, ids: string[]) => {
      selections.push({ id, ids });
      return { id, connectorIds: ids };
    },
  } as unknown as Workspace;
  const app = express();
  app.use(express.json());
  connectorRoutes(app, service, workspace);
  app.use(((_err, _req, res, _next) => res.status(400).json({ error: 'Invalid request' })) as ErrorRequestHandler);
  const server = await listenForFetch(app);
  t.after(async () => {
    await new Promise<void>((resolveClose, reject) =>
      server.close((error) => (error ? reject(error) : resolveClose())),
    );
    assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep));
    assert.match(dir, /pugport-connector-routes-/);
    await rm(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = (path: string, method = 'GET', body?: unknown) =>
    fetch(base + path, {
      method,
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
  const configure = async () => {
    assert.equal(
      (
        await request('/api/connectors/providers/google', 'PUT', {
          clientId: 'synthetic-client',
          clientSecret: 'SYNTHETIC_SECRET',
        })
      ).status,
      200,
    );
  };
  const connect = async () => {
    const start = (await (
      await request('/api/connectors/connect', 'POST', {
        provider: 'google',
        alias: '学校邮箱',
        capabilities: ['mail_read'],
      })
    ).json()) as { authorizationUrl: string };
    const state = new URL(start.authorizationUrl).searchParams.get('state')!;
    return request(`/api/connectors/oauth/callback?state=${encodeURIComponent(state)}&code=SYNTHETIC_CODE`);
  };
  return { service, selections, request, configure, connect };
}

test('connector routes expose only public fields before and after OAuth callback', async (t) => {
  const f = await fixture(t);
  await f.configure();
  const before = (await (await f.request('/api/connectors')).json()) as any;
  assert.deepEqual(before.accounts, []);
  assert.equal(before.providers[0].hasClientSecret, true);
  assert.ok(before.redirectUri.includes('/api/connectors/oauth/callback'));
  assert.ok(!JSON.stringify(before).includes('SYNTHETIC_SECRET'));
  const callback = await f.connect();
  assert.equal(callback.status, 200);
  const html = await callback.text();
  assert.match(html, /账号已连接/);
  assert.ok(!html.includes('SYNTHETIC'));
  assert.ok(!html.includes('<script'));
  assert.match(callback.headers.get('content-security-policy')!, /default-src 'none'/);
  const after = (await (await f.request('/api/connectors')).json()) as any;
  assert.equal(after.accounts.length, 1);
  assert.equal(after.accounts[0].alias, '学校邮箱');
  assert.ok(!JSON.stringify(after).includes('SYNTHETIC'));
});

test('OAuth callback errors never echo provider strings, codes, HTML, or exception messages', async (t) => {
  const f = await fixture(t);
  await f.configure();
  for (const query of [
    'state=unknown&code=SECRET_CODE',
    'state=x&error=%3Cscript%3Ealert(1)%3C/script%3E',
    'code=NO_STATE_SECRET',
  ]) {
    const response = await f.request('/api/connectors/oauth/callback?' + query);
    assert.equal(response.status, 400);
    const html = await response.text();
    assert.match(html, /授权未完成/);
    assert.ok(!html.includes('SECRET'));
    assert.ok(!html.includes('alert(1)'));
    assert.ok(!html.includes('<script'));
  }
});

test('conversation connector route accepts only connected enabled IDs and supports clearing selection', async (t) => {
  const f = await fixture(t);
  await f.configure();
  await f.connect();
  const account = (await f.service.list())[0];
  const selected = await f.request('/api/conversations/conversation/connectors', 'PATCH', {
    connectorIds: [account.id],
  });
  assert.equal(selected.status, 200);
  assert.deepEqual(f.selections[0], { id: 'conversation', ids: [account.id] });
  await f.service.update(account.id, { enabled: false });
  assert.equal(
    (await f.request('/api/conversations/conversation/connectors', 'PATCH', { connectorIds: [account.id] })).status,
    400,
  );
  assert.equal(f.selections.length, 1);
  assert.equal(
    (await f.request('/api/conversations/conversation/connectors', 'PATCH', { connectorIds: [] })).status,
    200,
  );
  assert.deepEqual(f.selections[1].ids, []);
  assert.equal(
    (await f.request('/api/conversations/conversation/connectors', 'PATCH', { connectorIds: ['invalid'] })).status,
    400,
  );
});

test('rename and local disconnect routes preserve public API boundary', async (t) => {
  const f = await fixture(t);
  await f.configure();
  await f.connect();
  const account = (await f.service.list())[0];
  const renamed = await f.request('/api/connectors/' + account.id, 'PATCH', { alias: '研究邮箱', enabled: true });
  const data = (await renamed.json()) as any;
  assert.equal(data.alias, '研究邮箱');
  assert.ok(!JSON.stringify(data).includes('SYNTHETIC'));
  assert.equal((await f.request('/api/connectors/' + account.id, 'PATCH', { accessToken: 'injected' })).status, 400);
  assert.equal((await f.request('/api/connectors/' + account.id, 'DELETE')).status, 200);
  assert.deepEqual(await f.service.list(), []);
});
