import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createContext, runInContext } from 'node:vm';
import { MOD_CLIENT_SHIM, buildModSrcDoc } from '../src/shared/mod-client-shim.ts';
import {
  createModHostBridge,
  cachedModManifest,
  invalidateModManifestCache,
  MOD_BRIDGE_MAX_IN_FLIGHT,
  type ModHostContext,
  type ModPort,
} from '../src/ui/mods/mod-host-bridge.ts';
import type { ModManifestV2 } from '../src/shared/mods-manifest.ts';
import { uiUpdateBlocked } from '../src/ui/ui-update-guard.ts';
import { ConversationModes } from '../src/server/conversation-modes.ts';
import { WorkspaceStore } from '../src/server/workspace-store.ts';
import type { Conversation } from '../src/shared/types.ts';
import { findNode, uiBundle, uiHarness } from './helpers/ui-harness.ts';

let serial = 0;
function manifest(): ModManifestV2 {
  return {
    schemaVersion: 2,
    id: `test.bridge${++serial}`,
    version: '1.0.0',
    title: '<b>Notes</b>',
    description: 'Synthetic',
    permissions: ['chat:read', 'composer:draft'],
    state: { keys: [{ id: 'notes' }, { id: 'topic' }] },
  };
}
class Port implements ModPort {
  onmessage: ((event: MessageEvent) => void) | null = null;
  sent: any[] = [];
  closed = false;
  postMessage(value: unknown) {
    if (!this.closed) this.sent.push(value);
  }
  start() {}
  close() {
    this.closed = true;
  }
  async request(method: string, params: unknown = {}, id = String(++serial)) {
    this.onmessage?.({ data: { type: 'request', id, method, params } } as MessageEvent);
    await new Promise((resolve) => setImmediate(resolve));
    return this.sent.find((value) => value.type === 'response' && value.id === id);
  }
}
function fixture(permissions?: ModManifestV2['permissions']) {
  const mod = manifest();
  if (permissions) mod.permissions = permissions;
  let alive = true;
  let revision = 0;
  let values: Record<string, string> = { notes: 'original' };
  let draft = 'old';
  const notifications: unknown[] = [];
  const context: ModHostContext = {
    conversationId: 'chat',
    modId: mod.id,
    version: mod.version,
    instanceId: 'instance',
    manifest: mod,
    isCurrent: () => alive,
    info: () => ({
      apiVersion: 2,
      hostVersion: 'test',
      locale: 'en',
      theme: 'dark',
      tokens: { accent: '#fff' },
      slot: 'rightPanel',
      layout: 'panel',
      conversation: { id: 'chat', title: 'Chat' },
    }),
    getState: async () => ({ revision, values }),
    setState: async (patch, expected) => {
      if (expected !== revision) throw { code: 'E_CONFLICT', message: '/secret/token' };
      values = { ...values, ...patch };
      return { revision: ++revision, values };
    },
    messages: () =>
      [
        {
          id: 'one',
          role: 'user',
          content: 'hello',
          createdAt: 'now',
          attachments: [{ name: 'note.txt', kind: 'text', path: '/secret' }],
          token: 'secret',
        },
      ] as any,
    insert: (text, mode) => {
      draft = mode === 'replace' ? text : draft + text;
    },
    notify: (title, message) => notifications.push([title, message]),
  };
  const bridge = createModHostBridge(context);
  const port = new Port();
  bridge.connect(port);
  return {
    context,
    bridge,
    port,
    notifications,
    draft: () => draft,
    invalidate: () => {
      alive = false;
    },
  };
}

