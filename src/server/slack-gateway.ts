import { ExternalEvents, type ExternalEvent } from './external-events.ts';
import { AdmissionRules, admit, textPreference } from './external-admission.ts';
import type { Inbox } from './inbox.ts';
import { assertTestUrl } from './platform/under-test.ts';
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import type { SlackConnectionStatus, SlackGatewayView, SlackPairingCode } from '../shared/slack-gateway.ts';
import { keyHint } from './api-providers.ts';
import { SlackConnectionLock, type SlackLockOptions } from './slack-connection-lock.ts';
import {
  validAppToken,
  validBotToken,
  validSlackUserId,
  SlackThreadStore,
  type SlackConfigStore,
} from './slack-config.ts';
import {
  readSlackContext,
  slackCall,
  slackPrompt,
  splitForSlack,
  escapeSlack,
  SlackApiError,
  SlackDirectory,
  type Fetch,
} from './slack-context.ts';

/**
 * Runs Slack requests as PugPort tasks; PugPort picks the account. `conversationId` continues the conversation
 * a Slack thread already has. `readOnly` asks for chat only: no file writes or other changes on this computer.
 * `untrusted` says the task quotes other people's messages: it then runs with no tools at all, so those
 * messages cannot make an executor read files on this computer. `no-safe-executor`: no executor can do that now.
 */
export interface SlackTaskRunner {
  dispatch(input: {
    task: string;
    caller: string;
    title: string;
    readOnly: boolean;
    owner?: boolean;
    untrusted?: boolean;
    conversationId?: string;
  }): Promise<{ taskId: string; conversationId: string }>;
  result(
    taskId: string,
    waitSeconds: number,
  ): Promise<{ status: string; result?: string; error?: string; code?: 'no-safe-executor' }>;
}

/** The part of the WHATWG WebSocket (global in Node 24) the gateway uses. */
export interface SlackSocket {
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: any) => void): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface SlackGatewayOptions {
  store: SlackConfigStore;
  events?: ExternalEvents;
  inbox?: Inbox;
  classify?: (text: string) => Promise<string>;
  tasks?: SlackTaskRunner;
  fetch?: Fetch;
  createSocket?: (url: string) => SlackSocket;
  log?: (line: string) => void;
  now?: () => number;
  retryDelaysMs?: number[];
  helloTimeoutMs?: number;
  resultWaitSeconds?: number;
  taskTimeoutMs?: number;
  maxActivePerUser?: number;
  maxTasksPerHour?: number;
  contextChars?: number;
  /** Where the thread → conversation map is kept; defaults to next to the Slack settings. */
  threadsFile?: string;
  /** How long stopping may spend updating "working" notes. */
  stopNoticeMs?: number;
  role?: 'desktop' | 'node';
  /** Tests can model distinct processes/config roots with one shared machine secrets directory. */
  lock?: Omit<SlackLockOptions, 'role'>;
}

export type SlackLanguage = 'zh' | 'en';
/** Chinese characters get a Chinese reply; anything else, including no text at all, gets English. */
export const slackLanguage = (text: string): SlackLanguage => (/[㐀-䶿一-鿿豈-﫿]/.test(text) ? 'zh' : 'en');

const zh = {
  working: '收到，正在处理…',
  refused:
    '抱歉，你还没有和这台 PugPort 配对，我不能替你做事。PugPort 的主人可以在「扩展 → 连接与服务 → Slack」里拿到配对码。',
  pairOnlyInDm: '配对只能在私信里做。这个配对码已作废，请在 PugPort 里重新生成。',
  pairExpired: '配对码无效或已过期，请在 PugPort 里重新生成。',
  pairWrong: '配对码不对，请核对后再发。',
  pairDone: '配对成功！现在可以直接私信我发任务；在频道里用时请 @我。',
  alreadyPaired: '你已经配对过了，直接发任务就行。',
  empty: '请在消息里写上要我做的事，比如「总结这个话题」。',
  busy: (limit: number) => `你已有 ${limit} 个任务在处理，请等其中一个完成后再发。`,
  hourly: (limit: number) => `这一小时已经处理了 ${limit} 个任务，请稍后再发。`,
  notReady: 'PugPort 还没准备好处理 Slack 任务，请稍后再试。',
  inviteBot: '我还读不了这个频道。请先在频道里输入 /invite @pugport 把我拉进来，然后再 @我。',
  missingScope: 'PugPort 的 Slack 应用缺少读取权限。请用 PugPort 里最新的 manifest 更新应用并重新安装。',
  timedOut: '等了太久还没有结果，请到 PugPort 里查看这条任务。',
  noSafeExecutor:
    '这条请求带着其他人的消息。为了不让别人借机读到你电脑上的文件，它只能交给不读文件的执行器（Claude、Grok 或 API 执行器），但现在一个都用不了。请在 PugPort 里启用一个后再试。',
  stopped: 'PugPort 在完成前停止了，答案会留在 PugPort 的对话里。',
  failed: (reason: string) => `没做成：${reason}`,
  slackError: (code: string) => `Slack 返回错误（${code}）`,
  notStarted: '任务没能开始。',
  status: (status: string) => `任务状态：${status}`,
};
const en: typeof zh = {
  working: 'Got it, working on it…',
  refused:
    "Sorry, you haven't been paired with this PugPort, so I can't act for you. Its owner can get a pairing code under Extensions → Connections → Slack.",
  pairOnlyInDm: 'Pairing only works in a direct message. That code is now void; make a new one in PugPort.',
  pairExpired: 'That pairing code is invalid or has expired. Make a new one in PugPort.',
  pairWrong: "That pairing code doesn't match. Check it and send it again.",
  pairDone: 'Paired! You can DM me tasks now; in channels, @mention me.',
  alreadyPaired: "You're already paired. Just send me a task.",
  empty: 'Tell me what to do in the message, for example “summarize this thread”.',
  busy: (limit) => `You already have ${limit} tasks running. Wait for one to finish.`,
  hourly: (limit) => `I've already handled ${limit} tasks for you this hour. Try again later.`,
  notReady: "PugPort isn't ready for Slack tasks yet. Try again shortly.",
  inviteBot: "I can't read this channel yet. Type /invite @pugport here, then @mention me again.",
  missingScope:
    "PugPort's Slack app is missing read permission. Update the app with the latest manifest from PugPort and reinstall it.",
  timedOut: 'This is taking too long. Check the task in PugPort.',
  noSafeExecutor:
    "This request includes other people's messages. To keep them from reaching files on your computer, it can only go to an executor that doesn't read files (Claude, Grok or an API executor), and none is available right now. Enable one in PugPort and try again.",
  stopped: "PugPort stopped before finishing. The answer will be in PugPort's chat.",
  failed: (reason) => `Not done: ${reason}`,
  slackError: (code) => `Slack returned an error (${code})`,
  notStarted: "the task couldn't start.",
  status: (status) => `task status: ${status}`,
};
/** Everything the bot says in Slack, in both languages. */
export const slackText = { zh, en };

