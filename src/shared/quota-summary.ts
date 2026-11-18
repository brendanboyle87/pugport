import { isNativeCli } from './provider-registry.ts';
import type { Provider, QuotaWindow, RuntimeSnapshot, RuntimeTarget } from './types.ts';
import {
  activeWebCooldown,
  webQuotaLabel,
  webResetLabel,
  webPlanLabel,
  webQuotaStale,
  type ExternalAgentView,
  type WebTokenBalance,
} from './external-agents.ts';

export type QuotaLine = {
  id: string;
  label: string;
  provider: Provider | 'web';
  windows: { name: string; remaining?: number; resetsAt?: string }[];
  plan?: string;
  status?: string;
  /** Lowest known share in the account overview; Claude's separate family caps stay in windows. */
  tightest?: number;
  observedAt: string | null;
  /** The latest check failed; this is the last good reading, shown with its time and dimmed in totals. */
  reference?: true;
  /** No provider quota response has arrived yet. */
  pending?: true;
  /** What the bars under the line show: one per separate pool (Cursor's), else one bar (see `quotaBars`). */
  bars?: (number | undefined)[];
  detail?: string;
  balances?: WebTokenBalance[];
};
export type QuotaTotal = {
  provider: Provider;
  accounts: number;
  known: number;
  total: number;
  /** Includes a last good reading because the latest check did not finish; shown dimmed. */
  stale?: true;
};

/** Claude's account overview follows shared limits; separate family caps stay in the per-window display. */
export function quotaOverviewWindows(runtime: Pick<RuntimeSnapshot, 'provider' | 'quota'>): QuotaWindow[] {
  const windows = runtime.quota.windows;
  if (runtime.provider === 'claude' && windows.some((window) => window.modelFamily)) {
    const shared = windows.filter((window) => !window.modelFamily);
    if (shared.length) return shared;
  }
  return windows;
}

/** Explicit @@ agents have their own lines, never router targets or platform totals. */
export function webQuotaLines(agents: ExternalAgentView[], now = Date.now()): QuotaLine[] {
  return agents
    .filter(
      (agent) =>
        agent.added !== false &&
        ((agent.kind === 'web' && agent.enabled) || (agent.kind === 'handoff' && agent.usageEnabled)),
    )
    .flatMap((agent) => {
      const cooldown = activeWebCooldown(agent.cooldown, now);
      const quota = agent.quota;
      const windows = quota?.status === 'known' ? quota.windows : [];
      const plan = webPlanLabel(quota);
      if (!cooldown && !windows.some((window) => window.usedPercent !== null) && !quota?.balances?.length) return [];
      const left = cooldown
        ? 0
        : windows.length
          ? Math.min(...windows.map((window) => remaining(window) ?? 100))
          : undefined;
      return [
        {
          id: agent.id,
          label: agent.name,
          provider: 'web' as const,
          status: 'ready',
          ...(plan ? { plan } : {}),
          windows: cooldown
            ? [{ name: '额度', remaining: 0 }]
            : windows.map((window) => ({
                name: window.label,
                remaining: remaining(window),
                ...(typeof window.resetsAt === 'string' ? { resetsAt: window.resetsAt } : {}),
              })),
          ...(left !== undefined ? { tightest: left } : {}),
          observedAt: cooldown?.observedAt ?? quota?.observedAt ?? null,
          bars: windows.length || cooldown ? [left] : [],
          detail: cooldown
            ? webQuotaLabel(agent, now)
            : windows.length
              ? windows[0]?.resetNotReported
                ? undefined
                : webResetLabel(windows[0]?.resetsAt, now)
              : undefined,
          ...(quota?.balances?.length ? { balances: quota.balances } : {}),
          ...(webQuotaStale(quota, now) ? { reference: true as const } : {}),
        },
      ];
    });
}

/** "5h", "周", "日": the shortest name for a quota window. */
export function windowName(window: QuotaWindow): string {
  const minutes = window.durationMinutes;
  const period =
    minutes === 10080
      ? '周'
      : minutes === 1440
        ? '日'
        : typeof minutes === 'number' && minutes > 0 && minutes % 60 === 0
          ? `${minutes / 60}h`
          : undefined;
  const bucket = window.modelPool
    ? window.label
    : window.label.includes(' · ') && !/^codex · /i.test(window.label)
      ? window.label.split(' · ')[0]
      : window.modelFamily
        ? window.modelFamily[0]!.toUpperCase() + window.modelFamily.slice(1)
        : undefined;
  if (bucket) return period ? `${bucket} ${period}` : bucket;
  return period ?? window.label.replace(/ · (primary|secondary)$/, '').slice(0, 6);
}

const remaining = (window: QuotaWindow) =>
  typeof window.usedPercent === 'number' ? Math.max(0, Math.round(100 - window.usedPercent)) : undefined;