test('internal chat shortcut only toggles a current visible main workspace frame', () => {
  const f = fixture();
  const original = f.context.info();
  let toggles = 0;
  f.context.toggleChat = () => toggles++;
  const shortcut = (data: unknown = { type: 'shortcut', name: 'chat' }) => f.port.onmessage?.({ data } as MessageEvent);
  shortcut();
  assert.equal(toggles, 0, 'panel cannot toggle');
  f.context.info = () => ({ ...original, slot: 'mainView', layout: 'workspace' });
  shortcut();
  assert.equal(toggles, 1);
  shortcut({ type: 'shortcut', name: 'chat', extra: true });
  shortcut({ type: 'shortcut', name: 'unknown' });
  assert.equal(toggles, 1, 'unknown or malformed shortcuts are ignored');
  f.bridge.emit('visibility', { visible: false });
  shortcut();
  assert.equal(toggles, 1, 'hidden frame cannot toggle');
  f.bridge.emit('visibility', { visible: true });
  f.invalidate();
  shortcut();
  assert.equal(toggles, 1, 'stale binding cannot toggle');
  f.bridge.detach();
});

test('theme exposes all 18 approved host tokens from the current computed style', async () => {
  const h = uiHarness(await uiBundle('src/ui/mods/use-mod-host.ts'), {
    document: { documentElement: { dataset: { theme: 'dark' } } },
    getComputedStyle: () => ({ getPropertyValue: (key: string) => ` value:${key} ` }),
  });
  try {
    const result = h.exports.modTheme();
    assert.equal(result.theme, 'dark');
    const keys = [
      '--text',
      '--muted',
      '--accent',
      '--accent-text',
      '--surface-1',
      '--sidebar',
      '--border',
      '--focus',
      '--bg',
      '--surface-2',
      '--hover',
      '--border-strong',
      '--faint',
      '--on-accent',
      '--danger',
      '--radius-md',
      '--radius-lg',
      '--font',
    ];
    assert.deepEqual(Object.keys(result.tokens).sort(), keys.sort());
    for (const key of keys) assert.equal(result.tokens[key], `value:${key}`);
  } finally {
    h.unmount();
  }
});

test('hidden Mod surfaces cannot authorize or reconnect banks but can read existing connections', async () => {
  const f = fixture(['connections:read']);
  f.context.granted = () => ['connections:read'];
  const calls: string[] = [];
  let canShow: (() => boolean) | undefined;
  f.context.data = {
    connections: async () => [],
    call: async (method, _args, guard) => {
      calls.push(method);
      canShow = guard;
      return { status: 'pending' };
    },
  };
  f.bridge.emit('visibility', { visible: false });
  for (const [method, params] of [
    ['connections.authorize', { provider: 'plaid' }],
    ['connections.reconnect', { connectionId: 'conn_abcdefgh12' }],
  ] as const)
    assert.equal((await f.port.request(method, params)).error.code, 'E_UNAVAILABLE');
  assert.deepEqual(calls, []);
  await f.port.request('connections.list');
  assert.deepEqual(calls, ['connections.list']);
  f.bridge.emit('visibility', { visible: true });
  assert.deepEqual((await f.port.request('connections.authorize', { provider: 'plaid' })).result, {
    status: 'pending',
  });
  assert.equal(canShow?.(), true);
  f.bridge.emit('visibility', { visible: false });
  assert.equal(canShow?.(), false);
  f.bridge.emit('visibility', { visible: true });
  f.invalidate();
  assert.equal(canShow?.(), false);
  f.bridge.detach();
});

test('bridge exposes only the method whitelist and validates exact arguments and bounded envelopes', async () => {
  const f = fixture();
  try {
    for (const name of ['chat.send', 'constructor', '__proto__', 'fetch', 'event'])
      assert.equal((await f.port.request(name)).error.code, 'E_INVALID');
    for (const [method, args] of [
      ['host.info', { token: true }],
      ['composer.insert', { text: 'x', mode: 'send' }],
      ['messages.list', { limit: 201 }],
      ['state.set', { values: { notes: 1 }, expectedRevision: 0 }],
      ['ui.notify', { message: 'x'.repeat(201) }],
      ['composer.insert', { text: 'x'.repeat(16001), mode: 'append' }],
    ] as const)
      assert.equal((await f.port.request(method, args)).error.code, 'E_INVALID');
    assert.equal((await f.port.request('host.info', { huge: 'x'.repeat(700000) })).error.code, 'E_LIMIT');
    const host = (await f.port.request('host.info')).result;
    assert.equal(host.conversation.id, 'chat');
    assert.equal('manifest' in host, false);
    const before = f.port.sent.length;
    f.port.onmessage?.({ data: { type: 'event', event: 'run', data: { running: true } } } as MessageEvent);
    assert.equal(f.port.sent.length, before);
  } finally {
    f.bridge.detach();
  }
});

