import { executorImage } from '../attachment-image.ts';
import { deferredBridgeToolNames } from '../../shared/bridge-catalog.ts';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { APP_NAME, APP_VERSION } from '../../shared/identity.ts';
import { cursorModelPool } from '../../shared/cursor-models.ts';
import { parseCursorModel } from '../../shared/model-family.ts';
import type {
  Adapter,
  DiscoveryOptions,
  ExecuteContext,
  ExecuteResult,
  EffectiveModelSelection,
  ModelInfo,
  RuntimeSnapshot,
  RuntimeTarget,
  StartupFailure,
} from '../../shared/types.ts';
import { subscriptionPlan } from '../subscription-plan.ts';
import { safeToolEventText, toolEventDetails } from '../../shared/tool-event-data.ts';
import {
  applyCursorEditorUsage,
  cursorIdentityHash,
  readCursorCliSession,
  type CursorUsageIdentity,
} from '../cursor-usage.ts';
import { recentCursorIdentity } from '../../shared/runtime-health.ts';
import { nativeAccountCursorLogin, nativeAccountEnvironment } from '../native-accounts.ts';
import {
  StartupTail,
  captureTarget,
  redactError,
  runtimeError,
  spawnTarget,
  targetPath,
  terminateProcess,
} from './process.ts';
import { auditNativeProcess, auditUnmappedSessionUpdate } from './execution-audit.ts';
import { hostBridgeToolNames } from './host-bridge.ts';
import { discoverNativeInHelper } from '../native-discovery-client.ts';

type Row = Record<string, unknown>;
const object = (value: unknown): Row =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : {};
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const now = () => new Date().toISOString();

/** ACP updates may enrich only arguments/results; retain only previously observed identity/state. */
export function cursorToolEventData(update: Row, previous: Row = {}): Row {
  const native = object(object(update._meta)['x.ai/tool']);
  const tool = text(update.toolName) || text(object(update.rawInput).tool_name) || text(native.name);
  const result: Row = { toolCallId: safeToolEventText(text(update.toolCallId), 512) };
  for (const field of ['kind', 'status', 'title', 'tool']) {
    const current = field === 'tool' ? tool : text(update[field]);
    const value = current || text(previous[field]);
    if (value) result[field] = safeToolEventText(value, field === 'title' ? 4096 : 256);
  }
  return { ...result, ...toolEventDetails(update) };
}
const abortError = () => Object.assign(new Error('operation-cancelled'), { name: 'AbortError' });
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const safeModel = (id: string) => /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(id);
type Dependencies = {
  spawn: typeof spawnTarget;
  capture: typeof captureTarget;
  terminate: typeof terminateProcess;
  targetPath: typeof targetPath;
  usage: typeof applyCursorEditorUsage;
  bridgeTools: typeof hostBridgeToolNames;
  requestTimeoutMs?: number;
  now?: () => number;
};
const defaults: Dependencies = {
  spawn: spawnTarget,
  capture: captureTarget,
  terminate: terminateProcess,
  targetPath,
  usage: applyCursorEditorUsage,
  bridgeTools: hostBridgeToolNames,
};

/**
 * This adapter uses a member login: the existing one, or a second account PugPort created (process.ts moves that
 * one into its own folder). Never an API-key override, and never a half-configured account.
 */
function memberEnvironment(target: RuntimeTarget): NodeJS.ProcessEnv {
  if (
    target.provider !== 'cursor' ||
    target.environment !== 'native' ||
    !!target.accountId !== !!target.accountHome ||
    target.gateway ||
    (target.args ?? []).some((arg) => /^--?(?:api[-_]?key|auth[-_]?token|access[-_]?token|force)(?:=|$)/i.test(arg))
  )
    throw new Error('native-session-identity-unverified');
  if (target.accountId)
    try {
      nativeAccountEnvironment(target);
    } catch {
      throw new Error('native-session-identity-unverified');
    }
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^CURSOR_(?:API_KEY|AUTH_TOKEN)$/i.test(key)) delete env[key];
  return env;
}

const userId = (value: unknown): string =>
  typeof value === 'number' ? (Number.isSafeInteger(value) && value >= 0 ? String(value) : '') : text(value).trim();