export function quotaReadingPending(runtime: RuntimeSnapshot): boolean {
  return (
    isNativeCli(runtime.provider) &&
    runtime.authMode !== 'apiKey' &&
    (runtime.status === 'ready' || runtime.status === 'refreshing') &&
    runtime.quota.status === 'unknown' &&
    !runtime.quota.note?.trim() &&
    !runtime.quota.observedAt &&
    !runtime.quota.windows.length &&
    runtime.lastKnownQuota?.status !== 'known'
  );
}

/** Below this share left, the 5-hour window takes over the bar from the weekly one. */
export const shortWindowLow = 15;

/**
 * Separate pools (Cursor's) each have their own balance, so each gets a bar. Otherwise one bar: the weekly
 * window, or the 5-hour one once less than 15% of it is left; without either, the tightest share. Every window
 * is still named with its share above the bar.
 */
export function quotaBarWindows(windows: QuotaWindow[], tightest: number | undefined): (QuotaWindow | undefined)[] {
  const pools = windows.filter((window) => window.modelPool);
  if (pools.length > 1) return pools;
  const shared = windows.filter((window) => !window.modelFamily && !window.modelPool);
  const short = shared.find((window) => window.durationMinutes === 300);
  const weekly = shared.find((window) => window.durationMinutes === 10080);
  if (short && (remaining(short) ?? 100) < shortWindowLow) return [short];
  if (weekly) return [weekly];
  return [windows.find((window) => remaining(window) === tightest)];
}

export function quotaBars(windows: QuotaWindow[], tightest: number | undefined): (number | undefined)[] {
  return quotaBarWindows(windows, tightest).map((window) => (window ? remaining(window) : tightest));
}

/** One line per enabled native CLI account, from the CLIs' own reports; nothing is estimated. */
export function quotaLines(runtimes: RuntimeSnapshot[], targets: RuntimeTarget[]): QuotaLine[] {
  return runtimes
    .filter(
      (runtime) =>
        isNativeCli(runtime.provider) &&
        runtime.status !== 'missing' &&
        targets.some((target) => target.id === runtime.id && target.enabled),
    )
    .map((runtime) => {
      const reference = runtime.quota.status !== 'known' && runtime.lastKnownQuota?.status === 'known';
      const quota = reference ? runtime.lastKnownQuota! : runtime.quota;
      const windows = quota.windows.map((window) => ({
        name: windowName(window),
        ...(typeof window.resetsAt === 'string' ? { resetsAt: window.resetsAt } : {}),
        remaining: remaining(window),
      }));
      const known = quotaOverviewWindows({ provider: runtime.provider, quota })
        .map(remaining)
        .filter((value): value is number => value !== undefined);
      const tightest = known.length ? Math.min(...known) : undefined;
      return {
        id: runtime.id,
        label: runtime.label,
        provider: runtime.provider,
        status: runtime.status,
        ...(quotaPlan(runtime)?.label ? { plan: quotaPlan(runtime)!.label } : {}),
        windows,
        ...(tightest !== undefined ? { tightest } : {}),
        observedAt: quota.observedAt,
        ...(reference ? { reference: true as const } : {}),
        ...(quotaReadingPending(runtime) ? { pending: true as const } : {}),
        bars: quotaBars(quota.windows, tightest),
      };
    });
}

/**
 * Per platform, each account's binding (tightest) share added up: 1.0 means one full account's worth left.
 * Windows of different lengths are not comparable, so this is a headroom sum, not a token count.
 */
export function quotaTotals(lines: QuotaLine[]): QuotaTotal[] {
  const totals = new Map<Provider, QuotaTotal>();
  for (const line of lines) {
    if (line.provider === 'web') continue;
    const entry = totals.get(line.provider) ?? { provider: line.provider, accounts: 0, known: 0, total: 0 };
    entry.accounts++;
    if (line.tightest !== undefined) {
      entry.known++;
      entry.total += line.tightest / 100;
      if (line.reference) entry.stale = true;
    }
    totals.set(line.provider, entry);
  }
  return [...totals.values()].map((entry) => ({ ...entry, total: Math.round(entry.total * 100) / 100 }));
}

/** "刚刚", "3 分钟前", or a clock time for older readings. */
export function observedLabel(at: string | null | undefined, now = Date.now()): string {
  if (!at) return '未刷新';
  const minutes = Math.floor((now - Date.parse(at)) / 60_000);
  if (!Number.isFinite(minutes)) return '未刷新';
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export function quotaPlan(runtime?: RuntimeSnapshot) {
  return (
    runtime?.subscription ??
    runtime?.quota?.subscription ??
    (runtime?.quota?.status !== 'known' ? runtime?.lastKnownQuota?.subscription : undefined)
  );
}
