import { subscriptionPlan } from './subscription-plan.ts';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { tmpdir } from 'node:os';
import type { RuntimeSnapshot, RuntimeTarget } from '../shared/types.js';
import { spawnTarget, terminateProcess, redactError } from './adapters/process.js';
import { grokBillingIdentity, readGrokAutoTopup, readGrokBillingSupplement } from './grok-billing-supplement.ts';

type Quota = RuntimeSnapshot['quota'];
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as ObjectValue) : {};
const number = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const source = 'Grok CLI 账单额度';
const unknown = (note: string, status: 'unknown' | 'error' = 'unknown'): Quota => ({
  status,
  source,
  observedAt: null,
  windows: [],
  note,
});
const timestamp = (value: unknown): string | null =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : null;

/** Official xai-org/grok-build billing.rs: optional creditUsagePercent and
 * currentPeriod are the included allowance. On-demand/prepaid money is separate
 * paid capacity, not another subscription constraint or an inferred percentage.
 */
export function grokBillingQuota(payload: unknown, observedAt = new Date().toISOString()): Quota {
  const config = object(object(payload).config);
  if (!Object.keys(config).length) return unknown('Grok 未返回此账号的订阅额度信息。');
  const period = object(config.currentPeriod);
  const resetsAt = timestamp(period.end ?? config.billingPeriodEnd);
  const startsAt = timestamp(period.start ?? config.billingPeriodStart);
  const duration = startsAt && resetsAt ? (Date.parse(resetsAt) - Date.parse(startsAt)) / 60_000 : null;
  const type = typeof period.type === 'string' ? period.type.replace(/^USAGE_PERIOD_TYPE_/, '') : '';
  const label =
    type === 'DAILY' ? '每日额度' : type === 'WEEKLY' ? '每周额度' : type === 'MONTHLY' ? '每月额度' : '订阅额度';
  let usedPercent: number | null = number(config.creditUsagePercent) ? config.creditUsagePercent : null;
  let percentSource: NonNullable<Quota['grokBilling']>['percentSource'] =
    usedPercent === null ? 'unknown' : 'cli-reported';
  // Only explicit legacy values may be used; {} and omitted proto fields are not zero.
  if (config.creditUsagePercent === undefined) {
    const limit = object(config.monthlyLimit).val,
      used = object(config.used).val;
    if (number(limit) && limit > 0 && number(used)) {
      usedPercent = (100 * used) / limit;
      percentSource = 'legacy-calculated';
    }
  }
  if (usedPercent !== null && (!Number.isFinite(usedPercent) || usedPercent > 100)) {
    usedPercent = null;
    percentSource = 'unknown';
  }
  // Extra usage credits: prepaid money spent once the included limit runs out, in cents.
  const prepaid = Object.hasOwn(config, 'prepaidBalance') ? Number(object(config.prepaidBalance).val ?? 0) : NaN;
  return {
    status: usedPercent === null ? 'unknown' : 'known',
    source,
    observedAt,
    grokBilling: {
      isUnifiedBillingUser: typeof config.isUnifiedBillingUser === 'boolean' ? config.isUnifiedBillingUser : null,
      percentSource,
    },
    subscription: subscriptionPlan(object(payload).subscription_tier, 'Grok CLI _x.ai/billing', observedAt),
    windows: [
      {
        id: 'included',
        label,
        usedPercent,
        resetsAt,
        ...(duration !== null && duration > 0 ? { durationMinutes: duration } : {}),
      },
    ],
    note:
      usedPercent === null
        ? '供应商未报告此账号有效的额度比例，剩余额度未知。'
        : !resetsAt
          ? 'Grok 已报告额度比例，但未报告有效重置时间。'
          : undefined,
    ...(Number.isFinite(prepaid) && prepaid >= 0 ? { grokCredits: { extraUsd: prepaid / 100, autoTopup: null } } : {}),
  };
}

type Dependencies = {
  spawn: typeof spawnTarget;
  terminate: typeof terminateProcess;
  timeoutMs: number;
  now: () => string;
  identity: typeof grokBillingIdentity;
  supplement: typeof readGrokBillingSupplement;
  autoTopup: typeof readGrokAutoTopup;
};
const defaults: Dependencies = {
  spawn: spawnTarget,
  terminate: terminateProcess,
  timeoutMs: 20_000,
  now: () => new Date().toISOString(),
  identity: grokBillingIdentity,
  supplement: readGrokBillingSupplement,
  autoTopup: readGrokAutoTopup,
};

/** Read only the native target's billing extension. No session, prompt, login,
 * browser credentials, other account homes or Magpie account pools are used.
 * spawnTarget applies the exact same managed account environment as execution.
 */
