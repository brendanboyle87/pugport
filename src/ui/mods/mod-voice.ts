/*
 * Voice sessions for Mods with `voice:session`. The host owns the microphone, the provider connection, playback and
 * every stop path; a Mod only receives states, transcripts and usage.
 *
 * - GPT Live (main): a full-duplex OpenAI model on the user's OpenAI API card. The backend holds the connection and
 *   key; this window streams microphone audio and plays the model's audio. The model hears the user while it speaks,
 *   and the host drops queued playback the moment the user cuts in. Billed per second to the card's budget.
 * - Local (fallback): speech recognised on this computer (the voice-input component) and read aloud with the system
 *   voices. No account, no cost. Used when the user chooses it, no OpenAI card can pay, or GPT Live drops.
 */

export const MOD_VOICE_SPEAK_MAX = 4000;
export const MOD_VOICE_INSTRUCTIONS_MAX = 16000;
export type ModVoiceProvider = 'gpt-live' | 'local';
export type ModVoiceLiveUnavailable = 'setting' | 'no-card' | 'budget' | 'cooldown' | 'busy';
export type ModVoiceState = 'listening' | 'hearing' | 'speaking' | 'stopped';
export type ModVoiceStopReason = 'mod' | 'user' | 'hidden' | 'detached' | 'idle' | 'error' | 'limit';
type ModVoiceEventBody =
  | {
      kind: 'state';
      state: ModVoiceState;
      provider: ModVoiceProvider;
      reason?: ModVoiceStopReason | 'interrupted' | 'fallback' | 'switched';
    }
  | { kind: 'transcript'; turn: number; role: 'user' | 'assistant'; text: string; final: boolean }
  | { kind: 'error'; code: 'E_MIC' | 'E_RECOGNITION' }
  | { kind: 'usage'; provider: ModVoiceProvider; seconds: number; costUsd: number };
export type ModVoiceEvent = { sessionId: string; seq: number } & ModVoiceEventBody;
export type ModVoiceOptions = {
  language?: string;
  endSilenceMs?: number;
  /**
   * `gpt-live` requires GPT Live: the start fails rather than use this computer, and the session never falls back.
   * `local` stays on this computer. Absent: GPT Live when the user's setting and a card allow it, else local.
   */
  provider?: ModVoiceProvider;
  /** Limits for the whole GPT Live session, across card switches: minutes (1–30, default 30) and dollars. */
  maxMinutes?: number;
  maxCostUsd?: number;
  /** How GPT Live should behave, e.g. as an English tutor. Local sessions ignore it: the Mod replies itself. */
  instructions?: string;
  voice?: string;
};
export type ModVoiceSession = {
  readonly id: string;
  provider(): ModVoiceProvider;
  speak(text: string): void;
  interrupt(): void;
  instruct(text: string): void;
  stop(reason: ModVoiceStopReason): void;
};
type LiveEvent =
  | { type: 'transcript'; role: 'user' | 'assistant'; text: string }
  | { type: 'usage'; seconds: number; costUsd: number }
  | { type: 'switched'; reason: string }
  | { type: 'closed'; reason: string };

/** Everything that touches a device or the backend, injectable so tests never open a microphone or a provider. */
export type ModVoiceDevices = {
  available(): Promise<boolean>;
  recognizer: {
    start(): Promise<string>;
    push(id: string, samples: Float32Array): Promise<{ text?: string }>;
    finish(id: string): Promise<{ text: string }>;
    cancel(id: string): void;
  };
  /** Opens the microphone at the given rate, mono; returns the function that releases it. */
  microphone(onSamples: (samples: Float32Array) => void, rate: number): Promise<() => void>;
  speaker: {
    speak(text: string, language: string, done: () => void): void;
    cancel(): void;
  };
  live?: {
    /** Which provider the user's setting and the cards allow now, and why GPT Live cannot start. */
    status(): Promise<{ provider: ModVoiceProvider; reason?: ModVoiceLiveUnavailable }>;
    start(input: { instructions: string; voice?: string; maxMinutes?: number; maxCostUsd?: number }): Promise<string>;
    exchange(id: string, pcm: Int16Array): Promise<{ events: LiveEvent[]; audio: string[] }>;
    instruct(id: string, text: string): Promise<void>;
    close(id: string): void;
  };
  /**
   * Plays GPT Live audio (24 kHz PCM16, base64); flush drops everything queued at once. GPT Live streams silence
   * between replies too, so `playing` means voiced audio is still queued.
   */
  player?: { play(base64: string): void; flush(): void; playing(): boolean; close(): void };
  now(): number;
};

