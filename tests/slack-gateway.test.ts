import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express, { type ErrorRequestHandler } from 'express';
import { SlackConfigStore } from '../src/server/slack-config.ts';
import { SlackConnectionLock } from '../src/server/slack-connection-lock.ts';
import { nodeSlackHost, slackConfigStoreFor } from '../src/server/node/slack-host.ts';
import { escapeSlack, splitForSlack } from '../src/server/slack-context.ts';
import { SlackGateway, slackText, type SlackSocket, type SlackTaskRunner } from '../src/server/slack-gateway.ts';
import { slackRoutes } from '../src/server/slack-routes.ts';
import { slackAppManifest } from '../src/shared/slack-gateway.ts';
import { listenForFetch } from './helpers/fetch-port.ts';

// Synthetic tokens only; nothing here reaches Slack.
const APP = 'xapp-1-A0SYNTH-0000000000-syntheticappsecretAAAA';
// Built at run time so secret scanners do not mistake the fixture for a real token.
const BOT = ['xoxb', '0000000000', '0000000000', 'syntheticbotsecretBBBB'].join('-');
const NOW = Date.parse('2026-10-10T12:00:00Z');
const ts = (secondsAgo: number, n = 100) => `${NOW / 1000 - secondsAgo}.000${n}`;
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

test('a handed-over node and same-machine desktop open only one Slack socket', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'pugport-slack-roles-'));
  const previous = process.env.COMBORUNNER_SECRETS_DIR;
  process.env.COMBORUNNER_SECRETS_DIR = dir;
  const sockets: FakeSocket[] = [];
  let opens = 0;
  const build = (store: SlackConfigStore) =>
    new SlackGateway({
      store,
      fetch: (async (url) => {
        if (String(url).endsWith('/auth.test')) return json({ ok: true, user_id: 'UBOT' });
        assert.ok(String(url).endsWith('/apps.connections.open'));
        opens++;
        return json({ ok: true, url: 'wss://example.invalid/socket' });
      }) as typeof fetch,
      createSocket: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      },
    });
  const nodeStore = slackConfigStoreFor('node');
  const node = build(nodeStore);
  const desktopStore = slackConfigStoreFor('desktop');
  await desktopStore.update((config) => Object.assign(config, { enabled: true, appToken: APP, botToken: BOT }));
  const desktop = build(desktopStore);
  t.after(async () => {
    await node.close();
    await desktop.close();
    if (previous === undefined) delete process.env.COMBORUNNER_SECRETS_DIR;
    else process.env.COMBORUNNER_SECRETS_DIR = previous;
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  const host = nodeSlackHost({
    store: nodeStore,
    gateway: node,
    flagFile: join(dir, 'slack-host.json'),
    desktopName: '桌面版 PugPort',
  });
  await host.host({ host: true, appToken: APP, botToken: BOT, users: [] });
  await node.start();
  await desktop.start();
  await waitFor(() => sockets.length === 1, 'single socket');
  await waitFor(async () => !!(await desktop.view()).hostedBy || !!(await node.view()).hostedBy, 'lock standby');
  assert.deepEqual({ opens, sockets: sockets.length }, { opens: 1, sockets: 1 });
});

test('standby waits for socket close and refuses to confirm a failed release', async (t) => {
  const f = await fixture(t);
  await f.gateway.start();
  await waitFor(() => f.sockets.length === 1, 'socket');
  const socket = f.sockets[0]!;
  const close = socket.close.bind(socket);
  t.mock.method(socket, 'close', () => {});
  await assert.rejects(f.gateway.setStandby('node'), /Slack.*close|Slack.*关闭/);
  assert.equal(socket.closed, false);
  close();
  await f.gateway.setStandby('node');
});

test('failed release before socket creation remains available for standby cleanup', async (t) => {
  const release = SlackConnectionLock.prototype.release;
  let stranded: SlackConnectionLock | undefined;
  t.mock.method(SlackConnectionLock.prototype, 'release', function (this: SlackConnectionLock) {
    if (!stranded && this.owns()) {
      stranded = this;
      throw new Error('synthetic close marker write failure');
    }
    return release.call(this);
  });
  const f = await fixture(t, {
    gateway: {
      retryDelaysMs: [60_000],
      fetch: (async (url) =>
        json(
          String(url).endsWith('/auth.test') ? { ok: true, user_id: 'UBOT' } : { ok: false, error: 'invalid_auth' },
        )) as typeof fetch,
    },
  });
  t.after(() => {
    if (stranded) release.call(stranded);
  });
  await f.gateway.start();
  await waitFor(() => !!stranded, 'failed pre-socket release');
  await f.gateway.setStandby('node');
  assert.equal(stranded!.owns(), false, 'standby must retry the release before confirming');
});

