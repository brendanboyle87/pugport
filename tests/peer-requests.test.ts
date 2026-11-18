import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { externalTaskRunner } from '../src/server/node/peer-tasks.ts';
import * as protocol from '../src/server/node/peer-protocol.ts';
import { peerApp, type PeerApiOptions } from '../src/server/node/peer-routes.ts';
import { PeerRegistry } from '../src/server/node/peer-auth.ts';
import { WorkspaceStore } from '../src/server/workspace-store.ts';
import type { ExternalTasks } from '../src/server/external-tasks.ts';
import { temporaryFolder } from './helpers/fake-peer.ts';
import { listenForFetch } from './helpers/fetch-port.ts';

const day = 86400_000;
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const input = (requestId: string) => ({
  requestId,
  task: 'Synthetic',
  caller: 'Synthetic',
  write: false,
  untrusted: false,
});
function fixture(t: TestContext, cap = 3) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const store = new WorkspaceStore(db, { recoverInterrupted: false });
  let now = Date.now();
  const states = new Map<string, string>();
  let created = 0;
  const tasks = {
    dispatch: async () => {
      const taskId = `task-${++created}`;
      states.set(taskId, 'running');
      return { taskId, status: 'running' };
    },
    status: (taskId: string) => (states.has(taskId) ? { taskId, status: states.get(taskId)! } : undefined),
    cancel: (taskId: string) => {
      states.set(taskId, 'cancelled');
      return true;
    },
  } as unknown as ExternalTasks;
  const runner = () => externalTaskRunner(tasks, store, undefined, { now: () => now, maxRequestsPerPeer: cap });
  return {
    db,
    store,
    states,
    tasks,
    runner,
    advance: (ms: number) => {
      now += ms;
    },
    count: () => created,
  };
}
async function http(
  t: TestContext,
  runner: ReturnType<typeof externalTaskRunner>,
  extra: Partial<PeerApiOptions> = {},
) {
  const registry = new PeerRegistry(join(temporaryFolder(t, 'peer-requests-'), 'peers.json'));
  await registry.load();
  const tokens: string[] = [];
  const peers: string[] = [];
  for (const name of ['Synthetic A', 'Synthetic B']) {
    const paired = await registry.pair(registry.createCode().code, name);
    assert.equal(typeof paired, 'object');
    if (typeof paired === 'object') {
      tokens.push(paired.token);
      peers.push(paired.peer.id);
    }
  }
  const app = peerApp({
    registry,
    runner,
    info: () => ({}) as never,
    runtimes: () => ({ executors: [], running: 0 }),
    projectFolder: (path) => path,
    ...extra,
  });
  const server = await listenForFetch(app);
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (path: string, method = 'GET', body?: unknown, token: string | undefined = tokens[0]) =>
    fetch(url + '/peer/v1/' + path, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body, (key, value) => (key === 'caller' ? undefined : value)) } : {}),
    });
  return { call, tokens, peers };
}

test('round5 cancel before a late original POST persists across runner restart', async (t) => {
  const f = fixture(t);
  const h = await http(t, f.runner());
  const cancel = await h.call('requests/r1/cancel', 'POST');
  assert.equal(cancel.status, 200);
  assert.deepEqual(await cancel.json(), { taskId: null });
  const late = await h.call('tasks', 'POST', input('r1'));
  assert.equal(late.status, 409, 'a confirmed cancellation must refuse the late POST');
  await assert.rejects(f.runner().dispatch(input('r1'), h.peers[0]!), /取消/);
  assert.equal(f.count(), 0, 'no task created or started');
});