const localRate = 16000;
const liveRate = 24000;
const speechLevel = 0.02;
// Our own playback reaches the microphone faintly even with echo cancellation; barging in takes a louder voice.
const bargeInLevel = 0.06;
const maxTurnMs = 60_000;
const idleStopMs = 5 * 60_000;
const liveTickMs = 100;
const liveTurnGapMs = 1500;
let owner: symbol | undefined;

function level(samples: Float32Array) {
  let sum = 0;
  for (let index = 0; index < samples.length; index += 8) sum += samples[index]! * samples[index]!;
  return Math.sqrt(sum / Math.max(1, samples.length / 8));
}
const pcm16 = (samples: Float32Array) =>
  Int16Array.from(samples, (value) => Math.max(-32768, Math.min(32767, Math.round(value * 32767))));

type Send = (event: ModVoiceEventBody) => void;
type Engine = {
  provider: ModVoiceProvider;
  speak(text: string): void;
  interrupt(): void;
  instruct(text: string): void;
  /** Releases everything; returns once the provider is closed. */
  stop(): void;
};
type EngineContext = {
  devices: ModVoiceDevices;
  options: ModVoiceOptions;
  send: Send;
  /** The engine ended on its own (idle, budget, connection): the session stops or falls back. */
  ended(reason: ModVoiceStopReason, fallback: boolean): void;
  nextTurn(): number;
};

/** One window, one live session: a second Mod waits until the first stops. */
export async function startModVoice(
  devices: ModVoiceDevices,
  options: ModVoiceOptions,
  emit: (event: ModVoiceEvent) => void,
): Promise<ModVoiceSession | undefined> {
  if (owner) return undefined;
  const token = Symbol('voice');
  owner = token;
  const id = crypto.randomUUID();
  let seq = 0;
  let stopped = false;
  let turn = 0;
  let engine: Engine | undefined;
  let provider: ModVoiceProvider = 'local';
  const send: Send = (event) => {
    if (!stopped || (event.kind === 'state' && event.state === 'stopped') || event.kind === 'usage')
      emit({ ...event, sessionId: id, seq: ++seq } as ModVoiceEvent);
  };
  const context: EngineContext = {
    devices,
    options,
    send,
    nextTurn: () => ++turn,
    ended(reason, fallback) {
      if (stopped) return;
      const ending = engine;
      engine = undefined;
      ending?.stop();
      if (fallback && ending?.provider === 'gpt-live' && options.provider !== 'gpt-live')
        void startLocal(context)
          .then((next) => {
            if (stopped) return next.stop();
            engine = next;
            provider = next.provider;
            send({ kind: 'state', state: 'listening', provider: 'local', reason: 'fallback' });
          })
          .catch(() => session.stop(reason));
      else session.stop(reason);
    },
  };
  const session: ModVoiceSession = {
    id,
    provider: () => provider,
    speak: (text) => !stopped && text.trim() && engine?.speak(text),
    interrupt: () => engine?.interrupt(),
    instruct: (text) => !stopped && text.trim() && engine?.instruct(text),
    stop(reason) {
      if (stopped) return;
      engine?.stop();
      engine = undefined;
      send({ kind: 'state', state: 'stopped', provider, reason });
      stopped = true;
      if (owner === token) owner = undefined;
    },
  };
  try {
    const allowed = (await devices.live?.status().catch(() => undefined))?.provider ?? 'local';
    if (options.provider === 'gpt-live') {
      // Required: a clear failure is better than a different kind of conversation.
      if (allowed !== 'gpt-live') throw new Error('GPT Live is not available.');
      engine = await startLive(context);
    } else if (allowed === 'gpt-live' && options.provider !== 'local')
      engine = await startLive(context).catch(() => undefined);
    engine ??= await startLocal(context);
    provider = engine.provider;
  } catch (error) {
    if (owner === token) owner = undefined;
    stopped = true;
    throw error;
  }
  send({ kind: 'state', state: 'listening', provider: engine.provider });
  return session;
}