class Notice extends Error {}
const pendingStatuses = new Set(['queued', 'pending', 'running', 'waiting', 'in_progress', 'working', 'accepted']);
const fatalCodes = new Set([
  'invalid_auth',
  'not_authed',
  'token_revoked',
  'token_expired',
  'account_inactive',
  'not_allowed_token_type',
  'missing_scope',
  'invalid_token',
]);
const pairingAlphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const pairingLifetimeMs = 10 * 60 * 1000;
const refusalCooldownMs = 10 * 60 * 1000;

interface Incoming {
  eventKey?: string;
  user: string;
  channel: string;
  ts: string;
  threadTs?: string;
  text: string;
  dm: boolean;
  lang: SlackLanguage;
}
interface PendingAck {
  channel: string;
  ts: string;
  lang: SlackLanguage;
}
interface Thread {
  conversationId?: string;
  lastTs?: string;
  tail: Promise<void>;
  busy: number;
}

function connectionError(token: 'app' | 'bot', code: string): string {
  if (code === 'network' || code.startsWith('http_5')) return '连不上 Slack，正在重试。';
  if (code === 'ratelimited' || code === 'http_429') return 'Slack 暂时限流，稍后自动重试。';
  if (token === 'app') {
    if (code === 'missing_scope') return 'App-Level Token 缺少 connections:write 权限，请重新生成。';
    if (code === 'not_allowed_token_type') return 'App-Level Token 类型不对，应以 xapp- 开头。';
    if (fatalCodes.has(code)) return 'App-Level Token 无效或已撤销，请在 Slack 应用的 Basic Information 页重新生成。';
  } else if (fatalCodes.has(code)) return 'Bot Token 无效或已撤销，请重新安装应用后复制 xoxb- 开头的 Token。';
  return `Slack 返回错误（${code}），正在重试。`;
}

/**
 * Slack Socket Mode: PugPort dials out to Slack, so no public URL is needed. Every envelope is acknowledged at
 * once; only paired users can start tasks, each Slack thread continues one PugPort conversation, and the answer
 * replaces the "working" note in that thread.
 */
export class SlackGateway {
  private readonly fetch: Fetch;
  private readonly createSocket: (url: string) => SlackSocket;
  private readonly log: (line: string) => void;
  private readonly now: () => number;
  private readonly retryDelays: number[];
  private tasks?: SlackTaskRunner;
  private status: SlackConnectionStatus = 'off';
  private error?: string;
  private socket?: SlackSocket;
  private socketClosed?: Promise<void>;
  private socketLease?: SlackConnectionLock;
  private connectionWork: Promise<void> = Promise.resolve();
  private lockHost?: string;
  private run = 0;
  private attempt = 0;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private helloTimer?: ReturnType<typeof setTimeout>;
  private session?: AbortController;
  private closed = false;
  private identity?: { botUserId: string; botId?: string; botName?: string; team?: string };
  private directory: SlackDirectory;
  private pairing?: { code: string; expiresAt: number; attemptsLeft: number; isOwner?: boolean };
  private receiptTimer?: ReturnType<typeof setInterval>;
  private receiptsBusy = new Set<string>();
  private queuedEvents = new Set<string>();
  private admittingEvents = new Set<string>();
  private recovering = false;
  private refusedAt = new Map<string, number>();
  private seenEvents = new Set<string>();
  private threads = new Map<string, Thread>();
  private assistantViews = new Map<string, string>();
  private active = new Map<string, number>();
  private recent = new Map<string, number[]>();
  private threadStore: SlackThreadStore;
  private pendingAcks = new Set<PendingAck>();
  /** Another PugPort (a device node) runs Slack: this one stays disconnected, whatever its own setting says. */
  private standby?: { hostedBy: string };

  constructor(private readonly options: SlackGatewayOptions) {
    this.tasks = options.tasks;
    this.fetch = options.fetch ?? fetch;
    this.createSocket =
      options.createSocket ??
      ((url) => {
        assertTestUrl(url.replace(/^ws/, 'http'));
        return new WebSocket(url);
      });
    this.log = options.log ?? ((line) => console.info(line));
    this.now = options.now ?? Date.now;
    this.retryDelays = options.retryDelaysMs ?? [1000, 2000, 5000, 10_000, 30_000, 60_000];
    this.directory = new SlackDirectory((method, args) => this.botCall(method, args));
    this.threadStore = new SlackThreadStore(options.threadsFile ?? options.store.threadsFile, this.now);
  }

  /** Wired after construction, once PugPort's external task service exists. */
  setTasks(tasks: SlackTaskRunner) {
    this.tasks = tasks;
  }

  async start() {
    const config = await this.options.store.read();
    if (this.socket && this.status === 'connected') return;
    if (config.enabled && config.appToken && config.botToken && !this.closed) this.open();
  }

  /** Only one PugPort may run Slack: `hostedBy` (the other one's name) stops this gateway, undefined resumes it. */
  async setStandby(hostedBy: string | undefined) {
    this.standby = hostedBy === undefined ? undefined : { hostedBy };
    if (this.standby) await this.shut();
    else await this.start();
  }

  async view(): Promise<SlackGatewayView> {
    const config = await this.options.store.read();
    const pairing = this.pairing && this.pairing.expiresAt > this.now() ? this.pairing : undefined;
    return {
      enabled: config.enabled,
      status: config.enabled ? this.status : 'off',
      ...(config.enabled && this.error ? { error: this.error } : {}),
      ...(config.appToken ? { appTokenHint: keyHint(config.appToken) } : {}),
      ...(config.botToken ? { botTokenHint: keyHint(config.botToken) } : {}),
      ...(this.identity?.team ? { workspace: this.identity.team } : {}),
      ...(this.identity?.botName ? { botName: this.identity.botName } : {}),
      ...(pairing ? { pairingExpiresAt: new Date(pairing.expiresAt).toISOString() } : {}),
      users: config.users.map(({ id, name, pairedAt, isOwner }) => ({
        id,
        ...(name ? { name } : {}),
        pairedAt,
        isOwner,
      })),
      activeTasks: [...this.active.values()].reduce((sum, count) => sum + count, 0),
      ...(this.standby || this.lockHost ? { hostedBy: this.standby?.hostedBy ?? this.lockHost } : {}),
    };
  }

  async saveTokens(input: { appToken?: string; botToken?: string }): Promise<SlackGatewayView> {
    const appToken = input.appToken?.trim() ? validAppToken(input.appToken) : undefined;
    const botToken = input.botToken?.trim() ? validBotToken(input.botToken) : undefined;
    if (!appToken && !botToken) throw new Error('请至少填一个 Token。');
    const config = await this.options.store.update((config) => {
      if (appToken) config.appToken = appToken;
      if (botToken) config.botToken = botToken;
      return config;
    });
    if (botToken) this.identity = undefined;
    if (config.enabled && !this.closed) this.open();
    return this.view();
  }

