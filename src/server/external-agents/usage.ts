import { z } from 'zod';
import type { WebQuota, WebUsageField, WebUsageSignature } from '../../shared/external-agents.ts';

const field = z.object({
  path: z.array(z.string().max(120)).min(1).max(12),
  scale: z.number().positive().max(1e12),
  zeroOnly: z.literal(true).optional(),
});
export const usageSignatureSchema = z.object({
  method: z.literal('GET'),
  origin: z.string().url(),
  path: z.string().max(2000),
  windows: z
    .array(
      z.object({
        id: z.string(),
        label: z.string().max(80),
        labelPath: field.shape.path.optional(),
        percent: field,
        reset: field.optional(),
      }),
    )
    .max(4),
  balances: z.array(z.object({ id: z.string(), label: z.string().max(80), percent: field, remaining: field })).max(4),
});
export const webQuotaSchema = z.object({
  status: z.enum(['known', 'unknown', 'error']),
  source: z.string(),
  observedAt: z.string().nullable(),
  stale: z.boolean().optional(),
  subscription: z.object({ label: z.string().max(80), source: z.string(), observedAt: z.string() }).optional(),
  billingBrand: z.string().max(80).optional(),
  currentPeriodStart: z.string().optional(),
  note: z.string().max(400).optional(),
  windows: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      usedPercent: z.number().min(0).max(100).nullable(),
      resetsAt: z.string().nullable(),
      observedAt: z.string().optional(),
      durationMinutes: z.number().nullable().optional(),
      resetNotReported: z.boolean().optional(),
      stale: z.boolean().optional(),
    }),
  ),
  balances: z
    .array(
      z.object({
        id: z.string(),
        label: z.string(),
        usedPercent: z.number().min(0).max(100),
        remainingTokens: z.number().nonnegative().finite(),
        observedAt: z.string(),
        stale: z.boolean().optional(),
      }),
    )
    .optional(),
});

export function parseTokenAmount(value: string): number | undefined {
  const match = value
    .replace(/,/g, '')
    .trim()
    .match(/^(\d+(?:\.\d+)?)\s*(万|亿|[KMB]|thousand|million|billion)?(?:\s*(?:个?词元|tokens?))?$/i);
  if (!match) return;
  const unit = match[2]?.toLowerCase();
  return (
    Number(match[1]) *
    (unit === '万'
      ? 1e4
      : unit === '亿'
        ? 1e8
        : unit === 'k' || unit === 'thousand'
          ? 1e3
          : unit === 'm' || unit === 'million'
            ? 1e6
            : unit === 'b' || unit === 'billion'
              ? 1e9
              : 1)
  );
}