for (const crash of ['dead pid', 'stale heartbeat'] as const)
  test(`two config roots share one app lock; ${crash} is taken over exactly once`, async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const dir = await mkdtemp(join(tmpdir(), 'slack-machine-lock-'));
    const directory = join(dir, 'secrets');
    const sockets: (FakeSocket & { pid: number })[] = [];
    const gateways: SlackGateway[] = [];
    let now = Date.now();
    const dead = new Set<number>();
    const make = async (pid: number, appToken = APP) => {
      const store = new SlackConfigStore(join(dir, `root-${pid}`, 'slack.json'));
      await store.update((config) => Object.assign(config, { enabled: true, appToken, botToken: BOT }));
      const gateway = new SlackGateway({
        store,
        role: pid === 101 ? 'desktop' : 'node',
        lock: { directory, pid, now: () => now, isAlive: (id) => !dead.has(id) },
        retryDelaysMs: [60_000],
        fetch: (async (url) =>
          json(
            String(url).endsWith('/auth.test')
              ? { ok: true, user_id: 'UBOT' }
              : { ok: true, url: 'wss://example.invalid/socket' },
          )) as typeof fetch,
        createSocket: (url) => {
          const socket = Object.assign(new FakeSocket(url), { pid });
          sockets.push(socket);
          return socket;
        },
      });
      gateways.push(gateway);
      return gateway;
    };
    t.after(async () => {
      for (const socket of sockets) if (socket.closed) socket.finishClose();
      for (const gateway of gateways) await gateway.close();
      await rm(dir, { recursive: true, force: true, maxRetries: 5 });
    });
    const first = await make(101);
    const second = await make(102, APP.replace('syntheticappsecretAAAA', 'rotatedsecretCCCC'));
    const third = await make(103);
    await first.start();
    await waitFor(() => sockets.length === 1, 'first process');
    await second.start();
    await waitFor(async () => !!(await second.view()).hostedBy, 'live holder blocks second root');
    assert.equal(sockets.length, 1);
    if (crash === 'dead pid') {
      // The OS closed the dead process's socket without running its JS close handler.
      dead.add(101);
      sockets[0]!.closed = true;
    } else {
      now += 91_000;
      await second.start();
      await waitFor(async () => {
        const lock = (await readdir(directory)).find((file) => file.endsWith('.lock'))!;
        return (await readdir(join(directory, lock))).some((file) => file.startsWith('takeover-'));
      }, 'stale holder close request');
      assert.equal(sockets.length, 1, 'stale live holder still blocks a new socket');
      t.mock.timers.tick(30_000);
      await waitFor(() => sockets[0]!.closed, 'stale holder closes before takeover');
    }
    await Promise.all([second.start(), third.start()]);
    await waitFor(() => sockets.length === 2, 'one replacement socket');
    await waitFor(async () => !!(await second.view()).hostedBy || !!(await third.view()).hostedBy, 'takeover loser');
    assert.equal(sockets.filter((socket) => !socket.closed).length, 1);
    const lock = (await readdir(directory)).find((file) => file.endsWith('.lock'))!;
    const record = await readFile(join(directory, lock, 'owner.json'), 'utf8');
    assert.doesNotMatch(record + lock, /xapp-|xoxb-|syntheticappsecret|rotatedsecret/);
    const owner = JSON.parse(record);
    assert.ok([102, 103].includes(owner.pid));
    assert.equal(owner.role, 'node');
    assert.equal(owner.startedAt, now);
    assert.equal(owner.heartbeatAt, now);
    sockets[0]!.finishClose();
    await first.close();
    assert.equal(
      await readFile(join(directory, lock, 'owner.json'), 'utf8'),
      record,
      'old owner cannot release its successor',
    );
  });

for (const action of ['reconnect', 'late close', 'standby', 'disable', 'close'] as const)
  test(`lost lock recovers after the requesting peer exits: ${action}`, async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const wallTime = Date.now;
    let elapsed = 0;
    const f = await fixture(t, { gateway: { retryDelaysMs: [25, 50] } });
    // Pause only the lock heartbeat; all sockets and configuration remain synthetic.
    t.mock.method(Date, 'now', () => wallTime() + elapsed);
    await f.gateway.start();
    await waitFor(() => f.sockets.length === 1, 'original holder');
    const peer = new SlackConnectionLock({ directory: f.dir, role: 'node' });
    t.after(() => peer.release());
    elapsed += 91_000;
    assert.equal(await peer.acquire('A0SYNTH', () => {}), false);
    peer.release(); // The requester exits without acquiring or opening a socket.
    const socket = f.sockets[0]!;
    let closeRequested = false;
    t.mock.method(socket, 'close', () => {
      closeRequested = true;
    });
    t.mock.timers.tick(30_000);
    await waitFor(() => closeRequested, 'holder receives takeover request');
    await new Promise((resolve) => setTimeout(resolve, action === 'late close' ? 3200 : 100));
    assert.equal(f.sockets.length, 1, 'must wait for confirmed close before reacquiring');
    let stopped: Promise<unknown> | undefined;
    if (action === 'standby') stopped = f.gateway.setStandby('node');
    if (action === 'disable') stopped = f.gateway.setEnabled(false);
    if (action === 'close') stopped = f.gateway.close();
    socket.finishClose();
    await stopped;
    // Let waitFor use wall time again, including on the unfixed implementation.
    t.mock.restoreAll();
    if (action === 'reconnect' || action === 'late close') {
      await waitFor(() => f.sockets.length === 2, 'automatic lock re-acquire without start');
      f.sockets[1]!.receive({ type: 'hello' });
      assert.equal((await f.gateway.view()).status, 'connected');
      assert.equal(f.sockets.filter((item) => !item.closed).length, 1);
    } else {
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(f.sockets.length, 1, 'explicit stop cancels recovery');
    }
  });

test(
  'Slack lock files are owner-only on POSIX',
  { skip: process.platform === 'win32' ? 'Windows uses ACLs, not POSIX mode bits' : false },
  async (t) => {
    const f = await fixture(t);
    await f.gateway.start();
    await waitFor(() => f.sockets.length === 1, 'socket');
    const lock = (await readdir(f.dir)).find((file) => file.endsWith('.lock'))!;
    assert.equal((await stat(join(f.dir, lock))).mode & 0o777, 0o700);
    assert.equal((await stat(join(f.dir, lock, 'owner.json'))).mode & 0o777, 0o600);
  },
);

class FakeSocket implements SlackSocket {
  sent: unknown[] = [];
  closed = false;
  private listeners = new Map<string, ((event: any) => void)[]>();
  constructor(readonly url: string) {}
  addEventListener(type: string, listener: (event: any) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    if (this.closed) return;
    this.finishClose();
  }
  finishClose() {
    this.closed = true;
    for (const listener of this.listeners.get('close') ?? []) listener({ code: 1000 });
  }
  /** Slack drops the connection without being asked. */
  drop() {
    this.close();
  }
  receive(frame: unknown) {
    for (const listener of this.listeners.get('message') ?? []) listener({ data: JSON.stringify(frame) });
  }
}

type Call = { method: string; params: Record<string, string>; authorization: string; url: string };