test('repeated references and cycles are rejected promptly without disabling the bridge', async () => {
  const f = fixture();
  try {
    let graph: object = {};
    for (let i = 0; i < 25; i++) graph = { left: graph, right: graph };
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    let deep: object = {};
    for (let i = 0; i < 25; i++) deep = { child: deep };
    for (const value of [graph, cycle, deep]) {
      const start = performance.now();
      const response = await f.port.request('state.set', { values: { notes: value }, expectedRevision: 0 });
      assert.ok(performance.now() - start < 500);
      assert.equal(response.error.code, 'E_LIMIT');
      assert.equal((await f.port.request('host.info')).result.apiVersion, 2);
    }
  } finally {
    f.bridge.detach();
  }
});

test('message byte limit accounts for UTF-8 and JSON escapes', async () => {
  const f = fixture();
  try {
    assert.equal((await f.port.request('host.info', { extra: '\u00e9'.repeat(300000) })).error.code, 'E_INVALID');
    assert.equal((await f.port.request('host.info', { extra: '\u00e9'.repeat(310000) })).error.code, 'E_LIMIT');
    assert.equal((await f.port.request('host.info', { extra: '\u0000'.repeat(103000) })).error.code, 'E_LIMIT');
  } finally {
    f.bridge.detach();
  }
});

test('state keeps caller revisions, merges patches, rejects unknown keys and sanitizes errors', async () => {
  const f = fixture();
  try {
    assert.deepEqual((await f.port.request('state.set', { values: { topic: 'new' }, expectedRevision: 0 })).result, {
      revision: 1,
      values: { notes: 'original', topic: 'new' },
    });
    const conflict = await f.port.request('state.set', { values: { notes: 'stale' }, expectedRevision: 0 });
    assert.deepEqual(conflict.error, { code: 'E_CONFLICT', message: 'State revision changed.' });
    assert.equal(
      (await f.port.request('state.set', { values: { unknown: 'bad' }, expectedRevision: 1 })).error.code,
      'E_INVALID',
    );
    f.context.getState = async () => {
      throw new Error('token=secret C:/private');
    };
    assert.deepEqual((await f.port.request('state.get')).error, {
      code: 'E_UNAVAILABLE',
      message: 'Mod is unavailable.',
    });
  } finally {
    f.bridge.detach();
  }
});

test('declared permissions gate reads, draft writes and message events', async () => {
  const f = fixture([]);
  try {
    for (const [method, args] of [
      ['messages.list', {}],
      ['composer.insert', { text: 'hello', mode: 'append' }],
    ] as const)
      assert.equal((await f.port.request(method, args)).error.code, 'E_PERMISSION');
    f.bridge.emit('messages', { count: 1, lastId: 'one' });
    assert.equal(
      f.port.sent.some((value) => value.event === 'messages'),
      false,
    );
  } finally {
    f.bridge.detach();
  }
});

test('messages are projected to public fields and drafts append/replace without a send capability', async () => {
  const f = fixture();
  try {
    assert.deepEqual((await f.port.request('messages.list')).result, [
      {
        id: 'one',
        role: 'user',
        content: 'hello',
        createdAt: 'now',
        attachments: [{ name: 'note.txt', kind: 'text' }],
      },
    ]);
    assert.deepEqual((await f.port.request('messages.list', { before: 'one' })).result, []);
    assert.equal((await f.port.request('messages.list', { before: 'missing' })).error.code, 'E_INVALID');
    await f.port.request('composer.insert', { text: '+', mode: 'append' });
    assert.equal(f.draft(), 'old+');
    await f.port.request('composer.insert', { text: 'new', mode: 'replace' });
    assert.equal(f.draft(), 'new');
    assert.equal((await f.port.request('chat.send')).error.code, 'E_INVALID');
  } finally {
    f.bridge.detach();
  }
});