export function parseVisibleWebUsage(
  text: string,
  now: number,
  reset: (text: string, now: number) => string | null,
): WebQuota | undefined {
  const observedAt = new Date(now).toISOString();
  const windows: WebQuota['windows'] = [];
  const balances: NonNullable<WebQuota['balances']> = [];
  const grokPlan = text.match(
    /(?:^|\n|\s)(SuperGrok(?: Heavy)?|Grok Bot Plan)[ \t\r\n]+(?:(?:Used|Usage|已使用|已用)\s*[:：]?\s*)?(\d+(?:\.\d+)?)\s*%/i,
  );
  if (grokPlan && Number(grokPlan[2]) <= 100) {
    const resetsAt = reset(text.slice(grokPlan.index), now);
    windows.push({
      id: 'grok-bot',
      label: grokPlan[1]!.trim(),
      usedPercent: Number(grokPlan[2]),
      resetsAt,
      observedAt,
      ...(!resetsAt ? { resetNotReported: true } : {}),
    });
  }
  const grok = text.match(
    /(?:^|\n)\s*([^\n%]{1,80}?)\s+(\d+(?:\.\d+)?)\s*%\s*(?=(?:\d+(?:\.\d+)?\s*(?:天|小时|分钟|秒)\s*后重置|resets?\s+in\s+\d))/i,
  );
  const grokReset = grok && reset(text.slice(grok.index), now);
  if (
    !windows.length &&
    grok &&
    grokReset &&
    !/^(?:已使用|used|usage|remaining)$/i.test(grok[1]!.trim()) &&
    Number(grok[2]) <= 100
  )
    windows.push({
      id: 'grok-bot',
      label: grok[1]!.trim(),
      usedPercent: Number(grok[2]),
      resetsAt: grokReset,
      observedAt,
    });
  const extraAt = text.search(
    /额外的使用额度|额外使用额度|extra usage(?: allowance| credits)?|additional usage(?: allowance| credits)?/i,
  );
  const weeklyText = extraAt >= 0 ? text.slice(0, extraAt) : text;
  const weekly =
    weeklyText.match(/(?:已使用|used|usage)\s*[:：]?\s*(\d+(?:\.\d+)?)\s*%/i) ??
    weeklyText.match(/(\d+(?:\.\d+)?)\s*%\s*used/i);
  const subtitle = weeklyText.match(/每周限额|weekly limit|weekly allowance/i);
  const weeklyReset = subtitle && reset(weeklyText.slice(subtitle.index), now);
  if (!windows.length && weekly && weeklyReset && Number(weekly[1]) <= 100) {
    const plan = weeklyText
      .replace(weekly[0], '')
      .replace(
        /每周限额[\s\S]*?重置|weekly (?:limit|allowance)[^\n]*?resets?\s+(?:on\s+|at\s+)?(?:[A-Za-z]+\s+\d{1,2}(?:,?\s+\d{4})?|\d{4}[-/]\d{1,2}[-/]\d{1,2})/i,
        '',
      )
      .trim()
      .split(/\r?\n/)
      .at(-1)
      ?.trim();
    windows.push({
      id: 'muse-weekly',
      label: plan && plan.length <= 80 ? plan : '每周额度',
      usedPercent: Number(weekly[1]),
      resetsAt: weeklyReset,
      durationMinutes: 10080,
      observedAt,
    });
  }
  const extraText = extraAt >= 0 ? text.slice(extraAt) : /从不过期|never expires|no expiration/i.test(text) ? text : '';
  if (/从不过期|never expires|no expiration/i.test(extraText)) {
    const used =
      extraText.match(/(?:已使用|used|usage)\s*[:：]?\s*(\d+(?:\.\d+)?)\s*%/i) ??
      extraText.match(/(\d+(?:\.\d+)?)\s*%\s*used/i);
    const tokens =
      extraText.match(
        /(?:剩余|remaining)\s*[:：]?\s*([\d,.]+\s*(?:万|亿|[KMB]|thousand|million|billion)?\s*(?:个?词元|tokens?))/i,
      ) ?? extraText.match(/([\d,.]+\s*(?:[KMB]|thousand|million|billion)?\s*tokens?)\s*(?:left|remaining)/i);
    const amount = tokens && parseTokenAmount(tokens[1]!);
    if (used && Number(used[1]) <= 100 && typeof amount === 'number' && Number.isFinite(amount))
      balances.push({
        id: 'muse-extra',
        label: '额外的使用额度',
        usedPercent: Number(used[1]),
        remainingTokens: amount,
        observedAt,
      });
  }
  return windows.length || balances.length
    ? { status: 'known', source: '网页用量页', observedAt, windows, ...(balances.length ? { balances } : {}) }
    : undefined;
}