async function waitFor(check: () => unknown, label: string) {
  // setImmediate instead of short timers: Windows rounds those up to ~15 ms.
  for (const deadline = Date.now() + 10_000; Date.now() < deadline;) {
    if (await check()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail(`timed out waiting for ${label}`);
}

let envelopes = 0;
const eventEnvelope = (event: Record<string, unknown>) => {
  const id = `env-${++envelopes}`;
  return {
    envelope_id: id,
    type: 'events_api',
    accepts_response_payload: false,
    retry_attempt: 0,
    payload: {
      type: 'event_callback',
      event_id: `Ev${envelopes}`,
      authorizations: [{ user_id: 'UBOT', is_bot: true }],
      event,
    },
  };
};

function fakeTasks(answer: (input: any) => string | Promise<string> = () => 'Synthetic answer.') {
  const dispatched: any[] = [];
  const runner: SlackTaskRunner & { dispatched: any[] } = {
    dispatched,
    async dispatch(input) {
      dispatched.push(input);
      return {
        taskId: `task-${dispatched.length}`,
        conversationId: input.conversationId ?? `conv-${dispatched.length}`,
      };
    },
    async result(taskId) {
      const input = dispatched[Number(taskId.split('-')[1]) - 1];
      return { status: 'completed', result: await answer(input) };
    },
  };
  return runner;
}

async function fixture(
  t: TestContext,
  options: {
    tasks?: SlackTaskRunner;
    paired?: boolean;
    history?: Record<string, unknown>;
    replies?: Record<string, unknown>;
    gateway?: Partial<ConstructorParameters<typeof SlackGateway>[0]>;
    /** chat.update never answers, like a network that hangs. */
    hangUpdates?: boolean;
  } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), 'pugport-slack-'));
  const file = join(dir, 'slack-gateway.json');
  const store = new SlackConfigStore(file);
  await store.update((config) => {
    config.enabled = true;
    config.appToken = APP;
    config.botToken = BOT;
    if (options.paired !== false) config.users = [{ id: 'UOWNER', name: 'Owner', pairedAt: '2026-10-01T00:00:00Z' }];
  });
  const calls: Call[] = [];
  const sockets: FakeSocket[] = [];
  const logs: string[] = [];
  let posted = 0;
  const names: Record<string, string> = { UOWNER: 'Owner', UALICE: 'Alice', USTRANGER: 'Stranger', UBOT: 'pugport' };
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const method = String(url).replace('https://slack.com/api/', '');
    const params = Object.fromEntries(new URLSearchParams(init.body as URLSearchParams));
    calls.push({ method, params, authorization: (init.headers as Record<string, string>).Authorization, url });
    switch (method) {
      case 'auth.test':
        return json({ ok: true, user_id: 'UBOT', user: 'pugport', team: 'Synthetic Team', bot_id: 'BBOT' });
      case 'apps.connections.open':
        return json({ ok: true, url: `wss://wss.example.invalid/link/?ticket=${calls.length}` });
      case 'chat.postMessage':
        return json({ ok: true, ts: `${NOW / 1000}.9${String(++posted).padStart(5, '0')}` });
      case 'chat.update':
        return options.hangUpdates ? new Promise<Response>(() => {}) : json({ ok: true });
      case 'users.info':
        return json({ ok: true, user: { name: params.user, profile: { display_name: names[params.user!] ?? '' } } });
      case 'conversations.history':
        return json(options.history?.[params.channel!] ?? { ok: true, messages: [] });
      case 'conversations.replies':
        return json(options.replies?.[params.channel!] ?? { ok: true, messages: [] });
      default:
        return json({ ok: false, error: 'unknown_method' });
    }
  }) as unknown as typeof fetch;
  const build = (configStore: SlackConfigStore) =>
    new SlackGateway({
      store: configStore,
      tasks: options.tasks ?? fakeTasks(),
      fetch: fetchImpl,
      createSocket: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      },
      log: (line) => logs.push(line),
      now: () => NOW,
      retryDelaysMs: [0],
      ...options.gateway,
    });
  const posts = () => calls.filter((call) => call.method === 'chat.postMessage');
  const updates = () => calls.filter((call) => call.method === 'chat.update');
  const f = {
    gateway: build(store),
    store,
    dir,
    file,
    calls,
    sockets,
    logs,
    posts,
    updates,
    async connect() {
      const before = sockets.length;
      await f.gateway.start();
      await waitFor(() => sockets.length === before + 1, 'socket');
      sockets.at(-1)!.receive({ type: 'hello', num_connections: 1 });
      assert.equal((await f.gateway.view()).status, 'connected');
      return sockets.at(-1)!;
    },
    /** PugPort quits and starts again with the same settings folder. */
    async restart() {
      await f.gateway.close();
      f.gateway = build(new SlackConfigStore(file));
    },
  };
  t.after(async () => {
    await f.gateway.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  return f;
}

test('a thread mention is acknowledged, run with the thread as context, and answered in the same thread', async (t) => {
  const tasks = fakeTasks();
  const root = ts(600);
  const f = await fixture(t, {
    tasks,
    replies: {
      C1: {
        ok: true,
        messages: [
          { ts: root, user: 'UALICE', text: 'Should we ship on Friday? &lt;draft&gt;' },
          { ts: ts(300), user: 'UOWNER', text: 'I think <@UALICE> is right, see <https://example.com|the plan>' },
          { ts: ts(200), user: 'UALICE', subtype: 'channel_join', text: 'joined' },
          { ts: ts(10), user: 'UOWNER', text: '<@UBOT> what did we decide?' },
        ],
      },
    },
  });
  const socket = await f.connect();
  assert.equal(f.sockets[0]!.url.startsWith('wss://'), true);
  const frame = eventEnvelope({
    type: 'app_mention',
    user: 'UOWNER',
    channel: 'C1',
    channel_type: 'channel',
    text: '<@UBOT> what did we decide?',
    ts: ts(10),
    thread_ts: root,
  });
  socket.receive(frame);
  assert.deepEqual(socket.sent, [{ envelope_id: frame.envelope_id }], 'acknowledged before any work');
  await waitFor(() => f.updates().length === 1, 'answer');

  const [ack] = f.posts();
  assert.equal(ack!.params.channel, 'C1');
  assert.equal(ack!.params.thread_ts, root);
  assert.equal(ack!.params.text, slackText.en.working);
  assert.equal(ack!.authorization, `Bearer ${BOT}`);
  const answer = f.updates()[0]!;
  assert.equal(answer.params.ts, `${NOW / 1000}.900001`, 'the working note becomes the answer');
  assert.equal(answer.params.text, 'Synthetic answer.');

  assert.equal(tasks.dispatched.length, 1);
  const input = tasks.dispatched[0];
  assert.equal(input.caller, 'slack:UOWNER');
  assert.equal(input.readOnly, true);
  assert.equal(input.untrusted, true, "Alice's messages make the task tool-less");
  assert.equal(input.title, 'what did we decide?');
  assert.equal(input.conversationId, undefined);
  assert.match(input.task, /Request sent from Slack by Owner/);
  assert.match(input.task, /Messages in this Slack thread, oldest first:/);
  assert.match(input.task, /\] Alice: Should we ship on Friday\? <draft>/);
  assert.match(input.task, /\] Owner: I think @Alice is right, see the plan \(https:\/\/example\.com\)/);
  assert.doesNotMatch(input.task, /joined/);
  assert.equal(input.task.match(/what did we decide/g)?.length, 1, 'the request itself is not repeated as context');
  assert.match(input.task, /Request from Owner:\nwhat did we decide\?$/);

  // A follow-up in the same thread continues the conversation with only what was said since.
  socket.receive(
    eventEnvelope({
      type: 'app_mention',
      user: 'UOWNER',
      channel: 'C1',
      text: '<@UBOT> and who owns it?',
      ts: ts(5),
      thread_ts: root,
    }),
  );
  await waitFor(() => f.updates().length === 2, 'second answer');
  assert.equal(tasks.dispatched[1].conversationId, 'conv-1');
  assert.match(tasks.dispatched[1].task, /^Follow-up request sent from Slack by Owner/);
  const replies = f.calls.filter((call) => call.method === 'conversations.replies');
  assert.equal(replies[1]!.params.oldest, ts(10));
  assert.doesNotMatch(tasks.dispatched[1].task, /Should we ship/);
  // Nothing new from others; PugPort itself keeps a conversation that once had outside words tool-less.
  assert.equal(tasks.dispatched[1].untrusted, undefined);
});

