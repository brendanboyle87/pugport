import assert from 'node:assert/strict';
import test from 'node:test';
import {
  startModVoice,
  type ModVoiceDevices,
  type ModVoiceEvent,
  type ModVoiceProvider,
} from '../src/ui/mods/mod-voice.ts';
import { createModHostBridge, type ModHostContext, type ModPort } from '../src/ui/mods/mod-host-bridge.ts';
import type { ModManifestV2, ModPermission } from '../src/shared/mods-manifest.ts';

type LiveReply = Awaited<ReturnType<NonNullable<ModVoiceDevices['live']>['exchange']>>;
const wait = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

// A fake microphone, recogniser, speaker, GPT Live backend and player: no device, audio or provider is touched.
function devices(options: { asr?: boolean; live?: ModVoiceProvider; liveFails?: boolean } = {}) {
  let feed: ((samples: Float32Array) => void) | undefined;
  let rate = 0;
  let clock = 0;
  const log: string[] = [];
  const pushed: number[] = [];
  let recognisers = 0;
  const speaking: (() => void)[] = [];
  const replies: LiveReply[] = [];
  const sentAudio: number[] = [];
  const instructions: string[] = [];
  let playing = false;
  const fake: ModVoiceDevices = {
    available: async () => options.asr ?? true,
    recognizer: {
      start: async () => `asr-${++recognisers}`,
      push: async (id, samples) => {
        pushed.push(samples.length);
        return { text: `partial ${id}` };
      },
      finish: async (id) => ({ text: `final ${id}` }),
      cancel: (id) => log.push(`cancel ${id}`),
    },
    microphone: async (onSamples, sampleRate) => {
      feed = onSamples;
      rate = sampleRate;
      log.push(`mic open ${sampleRate}`);
      return () => {
        feed = undefined;
        log.push('mic closed');
      };
    },
    speaker: {
      speak: (text, language, done) => {
        log.push(`say ${language} ${text}`);
        speaking.push(done);
      },
      cancel: () => log.push('speaker cancel'),
    },
    live: {
      status: async () => ({
        provider: options.live ?? 'local',
        ...(options.live ? {} : { reason: 'no-card' as const }),
      }),
      start: async (input) => {
        if (options.liveFails) throw new Error('GPT Live did not connect.');
        log.push(`live start ${input.instructions}`);
        return 'live-1';
      },
      exchange: async (_id, pcm) => {
        sentAudio.push(pcm.length);
        return replies.shift() ?? { events: [], audio: [] };
      },
      instruct: async (_id, text) => void instructions.push(text),
      close: () => log.push('live close'),
    },
    player: {
      play: (audio) => {
        log.push(`play ${audio}`);
        playing = true;
      },
      flush: () => {
        if (playing) log.push('flush');
        playing = false;
      },
      playing: () => playing,
      close: () => undefined,
    },
    now: () => clock,
  };
  const chunk = (value: number) => {
    clock += 256;
    feed?.(new Float32Array(4096).fill(value));
  };
  return {
    fake,
    log,
    pushed,
    speaking,
    chunk,
    replies,
    sentAudio,
    instructions,
    open: () => !!feed,
    rate: () => rate,
    advance: (ms: number) => (clock += ms),
    stopPlaying: () => (playing = false),
  };
}
const states = (events: ModVoiceEvent[]) =>
  events.flatMap((event) =>
    event.kind === 'state' ? [`${event.state}${event.reason ? `:${event.reason}` : ''}`] : [],
  );

test('local: a turn starts on speech, previews words, ends after silence and reports usage', async () => {
  const d = devices();
  const events: ModVoiceEvent[] = [];
  const session = (await startModVoice(d.fake, { endSilenceMs: 500 }, (event) => events.push(event)))!;
  assert.equal(session.provider(), 'local');
  assert.equal(d.rate(), 16000);
  d.chunk(0); // quiet: kept as pre-roll only
  d.chunk(0.2);
  d.chunk(0.2);
  await wait();
  d.chunk(0);
  d.chunk(0);
  await wait();
  assert.deepEqual(states(events).slice(0, 2), ['listening', 'hearing']);
  const final = events.find((event) => event.kind === 'transcript' && event.final);
  assert.deepEqual(final && { ...final, seq: 0 }, {
    sessionId: session.id,
    seq: 0,
    kind: 'transcript',
    turn: 1,
    role: 'user',
    text: 'final asr-1',
    final: true,
  });
  assert.ok(events.some((event) => event.kind === 'usage' && event.provider === 'local' && event.costUsd === 0));
  // The pre-roll chunk reaches the recogniser with the speech.
  assert.ok(d.pushed.length >= 3);
  assert.deepEqual(
    events.map((event) => event.seq),
    events.map((_, index) => index + 1),
  );
  session.instruct('ignored without a model');
  session.stop('mod');
  session.stop('mod');
  assert.ok(d.log.includes('mic closed'));
  assert.equal(states(events).filter((state) => state.startsWith('stopped')).length, 1);
});

