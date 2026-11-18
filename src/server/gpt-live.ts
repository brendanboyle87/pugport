import { createHash, randomUUID } from 'node:crypto';

/*
 * GPT Live voice sessions for Mods. The backend holds the OpenAI connection and key; the window sends microphone
 * audio and plays the model's audio through one exchange route, and never sees the key. Protocol per
 * developers.openai.com Live guides: session.start → session.started, session.input_audio.append, output audio and
 * transcript deltas, session.usage.updated (cumulative seconds), session.close → session.closed.
 *
 * One window session may run on several provider sessions: when a card's budget runs out or its connection drops,
 * the next eligible OpenAI card starts a new provider session seeded with the conversation so far (`input`), and the
 * window's session limits keep counting across them.
 */

export const GPT_LIVE_MODEL = 'gpt-live-1';
export const GPT_LIVE_URL = 'wss://api.openai.com/v1/live/sessions';
/** Billed per second of session time, silence included ($0.05 per minute). */
export const GPT_LIVE_USD_PER_SECOND = 0.05 / 60;
export const GPT_LIVE_MAX_SECONDS = 30 * 60;
/** A card needs at least a minute of voice time left to start. */
export const GPT_LIVE_MIN_START_USD = 0.05;
/** A window that stops exchanging audio (closed, crashed, asleep) ends its paid session. */
export const GPT_LIVE_SILENT_WINDOW_MS = 10_000;
export const GPT_LIVE_COOLDOWN_MS = 2 * 60_000;
// Documented startup history limits: 128 messages and 8,192 tokens; characters stay well under that.
const historyMessages = 128;
const historyChars = 20_000;
const startTimeoutMs = 15_000;
const closeTimeoutMs = 3_000;

export type LiveSocket = {
  send(data: string): void;
  close(): void;
  onmessage: ((data: string) => void) | null;
  onclose: (() => void) | null;
};
export type LiveConnect = (key: string) => Promise<LiveSocket>;
/** An enabled OpenAI API card with a key and `gpt-live-1`; remainingUsd is undefined without a budget. */
export type LiveCard = { targetId: string; key: string; remainingUsd?: number };
export type LiveCloseReason = 'mod' | 'cap' | 'limit' | 'expired' | 'content' | 'remote' | 'error' | 'window';
export type LiveUnavailable = 'no-card' | 'budget' | 'cooldown' | 'busy';
export type LiveEvent =
  | { type: 'transcript'; role: 'user' | 'assistant'; text: string }
  | { type: 'usage'; seconds: number; costUsd: number }
  | { type: 'switched'; reason: 'cap' | 'error' }
  | { type: 'closed'; reason: LiveCloseReason };
export class GptLiveError extends Error {
  constructor(readonly code: 'unavailable' | 'busy' | 'failed') {
    super(code);
  }
}

/** Node's WebSocket sends the key as a header; nothing about it reaches the window. */
export const openLiveSocket: LiveConnect = (key) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(GPT_LIVE_URL, { headers: { Authorization: `Bearer ${key}` } } as never);
    const socket: LiveSocket = {
      send: (data) => ws.send(data),
      close: () => ws.close(),
      onmessage: null,
      onclose: null,
    };
    const timer = setTimeout(() => {
      ws.close();
      reject(new GptLiveError('failed'));
    }, startTimeoutMs);
    ws.onopen = () => {
      clearTimeout(timer);
      resolve(socket);
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new GptLiveError('failed'));
    };
    ws.onmessage = (event) => socket.onmessage?.(String(event.data));
    ws.onclose = () => socket.onclose?.();
  });

type Host = {
  /** The OpenAI cards that could run GPT Live, with their budget left. */
  cards(): LiveCard[];
  /** What a card may still spend now; undefined without a budget, 0 once disabled or expired. */
  remainingUsd(targetId: string): number | undefined;
  record(targetId: string, costUsd: number): void;
  connect: LiveConnect;
  now(): number;
};
type Upstream = {
  socket: LiveSocket;
  targetId: string;
  group: string;
  startedAt: number;
  billedSeconds: number;
  retiring: boolean;
  settled: boolean;
};
type Session = {
  id: string;
  instructions: string;
  voice: string;
  maxSeconds: number;
  maxCostUsd?: number;
  /** Seconds and cost of provider sessions already settled or retiring. */
  priorSeconds: number;
  priorCostUsd: number;
  history: { role: 'user' | 'assistant'; text: string }[];
  /** Quota groups this session left because they ran out or failed. */
  spent: Set<string>;
  upstream?: Upstream;
  switching: boolean;
  events: LiveEvent[];
  audio: string[];
  closed: boolean;
  closing?: LiveCloseReason;
  watchdog?: ReturnType<typeof setTimeout>;
};
const closeReasons: Record<string, LiveCloseReason> = {
  close_requested: 'mod',
  expired: 'expired',
  content: 'content',
  remote_hangup: 'remote',
  connection_lost: 'error',
};
/** Cards with the same key share one project budget; switching between them gains nothing. */
const quotaGroup = (key: string) => createHash('sha256').update(key).digest('hex').slice(0, 16);