test('top-level channel mentions read recent channel history and DMs read the DM', async (t) => {
  const tasks = fakeTasks();
  const f = await fixture(t, {
    tasks,
    history: {
      C2: { ok: true, messages: [{ ts: ts(60), user: 'UALICE', text: 'Budget is 10k' }] },
      D1: { ok: true, messages: [{ ts: ts(90), user: 'UOWNER', text: 'earlier note' }] },
    },
  });
  const socket = await f.connect();
  socket.receive(
    eventEnvelope({ type: 'app_mention', user: 'UOWNER', channel: 'C2', text: '<@UBOT> summarize', ts: ts(1) }),
  );
  await waitFor(() => tasks.dispatched.length === 1, 'channel task');
  const history = f.calls.find((call) => call.method === 'conversations.history')!;
  assert.equal(history.params.channel, 'C2');
  assert.equal(history.params.limit, '30');
  assert.equal(Number(history.params.oldest), NOW / 1000 - 86_400);
  assert.match(
    tasks.dispatched[0].task,
    /Messages in this channel \(last 24 hours\)[^\n]*:\n\[[^\]]+\] Alice: Budget is 10k/,
  );
  await waitFor(() => f.updates().length === 1, 'channel answer');
  assert.equal(f.posts()[0]!.params.thread_ts, ts(1), 'a top-level mention is answered in a thread under it');

  socket.receive(
    eventEnvelope({
      type: 'message',
      channel_type: 'im',
      user: 'UOWNER',
      channel: 'D1',
      text: 'hello there',
      ts: ts(2),
    }),
  );
  await waitFor(() => tasks.dispatched.length === 2, 'dm task');
  assert.match(tasks.dispatched[1].task, /Messages in this direct message[^\n]*:\n\[[^\]]+\] Owner: earlier note/);
  assert.equal(tasks.dispatched[0].untrusted, true, 'channel history written by Alice');
  assert.equal(tasks.dispatched[1].untrusted, undefined, "the owner's own DM keeps the ordinary read-only mode");
});

test('another person’s display name or the channel viewed in the assistant panel also make a DM task tool-less', async (t) => {
  const tasks = fakeTasks();
  const f = await fixture(t, {
    tasks,
    history: {
      D1: { ok: true, messages: [{ ts: ts(90), user: 'UOWNER', text: 'remind me what <@UALICE> asked' }] },
      C7: { ok: true, messages: [{ ts: ts(80), user: 'UALICE', text: 'Ship it on Friday' }] },
    },
  });
  const socket = await f.connect();
  socket.receive(
    eventEnvelope({
      type: 'message',
      channel_type: 'im',
      user: 'UOWNER',
      channel: 'D1',
      text: 'what was it?',
      ts: ts(2),
    }),
  );
  await waitFor(() => tasks.dispatched.length === 1, 'dm task');
  assert.match(tasks.dispatched[0].task, /Owner: remind me what @Alice asked/);
  assert.equal(tasks.dispatched[0].untrusted, true, 'Alice chose her own display name');

  socket.receive(
    eventEnvelope({
      type: 'assistant_thread_started',
      assistant_thread: { channel_id: 'D2', thread_ts: ts(50), context: { channel_id: 'C7' } },
    }),
  );
  socket.receive(
    eventEnvelope({
      type: 'message',
      channel_type: 'im',
      user: 'UOWNER',
      channel: 'D2',
      text: 'summarize this channel',
      ts: ts(3),
      thread_ts: ts(50),
    }),
  );
  await waitFor(() => tasks.dispatched.length === 2, 'assistant panel task');
  assert.match(tasks.dispatched[1].task, /Alice: Ship it on Friday/);
  assert.equal(tasks.dispatched[1].untrusted, true);
});

test('when no executor can answer tool-less, the owner gets one plain line in their language', async (t) => {
  const tasks: SlackTaskRunner = {
    async dispatch() {
      return { taskId: 'task-1', conversationId: 'conv-1' };
    },
    async result() {
      return { status: 'blocked', error: 'router reason', code: 'no-safe-executor' };
    },
  };
  const f = await fixture(t, {
    tasks,
    history: { C3: { ok: true, messages: [{ ts: ts(60), user: 'UALICE', text: 'hi' }] } },
  });
  const socket = await f.connect();
  socket.receive(
    eventEnvelope({ type: 'app_mention', user: 'UOWNER', channel: 'C3', text: '<@UBOT> summarize', ts: ts(1) }),
  );
  await waitFor(() => f.updates().length === 1, 'answer');
  assert.equal(f.updates()[0]!.params.text, escapeSlack(slackText.en.noSafeExecutor));
});

