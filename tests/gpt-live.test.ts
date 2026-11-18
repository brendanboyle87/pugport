import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { listenForFetch } from './helpers/fetch-port.ts';
import {
  GptLive,
  GptLiveError,
  GPT_LIVE_COOLDOWN_MS,
  GPT_LIVE_USD_PER_SECOND,
  type LiveSocket,
} from '../src/server/gpt-live.ts';
import { registerVoiceLiveRoutes } from '../src/server/voice-live-routes.ts';

// Fake provider sockets and synthetic cards: nothing here reaches OpenAI, an account or the network.
class FakeSocket implements LiveSocket {
  sent: any[] = [];
  closed = false;
  onmessage: ((data: string) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly key: string) {}
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.closed = true;
  }
  server(event: unknown) {
    this.onmessage?.(JSON.stringify(event));
  }
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
type Card = { targetId: string; key: string; remainingUsd?: number };
function fixture(cards: Card[], options: { refuse?: string[] } = {}) {
  let clock = 1_000_000;
  const charges: { targetId: string; cost: number }[] = [];
  const sockets: FakeSocket[] = [];
  const live = new GptLive({
    cards: () => cards.map((card) => ({ ...card })),
    remainingUsd: (id) => cards.find((card) => card.targetId === id)?.remainingUsd,
    record: (targetId, cost) => {
      charges.push({ targetId, cost });
      for (const card of cards)
        if (card.key === cards.find((item) => item.targetId === targetId)?.key && card.remainingUsd !== undefined)
          card.remainingUsd -= cost;
    },
    connect: async (key) => {
      const socket = new FakeSocket(key);
      sockets.push(socket);
      // The provider answers only after session.start was sent.
      setTimeout(
        () =>
          socket.server(
            options.refuse?.includes(key)
              ? { type: 'error', error: { code: 'invalid_api_key', message: 'x' } }
              : { type: 'session.started', session: { id: `live_${sockets.length}`, expires_at: 0 } },
          ),
        1,
      );
      return socket;
    },
    now: () => clock,
  });
  const spent = (targetId: string) =>
    charges.filter((item) => item.targetId === targetId).reduce((sum, item) => sum + item.cost, 0);
  return { live, charges, sockets, spent, advance: (ms: number) => (clock += ms) };
}
const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
const candidates = (live: GptLive) =>
  (live as unknown as { candidates(): { targetId: string }[] })
    .candidates()
    .map((card) => card.targetId)
    .join();

test('starts on the card with the most credit and relays audio, transcripts and per-second usage', async () => {
  const f = fixture([
    { targetId: 'small', key: 'sk-small', remainingUsd: 1 },
    { targetId: 'big', key: 'sk-big', remainingUsd: 5 },
    { targetId: 'payg', key: 'sk-payg' },
  ]);
  assert.equal(candidates(f.live), 'big,small,payg');
  const { id } = await f.live.start({ instructions: 'English tutor.', voice: 'marin' });
  const socket = f.sockets[0]!;
  assert.equal(socket.key, 'sk-big');
  assert.equal(socket.sent[0].type, 'session.start');
  assert.deepEqual(socket.sent[0].session, {
    model: 'gpt-live-1',
    instructions: 'English tutor.',
    audio: { format: { type: 'audio/pcm', rate: 24000 }, output: { voice: 'marin' } },
    delegation: { type: 'client' },
  });
  f.live.exchange(id, new Uint8Array([1, 0, 2, 0]));
  assert.deepEqual(socket.sent[1], { type: 'session.input_audio.append', audio: 'AQACAA==' });
  socket.server({ type: 'session.output_audio.delta', delta: 'BBBB' });
  socket.server({ type: 'session.input_transcript.delta', delta: 'I goed', start_ms: 0, end_ms: 400 });
  socket.server({ type: 'session.output_transcript.delta', delta: 'I went', start_ms: 500, end_ms: 900 });
  socket.server({ type: 'session.usage.updated', usage: { seconds: 12 }, context_window: { usage_ratio: 0.1 } });
  socket.server({ type: 'session.usage.updated', usage: { seconds: 30 } });
  const reply = f.live.exchange(id, new Uint8Array());
  assert.deepEqual(reply.audio, ['BBBB']);
  assert.deepEqual(reply.events, [
    { type: 'transcript', role: 'user', text: 'I goed' },
    { type: 'transcript', role: 'assistant', text: 'I went' },
    { type: 'usage', seconds: 12, costUsd: 12 * GPT_LIVE_USD_PER_SECOND },
    { type: 'usage', seconds: 30, costUsd: 30 * GPT_LIVE_USD_PER_SECOND },
  ]);
  // Cumulative snapshots: 12 s then 18 more, never 42.
  near(f.spent('big'), 30 * GPT_LIVE_USD_PER_SECOND);
  f.live.instruct(id, 'Correct grammar only.');
  assert.deepEqual(socket.sent.at(-1), {
    type: 'session.instructions.append',
    delegation_id: null,
    content: 'Correct grammar only.',
  });
  assert.deepEqual(f.live.status(), { available: false, reason: 'busy' });
  await assert.rejects(f.live.start({ instructions: '' }), (error) => (error as GptLiveError).code === 'busy');
  f.live.close(id);
  assert.deepEqual(socket.sent.at(-1), { type: 'session.close' });
  socket.server({ type: 'session.closed', reason: 'close_requested', usage: { seconds: 31 }, session: {} });
  assert.deepEqual(f.live.exchange(id, new Uint8Array()).events, [
    { type: 'usage', seconds: 31, costUsd: 31 * GPT_LIVE_USD_PER_SECOND },
    { type: 'closed', reason: 'mod' },
  ]);
  assert.ok(socket.closed);
  assert.throws(() => f.live.exchange(id, new Uint8Array()), GptLiveError);
});

