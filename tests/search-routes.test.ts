import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import express from 'express';
import { WorkspaceStore } from '../src/server/workspace-store.ts';
import { searchConversations, searchRoutes } from '../src/server/search-routes.ts';
import { searchSnippet, textMatches, type ConversationSearchResult } from '../src/shared/search.ts';
import { listenForFetch } from './helpers/fetch-port.ts';

function fixture() {
  const db = new DatabaseSync(':memory:');
  const store = new WorkspaceStore(db, { recoverInterrupted: false });
  store.save('project', 'p', '', { id: 'p' });
  const conversation = (id: string, extra = {}) =>
    store.save('conversation', id, 'p', {
      id,
      projectId: 'p',
      title: `Title ${id}`,
      createdAt: '2026-01-01T00:00:00Z',
      ...extra,
    });
  const message = (id: string, owner: string, content: string, day = 1) =>
    store.save('message', id, owner, {
      id,
      conversationId: owner,
      content,
      role: 'user',
      createdAt: `2026-01-${String(day).padStart(2, '0')}T00:00:00Z`,
    });
  return { db, store, conversation, message };
}

test('search finds message text and Chinese, newest first, with safe marked snippets', () => {
  const f = fixture();
  try {
    f.conversation('c');
    f.message('old', 'c', 'Before NEEDLE after', 1);
    f.message('new', 'c', '<script>alert(1)</script> needle 中文记录', 3);
    const results = searchConversations(f.store, 'needle');
    assert.deepEqual(
      results.map((hit) => hit.messageId),
      ['new', 'old'],
    );
    assert.deepEqual(
      results[0].snippet.filter((part) => part.match),
      [{ text: 'needle', match: true }],
    );
    assert.equal(results[0].title, 'Title c');
    assert.equal(searchConversations(f.store, '中文')[0].messageId, 'new');
  } finally {
    f.db.close();
  }
});

test('search excludes deleted conversations, side chats, removed and missing projects', () => {
  const f = fixture();
  try {
    f.conversation('live');
    f.conversation('incognito', { incognito: true, memory: 'off' });
    f.conversation('deleted', { deletedAt: '2026-01-03T00:00:00Z' });
    f.conversation('side', { sideChat: { parentConversationId: 'live' } });
    f.store.save('project', 'removed', '', { id: 'removed', removedAt: '2026-01-03' });
    for (const owner of ['removed', 'missing']) {
      f.store.save('conversation', owner, owner, { id: owner, title: 'needle', createdAt: '2026-01-01' });
    }
    for (const id of ['live', 'deleted', 'side', 'removed', 'missing', 'incognito']) f.message(id, id, 'needle');
    assert.deepEqual(
      searchConversations(f.store, 'needle').map((hit) => hit.conversationId),
      ['live'],
    );
    f.store.save('project', 'p', '', { id: 'p', removedAt: '2026-01-04' });
    assert.deepEqual(searchConversations(f.store, 'needle'), []);
  } finally {
    f.db.close();
  }
});

test('title hits appear once, including empty conversations, and link to a message when present', () => {
  const f = fixture();
  try {
    f.conversation('empty', { title: 'needle title' });
    f.conversation('full', { title: 'needle title' });
    f.message('first', 'full', 'unrelated', 1);
    f.message('last', 'full', 'unrelated', 2);
    const results = searchConversations(f.store, 'needle');
    assert.equal(results.length, 2);
    assert.equal(results.find((hit) => hit.conversationId === 'empty')?.messageId, null);
    assert.equal(results.find((hit) => hit.conversationId === 'full')?.messageId, 'last');
    assert.ok(results.every((hit) => hit.snippet.some((part) => part.match)));
  } finally {
    f.db.close();
  }
});

test('limits are bounded and LIKE metacharacters are literal', () => {
  const f = fixture();
  try {
    f.conversation('c');
    for (let i = 0; i < 70; i++) f.message(`m${i}`, 'c', 'needle');
    assert.equal(searchConversations(f.store, 'needle', 3).length, 3);
    assert.equal(searchConversations(f.store, 'needle', 999).length, 50);
    assert.equal(searchConversations(f.store, 'needle').length, 30);
    assert.deepEqual(searchConversations(f.store, '  '), []);
    assert.deepEqual(searchConversations(f.store, 'n'), []);
    assert.deepEqual(searchConversations(f.store, '%%'), []);
    assert.deepEqual(searchConversations(f.store, '__'), []);
    f.message('literal', 'c', '100% _ C:\\fixture');
    for (const query of ['0%', '_ C', ':\\']) assert.equal(searchConversations(f.store, query)[0].messageId, 'literal');
    assert.deepEqual(searchConversations(f.store, "' OR 1=1 --"), []);
  } finally {
    f.db.close();
  }
});

test('GET /api/search validates input and returns bounded results', async () => {
  const f = fixture();
  f.conversation('c');
  f.message('m', 'c', 'needle');
  const app = express();
  searchRoutes(app, f.store);
  const server = await listenForFetch(app);
  const address = server.address() as { port: number };
  const get = (query: string) => fetch(`http://127.0.0.1:${address.port}/api/search${query}`);
  try {
    const result = await get('?q=needle&limit=1');
    assert.equal(result.status, 200);
    assert.equal(((await result.json()) as ConversationSearchResult[])[0].messageId, 'm');
    for (const query of ['', '?q=needle&limit=oops', '?q=a&q=b', `?q=${'a'.repeat(201)}`])
      assert.equal((await get(query)).status, 400);
    assert.deepEqual(await (await get('?q=%20')).json(), []);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    f.db.close();
  }
});

test('snippet finds middle text and treats regex symbols literally', () => {
  const parts = searchSnippet('a'.repeat(500) + 'a+b' + 'z'.repeat(500), 'a+b');
  assert.deepEqual(
    parts.filter((part) => part.match),
    [{ text: 'a+b', match: true }],
  );
  assert.ok(parts.map((part) => part.text).join('').length < 250);
  assert.deepEqual(textMatches('İ x NEEDLE needle', 'needle'), [
    { start: 4, end: 10 },
    { start: 11, end: 17 },
  ]);
});