test('Slack disconnect requests and dropped sockets reconnect with a fresh URL', async (t) => {
  const f = await fixture(t);
  const first = await f.connect();
  first.receive({ type: 'disconnect', reason: 'refresh_requested', debug_info: { host: 'x' } });
  await waitFor(() => f.sockets.length === 2, 'refreshed socket');
  assert.equal(first.closed, true);
  assert.notEqual(f.sockets[1]!.url, first.url);
  assert.equal(f.calls.filter((call) => call.method === 'apps.connections.open').length, 2);
  assert.equal(f.calls.filter((call) => call.method === 'auth.test').length, 1, 'identity is kept');
  // Frames on the replaced socket are ignored.
  first.receive(eventEnvelope({ type: 'app_mention', user: 'UOWNER', channel: 'C1', text: '<@UBOT> hi', ts: ts(1) }));
  assert.deepEqual(first.sent.length, 0);
  f.sockets[1]!.receive({ type: 'hello' });
  assert.equal((await f.gateway.view()).status, 'connected');

  f.sockets[1]!.drop();
  assert.equal((await f.gateway.view()).status, 'connecting');
  await waitFor(() => f.sockets.length === 3, 'socket after drop');
  f.sockets[2]!.receive({ type: 'hello' });
  assert.equal((await f.gateway.view()).status, 'connected');

  f.sockets[2]!.receive({ type: 'disconnect', reason: 'link_disabled' });
  const view = await f.gateway.view();
  assert.equal(view.status, 'error');
  assert.match(view.error!, /Socket Mode/);
  await waitFor(() => f.sockets.length === 4, 'retry after link_disabled');
});

test('an unpaired person gets one polite line and nothing is read or run', async (t) => {
  const tasks = fakeTasks();
  const f = await fixture(t, { tasks, paired: false });
  const socket = await f.connect();
  const mention = (n: number) =>
    eventEnvelope({
      type: 'app_mention',
      user: 'USTRANGER',
      channel: 'C1',
      text: '<@UBOT> summarize this thread',
      ts: ts(10, n),
      thread_ts: ts(600),
    });
  socket.receive(mention(1));
  socket.receive(mention(2));
  socket.receive(
    eventEnvelope({
      type: 'message',
      channel_type: 'im',
      user: 'USTRANGER',
      channel: 'D9',
      text: 'run this',
      ts: ts(3),
    }),
  );
  await waitFor(() => f.posts().length >= 1, 'refusal');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(socket.sent.length, 3, 'every envelope is still acknowledged');
  assert.equal(f.posts().length, 1, 'one refusal per person per cooldown');
  assert.equal(f.posts()[0]!.params.text, escapeSlack(slackText.en.refused));
  assert.equal(f.posts()[0]!.params.thread_ts, ts(600));
  assert.equal(tasks.dispatched.length, 0);
  assert.deepEqual(
    f.calls.filter((call) => /^conversations\.|^users\./.test(call.method)),
    [],
    'nothing is read for an unpaired person',
  );
});

test('pairing: a one-time code sent by DM authorizes that Slack user', async (t) => {
  const tasks = fakeTasks();
  const f = await fixture(t, { tasks, paired: false });
  const socket = await f.connect();
  const dm = (user: string, text: string, n: number, channel = 'D1') =>
    socket.receive(eventEnvelope({ type: 'message', channel_type: 'im', user, channel, text, ts: ts(50 - n) }));
  dm('UALICE', 'pair ABCDEF', 1);
  await waitFor(() => f.posts().length === 1, 'no code yet');
  assert.equal(f.posts()[0]!.params.text, slackText.en.pairExpired);

  const { code, expiresAt } = f.gateway.createPairingCode();
  assert.match(code, /^[A-HJKMNP-Z2-9]{6}$/);
  assert.equal(expiresAt, new Date(NOW + 10 * 60 * 1000).toISOString());
  assert.equal((await f.gateway.view()).pairingExpiresAt, expiresAt);
  const wrong = code.startsWith('A') ? 'BBBBBB' : 'AAAAAA';
  dm('UALICE', `pair ${wrong}`, 2);
  await waitFor(() => f.posts().length === 2, 'wrong code');
  assert.equal(f.posts()[1]!.params.text, slackText.en.pairWrong);

  // A correct code posted in a channel is void.
  socket.receive(
    eventEnvelope({ type: 'app_mention', user: 'UALICE', channel: 'C1', text: `<@UBOT> pair ${code}`, ts: ts(30) }),
  );
  await waitFor(() => f.posts().length === 3, 'channel pairing');
  assert.equal(f.posts()[2]!.params.text, slackText.en.pairOnlyInDm);
  dm('UALICE', `pair ${code}`, 4);
  await waitFor(() => f.posts().length === 4, 'voided code');
  assert.equal(f.posts()[3]!.params.text, slackText.en.pairExpired);

  const fresh = f.gateway.createPairingCode().code;
  dm('UALICE', `配对 ${fresh.toLowerCase()}`, 5);
  await waitFor(() => f.posts().length === 5, 'paired');
  assert.equal(f.posts()[4]!.params.text, slackText.zh.pairDone);
  const view = await f.gateway.view();
  assert.deepEqual(
    view.users.map(({ id, name }) => ({ id, name })),
    [{ id: 'UALICE', name: 'Alice' }],
  );
  assert.equal(view.pairingExpiresAt, undefined, 'the code is used up');
  assert.match(await readFile(f.file, 'utf8'), /"UALICE"/, 'saved locally');

  dm('UOWNER', `pair ${fresh}`, 6);
  await waitFor(() => f.posts().length === 6, 'reused code');
  assert.equal(f.posts()[5]!.params.text, slackText.en.pairExpired);

  dm('UALICE', 'what is on my list?', 7);
  await waitFor(() => tasks.dispatched.length === 1, 'paired user runs a task');
  assert.equal(tasks.dispatched[0].caller, 'slack:UALICE');

  await f.gateway.removeUser('UALICE');
  assert.deepEqual((await f.gateway.view()).users, []);
});