test('message list caps at 200 and rejects oversized public results', async () => {
  const f = fixture();
  try {
    f.context.messages = () =>
      Array.from({ length: 220 }, (_, i) => ({ id: String(i), role: 'user', content: 'x', createdAt: 'now' }));
    assert.equal((await f.port.request('messages.list')).result.length, 200);
    f.context.messages = () => [{ id: 'x', role: 'user', content: 'x'.repeat(700000), createdAt: 'now' }];
    assert.equal((await f.port.request('messages.list')).error.code, 'E_LIMIT');
  } finally {
    f.bridge.detach();
  }
});

test('notifications remain text and share the per-Mod three-per-ten-second limit across frames', async (t) => {
  const f = fixture();
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const other = createModHostBridge(f.context);
  const port = new Port();
  other.connect(port);
  try {
    for (let i = 0; i < 3; i++)
      assert.deepEqual((await f.port.request('ui.notify', { message: '<img onerror=alert(1)>' })).result, {});
    assert.equal((await port.request('ui.notify', { message: 'fourth' })).error.code, 'E_LIMIT');
    assert.deepEqual(f.notifications[0], ['<b>Notes</b>', '<img onerror=alert(1)>']);
    now += 10000;
    assert.deepEqual((await port.request('ui.notify', { message: 'after the window' })).result, {});
  } finally {
    f.bridge.detach();
    other.detach();
  }
});

test('dirty blockers belong to individual frames and reload releases only that frame', async () => {
  const a = fixture(),
    b = fixture();
  try {
    await a.port.request('ui.setDirty', { dirty: true });
    await b.port.request('ui.setDirty', { dirty: true });
    assert.equal(uiUpdateBlocked(), true);
    a.bridge.connect(new Port());
    assert.equal(uiUpdateBlocked(), true);
    b.bridge.detach();
    assert.equal(uiUpdateBlocked(), false);
  } finally {
    a.bridge.detach();
    b.bridge.detach();
  }
});

test('rehandshake invalidates old port and in-flight work, then restores request capacity', async () => {
  const f = fixture();
  let release!: () => void;
  f.context.getState = () =>
    new Promise((resolve) => {
      release = () => resolve({ revision: 0, values: { notes: 'late' } });
    });
  const oldHandler = f.port.onmessage!;
  for (let i = 0; i < MOD_BRIDGE_MAX_IN_FLIGHT; i++)
    oldHandler({ data: { type: 'request', id: `wait${i}`, method: 'state.get' } } as MessageEvent);
  assert.equal((await f.port.request('host.info')).error.code, 'E_LIMIT');
  const next = new Port();
  f.bridge.connect(next);
  assert.equal(f.port.closed, true);
  assert.equal(f.port.sent.filter((value) => value.error?.code === 'E_UNAVAILABLE').length, MOD_BRIDGE_MAX_IN_FLIGHT);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await next.request('host.info')).result.apiVersion, 2);
  oldHandler({
    data: { type: 'request', id: 'old', method: 'composer.insert', params: { text: 'bad', mode: 'replace' } },
  } as MessageEvent);
  assert.equal(f.draft(), 'old');
  assert.equal(next.sent.filter((value) => value.event === 'ready').length, 1);
  assert.equal(
    next.sent.some((value) => value.id?.startsWith('wait')),
    false,
    'late work never reaches the new port',
  );
  f.bridge.detach();
  assert.equal(next.closed, true);
  const rejected = new Port();
  f.bridge.connect(rejected);
  assert.equal(rejected.closed, true);
});

