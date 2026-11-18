import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { ZodError } from 'zod';
import { Inbox } from '../src/server/inbox.ts';
import { inboxRoutes } from '../src/server/inbox-routes.ts';
import type { InboxNotice } from '../src/shared/inbox.ts';
import { listenForFetch } from './helpers/fetch-port.ts';

async function fixture(t: TestContext) {
  const db = new DatabaseSync(':memory:');
  const inbox = new Inbox(db);
  const app = express();
  app.use(express.json());
  inboxRoutes(app, inbox);
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res
      .status(error instanceof ZodError || error instanceof SyntaxError ? 400 : 500)
      .json({ error: 'Invalid request' });
  });
  const server = await listenForFetch(app);
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    db.close();
  });
  const address = server.address() as { port: number };
  const request = (path = '', body?: unknown) =>
    fetch(
      `http://127.0.0.1:${address.port}/api/inbox${path}`,
      body === undefined
        ? undefined
        : {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          },
    );
  const raise = (key = 'synthetic') =>
    inbox.raise({ kind: 'executor-login', key, severity: 'action', title: 'Synthetic sign-in' });
  return { inbox, request, raise };
}

test('inbox HTTP lists open rows, supports bounded history and applies read and dismiss operations', async (t) => {
  const { inbox, request, raise } = await fixture(t);
  assert.deepEqual(await (await request()).json(), []);
  const first = raise();
  const second = raise('other');
  const list = await request();
  assert.equal(list.status, 200);
  assert.equal(((await list.json()) as InboxNotice[]).length, 2);
  assert.equal((await request('/read', { ids: [first.id] })).status, 200);
  assert.equal(inbox.summary().unread, 1);
  assert.equal((await request(`/${second.id}/dismiss`, {})).status, 200);
  assert.equal(inbox.summary().unread, 0);
  assert.equal(((await (await request()).json()) as InboxNotice[]).length, 1);
  assert.equal(((await (await request('?all=1')).json()) as InboxNotice[]).length, 2);
  assert.equal(((await (await request('?all=1&limit=1')).json()) as InboxNotice[]).length, 1);
  assert.equal((await request(`/${second.id}/dismiss`, {})).status, 200);
  assert.equal((await request(`/${randomUUID()}/dismiss`, {})).status, 404);
});

test('inbox HTTP rejects malformed bodies, IDs and unknown properties without mutating state', async (t) => {
  const { inbox, request, raise } = await fixture(t);
  const notice = raise();
  const before = inbox.list({ all: true });
  for (const body of [
    null,
    [],
    'all',
    { ids: 'all' },
    { ids: ['not-a-uuid'] },
    { ids: Array(201).fill(notice.id) },
    { ids: [], all: true },
  ]) {
    assert.equal((await request('/read', body)).status, 400, JSON.stringify(body));
    assert.deepEqual(inbox.list({ all: true }), before);
  }
  for (const body of [null, [], { dismiss: true }, { id: notice.id }]) {
    assert.equal((await request(`/${notice.id}/dismiss`, body)).status, 400);
    assert.deepEqual(inbox.list({ all: true }), before);
  }
  assert.equal((await request('/not-a-uuid/dismiss', {})).status, 400);
  assert.deepEqual(inbox.list({ all: true }), before);
  assert.equal((await request('/read', {})).status, 200);
  assert.equal(inbox.summary().unread, 0);
});

test('inbox HTTP validates list query limits and resolves info when the panel marks it read', async (t) => {
  const { inbox, request } = await fixture(t);
  for (const query of [
    '?all=true',
    '?all=1&all=0',
    '?limit=0',
    '?limit=201',
    '?limit=1.5',
    '?limit=oops',
    '?extra=true',
  ])
    assert.equal((await request(query)).status, 400, query);
  const info = inbox.raise({ kind: 'executor-failing', key: 'synthetic', severity: 'info', title: 'Synthetic update' });
  assert.equal((await request('/read', {})).status, 200);
  assert.deepEqual(await (await request()).json(), []);
  const history = (await (await request('?all=1')).json()) as InboxNotice[];
  assert.equal(history[0].id, info.id);
  assert.ok(history[0].readAt);
  assert.ok(history[0].resolvedAt);
});