async function startLive(context: EngineContext): Promise<Engine> {
  const { devices, options, send } = context;
  const live = devices.live!;
  const player = devices.player!;
  const id = await live.start({
    instructions: options.instructions ?? '',
    ...(options.voice ? { voice: options.voice } : {}),
    ...(options.maxMinutes !== undefined ? { maxMinutes: options.maxMinutes } : {}),
    ...(options.maxCostUsd !== undefined ? { maxCostUsd: options.maxCostUsd } : {}),
  });
  let ended = false;
  let pending: Float32Array[] = [];
  let inFlight = false;
  let loudChunks = 0;
  let state: ModVoiceState = 'listening';
  let lastUser = 0;
  let lastActivity = devices.now();
  let current: { turn: number; role: 'user' | 'assistant'; text: string; at: number } | undefined;
  const setState = (next: ModVoiceState, reason?: 'interrupted') => {
    if (state === next && !reason) return;
    state = next;
    send({ kind: 'state', state: next, provider: 'gpt-live', ...(reason ? { reason } : {}) });
  };
  const finalize = () => {
    if (!current) return;
    send({ kind: 'transcript', turn: current.turn, role: current.role, text: current.text.trim(), final: true });
    current = undefined;
  };
  // The user cut in: drop whatever is queued; the model hears them too and stops on its own.
  const bargeIn = () => {
    if (!player.playing()) return;
    player.flush();
    setState('hearing', 'interrupted');
  };
  const receive = (event: LiveEvent) => {
    if (event.type === 'usage') send({ kind: 'usage', provider: 'gpt-live', ...event });
    // Another OpenAI card took over with the conversation so far; the session goes on.
    else if (event.type === 'switched') send({ kind: 'state', state, provider: 'gpt-live', reason: 'switched' });
    else if (event.type === 'closed') {
      if (ended) return;
      // Every card out of credit, or no card would connect: the conversation may go on locally. The session's own
      // limit, a policy stop or the user's close ends it.
      const reason =
        event.reason === 'cap' || event.reason === 'limit' ? 'limit' : event.reason === 'mod' ? 'mod' : 'error';
      context.ended(reason, ['cap', 'error', 'remote', 'expired'].includes(event.reason));
    } else {
      const now = devices.now();
      if (event.role === 'user') {
        lastUser = now;
        lastActivity = now;
        bargeIn();
      }
      if (current && current.role !== event.role) finalize();
      current ??= { turn: context.nextTurn(), role: event.role, text: '', at: now };
      current.text += event.text;
      current.at = now;
      send({ kind: 'transcript', turn: current.turn, role: current.role, text: current.text.trim(), final: false });
    }
  };
  const tick = async () => {
    if (ended || inFlight) return;
    inFlight = true;
    const chunks = pending;
    pending = [];
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const samples = new Float32Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      samples.set(chunk, offset);
      offset += chunk.length;
    }
    try {
      const reply = await live.exchange(id, pcm16(samples));
      if (ended) return;
      for (const audio of reply.audio) player.play(audio);
      for (const event of reply.events) receive(event);
      const now = devices.now();
      if (current && now - current.at >= liveTurnGapMs) finalize();
      if (!ended) setState(player.playing() ? 'speaking' : now - lastUser < liveTurnGapMs ? 'hearing' : 'listening');
      if (now - lastActivity > idleStopMs) context.ended('idle', false);
    } catch {
      if (!ended) context.ended('error', true);
    } finally {
      inFlight = false;
    }
  };
  let release: (() => void) | undefined;
  try {
    release = await devices.microphone((samples) => {
      if (ended) return;
      pending.push(samples);
      loudChunks = player.playing() && level(samples) >= bargeInLevel ? loudChunks + 1 : 0;
      if (loudChunks >= 2) {
        loudChunks = 0;
        bargeIn();
      }
    }, liveRate);
  } catch (error) {
    live.close(id);
    throw error;
  }
  const timer = setInterval(() => void tick(), liveTickMs);
  return {
    provider: 'gpt-live',
    speak: (text) => {
      lastActivity = devices.now();
      void live.instruct(id, `Say this to the learner exactly, then keep listening: ${text}`).catch(() => undefined);
    },
    interrupt: () => {
      player.flush();
      void live.instruct(id, 'Stop speaking now and listen to the learner.').catch(() => undefined);
      setState('listening');
    },
    instruct: (text) => void live.instruct(id, text).catch(() => undefined),
    stop() {
      if (ended) return;
      ended = true;
      clearInterval(timer);
      finalize();
      release?.();
      player.flush();
      live.close(id);
      // Collect the final usage the backend records when the provider confirms the close.
      setTimeout(() => {
        void live
          .exchange(id, new Int16Array(0))
          .then((reply) =>
            reply.events.forEach(
              (event) => event.type === 'usage' && send({ kind: 'usage', provider: 'gpt-live', ...event }),
            ),
          )
          .catch(() => undefined);
      }, 3500);
    },
  };
}