function clean(value: string): string {
  return value
    .replace(/\b(?:sk|pk|xai)-[\w-]+/g, '[redacted]')
    .replace(/(bearer\s+)[\w.+/=-]+/gi, '$1[redacted]')
    .replace(/((?:api[_-]?key|token|password|secret)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]')
    .slice(0, 12_000);
}

/** Authentication metadata only; never read Cursor's credential files or expose account identifiers. */
export function cursorAccountFingerprint(payload: unknown): string | undefined {
  const status = object(payload),
    user = object(status.userInfo);
  if (!authenticated(status)) return;
  const id = userId(user.userId) || userId(status.userId);
  const email = text(user.email).trim().toLowerCase();
  const identity = id ? ['cursor', 'user_id', id] : email.includes('@') ? ['cursor', 'email', email] : undefined;
  return identity ? createHash('sha256').update(JSON.stringify(identity)).digest('hex') : undefined;
}

export function cursorModels(payload: unknown): ModelInfo[] {
  const result: ModelInfo[] = [];
  const add = (id: string, label: string) => {
    if (!safeModel(id) || result.some((row) => row.id === id)) return;
    // Cursor's CLI model slugs already encode effort and speed. Keep them exact;
    // advertising an independent effort control would silently select the wrong variant.
    result.push({
      id,
      label: clean(label.trim() || id),
      efforts: [],
      lightweight: /luna|mini|nano|flash/i.test(id),
      quotaPool: cursorModelPool(id),
    });
  };
  if (typeof payload === 'string') {
    for (const line of payload.replace(/\u001b\[[0-9;]*m/g, '').split(/\r?\n/)) {
      const match = /^\s*([a-zA-Z0-9][a-zA-Z0-9._-]*)\s+-\s+(.+?)\s*$/.exec(line);
      if (match) add(match[1]!, match[2]!.replace(/\s*\(default\)\s*$/, '').replace(/[\u200b-\u200d\ufeff]/g, ''));
    }
  } else {
    const rows = Array.isArray(payload) ? payload : object(payload).models;
    for (const raw of Array.isArray(rows) ? rows : []) {
      const row = object(raw);
      add(text(row.id) || text(row.modelId), text(row.name) || text(row.displayName));
    }
  }
  return result;
}

const normalizeEffort = (value: string) => (value === 'extra-high' ? 'xhigh' : value);
const configOptions = (value: unknown): Row[] => (Array.isArray(value) ? value.map(object) : []);
function optionValues(option: Row): string[] {
  return configOptions(option.options).flatMap((item) =>
    Array.isArray(item.options) ? optionValues(item) : typeof item.value === 'string' ? [item.value] : [],
  );
}
function effortOption(options: Row[]): Row | undefined {
  return options.find(
    (option) =>
      (option.category === 'thought_level' ||
        /^(reasoning|reasoning_effort|effort|thought_level)$/.test(text(option.id))) &&
      optionValues(option).some((value) => /^(none|minimal|low|medium|high|xhigh|extra-high|max|ultra)$/.test(value)),
  );
}

/** Official ACP metadata exposes model families and their supported settings, without creating a session. */
export function cursorParameterizedModels(payload: unknown): ModelInfo[] {
  const models: ModelInfo[] = [];
  for (const row of configOptions(object(payload).models)) {
    const id = text(row.value);
    if (!safeModel(id) || models.some((model) => model.id === id)) continue;
    const thought = effortOption(configOptions(row.configOptions));
    const efforts = thought ? [...new Set(optionValues(thought).map(normalizeEffort))] : [];
    const current = normalizeEffort(text(thought?.currentValue));
    models.push({
      id,
      label: clean(text(row.name) || id),
      efforts,
      ...(efforts.includes(current) ? { defaultEffort: current } : {}),
      lightweight: /luna|mini|nano|flash/i.test(id),
      quotaPool: cursorModelPool(id),
    });
  }
  return models;
}

async function parameterizedCatalog(rpc: CursorRpc): Promise<ModelInfo[] | undefined> {
  try {
    const result = await rpc.request('cursor/list_available_models', {});
    if (!Array.isArray(result.models)) throw new Error('runtime-protocol-incompatible');
    return cursorParameterizedModels(result);
  } catch (error) {
    // Only an explicit unsupported method selects the old slug protocol. Other failures must remain visible.
    if (object(error).code === -32601) return undefined;
    throw error;
  }
}

/** ACP prompt usage is turn consumption. usage_update.used is context occupancy, never billed tokens or quota. */
export function cursorResultUsage(payload: unknown): Row | undefined {
  const usage = object(object(payload).usage),
    data: Row = {};
  for (const [source, destination] of [
    ['inputTokens', 'inputTokens'],
    ['outputTokens', 'outputTokens'],
    ['totalTokens', 'totalTokens'],
    ['cachedReadTokens', 'cacheReadTokens'],
    ['cachedWriteTokens', 'cacheWriteTokens'],
    ['thoughtTokens', 'reasoningOutputTokens'],
  ] as const)
    if (finite(usage[source])) data[destination] = usage[source];
  return Object.keys(data).length
    ? {
        ...data,
        source: 'Cursor ACP session/prompt usage',
        scope: 'run-cumulative',
        cumulative: true,
        eventId: 'cursor-prompt-usage',
        note: '原生协议报告的本轮消耗，不代表套餐或活动剩余额度。',
      }
    : undefined;
}

const quota = (): RuntimeSnapshot['quota'] => ({
  status: 'unknown',
  source: 'Cursor account dashboard',
  observedAt: null,
  windows: [],
  note: 'Cursor 没有公开的余额查询；在“用量与连接”的 Cursor 一项里开启“自动读取用量和赠送额度”后，这里会自动显示。',
});

function cursorFailure(payload: unknown): string {
  const error = object(payload);
  if (error.code === -32601 || error.code === -32602) return 'runtime-protocol-incompatible';
  // -32000 is a generic server error, including quota/network failures; its message determines the safe category.
  return redactError(text(error.message) || 'runtime-request-failed');
}

/** ACP v1 uses newline framing; only sanitized structured error messages are retained. */
class CursorRpc {
  private sequence = 0;
  private ended = false;
  private terminalError?: Error;
  private buffer = '';
  private decoder = new StringDecoder('utf8');
  private pending = new Map<
    number,
    { resolve(value: Row): void; reject(error: Error): void; timer?: NodeJS.Timeout }
  >();
  readonly failure: Promise<never>;
  private rejectFailure!: (error: Error) => void;
  onNotification?: (method: string, params: Row) => void;
  onRequest?: (method: string, params: Row) => Promise<unknown>;
  readonly startup = new StartupTail();
  private invalidStartupLine = false;
  constructor(
    readonly child: ChildProcessWithoutNullStreams,
    private readonly terminate: typeof terminateProcess,
    private readonly requestTimeoutMs = 20_000,
    private readonly errorOptions: Parameters<typeof runtimeError>[1] = {},
  ) {
    this.failure = new Promise<never>((_, reject) => {
      this.rejectFailure = reject;
    });
    void this.failure.catch(() => {});
    child.stdout.on('data', (chunk: Buffer) => {
      this.startup.write('stdout', chunk);
      this.buffer += this.decoder.write(chunk);
      if (this.buffer.length > 16 * 1024 * 1024) {
        this.fail(new Error('runtime-protocol-incompatible'));
        return;
      }
      let index: number;
      while ((index = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, index).trim();
        this.buffer = this.buffer.slice(index + 1);
        if (line) this.receive(line);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => this.startup.write('stderr', chunk));
    child.on('error', (error) => this.fail(new Error(redactError(error))));
    child.stdin.on('error', () => {
      if (!this.startup.active) this.fail(new Error('runtime-process-closed'));
    });
    child.once('close', (code) =>
      this.fail(
        this.startup.active
          ? this.startup.failure('Cursor', code ?? null, this.errorOptions)
          : new Error('runtime-process-closed'),
      ),
    );
  }
  fail(error: Error): void {
    if (this.ended) return;
    this.ended = true;
    this.terminalError = error;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
    this.rejectFailure(error);
  }
  private receive(line: string): void {
    let message: Row;
    try {
      message = object(JSON.parse(line));
    } catch {
      if (this.startup.active) {
        this.invalidStartupLine = true;
        return;
      }
      this.fail(new Error('runtime-protocol-incompatible'));
      return;
    }
    if (message.jsonrpc !== '2.0') {
      this.fail(new Error('runtime-protocol-incompatible'));
      return;
    }
    const method = text(message.method),
      params = object(message.params);
    if (method) {
      if (typeof message.id === 'number' || typeof message.id === 'string') {
        const id = message.id;
        void Promise.resolve()
          .then(() => {
            if (!this.onRequest) throw new Error('unsupported-server-request');
            return this.onRequest(method, params);
          })
          .then((result) => this.send({ id, result }))
          .catch(() => this.send({ id, error: { code: -32601, message: 'Client does not support this request.' } }));
      } else {
        try {
          this.onNotification?.(method, params);
        } catch {
          this.fail(new Error('runtime-protocol-incompatible'));
        }
      }
      return;
    }
    if (typeof message.id !== 'number') return;
    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error)
      entry.reject(
        Object.assign(
          runtimeError(text(object(message.error).message), {
            ...this.errorOptions,
            provider: 'Cursor',
            code: cursorFailure(message.error),
          }),
          { code: object(message.error).code },
        ),
      );
    else if (!Object.hasOwn(message, 'result')) entry.reject(new Error('runtime-protocol-incompatible'));
    else entry.resolve(object(message.result));
  }
  private send(value: Row): void {
    if (!this.ended && !this.child.stdin.destroyed)
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
  }
  notify(method: string, params: Row): void {
    this.send({ method, params });
  }
  request(method: string, params: Row, timeoutMs = this.requestTimeoutMs): Promise<Row> {
    if (this.ended) return Promise.reject(this.terminalError ?? new Error('runtime-process-closed'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(
                new Error(
                  this.invalidStartupLine && this.startup.active ? 'runtime-protocol-incompatible' : 'runtime-timeout',
                ),
              );
            }, timeoutMs)
          : undefined;
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }
  async initialize(): Promise<Row> {
    const result = await this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
        _meta: { parameterizedModelPicker: true },
      },
      clientInfo: { name: 'pugport', title: APP_NAME, version: APP_VERSION },
    });
    if (result.protocolVersion !== 1) throw new Error('runtime-protocol-incompatible');
    return object(result.agentCapabilities);
  }
  async close(): Promise<void> {
    await this.terminate(this.child);
    this.fail(new Error('runtime-process-closed'));
  }
}