test('local: speaking, interruption by the Mod and by the user raising their voice', async () => {
  const d = devices();
  const events: ModVoiceEvent[] = [];
  const session = (await startModVoice(d.fake, { language: 'en-GB' }, (event) => events.push(event)))!;
  session.speak('Try again: I went home.');
  assert.ok(d.log.includes('say en-GB Try again: I went home.'));
  assert.equal(states(events).at(-1), 'speaking');
  session.interrupt();
  assert.ok(d.log.includes('speaker cancel'));
  assert.equal(states(events).at(-1), 'listening');
  session.speak('Second answer');
  // Quiet echo of our own voice does not count as the user; a raised voice for two chunks does.
  d.chunk(0.04);
  assert.equal(states(events).at(-1), 'speaking');
  d.chunk(0.2);
  d.chunk(0.2);
  assert.ok(states(events).includes('hearing:interrupted'));
  // The cancelled utterance's end callback is ignored.
  d.speaking.forEach((done) => done());
  assert.equal(states(events).at(-1), 'hearing:interrupted');
  session.stop('user');
  await wait();
  assert.equal(events.filter((event) => event.kind === 'transcript' && event.final).length, 0);
  assert.ok(d.log.some((line) => line.startsWith('cancel asr-')));
});

test('one live session per window, and an unavailable recogniser never opens the microphone', async () => {
  const d = devices();
  const first = (await startModVoice(d.fake, {}, () => undefined))!;
  assert.equal(await startModVoice(d.fake, {}, () => undefined), undefined);
  first.stop('mod');
  const second = await startModVoice(d.fake, {}, () => undefined);
  assert.ok(second);
  second!.stop('mod');
  const missing = devices({ asr: false });
  await assert.rejects(startModVoice(missing.fake, {}, () => undefined));
  assert.equal(missing.open(), false);
  // A failed start does not keep the window's slot.
  const third = await startModVoice(d.fake, {}, () => undefined);
  assert.ok(third);
  third!.stop('mod');
});

test('GPT Live: streams audio, plays the model, drops queued audio when the user cuts in, groups turns', async () => {
  const d = devices({ live: 'gpt-live' });
  const events: ModVoiceEvent[] = [];
  const session = (await startModVoice(d.fake, { instructions: 'You are an English tutor.' }, (event) =>
    events.push(event),
  ))!;
  assert.equal(session.provider(), 'gpt-live');
  assert.equal(d.rate(), 24000);
  assert.ok(d.log.includes('live start You are an English tutor.'));
  assert.deepEqual(states(events), ['listening']);

  d.chunk(0.01);
  d.replies.push({
    events: [
      { type: 'transcript', role: 'user', text: 'I goed ' },
      { type: 'transcript', role: 'user', text: 'home.' },
    ],
    audio: [],
  });
  await wait(130);
  assert.ok(d.sentAudio.some((length) => length === 4096));
  d.replies.push({
    events: [
      { type: 'transcript', role: 'assistant', text: 'You mean "I went home".' },
      { type: 'usage', seconds: 6, costUsd: 0.005 },
    ],
    audio: ['AAA='],
  });
  await wait(130);
  const finals = events.filter((event) => event.kind === 'transcript' && event.final);
  assert.deepEqual(
    finals.map((event) => event.kind === 'transcript' && [event.turn, event.role, event.text]),
    [[1, 'user', 'I goed home.']],
  );
  assert.ok(d.log.includes('play AAA='));
  assert.equal(states(events).at(-1), 'speaking');
  assert.ok(events.some((event) => event.kind === 'usage' && event.provider === 'gpt-live' && event.seconds === 6));

  // The learner talks over the model: queued playback is dropped at once.
  d.chunk(0.2);
  d.chunk(0.2);
  assert.ok(d.log.includes('flush'));
  assert.ok(states(events).includes('hearing:interrupted'));

  session.speak('Say it again.');
  session.instruct('Correct only grammar.');
  await wait();
  assert.deepEqual(d.instructions, [
    'Say this to the learner exactly, then keep listening: Say it again.',
    'Correct only grammar.',
  ]);
  session.stop('mod');
  assert.ok(d.log.includes('live close'));
  assert.ok(d.log.includes('mic closed'));
  assert.equal(states(events).at(-1), 'stopped:mod');
});

