import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BackendSession } from '../src/ui/backend-session.ts';

test('a late session response from the old backend cannot overwrite the recovered token', () => {
  const session = new BackendSession();
  const oldGeneration = session.generation;
  assert.equal(session.accept(oldGeneration, 'old-synthetic-token'), true);
  const freshGeneration = session.clear();
  assert.equal(session.token, '');
  assert.equal(session.accept(freshGeneration, 'new-synthetic-token'), true);
  assert.equal(session.accept(oldGeneration, 'old-synthetic-token'), false);
  assert.equal(session.token, 'new-synthetic-token');
});

test('multiple disconnects invalidate all older pending replies and malformed tokens', () => {
  const session = new BackendSession();
  const initial = session.generation;
  const firstRecovery = session.clear();
  const secondRecovery = session.clear();
  assert.equal(session.accept(initial, 'initial'), false);
  assert.equal(session.accept(firstRecovery, 'first'), false);
  for (const token of [undefined, null, '', 123]) assert.equal(session.accept(secondRecovery, token), false);
  assert.equal(session.token, '');
  assert.equal(session.accept(secondRecovery, 'current-synthetic-token'), true);
});

const json = (value: unknown, status = 200) => Response.json(value, { status });
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test('expired sessions refresh once and preserve method, binary body and other headers', async () => {
  const session = new BackendSession();
  session.accept(0, 'old');
  const body = new Uint8Array([1, 2, 3]);
  let refreshes = 0;
  const tokens: string[] = [];
  const fetcher: typeof fetch = async (path, init) => {
    if (path === '/api/session') {
      refreshes++;
      return json({ token: 'new' });
    }
    assert.equal(init?.method, 'POST');
    assert.equal(init?.body, body);
    assert.equal(new Headers(init?.headers).get('x-test'), 'kept');
    const token = new Headers(init?.headers).get('x-agent-token')!;
    tokens.push(token);
    return token === 'old' ? json({ error: 'expired' }, 403) : json({ ok: true });
  };
  assert.equal(
    (await session.request('/upload', { method: 'POST', body, headers: { 'x-test': 'kept' } }, fetcher)).status,
    200,
  );
  assert.equal(refreshes, 1);
  assert.deepEqual(tokens, ['old', 'new']);
});

test('concurrent expired responses share refresh and late old responses keep the new token', async () => {
  const session = new BackendSession();
  session.accept(0, 'old');
  let finishRefresh!: (value: Response) => void;
  let finishLate!: (value: Response) => void;
  let refreshes = 0;
  const fetcher: typeof fetch = async (path, init) => {
    if (path === '/api/session') {
      refreshes++;
      return new Promise((resolve) => {
        finishRefresh = resolve;
      });
    }
    if (new Headers(init?.headers).get('x-agent-token') === 'new') return json({ ok: true });
    if (path === '/late')
      return new Promise((resolve) => {
        finishLate = resolve;
      });
    return json({}, 401);
  };
  const late = session.request('/late', {}, fetcher);
  const first = session.request('/first', {}, fetcher);
  const second = session.request('/second', {}, fetcher);
  await tick();
  assert.equal(refreshes, 1);
  finishRefresh(json({ token: 'new' }));
  await Promise.all([first, second]);
  finishLate(json({}, 403));
  await late;
  assert.equal(refreshes, 1);
  assert.equal(session.token, 'new');
});

test('only one retry is allowed and ordinary errors are not replayed', async () => {
  for (const status of [401, 403, 500]) {
    const session = new BackendSession();
    session.accept(0, 'old');
    let calls = 0;
    let refreshes = 0;
    const response = await session.request('/write', { method: 'POST' }, async (path) => {
      if (path === '/api/session') {
        refreshes++;
        return json({ token: 'new' });
      }
      calls++;
      return json({}, status);
    });
    assert.equal(response.status, status);
    assert.equal(calls, status === 500 ? 1 : 2);
    assert.equal(refreshes, status === 500 ? 0 : 1);
  }
});

test('one cancelled caller does not cancel shared session recovery', async () => {
  const session = new BackendSession();
  const abort = new AbortController();
  let finish!: (value: Response) => void;
  let writes = 0;
  const fetcher: typeof fetch = async (path, init) => {
    if (path === '/api/session') {
      assert.equal(init?.signal, undefined);
      return new Promise((resolve) => {
        finish = resolve;
      });
    }
    writes++;
    return json({ ok: true });
  };
  const cancelled = session.request('/cancelled', { signal: abort.signal }, fetcher);
  const other = session.request('/other', {}, fetcher);
  abort.abort();
  await assert.rejects(cancelled, { name: 'AbortError' });
  finish(json({ token: 'new' }));
  await other;
  assert.equal(writes, 1);
});

test('a pending refresh cannot restore the session cleared by SSE reconnect', async () => {
  const session = new BackendSession();
  let finish!: (value: Response) => void;
  const pending = session.ensure(
    async () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const generation = session.clear();
  session.accept(generation, 'sse-new');
  finish(json({ token: 'old' }));
  await assert.rejects(pending);
  assert.equal(session.token, 'sse-new');
});

test('explicit session errors recover but network errors are never replayed', async () => {
  const session = new BackendSession();
  session.accept(0, 'old');
  let calls = 0;
  await session.request('/test', {}, async (path) => {
    if (path === '/api/session') return json({ token: 'new' });
    return ++calls === 1 ? json({ code: 'SESSION_EXPIRED' }, 409) : json({ ok: true });
  });
  assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(
    session.request('/test', {}, async () => {
      calls++;
      throw new Error('offline');
    }),
  );
  assert.equal(calls, 1);
});