async function startLocal(context: EngineContext): Promise<Engine> {
  const { devices, options, send } = context;
  const language = options.language ?? 'en-US';
  const endSilence = Math.min(3000, Math.max(400, options.endSilenceMs ?? 900));
  let ended = false;
  let state: ModVoiceState = 'listening';
  let recording:
    { id: Promise<string>; turn: number; startedAt: number; lastVoice: number; chain: Promise<void> } | undefined;
  let preRoll: Float32Array | undefined;
  let speaking = 0;
  let loudChunks = 0;
  let listenedMs = 0;
  let lastActivity = devices.now();
  const setState = (next: ModVoiceState, reason?: 'interrupted') => {
    if (state === next && !reason) return;
    state = next;
    send({ kind: 'state', state: next, provider: 'local', ...(reason ? { reason } : {}) });
  };
  const usage = () =>
    send({ kind: 'usage', provider: 'local', seconds: Math.round(listenedMs / 100) / 10, costUsd: 0 });
  const finishTurn = () => {
    const active = recording;
    if (!active) return;
    recording = undefined;
    listenedMs += devices.now() - active.startedAt;
    active.chain = active.chain
      .then(async () => {
        const { text } = await devices.recognizer.finish(await active.id);
        if (!ended && text.trim())
          send({ kind: 'transcript', turn: active.turn, role: 'user', text: text.trim(), final: true });
        usage();
      })
      .catch(() => send({ kind: 'error', code: 'E_RECOGNITION' }));
    if (!ended) setState(speaking ? 'speaking' : 'listening');
  };
  const interruptPlayback = (reason?: 'interrupted') => {
    if (!speaking) return;
    speaking = 0;
    devices.speaker.cancel();
    if (!ended) setState(recording ? 'hearing' : 'listening', reason);
  };
  // Chunks reach the recogniser in order; a preview of the words so far comes back about once a second.
  const push = (active: NonNullable<typeof recording>, samples: Float32Array) => {
    active.chain = active.chain
      .then(async () => {
        const reply = await devices.recognizer.push(await active.id, samples);
        if (!ended && recording === active && reply.text?.trim())
          send({ kind: 'transcript', turn: active.turn, role: 'user', text: reply.text.trim(), final: false });
      })
      .catch(() => undefined);
  };
  const onSamples = (samples: Float32Array) => {
    if (ended) return;
    const now = devices.now();
    const loud = level(samples);
    if (!recording) {
      // While the host speaks, only a clearly raised voice counts as the user taking the turn.
      loudChunks = loud >= (speaking ? bargeInLevel : speechLevel) ? loudChunks + 1 : 0;
      if (loudChunks < (speaking ? 2 : 1)) {
        preRoll = samples;
        if (now - lastActivity > idleStopMs) context.ended('idle', false);
        return;
      }
      loudChunks = 0;
      recording = {
        id: devices.recognizer.start(),
        turn: context.nextTurn(),
        startedAt: now,
        lastVoice: now,
        chain: Promise.resolve(),
      };
      interruptPlayback('interrupted');
      setState('hearing');
      if (preRoll) push(recording, preRoll);
      preRoll = undefined;
    }
    lastActivity = now;
    if (loud >= speechLevel) recording.lastVoice = now;
    push(recording, samples);
    if (now - recording.lastVoice >= endSilence || now - recording.startedAt >= maxTurnMs) finishTurn();
  };
  if (!(await devices.available())) throw new Error('unavailable');
  const release = await devices.microphone(onSamples, localRate);
  return {
    provider: 'local',
    speak(text) {
      speaking++;
      lastActivity = devices.now();
      if (!recording) setState('speaking');
      devices.speaker.speak(text, language, () => {
        if (ended || speaking === 0) return;
        speaking--;
        if (!speaking && !recording) setState('listening');
      });
    },
    interrupt: () => interruptPlayback(),
    // Local sessions have no model to steer; the Mod replies with model.run and speak.
    instruct: () => undefined,
    stop() {
      if (ended) return;
      ended = true;
      if (recording) {
        const active = recording;
        recording = undefined;
        listenedMs += devices.now() - active.startedAt;
        void active.id.then((recognizer) => devices.recognizer.cancel(recognizer)).catch(() => undefined);
      }
      speaking = 0;
      devices.speaker.cancel();
      release();
      usage();
    },
  };
}