test('round5 cancel wins while the original POST is awaiting folder creation', async (t) => {
  const f = fixture(t);
  const entered = gate();
  const release = gate();
  t.after(() => release.resolve());
  const h = await http(t, f.runner());
  const mkdir = t.mock.method(fs, 'mkdir', async () => {
    entered.resolve();
    await release.promise;
  });
  syncBuiltinESMExports();
  t.after(() => {
    mkdir.mock.restore();
    syncBuiltinESMExports();
  });
  const original = h.call('tasks', 'POST', { task: 'Synthetic write', write: true, requestId: 'paused' });
  await Promise.race([
    entered.promise,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('folder pause was not reached')), 1000);
      timer.unref();
    }),
  ]);
  assert.deepEqual(await (await h.call('requests/paused/cancel', 'POST')).json(), { taskId: null });
  release.resolve();
  assert.equal((await original).status, 409);
  assert.equal(f.count(), 0, 'no task created or started after folder await');
});

for (const destination of ['node', 'desktop'] as const) {
  test(`round5 cancel during desktop probe prevents ${destination} dispatch`, async (t) => {
    const f = fixture(t);
    const entered = gate();
    const release = gate();
    t.after(() => release.resolve());
    let forwarded = 0;
    const runner = externalTaskRunner(f.tasks, f.store, {
      tray: async () => [],
      probe: async () => {
        entered.resolve();
        await release.promise;
        return destination === 'desktop' ? 'device' : undefined;
      },
      dispatch: async () => {
        forwarded++;
        return { taskId: 'desktop-task', status: 'queued' };
      },
      status: async () => undefined,
      result: async () => undefined,
      cancel: async () => true,
    });
    const dispatch = runner.dispatch(input('r1'), 'peer');
    const outcome = dispatch.then(
      () => 'started',
      () => 'refused',
    );
    await entered.promise;
    const cancel = runner.cancelRequest('r1', 'peer');
    release.resolve();
    assert.equal(await cancel, undefined);
    assert.equal(await outcome, 'refused');
    assert.equal(forwarded + f.count(), 0);
  });
}

test('round5 retry window is shorter than retention', () => {
  assert.ok(
    protocol.peerRequestRetryMs < protocol.peerRequestKeepMs,
    'sender retry window must be shorter than node retention',
  );
});

test('round5 retention preserves window dedupe, prunes only settled old records and admits old ids after expiry', async (t) => {
  const f = fixture(t, 2);
  const runner = f.runner();
  const first = await runner.dispatch(input('old'), 'peer');
  f.states.set(first.taskId, 'completed');
  f.advance(6 * day);
  assert.deepEqual(await f.runner().dispatch(input('old'), 'peer'), first);
  await runner.dispatch(input('live'), 'peer');
  await assert.rejects(runner.dispatch(input('new'), 'peer'), /请求记录.*上限/);
  f.advance(2 * day);
  const second = await f.runner().dispatch(input('old'), 'peer');
  assert.notEqual(second.taskId, first.taskId);
  assert.equal(f.count(), 3);
  f.advance(8 * day);
  await assert.rejects(f.runner().dispatch(input('new'), 'peer'), /请求记录.*上限/);
  assert.equal(await runner.lookup('live', 'peer'), 'task-2', 'old live records must never be evicted');
});

test('round7 tombstones have a separate budget and expire only after retention', async (t) => {
  const f = fixture(t, 1);
  const h = await http(t, f.runner());
  assert.equal((await h.call('requests/cancelled/cancel', 'POST')).status, 200);
  assert.equal((await h.call('tasks', 'POST', input('new'))).status, 201, 'tombstones have their own budget');
  f.states.set('task-1', 'completed');
  assert.equal(
    (await h.call('requests/other/cancel', 'POST')).status,
    200,
    'a full cap must still store cancellation tombstones',
  );
  f.advance(6 * day);
  await assert.rejects(f.runner().dispatch(input('cancelled'), h.peers[0]!), /取消/);
  f.advance(2 * day);
  await f.runner().dispatch(input('cancelled'), h.peers[0]!);
  assert.equal(f.count(), 2);
});