test('actual ModFrame load callback revokes the previous bridge on every document load', async () => {
  const f = fixture();
  f.context.manifest.ui = { entries: { panel: { html: '<p>Fixture</p>' } } };
  f.context.manifest.contributions = { rightPanel: { kind: 'web', entry: 'panel' } };
  const channels: { port1: Port; port2: Port }[] = [];
  const transfers: unknown[][] = [];
  const harness = uiHarness(await uiBundle('src/ui/mods/ModFrame.tsx'), {
    MessageChannel: class {
      port1 = new Port();
      port2 = new Port();
      constructor() {
        channels.push(this);
      }
    },
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
  });
  try {
    const tree = harness.render('ModFrame', {
      host: f.context,
      slot: 'rightPanel',
      hidden: false,
      messages: { count: 0 },
      running: false,
    });
    const frame = findNode(tree, (node) => node.type === 'iframe')!;
    frame.props.ref.current = {
      contentWindow: {
        postMessage: (data: unknown, origin: unknown, ports: unknown) => transfers.push([data, origin, ports]),
      },
    };
    for (let load = 0; load < 3; load++) {
      frame.props.onLoad();
      assert.equal(channels.length, load + 1);
      const channel = channels[load]!;
      assert.equal(channel.port1.closed, false);
      assert.equal(typeof channel.port1.onmessage, 'function');
      assert.equal((transfers[load]![0] as any).type, 'connect');
      assert.equal((transfers[load]![2] as Port[])[0], channel.port2);
      if (load > 0) {
        assert.equal(channels[load - 1]!.port1.closed, true);
        assert.equal(channels[load - 1]!.port1.onmessage, null);
      }
    }
    harness.unmount();
    assert.equal(channels.at(-1)!.port1.closed, true);
  } finally {
    harness.unmount();
    f.bridge.detach();
  }
});

test('binding changes and async completion after removal return unavailable', async () => {
  const f = fixture();
  let resolve!: (value: any) => void;
  f.context.getState = () =>
    new Promise((done) => {
      resolve = done;
    });
  const pending = f.port.request('state.get', {}, 'pending');
  f.invalidate();
  resolve({ revision: 0, values: { notes: 'late' } });
  assert.equal((await pending).error.code, 'E_UNAVAILABLE');
  assert.equal((await f.port.request('composer.insert', { text: 'bad', mode: 'replace' })).error.code, 'E_UNAVAILABLE');
  f.bridge.detach();
  const other = fixture();
  other.context.conversationId = 'other';
  assert.equal((await other.port.request('state.get')).error.code, 'E_UNAVAILABLE');
  other.bridge.detach();
});

test('events accept only validated host payloads and manifest cache separates versions and invalidates', () => {
  const f = fixture();
  f.bridge.emit('messages', { count: 1, lastId: 'one' });
  f.bridge.emit('theme', { theme: 'dark', tokens: { accent: 'red' } });
  f.bridge.emit('run', { running: 'false' });
  f.bridge.emit('settings' as any, {});
  assert.deepEqual(
    f.port.sent.filter((value) => value.type === 'event').map((value) => value.event),
    ['ready', 'messages', 'theme'],
  );
  const original = cachedModManifest(f.context.manifest);
  assert.equal(cachedModManifest(f.context.manifest), original);
  const upgraded = cachedModManifest({ ...f.context.manifest, version: '2.0.0' });
  assert.notEqual(upgraded, original);
  invalidateModManifestCache(f.context.modId);
  assert.notEqual(cachedModManifest(f.context.manifest), original);
  f.bridge.detach();
});