export async function readGrokQuota(target: RuntimeTarget, overrides: Partial<Dependencies> = {}): Promise<Quota> {
  if (target.provider !== 'grok' || target.environment !== 'native' || target.gateway)
    return unknown('此运行环境不支持原生 Grok 额度读取。');
  const deps = { ...defaults, ...overrides };
  let child: ChildProcessWithoutNullStreams | undefined;
  try {
    const identity = deps.identity(target);
    child = await deps.spawn(target, ['agent', 'stdio'], { cwd: tmpdir() });
    const process = child;
    const result = await new Promise<unknown>((resolve, reject) => {
      let buffer = '',
        expected = 1,
        finished = false;
      const timer = setTimeout(() => finish(new Error('runtime-timeout')), deps.timeoutMs);
      const finish = (error?: Error, value?: unknown) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        error ? reject(error) : resolve(value);
      };
      const send = (packet: ObjectValue) => {
        try {
          process.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...packet }) + '\n');
        } catch {
          finish(new Error('runtime-process-closed'));
        }
      };
      const receive = (line: string) => {
        if (finished || !line.trim()) return;
        let packet: ObjectValue;
        try {
          packet = object(JSON.parse(line));
        } catch {
          finish(new Error('runtime-protocol-incompatible'));
          return;
        }
        if (typeof packet.method === 'string') {
          // This probe does not provide files, terminals, authentication or permissions.
          if (typeof packet.id === 'number' || typeof packet.id === 'string')
            send({ id: packet.id, error: { code: -32601, message: 'Unsupported by quota probe.' } });
          return;
        }
        if (packet.id !== expected) return;
        if (packet.error) {
          const error = object(packet.error);
          finish(
            new Error(
              error.code === -32601
                ? 'runtime-protocol-incompatible'
                : redactError(typeof error.message === 'string' ? error.message : 'runtime-request-failed'),
            ),
          );
          return;
        }
        if (expected === 1) {
          if (object(packet.result).protocolVersion !== 1) {
            finish(new Error('runtime-protocol-incompatible'));
            return;
          }
          expected = 2;
          send({ id: 2, method: '_x.ai/billing', params: {} });
        } else finish(undefined, packet.result);
      };
      process.stdout.setEncoding('utf8');
      process.stdout.on('data', (chunk: string) => {
        if (finished) return;
        buffer += chunk;
        if (Buffer.byteLength(buffer) > 1024 * 1024) {
          finish(new Error('runtime-protocol-incompatible'));
          return;
        }
        let index: number;
        while (!finished && (index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          receive(line);
        }
      });
      process.stderr.resume();
      process.once('error', (error) => finish(new Error(redactError(error))));
      process.stdin.on('error', () => finish(new Error('runtime-process-closed')));
      process.once('close', () => {
        if (buffer.trim()) receive(buffer);
        finish(new Error('runtime-process-closed'));
      });
      send({
        id: 1,
        method: 'initialize',
        params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'comborunner-quota', version: '1' } },
      });
    });
    const read = grokBillingQuota(result, deps.now());
    // Auto top-up is not in the CLI's billing reply; one read-only call fills it in for the credits line.
    const autoTopup =
      read.grokCredits && identity
        ? await deps
            .autoTopup(target, identity)
            .catch(() => undefined)
            .then((on) => (deps.identity(target) === identity ? on : undefined))
        : undefined;
    const quota =
      read.grokCredits && autoTopup !== undefined ? { ...read, grokCredits: { ...read.grokCredits, autoTopup } } : read;
    const config = object(object(result).config),
      period = object(config.currentPeriod);
    if (
      identity &&
      quota.status === 'unknown' &&
      !Object.hasOwn(config, 'creditUsagePercent') &&
      typeof period.type === 'string' &&
      timestamp(period.start) &&
      timestamp(period.end) &&
      deps.identity(target) === identity
    ) {
      const supplement = await deps
        .supplement(target, identity, { type: period.type, start: String(period.start), end: String(period.end) })
        .catch(() => undefined);
      if (supplement && deps.identity(target) === identity)
        return {
          ...quota,
          status: 'known',
          source: 'Grok 官方账单',
          observedAt: deps.now(),
          windows: quota.windows.map((window) => ({ ...window, usedPercent: supplement.usedPercent })),
          grokBilling: {
            isUnifiedBillingUser: quota.grokBilling?.isUnifiedBillingUser ?? null,
            percentSource: supplement.implicitZero ? 'implicit-zero' : 'web-reported',
          },
          note: supplement.implicitZero
            ? '当前周期账单省略用量比例；按完整响应的零值规则推算已用 0%，并非供应商明确报告 0%。'
            : undefined,
        };
    }
    return quota;
  } catch (error) {
    const reason = redactError(error);
    return unknown(
      reason === 'runtime-protocol-incompatible'
        ? '当前 Grok CLI 未提供兼容的额度读取接口，剩余额度未知。'
        : reason === 'authentication-required'
          ? 'Grok 额度读取需要有效的订阅登录，剩余额度未知。'
          : reason === 'runtime-timeout'
            ? 'Grok 额度读取超时，剩余额度未知。'
            : '暂时无法读取 Grok 额度，剩余额度未知。',
      reason === 'runtime-protocol-incompatible' ? 'unknown' : 'error',
    );
  } finally {
    if (child) await deps.terminate(child);
  }
}