/** At most one paid voice session at a time; each provider session is billed to the card it ran on. */
export class GptLive {
  private session?: Session;
  private cooldown = new Map<string, number>();
  constructor(private readonly host: Host) {}

  /** Eligible cards, most credit left first; pay-as-you-go cards without a budget come last. */
  private candidates(exclude: ReadonlySet<string> = new Set()) {
    const now = this.host.now();
    const seen = new Set<string>();
    return this.host
      .cards()
      .map((card) => ({ ...card, group: quotaGroup(card.key) }))
      .filter((card) => {
        if (seen.has(card.group) || exclude.has(card.group)) return false;
        seen.add(card.group);
        return (card.remainingUsd ?? Infinity) >= GPT_LIVE_MIN_START_USD && (this.cooldown.get(card.group) ?? 0) <= now;
      })
      .sort((a, b) => (b.remainingUsd ?? -1) - (a.remainingUsd ?? -1));
  }

  /** Whether a session could start now, and why not. */
  status(): { available: boolean; reason?: LiveUnavailable } {
    if (this.session && !this.session.closed) return { available: false, reason: 'busy' };
    const cards = this.host.cards();
    if (!cards.length) return { available: false, reason: 'no-card' };
    if (this.candidates().length) return { available: true };
    const now = this.host.now();
    return {
      available: false,
      reason: cards.some(
        (card) =>
          (card.remainingUsd ?? Infinity) >= GPT_LIVE_MIN_START_USD &&
          (this.cooldown.get(quotaGroup(card.key)) ?? 0) > now,
      )
        ? 'cooldown'
        : 'budget',
    };
  }

  available(): boolean {
    return this.status().available || this.status().reason === 'busy';
  }

  async start(input: {
    instructions: string;
    voice?: string;
    maxMinutes?: number;
    maxCostUsd?: number;
  }): Promise<{ id: string }> {
    if (this.session && !this.session.closed) throw new GptLiveError('busy');
    const session: Session = {
      id: randomUUID(),
      instructions: input.instructions,
      voice: input.voice ?? 'marin',
      maxSeconds: Math.min(GPT_LIVE_MAX_SECONDS, Math.round((input.maxMinutes ?? 30) * 60)),
      ...(input.maxCostUsd !== undefined ? { maxCostUsd: input.maxCostUsd } : {}),
      priorSeconds: 0,
      priorCostUsd: 0,
      history: [],
      spent: new Set(),
      switching: false,
      events: [],
      audio: [],
      closed: false,
    };
    this.session = session;
    if (!(await this.open(session))) {
      session.closed = true;
      throw new GptLiveError(this.candidates().length ? 'failed' : 'unavailable');
    }
    this.touch(session);
    return { id: session.id };
  }

  /** Sends microphone audio (24 kHz PCM16) and returns what arrived since the last exchange. */
  exchange(id: string, pcm: Uint8Array): { events: LiveEvent[]; audio: string[] } {
    const session = this.find(id);
    const upstream = session.upstream;
    if (!session.closed && upstream && !upstream.retiring && pcm.byteLength)
      upstream.socket.send(
        JSON.stringify({ type: 'session.input_audio.append', audio: Buffer.from(pcm).toString('base64') }),
      );
    if (!session.closed) this.touch(session);
    const result = { events: session.events, audio: session.audio };
    session.events = [];
    session.audio = [];
    if (session.closed && this.session === session) this.session = undefined;
    return result;
  }

  /** Steers the conversation; the docs note this may interrupt the model's current speech. */
  instruct(id: string, text: string) {
    const upstream = this.find(id).upstream;
    if (!upstream || upstream.retiring) return;
    upstream.socket.send(
      JSON.stringify({ type: 'session.instructions.append', delegation_id: null, content: text.slice(0, 2000) }),
    );
  }

  close(id: string, reason: LiveCloseReason = 'mod') {
    const session = this.session?.id === id ? this.session : undefined;
    if (session) this.end(session, reason);
  }

  private find(id: string): Session {
    if (this.session?.id !== id) throw new GptLiveError('unavailable');
    return this.session;
  }

  private touch(session: Session) {
    clearTimeout(session.watchdog);
    session.watchdog = setTimeout(() => this.end(session, 'window'), GPT_LIVE_SILENT_WINDOW_MS);
  }