test('ui.chat validates input, workspace layout, visibility and current binding', async () => {
  const f = fixture([]);
  const changes: boolean[] = [];
  const panelInfo = f.context.info();
  f.context.chat = (open) => changes.push(open);
  assert.equal((await f.port.request('ui.chat', { open: true })).error.code, 'E_UNAVAILABLE');
  f.context.info = () => ({ ...panelInfo, slot: 'mainView', layout: 'workspace' });
  assert.equal((await f.port.request('host.info')).result.layout, 'workspace');
  for (const input of [{}, { open: 'true' }, { open: true, extra: 1 }])
    assert.equal((await f.port.request('ui.chat', input)).error.code, 'E_INVALID');
  assert.deepEqual((await f.port.request('ui.chat', { open: true })).result, {});
  assert.deepEqual((await f.port.request('ui.chat', { open: false })).result, {});
  assert.deepEqual(changes, [true, false]);
  f.bridge.emit('chat', { open: true });
  f.bridge.emit('chat', { open: 'bad' });
  assert.deepEqual(
    f.port.sent.filter((item) => item.event === 'chat').map((item) => item.data),
    [{ open: true }],
  );
  f.bridge.emit('visibility', { visible: false });
  assert.equal((await f.port.request('ui.chat', { open: true })).error.code, 'E_UNAVAILABLE');
  f.bridge.emit('visibility', { visible: true });
  f.invalidate();
  assert.equal((await f.port.request('ui.chat', { open: true })).error.code, 'E_UNAVAILABLE');
  assert.deepEqual(changes, [true, false]);
  f.bridge.detach();
});

function serverFixture() {
  const db = new DatabaseSync(':memory:');
  const store = new WorkspaceStore(db, { recoverInterrupted: false });
  store.save('conversation', 'chat', 'project', {
    id: 'chat',
    projectId: 'project',
    title: 'Synthetic',
    createdAt: 'now',
    updatedAt: 'now',
  } satisfies Conversation);
  const modes = new ConversationModes({
    store,
    requireConversation: (id) => {
      const value = store.get<Conversation>('conversation', id);
      if (!value) throw new Error('Missing');
      return value;
    },
    modeSwitchBarrier: () => undefined,
    notify: () => {},
  });
  const mod = manifest();
  modes.import(mod);
  modes.install(mod.id, mod.version);
  const instance = modes.bind('chat', { modeId: mod.id }).instance!;
  const request = (revision = 0) => ({
    instanceId: instance.id,
    expectedRevision: revision,
    action: { type: 'save', values: { notes: 'saved' } },
  });
  return { db, store, modes, mod, instance, request };
}
test('server serializes two window revisions and validates merged state under the transaction', () => {
  const f = serverFixture();
  try {
    let locked = false;
    const save = f.store.save.bind(f.store);
    f.store.save = ((...args: Parameters<typeof save>) => {
      if (args[0] === 'mode-instance') locked = f.db.isTransaction;
      return save(...args);
    }) as typeof save;
    assert.equal(f.modes.action('chat', f.request()).instance?.revision, 1);
    assert.equal(locked, true);
    assert.throws(() => f.modes.action('chat', f.request()), { code: 'E_CONFLICT' });
    assert.throws(
      () => f.modes.action('chat', { ...f.request(1), action: { type: 'save', values: { unknown: 'x' } } }),
      { code: 'E_INVALID' },
    );
    assert.equal(f.modes.view('chat').instance?.revision, 1);
  } finally {
    f.db.close();
  }
});
test('server refuses another conversation instance without changing either state', () => {
  const f = serverFixture();
  try {
    f.store.save('conversation', 'other', 'project', {
      id: 'other',
      projectId: 'project',
      title: 'Other',
      createdAt: 'now',
      updatedAt: 'now',
    } satisfies Conversation);
    f.modes.bind('other', { modeId: f.mod.id });
    assert.throws(() => f.modes.action('other', f.request()), { code: 'E_UNAVAILABLE' });
    assert.equal(f.modes.view('chat').instance?.revision, 0);
    assert.equal(f.modes.view('other').instance?.revision, 0);
  } finally {
    f.db.close();
  }
});
for (const replacement of [false, true])
  for (const writeFirst of [false, true]) {
    test(`server ${replacement ? 'replacement' : 'removal'} racing save: ${writeFirst ? 'write' : 'binding'} first`, () => {
      const f = serverFixture();
      try {
        const change = () => {
          if (replacement) {
            const next = manifest();
            f.modes.import(next);
            f.modes.install(next.id, next.version);
            f.modes.bind('chat', { modeId: next.id });
          } else f.modes.bind('chat', { modeId: null });
        };
        if (writeFirst) {
          f.modes.action('chat', f.request());
          change();
        } else change();
        assert.throws(() => f.modes.action('chat', f.request(writeFirst ? 1 : 0)), { code: 'E_UNAVAILABLE' });
        const stored = f.store.get<{ revision: number }>('mode-instance', f.instance.id)!;
        assert.equal(stored.revision, writeFirst ? 1 : 0);
      } finally {
        f.db.close();
      }
    });
  }

