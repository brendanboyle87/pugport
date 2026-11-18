import { isolatedUserPath } from './platform/under-test.ts';
import { existsSync } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CursorCredits, QuotaWindow, RuntimeSnapshot } from '../shared/types.ts';
import { missedCheckReferenceMs, recentCursorIdentity } from '../shared/runtime-health.ts';

/*
 * Cursor's live usage, read the way Cursor's own dashboard reads it. Cursor publishes no balance query for
 * its CLI, so — only when the user turns it on in Settings — PugPort reads the login the Cursor editor
 * keeps on this computer and asks cursor.com for the current billing period's usage. The login stays in
 * memory for that one request: it is never stored, logged or shown. Grok Bot's usage RPC uses the same login
 * only at the fixed api2.cursor.sh endpoint below.
 * The dashboard endpoint is not a published API; when Cursor changes it, the card says so instead of
 * guessing.
 */

/**
 * The only cursor.com addresses PugPort ever calls, all of them reads. Never widen this by pattern:
 * the dashboard also has endpoints that change billing settings with the same kind of request.
 */
export const cursorReadEndpoints = {
  usage: { method: 'GET', url: 'https://cursor.com/api/usage-summary' },
  grants: { method: 'POST', url: 'https://cursor.com/api/dashboard/get-client-visible-credit-grants' },
  balance: { method: 'POST', url: 'https://cursor.com/api/dashboard/get-credit-grants-balance' },
  /** The subscription record; its customerBalance (cents, negative when Cursor owes you) is the account credit. */
  account: { method: 'GET', url: 'https://cursor.com/api/auth/stripe' },
} as const;

export const grokBotUsageEndpoint = 'https://api2.cursor.sh/aiserver.v1.DashboardService/GetSandUsageStatus';
const grokSource = 'Cursor 登录 · Grok Bot 用量';
export function parseGrokBotUsage(
  payload: unknown,
  observedAt = new Date().toISOString(),
  source = grokSource,
): RuntimeSnapshot['quota'] {
  const root = object(payload);
  const used = root.usagePercent;
  const timestamp = root.nextResetTimestampUtc;
  const numeric = typeof timestamp === 'number' || (typeof timestamp === 'string' && /^\d+$/.test(timestamp));
  const reset = instant(numeric ? Number(timestamp) * (Number(timestamp) < 1e12 ? 1000 : 1) : timestamp);
  const label = (value: unknown) => (typeof value === 'string' && value.trim().length <= 80 ? value.trim() : '');
  const plan = label(root.grokPlanLabel) || label(root.cursorPlanName) || '未报告套餐';
  const billingBrand =
    typeof root.billingBrand === 'string' && /^SAND_BILLING_BRAND_[A-Z_]{1,40}$/.test(root.billingBrand)
      ? root.billingBrand
      : undefined;
  const currentPeriodStart = instant(root.currentPeriodStart);
  if (typeof used !== 'number' || !Number.isFinite(used) || used < 0 || used > 100)
    return {
      status: 'unknown',
      source,
      observedAt,
      windows: [],
      note: 'Grok Bot 返回的用量格式无法识别。',
    };
  return {
    status: 'known',
    source,
    observedAt,
    windows: [
      {
        id: 'grok-bot',
        label: plan,
        usedPercent: used,
        resetsAt: reset,
        ...(!reset ? { resetNotReported: true } : {}),
      },
    ],
    subscription: {
      label: `${plan}${billingBrand === 'SAND_BILLING_BRAND_CURSOR' ? ' · Cursor' : ''}`,
      source,
      observedAt,
    },
    ...(billingBrand ? { billingBrand } : {}),
    ...(currentPeriodStart ? { currentPeriodStart } : {}),
  };
}