test('when a card runs out mid-session the next card continues the same conversation', async () => {
  const f = fixture([
    { targetId: 'a', key: 'sk-a', remainingUsd: 0.06 },
    { targetId: 'a-copy', key: 'sk-a', remainingUsd: 0.06 },
    { targetId: 'b', key: 'sk-b', remainingUsd: 0.055 },
  ]);
  const { id } = await f.live.start({ instructions: 'Tutor.' });
  const a = f.sockets[0]!;
  assert.equal(a.key, 'sk-a');
  a.server({ type: 'session.input_transcript.delta', delta: 'Yesterday I goed ' });
  a.server({ type: 'session.input_transcript.delta', delta: 'home.' });
  a.server({ type: 'session.output_transcript.delta', delta: 'You went home.' });
  a.server({ type: 'session.usage.updated', usage: { seconds: 70 } });
  // 'a-copy' shares the key, so it is the same budget and is skipped; 'b' takes over with the conversation so far.
  assert.deepEqual(a.sent.at(-1), { type: 'session.close' });
  await tick();
  const b = f.sockets[1]!;
  assert.equal(b.key, 'sk-b');
  assert.deepEqual(b.sent[0].session.input, [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Yesterday I goed home.' }] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'You went home.' }] },
  ]);
  assert.equal(b.sent[0].session.instructions, 'Tutor.');
  // The retiring session's last usage still goes to its own card; its words no longer reach the window.
  a.server({ type: 'session.output_transcript.delta', delta: 'stale' });
  a.server({ type: 'session.closed', reason: 'close_requested', usage: { seconds: 71 }, session: {} });
  b.server({ type: 'session.usage.updated', usage: { seconds: 4 } });
  const events = f.live.exchange(id, new Uint8Array([1, 0])).events;
  assert.ok(events.some((event) => event.type === 'switched' && event.reason === 'cap'));
  assert.ok(!events.some((event) => event.type === 'transcript' && event.text === 'stale'));
  // Usage keeps counting across cards: 71 s on A, then 4 on B.
  assert.deepEqual(events.at(-1), { type: 'usage', seconds: 75, costUsd: 75 * GPT_LIVE_USD_PER_SECOND });
  near(f.spent('a'), 71 * GPT_LIVE_USD_PER_SECOND);
  near(f.spent('b'), 4 * GPT_LIVE_USD_PER_SECOND);
  assert.deepEqual(b.sent.at(-1), { type: 'session.input_audio.append', audio: 'AQA=' });
  // B runs out and no card is left: the session ends as out of credit.
  b.server({ type: 'session.usage.updated', usage: { seconds: 63 } });
  await tick();
  assert.deepEqual(f.live.exchange(id, new Uint8Array()).events.at(-1), { type: 'closed', reason: 'cap' });
  assert.deepEqual(f.live.status(), { available: false, reason: 'budget' });
});

test("the session's own limits hold across cards", async () => {
  const f = fixture([{ targetId: 'a', key: 'sk-a', remainingUsd: 10 }]);
  const { id } = await f.live.start({ instructions: '', maxMinutes: 1 });
  f.sockets[0]!.server({ type: 'session.usage.updated', usage: { seconds: 61 } });
  assert.deepEqual(f.sockets[0]!.sent.at(-1), { type: 'session.close' });
  f.sockets[0]!.server({ type: 'session.closed', reason: 'close_requested', usage: { seconds: 62 }, session: {} });
  assert.deepEqual(f.live.exchange(id, new Uint8Array()).events.at(-1), { type: 'closed', reason: 'limit' });

  const g = fixture([{ targetId: 'a', key: 'sk-a', remainingUsd: 10 }]);
  const priced = await g.live.start({ instructions: '', maxCostUsd: 0.05 });
  g.sockets[0]!.server({ type: 'session.usage.updated', usage: { seconds: 56 } });
  assert.deepEqual(g.sockets[0]!.sent.at(-1), { type: 'session.close' });
  g.sockets[0]!.server({ type: 'session.closed', reason: 'close_requested', usage: { seconds: 56 }, session: {} });
  assert.deepEqual(g.live.exchange(priced.id, new Uint8Array()).events.at(-1), { type: 'closed', reason: 'limit' });
});