/** An allowlist reconstruction, never a substring of arbitrary page text. */
export function redactedUsageSample(text: string): string {
  return Array.from(
    text.matchAll(
      /免费版|Free plan|每周限额|Weekly (?:limit|allowance)|额外的使用额度|额外使用额度|(?:extra|additional) usage(?: allowance| credits)?|从不过期|Never expires|No expiration|(?:已使用|used|usage)\s*[:：]?\s*\d+(?:\.\d+)?\s*%|\d+(?:\.\d+)?\s*%\s*used|(?:剩余|remaining)\s*[:：]?\s*[\d,.]+\s*(?:万|亿|[KMB]|thousand|million|billion)?\s*(?:个?词元|tokens?)|[\d,.]+\s*(?:[KMB]|thousand|million|billion)?\s*tokens?\s*(?:left|remaining)|\d{1,2}月\s*\d{1,2}日|\d{4}[-/]\d{1,2}[-/]\d{1,2}|(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}(?:,?\s+\d{4})?/gi,
    ),
    (match) => match[0].replace(/\s+/g, ' ').trim(),
  )
    .join(' · ')
    .slice(0, 240);
}

export function partialUsageSamples(
  blocks: string[],
  now: number,
  reset: (text: string, now: number) => string | null,
) {
  return blocks
    .filter((block) => {
      const quota = parseVisibleWebUsage(block, now, reset);
      return (
        (/每周限额|weekly (?:limit|allowance)/i.test(block) &&
          !quota?.windows.some((window) => window.id === 'muse-weekly')) ||
        (/额外的?使用额度|(?:extra|additional) usage/i.test(block) && !quota?.balances?.length)
      );
    })
    .map(redactedUsageSample)
    .filter(Boolean)
    .slice(0, 4);
}