test('five wrong guesses void a pairing code', async (t) => {
  const f = await fixture(t, { paired: false });
  const socket = await f.connect();
  const { code } = f.gateway.createPairingCode();
  const wrong = code.startsWith('A') ? 'BBBBBB' : 'AAAAAA';
  for (let n = 1; n <= 5; n++)
    socket.receive(
      eventEnvelope({
        type: 'message',
        channel_type: 'im',
        user: 'USTRANGER',
        channel: 'D9',
        text: `pair ${wrong}`,
        ts: ts(n),
      }),
    );
  await waitFor(() => f.posts().length === 5, 'guesses');
  assert.equal((await f.gateway.view()).pairingExpiresAt, undefined);
});

test('bot posts, edits, own messages and mentions inside DMs are ignored; the mention is stripped', async (t) => {
  const tasks = fakeTasks();
  const f = await fixture(t, { tasks });
  const socket = await f.connect();
  const base = { user: 'UOWNER', channel: 'D1', channel_type: 'im', text: 'hi', type: 'message' };
  socket.receive(eventEnvelope({ ...base, ts: ts(9), bot_id: 'BOTHER' }));
  socket.receive(eventEnvelope({ ...base, ts: ts(8), subtype: 'message_changed' }));
  socket.receive(eventEnvelope({ ...base, ts: ts(7), user: 'UBOT' }));
  socket.receive(eventEnvelope({ ...base, ts: ts(6), type: 'app_mention', text: '<@UBOT> hi' }));
  socket.receive(eventEnvelope({ ...base, ts: ts(5), channel: 'C1', channel_type: 'channel' }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(tasks.dispatched.length, 0);
  assert.equal(f.posts().length, 0);
  // The same event delivered twice (Slack retry) runs once.
  const frame = eventEnvelope({ ...base, ts: ts(4), text: '<@UBOT|pugport>   translate this' });
  socket.receive(frame);
  socket.receive({ ...frame, envelope_id: 'env-retry', retry_attempt: 1 });
  await waitFor(() => tasks.dispatched.length === 1, 'task');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(tasks.dispatched.length, 1);
  assert.equal(tasks.dispatched[0].title, 'translate this');
});

test('per-person limit refuses extra tasks while earlier ones run', async (t) => {
  let release!: () => void;
  const gate = new Promise<string>((resolve) => (release = () => resolve('done')));
  const tasks = fakeTasks(() => gate);
  const f = await fixture(t, { tasks, gateway: { maxActivePerUser: 1 } });
  const socket = await f.connect();
  const dm = (n: number) =>
    socket.receive(
      eventEnvelope({
        type: 'message',
        channel_type: 'im',
        user: 'UOWNER',
        channel: 'D1',
        text: `task ${n}`,
        ts: ts(10 - n),
      }),
    );
  dm(1);
  await waitFor(() => tasks.dispatched.length === 1, 'first task');
  assert.equal((await f.gateway.view()).activeTasks, 1);
  dm(2);
  await waitFor(() => f.posts().length === 2, 'limit line');
  assert.equal(f.posts()[1]!.params.text, slackText.en.busy(1));
  release();
  await waitFor(() => f.updates().length === 1, 'first answer');
  await waitFor(async () => (await f.gateway.view()).activeTasks === 0, 'slot freed');
  assert.equal(tasks.dispatched.length, 1);
});

test('long answers are split into several messages in the thread', async (t) => {
  const paragraph = (n: number) => `Paragraph ${n}: ${'word '.repeat(150).trim()} <tag> & more`;
  const long = Array.from({ length: 12 }, (_, n) => paragraph(n)).join('\n');
  const tasks = fakeTasks(() => long);
  const f = await fixture(t, { tasks });
  const socket = await f.connect();
  socket.receive(
    eventEnvelope({
      type: 'message',
      channel_type: 'im',
      user: 'UOWNER',
      channel: 'D1',
      text: 'write a lot',
      ts: ts(1),
    }),
  );
  await waitFor(() => f.updates().length === 1, 'first part');
  await waitFor(() => f.posts().length === 1 + splitForSlack(long).length - 1, 'remaining parts');
  const parts = [f.updates()[0]!, ...f.posts().slice(1)].map((call) => call.params.text!);
  assert.ok(parts.length >= 3);
  for (const part of parts) assert.ok(part.length <= 3500, `part of ${part.length} chars`);
  for (const call of f.posts().slice(1)) assert.equal(call.params.thread_ts, ts(1));
  assert.ok(
    parts.every((part) => part.includes('&lt;tag&gt; &amp; more')),
    'escaped for Slack',
  );
  assert.equal(parts.join('\n'), escapeSlack(long));
});

test('splitForSlack prefers line breaks and never cuts an emoji or exceeds the limit once escaped', () => {
  assert.deepEqual(splitForSlack('short'), ['short']);
  assert.deepEqual(splitForSlack('   '), []);
  const lines = splitForSlack('aaaa\nbbbb\ncccc', 10);
  assert.deepEqual(lines, ['aaaa\nbbbb', 'cccc']);
  const escaped = splitForSlack('<'.repeat(30), 20);
  assert.ok(escaped.every((part) => escapeSlack(part).length <= 20));
  assert.equal(escaped.join(''), '<'.repeat(30));
  const emoji = splitForSlack('x' + '😀'.repeat(10), 6);
  assert.ok(emoji.every((part) => !/[\uD800-\uDBFF]$/.test(part)));
  assert.equal(emoji.join(''), 'x' + '😀'.repeat(10));
});

test('a channel the bot cannot read gets one plain line and no task', async (t) => {
  const tasks = fakeTasks();
  const f = await fixture(t, { tasks, history: { C7: { ok: false, error: 'not_in_channel' } } });
  const socket = await f.connect();
  socket.receive(
    eventEnvelope({ type: 'app_mention', user: 'UOWNER', channel: 'C7', text: '<@UBOT> summarize', ts: ts(1) }),
  );
  await waitFor(() => f.updates().length === 1, 'invite line');
  assert.equal(f.updates()[0]!.params.text, escapeSlack(slackText.en.inviteBot));
  assert.equal(tasks.dispatched.length, 0);
});

test('the assistant panel reads the channel the user is looking at', async (t) => {
  const tasks = fakeTasks();
  const f = await fixture(t, {
    tasks,
    history: { CVIEW: { ok: true, messages: [{ ts: ts(100), user: 'UALICE', text: 'Launch moved to Monday' }] } },
  });
  const socket = await f.connect();
  const thread = ts(50);
  socket.receive(
    eventEnvelope({
      type: 'assistant_thread_started',
      assistant_thread: { user_id: 'UOWNER', channel_id: 'D1', thread_ts: thread, context: { channel_id: 'CVIEW' } },
    }),
  );
  socket.receive(
    eventEnvelope({
      type: 'message',
      channel_type: 'im',
      user: 'UOWNER',
      channel: 'D1',
      text: 'What changed?',
      ts: ts(1),
      thread_ts: thread,
    }),
  );
  await waitFor(() => tasks.dispatched.length === 1, 'assistant task');
  assert.match(
    tasks.dispatched[0].task,
    /channel the user is looking at \(<#CVIEW>\)[^\n]*:\n\[[^\]]+\] Alice: Launch moved/,
  );
  assert.ok(f.calls.some((call) => call.method === 'conversations.replies' && call.params.channel === 'D1'));
});

test('tokens never appear in logs, views or route responses; invalid tokens are refused', async (t) => {
  const f = await fixture(t);
  await f.connect();
  const view = await f.gateway.view();
  assert.equal(view.appTokenHint, '…AAAA');
  assert.equal(view.botTokenHint, '…BBBB');
  assert.equal(view.workspace, 'Synthetic Team');
  await assert.rejects(f.gateway.saveTokens({ appToken: 'xoxb-wrong-kind-of-token' }), (error: Error) => {
    assert.match(error.message, /xapp-/);
    assert.doesNotMatch(error.message, /wrong-kind/);
    return true;
  });
  await assert.rejects(f.gateway.saveTokens({}), /至少填一个/);
  for (const call of f.calls) assert.ok(!call.url.includes('xapp-') && !call.url.includes('xoxb-'), 'no token in URLs');

  const app = express();
  app.use(express.json());
  slackRoutes(app, f.gateway);
  app.use(((error, _req, res, _next) =>
    res.status(400).json({ error: error instanceof Error ? error.message : 'bad' })) as ErrorRequestHandler);
  const server = await listenForFetch(app);
  t.after(() => new Promise<void>((done) => server.close(() => done())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = (path: string, method = 'GET', body?: unknown) =>
    fetch(base + path, {
      method,
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
  const bodies: string[] = [];
  const got = await request('/api/slack');
  bodies.push(await got.text());
  assert.equal(JSON.parse(bodies[0]!).status, 'connected');
  const pairing = await request('/api/slack/pairing', 'POST', {});
  assert.match((await pairing.json()).code, /^[A-Z2-9]{6}$/);
  const bad = await request('/api/slack/tokens', 'PUT', { botToken: 'xapp-not-a-bot-token-0000' });
  assert.equal(bad.status, 400);
  bodies.push(await bad.text());
  const extra = await request('/api/slack/tokens', 'PUT', { botToken: BOT, other: 1 });
  assert.equal(extra.status, 400);
  const saved = await request('/api/slack/tokens', 'PUT', { botToken: BOT.replace('BBBB', 'CCCC') });
  bodies.push(await saved.text());
  assert.equal(JSON.parse(bodies.at(-1)!).botTokenHint, '…CCCC');
  await waitFor(() => f.sockets.length === 2, 'reconnect with the new token');
  const off = await request('/api/slack', 'PATCH', { enabled: false });
  bodies.push(await off.text());
  assert.equal(JSON.parse(bodies.at(-1)!).status, 'off');
  assert.equal(f.sockets[1]!.closed, true);
  assert.equal((await request('/api/slack/users/not-an-id', 'DELETE')).status, 400);

  const everything = [...f.logs, ...bodies, JSON.stringify(await f.gateway.view())].join('\n');
  for (const secret of [APP, BOT, BOT.replace('BBBB', 'CCCC'), 'syntheticappsecret', 'syntheticbotsecret'])
    assert.ok(!everything.includes(secret), 'a token leaked into logs or responses');
});

test('shutdown closes the socket, says so in the pending thread, and posts nothing afterwards', async (t) => {
  let release!: () => void;
  const gate = new Promise<string>((resolve) => (release = () => resolve('late answer')));
  const tasks = fakeTasks(() => gate);
  const f = await fixture(t, { tasks });
  const socket = await f.connect();
  socket.receive(
    eventEnvelope({ type: 'message', channel_type: 'im', user: 'UOWNER', channel: 'D1', text: 'slow task', ts: ts(1) }),
  );
  await waitFor(() => tasks.dispatched.length === 1, 'task');
  await f.gateway.close();
  assert.equal(socket.closed, true);
  assert.equal((await f.gateway.view()).status, 'off');
  assert.deepEqual(
    f.updates().map((call) => [call.params.ts, call.params.text]),
    [[`${NOW / 1000}.900001`, escapeSlack(slackText.en.stopped)]],
    'the working note now points to PugPort',
  );
  release();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(f.updates().length, 1, 'no answer after shutdown');
  assert.equal(f.sockets.length, 1, 'no reconnect after shutdown');
  await f.gateway.start();
  assert.equal(f.sockets.length, 1, 'a closed gateway stays closed');
});

test('switching Slack off updates pending notes in the asker’s language; a hanging Slack cannot hold up stopping', async (t) => {
  const tasks = fakeTasks(() => new Promise<string>(() => {}));
  const f = await fixture(t, { tasks });
  const socket = await f.connect();
  socket.receive(
    eventEnvelope({ type: 'message', channel_type: 'im', user: 'UOWNER', channel: 'D1', text: '慢慢整理', ts: ts(2) }),
  );
  await waitFor(() => tasks.dispatched.length === 1, 'task');
  assert.equal(f.posts()[0]!.params.text, slackText.zh.working);
  await f.gateway.setEnabled(false);
  assert.equal(f.updates().length, 1);
  assert.equal(f.updates()[0]!.params.text, slackText.zh.stopped);

  const hanging = await fixture(t, { tasks: fakeTasks(() => new Promise<string>(() => {})), hangUpdates: true });
  const other = await hanging.connect();
  other.receive(
    eventEnvelope({ type: 'message', channel_type: 'im', user: 'UOWNER', channel: 'D1', text: 'long one', ts: ts(3) }),
  );
  await waitFor(() => hanging.posts().length === 1, 'working note');
  await waitFor(() => hanging.calls.some((call) => call.method === 'users.info'), 'task started');
  const started = Date.now();
  await hanging.gateway.close();
  const took = Date.now() - started;
  assert.ok(took >= 1500 && took < 4000, `stopping took ${took} ms`);
});

test('replies follow the language of each message', async (t) => {
  const tasks = fakeTasks();
  const f = await fixture(t, { tasks, paired: false });
  const socket = await f.connect();
  socket.receive(
    eventEnvelope({ type: 'app_mention', user: 'USTRANGER', channel: 'C1', text: '<@UBOT> 帮我总结一下', ts: ts(9) }),
  );
  socket.receive(eventEnvelope({ type: 'app_mention', user: 'UALICE', channel: 'C1', text: '<@UBOT>', ts: ts(8) }));
  await waitFor(() => f.posts().length === 2, 'refusals');
  const texts = f.posts().map((call) => call.params.text);
  assert.ok(texts.includes(slackText.zh.refused), 'Chinese message, Chinese refusal');
  assert.ok(texts.includes(slackText.en.refused), 'no text at all, English refusal');
  await f.store.update((config) => {
    config.users = [{ id: 'UOWNER', pairedAt: '2026-10-01T00:00:00Z' }];
  });
  socket.receive(
    eventEnvelope({
      type: 'message',
      channel_type: 'im',
      user: 'UOWNER',
      channel: 'D1',
      text: '总结今天的讨论',
      ts: ts(5),
    }),
  );
  await waitFor(() => f.updates().length === 1, 'answer');
  assert.equal(f.posts().at(-1)!.params.text, slackText.zh.working);
  assert.equal(slackText.zh.busy(2), '你已有 2 个任务在处理，请等其中一个完成后再发。');
  assert.equal(Object.keys(slackText.zh).join(), Object.keys(slackText.en).join(), 'both languages say everything');
});

test('a follow-up after a restart continues the same PugPort conversation; old threads are forgotten', async (t) => {
  const tasks = fakeTasks();
  const root = ts(600);
  const f = await fixture(t, { tasks });
  const old = { conversationId: 'conv-old', lastTs: ts(5000), usedAt: new Date(NOW - 40 * 86_400_000).toISOString() };
  await writeFile(
    join(f.dir, 'slack-threads.json'),
    JSON.stringify({ version: 1, threads: { [`C1:${ts(5000)}`]: old } }),
  );
  let socket = await f.connect();
  socket.receive(
    eventEnvelope({
      type: 'app_mention',
      user: 'UOWNER',
      channel: 'C1',
      text: '<@UBOT> start',
      ts: ts(30),
      thread_ts: root,
    }),
  );
  await waitFor(() => f.updates().length === 1, 'first answer');
  // Quitting waits for the save, so the map is on disk afterwards.
  await f.restart();
  const saved = JSON.parse(await readFile(join(f.dir, 'slack-threads.json'), 'utf8'));
  assert.deepEqual(Object.keys(saved.threads), [`C1:${root}`], 'a thread unused for 40 days is pruned');
  assert.deepEqual(saved.threads[`C1:${root}`], {
    conversationId: 'conv-1',
    lastTs: ts(30),
    usedAt: new Date(NOW).toISOString(),
  });
  assert.doesNotMatch(await readFile(join(f.dir, 'slack-threads.json'), 'utf8'), /xoxb-|xapp-/);
  assert.doesNotMatch(await readFile(f.file, 'utf8'), /conv-1/, 'the map is not in the secrets file');

  socket = await f.connect();
  socket.receive(
    eventEnvelope({
      type: 'app_mention',
      user: 'UOWNER',
      channel: 'C1',
      text: '<@UBOT> and then?',
      ts: ts(10),
      thread_ts: root,
    }),
  );
  socket.receive(
    eventEnvelope({
      type: 'app_mention',
      user: 'UOWNER',
      channel: 'C1',
      text: '<@UBOT> old',
      ts: ts(9),
      thread_ts: ts(5000),
    }),
  );
  await waitFor(() => tasks.dispatched.length === 3, 'tasks after restart');
  const followUp = tasks.dispatched.find((input) => input.title === 'and then?');
  assert.equal(followUp.conversationId, 'conv-1');
  assert.match(followUp.task, /^Follow-up request/);
  const replies = f.calls.filter((call) => call.method === 'conversations.replies' && call.params.ts === root);
  assert.equal(replies.at(-1)!.params.oldest, ts(30), 'only what was said since the last answer');
  assert.equal(tasks.dispatched.find((input) => input.title === 'old').conversationId, undefined);
});

test('fatal token errors stop retrying and explain which token is wrong', async (t) => {
  const f = await fixture(t, {
    gateway: {
      fetch: (async (url: string) =>
        String(url).endsWith('auth.test')
          ? json({ ok: true, user_id: 'UBOT' })
          : json({ ok: false, error: 'invalid_auth' })) as unknown as typeof fetch,
    },
  });
  await f.gateway.start();
  await waitFor(async () => (await f.gateway.view()).status === 'error', 'error');
  assert.match((await f.gateway.view()).error!, /App-Level Token 无效/);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(f.sockets.length, 0);
});

test('the manifest uses Socket Mode with the needed events and scopes; the assistant panel is optional', () => {
  const basic = slackAppManifest();
  assert.equal(basic.settings.socket_mode_enabled, true);
  assert.equal(basic.display_information.name, 'PugPort');
  assert.equal(basic.features.bot_user.display_name, 'pugport');
  assert.equal(basic.features.app_home.messages_tab_enabled, true);
  assert.deepEqual(basic.settings.event_subscriptions.bot_events, [
    'app_mention',
    'message.im',
    'message.channels',
    'message.groups',
  ]);
  for (const scope of [
    'app_mentions:read',
    'chat:write',
    'reactions:write',
    'im:history',
    'channels:history',
    'users:read',
  ])
    assert.ok(basic.oauth_config.scopes.bot.includes(scope));
  assert.ok(!basic.oauth_config.scopes.bot.includes('assistant:write'));
  assert.equal('assistant_view' in basic.features, false);
  const assistant = slackAppManifest(true);
  assert.ok(assistant.oauth_config.scopes.bot.includes('assistant:write'));
  assert.ok(assistant.settings.event_subscriptions.bot_events.includes('assistant_thread_context_changed'));
});