async function status(target: RuntimeTarget, deps: Dependencies): Promise<Row> {
  const result = await deps.capture(target, ['status', '--format', 'json'], {
    env: memberEnvironment(target),
    timeoutMs: 30_000,
    acceptedExitCodes: [0, 1],
  });
  try {
    return object(JSON.parse(result.stdout));
  } catch {
    throw new Error('runtime-protocol-incompatible');
  }
}
/** Fresh official metadata only. Authentication, browser login and credential-file access are never attempted. */
export async function readCursorIdentity(
  target: RuntimeTarget,
  overrides: Partial<Dependencies> = {},
): Promise<string | undefined> {
  try {
    return cursorAccountFingerprint(await status(target, { ...defaults, ...overrides }));
  } catch {
    return undefined;
  }
}
function authenticated(value: Row): boolean {
  if (typeof value.isAuthenticated === 'boolean') return value.isAuthenticated;
  if (typeof value.authenticated === 'boolean') return value.authenticated;
  return value.status === 'authenticated';
}
function assertIdentity(value: Row, ctx: ExecuteContext): void {
  if (!authenticated(value)) throw new Error('authentication-required');
  const fingerprint = cursorAccountFingerprint(value);
  const expected = ctx.route.accountFingerprint ?? ctx.target.accountFingerprint;
  if (!expected || !fingerprint) throw new Error('native-session-identity-unverified');
  if (fingerprint !== expected) throw new Error('native-session-identity-changed');
}