  /** Opens a provider session on the best eligible card, trying the next one when a start fails. */
  private async open(session: Session): Promise<boolean> {
    for (;;) {
      if (session.closed || session.closing) return false;
      const card = this.candidates(session.spent)[0];
      if (!card) return false;
      try {
        await this.connect(session, card);
        return true;
      } catch {
        // A card that cannot start rests for a while; the session tries the next one.
        this.cooldown.set(card.group, this.host.now() + GPT_LIVE_COOLDOWN_MS);
      }
    }
  }

  private async connect(session: Session, card: LiveCard & { group: string }) {
    const socket = await this.host.connect(card.key);
    const upstream: Upstream = {
      socket,
      targetId: card.targetId,
      group: card.group,
      startedAt: this.host.now(),
      billedSeconds: 0,
      retiring: false,
      settled: false,
    };
    const input = this.seed(session);
    await new Promise<void>((resolve, reject) => {
      const fail = () => {
        clearTimeout(timer);
        socket.onmessage = null;
        socket.onclose = null;
        socket.close();
        // Refused before the session started: nothing ran, so nothing is charged.
        reject(new GptLiveError('failed'));
      };
      const timer = setTimeout(fail, startTimeoutMs);
      socket.onclose = fail;
      socket.onmessage = (data) => {
        let event: { type?: string };
        try {
          event = JSON.parse(data);
        } catch {
          return;
        }
        if (event.type === 'session.started') {
          clearTimeout(timer);
          socket.onmessage = (next) => this.receive(session, upstream, next);
          socket.onclose = () => this.dropped(session, upstream);
          resolve();
        } else if (event.type === 'error' || event.type === 'session.closed') fail();
      };
      socket.send(
        JSON.stringify({
          type: 'session.start',
          event_id: `start_${randomUUID()}`,
          session: {
            model: GPT_LIVE_MODEL,
            instructions: session.instructions,
            ...(input.length ? { input } : {}),
            audio: { format: { type: 'audio/pcm', rate: 24000 }, output: { voice: session.voice } },
            delegation: { type: 'client' },
          },
        }),
      );
    });
    if (session.closed || session.closing) {
      this.retire(session, upstream);
      return;
    }
    session.upstream = upstream;
  }

  /** The conversation so far, as the documented startup history: newest messages that fit. */
  private seed(session: Session) {
    const items: { type: 'message'; role: 'user' | 'assistant'; content: { type: string; text: string }[] }[] = [];
    let chars = 0;
    for (const message of [...session.history].reverse()) {
      const text = message.text.trim();
      if (!text) continue;
      if (items.length >= historyMessages || chars + text.length > historyChars) break;
      chars += text.length;
      items.unshift({
        type: 'message',
        role: message.role,
        content: [{ type: message.role === 'user' ? 'input_text' : 'output_text', text }],
      });
    }
    return items;
  }

  private receive(session: Session, upstream: Upstream, data: string) {
    let event: {
      type?: string;
      delta?: unknown;
      usage?: { seconds?: unknown };
      reason?: unknown;
    };
    try {
      event = JSON.parse(data);
    } catch {
      return;
    }
    // A retiring provider session still settles its usage, but its audio and words are no longer live.
    const live = session.upstream === upstream && !upstream.retiring && !session.closed;
    switch (event.type) {
      case 'session.output_audio.delta':
        if (live && typeof event.delta === 'string') session.audio.push(event.delta);
        break;
      case 'session.input_transcript.delta':
      case 'session.output_transcript.delta': {
        if (!live || typeof event.delta !== 'string' || !event.delta) break;
        const role = event.type === 'session.input_transcript.delta' ? 'user' : 'assistant';
        const last = session.history.at(-1);
        if (last?.role === role) last.text += event.delta;
        else session.history.push({ role, text: event.delta });
        if (session.history.length > historyMessages * 2) session.history.splice(0, historyMessages);
        session.events.push({ type: 'transcript', role, text: event.delta });
        break;
      }
      case 'session.usage.updated':
        this.bill(session, upstream, event.usage?.seconds);
        break;
      case 'session.closed': {
        this.bill(session, upstream, event.usage?.seconds);
        upstream.settled = true;
        this.release(upstream);
        // Our own close of the current provider session: its final usage is in, so the session ends now.
        if (session.upstream === upstream && session.closing && !session.closed) {
          this.finish(session, session.closing);
          break;
        }
        if (!live) break;
        const reason = closeReasons[typeof event.reason === 'string' ? event.reason : ''] ?? 'error';
        // Policy stops and duration limits end the session; a dropped connection moves to the next card.
        if (reason === 'error' || reason === 'remote') void this.switchCard(session, 'error');
        else this.finish(session, session.closing ?? reason);
        break;
      }
    }
  }