test('a card that refuses or drops rests for a while; another card takes over and nothing is charged twice', async () => {
  const f = fixture(
    [
      { targetId: 'broken', key: 'sk-broken', remainingUsd: 9 },
      { targetId: 'good', key: 'sk-good', remainingUsd: 5 },
      { targetId: 'spare', key: 'sk-spare', remainingUsd: 1 },
    ],
    { refuse: ['sk-broken'] },
  );
  const { id } = await f.live.start({ instructions: '' });
  assert.deepEqual(
    f.sockets.map((socket) => socket.key),
    ['sk-broken', 'sk-good'],
  );
  assert.equal(f.charges.length, 0);
  // The connection to 'good' drops after 41 seconds without a final report: those seconds are charged once.
  f.advance(40_500);
  f.sockets[1]!.onclose?.();
  await tick();
  near(f.spent('good'), 41 * GPT_LIVE_USD_PER_SECOND);
  assert.equal(f.sockets[2]!.key, 'sk-spare');
  assert.ok(f.live.exchange(id, new Uint8Array()).events.some((event) => event.type === 'switched'));
  f.live.close(id);
  f.sockets[2]!.server({ type: 'session.closed', reason: 'close_requested', usage: { seconds: 1 }, session: {} });
  f.live.exchange(id, new Uint8Array());
  // Both failed cards cool down; afterwards they are eligible again.
  assert.equal(candidates(f.live), 'spare');
  f.advance(GPT_LIVE_COOLDOWN_MS + 1);
  assert.equal(candidates(f.live), 'broken,good,spare');
  assert.deepEqual(fixture([]).live.status(), { available: false, reason: 'no-card' });
  await assert.rejects(
    fixture([]).live.start({ instructions: '' }),
    (error) => (error as GptLiveError).code === 'unavailable',
  );
  const cooling = fixture([{ targetId: 'x', key: 'sk-x', remainingUsd: 3 }], { refuse: ['sk-x'] });
  await assert.rejects(cooling.live.start({ instructions: '' }), GptLiveError);
  assert.deepEqual(cooling.live.status(), { available: false, reason: 'cooldown' });
  assert.equal(cooling.charges.length, 0);
});

test('HTTP: the user setting decides, reasons are plain, and the key never appears in a response', async (t) => {
  const f = fixture([{ targetId: 'a', key: 'sk-synthetic', remainingUsd: 5 }]);
  let setting: 'gpt-live' | 'local' | undefined;
  const app = express();
  app.use(express.json());
  registerVoiceLiveRoutes(app, f.live, () => setting);
  const server = createServer(app);
  await listenForFetch(server);
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (path: string, method = 'GET', body?: BodyInit, type = 'application/json') => {
    const response = await fetch(base + path, { method, headers: { 'content-type': type }, ...(body ? { body } : {}) });
    const text = await response.text();
    assert.ok(!text.includes('sk-synthetic'));
    return { status: response.status, body: JSON.parse(text) };
  };
  assert.deepEqual((await call('/api/voice/live/status')).body, {
    setting: 'gpt-live',
    available: true,
    provider: 'gpt-live',
  });
  setting = 'local';
  assert.deepEqual((await call('/api/voice/live/status')).body, {
    setting: 'local',
    available: true,
    provider: 'local',
    reason: 'setting',
  });
  assert.deepEqual(await call('/api/voice/live/sessions', 'POST', JSON.stringify({ instructions: '' })), {
    status: 409,
    body: { error: 'GPT Live is not available.', code: 'unavailable' },
  });
  setting = undefined;
  const started = await call(
    '/api/voice/live/sessions',
    'POST',
    JSON.stringify({ instructions: 'Tutor', maxMinutes: 10, maxCostUsd: 0.5 }),
  );
  assert.equal(started.status, 200);
  const id = started.body.id as string;
  const exchanged = await call(
    `/api/voice/live/sessions/${id}/exchange`,
    'POST',
    new Uint8Array([1, 0]),
    'application/octet-stream',
  );
  assert.deepEqual(exchanged.body, { events: [], audio: [] });
  assert.deepEqual(f.sockets[0]!.sent.at(-1), { type: 'session.input_audio.append', audio: 'AQA=' });
  assert.equal(
    (await call(`/api/voice/live/sessions/${id}/instruct`, 'POST', JSON.stringify({ text: 'Hi' }))).status,
    200,
  );
  assert.equal((await call(`/api/voice/live/sessions/${id}`, 'DELETE')).status, 200);
  assert.equal(
    (await call('/api/voice/live/sessions/unknown/exchange', 'POST', new Uint8Array(), 'application/octet-stream'))
      .status,
    409,
  );
  f.sockets[0]!.server({ type: 'session.closed', reason: 'close_requested', usage: { seconds: 2 }, session: {} });
});
