import assert from 'node:assert/strict';
import test from 'node:test';
import type { Conversation } from '../src/shared/types.ts';
import {
  ConversationCreationGate,
  createSidebarConversation,
  createdConversationSelection,
  conversationsWithCreated,
  isCreatedConversationPending,
} from '../src/ui/conversation-creation.ts';

type Options = Parameters<typeof createSidebarConversation>[1];
const conversation = (id = 'new', projectId = 'project'): Conversation => ({
  id,
  projectId,
  title: 'New fixture chat',
  createdAt: '2026-10-09T20:00:00Z',
  updatedAt: '2026-10-09T20:00:00Z',
});
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function fixture(patch: Partial<Options> = {}) {
  const gate = new ConversationCreationGate();
  const calls: { path: string; body?: unknown; method: string }[] = [];
  const selected: Conversation[] = [];
  const pending: boolean[] = [];
  const errors: { stage: string; failure: unknown }[] = [];
  let refreshes = 0;
  const options: Options = {
    api: async <T>(path: string, body?: unknown, method = 'POST') => {
      calls.push({ path, body, method });
      return conversation() as T;
    },
    reload: async () => {
      refreshes++;
    },
    onPending: (value) => pending.push(value),
    onCreated: (value) => selected.push(value),
    onError: (stage, failure) => errors.push({ stage, failure }),
    ...patch,
  };
  return { gate, options, calls, selected, pending, errors, refreshes: () => refreshes };
}
const flush = async () => {
  await new Promise<void>((resolve) => setImmediate(resolve));
};

test('a confirmed project chat opens and unlocks while the full state refresh is still pending', async () => {
  const refresh = deferred<void>();
  const f = fixture({ projectId: 'project', reload: () => refresh.promise });
  const result = await createSidebarConversation(f.gate, f.options);
  assert.equal(result?.id, 'new');
  assert.equal(f.selected[0]?.projectId, 'project');
  assert.deepEqual(f.calls, [{ path: '/api/conversations', body: { projectId: 'project' }, method: 'POST' }]);
  assert.deepEqual(f.pending, [true, false]);
  assert.equal(f.errors.length, 0);
  refresh.resolve();
  await flush();
});

test('failed background refresh preserves the created chat and is not reported as a failed create', async () => {
  const f = fixture({ reload: async () => Promise.reject(new Error('Fixture state unavailable')) });
  const created = await createSidebarConversation(f.gate, f.options);
  await flush();
  assert.equal(created?.id, 'new');
  assert.equal(f.selected.length, 1);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(
    f.errors.map((item) => item.stage),
    ['refresh'],
  );
  assert.equal(createdConversationSelection([], created, 'new'), created);
});

test('two immediate clicks send one POST before React can apply the pending state', async () => {
  const post = deferred<Conversation>();
  let calls = 0;
  const f = fixture({
    api: async <T>() => {
      calls++;
      return (await post.promise) as T;
    },
  });
  const first = createSidebarConversation(f.gate, f.options);
  const second = createSidebarConversation(f.gate, f.options);
  assert.equal(await second, undefined);
  assert.equal(calls, 1);
  assert.deepEqual(f.pending, [true]);
  post.resolve(conversation());
  await first;
  assert.equal(f.selected.length, 1);
  assert.deepEqual(f.pending, [true, false]);
});

test('a delayed POST cannot replace navigation performed while it was in flight', async () => {
  const post = deferred<Conversation>();
  const f = fixture({ api: async <T>() => (await post.promise) as T });
  const creation = createSidebarConversation(f.gate, f.options);
  f.gate.navigate();
  post.resolve(conversation());
  const saved = await creation;
  await flush();
  assert.equal(saved?.id, 'new', 'the confirmed record remains saved');
  assert.equal(f.selected.length, 0, 'the current page or conversation is not changed');
  assert.equal(f.refreshes(), 1, 'the sidebar may still discover the saved record');
  assert.deepEqual(f.pending, [true, false]);
});

test('ordinary creation sends no project pin, and the gate can create again before an old refresh completes', async () => {
  const refresh = deferred<void>();
  const f = fixture({ reload: () => refresh.promise });
  await createSidebarConversation(f.gate, f.options);
  await createSidebarConversation(f.gate, f.options);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(
    f.calls.map((item) => item.body),
    [{}, {}],
  );
  assert.equal(f.selected.length, 2);
  refresh.resolve();
  await flush();
});