  async setEnabled(enabled: boolean): Promise<SlackGatewayView> {
    await this.options.store.update((config) => {
      if (enabled && (!config.appToken || !config.botToken)) throw new Error('请先填好 App-Level Token 和 Bot Token。');
      config.enabled = enabled;
    });
    if (enabled && !this.closed) this.open();
    else await this.shut();
    return this.view();
  }

  async removeUser(id: string): Promise<SlackGatewayView> {
    if (!validSlackUserId(id)) throw new Error('Slack 用户标识无效。');
    await this.options.store.update((config) => {
      config.users = config.users.filter((user) => user.id !== id);
    });
    return this.view();
  }

  /** A one-time code the owner sends to the bot in a DM. Five wrong guesses in total void it. */
  createPairingCode(isOwner = false): SlackPairingCode {
    // The code would be sent to the bot, which is answered by the PugPort that runs Slack, not this one.
    if (this.standby)
      throw new Error(
        `现在由「${this.standby.hostedBy}」运行 Slack：要配对新的 Slack 用户，先在「设备」里把 Slack 切回本机。`,
      );
    const code = Array.from({ length: 6 }, () => pairingAlphabet[randomInt(pairingAlphabet.length)]).join('');
    const expiresAt = this.now() + pairingLifetimeMs;
    this.pairing = { code, expiresAt, attemptsLeft: 5, isOwner };
    return { code, expiresAt: new Date(expiresAt).toISOString() };
  }

  /** PugPort is quitting: drop the connection and stop waiting for answers. Takes at most ~2 seconds. */
  async close() {
    this.closed = true;
    await Promise.all([this.shut(), this.threadStore.flush()]);
  }

  private open() {
    if (this.standby) return;
    this.session ??= new AbortController();
    this.run++;
    clearTimeout(this.retryTimer);
    clearTimeout(this.helloTimer);
    this.status = 'connecting';
    this.error = undefined;
    this.attempt = 0;
    this.queueConnect(this.run);
  }

  private async shut() {
    clearInterval(this.receiptTimer);
    this.run++;
    clearTimeout(this.retryTimer);
    clearTimeout(this.helloTimer);
    this.session?.abort();
    this.session = undefined;
    await this.waitForClose(Promise.all([this.disconnect(), this.connectionWork]));
    // An in-flight acquire may finish after the first disconnect; its release must also be confirmed.
    await this.disconnect();
    this.status = 'off';
    this.error = undefined;
    const stranded = [...this.pendingAcks];
    this.pendingAcks.clear();
    await this.stopNotices(stranded);
  }