  /** The socket closed without a final report: charge the elapsed time, then continue elsewhere if live. */
  private dropped(session: Session, upstream: Upstream) {
    if (!upstream.settled) {
      this.bill(session, upstream, Math.ceil((this.host.now() - upstream.startedAt) / 1000));
      upstream.settled = true;
    }
    this.release(upstream);
    if (session.upstream !== upstream || upstream.retiring || session.closed) return;
    if (session.closing) this.finish(session, session.closing);
    else void this.switchCard(session, 'error');
  }

  /** Usage reports are cumulative snapshots per provider session: only the new seconds are charged. */
  private bill(session: Session, upstream: Upstream, value: unknown) {
    const seconds = typeof value === 'number' && Number.isFinite(value) ? value : undefined;
    if (seconds === undefined || seconds <= upstream.billedSeconds || upstream.settled) return;
    const cost = (seconds - upstream.billedSeconds) * GPT_LIVE_USD_PER_SECOND;
    this.host.record(upstream.targetId, cost);
    session.priorSeconds += seconds - upstream.billedSeconds;
    session.priorCostUsd += cost;
    upstream.billedSeconds = seconds;
    session.events.push({
      type: 'usage',
      seconds: session.priorSeconds,
      costUsd: session.priorSeconds * GPT_LIVE_USD_PER_SECOND,
    });
    if (session.closed || session.closing || upstream !== session.upstream || upstream.retiring) return;
    // The session's own limits hold across cards; stop with a few seconds of headroom.
    const headroom = 5 * GPT_LIVE_USD_PER_SECOND;
    if (
      session.priorSeconds >= session.maxSeconds ||
      (session.maxCostUsd !== undefined && session.priorCostUsd + headroom >= session.maxCostUsd)
    )
      this.end(session, 'limit');
    else if ((this.host.remainingUsd(upstream.targetId) ?? Infinity) <= headroom) void this.switchCard(session, 'cap');
  }

  /** Leaves the current card and continues the same conversation on the next eligible one. */
  private async switchCard(session: Session, reason: 'cap' | 'error') {
    if (session.switching || session.closed || session.closing) return;
    session.switching = true;
    const previous = session.upstream;
    if (previous) {
      session.spent.add(previous.group);
      if (reason === 'error') this.cooldown.set(previous.group, this.host.now() + GPT_LIVE_COOLDOWN_MS);
      this.retire(session, previous);
    }
    session.upstream = undefined;
    const opened = await this.open(session);
    session.switching = false;
    if (session.closed || session.closing) return;
    if (opened) session.events.push({ type: 'switched', reason });
    else this.finish(session, reason);
  }

  /** Asks a provider session to close; its final usage still arrives and is charged to its own card. */
  private retire(_session: Session, upstream: Upstream) {
    if (upstream.retiring) return;
    upstream.retiring = true;
    try {
      upstream.socket.send(JSON.stringify({ type: 'session.close' }));
    } catch {
      // Already disconnected.
    }
    setTimeout(() => {
      if (!upstream.settled) {
        this.bill(_session, upstream, Math.ceil((this.host.now() - upstream.startedAt) / 1000));
        upstream.settled = true;
      }
      this.release(upstream);
    }, closeTimeoutMs).unref?.();
  }

  /** Disconnects a provider session once its usage is settled. */
  private release(upstream: Upstream) {
    if (!upstream.settled) return;
    upstream.socket.onmessage = null;
    upstream.socket.onclose = null;
    try {
      upstream.socket.close();
    } catch {
      // Nothing left to close.
    }
  }

  private end(session: Session, reason: LiveCloseReason) {
    if (session.closed || session.closing) return;
    session.closing = reason;
    const upstream = session.upstream;
    if (!upstream) {
      this.finish(session, reason);
      return;
    }
    this.retire(session, upstream);
    // The final usage comes with session.closed; a silent provider still closes after a few seconds.
    setTimeout(() => this.finish(session, reason), closeTimeoutMs + 100).unref?.();
  }

  private finish(session: Session, reason: LiveCloseReason) {
    if (session.closed) return;
    session.closed = true;
    clearTimeout(session.watchdog);
    const upstream = session.upstream;
    if (upstream && !upstream.settled) {
      this.bill(session, upstream, Math.ceil((this.host.now() - upstream.startedAt) / 1000));
      upstream.settled = true;
      this.release(upstream);
    }
    session.events.push({ type: 'closed', reason });
    // Nobody collects the events of a window that went away.
    if (reason === 'window' && this.session === session) this.session = undefined;
  }
}