/** Same Cursor session and bounded JSON read; never expose response bodies or thrown credential-bearing errors. */
export async function fetchGrokBotUsage(
  session: CursorEditorSession | undefined,
  options: { fetch?: typeof fetch; signal?: AbortSignal; timeoutMs?: number; now?: () => number } = {},
): Promise<RuntimeSnapshot['quota']> {
  const observedAt = new Date((options.now ?? Date.now)()).toISOString();
  const unknown = (note: string): RuntimeSnapshot['quota'] => ({
    status: 'error',
    source: grokSource,
    observedAt,
    windows: [],
    note,
  });
  if (!session) return unknown('没有找到有效的 Cursor 登录。');
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 8_000);
  try {
    return await bounded(async () => {
      const response = await (options.fetch ?? fetch)(grokBotUsageEndpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${session.token}`,
          origin: 'https://cursor.com',
          referer: 'https://cursor.com/dashboard',
          'content-type': 'application/json',
          'connect-protocol-version': '1',
        },
        body: '{}',
        redirect: 'error',
        signal,
      });
      if (response.status === 401 || response.status === 403)
        return unknown('Cursor 登录失效或无权读取 Grok Bot 用量。');
      if (!response.ok) return unknown('Grok Bot 用量服务暂时无法读取。');
      const payload: unknown = await response.json();
      // A service must never be able to echo the login into a saved plan or error.
      if (JSON.stringify(payload)?.includes(session.token)) return unknown('Grok Bot 返回的用量格式无法识别。');
      return parseGrokBotUsage(payload, observedAt);
    }, signal);
  } catch {
    return unknown('暂时无法读取 Grok Bot 用量，稍后会自动重试。');
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

let enabled = false;
let usageGeneration = 0;
/** Turning the setting off invalidates even requests already awaiting a response. */
export const cursorEditorUsage = {
  get enabled() {
    return enabled;
  },
  set enabled(value: boolean) {
    if (enabled === value) return;
    enabled = value;
    usageGeneration++;
    recent.clear();
    for (const request of inFlight.values()) request.controller.abort();
    inFlight.clear();
  },
  /** Kept in sync with the router's quota freshness limit by the controller. */
  maxAgeMs: 120_000,
};

type Row = Record<string, unknown>;
const object = (value: unknown): Row =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : {};
const percent = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.min(100, value) : null;
const amount = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null);
const instant = (value: unknown): string | null => {
  const time =
    typeof value === 'number' || (typeof value === 'string' && /^\d{12,14}$/.test(value))
      ? Number(value)
      : typeof value === 'string'
        ? Date.parse(value)
        : NaN;
  const date = new Date(time);
  return Number.isFinite(time) && time > 0 && Number.isFinite(date.getTime()) ? date.toISOString() : null;
};

export function cursorUserFolder(): string {
  const base =
    process.platform === 'win32'
      ? process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
      : process.platform === 'darwin'
        ? join(homedir(), 'Library', 'Application Support')
        : process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(isolatedUserPath(base), 'Cursor', 'User');
}

export function cursorStateDatabase(): string {
  return join(cursorUserFolder(), 'globalStorage', 'state.vscdb');
}

export const cursorDatabaseText = (value: unknown): string =>
  typeof value === 'string' ? value : value instanceof Uint8Array ? Buffer.from(value).toString() : '';

/** Whether a quota (or its error) came from this module's cursor.com reading, for either kind of login. */
export const cursorDashboardSource = (source: string | undefined) =>
  !!source && /^(?:Cursor 编辑器登录|此账号的 Cursor 登录)/.test(source);

export type CursorEditorSession = { userId: string; token: string; email?: string };
export type CursorUsageIdentity =
  | { state: 'missing' }
  | { state: 'unverified' }
  | { state: 'verified'; email: string; userId?: string }
  | { state: 'reference'; verification: NonNullable<RuntimeSnapshot['cursorVerifiedIdentity']> };

export const cursorIdentityHash = (value: string) => createHash('sha256').update(value).digest('hex');

/** A Cursor access token's account id; undefined for a malformed or expired token. Never checks a signature. */
function sessionFromToken(token: string, email = ''): CursorEditorSession | undefined {
  if (!/^[\w-]+\.[\w-]+\.[\w-]+$/.test(token)) return undefined;
  const claims = object(JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()));
  if (typeof claims.exp === 'number' && claims.exp * 1000 <= Date.now()) return undefined;
  const subject = typeof claims.sub === 'string' ? claims.sub : '';
  const userId = subject.includes('|') ? subject.split('|').pop()! : subject;
  if (!/^[\w-]{1,200}$/.test(userId)) return undefined;
  return { userId, token, ...(email.includes('@') ? { email } : {}) };
}

/**
 * A second Cursor account's own CLI login (auth.json inside PugPort's account folder; never the editor's or the
 * default CLI's). Like the editor's login it stays in memory for one request to cursor.com.
 */
export async function readCursorCliSession(file: string): Promise<CursorEditorSession | undefined> {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024) return undefined;
    const token = object(JSON.parse(await readFile(isolatedUserPath(file), 'utf8'))).accessToken;
    return typeof token === 'string' ? sessionFromToken(token.trim()) : undefined;
  } catch {
    return undefined;
  }
}

/** The Cursor editor's current login, or undefined when it is not installed, signed out or expired. */
export async function readCursorEditorSession(file = cursorStateDatabase()): Promise<CursorEditorSession | undefined> {
  file = isolatedUserPath(file);
  if (!existsSync(file)) return undefined;
  const { DatabaseSync } = await import('node:sqlite');
  let db: InstanceType<typeof DatabaseSync> | undefined;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    // One SQLite statement gives the token and its cached email the same read snapshot.
    const rows = db
      .prepare('SELECT key, value FROM ItemTable WHERE key IN (?, ?)')
      .all('cursorAuth/accessToken', 'cursorAuth/cachedEmail') as Array<{ key: string; value: unknown }>;
    const read = (key: string) => {
      const value = rows.find((row) => row.key === key)?.value;
      return cursorDatabaseText(value);
    };
    const token = read('cursorAuth/accessToken').trim();
    const email = read('cursorAuth/cachedEmail').trim().toLowerCase();
    return sessionFromToken(token, email);
  } catch {
    return undefined;
  } finally {
    db?.close();
  }
}

/** The usage summary as quota windows: one per pool (Auto and API), each resetting at the end of the billing period. */
export function parseCursorUsage(
  payload: unknown,
  observedAt = new Date().toISOString(),
  login = 'Cursor 编辑器登录',
): RuntimeSnapshot['quota'] {
  const root = object(payload);
  const plan = object(object(root.individualUsage).plan);
  const onDemand = object(object(root.individualUsage).onDemand);
  const resetsAt = instant(root.billingCycleEnd);
  const periodStartedAt = instant(root.billingCycleStart);
  const reset = {
    resetsAt,
    ...(root.billingCycleEnd == null ? { resetNotReported: true } : {}),
    ...(periodStartedAt ? { periodStartedAt } : {}),
  };
  const source = `${login} · cursor.com 用量`;
  if (root.isUnlimited === true)
    return {
      status: 'known',
      source,
      observedAt,
      windows: [],
      unlimited: true,
      note: 'Cursor 报告当前套餐不限量。',
      cursorCredits: credits(root),
    };
  const limit = amount(plan.limit);
  const used = amount(plan.used);
  const total =
    percent(plan.totalPercentUsed) ??
    (limit !== null && limit > 0 && used !== null ? percent((used / limit) * 100) : null);
  const windows: QuotaWindow[] = [];
  const auto = percent(plan.autoPercentUsed);
  const api = percent(plan.apiPercentUsed);
  if (auto !== null || api !== null) {
    windows.push({ id: 'cursor-auto', label: 'Cursor Models', modelPool: 'cursor', usedPercent: auto, ...reset });
    windows.push({ id: 'cursor-api', label: 'Other Models', modelPool: 'other', usedPercent: api, ...reset });
  } else if (total !== null) windows.push({ id: 'cursor-plan', label: '本账期用量', usedPercent: total, ...reset });
  if (!windows.length)
    return {
      status: 'unknown',
      source,
      observedAt,
      windows: [],
      note: 'Cursor 返回的用量格式无法识别，可能已改版；请在 Cursor 官网核对。',
    };
  const notes = [
    `本账期 ${dayText(instant(root.billingCycleStart))} 至 ${dayText(resetsAt)}${total !== null ? `，合计已用 ${Math.round(total * 10) / 10}%` : ''}。`,
    onDemand.enabled === true ? '已开启超额按量付费，用完套餐额度后会继续扣费。' : '',
  ].filter(Boolean);
  return { status: 'known', source, observedAt, windows, note: notes.join(''), cursorCredits: credits(root) };
}

/** Cents as cursor.com sends them (numbers or numeric strings), in dollars. */
const dollars = (value: unknown): number | null => {
  const cents = typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) : value;
  return typeof cents === 'number' && Number.isFinite(cents) ? Math.round(cents) / 100 : null;
};

/** On-demand spending from the usage summary; grants and their total are added from their own reads. */
function credits(summary: Row, grants?: unknown, balance?: unknown, account?: unknown): CursorCredits {
  const customer = dollars(object(account).customerBalance);
  const onDemand = object(object(summary.individualUsage).onDemand);
  const total = object(balance);
  return {
    // Stripe keeps credit as a negative balance: -4000 cents is $40 the account holds.
    accountUsd: customer === null ? null : -customer,
    balanceUsd: dollars(total.creditBalanceCents),
    totalUsd: dollars(total.totalCents),
    usedUsd: dollars(total.usedCents),
    grants: (Array.isArray(object(grants).grants) ? (object(grants).grants as unknown[]) : [])
      .slice(0, 20)
      .map((item) => {
        const grant = object(item);
        return {
          name: typeof grant.displayName === 'string' ? grant.displayName.slice(0, 80) : '赠送额度',
          remainingUsd: dollars(grant.remainingCents),
          totalUsd: dollars(grant.totalCents),
          expiresAt: instant(grant.expiresAtMs),
        };
      }),
    onDemand:
      typeof onDemand.enabled === 'boolean'
        ? { enabled: onDemand.enabled, limitUsd: dollars(onDemand.limit), usedUsd: dollars(onDemand.used) }
        : null,
  };
}

const dayText = (value: string | null) =>
  value ? new Date(value).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }) : '未报告';

/** A fetch substitute may ignore AbortSignal; bound the whole read, including its JSON body. */
function bounded<T>(read: () => Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(new Error('cursor-usage-cancelled'));
    if (signal.aborted) return aborted();
    signal.addEventListener('abort', aborted, { once: true });
    void Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return read();
      })
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', aborted));
  });
}

/** Asks only the four read endpoints; a shared deadline also bounds optional credit reads. */
export async function fetchCursorUsage(
  session: CursorEditorSession,
  options: {
    fetch?: typeof fetch;
    signal?: AbortSignal;
    timeoutMs?: number;
    now?: () => number;
    /** The session is a second account's own CLI login rather than the editor's. */
    accountLogin?: boolean;
  } = {},
): Promise<RuntimeSnapshot['quota']> {
  const observedAt = new Date((options.now ?? Date.now)()).toISOString();
  const login = options.accountLogin ? '此账号的 Cursor 登录' : 'Cursor 编辑器登录';
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 8_000);
  const read = (endpoint: (typeof cursorReadEndpoints)[keyof typeof cursorReadEndpoints]) =>
    bounded(async () => {
      const response = await (options.fetch ?? fetch)(endpoint.url, {
        method: endpoint.method,
        headers: {
          cookie: `WorkosCursorSessionToken=${session.userId}%3A%3A${session.token}`,
          origin: 'https://cursor.com',
          referer: 'https://cursor.com/dashboard',
          ...(endpoint.method === 'POST' ? { 'content-type': 'application/json' } : {}),
        },
        ...(endpoint.method === 'POST' ? { body: '{}' } : {}),
        redirect: 'error',
        signal,
      });
      return { status: response.status, ok: response.ok, body: response.ok ? await response.json() : undefined };
    }, signal);
  // Credit grants are extras: when they cannot be read, the usage pools still show.
  const extra = (endpoint: (typeof cursorReadEndpoints)[keyof typeof cursorReadEndpoints]) =>
    read(endpoint)
      .then((response) => (response.ok ? response.body : undefined))
      .catch(() => undefined);
  try {
    const responsePromise = read(cursorReadEndpoints.usage);
    const extras = Promise.all([
      extra(cursorReadEndpoints.grants),
      extra(cursorReadEndpoints.balance),
      extra(cursorReadEndpoints.account),
    ]);
    const response = await responsePromise;
    if (response.status === 401 || response.status === 403)
      return {
        status: 'error',
        source: login,
        observedAt,
        windows: [],
        note: options.accountLogin
          ? '这个 Cursor 账号的登录已失效；在账号卡片上点"重新登录"后会自动恢复。'
          : 'Cursor 编辑器的登录已失效；在 Cursor 编辑器里重新登录后会自动恢复。',
      };
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const [grants, balance, account] = await extras;
    const summary = response.body;
    const quota = parseCursorUsage(summary, observedAt, login);
    const incomplete = [grants, balance, account].some((value) => value === undefined);
    return {
      ...quota,
      ...(incomplete
        ? { note: [quota.note, '部分赠送额度或账户余额未能读取；未报告的金额保持未知。'].filter(Boolean).join('') }
        : {}),
      cursorCredits: credits(object(summary), grants, balance, account),
    };
  } catch {
    return {
      status: 'error',
      source: login,
      observedAt,
      windows: [],
      note: '暂时无法从 cursor.com 读取用量，稍后会自动重试。',
    };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

/**
 * The CLI must have a stable, verified identity. An explicitly absent CLI can show editor-only usage;
 * a failed identity read must not be mistaken for an absent CLI.
 */
export async function applyCursorEditorUsage(
  snapshot: RuntimeSnapshot,
  identity: CursorUsageIdentity,
  dependencies: {
    session?: () => Promise<CursorEditorSession | undefined>;
    fetch?: typeof fetch;
    timeoutMs?: number;
    now?: () => number;
    /** Active executions need fresher observations than an idle dashboard. */
    maxCacheAgeMs?: number;
    referenceQuota?: RuntimeSnapshot['quota'];
    /**
     * `session` reads a second account's own CLI login from its folder. That login is the CLI's by construction, so
     * there is no editor account to match against it.
     */
    accountLogin?: boolean;
  } = {},
) {
  if (!cursorEditorUsage.enabled) return;
  const generation = usageGeneration;
  const own = dependencies.accountLogin === true;
  if (
    identity.state === 'unverified' ||
    (identity.state === 'verified' && !identity.email.trim()) ||
    (identity.state === 'reference' && !recentCursorIdentity(identity.verification, (dependencies.now ?? Date.now)()))
  ) {
    snapshot.quota = {
      ...snapshot.quota,
      note: own
        ? '命令行账号身份尚未核验一致，暂不读取这个账号的用量。'
        : '命令行账号身份尚未核验一致，未把编辑器账号的用量算到这张卡上。',
    };
    return;
  }
  const session = await (dependencies.session ?? readCursorEditorSession)();
  if (!cursorEditorUsage.enabled || generation !== usageGeneration) return;
  if (!session) {
    snapshot.quota = {
      ...snapshot.quota,
      note: own
        ? '已开启自动查询，但还读不到这个账号的登录；登录后会自动读取。'
        : '已开启自动查询，但没有找到 Cursor 编辑器的有效登录；在 Cursor 编辑器里登录后会自动读取。',
    };
    return;
  }
  const email = session.email?.trim().toLowerCase();
  // The CLI reports a numeric account number while the editor's token names the account by its
  // "user_…" login id: two different namespaces. Ids are compared only when they share one; the
  // email must always match.
  const cliId = identity.state === 'verified' ? identity.userId?.split('|').at(-1) : undefined;
  if (
    (identity.state === 'reference' &&
      (!email ||
        cursorIdentityHash(email) !== identity.verification.emailHash ||
        (identity.verification.userIdHash &&
          cursorIdentityHash(session.userId) !== identity.verification.userIdHash))) ||
    (!own &&
      identity.state === 'verified' &&
      (!email ||
        identity.email.trim().toLowerCase() !== email ||
        (cliId && !/^\d+$/.test(cliId) && cliId !== session.userId)))
  ) {
    snapshot.quota = {
      ...snapshot.quota,
      note: 'Cursor 编辑器登录的账号与命令行登录的账号不同，未把编辑器账号的用量算到这张卡上。',
    };
    return;
  }
  // A renewed token can recover immediately from an auth error cached for the same account.
  const reference = dependencies.referenceQuota;
  const observed = Date.parse(reference?.observedAt ?? '');
  const currentTime = (dependencies.now ?? Date.now)();
  if (
    identity.state === 'reference' &&
    reference?.status === 'known' &&
    Number.isFinite(observed) &&
    observed <= currentTime &&
    currentTime - observed < missedCheckReferenceMs
  ) {
    snapshot.quota = structuredClone(reference);
    return;
  }
  const key = `${own ? 'account:' : ''}${session.userId}:${createHash('sha256').update(session.token).digest('hex')}`;
  const clock = dependencies.now ?? Date.now;
  const cached = recent.get(key);
  const maxAge = Number.isFinite(cursorEditorUsage.maxAgeMs) ? Math.max(0, cursorEditorUsage.maxAgeMs - 1_000) : 0;
  const requestedAge = dependencies.maxCacheAgeMs;
  const freshness =
    typeof requestedAge === 'number' && Number.isFinite(requestedAge) ? Math.max(0, requestedAge) : 180_000;
  const ttl = Math.min(maxAge, freshness, cached?.quota.status === 'known' ? 180_000 : 10_000);
  if (cached && clock() >= cached.at && clock() - cached.at < ttl) {
    snapshot.quota = structuredClone(cached.quota);
    return;
  }
  let request = inFlight.get(key);
  if (!request) {
    const controller = new AbortController();
    const startedAt = clock();
    const promise = fetchCursorUsage(session, {
      fetch: dependencies.fetch,
      signal: controller.signal,
      timeoutMs: dependencies.timeoutMs,
      now: clock,
      accountLogin: own,
    })
      .then((quota) => {
        if (cursorEditorUsage.enabled && generation === usageGeneration) {
          recent.delete(key);
          // Cache cadence follows the request start, so a slow response cannot
          // defer the next active-account check for an extra polling interval.
          // The quota itself retains its actual provider observation time.
          recent.set(key, { at: startedAt, quota: structuredClone(quota) });
          if (recent.size > 16) recent.delete(recent.keys().next().value!);
        }
        return quota;
      })
      .finally(() => {
        if (inFlight.get(key)?.controller === controller) inFlight.delete(key);
      });
    request = { controller, promise };
    inFlight.set(key, request);
  }
  const quota = await request.promise;
  if (cursorEditorUsage.enabled && generation === usageGeneration) snapshot.quota = structuredClone(quota);
}
const recent = new Map<string, { at: number; quota: RuntimeSnapshot['quota'] }>();
const inFlight = new Map<string, { controller: AbortController; promise: Promise<RuntimeSnapshot['quota']> }>();