test('swarm creation waits for the confirmed PATCH and preserves its selected mode before state catches up', async () => {
  const patch = deferred<Conversation>();
  const f = fixture({ swarm: true });
  f.options.api = async <T>(path: string, body?: unknown, method = 'POST') => {
    f.calls.push({ path, body, method });
    return (method === 'PATCH' ? await patch.promise : conversation()) as T;
  };
  const creation = createSidebarConversation(f.gate, f.options);
  await flush();
  assert.equal(f.selected.length, 0);
  assert.deepEqual(f.pending, [true]);
  patch.resolve({ ...conversation(), swarm: true });
  const created = await creation;
  assert.equal(f.selected[0]?.swarm, true);
  assert.deepEqual(f.calls[1], { path: '/api/conversations/new', body: { swarm: true }, method: 'PATCH' });
  assert.equal(createdConversationSelection([conversation()], created, 'new')?.swarm, true);
  assert.equal(conversationsWithCreated([conversation()], created)[0]?.swarm, true);
});

test('failed swarm PATCH retains the ordinary conversation and never repeats the successful POST', async () => {
  const f = fixture({ swarm: true });
  f.options.api = async <T>(path: string, body?: unknown, method = 'POST') => {
    f.calls.push({ path, body, method });
    if (method === 'PATCH') throw new Error('Fixture mode update denied');
    return conversation() as T;
  };
  const created = await createSidebarConversation(f.gate, f.options);
  assert.equal(created?.id, 'new');
  assert.equal(f.selected[0]?.id, 'new');
  assert.notEqual(f.selected[0]?.swarm, true);
  assert.equal(f.calls.filter((item) => item.method === 'POST').length, 1);
  assert.deepEqual(
    f.errors.map((item) => item.stage),
    ['swarm'],
  );
  assert.deepEqual(f.pending, [true, false]);
});

test('a failed POST creates no local conversation, sends no refresh, and releases the retry lock', async () => {
  const f = fixture({ api: async () => Promise.reject(new Error('Fixture create rejected')) });
  assert.equal(await createSidebarConversation(f.gate, f.options), undefined);
  assert.equal(f.selected.length, 0);
  assert.equal(f.refreshes(), 0);
  assert.deepEqual(
    f.errors.map((item) => item.stage),
    ['create'],
  );
  f.options.api = async <T>() => conversation() as T;
  await createSidebarConversation(f.gate, f.options);
  assert.equal(f.selected.length, 1);
  assert.deepEqual(f.pending, [true, false, true, false]);
});

test('missing and delayed snapshots retain the saved conversation once, then accept the server row', () => {
  const saved = conversation();
  const older = conversation('older');
  const pendingList = conversationsWithCreated([older], saved);
  assert.equal(pendingList.length, 2);
  assert.equal(pendingList[0], saved);
  assert.equal(pendingList[0]?.projectId, 'project', 'project sidebar grouping retains the saved project');
  assert.equal(createdConversationSelection([older], saved, 'new'), saved);
  const server = { ...saved, title: 'Server title', updatedAt: '2026-10-09T20:01:00Z' };
  const caughtUp = [server, older];
  assert.equal(conversationsWithCreated(caughtUp, saved), caughtUp, 'no duplicate local entry after catch-up');
  assert.equal(createdConversationSelection(caughtUp, saved, 'new'), server);
  assert.equal(createdConversationSelection([older], saved, 'older'), older, 'another selection is preserved');
});

test('an unmounted workspace does not adopt a delayed create response', async () => {
  const post = deferred<Conversation>();
  const f = fixture({ api: async <T>() => (await post.promise) as T });
  const creation = createSidebarConversation(f.gate, f.options);
  f.gate.dispose();
  post.resolve(conversation());
  await creation;
  assert.equal(f.selected.length, 0);
  assert.deepEqual(f.pending, [true], 'no state callback is sent to the unmounted component');
});

test('the complete swarm PATCH record is adopted, but a newer server mode wins over the temporary cache', async () => {
  const f = fixture({ swarm: true });
  f.options.api = async <T>(_path: string, _body?: unknown, method = 'POST') =>
    (method === 'PATCH'
      ? { ...conversation(), swarm: true, updatedAt: '2026-10-09T20:01:00Z', title: 'Confirmed swarm' }
      : conversation()) as T;
  const created = await createSidebarConversation(f.gate, f.options);
  assert.equal(created?.updatedAt, '2026-10-09T20:01:00Z');
  assert.equal(created?.title, 'Confirmed swarm');
  assert.equal(createdConversationSelection([conversation()], created, 'new')?.swarm, true);
  const exited = { ...created!, swarm: false, updatedAt: '2026-10-09T20:02:00Z' };
  assert.equal(isCreatedConversationPending(exited, created!), false);
  assert.equal(createdConversationSelection([exited], created, 'new'), exited);
  assert.equal(conversationsWithCreated([exited], created)[0], exited);
});
