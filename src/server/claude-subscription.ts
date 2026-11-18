import './platform/under-test.ts';
import { constants, realpath } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { RuntimeTarget, SubscriptionPlan } from '../shared/types.ts';
import { subscriptionPlan } from './subscription-plan.ts';

const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';
const MAX_BYTES = 256 * 1024;
const SOURCE = 'Claude 官方账户资料';
type Row = Record<string, unknown>;
const object = (value: unknown): Row =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : {};
const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
const comparable = (value: string) => (process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value));
// Unlike fs/promises.realpath's native Windows implementation, this resolver preserves
// harmless 8.3 spellings (including hosted runners' TEMP) while still resolving links.
const credentialRealpath = promisify(realpath);

export type ClaudeSubscriptionDependencies = {
  readCredentials: (path: string, signal: AbortSignal) => Promise<string>;
  fetch: typeof fetch;
  now: () => number;
  /** Tests may shorten the deadline; production reads never exceed ten seconds. */
  timeoutMs: number;
};

async function readCredentials(path: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  // Use only the profile reported by this CLI. Do not follow an alias to another account's credentials.
  for (const entry of [dirname(path), path]) {
    const info = await lstat(entry);
    if (
      info.isSymbolicLink() ||
      (entry === path ? !info.isFile() : !info.isDirectory()) ||
      comparable(await credentialRealpath(entry)) !== comparable(entry)
    )
      throw new Error('path');
  }
  signal.throwIfAborted();
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_BYTES) throw new Error('size');
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let count = 0;
    while (count < buffer.length) {
      signal.throwIfAborted();
      const read = await file.read(buffer, count, buffer.length - count, count);
      if (read.bytesRead === 0) break;
      count += read.bytesRead;
    }
    signal.throwIfAborted();
    if (count > MAX_BYTES) throw new Error('size');
    return buffer.subarray(0, count).toString('utf8');
  } finally {
    await file.close();
  }
}