  /** Best effort, bounded: turn notes still saying "working" into a line that points to PugPort. */
  private async stopNotices(stranded: PendingAck[]) {
    if (!stranded.length) return;
    const limit = this.options.stopNoticeMs ?? 2000;
    const token = (await this.options.store.read().catch(() => undefined))?.botToken;
    if (!token) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled(
        stranded.map((ack) =>
          slackCall(
            this.fetch,
            'chat.update',
            token,
            { channel: ack.channel, ts: ack.ts, text: escapeSlack(slackText[ack.lang].stopped) },
            { timeoutMs: limit, attempts: 1 },
          ),
        ),
      ),
      new Promise((resolve) => (timer = setTimeout(resolve, limit))),
    ]);
    clearTimeout(timer);
  }

  private async waitForClose(work: Promise<unknown>) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Slack socket did not close; the new host remains on standby.')),
            3000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async disconnect() {
    const socket = this.socket;
    if (socket) {
      const closed = this.socketClosed!;
      socket.close(1000);
      await this.waitForClose(closed);
    }
    this.socketLease?.release();
    this.socketLease = undefined;
  }

  private queueConnect(run: number) {
    this.connectionWork = this.connectionWork
      .catch(() => {})
      .then(async () => {
        if (run !== this.run || this.standby || this.closed) return;
        await this.disconnect();
        if (run === this.run && !this.standby && !this.closed) await this.connect(run);
      })
      .catch((error: unknown) => {
        if (run !== this.run) return;
        this.status = 'error';
        this.error = error instanceof Error ? error.message : 'Slack socket did not close.';
        this.retry(run);
      });
  }

  private retry(run: number) {
    if (run !== this.run) return;
    const delay = this.retryDelays[Math.min(this.attempt++, this.retryDelays.length - 1)] ?? 60_000;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      if (run === this.run) this.queueConnect(run);
    }, delay);
    this.retryTimer.unref?.();
  }

  private async lostLock(run: number) {
    if (run !== this.run || this.standby || this.closed) return;
    this.lockHost = '本机的另一个 PugPort';
    const stopping = this.shut();
    const recoveryRun = this.run;
    await stopping.catch((error: unknown) => this.log(`[slack] ${String(error)}`));
    // A close can arrive after shut's timeout; never reopen before that confirmation.
    await this.socketClosed;
    const config = await this.options.store.read();
    if (recoveryRun !== this.run || this.standby || this.closed || !config.enabled) return;
    this.session ??= new AbortController();
    this.retry(recoveryRun);
  }

  private async connect(run: number) {
    let token: 'app' | 'bot' = 'bot';
    const lease = new SlackConnectionLock({
      directory: this.options.store.secretsDir,
      role: this.options.role ?? 'desktop',
      ...this.options.lock,
    });
    let socketOwnsLease = false;
    try {
      const config = await this.options.store.read();
      if (run !== this.run) return;
      if (!config.appToken || !config.botToken) {
        this.status = 'error';
        this.error = '请先填好 App-Level Token 和 Bot Token。';
        return;
      }
      if (!this.identity) {
        const auth = await slackCall(this.fetch, 'auth.test', config.botToken);
        if (run !== this.run) return;
        if (typeof auth.user_id !== 'string') throw new SlackApiError('bad_response');
        this.identity = {
          botUserId: auth.user_id,
          ...(typeof auth.bot_id === 'string' ? { botId: auth.bot_id } : {}),
          ...(typeof auth.user === 'string' ? { botName: auth.user } : {}),
          ...(typeof auth.team === 'string' ? { team: auth.team } : {}),
        };
      }
      token = 'app';
      // The app-id component is stable across rotations; no secret token text enters the lock key or record.
      const appId = /^xapp-\d+-(A[A-Z0-9]+)-/.exec(config.appToken)?.[1];
      if (!appId) throw new Error('Slack app identity is unavailable.');
      const acquired = await lease.acquire(appId, () => {
        void this.lostLock(run).catch((error: unknown) => this.log(`[slack] ${String(error)}`));
      });
      if (acquired) this.socketLease = lease;
      if (run !== this.run) return;
      if (!acquired) {
        this.lockHost = '本机的另一个 PugPort';
        this.status = 'off';
        this.retry(run);
        return;
      }
      this.lockHost = undefined;
      const opened = await slackCall(this.fetch, 'apps.connections.open', config.appToken);
      if (run !== this.run || !lease.owns()) return;
      if (typeof opened.url !== 'string' || !opened.url.startsWith('wss://')) throw new SlackApiError('bad_response');
      const socket = this.createSocket(opened.url);
      this.socket = socket;
      this.socketLease = lease;
      socketOwnsLease = true;
      this.socketClosed = new Promise<void>((resolve) => {
        socket.addEventListener('close', () => {
          try {
            lease.release();
            if (this.socketLease === lease) this.socketLease = undefined;
          } catch {
            // disconnect retries a failed release before acknowledging standby or opening another socket.
          }
          resolve();
          this.closedSocket(socket, run);
        });
      });
      socket.addEventListener('message', (event) => this.frame(socket, run, event?.data));
      socket.addEventListener('error', () => {
        /* A close event follows. */
      });
      clearTimeout(this.helloTimer);
      this.helloTimer = setTimeout(() => {
        if (socket !== this.socket) return;
        this.log('[slack] no hello from Slack; reconnecting');
        socket.close(1000);
      }, this.options.helloTimeoutMs ?? 20_000);
      this.helloTimer.unref?.();
    } catch (error) {
      if (run !== this.run) return;
      const code = error instanceof SlackApiError ? error.code : 'network';
      this.status = 'error';
      this.error = connectionError(token, code);
      this.log(`[slack] connection failed (${token} token): ${code}`);
      if (!fatalCodes.has(code)) this.retry(run);
    } finally {
      if (!socketOwnsLease) {
        lease.release();
        if (this.socketLease === lease) this.socketLease = undefined;
      }
    }
  }

  private closedSocket(socket: SlackSocket, run: number) {
    if (socket !== this.socket) return;
    this.socket = undefined;
    this.socketClosed = undefined;
    clearTimeout(this.helloTimer);
    if (run !== this.run || this.standby || this.closed) return;
    if (this.status === 'connected') this.status = 'connecting';
    this.log('[slack] connection closed; reconnecting');
    this.retry(run);
  }

  private frame(socket: SlackSocket, run: number, data: unknown) {
    if (socket !== this.socket || run !== this.run || typeof data !== 'string') return;
    let envelope: any;
    try {
      envelope = JSON.parse(data);
    } catch {
      return;
    }
    // Slack resends anything not acknowledged within three seconds, so acknowledge before any work.
    if (typeof envelope?.envelope_id === 'string') socket.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
    if (envelope?.type === 'hello') {
      clearTimeout(this.helloTimer);
      this.status = 'connected';
      this.error = undefined;
      this.attempt = 0;
      this.log('[slack] connected');
      if (this.options.events) {
        clearInterval(this.receiptTimer);
        this.receiptTimer = setInterval(() => void this.recoverEvents(), 2000);
        this.receiptTimer.unref?.();
        void this.recoverEvents();
      }
    } else if (envelope?.type === 'disconnect') {
      const reason = typeof envelope.reason === 'string' ? envelope.reason.slice(0, 40) : 'unknown';
      this.log(`[slack] Slack asked to reconnect (${reason})`);
      clearTimeout(this.helloTimer);
      socket.close(1000);
      if (reason === 'link_disabled') {
        this.status = 'error';
        this.error = 'Slack 应用关闭了 Socket Mode，请在应用设置里重新打开。';
        this.retry(run);
      }
    } else if (envelope?.type === 'events_api')
      void this.event(envelope.payload).catch((error) =>
        this.log(`[slack] event failed: ${error instanceof SlackApiError ? error.code : 'error'}`),
      );
  }

  private botCall(method: string, args?: Record<string, string | number | boolean | undefined>) {
    return this.options.store.read().then((config) => {
      if (!config.botToken) throw new SlackApiError('not_authed');
      return slackCall(this.fetch, method, config.botToken, args);
    });
  }

  private async event(payload: any) {
    if (this.options.events && payload?.event?.subtype === 'message_changed') {
      const edited = payload.event.message;
      const old = this.options.events
        .list()
        .find((e) => e.source === 'slack' && e.channel === payload.event.channel && e.ts === edited?.ts);
      if (old && typeof edited.text === 'string' && edited.user === old.senderId) {
        old.text = edited.text.slice(0, 8000);
        this.options.events.save(old);
        this.notice(old);
      }
      return;
    }
    const eventId = typeof payload?.event_id === 'string' ? payload.event_id : undefined;
    if (eventId) {
      if (this.seenEvents.has(eventId)) return;
      this.seenEvents.add(eventId);
      if (this.seenEvents.size > 1000) this.seenEvents.delete(this.seenEvents.values().next().value!);
    }
    const event = payload?.event;
    if (this.options.events && event?.bot_id && typeof event.channel === 'string' && typeof event.ts === 'string') {
      this.options.events.record({
        source: 'slack',
        scope: event.channel.startsWith('D') ? 'dm' : 'channel-mention',
        senderId: event.user ?? event.bot_id,
        senderName: event.bot_id,
        senderClass: 'bot',
        eventId: event.channel + ':' + event.ts,
        channel: event.channel,
        ts: event.ts,
        text: event.text ?? '',
        level: 'ignore',
        verdict: 'ignore',
        reason: '机器人消息',
      });
      return;
    }
    if (!event || typeof event !== 'object') return;
    if (event.type === 'assistant_thread_started' || event.type === 'assistant_thread_context_changed') {
      const thread = event.assistant_thread;
      const viewing = thread?.context?.channel_id;
      if (typeof thread?.channel_id === 'string' && typeof thread?.thread_ts === 'string') {
        const key = `${thread.channel_id}:${thread.thread_ts}`;
        if (typeof viewing === 'string') this.assistantViews.set(key, viewing);
        else this.assistantViews.delete(key);
        if (this.assistantViews.size > 500) this.assistantViews.delete(this.assistantViews.keys().next().value!);
      }
      return;
    }
    const botUserId = this.identity?.botUserId ?? payload?.authorizations?.[0]?.user_id;
    const message = this.incoming(event, botUserId);
    if (message) await this.handle(message);
  }

  private incoming(event: any, botUserId?: string): Incoming | undefined {
    // Edits, joins and bot posts carry a subtype; a message with a file or sent to the channel too is still a request.
    if (event.bot_id || event.edited || event.hidden) return;
    if (event.subtype && event.subtype !== 'file_share' && event.subtype !== 'thread_broadcast') return;
    if (typeof event.user !== 'string' || event.user === botUserId || !validSlackUserId(event.user)) return;
    if (typeof event.channel !== 'string' || typeof event.ts !== 'string' || typeof event.text !== 'string') return;
    const dm = event.channel_type === 'im' || event.channel.startsWith('D');
    // A mention inside a DM also arrives as a DM message; channel messages arrive only as mentions.
    if (event.type === 'app_mention' ? dm : event.type !== 'message' || !dm) return;
    const text = (
      botUserId ? event.text.replace(new RegExp(`<@${botUserId}(?:\\|[^>]*)?>`, 'g'), ' ') : event.text
    ).trim();
    return {
      user: event.user,
      channel: event.channel,
      ts: event.ts,
      ...(typeof event.thread_ts === 'string' ? { threadTs: event.thread_ts } : {}),
      text: text.slice(0, 8000),
      dm,
      lang: slackLanguage(text),
    };
  }

  private async handle(message: Incoming) {
    const pair = /^(?:pair|配对)\s+([A-Za-z0-9]{4,12})$/i.exec(message.text);
    const config = await this.options.store.read();
    const paired = config.users.some((user) => user.id === message.user);
    const text = slackText[message.lang];
    if (pair) return this.pair(message, pair[1]!, paired);
    if (!paired && (!this.options.events || message.dm)) return this.refuse(message);
    if (this.options.events)
      return this.admitMessage(
        message,
        config.users.find((u) => u.id === message.user),
      );
    if (!message.text) return this.say(message, text.empty);
    const limit = this.options.maxActivePerUser ?? 3;
    if ((this.active.get(message.user) ?? 0) >= limit) return this.say(message, text.busy(limit));
    const hourly = this.options.maxTasksPerHour ?? 30;
    const recent = (this.recent.get(message.user) ?? []).filter((at) => at > this.now() - 60 * 60 * 1000);
    if (recent.length >= hourly) return this.say(message, text.hourly(hourly));
    recent.push(this.now());
    this.recent.set(message.user, recent);
    this.queue(message);
  }

  /** Lines that answer a message go into its thread. */
  private say(message: Incoming, text: string) {
    return this.post(message.channel, message.threadTs ?? message.ts, text).then(() => undefined);
  }

  /** One polite line per person per cooldown, so a stranger cannot make the bot spam. */
  private refuse(message: Incoming) {
    const last = this.refusedAt.get(message.user) ?? 0;
    if (this.now() - last < refusalCooldownMs) return;
    this.refusedAt.set(message.user, this.now());
    if (this.refusedAt.size > 1000) this.refusedAt.delete(this.refusedAt.keys().next().value!);
    return this.say(message, slackText[message.lang].refused);
  }

  private async pair(message: Incoming, supplied: string, paired: boolean) {
    const text = slackText[message.lang];
    const current = this.pairing && this.pairing.expiresAt > this.now() ? this.pairing : undefined;
    const given = Buffer.from(supplied.toUpperCase());
    const expected = Buffer.from(current?.code ?? '');
    const matches = given.length === expected.length && timingSafeEqual(given, expected);
    if (!message.dm) {
      // A correct code posted where others can read it is void.
      if (matches) this.pairing = undefined;
      if (matches) return this.say(message, text.pairOnlyInDm);
      return paired ? this.say(message, text.alreadyPaired) : this.refuse(message);
    }
    if (paired) return this.say(message, text.alreadyPaired);
    if (!current) return this.say(message, text.pairExpired);
    if (!matches) {
      if (--current.attemptsLeft <= 0) this.pairing = undefined;
      return this.say(message, text.pairWrong);
    }
    this.pairing = undefined;
    const name = await this.directory.name(message.user);
    await this.options.store.update((config) => {
      if (current.isOwner) for (const user of config.users) user.isOwner = false;
      if (!config.users.some((user) => user.id === message.user))
        config.users.push({
          id: message.user,
          ...(name !== message.user ? { name } : {}),
          pairedAt: new Date(this.now()).toISOString(),
          ...(current.isOwner ? { isOwner: true } : {}),
        });
    });
    this.log('[slack] paired a Slack user');
    return this.say(message, text.pairDone);
  }

  /** Messages in one thread run one after another, so a follow-up continues the same conversation. */
  private queue(message: Incoming) {
    if (message.eventKey) {
      if (this.queuedEvents.has(message.eventKey)) return;
      this.queuedEvents.add(message.eventKey);
    }
    const key = `${message.channel}:${message.threadTs ?? message.ts}${this.options.events ? `:${message.user}` : ''}`;
    let thread = this.threads.get(key);
    if (!thread) {
      thread = { tail: Promise.resolve(), busy: 0 };
      this.threads.set(key, thread);
      if (this.threads.size > 500)
        for (const [old, value] of this.threads)
          if (!value.busy && old !== key) {
            this.threads.delete(old);
            break;
          }
    }
    const session = this.session?.signal;
    this.active.set(message.user, (this.active.get(message.user) ?? 0) + 1);
    thread.busy++;
    const current = thread;
    current.tail = current.tail
      .then(() => (session && !session.aborted ? this.execute(message, key, current, session) : undefined))
      .catch((error) => this.log(`[slack] task failed: ${error instanceof SlackApiError ? error.code : 'error'}`))
      .finally(() => {
        if (message.eventKey) this.queuedEvents.delete(message.eventKey);
        current.busy--;
        const left = (this.active.get(message.user) ?? 1) - 1;
        if (left > 0) this.active.set(message.user, left);
        else this.active.delete(message.user);
      });
  }

  private async execute(message: Incoming, key: string, thread: Thread, session: AbortSignal) {
    const threadTs = message.threadTs ?? message.ts;
    const text = slackText[message.lang];
    if (message.eventKey && this.options.events) {
      this.options.events.receipt(message.eventKey, 'working', '处理中…');
      await this.flushReceipt(message.eventKey);
      await this.answer(message, key, thread, session);
      return;
    }
    const ackTs = await this.post(message.channel, threadTs, text.working);
    const ack: PendingAck | undefined = ackTs ? { channel: message.channel, ts: ackTs, lang: message.lang } : undefined;
    if (ack && session.aborted) return void (await this.stopNotices([ack]));
    if (ack) this.pendingAcks.add(ack);
    try {
      await this.answer(message, key, thread, session, ack);
    } finally {
      if (ack) this.pendingAcks.delete(ack);
    }
  }

  private async answer(message: Incoming, key: string, thread: Thread, session: AbortSignal, ack?: PendingAck) {
    const threadTs = message.threadTs ?? message.ts;
    const text = slackText[message.lang];
    let answer: string;
    try {
      const tasks = this.tasks;
      if (!tasks) throw new Notice(text.notReady);
      if (!thread.conversationId) {
        // After a restart, a follow-up still continues the conversation this thread already has.
        const saved = await this.threadStore.get(key).catch(() => undefined);
        if (saved) Object.assign(thread, { conversationId: saved.conversationId, lastTs: saved.lastTs });
      }
      const requester = await this.directory.name(message.user);
      let context: Awaited<ReturnType<typeof readSlackContext>>;
      try {
        context = await readSlackContext(
          (method, args) => this.botCall(method, args),
          this.directory,
          {
            requester: message.user,
            channel: message.channel,
            kind: message.threadTs ? 'thread' : message.dm ? 'dm' : 'channel',
            ...(message.threadTs ? { threadTs: message.threadTs } : {}),
            currentTs: message.ts,
            ...(thread.conversationId && thread.lastTs ? { after: thread.lastTs } : {}),
            ...(message.dm && this.assistantViews.has(`${message.channel}:${threadTs}`)
              ? { viewingChannel: this.assistantViews.get(`${message.channel}:${threadTs}`)! }
              : {}),
          },
          {
            botUserId: this.identity?.botUserId,
            botName: this.identity?.botName,
            now: this.now(),
            maxChars: this.options.contextChars ?? 12_000,
          },
        );
      } catch (error) {
        const code = error instanceof SlackApiError ? error.code : 'error';
        if (code === 'missing_scope') throw new Notice(text.missingScope);
        if (['not_in_channel', 'channel_not_found', 'access_denied'].includes(code)) throw new Notice(text.inviteBot);
        throw error;
      }
      if (session.aborted) return;
      const record = message.eventKey ? this.options.events?.get(message.eventKey) : undefined;
      if (record) {
        record.quotedContext = context.text;
        record.dispatching = true;
        this.options.events!.save(record);
      }
      const config = await this.options.store.read();
      const owner =
        record?.level === 'L1' && config.users.some((u) => u.id === message.user && u.isOwner) && !context.fromOthers;
      const continued = !!thread.conversationId;
      const { taskId, conversationId } = await tasks.dispatch({
        task: slackPrompt({ requester, request: message.text, context: context.text, continued }),
        caller: `slack:${message.user}`,
        title: message.text.slice(0, 80),
        readOnly: !owner,
        ...(owner ? { owner: true } : {}),
        // PugPort keeps a conversation tool-less once this was set, so later follow-ups stay that way too.
        ...(context.fromOthers ? { untrusted: true } : {}),
        ...(thread.conversationId ? { conversationId: thread.conversationId } : {}),
      });
      if (record) {
        const latest = this.options.events!.get(record.id)!;
        latest.workflowId = taskId;
        latest.conversationId = conversationId;
        latest.dispatching = false;
        this.options.events!.save(latest);
        this.notice(latest);
      }
      thread.conversationId = conversationId;
      thread.lastTs = message.ts;
      void this.threadStore
        .set(key, { conversationId, lastTs: message.ts })
        .catch(() => this.log('[slack] could not save the thread map'));
      answer = await this.wait(tasks, taskId, session, message.lang, !!message.eventKey);
    } catch (error) {
      answer =
        error instanceof Notice
          ? message.eventKey
            ? text.failed(error.message)
            : error.message
          : text.failed(error instanceof SlackApiError ? text.slackError(error.code) : text.notStarted);
    }
    if (session.aborted) return;
    // From here the note becomes the answer; stopping must not overwrite it.
    if (ack) this.pendingAcks.delete(ack);
    if (message.eventKey && this.options.events) {
      this.finishEvent(message.eventKey, answer);
      await this.flushReceipt(message.eventKey);
    } else await this.deliver(message.channel, threadTs, ack?.ts, answer);
  }

  private async wait(
    tasks: SlackTaskRunner,
    taskId: string,
    session: AbortSignal,
    lang: SlackLanguage,
    durable = false,
  ): Promise<string> {
    const text = slackText[lang];
    const deadline = this.now() + (this.options.taskTimeoutMs ?? 60 * 60 * 1000);
    while (!session.aborted) {
      const started = this.now();
      const outcome = await tasks.result(taskId, this.options.resultWaitSeconds ?? 25);
      if (outcome.code === 'no-safe-executor') {
        if (durable) throw new Notice(text.noSafeExecutor);
        return text.noSafeExecutor;
      }
      const status = String(outcome.status ?? '').toLowerCase();
      if (!pendingStatuses.has(status)) {
        if (durable && ['failed', 'blocked', 'cancelled', 'interrupted', 'error'].includes(status))
          throw new Notice(outcome.error?.split('\n')[0]?.slice(0, 500) || text.status(status));
        const result = outcome.result?.trim();
        if (result) return result;
        return text.failed(outcome.error?.trim().slice(0, 500) || text.status(status || 'unknown'));
      }
      if (this.now() > deadline) throw new Notice(text.timedOut);
      // A result call that does not wait must not become a busy loop.
      if (this.now() - started < 1000) await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return '';
  }

  private async deliver(channel: string, threadTs: string, ack: string | undefined, answer: string) {
    const [first = '', ...rest] = splitForSlack(answer);
    let updated = false;
    if (ack)
      updated = await this.botCall('chat.update', { channel, ts: ack, text: escapeSlack(first) })
        .then(() => true)
        .catch(() => false);
    if (!updated) await this.post(channel, threadTs, first);
    for (const chunk of rest) await this.post(channel, threadTs, chunk);
  }

  rules() {
    if (!this.options.events) throw new Error('来源授权服务尚未就绪');
    return new AdmissionRules(this.options.events.store);
  }
  async setOwner(id: string, isOwner: boolean) {
    if (!validSlackUserId(id)) throw new Error('Slack 用户标识无效。');
    await this.options.store.update((c) => {
      const user = c.users.find((u) => u.id === id);
      if (!user) throw new Error('用户尚未配对');
      if (isOwner) for (const other of c.users) other.isOwner = false;
      user.isOwner = isOwner;
    });
    return this.view();
  }
  private notice(e: ExternalEvent) {
    if (e.verdict !== 'ask-owner') return;
    const externalRequest = {
      eventId: e.id,
      source: 'slack' as const,
      senderName: e.senderName,
      scopeLabel: e.scopeLabel ?? e.channel,
      permalink: e.permalink,
      status:
        e.decision === 'reject' ? ('rejected' as const) : e.decision ? ('approved' as const) : ('pending' as const),
      workflowId: e.workflowId,
      receiptState: e.receipt?.state,
      suggestAlways: this.options.events!.streak(e) >= 2,
    };
    const inbox = this.options.inbox;
    if (inbox?.list({ all: true }).some((n) => n.kind === 'external-request' && n.key === e.id))
      inbox.update('external-request', e.id, {
        externalRequest,
        body: e.text,
        severity: e.decision ? 'info' : 'action',
      });
    else
      inbox?.raise({
        kind: 'external-request',
        key: e.id,
        severity: e.decision ? 'info' : 'action',
        title: e.senderName + ' 在 ' + (e.scopeLabel ?? e.channel) + ' 请求',
        body: e.text,
        bodyVerbatim: true,
        externalRequest,
      });
  }
  private async admitMessage(message: Incoming, user?: { name?: string; isOwner?: boolean }) {
    const events = this.options.events!;
    const recent = (this.recent.get(message.user) ?? []).filter((at) => at > this.now() - 3600000);
    const input = {
      source: 'slack' as const,
      scope: message.dm ? ('dm' as const) : ('channel-mention' as const),
      senderId: message.user,
      senderClass: user?.isOwner ? ('owner' as const) : user ? ('trusted' as const) : ('other' as const),
      rateLimited:
        (this.active.get(message.user) ?? 0) >= (this.options.maxActivePerUser ?? 3) ||
        recent.length >= (this.options.maxTasksPerHour ?? 30),
    };
    const { event: e, fresh } = events.record({
      ...input,
      ...admit(input, this.rules().read()),
      eventId: message.channel + ':' + message.ts,
      senderName: user?.name ?? message.user,
      channel: message.channel,
      ts: message.ts,
      threadTs: message.threadTs,
      text: message.text,
    });
    if (!fresh) return;
    message.eventKey = e.id;
    if (e.verdict === 'ignore') return;
    if (e.verdict === 'digest') {
      events.receipt(e.id, 'noted', '');
      await this.flushReceipt(e.id);
      return;
    }
    events.receipt(e.id, 'received', e.verdict === 'ask-owner' ? '收到，等主人确认' : '收到，马上处理');
    this.notice(e);
    if (e.verdict === 'ask-owner') {
      await this.flushReceipt(e.id);
      const [name, channel, link] = await Promise.allSettled([
        this.directory.name(e.senderId),
        this.botCall('conversations.info', { channel: e.channel }),
        this.botCall('chat.getPermalink', { channel: e.channel, message_ts: e.ts }),
      ]);
      const latest = events.get(e.id)!;
      if (name.status === 'fulfilled') latest.senderName = name.value;
      if (channel.status === 'fulfilled' && typeof channel.value.channel?.name === 'string')
        latest.scopeLabel = '#' + channel.value.channel.name;
      if (
        link.status === 'fulfilled' &&
        typeof link.value.permalink === 'string' &&
        /^https:\/\/[^/]+\.slack\.com\//.test(link.value.permalink)
      )
        latest.permalink = link.value.permalink;
      events.save(latest);
      this.notice(latest);
      return;
    }
    this.admittingEvents.add(e.id);
    this.active.set(message.user, (this.active.get(message.user) ?? 0) + 1);
    recent.push(this.now());
    this.recent.set(message.user, recent);
    try {
      await this.flushReceipt(e.id);
      const preference = await textPreference(
        e.level,
        this.options.classify ? () => this.options.classify!(message.text) : undefined,
      );
      if (preference === 'reply') {
        this.finishEvent(e.id, '你好，我在。');
        await this.flushReceipt(e.id);
        return;
      }
    } finally {
      this.admittingEvents.delete(e.id);
      const left = (this.active.get(message.user) ?? 1) - 1;
      if (left) this.active.set(message.user, left);
      else this.active.delete(message.user);
    }
    this.queue(message);
  }
  async resolveRequest(id: string, decision: 'approve' | 'reject' | 'always') {
    const events = this.options.events;
    const e = events?.get(id);
    if (!e || e.source !== 'slack' || e.verdict !== 'ask-owner') throw new Error('请求不存在');
    if (e.decision) return e;
    // Save the decision synchronously before any network await; repeated clicks cannot dispatch twice.
    e.decision = decision;
    e.decisionOrder = events!.list().reduce((order, item) => Math.max(order, item.decisionOrder ?? 0), 0) + 1;
    events!.save(e);
    if (decision === 'always') this.rules().trust(e.scope, e.senderId);
    this.notice(e);
    if (decision === 'reject') {
      events!.receipt(id, 'rejected', '主人这次没有接这个请求');
      await this.flushReceipt(id);
    } else {
      const recent = (this.recent.get(e.senderId) ?? []).filter((at) => at > this.now() - 3600000);
      if (
        (this.active.get(e.senderId) ?? 0) >= (this.options.maxActivePerUser ?? 3) ||
        recent.length >= (this.options.maxTasksPerHour ?? 30)
      ) {
        e.level = 'L4';
        e.reason = '太频繁';
        events!.save(e);
        const noted = events!.receipt(id, 'noted', '');
        this.notice(noted);
        noted.verdict = 'digest';
        events!.save(noted);
        await this.flushReceipt(id);
        return noted;
      }
      recent.push(this.now());
      this.recent.set(e.senderId, recent);
      this.queue({
        eventKey: id,
        user: e.senderId,
        channel: e.channel,
        ts: e.ts,
        threadTs: e.threadTs,
        text: e.text,
        dm: e.scope === 'dm',
        lang: slackLanguage(e.text),
      });
    }
    return events!.get(id);
  }
  private finishEvent(id: string, answer: string) {
    const events = this.options.events!;
    const e = events.get(id)!;
    const updated = events.receipt(
      id,
      answer.startsWith('没做成：') || answer.startsWith('Not done:') ? 'failed' : 'done',
      answer,
    );
    this.notice(updated);
    if (e.level === 'L2')
      this.options.inbox?.raise({
        kind: 'external-request',
        key: id,
        severity: 'info',
        title: 'Slack · ' + e.text.slice(0, 80),
        body: answer.startsWith('没做成：') || answer.startsWith('Not done:') ? '未完成' : '已完成',
        externalRequest: {
          eventId: id,
          source: 'slack',
          senderName: e.senderName,
          scopeLabel: e.channel,
          status: 'approved',
          workflowId: e.workflowId,
          receiptState: updated.receipt?.state,
          suggestAlways: false,
        },
      });
  }
  private async recoverEvents() {
    if (this.status !== 'connected' || this.closed || this.standby || this.recovering) return;
    this.recovering = true;
    try {
      for (const e of this.options.events?.list() ?? []) {
        if (e.source !== 'slack') continue;
        if (e.workflowId && e.receipt?.state === 'working' && this.tasks && !this.queuedEvents.has(e.id)) {
          const outcome = await this.tasks.result(e.workflowId, 0).catch(() => undefined);
          if (outcome && !pendingStatuses.has(outcome.status))
            this.finishEvent(
              e.id,
              ['failed', 'blocked', 'cancelled', 'interrupted', 'error'].includes(outcome.status)
                ? '没做成：' + (outcome.error ?? outcome.status).split('\n')[0]
                : outcome.result || '没做成：' + (outcome.error ?? outcome.status),
            );
        }
        if (
          !e.workflowId &&
          !this.queuedEvents.has(e.id) &&
          !this.admittingEvents.has(e.id) &&
          (e.verdict === 'do-now' || e.decision === 'approve' || e.decision === 'always') &&
          (e.receipt?.state === 'received' || e.receipt?.state === 'working')
        ) {
          if (e.dispatching) this.finishEvent(e.id, '没做成：任务启动结果未确认，请在 PugPort 查看');
          else
            this.queue({
              eventKey: e.id,
              user: e.senderId,
              channel: e.channel,
              ts: e.ts,
              threadTs: e.threadTs,
              text: e.text,
              dm: e.scope === 'dm',
              lang: slackLanguage(e.text),
            });
        }
        await this.flushReceipt(e.id);
      }
    } finally {
      this.recovering = false;
    }
  }
  private async flushReceipt(id: string) {
    const events = this.options.events;
    let e = events?.get(id);
    const r = e?.receipt;
    if (
      !events ||
      !e ||
      !r ||
      r.delivered === r.state + ':' + r.text ||
      r.nextAttempt > this.now() ||
      this.receiptsBusy.has(id)
    )
      return;
    this.receiptsBusy.add(id);
    const signature = r.state + ':' + r.text;
    try {
      r.attempts++;
      events.save(e);
      if (r.state === 'noted') {
        try {
          await this.botCall('reactions.add', { channel: e.channel, timestamp: e.ts, name: 'eyes' });
        } catch (error) {
          if (!(error instanceof SlackApiError) || error.code !== 'already_reacted') throw error;
        }
      } else {
        const chunks = splitForSlack(r.text);
        for (let i = 0; i < chunks.length; i++) {
          if (r.messages[i])
            await this.botCall('chat.update', { channel: e.channel, ts: r.messages[i], text: escapeSlack(chunks[i]!) });
          else {
            const hex = id.slice(0, 30) + i.toString(16).padStart(2, '0');
            const clientId =
              hex.slice(0, 8) +
              '-' +
              hex.slice(8, 12) +
              '-' +
              hex.slice(12, 16) +
              '-' +
              hex.slice(16, 20) +
              '-' +
              hex.slice(20, 32);
            // Reconcile an ambiguous post before retrying, including a restart between Slack accepting and saving its ts.
            if (r.attempts > 1) {
              let cursor: string | undefined;
              let prior: { ts?: string } | undefined;
              do {
                const found = await this.botCall('conversations.replies', {
                  channel: e.channel,
                  ts: e.threadTs ?? e.ts,
                  limit: 100,
                  cursor,
                });
                prior = found.messages?.find((m: any) => m.client_msg_id === clientId);
                cursor = found.response_metadata?.next_cursor || undefined;
              } while (!prior && cursor);
              if (prior?.ts) {
                r.messages[i] = prior.ts;
                await this.botCall('chat.update', { channel: e.channel, ts: prior.ts, text: escapeSlack(chunks[i]!) });
              }
            }
            if (!r.messages[i]) {
              const sent = await this.botCall('chat.postMessage', {
                channel: e.channel,
                thread_ts: e.threadTs ?? e.ts,
                text: escapeSlack(chunks[i]!),
                client_msg_id: clientId,
              });
              if (typeof sent.ts !== 'string') throw new Error('missing receipt timestamp');
              r.messages[i] = sent.ts;
            }
            const latest = events.get(id)!;
            latest.receipt!.messages = r.messages;
            events.save(latest);
          }
        }
      }
      // Preserve a newer desired state if it changed while a request was in flight.
      const latest = events.get(id)!;
      latest.receipt!.messages = r.messages;
      latest.receipt!.delivered = signature;
      latest.receipt!.attempts = r.attempts;
      events.save(latest);
    } catch {
      const latest = events.get(id)!;
      latest.receipt!.messages = r.messages;
      latest.receipt!.attempts = r.attempts;
      latest.receipt!.nextAttempt = this.now() + Math.min(60000, 1000 * 2 ** Math.min(r.attempts, 6));
      latest.receipt!.history.push({
        state: r.state,
        at: new Date(this.now()).toISOString(),
        error: 'delivery failed',
      });
      events.save(latest);
    } finally {
      this.receiptsBusy.delete(id);
    }
  }

  /** Digest deliveries use the same bot transport, chunking and persisted receipt recovery as request replies. */
  async deliverDigest(id: string, text: string): Promise<boolean> {
    const events = this.options.events;
    const config = await this.options.store.read();
    if (!events || !config.enabled || this.status !== 'connected' || this.closed || this.standby) return false;
    const owner = config.users.find((u) => u.isOwner);
    if (!owner) return false;
    type Delivery = {
      owner: string;
      channel?: string;
      messages: string[];
      attempts: number;
      started: string;
      done?: boolean;
    };
    const key = 'digest:' + id;
    const r = events.store.get<Delivery>('slack-digest-receipt', key) ?? {
      owner: owner.id,
      messages: [],
      attempts: 0,
      started: String(this.now() / 1000),
    };
    // A pending delivery is bound to its original owner; changing pairing must not redirect private data.
    if (!config.users.some((u) => u.id === r.owner && u.isOwner)) return false;
    if (r.done) return true;
    const save = () => events.store.save('slack-digest-receipt', key, key, r);
    r.attempts++;
    save();
    if (!r.channel) {
      const opened = await this.botCall('conversations.open', { users: r.owner });
      if (typeof opened.channel?.id !== 'string') throw Error('missing digest DM channel');
      r.channel = opened.channel.id;
      save();
    }
    const chunks = splitForSlack(text);
    for (let i = 0; i < chunks.length; i++) {
      const hex = createHash('sha256')
        .update(key + ':' + i)
        .digest('hex')
        .slice(0, 32);
      const clientId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      if (!r.messages[i] && r.attempts > 1) {
        let cursor: string | undefined;
        do {
          const found = await this.botCall('conversations.history', {
            channel: r.channel,
            oldest: r.started,
            limit: 100,
            cursor,
          });
          const prior = found.messages?.find((m: any) => m.client_msg_id === clientId);
          if (typeof prior?.ts === 'string') {
            r.messages[i] = prior.ts;
            save();
            break;
          }
          cursor = found.response_metadata?.next_cursor || undefined;
        } while (cursor);
      }
      if (r.messages[i])
        await this.botCall('chat.update', { channel: r.channel, ts: r.messages[i], text: escapeSlack(chunks[i]!) });
      else {
        const sent = await this.botCall('chat.postMessage', {
          channel: r.channel,
          text: escapeSlack(chunks[i]!),
          client_msg_id: clientId,
        });
        if (typeof sent.ts !== 'string') throw Error('missing digest receipt timestamp');
        r.messages[i] = sent.ts;
        save();
      }
    }
    r.done = true;
    save();
    return true;
  }

  private async post(channel: string, threadTs: string, text: string): Promise<string | undefined> {
    try {
      const sent = await this.botCall('chat.postMessage', { channel, thread_ts: threadTs, text: escapeSlack(text) });
      return typeof sent.ts === 'string' ? sent.ts : undefined;
    } catch (error) {
      this.log(`[slack] could not post a reply: ${error instanceof SlackApiError ? error.code : 'error'}`);
      return undefined;
    }
  }
}
