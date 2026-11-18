import assert from 'node:assert/strict';
import test from 'node:test';
import { StoreOutbox } from '../src/server/maintainer/outbox.ts';
import type { VerdictRecord } from '../src/server/maintainer/shadow-score.ts';
import { card, memoryStore, sha, stamp } from './helpers/maintainer.ts';
import { hostFixture } from './helpers/maintainer-host.ts';

test('outbox reads a bounded open-only list and shows the newest 100 cards, oldest first', (t) => {
  const store = memoryStore();
  for (let i = 1100; i >= 1; i--) {
    const item = card({ id: `card-${i}`, number: i, createdAt: new Date(Date.parse(stamp) + i * 1000).toISOString() });
    store.save('maintainer-card', `o/r#${i}:${item.id}`, 'maintainer:open', item);
  }
  store.save('maintainer-card', 'o/r#0:closed', 'maintainer:closed', card({ id: 'closed', number: 0 }));
  const calls: { owner?: string; limit?: number }[] = [];
  const list = store.list.bind(store);
  t.mock.method(store, 'list', (kind: string, owner?: string, limit?: number) => {
    calls.push({ owner, limit });
    return list(kind, owner, limit);
  });
  const open = new StoreOutbox(store, () => Date.parse(stamp)).open();
  assert.deepEqual(calls, [{ owner: 'maintainer:open', limit: 1000 }]);
  assert.deepEqual(
    open.map((item) => item.number),
    Array.from({ length: 100 }, (_, i) => i + 1001),
  );
});

test('outbox keys, deduplication and supersession keep repositories separate', () => {
  const store = memoryStore();
  const outbox = new StoreOutbox(store, () => Date.parse(stamp));
  const first = outbox.raise(card());
  const second = outbox.raise(card({ url: 'https://github.com/another/repository/pull/7' }));
  assert.notEqual(first.id, second.id);
  assert.equal(outbox.raise(card()).id, first.id);
  assert.ok(store.get('maintainer-card', `o/r#7:${first.id}`));
  assert.ok(store.get('maintainer-card', `another/repository#7:${second.id}`));
  outbox.supersede(7, 'b'.repeat(40), 'o/r');
  assert.deepEqual(outbox.open('o/r'), []);
  assert.deepEqual(
    outbox.open('another/repository').map((item) => item.id),
    [second.id],
  );
  outbox.resolve(second.id, { outcome: 'declined', at: stamp });
  assert.deepEqual(outbox.open(), []);
  assert.equal(store.list('maintainer-card', 'maintainer:closed').length, 2);
});

test('poll outcomes save only changed verdicts using repository keys', async (t) => {
  const f = await hostFixture(t);
  const first = f.addPr(1);
  f.addPr(2);
  await f.poll();
  const verdictKeys: string[] = [];
  const save = f.store.save.bind(f.store);
  t.mock.method(f.store, 'save', (kind: string, id: string, owner: string, value: unknown) => {
    if (kind === 'maintainer-verdict') verdictKeys.push(id);
    return save(kind, id, owner, value);
  });
  await f.poll();
  assert.deepEqual(verdictKeys, []);
  first.view.state = 'CLOSED';
  await f.poll();
  const key = `o/r#1:${first.view.headRefOid}:live`;
  assert.deepEqual(verdictKeys, [key]);
  assert.equal(f.store.get<VerdictRecord>('maintainer-verdict', key)?.outcome, 'closed');
  verdictKeys.length = 0;
  await f.poll();
  assert.deepEqual(verdictKeys, []);
  assert.equal(f.store.get('maintainer-verdict', `other/repository#1:${sha}:live`), undefined);
});

test('the desktop sees the newest 100 open cards while the host still finds older ones', () => {
  let clock = Date.parse('2026-10-28T12:00:00Z');
  const store = memoryStore();
  const outbox = new StoreOutbox(store, () => clock);
  const ids: string[] = [];
  for (let n = 1; n <= 120; n++) {
    clock += 1000;
    ids.push(
      outbox.raise({
        kind: 'review',
        mode: 'live',
        number: n,
        title: `PR ${n}`,
        url: `https://github.com/o/r/pull/${n}`,
        author: 'contributor',
        external: false,
        reasons: [],
      }).id,
    );
  }
  assert.equal(outbox.open('o/r').length, 100);
  assert.equal(outbox.open('o/r')[0]!.number, 21);
  assert.equal(outbox.open('o/r').at(-1)!.number, 120);
  assert.ok(outbox.all('o/r').some((card) => card.id === ids[0]));
});