async function discoverMetadata(
  target: RuntimeTarget,
  deps: Dependencies,
  options: DiscoveryOptions = {},
): Promise<{ snapshot: RuntimeSnapshot; usageIdentity: CursorUsageIdentity }> {
  const snapshot: RuntimeSnapshot = {
    id: target.id,
    provider: 'cursor',
    label: target.label,
    environment: target.environment,
    installed: false,
    status: 'missing',
    models: [],
    quota: quota(),
    refreshedAt: now(),
    capabilities: { execute: false, resume: false, cancel: false, approvals: false, steer: false, imageInput: false },
  };
  let rpc: CursorRpc | undefined;
  let initialStatus: Row | undefined;
  let capabilities: Row | undefined;
  let discoveryFailure: string | undefined;
  let aboutEmail = '';
  let usageIdentity: CursorUsageIdentity = { state: 'unverified' };
  const clock = deps.now ?? Date.now;
  let identityMismatch = false;
  let legacyCatalog: Promise<void> | undefined;
  const readLegacyCatalog = () =>
    (legacyCatalog ??= (async () => {
      const catalog = await deps.capture(target, ['models'], { env: memberEnvironment(target), timeoutMs: 30_000 });
      snapshot.installed = true;
      snapshot.models = cursorModels(catalog.stdout);
    })());
  try {
    const env = memberEnvironment(target);
    const results = await Promise.allSettled([
      status(target, deps),
      deps.capture(target, ['about', '--format', 'json'], { env, timeoutMs: 30_000 }),
    ]);
    const [auth, about] = results;
    snapshot.installed = results.some((entry) => entry.status === 'fulfilled');
    if (auth.status !== 'fulfilled') {
      // Even when status times out, contradictory account metadata must invalidate the reference.
      if (about.status === 'fulfilled') {
        try {
          aboutEmail = text(object(JSON.parse(about.value.stdout)).userEmail)
            .trim()
            .toLowerCase();
        } catch {}
      }
      throw auth.reason;
    }
    initialStatus = auth.value;
    snapshot.accountFingerprint = cursorAccountFingerprint(initialStatus);
    snapshot.status = authenticated(initialStatus) ? 'unknown' : 'auth-required';
    if (about.status === 'fulfilled') {
      // Plan metadata is optional. A malformed about response must not discard a valid login.
      let info: Row = {};
      try {
        info = object(JSON.parse(about.value.stdout));
      } catch {}
      const version = text(info.cliVersion);
      if (/^[a-zA-Z0-9._-]{1,100}$/.test(version)) snapshot.version = version;
      snapshot.subscription = subscriptionPlan(info.subscriptionTier, 'Cursor CLI about.subscriptionTier');
      aboutEmail = text(info.userEmail).trim().toLowerCase();
    }
    rpc = new CursorRpc(
      await deps.spawn(target, ['--model', 'auto', '--mode', 'ask', 'acp'], { env }),
      deps.terminate,
      deps.requestTimeoutMs,
      {
        paths: [target.agentDir],
      },
    );
    snapshot.installed = true;
    capabilities = await rpc.initialize();
    const parameterized = snapshot.status === 'auth-required' ? undefined : await parameterizedCatalog(rpc);
    if (parameterized) snapshot.models = parameterized;
    else if (snapshot.status === 'auth-required') await readLegacyCatalog().catch(() => undefined);
    else await readLegacyCatalog();
  } catch (error) {
    // Failed metadata still retains the legacy catalog and installed evidence, as before.
    await readLegacyCatalog().catch(() => undefined);
    discoveryFailure = redactError(error);
    snapshot.status =
      discoveryFailure === 'runtime-not-found' && !snapshot.installed
        ? 'missing'
        : discoveryFailure === 'authentication-required'
          ? 'auth-required'
          : 'error';
    if (snapshot.status === 'missing') usageIdentity = { state: 'missing' };
    snapshot.note = discoveryFailure;
    snapshot.errorDetail = (error as { startup?: StartupFailure }).startup?.firstLine;
  } finally {
    await rpc?.close();
  }
  if (initialStatus) {
    // Identity is checked independently of model discovery and ACP availability. A failed handshake
    // must not look like an account mismatch or hide usage for a separately verified CLI account.
    // Metadata reads can straddle an external login switch, so always compare a fresh status.
    let statusFailure: string | undefined;
    const fresh = await status(target, deps).catch((error) => {
      statusFailure = redactError(error);
      return undefined;
    });
    const freshFingerprint = cursorAccountFingerprint(fresh);
    const freshEmail = text(object(object(fresh).userInfo).email)
      .trim()
      .toLowerCase();
    if (
      !freshFingerprint ||
      freshFingerprint !== snapshot.accountFingerprint ||
      (aboutEmail && aboutEmail !== freshEmail)
    ) {
      identityMismatch = !!fresh || statusFailure !== 'runtime-timeout';
      if (statusFailure === 'authentication-required') discoveryFailure = statusFailure;
      else if (!discoveryFailure && statusFailure === 'runtime-timeout') discoveryFailure = statusFailure;
      snapshot.accountFingerprint = undefined;
      snapshot.subscription = undefined;
      snapshot.quota = quota();
      snapshot.status =
        (fresh && !authenticated(fresh)) || discoveryFailure === 'authentication-required'
          ? 'auth-required'
          : discoveryFailure
            ? 'error'
            : 'unknown';
      snapshot.accounting = {
        mode: 'unknown',
        source: 'Cursor CLI identity consistency check',
        note: '发现期间账号身份无法保持一致；请刷新后重新核对套餐与手动余额。',
      };
      snapshot.note = discoveryFailure ?? snapshot.accounting.note;
    } else {
      if (freshEmail) {
        const id = userId(object(object(fresh).userInfo).userId) || userId(object(fresh).userId);
        usageIdentity = { state: 'verified', email: freshEmail, ...(id ? { userId: id } : {}) };
        const comparableId = id.split('|').at(-1);
        snapshot.cursorVerifiedIdentity = {
          fingerprint: freshFingerprint,
          observedAt: new Date(clock()).toISOString(),
          emailHash: cursorIdentityHash(freshEmail),
          ...(comparableId && !/^\d+$/.test(comparableId) ? { userIdHash: cursorIdentityHash(comparableId) } : {}),
        };
      }
      // Older about output without an email cannot prove the account that supplied its plan.
      if (!aboutEmail) snapshot.subscription = undefined;
      snapshot.accounting = {
        mode: snapshot.subscription ? 'subscription' : 'unknown',
        source: 'Cursor CLI verified status and about',
        note: snapshot.subscription
          ? '前后账号身份与套餐来源一致；余额另由官方 dashboard 确认。'
          : '账号身份已确认，套餐来源缺少可匹配账号信息；余额另由官方 dashboard 确认。',
      };
      const verified = !discoveryFailure && !!capabilities && snapshot.models.length > 0;
      snapshot.capabilities = {
        execute: verified,
        resume: verified && capabilities?.loadSession === true,
        cancel: verified,
        approvals: verified,
        steer: false,
        imageInput: verified && object(capabilities?.promptCapabilities).image === true,
      };
      if (!discoveryFailure) {
        snapshot.status = snapshot.capabilities.execute ? 'ready' : 'unknown';
        snapshot.note = 'Cursor 原生 ACP；支持流输出与权限确认。当前协议未提供同轮 steer 或个人余额查询。';
      }
    }
  }
  const previous = options.cursorVerifiedIdentity;
  if (
    snapshot.note === 'runtime-timeout' &&
    snapshot.status === 'error' &&
    usageIdentity.state === 'unverified' &&
    !identityMismatch &&
    recentCursorIdentity(previous, clock()) &&
    (!aboutEmail || cursorIdentityHash(aboutEmail) === previous!.emailHash) &&
    (!initialStatus || cursorAccountFingerprint(initialStatus) === previous!.fingerprint)
  ) {
    snapshot.cursorVerifiedIdentity = previous;
    snapshot.accountFingerprint = previous!.fingerprint;
    usageIdentity = { state: 'reference', verification: previous! };
  }
  // Authentication failure must revoke verification even if another metadata command succeeded.
  if (snapshot.status === 'auth-required') {
    snapshot.cursorVerifiedIdentity = undefined;
    snapshot.accountFingerprint = undefined;
    usageIdentity = { state: 'unverified' };
  }
  return { snapshot, usageIdentity };
}

/** The helper never reads the editor dashboard; its cache and settings belong to the parent. */
export function discoverCursorMetadata(target: RuntimeTarget, options: DiscoveryOptions = {}) {
  return discoverMetadata(target, defaults, options);
}