/** Plays 24 kHz PCM16 chunks back to back; flushing stops every queued chunk at once. */
function browserPlayer(): NonNullable<ModVoiceDevices['player']> {
  let context: AudioContext | undefined;
  let queued: AudioBufferSourceNode[] = [];
  let until = 0;
  let voicedUntil = 0;
  return {
    play(base64) {
      context ??= new AudioContext({ sampleRate: liveRate });
      // The window starts audio without a click in it; a suspended context would stay silent.
      if (context.state === 'suspended') void context.resume().catch(() => undefined);
      const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
      const pcm = new Int16Array(bytes.buffer, 0, bytes.byteLength >> 1);
      if (!pcm.length) return;
      const buffer = context.createBuffer(1, pcm.length, liveRate);
      buffer.getChannelData(0).set(Float32Array.from(pcm, (value) => value / 32768));
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      until = Math.max(until, context.currentTime + 0.03);
      source.start(until);
      until += buffer.duration;
      // About -40 dBFS: quieter chunks are the silence GPT Live sends between replies.
      if (pcm.some((value) => value > 320 || value < -320)) voicedUntil = until;
      queued.push(source);
      source.onended = () => (queued = queued.filter((item) => item !== source));
    },
    flush() {
      for (const source of queued) {
        try {
          source.stop();
        } catch {
          // Already finished.
        }
      }
      queued = [];
      until = 0;
      voicedUntil = 0;
    },
    playing: () => !!context && voicedUntil > context.currentTime,
    close() {
      this.flush();
      if (context && context.state !== 'closed') void context.close().catch(() => undefined);
      context = undefined;
    },
  };
}

/** The real devices: GPT Live through the backend, local recognition, system voices and this window's audio. */
export function browserVoiceDevices(
  api: <T>(path: string, body?: unknown, method?: string) => Promise<T>,
): ModVoiceDevices {
  const player = browserPlayer();
  return {
    available: async () => (await api<{ asr: boolean }>('/api/voice/status', undefined, 'GET')).asr,
    recognizer: {
      start: async () => (await api<{ id: string }>('/api/voice/sessions', {})).id,
      push: (id, samples) => api<{ text?: string }>(`/api/voice/sessions/${id}/audio`, samples.buffer),
      // `raw` keeps the learner's own words: no tidying model and no extra usage.
      finish: (id) => api<{ text: string }>(`/api/voice/sessions/${id}/finish`, {}),
      cancel: (id) => void api(`/api/voice/sessions/${id}`, undefined, 'DELETE').catch(() => undefined),
    },
    live: {
      status: async () => {
        const value = await api<{ provider: ModVoiceProvider; reason?: ModVoiceLiveUnavailable }>(
          '/api/voice/live/status',
          undefined,
          'GET',
        );
        return { provider: value.provider, ...(value.reason ? { reason: value.reason } : {}) };
      },
      start: async (input) => (await api<{ id: string }>('/api/voice/live/sessions', input)).id,
      exchange: (id, pcm) => api(`/api/voice/live/sessions/${id}/exchange`, pcm.buffer),
      instruct: (id, text) => api(`/api/voice/live/sessions/${id}/instruct`, { text }),
      close: (id) => void api(`/api/voice/live/sessions/${id}`, undefined, 'DELETE').catch(() => undefined),
    },
    player,
    async microphone(onSamples, rate) {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      const context = new AudioContext({ sampleRate: rate });
      const source = context.createMediaStreamSource(stream);
      const node = context.createScriptProcessor(rate === liveRate ? 2048 : 4096, 1, 1);
      node.onaudioprocess = (event) => onSamples(new Float32Array(event.inputBuffer.getChannelData(0)));
      source.connect(node);
      node.connect(context.destination);
      return () => {
        node.onaudioprocess = null;
        node.disconnect();
        stream.getTracks().forEach((track) => track.stop());
        if (context.state !== 'closed') void context.close().catch(() => undefined);
      };
    },
    speaker: {
      speak(text, language, done) {
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = language;
        const voice = speechSynthesis
          .getVoices()
          .find((item) => item.lang.toLowerCase().startsWith(language.toLowerCase().split('-')[0]!));
        if (voice) utterance.voice = voice;
        utterance.onend = done;
        utterance.onerror = done;
        speechSynthesis.speak(utterance);
      },
      cancel: () => speechSynthesis.cancel(),
    },
    now: () => Date.now(),
  };
}