test('GPT Live hands over to this computer when the card runs out or the connection drops', async () => {
  const d = devices({ live: 'gpt-live' });
  const events: ModVoiceEvent[] = [];
  const session = (await startModVoice(d.fake, {}, (event) => events.push(event)))!;
  d.replies.push({ events: [{ type: 'closed', reason: 'cap' }], audio: [] });
  await wait(150);
  assert.equal(session.provider(), 'local');
  assert.ok(
    events.some((event) => event.kind === 'state' && event.provider === 'local' && event.reason === 'fallback'),
  );
  assert.ok(d.log.includes('live close'));
  assert.ok(d.log.includes('mic open 16000'));
  session.stop('mod');

  // The Mod may ask for this computer; a failed GPT Live start also falls back.
  const local = (await startModVoice(devices({ live: 'gpt-live' }).fake, { provider: 'local' }, () => undefined))!;
  assert.equal(local.provider(), 'local');
  local.stop('mod');
  const failing = (await startModVoice(devices({ live: 'gpt-live', liveFails: true }).fake, {}, () => undefined))!;
  assert.equal(failing.provider(), 'local');
  failing.stop('mod');
});

test('a Mod that requires GPT Live gets a clear failure, never this computer', async () => {
  const none = devices();
  await assert.rejects(
    startModVoice(none.fake, { provider: 'gpt-live' }, () => undefined),
    /GPT Live/,
  );
  assert.equal(none.open(), false);
  await assert.rejects(
    startModVoice(devices({ live: 'gpt-live', liveFails: true }).fake, { provider: 'gpt-live' }, () => undefined),
  );
  // A card switch keeps the session on GPT Live; running out everywhere stops it instead of falling back.
  const d = devices({ live: 'gpt-live' });
  const events: ModVoiceEvent[] = [];
  const session = (await startModVoice(d.fake, { provider: 'gpt-live', maxMinutes: 20 }, (event) =>
    events.push(event),
  ))!;
  d.replies.push({ events: [{ type: 'switched', reason: 'cap' }], audio: [] });
  await wait(150);
  assert.ok(states(events).includes('listening:switched'));
  assert.equal(session.provider(), 'gpt-live');
  d.replies.push({ events: [{ type: 'closed', reason: 'cap' }], audio: [] });
  await wait(150);
  assert.equal(states(events).at(-1), 'stopped:limit');
  assert.ok(!d.log.includes('mic open 16000'));
});

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
  async request(method: string, params: unknown = {}) {
    const id = String(Math.random());
    this.onmessage?.({ data: { type: 'request', id, method, params } } as MessageEvent);
    for (let i = 0; i < 20; i++) await wait(1);
    return this.sent.find((value) => value.type === 'response' && value.id === id);
  }
}
let serial = 0;
function bridge(declared: ModPermission[], granted: ModPermission[], live?: ModVoiceProvider) {
  const d = devices({ live });
  const manifest: ModManifestV2 = {
    schemaVersion: 2,
    id: `test.voice${++serial}`,
    version: '1.0.0',
    title: 'Coach',
    description: 'Synthetic',
    permissions: declared,
    state: { keys: [{ id: 'feedback' }] },
  };
  const runs: unknown[] = [];
  const voiceStates: (ModVoiceProvider | undefined)[] = [];
  const context: ModHostContext = {
    conversationId: 'chat',
    modId: manifest.id,
    version: manifest.version,
    instanceId: 'instance',
    manifest,
    isCurrent: () => true,
    info: () => ({
      apiVersion: 2,
      hostVersion: 'test',
      locale: 'en',
      theme: 'light',
      tokens: {},
      slot: 'rightPanel',
      layout: 'panel',
      conversation: { id: 'chat', title: 'Chat' },
    }),
    getState: async () => ({ revision: 0, values: {} }),
    setState: async () => ({ revision: 1, values: {} }),
    messages: () => [],
    insert() {},
    notify() {},
    granted: () => granted,
    runModel: async (input) => {
      runs.push(input);
      return { runId: 'run-1' };
    },
    cancelModel: async () => undefined,
    voice: {
      status: async () => ({
        provider: live ?? 'local',
        available: true,
        gptLive: { available: live === 'gpt-live', ...(live === 'gpt-live' ? {} : { reason: 'no-card' as const }) },
      }),
      start: (options, emit) => startModVoice(d.fake, options, emit),
    },
  };
  const host = createModHostBridge(context, { voiceChanged: (provider) => voiceStates.push(provider) });
  const port = new Port();
  host.connect(port);
  return { host, port, runs, voiceStates, d };
}