function checkedUsageIdentity(
  snapshot: RuntimeSnapshot,
  identity: CursorUsageIdentity | undefined,
  options: DiscoveryOptions,
): CursorUsageIdentity {
  if (identity?.state === 'unverified') return { state: 'unverified' };
  if (identity?.state === 'missing' && snapshot.status === 'missing' && !snapshot.installed)
    return { state: 'missing' };
  const verification = snapshot.cursorVerifiedIdentity;
  if (
    verification &&
    snapshot.status !== 'auth-required' &&
    verification.fingerprint === snapshot.accountFingerprint &&
    recentCursorIdentity(verification, Date.now())
  ) {
    if (
      identity?.state === 'verified' &&
      typeof identity.email === 'string' &&
      identity.email.includes('@') &&
      (identity.userId === undefined || typeof identity.userId === 'string') &&
      cursorIdentityHash(identity.email.trim().toLowerCase()) === verification.emailHash &&
      cursorAccountFingerprint({
        isAuthenticated: true,
        userInfo: { email: identity.email, userId: identity.userId },
      }) === verification.fingerprint &&
      (!verification.userIdHash ||
        (identity.userId && cursorIdentityHash(identity.userId.split('|').at(-1)!) === verification.userIdHash))
    )
      return { state: 'verified', email: identity.email, ...(identity.userId ? { userId: identity.userId } : {}) };
    if (
      identity?.state === 'reference' &&
      snapshot.status === 'error' &&
      snapshot.note === 'runtime-timeout' &&
      JSON.stringify(identity.verification) === JSON.stringify(verification) &&
      JSON.stringify(verification) === JSON.stringify(options.cursorVerifiedIdentity)
    )
      return { state: 'reference', verification };
  }
  throw new Error('runtime-protocol-incompatible');
}

async function discover(
  target: RuntimeTarget,
  deps: Dependencies,
  options: DiscoveryOptions = {},
  helper = false,
): Promise<RuntimeSnapshot> {
  const result = helper
    ? await discoverNativeInHelper(target, { discovery: { cursorVerifiedIdentity: options.cursorVerifiedIdentity } })
    : await discoverMetadata(target, deps, options);
  const { snapshot } = result;
  const usageIdentity = helper ? checkedUsageIdentity(snapshot, result.usageIdentity, options) : result.usageIdentity!;
  const clock = deps.now ?? Date.now;
  // Live usage from the Cursor editor's login, when the user turned it on (works without the CLI too).
  // A second account reads its own login instead: the editor belongs to whoever is signed in there.
  await deps
    .usage(snapshot, usageIdentity, {
      maxCacheAgeMs: options.quotaMaxAgeMs,
      referenceQuota: options.cursorLastKnownQuota,
      now: clock,
      ...(target.accountId
        ? { session: async () => readCursorCliSession(nativeAccountCursorLogin(target)), accountLogin: true }
        : {}),
    })
    .catch(() => undefined);
  if (
    snapshot.note === 'runtime-timeout' &&
    recentCursorIdentity(snapshot.cursorVerifiedIdentity, clock()) &&
    snapshot.quota.status === 'known'
  ) {
    snapshot.lastKnownQuota = { ...snapshot.quota, note: '检查超时，显示上次读数' };
    snapshot.quota = quota();
  }
  snapshot.refreshedAt = now();
  return snapshot;
}

async function approve(ctx: ExecuteContext, tool: string, description: string): Promise<boolean> {
  if (ctx.signal.aborted) return false;
  let onAbort!: () => void;
  const cancelled = new Promise<boolean>((resolve) => {
    onAbort = () => resolve(false);
    ctx.signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([ctx.approve(tool, clean(description)), cancelled]);
  } finally {
    ctx.signal.removeEventListener('abort', onAbort);
  }
}

export function cursorBridgeServers(bridge: NonNullable<ExecuteContext['agentBridge']>): Row[] {
  const url = new URL(bridge.url);
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    !bridge.token ||
    /[\r\n]/.test(bridge.token)
  )
    throw new Error('runtime-protocol-incompatible');
  return [
    {
      type: 'http',
      name: 'pugport',
      url: bridge.url,
      headers: [{ name: 'Authorization', value: `Bearer ${bridge.token}` }],
    },
  ];
}

async function promptContent(ctx: ExecuteContext, capabilities: Row): Promise<Row[]> {
  const prompt: Row[] = [{ type: 'text', text: ctx.input.prompt }];
  const imageBudget = { bytes: 0 };
  for (const image of (ctx.input.attachments ?? []).filter((item) => item.kind === 'image')) {
    if (object(capabilities.promptCapabilities).image !== true) throw new Error('runtime-image-input-unavailable');
    if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(image.mimeType))
      throw new Error('runtime-image-input-invalid');
    const selected = await executorImage(image, 'cursor', ctx, imageBudget).catch(() => {
      throw new Error('runtime-image-input-invalid');
    });
    if (!selected) {
      prompt.push({ type: 'text', text: `${image.name}：图片像素未提供，原件仍保留在 ${image.path}。` });
      continue;
    }
    let bytes: Buffer;
    try {
      const file = await stat(selected.path);
      if (!file.isFile() || file.size > 5 * 1024 * 1024) throw new Error('runtime-image-input-invalid');
      bytes = await readFile(selected.path);
    } catch {
      throw new Error('runtime-image-input-invalid');
    }
    if (!bytes.length || bytes.length > 5 * 1024 * 1024) throw new Error('runtime-image-input-invalid');
    prompt.push({ type: 'image', data: bytes.toString('base64'), mimeType: selected.mimeType });
  }
  return prompt;
}

/** The ACP handshake configures and confirms effort; the launch flag selects only the requested model. */
export function cursorExecutionArgs(ctx: ExecuteContext): string[] {
  requestedSelection(ctx.route.model, ctx.route.effort);
  // Current cursor-agent accepts only plan|ask for --mode and exits on `agent`; agent is its default, and
  // configureSession sets the mode explicitly over ACP either way.
  const readOnly = ctx.input.permissionMode === 'read-only' || ctx.input.prohibitCommands === true;
  return ['--model', ctx.route.model, ...(readOnly ? ['--mode', 'ask'] : []), 'acp'];
}

function requestedSelection(model: string, effort?: string) {
  if (
    !safeModel(model) ||
    (effort !== undefined && !/^(none|minimal|low|medium|high|xhigh|extra-high|max|ultra)$/.test(effort))
  )
    throw new Error('runtime-protocol-incompatible');
  const variant = parseCursorModel(model);
  if (effort && variant.effort && normalizeEffort(effort) !== variant.effort)
    throw new Error('runtime-protocol-incompatible');
  return { ...variant, effort: effort ? normalizeEffort(effort) : variant.effort };
}