test('shim rejects forged parent messages and accepts one trusted parent port per load', async () => {
  const listeners = new Map<string, (event: unknown) => void>();
  const parent = {};
  const sandbox = createContext({
    parent,
    setTimeout,
    clearTimeout,
    addEventListener: (event: string, callback: (event: unknown) => void) => listeners.set(event, callback),
    removeEventListener: (event: string) => listeners.delete(event),
  });
  runInContext('window = globalThis', sandbox);
  runInContext(MOD_CLIENT_SHIM, sandbox);
  const accept = listeners.get('message')!;
  const forged = new Port(),
    real = new Port(),
    duplicate = new Port();
  const connect = (source: unknown, port: Port, isTrusted = true) => ({
    source,
    isTrusted,
    data: { pugport: 2, type: 'connect' },
    ports: [port],
  });
  accept(connect({}, forged));
  assert.equal(forged.onmessage, null);
  accept(connect(parent, forged, false));
  assert.equal(forged.onmessage, null);
  accept(connect(parent, real));
  assert.equal(typeof real.onmessage, 'function');
  accept(connect(parent, duplicate));
  assert.equal(duplicate.onmessage, null);
  real.onmessage!({ data: { type: 'event', event: 'ready', data: {} } } as MessageEvent);
  const pending = runInContext('pugport.state.get()', sandbox) as Promise<unknown>;
  await new Promise((resolve) => setImmediate(resolve));
  const request = real.sent.find((value) => value.method === 'state.get');
  assert.equal(request.method, 'state.get');
  real.onmessage!({ data: { type: 'response', id: request.id, result: { revision: 0, values: {} } } } as MessageEvent);
  assert.deepEqual(await pending, { revision: 0, values: {} });
  const unavailable = runInContext('pugport.state.get()', sandbox) as Promise<unknown>;
  const rejected = assert.rejects(unavailable, { code: 'E_UNAVAILABLE' });
  await new Promise((resolve) => setImmediate(resolve));
  listeners.get('pagehide')!({});
  await rejected;
  assert.equal(real.closed, true);
  assert.throws(() => runInContext("pugport.on('settings',()=>{})", sandbox), /Invalid Mod event/);
  // A navigation replaces the realm, but preserves the parent WindowProxy identity.
  const renewed = createContext({
    parent,
    setTimeout,
    clearTimeout,
    addEventListener: (event: string, callback: (event: unknown) => void) => listeners.set(event, callback),
    removeEventListener: (event: string) => listeners.delete(event),
  });
  runInContext('window = globalThis', renewed);
  runInContext(MOD_CLIENT_SHIM, renewed);
  const renewedPort = new Port();
  listeners.get('message')!(connect(parent, renewedPort));
  assert.equal(renewedPort.sent.filter((value) => value.id === 'handshake').length, 1);
  assert.notEqual(renewed.pugport, sandbox.pugport);
  accept(connect(parent, duplicate));
  assert.equal(duplicate.onmessage, null, 'old document stays detached');
  listeners.get('pagehide')!({});
  assert.equal(renewedPort.closed, true);
});