test('bridge: model and voice need the declared and approved permission', async () => {
  const declaredOnly = bridge(['model:run', 'voice:session'], []);
  assert.equal((await declaredOnly.port.request('model.run', { prompt: 'x' })).error.code, 'E_PERMISSION');
  assert.equal((await declaredOnly.port.request('voice.start', {})).error.code, 'E_PERMISSION');
  declaredOnly.host.detach();

  const approved = bridge(['model:run'], ['model:run']);
  const run = await approved.port.request('model.run', { prompt: 'Correct me', saveTo: 'feedback', format: 'json' });
  assert.deepEqual(run.result, { runId: 'run-1' });
  assert.deepEqual(approved.runs, [{ prompt: 'Correct me', saveTo: 'feedback', format: 'json' }]);
  assert.equal(
    (await approved.port.request('model.run', { prompt: 'x', instanceId: 'other' })).error.code,
    'E_INVALID',
  );
  assert.equal((await approved.port.request('voice.status', {})).error.code, 'E_PERMISSION');
  approved.host.emit('model', { runId: 'run-1', status: 'completed', text: 'ok', saveTo: 'feedback' });
  assert.deepEqual(approved.port.sent.at(-1), {
    type: 'event',
    event: 'model',
    data: { runId: 'run-1', status: 'completed', text: 'ok', saveTo: 'feedback' },
  });
  approved.host.detach();
});

test('bridge: voice stops when hidden, on the host Stop control and on detach', async () => {
  const b = bridge(['voice:session'], ['voice:session']);
  assert.deepEqual((await b.port.request('voice.status', {})).result, {
    provider: 'local',
    available: true,
    gptLive: { available: false, reason: 'no-card' },
  });
  const started = await b.port.request('voice.start', { language: 'en-US' });
  const sessionId = started.result.sessionId as string;
  assert.equal(started.result.provider, 'local');
  assert.deepEqual(b.voiceStates, ['local']);
  assert.equal((await b.port.request('voice.start', {})).error.code, 'E_LIMIT');
  assert.deepEqual((await b.port.request('voice.speak', { sessionId, text: 'Hello' })).result, {});
  assert.equal((await b.port.request('voice.speak', { sessionId: 'other', text: 'Hello' })).error.code, 'E_INVALID');
  // A local session has no model to steer.
  assert.equal((await b.port.request('voice.instruct', { sessionId, text: 'Be brief.' })).error.code, 'E_INVALID');
  b.host.emit('visibility', { visible: false });
  assert.equal(b.voiceStates.at(-1), undefined);
  assert.ok(b.d.log.includes('mic closed'));
  const stopped = b.port.sent.find(
    (value) => value.event === 'voice' && value.data.kind === 'state' && value.data.state === 'stopped',
  );
  assert.equal(stopped.data.reason, 'hidden');
  // Hidden Mods cannot start the microphone; stop stays idempotent.
  assert.equal((await b.port.request('voice.start', {})).error.code, 'E_UNAVAILABLE');
  assert.deepEqual((await b.port.request('voice.stop', { sessionId })).result, {});

  b.host.emit('visibility', { visible: true });
  await b.port.request('voice.start', {});
  b.host.stopVoice();
  assert.equal(b.voiceStates.at(-1), undefined);
  await b.port.request('voice.start', {});
  b.host.detach();
  assert.equal(b.voiceStates.at(-1), undefined);
  assert.equal(b.d.log.filter((line) => line === 'mic closed').length, 3);
});

test('bridge: a GPT Live session reports its provider and accepts instructions', async () => {
  const b = bridge(['voice:session'], ['voice:session'], 'gpt-live');
  const started = await b.port.request('voice.start', { instructions: 'Tutor.', voice: 'marin' });
  assert.equal(started.result.provider, 'gpt-live');
  assert.equal(b.voiceStates.at(-1), 'gpt-live');
  const sessionId = started.result.sessionId as string;
  assert.deepEqual((await b.port.request('voice.instruct', { sessionId, text: 'Be brief.' })).result, {});
  assert.deepEqual(b.d.instructions, ['Be brief.']);
  assert.equal((await b.port.request('voice.start', { voice: 'Bad Voice' })).error.code, 'E_INVALID');
  b.host.detach();
  assert.ok(b.d.log.includes('live close'));
});