function bracketParameters(value: string): Record<string, string> | undefined {
  const match = /^([^\[\]]+)\[([^\[\]]*)\]$/.exec(value);
  if (!match) return;
  const parameters: Record<string, string> = {};
  for (const pair of match[2]!.split(',')) {
    const at = pair.indexOf('=');
    if (at < 1) return;
    const key = pair.slice(0, at).trim();
    const setting = pair.slice(at + 1).trim();
    if (!key || !setting || Object.hasOwn(parameters, key)) return;
    parameters[key] = setting;
  }
  return parameters;
}

function actualSelection(value: string, options: Row[] = []): EffectiveModelSelection {
  const bracket = bracketParameters(value);
  const variant = parseCursorModel(bracket ? value.split('[')[0]! : value);
  const parameters: Record<string, string> = bracket ?? {};
  for (const option of options) {
    if (option.category === 'model' || option.category === 'mode' || ['model', 'mode'].includes(text(option.id)))
      continue;
    if (typeof option.id === 'string' && typeof option.currentValue === 'string')
      parameters[option.id] = option.currentValue;
  }
  if (!bracket && !options.length) {
    parameters.fast = String(variant.fast);
    parameters.thinking = String(variant.thinking);
    if (variant.effort) parameters.effort = variant.effort;
  }
  const thought = effortOption(options);
  const effort = normalizeEffort(
    text(thought?.currentValue) ||
      parameters.effort ||
      parameters.reasoning ||
      parameters.reasoning_effort ||
      variant.effort ||
      '',
  );
  return {
    model: variant.family,
    ...(effort ? { effort } : {}),
    ...(Object.keys(parameters).length ? { parameters } : {}),
    source: 'Cursor ACP confirmed model configuration',
  };
}

async function configureSession(
  rpc: CursorRpc,
  sessionId: string,
  session: Row,
  ctx: ExecuteContext,
): Promise<EffectiveModelSelection> {
  const wanted = requestedSelection(ctx.route.model, ctx.route.effort);
  const desiredMode = ctx.input.permissionMode === 'read-only' || ctx.input.prohibitCommands === true ? 'ask' : 'agent';
  const modes = object(session.modes);
  const available = Array.isArray(modes.availableModes) ? modes.availableModes.map(object) : [];
  if (!available.some((mode) => mode.id === desiredMode)) throw new Error('runtime-permission-or-sandbox-error');
  // Restored sessions may have a different mode. Never rely on prompt instructions or the launch flag alone.
  await rpc.request('session/set_mode', { sessionId, modeId: desiredMode });
  let options = configOptions(session.configOptions);
  const modelOption = options.find((option) => option.category === 'model' || option.id === 'model');
  if (modelOption) {
    const values = optionValues(modelOption);
    // Parameterized peers expose a family choice; old peers expose exact slugs or bracket variants.
    const value = values.includes(wanted.family)
      ? wanted.family
      : sessionModel(values, ctx.route.model, ctx.route.effort)?.value;
    if (!value) throw new Error('runtime-protocol-incompatible');
    const confirmed = new Map<string, string>();
    const set = async (id: string, setting: string) => {
      if (options.find((option) => option.id === id)?.currentValue !== setting) {
        const response = await rpc.request('session/set_config_option', { sessionId, configId: id, value: setting });
        options = configOptions(response.configOptions);
      }
      confirmed.set(id, setting);
      // A later setting can reset earlier ones. Check the complete confirmed selection after every change.
      for (const [key, expected] of confirmed)
        if (options.find((option) => option.id === key)?.currentValue !== expected)
          throw new Error('runtime-protocol-incompatible');
    };
    await set(text(modelOption.id), value);
    if (value !== wanted.family) return actualSelection(value);

    const setParameter = async (id: string, expected: string) => {
      const option = options.find((item) => item.id === id);
      const setting = option && optionValues(option).find((choice) => normalizeEffort(choice) === expected);
      if (!option || setting === undefined) throw new Error('runtime-protocol-incompatible');
      await set(id, setting);
    };
    const thinking = options.find((option) => option.id === 'thinking');
    if (wanted.thinking) await setParameter('thinking', 'true');
    else if (thinking && ctx.route.model !== wanted.family) await setParameter('thinking', 'false');
    if (wanted.effort) {
      const thought = effortOption(options);
      if (!thought) throw new Error('runtime-protocol-incompatible');
      await setParameter(text(thought.id), wanted.effort);
    }
    const fast = options.find((option) => option.id === 'fast');
    if (fast || wanted.fast) await setParameter('fast', String(wanted.fast));
    return actualSelection(value, options);
  } else {
    const models = object(session.models);
    const choice = sessionModel([text(models.currentModelId)], ctx.route.model, ctx.route.effort);
    if (!choice) throw new Error('runtime-protocol-incompatible');
    return actualSelection(choice.value);
  }
}

/** Old ACP variants must match every requested setting; incompatible settings never downgrade silently. */
export function sessionModel(values: string[], model: string, effort?: string): { value: string } | undefined {
  const wanted = requestedSelection(model, effort);
  const exact = values.find(
    (value) => value === model && (!wanted.effort || parseCursorModel(value).effort === wanted.effort),
  );
  if (exact) return { value: exact };
  for (const value of values) {
    if (!value.includes('[')) {
      const candidate = parseCursorModel(value);
      if (
        wanted.effort &&
        candidate.family === wanted.family &&
        candidate.effort === wanted.effort &&
        candidate.fast === wanted.fast &&
        candidate.thinking === wanted.thinking
      )
        return { value };
      continue;
    }
    if (value.split('[')[0] !== wanted.family) continue;
    const settings = bracketParameters(value);
    if (!settings) continue;
    const actualEffort = normalizeEffort(settings.effort ?? settings.reasoning ?? settings.reasoning_effort ?? '');
    if (wanted.effort && actualEffort !== wanted.effort) continue;
    if (settings.fast !== String(wanted.fast)) continue;
    if (wanted.thinking ? settings.thinking !== 'true' : settings.thinking === 'true') continue;
    return { value };
  }
  return undefined;
}