test('round7 unseen cancels are bounded across restart, while admitted ids and other peers still cancel', async (t) => {
  const f = fixture(t, 2);
  const runner = f.runner();
  const h = await http(t, runner);
  const admitted = await runner.dispatch(input('admitted'), h.peers[0]!);
  for (let i = 0; i < 1000; i++) assert.equal(await runner.cancelRequest(`unseen-${i}`, h.peers[0]!), undefined);
  const count = () => Number(f.db.prepare('SELECT count(*) AS n FROM workspace_records').get()!.n);
  const full = count();
  for (let i = 0; i < 3; i++) {
    const reply = await h.call(`requests/overflow-${i}/cancel`, 'POST');
    assert.equal(reply.status, 409, 'a full unseen-id budget cannot confirm cancellation');
    assert.equal((await reply.json()).code, 'PEER_CANCEL_UNCONFIRMED');
    assert.equal(count(), full, 'refused cancels must not grow storage');
  }
  await assert.rejects(f.runner().cancelRequest('after-restart', h.peers[0]!), /未确认/);
  assert.equal(await runner.cancelRequest('unseen-0', h.peers[0]!), undefined, 'duplicate does not need a slot');
  assert.deepEqual(await (await h.call('requests/admitted/cancel', 'POST')).json(), { taskId: admitted.taskId });
  assert.equal(f.states.get(admitted.taskId), 'cancelled');
  assert.equal((await h.call('requests/overflow-0/cancel', 'POST', undefined, h.tokens[1])).status, 200);
  f.advance(protocol.peerRequestKeepMs);
  await assert.rejects(f.runner().cancelRequest('still-full', h.peers[0]!), /未确认/);
  await assert.rejects(runner.dispatch(input('unseen-1'), h.peers[0]!), /取消/);
  f.advance(1);
  assert.equal(await f.runner().cancelRequest('after-window', h.peers[0]!), undefined);
  assert.ok(count() < full, 'expired tombstones are reclaimed');
  await f.runner().dispatch(input('unseen-1'), h.peers[0]!);
});

test('round7 cancel and lookup use indexed queries without visiting unrelated records', async (t) => {
  const f = fixture(t);
  const runner = f.runner();
  const admitted = await runner.dispatch(input('admitted'), 'peer');
  for (let i = 0; i < 20_000; i++)
    f.store.save('peer-request', `peer:other-${i}`, 'peer', { status: 'dispatching', recordedAt: 0 });
  const scanned = t.mock.method(f.store, 'entries');
  const reads = t.mock.method(f.store, 'get');
  const statuses = t.mock.method(f.tasks, 'status');
  const queries = t.mock.method(f.db, 'prepare');
  assert.equal(await runner.lookup('admitted', 'peer'), admitted.taskId);
  assert.equal(await runner.cancelRequest('admitted', 'peer'), admitted.taskId);
  assert.equal(await runner.cancelRequest('unseen', 'peer'), undefined);
  assert.equal(await runner.lookup('absent', 'peer'), undefined);
  assert.equal(scanned.mock.callCount(), 0, 'cancel/lookup must not enumerate request records');
  assert.equal(statuses.mock.callCount(), 0, 'cancel/lookup must not inspect unrelated task statuses');
  assert.ok(reads.mock.calls.every(({ arguments: args }) => !String(args[1]).includes('other-')));
  assert.ok(queries.mock.callCount() <= 20, 'query count must not grow with the number of records');
  const sql = queries.mock.calls.map(({ arguments: args }) => String(args[0]));
  queries.mock.restore();
  for (const query of sql.filter((q) => /^(SELECT|DELETE)/.test(q))) {
    const plan = f.db.prepare(`EXPLAIN QUERY PLAN ${query}`).all(...Array(query.split('?').length - 1).fill(0));
    assert.ok(
      plan.every((row) => !/SCAN workspace_records/.test(String(row.detail))),
      query,
    );
  }
});