test('srcdoc encodes adversarial raw-text parser sequences without changing valid author code', () => {
  const nonce = 'a'.repeat(48);
  const payload = '</ScRiPt><script>escape()</script><!--</STYLE>\u2028\u2029&';
  const entry = {
    html: `<div>${payload}</div>`,
    css: `/*${payload}*/ body {color:red}`,
    js: `globalThis.authorResult = ${JSON.stringify(payload)};`,
  };
  const document = buildModSrcDoc(entry, nonce);
  assert.equal((document.match(/<script\b/gi) ?? []).length, 1);
  assert.equal((document.match(/<\/script\s*>/gi) ?? []).length, 1);
  assert.equal(document.includes(payload), false);
  assert.match(document, /connect-src 'none'/);
  const html = {
    innerHTML: '',
    replaceChildren(content: { innerHTML: string }) {
      this.innerHTML = content.innerHTML;
    },
  };
  const styles: any[] = [];
  const scripts: any[] = [];
  const sandbox = createContext({
    parent: {},
    addEventListener: () => {},
    removeEventListener: () => {},
    setTimeout,
    clearTimeout,
    document: {
      getElementById: () => html,
      createElement: (tag: string) =>
        tag === 'template'
          ? {
              content: { innerHTML: '', querySelectorAll: () => [] },
              set innerHTML(value: string) {
                this.content.innerHTML = value;
              },
            }
          : { tag },
      head: { append: (value: unknown) => styles.push(value) },
      body: { append: (value: unknown) => scripts.push(value) },
    },
  });
  runInContext('window = globalThis', sandbox);
  const wrapper = document.match(/<script nonce="[a-f0-9]+">([\s\S]*)<\/script>/)![1]!;
  runInContext(wrapper, sandbox);
  assert.equal(html.innerHTML, entry.html);
  assert.equal(styles[0].textContent, entry.css);
  assert.equal(scripts[0].textContent, entry.js);
  runInContext(scripts[0].textContent, sandbox);
  assert.equal(sandbox.authorResult, payload);
  assert.throws(() => buildModSrcDoc(entry, 'bad" nonce'), /Invalid Mod nonce/);
});

test('debug channel: frame lines and refused requests are recorded; a detached frame records nothing', async () => {
  const f = fixture();
  const recorded: { level: string; source: string; text: string; dropped?: number }[] = [];
  f.context.diagnostic = ({ at, ...entry }) => {
    assert.ok(Math.abs(at - Date.now()) < 5000, 'the host stamps its own time');
    recorded.push(entry);
  };
  const diag = (data: Record<string, unknown>) =>
    f.port.onmessage?.({ data: { pugport: 2, type: 'diag', at: 1, ...data } } as MessageEvent);
  diag({ level: 'error', text: 'TypeError: notes is undefined (line 88:3)' });
  diag({ level: 'log', text: 'x'.repeat(500), dropped: 4 });
  diag({ level: 'debug', text: 'not a level' });
  diag({ level: 'warn', text: 'extra field', extra: true });
  await f.port.request('nope.method');
  await f.port.request('messages.list', { limit: 'many' });
  await f.port.request('model.run', { prompt: 'x' });
  assert.deepEqual(recorded, [
    { level: 'error', source: 'frame', text: 'TypeError: notes is undefined (line 88:3)' },
    { level: 'log', source: 'frame', text: 'x'.repeat(200), dropped: 4 },
    { level: 'error', source: 'bridge', text: 'nope.method refused: E_INVALID' },
    { level: 'error', source: 'bridge', text: 'messages.list refused: E_INVALID' },
    { level: 'error', source: 'bridge', text: 'model.run refused: E_PERMISSION' },
  ]);
  const before = recorded.length;
  const stale = f.port.onmessage;
  f.bridge.detach();
  stale?.({ data: { pugport: 2, type: 'diag', level: 'error', text: 'late', at: 1 } } as MessageEvent);
  f.invalidate();
  assert.equal(recorded.length, before, 'nothing arrives from a detached frame');
});