async function execute(ctx: ExecuteContext, deps: Dependencies): Promise<ExecuteResult> {
  ctx.registerSteer?.(undefined, { state: 'unsupported', reason: 'Cursor ACP 当前没有已验证的同轮 steer 协议。' });
  if (ctx.signal.aborted) throw abortError();
  assertIdentity(await status(ctx.target, deps), ctx);
  if (ctx.signal.aborted) throw abortError();
  const env = memberEnvironment(ctx.target);
  const wanted = requestedSelection(ctx.route.model, ctx.route.effort);
  const cwd = await deps.targetPath(ctx.target, ctx.input.projectPath);
  if (ctx.signal.aborted) throw abortError();
  const args = cursorExecutionArgs(ctx);
  const bridge = ctx.input.visualAssistant ? undefined : ctx.agentBridge;
  const hostTools = new Set(
    bridge ? (await deps.bridgeTools(bridge, ctx.signal)).map((name) => `mcp__pugport__${name}`) : [],
  );
  if (ctx.signal.aborted) throw abortError();
  const child = await deps.spawn(ctx.target, args, {
    cwd: ctx.input.projectPath,
    env,
    sandbox: ctx.sandbox,
    onSandboxFailure: ctx.onSandboxFailure,
    onSandboxSuccess: ctx.onSandboxSuccess,
    signal: ctx.signal,
    runTemp: ctx.runTemp,
  });
  auditNativeProcess(ctx, child, args, 'cursor-acp');
  const rpc = new CursorRpc(child, deps.terminate, deps.requestTimeoutMs, {
    paths: [ctx.dataDir, ctx.target.agentDir],
    secrets: [ctx.agentBridge?.token],
    prompt: ctx.input.prompt,
  });
  let sessionId = ctx.nativeSessionId ?? '',
    active = false,
    output = '',
    cancelTimer: NodeJS.Timeout | undefined;
  const toolStates = new Map<string, Row>();
  const readOnly = ctx.input.permissionMode === 'read-only' || ctx.input.prohibitCommands === true;
  if (ctx.input.prohibitCommands === true && ctx.input.permissionMode === 'workspace-write')
    ctx.emit({
      at: now(),
      type: 'status',
      text: 'Command prohibition limits Cursor native tools to read-only mode; native file writes are also disabled.',
    });
  const stop = () => {
    if (sessionId && active) rpc.notify('session/cancel', { sessionId });
    // A broken peer must not keep inference/tools alive after cancellation. Pending permission handlers
    // see the abort signal and return the ACP cancelled outcome before the bounded hard stop.
    cancelTimer ??= setTimeout(() => {
      void rpc.close();
    }, 1200);
  };
  ctx.signal.addEventListener('abort', stop, { once: true });
  rpc.onRequest = async (method, params) => {
    if (text(params.sessionId) && params.sessionId !== sessionId) {
      if (method === 'session/request_permission') return { outcome: { outcome: 'cancelled' } };
      throw new Error('unsupported-server-request');
    }
    if (method === 'session/request_permission') {
      if (params.sessionId !== sessionId || ctx.signal.aborted || !active) return { outcome: { outcome: 'cancelled' } };
      const tool = object(params.toolCall),
        kind = text(tool.kind);
      const options = (Array.isArray(params.options) ? params.options : []).map(object);
      const once = options.find((option) => option.kind === 'allow_once');
      const reject = options.find((option) => option.kind === 'reject_once');
      // A named tool from our authenticated run-scoped host is authorized again at the host.
      // Never infer MCP identity from a title, and never let a host-looking name authorize native writes.
      const hostTool = kind === 'other' && hostTools.has(text(cursorToolEventData(tool).tool));
      const nativeToolName = Object.hasOwn(tool, 'toolName')
        ? tool.toolName
        : Object.hasOwn(object(tool.rawInput), 'tool_name')
          ? object(tool.rawInput).tool_name
          : object(object(tool._meta)['x.ai/tool']).name;
      const deferredTool =
        hostTool && deferredBridgeToolNames.some((name) => `mcp__pugport__${name}` === nativeToolName);
      const permitted = !readOnly || ['read', 'search', 'fetch'].includes(kind) || hostTool;
      const granted =
        permitted &&
        !!once &&
        (deferredTool ||
          ctx.approvalMode === 'auto' ||
          (await approve(
            ctx,
            clean(text(tool.title) || `Cursor ${kind || 'tool'}`),
            JSON.stringify(tool, (key, value: unknown) =>
              /token|password|secret|authorization|api.?key/i.test(key) ? '[redacted]' : value,
            ),
          )));
      if (ctx.signal.aborted) return { outcome: { outcome: 'cancelled' } };
      const option = granted ? once : reject;
      if (!granted)
        ctx.emit({ at: now(), type: 'status', text: 'Cursor 操作被权限规则拒绝。', data: { decision: 'deny', kind } });
      return option
        ? { outcome: { outcome: 'selected', optionId: option.optionId } }
        : { outcome: { outcome: 'cancelled' } };
    }
    if (method === 'cursor/ask_question') {
      ctx.emit({ at: now(), type: 'status', text: 'Cursor 请求补充选择；当前客户端没有多选回答协议，已明确跳过。' });
      return {
        outcome: {
          outcome: ctx.signal.aborted ? 'cancelled' : 'skipped',
          reason: 'Client does not support multiple-choice answers.',
        },
      };
    }
    if (method === 'cursor/create_plan') {
      if (ctx.signal.aborted) return { outcome: { outcome: 'cancelled' } };
      const accepted =
        !readOnly && active && (ctx.approvalMode === 'auto' || (await approve(ctx, 'Cursor plan', text(params.plan))));
      return { outcome: { outcome: ctx.signal.aborted ? 'cancelled' : accepted ? 'accepted' : 'rejected' } };
    }
    // fs/* and terminal/* were not advertised. Never service unexpected write or command requests.
    throw new Error('unsupported-server-request');
  };
  rpc.onNotification = (method, params) => {
    if (method !== 'session/update' || params.sessionId !== sessionId) return;
    const update = object(params.update),
      type = text(update.sessionUpdate);
    if (type === 'current_mode_update' && active && readOnly && update.currentModeId !== 'ask') {
      rpc.notify('session/cancel', { sessionId });
      rpc.fail(new Error('runtime-permission-or-sandbox-error'));
      return;
    }
    // session/load replays old messages. Ignore that history for this run's output and token counts.
    if (!active) {
      if (type === 'usage_update' && ctx.nativeSessionId) emitContextUsage(update, true);
      return;
    }
    auditUnmappedSessionUpdate(ctx, method, update);
    if (type === 'agent_message_chunk' || type === 'agent_thought_chunk') {
      const content = object(update.content),
        chunk = content.type === 'text' ? text(content.text) : '';
      if (!chunk) return;
      if (type === 'agent_message_chunk') output += chunk;
      ctx.emit({ at: now(), type: type === 'agent_message_chunk' ? 'text' : 'reasoning', text: chunk });
    } else if (type === 'tool_call' || type === 'tool_call_update') {
      const id = text(update.toolCallId);
      const data = cursorToolEventData(update, toolStates.get(id));
      if (id)
        toolStates.set(
          id,
          Object.fromEntries(
            ['kind', 'status', 'title', 'tool']
              .filter((field) => data[field] !== undefined)
              .map((field) => [field, data[field]]),
          ),
        );
      ctx.emit({
        at: now(),
        type: 'tool',
        text: clean(text(data.title) || text(data.tool) || text(data.kind) || 'Cursor tool'),
        data,
      });
    } else if (type === 'usage_update') emitContextUsage(update, false);
    else if (type === 'plan') ctx.emit({ at: now(), type: 'status', data: { taskList: update.entries } });
  };
  function emitContextUsage(update: Row, baseline: boolean) {
    const cost = object(update.cost);
    if (cost.currency === 'USD' && finite(cost.amount))
      ctx.emit({
        at: now(),
        type: 'usage',
        data: {
          estimatedCostUsd: cost.amount,
          scope: 'session-cumulative',
          cumulative: true,
          sessionId,
          baseline,
          freshSession: !ctx.nativeSessionId,
          eventId: `cursor-cost:${cost.amount}`,
          source: 'Cursor ACP usage_update.cost',
          note: '原生会话累计成本报告，不代表套餐或活动余额。',
        },
      });
    if (!baseline && finite(update.used) && finite(update.size))
      ctx.emit({
        at: now(),
        type: 'status',
        text: 'Cursor 已更新上下文窗口用量。',
        data: { contextTokens: update.used, contextWindow: update.size },
      });
  }
  try {
    if (ctx.signal.aborted) throw abortError();
    const capabilities = await rpc.initialize();
    const parameterized = await parameterizedCatalog(rpc);
    if (parameterized) {
      const model = parameterized.find((item) => item.id === wanted.family);
      if (!model || (wanted.effort && !model.efforts.includes(wanted.effort)))
        throw new Error('runtime-protocol-incompatible');
    } else {
      // Only old ACP peers need a separate CLI process to list model slugs.
      const catalog = cursorModels((await deps.capture(ctx.target, ['models'], { env })).stdout);
      if (ctx.signal.aborted) throw abortError();
      if (
        !sessionModel(
          catalog.map((model) => model.id),
          ctx.route.model,
          ctx.route.effort,
        )
      )
        throw new Error('runtime-protocol-incompatible');
    }
    const prompt = await promptContent(ctx, capabilities);
    const mcpServers = bridge ? cursorBridgeServers(bridge) : [];
    if (mcpServers.length && object(capabilities.mcpCapabilities).http !== true)
      throw new Error('runtime-protocol-incompatible');
    if (ctx.nativeSessionId && capabilities.loadSession !== true) throw new Error('native-session-unavailable');
    if (ctx.signal.aborted) throw abortError();
    // The CLI is already authenticated on startup. Do not call authenticate(): Cursor's handler can
    // open a browser and change credentials if auth has expired. Return auth-required instead.
    const session = await rpc
      .request(ctx.nativeSessionId ? 'session/load' : 'session/new', {
        ...(ctx.nativeSessionId ? { sessionId } : {}),
        cwd,
        mcpServers,
      })
      .catch((error) => {
        if (ctx.nativeSessionId && !ctx.signal.aborted)
          throw runtimeError(error, {
            code: 'native-session-unavailable',
            paths: [ctx.dataDir, ctx.target.agentDir],
            prompt: ctx.input.prompt,
          });
        throw error;
      });
    rpc.startup.done();
    if (bridge)
      ctx.emit({
        at: now(),
        type: 'status',
        text: 'Cursor 已接通当前任务授权的宿主工具。',
        data: {
          source: 'pugport',
          kind: 'host-tool-bridge',
          ready: true,
          tools: [...hostTools],
          permissionMode: ctx.input.permissionMode,
        },
      });
    if (!ctx.nativeSessionId) sessionId = text(session.sessionId);
    if (!sessionId) throw new Error('runtime-protocol-incompatible');
    const effectiveModel = await configureSession(rpc, sessionId, session, ctx);
    assertIdentity(await status(ctx.target, deps), ctx);
    if (ctx.signal.aborted) throw abortError();
    ctx.emit({ at: now(), type: 'session', data: { nativeSessionId: sessionId, effectiveModel } });
    active = true;
    const result = await Promise.race([rpc.request('session/prompt', { sessionId, prompt }, 0), rpc.failure]);
    if (ctx.signal.aborted || result.stopReason === 'cancelled') throw abortError();
    const usage = cursorResultUsage(result);
    if (usage) ctx.emit({ at: now(), type: 'usage', data: usage });
    if (result.stopReason !== 'end_turn') throw new Error('runtime-request-failed');
    return { nativeSessionId: sessionId, output, effectiveModel };
  } catch (error) {
    if (ctx.signal.aborted) throw abortError();
    throw runtimeError(error, { paths: [ctx.dataDir, ctx.target.agentDir], prompt: ctx.input.prompt });
  } finally {
    ctx.endTools?.();
    active = false;
    clearTimeout(cancelTimer);
    ctx.signal.removeEventListener('abort', stop);
    await rpc.close();
  }
}

export function createCursorAdapter(overrides: Partial<Dependencies> = {}): Adapter {
  const deps = { ...defaults, ...overrides };
  return {
    discover: (target, options) =>
      discover(target, deps, options, process.platform === 'win32' && !Object.keys(overrides).length),
    execute: (ctx) => execute(ctx, deps),
  };
}
export const cursorAdapter: Adapter = createCursorAdapter();
