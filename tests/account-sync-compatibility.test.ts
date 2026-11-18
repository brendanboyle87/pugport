import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceStore } from '../src/server/workspace-store.ts';
import { SyncStore } from '../src/server/account-sync-store.ts';
import { SyncEngine } from '../src/server/account-sync.ts';
import { createDataKey } from '../src/server/account-sync-crypto.ts';
import {
  MemorySyncRemote,
  PostgrestSyncRemote,
  SyncRemoteError,
  type PushChange,
} from '../src/server/account-sync-remote.ts';

const config = { url: 'https://synthetic.invalid', publishableKey: 'sb_publishable_synthetic' };
async function fixture(t: TestContext, remote = new MemorySyncRemote()) {
  const dir = mkdtempSync(join(tmpdir(), 'sync-compat-'));
  const db = new DatabaseSync(join(dir, 'studio.sqlite'));
  const store = new SyncStore(new WorkspaceStore(db, { recoverInterrupted: false }), dir);
  const engine = new SyncEngine({ local: store, remote, deviceId: 'synthetic', config, sealKey: createDataKey() });
  t.after(async () => {
    engine.stop();
    await engine.drain();
    db.close();
  });
  await engine.enable({ userId: 'user', generation: remote.generation });
  return { db, store, engine, remote };
}
test('a rejected new kind retains its queue but cannot starve ordinary records behind 100 entries', async (t) => {
  const { store, engine, remote } = await fixture(t);
  const push = remote.push.bind(remote);
  let refused = 0;
  remote.push = async (generation, changes) => {
    if (changes.some((c) => c.kind === 'remote-server')) {
      refused++;
      throw new SyncRemoteError('UNSUPPORTED_KIND');
    }
    return push(generation, changes);
  };
  for (let i = 0; i < 120; i++) {
    const payload = { owner: '', value: { name: `server-${i}` }, deleted: false };
    store.apply('remote-server', `server-${i}`, payload);
  }
  store.apply('memory', 'note', { owner: '', value: { content: 'ordinary' }, deleted: false });
  store.apply('api-provider', 'api-synthetic', {
    owner: '',
    value: {
      id: 'api-synthetic',
      card: { apiProvider: 'deepseek', label: 'Synthetic', enabled: true },
      key: 'synthetic-key',
      excluded: true,
    },
    deleted: false,
  });
  await engine.syncNow();
  assert.equal(engine.status, 'idle');
  assert.equal(refused, 1);
  assert.equal([...remote.records.values()].filter((r) => r.kind === 'memory').length, 1);
  assert.equal([...remote.records.values()].filter((r) => r.kind === 'api-provider').length, 1);
  assert.equal(store.pending().length, 120);
  store.apply('memory', 'note2', { owner: '', value: { content: 'still ordinary' }, deleted: false });
  await engine.syncNow();
  assert.equal(refused, 1);
  assert.equal([...remote.records.values()].filter((r) => r.kind === 'memory').length, 2);
  remote.push = push;
  const resumedAt = Date.now() + 300001;
  t.mock.method(Date, 'now', () => resumedAt);
  await engine.syncNow();
  await engine.syncNow();
  assert.equal(store.pending().length, 0);
  assert.equal([...remote.records.values()].filter((r) => r.kind === 'remote-server').length, 120);
});
test('ordinary transport/auth errors remain errors and do not masquerade as unsupported kinds', async (t) => {
  const { store, engine, remote } = await fixture(t);
  store.apply('remote-server', 'server', { owner: '', value: { name: 'server' }, deleted: false });
  remote.push = async () => {
    throw new SyncRemoteError('AUTH_REQUIRED');
  };
  await engine.syncNow();
  assert.equal(engine.status, 'error: AUTH_REQUIRED');
  assert.equal(store.pending().length, 1);
});
const plant = (kind: string, id: string, body: unknown): PushChange => ({
  kind,
  id,
  device_id: 'other',
  deleted: false,
  last_seq: 0,
  body: body as PushChange['body'],
});
test('unknown kinds advance the cursor while known records are still validated before any page applies', async (t) => {
  const { store, engine, remote } = await fixture(t);
  await remote.push(remote.generation, [
    plant('future-kind', 'future', { format: 'unreadable-future-format' } as never),
    plant('memory', 'note', { owner: '', value: { content: 'known' }, deleted: false }),
  ]);
  await engine.syncNow();
  assert.equal(engine.status, 'idle');
  assert.equal(store.cursor, 2);
  assert.equal(store.current('future-kind', 'future'), undefined);
  assert.equal(store.current('memory', 'note')?.value.content, 'known');
  await remote.push(remote.generation, [
    plant('future-kind', 'future2', {}),
    // Malformed: the body claims a deletion the row does not.
    plant('memory', 'malformed', { owner: '', value: {}, deleted: true }),
  ]);
  await engine.syncNow();
  assert.equal(engine.status, 'error: INVALID_RECORD');
  assert.equal(store.cursor, 2);
  assert.equal(store.current('memory', 'malformed'), undefined);
});
test('transport only classifies the exact kind check constraint, never an arbitrary HTTP 400', async () => {
  const token = `header.${Buffer.from(JSON.stringify({ sub: 'user' })).toString('base64url')}.signature`;
  for (const [failure, expected] of [
    [{ code: '23514', message: 'new row violates check constraint "sync_records_kind_check"' }, 'UNSUPPORTED_KIND'],
    [{ code: '23514', message: 'new row violates check constraint "records_kind_check"' }, 'HTTP_400'],
    [{ code: '23514', message: 'new row violates check constraint "sync_records_size_check"' }, 'HTTP_400'],
    [{ code: '22000', message: 'sync_records_kind_check' }, 'HTTP_400'],
  ] as const) {
    let path = '';
    const remote = new PostgrestSyncRemote(config, 'user', () => token, (async (url: string) => {
      path = new URL(url).pathname;
      return new Response(JSON.stringify(failure), { status: 400 });
    }) as typeof fetch);
    await assert.rejects(remote.push('generation', []), (error: Error) => error.message === expected);
    assert.equal(path, '/rest/v1/rpc/push_sync_records');
  }
});
test('transport sends secrets beside the body and joins them back on accept, conflict and pull', async () => {
  const token = `header.${Buffer.from(JSON.stringify({ sub: 'user' })).toString('base64url')}.signature`;
  const node = { id: 'node', enrolledServer: 'srv', token: 'synthetic-token', peerId: 'peer' };
  const stored = (seq: number) => ({
    kind: 'server-node',
    id: 'node',
    seq,
    body: { owner: '', value: { id: 'node', enrolledServer: 'srv', peerId: 'peer' }, deleted: false },
    deleted: false,
    device_id: 'other',
    size: 1,
    server_updated_at: '2026-01-01T00:00:00Z',
  });
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  const remote = new PostgrestSyncRemote(config, 'user', () => token, (async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    requests.push({ path, body: JSON.parse(String(init?.body)) });
    if (path.endsWith('/rpc/pull_sync_records'))
      return Response.json([{ ...stored(9), secrets: { token: 'pulled-token' } }]);
    return Response.json([
      { kind: 'server-node', id: 'node', status: 'accepted', record: stored(7) },
      { kind: 'api-provider', id: 'api-x', status: 'conflict', record: null, secrets: null },
      {
        kind: 'server-node',
        id: 'node2',
        status: 'conflict',
        record: { ...stored(8), id: 'node2' },
        secrets: { token: 'cloud-token' },
      },
    ]);
  }) as typeof fetch);
  const results = await remote.push('generation', [
    {
      kind: 'server-node',
      id: 'node',
      last_seq: 0,
      deleted: false,
      device_id: 'me',
      body: { owner: '', value: node, deleted: false },
    },
    {
      kind: 'api-provider',
      id: 'api-x',
      last_seq: 3,
      deleted: true,
      device_id: 'me',
      body: { owner: '', value: {}, deleted: true },
    },
    {
      kind: 'server-node',
      id: 'node2',
      last_seq: 0,
      deleted: false,
      device_id: 'me',
      body: { owner: '', value: node, deleted: false },
    },
  ]);
  const sent = requests[0].body as { p_generation: string; changes: Record<string, unknown>[] };
  assert.equal(requests[0].path, '/rest/v1/rpc/push_sync_records');
  assert.equal(sent.p_generation, 'generation');
  assert.doesNotMatch(JSON.stringify(sent.changes.map((change) => change.body)), /synthetic-token/);
  assert.deepEqual(sent.changes[0].secrets, { token: 'synthetic-token' });
  assert.equal(sent.changes[1].secrets, undefined);
  assert.equal(results[0].status === 'accepted' && results[0].record.body.value.token, 'synthetic-token');
  assert.equal(results[1].status === 'conflict' && results[1].record, null);
  assert.equal(results[2].status === 'conflict' && results[2].record?.body.value.token, 'cloud-token');
  const pulled = await remote.pull(0);
  assert.deepEqual(requests[1], { path: '/rest/v1/rpc/pull_sync_records', body: { after_seq: 0, max_rows: 200 } });
  assert.equal(pulled[0].body.value.token, 'pulled-token');
  assert.equal('secrets' in pulled[0], false);
});