test('round6 a capacity-refused id can be cancelled and its late POST stays refused after restart', async (t) => {
  const f = fixture(t, 1);
  const h = await http(t, f.runner());
  assert.equal((await h.call('tasks', 'POST', input('live'))).status, 201);
  assert.equal((await h.call('tasks', 'POST', input('late'))).status, 409);
  assert.deepEqual(await (await h.call('requests/late')).json(), { taskId: null });
  assert.equal((await h.call('requests/late/cancel', 'POST')).status, 200);
  f.states.set('task-1', 'completed');
  f.advance(6 * day);
  await assert.rejects(f.runner().dispatch(input('late'), h.peers[0]!), /取消/);
  assert.equal(f.count(), 1);
  f.advance(2 * day);
  await f.runner().dispatch(input('late'), h.peers[0]!);
  assert.equal(f.count(), 2, 'tombstones expire under the same seven-day retention policy');
});

test('round5 request HTTP routes authenticate and never lookup or cancel across peers', async (t) => {
  const f = fixture(t);
  const h = await http(t, f.runner());
  const sent = await h.call('tasks', 'POST', input('same'));
  const { taskId } = await sent.json();
  for (const [path, method] of [
    ['requests/same', 'GET'],
    ['requests/same/cancel', 'POST'],
  ]) {
    assert.equal((await h.call(path!, method, undefined, '')).status, 401);
    assert.equal((await h.call(path!, method, undefined, 'x'.repeat(43))).status, 401);
    const other = await h.call(path!, method, undefined, h.tokens[1]);
    assert.equal(other.status, 200);
    assert.deepEqual(await other.json(), { taskId: null }, 'same id is absent in the other peer namespace');
  }
  assert.equal(f.states.get(taskId), 'running');
  assert.equal((await h.call(`tasks/${taskId}`, 'GET', undefined, h.tokens[1])).status, 404);
  assert.equal((await h.call('tasks', 'POST', input('same'), h.tokens[1])).status, 409);
  assert.deepEqual(await (await h.call('requests/same')).json(), { taskId });
  assert.equal((await h.call('requests/same/cancel', 'POST')).status, 200);
  assert.equal(f.states.get(taskId), 'cancelled');
  const first = await (await h.call('tasks', 'POST', input('both'))).json();
  const second = await (await h.call('tasks', 'POST', input('both'), h.tokens[1])).json();
  assert.notEqual(first.taskId, second.taskId);
  assert.deepEqual(await (await h.call('requests/both/cancel', 'POST', undefined, h.tokens[1])).json(), {
    taskId: second.taskId,
  });
  assert.equal(f.states.get(first.taskId), 'running');
  assert.equal(f.states.get(second.taskId), 'cancelled');
});

test('round5 unresolved dispatch reservations stay uncertain after cancellation and expiry', async (t) => {
  const f = fixture(t, 1);
  f.store.save('peer-request', 'peer:uncertain', 'peer', { status: 'dispatching' });
  await assert.rejects(f.runner().cancelRequest('uncertain', 'peer'), /不确定/);
  await assert.rejects(f.runner().dispatch(input('uncertain'), 'peer'), /不确定/);
  f.advance(8 * day);
  await assert.rejects(f.runner().dispatch(input('new'), 'peer'), /请求记录.*上限/);
  assert.equal(f.count(), 0);
});

test('round5 a cached result cannot evict a task that is running again', async (t) => {
  const f = fixture(t, 1);
  const first = await f.runner().dispatch(input('continued'), 'peer');
  f.store.save('peer-task', first.taskId, 'peer', { peerId: 'peer', result: { status: 'completed' } });
  f.advance(8 * day);
  await assert.rejects(f.runner().dispatch(input('new'), 'peer'), /请求记录.*上限/);
  assert.deepEqual(await f.runner().dispatch(input('continued'), 'peer'), first);
  assert.equal(f.count(), 1);
});

test('round5 request routes reject a mismatched task owner with 404', async (t) => {
  const f = fixture(t);
  const runner = f.runner();
  const task = await runner.dispatch(input('owned'), 'another-peer');
  runner.lookup = async () => task.taskId;
  runner.cancelRequest = async () => task.taskId;
  const h = await http(t, runner);
  assert.equal((await h.call('requests/owned')).status, 404);
  assert.equal((await h.call('requests/owned/cancel', 'POST')).status, 404);
  assert.equal(f.states.get(task.taskId), 'running');
});
