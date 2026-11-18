import type { QuotaWindow, RuntimeSnapshot, Settings } from './types.ts';

export function isShortQuotaWindow(window: QuotaWindow): boolean {
  if (window.modelPool || window.modelFamily) return false;
  const minutes = window.durationMinutes;
  if (typeof minutes === 'number' && Number.isFinite(minutes) && minutes > 0) return minutes <= 6 * 60;
  return window.id === 'five_hour';
}

/**
 * Fresh session windows have no blanket reserve; routing redirects long tasks at 5% remaining.
 * All non-short windows retain reset-based relaxation, while callers still enforce exhaustion, refresh and
 * in-flight buffers.
 */
export function quotaWindowReservePercent(
  window: QuotaWindow,
  quota: Pick<RuntimeSnapshot['quota'], 'status' | 'observedAt'>,
  settings: Pick<Settings, 'reservePercent' | 'maxQuotaAgeSeconds'>,
  now: number,
): number {
  const reserve = settings.reservePercent;
  const observed = Date.parse(window.observedAt ?? quota.observedAt ?? '');
  const reset = Date.parse(window.resetsAt ?? '');
  if (
    quota.status !== 'known' ||
    !Number.isFinite(now) ||
    !Number.isFinite(observed) ||
    observed > now ||
    !(now - observed < settings.maxQuotaAgeSeconds * 1000) ||
    !Number.isFinite(reset) ||
    reset <= now ||
    window.usedPercent === null ||
    !Number.isFinite(window.usedPercent) ||
    window.usedPercent < 0 ||
    window.usedPercent > 100
  )
    return reserve;
  if (isShortQuotaWindow(window)) return 0;
  const hoursLeft = (reset - now) / 3_600_000;
  if (hoursLeft <= 6) return 0;
  if (hoursLeft <= 24) return Math.min(reserve, 2);
  return reserve;
}