async function readProfile(response: Response, signal: AbortSignal): Promise<unknown> {
  const length = response.headers.get('content-length');
  if (length && Number(length) > MAX_BYTES) {
    void response.body?.cancel().catch(() => {});
    throw new Error('size');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('body');
  const abort = () => void reader.cancel().catch(() => {});
  signal.addEventListener('abort', abort, { once: true });
  let count = 0;
  const chunks: Uint8Array[] = [];
  let complete = false;
  try {
    for (;;) {
      signal.throwIfAborted();
      const next = await reader.read();
      if (next.done) {
        complete = true;
        break;
      }
      count += next.value.byteLength;
      if (count > MAX_BYTES) throw new Error('size');
      chunks.push(next.value);
    }
    return JSON.parse(Buffer.concat(chunks, count).toString('utf8'));
  } finally {
    signal.removeEventListener('abort', abort);
    if (!complete) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Read fresh native account metadata without refreshing, copying, or modifying its credentials. */
export async function readClaudeSubscription(
  target: RuntimeTarget,
  authPayload: unknown,
  overrides: Partial<ClaudeSubscriptionDependencies> = {},
): Promise<{ subscription?: SubscriptionPlan; note?: string }> {
  const status = object(authPayload);
  const method = text(status.authMethod)
    .toLowerCase()
    .replace(/[^a-z]/g, '');
  if (
    target.provider !== 'claude' ||
    target.environment !== 'native' ||
    target.gateway ||
    status.loggedIn !== true ||
    method !== 'claudeai' ||
    status.apiProvider !== 'firstParty'
  )
    return { note: '当前认证方式不支持读取 Claude 原生订阅资料。' };
  const email = text(status.email).toLowerCase();
  const organizationId = text(status.orgId);
  const directory = text(status.configDirectory);
  if (!email.includes('@') || !organizationId || !directory || !isAbsolute(directory) || /[\0\r\n]/.test(directory))
    return { note: 'CLI 未提供可核验的账号或配置目录；套餐仍以 CLI 缓存为准。' };
  const deps: ClaudeSubscriptionDependencies = {
    readCredentials,
    fetch: globalThis.fetch,
    now: Date.now,
    timeoutMs: 10000,
    ...overrides,
  };
  const controller = new AbortController();
  const timeoutMs = Number.isFinite(deps.timeoutMs) ? Math.max(1, Math.min(10000, deps.timeoutMs)) : 10000;
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('timeout'));
    }, timeoutMs);
  });
  const load = async (): Promise<{ subscription?: SubscriptionPlan; note?: string }> => {
    let token: Row;
    try {
      const raw = await deps.readCredentials(join(directory, '.credentials.json'), controller.signal);
      controller.signal.throwIfAborted();
      if (Buffer.byteLength(raw, 'utf8') > MAX_BYTES) throw new Error('size');
      token = object(object(JSON.parse(raw)).claudeAiOauth);
    } catch {
      controller.signal.throwIfAborted();
      return { note: '无法读取此 CLI 的本地订阅凭据（可能由系统凭据库保管）；套餐仍以 CLI 缓存为准。' };
    }
    const accessToken = text(token.accessToken);
    if (!accessToken || accessToken.length > 16384 || /\s/.test(accessToken))
      return { note: '此 CLI 没有可用于读取套餐的本地访问令牌；未改变登录状态。' };
    if (typeof token.expiresAt === 'number' && token.expiresAt <= deps.now())
      return { note: 'CLI 访问令牌待原生客户端刷新；暂时保留套餐缓存，未要求重新登录。' };
    if (Array.isArray(token.scopes) && !token.scopes.includes('user:profile'))
      return { note: '此 CLI 的令牌没有账户资料读取权限；套餐仍以 CLI 缓存为准。' };
    controller.signal.throwIfAborted();
    const response = await deps.fetch(PROFILE_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
      },
      redirect: 'error',
      signal: controller.signal,
    });
    controller.signal.throwIfAborted();
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      return {
        note:
          response.status === 401 || response.status === 403
            ? '官方账户资料暂未通过认证或授权；未改变 CLI 登录状态，套餐仍以缓存为准。'
            : '官方账户资料暂时不可用；套餐仍以 CLI 缓存为准。',
      };
    }
    const profile = object(await readProfile(response, controller.signal));
    controller.signal.throwIfAborted();
    const account = object(profile.account);
    const organization = object(profile.organization);
    if (text(account.email).toLowerCase() !== email || text(organization.uuid) !== organizationId)
      return { note: '官方账户资料与当前 CLI 账号不一致，未采用该套餐。' };
    const kind = text(organization.organization_type);
    const labels: Record<string, string> = {
      claude_pro: 'Pro',
      claude_max: 'Max',
      claude_ultra: 'Ultra',
      claude_team: 'Team',
      claude_enterprise: 'Enterprise',
    };
    let label = labels[kind];
    if (!label) return { note: '官方尚未返回可识别的订阅类型；未推测套餐。' };
    const displayName = text(organization.plan_display_name).replace(/^Claude\s+/i, '');
    const display = subscriptionPlan(displayName, SOURCE);
    const max = kind === 'claude_max' || kind === 'claude_ultra';
    const family = max ? /^(?:Max|Ultra)\b/i : new RegExp(`^${label}(?:\\b|$)`, 'i');
    if (display && family.test(display.label)) label = display.label;
    if (max) {
      const tier = text(organization.rate_limit_tier).match(/^default_claude_max_(5|20)x$/)?.[1];
      if (tier) label = tier === '20' ? 'Ultra' : 'Max';
      // Since 2026-10-31 Max 20x is called Ultra and Max 5x just Max; older profile names still say 20x/5x.
      label = /\b20x\b/i.test(label) ? 'Ultra' : /\b5x\b/i.test(label) ? 'Max' : label;
    }
    return { subscription: { label, source: SOURCE, observedAt: new Date(deps.now()).toISOString() } };
  };
  try {
    return await Promise.race([load(), timeout]);
  } catch {
    // Never surface fetch errors, credential text or profile response bodies to logs/UI.
    return { note: '实时套餐查询未完成；暂时保留 CLI 套餐缓存，稍后会再次刷新。' };
  } finally {
    clearTimeout(timer!);
    controller.abort();
  }
}