/** Route metadata may not contain credentials, arbitrary queries or account identifiers. */
export function safeWebUsageRoute(value: string, origin?: string) {
  try {
    const url = new URL(value);
    const query = Array.from(url.searchParams);
    const safeQuery =
      query.length <= 3 &&
      query.every(
        ([key, item]) =>
          ['tab', 'view', 'page', 'section', 'panel', 'settings'].includes(key) &&
          ['usage', 'settings', 'general', 'billing'].includes(item),
      );
    return (
      (!origin || url.origin === origin) &&
      /^https?:$/.test(url.protocol) &&
      !url.username &&
      !url.password &&
      safeQuery &&
      !/auth|login|logout|oauth|delete|purchase|subscribe/i.test(url.pathname) &&
      /^\/(?:[a-z-]+\/)*[a-z-]*$/i.test(url.pathname) &&
      (!url.hash || /^#\/?(?:[a-z-]+\/)*[a-z-]*$/i.test(url.hash))
    );
  } catch {
    return false;
  }
}

export type UsageMetric =
  { path: string[]; value: number; date?: true } | { path: string[]; value: string; label: true };
export type UsageResponse = { method: string; origin: string; path: string; metrics: UsageMetric[] };

/** Retains quota numbers, dates and matching visible plan labels, never bodies, headers or unrelated strings. */
export function usageMetrics(json: unknown, visibleLabels: string[] = []): UsageMetric[] {
  const result: UsageMetric[] = [];
  const visit = (value: unknown, path: string[]) => {
    if (path.length > 12 || result.length >= 200) return;
    const key = path.join('.');
    if (
      typeof value === 'string' &&
      value.trim().length <= 80 &&
      visibleLabels.includes(value.trim()) &&
      /plan|tier|subscription|name|label/i.test(key)
    )
      result.push({ path, value: value.trim(), label: true });
    if (/reset|renew|refresh|expires?_?at/i.test(key)) {
      const timestamp =
        typeof value === 'number'
          ? value * (value < 1e11 ? 1000 : 1)
          : typeof value === 'string' && /^\d{4}-\d{2}-\d{2}[T ]/.test(value)
            ? Date.parse(value)
            : NaN;
      if (Number.isFinite(timestamp) && timestamp > 1e12 && timestamp < 1e14)
        result.push({ path, value: timestamp, date: true });
    } else if (
      typeof value === 'number' &&
      Number.isFinite(value) &&
      /used|usage|percent|utilization|remaining|balance|tokens?/i.test(key)
    )
      result.push({ path, value });
    if (value && typeof value === 'object')
      for (const [key, child] of Object.entries(value)) visit(child, [...path, key]);
  };
  visit(json, []);
  return result;
}

export function safeUsageRequest(response: Pick<UsageResponse, 'method' | 'origin' | 'path'>, origin: string) {
  // Only body-free GET readings can be replayed without retaining request payloads or credentials.
  try {
    const url = new URL(response.path, response.origin);
    return (
      response.method === 'GET' &&
      response.origin === origin &&
      url.origin === origin &&
      /^https?:$/.test(url.protocol) &&
      response.path.startsWith('/') &&
      !response.path.startsWith('//') &&
      !url.search &&
      !url.hash &&
      !url.username &&
      !url.password &&
      !/auth|login|logout|oauth|delete|remove|purchase|subscribe/i.test(url.pathname)
    );
  } catch {
    return false;
  }
}

function numericField(
  metrics: UsageMetric[],
  expected: number,
  kind: 'percent' | 'remaining',
): WebUsageField | undefined {
  const matches = metrics
    .filter((metric) => {
      const key = metric.path.at(-1) ?? '';
      return (
        typeof metric.value === 'number' &&
        !('date' in metric && metric.date) &&
        (kind === 'percent'
          ? !/remaining|left|available/i.test(key) &&
            (/percent|pct|ratio|fraction|utilization/i.test(key) || /^(?:used|usage)$/i.test(key))
          : /remaining|balance/i.test(key))
      );
    })
    .flatMap((metric) =>
      (kind === 'percent' ? [1, 100] : [1])
        .filter((scale) => typeof metric.value === 'number' && Math.abs(metric.value * scale - expected) < 1e-6)
        .map((scale) => ({ path: metric.path, scale })),
    );
  // Zero has the same value in ratio and percent forms; its field name must say which representation it uses.
  const unique = matches
    .filter((match) => expected !== 0 || match.scale === (/ratio|fraction/i.test(match.path.join('.')) ? 100 : 1))
    .map((match) =>
      expected === 0 && kind === 'percent' && !/ratio|fraction|percent|pct/i.test(match.path.at(-1)!)
        ? { ...match, zeroOnly: true as const }
        : match,
    );
  return unique.length === 1 ? unique[0] : undefined;
}
function commonParent(a: string[], b: string[]) {
  return a.slice(0, -1).join('.') === b.slice(0, -1).join('.');
}
export function learnUsageSignature(
  responses: UsageResponse[],
  quota: WebQuota,
  origin: string,
): WebUsageSignature | undefined {
  const matches = responses
    .filter((response) => safeUsageRequest(response, origin))
    .flatMap((response) => {
      const windows: WebUsageSignature['windows'] = [];
      const balances: WebUsageSignature['balances'] = [];
      for (const window of quota.windows) {
        if (window.usedPercent === null || (!window.resetsAt && !window.resetNotReported)) continue;
        const percent = numericField(response.metrics, window.usedPercent, 'percent');
        const resets = response.metrics.filter(
          (metric) =>
            'date' in metric &&
            metric.date &&
            Math.abs(metric.value - Date.parse(window.resetsAt!)) <= 12 * 3_600_000 &&
            percent &&
            commonParent(percent.path, metric.path),
        );
        if (percent && (resets.length === 1 || (window.id === 'grok-bot' && window.resetNotReported))) {
          const labels = response.metrics.filter(
            (metric) => 'label' in metric && metric.label && metric.value === window.label,
          );
          const local = labels.filter((metric) => commonParent(metric.path, percent.path));
          const matching = local.length ? local : labels;
          if (!window.resetsAt && matching.length !== 1) continue;
          windows.push({
            id: window.id,
            label: window.label,
            ...(matching.length === 1 ? { labelPath: matching[0]!.path } : {}),
            percent,
            ...(window.resetsAt ? { reset: { path: resets[0]!.path, scale: 1 } } : {}),
          });
        }
      }
      for (const balance of quota.balances ?? []) {
        const percent = numericField(response.metrics, balance.usedPercent, 'percent');
        const remaining = numericField(response.metrics, balance.remainingTokens, 'remaining');
        if (percent && remaining && commonParent(percent.path, remaining.path))
          balances.push({ id: balance.id, label: balance.label, percent, remaining });
      }
      return windows.length || balances.length
        ? [{ method: 'GET' as const, origin, path: response.path, windows, balances }]
        : [];
    });
  return matches.length === 1 ? matches[0] : undefined;
}

function readPath(json: unknown, field: WebUsageField): unknown {
  let value = json;
  for (const key of field.path) {
    if (
      !value ||
      typeof value !== 'object' ||
      !Object.hasOwn(value, key) ||
      ['__proto__', 'constructor', 'prototype'].includes(key)
    )
      return;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}
export function readLearnedUsage(json: unknown, signature: WebUsageSignature, now: number): WebQuota | undefined {
  const observedAt = new Date(now).toISOString();
  const windows: WebQuota['windows'] = [];
  const balances: NonNullable<WebQuota['balances']> = [];
  for (const window of signature.windows) {
    const label = window.labelPath ? readPath(json, { path: window.labelPath, scale: 1 }) : window.label;
    if (typeof label !== 'string' || !label.trim() || label.trim().length > 80) return;
    const percent = readPath(json, window.percent);
    const rawReset = window.reset ? readPath(json, window.reset) : undefined;
    const reset =
      typeof rawReset === 'number'
        ? rawReset * (rawReset < 1e11 ? 1000 : 1)
        : typeof rawReset === 'string' && /^\d{4}-\d{2}-\d{2}[T ]/.test(rawReset)
          ? Date.parse(rawReset)
          : NaN;
    if (
      typeof percent !== 'number' ||
      !Number.isFinite(percent) ||
      (window.percent.zeroOnly && percent !== 0) ||
      percent * window.percent.scale < 0 ||
      percent * window.percent.scale > 100 ||
      (window.reset && (!Number.isFinite(reset) || !Number.isFinite(new Date(reset).getTime())))
    )
      return;
    windows.push({
      id: window.id,
      label: label.trim(),
      usedPercent: percent * window.percent.scale,
      resetsAt: window.reset ? new Date(reset).toISOString() : null,
      ...(!window.reset ? { resetNotReported: true } : {}),
      observedAt,
      ...(window.id === 'muse-weekly' ? { durationMinutes: 10080 } : {}),
    });
  }
  for (const balance of signature.balances) {
    const percent = readPath(json, balance.percent),
      remaining = readPath(json, balance.remaining);
    if (
      typeof percent !== 'number' ||
      !Number.isFinite(percent) ||
      (balance.percent.zeroOnly && percent !== 0) ||
      percent * balance.percent.scale < 0 ||
      percent * balance.percent.scale > 100 ||
      typeof remaining !== 'number' ||
      !Number.isFinite(remaining) ||
      remaining < 0 ||
      !Number.isFinite(remaining * balance.remaining.scale)
    )
      return;
    balances.push({
      id: balance.id,
      label: balance.label,
      usedPercent: percent * balance.percent.scale,
      remainingTokens: remaining * balance.remaining.scale,
      observedAt,
    });
  }
  return { status: 'known', source: '网页自动刷新', observedAt, windows, ...(balances.length ? { balances } : {}) };
}

export function mergeWebUsage(previous: WebQuota | undefined, next: WebQuota): WebQuota {
  return {
    ...next,
    windows: [
      ...(previous?.windows ?? [])
        .filter((window) => !next.windows.some((item) => item.id === window.id))
        .map((window) => ({
          ...window,
          ...((window.observedAt ?? previous?.observedAt)
            ? { observedAt: window.observedAt ?? previous?.observedAt ?? undefined }
            : {}),
          stale: true,
        })),
      ...next.windows,
    ],
    balances: [
      ...(previous?.balances ?? [])
        .filter((balance) => !next.balances?.some((item) => item.id === balance.id))
        .map((balance) => ({ ...balance, stale: true })),
      ...(next.balances ?? []),
    ],
  };
}
