import type { QuotaWindow } from './types.ts';
export const quotaWindowLabel = (label: string) =>
  label
    .replace(/^Cursor Models$/i, 'Cursor 模型')
    .replace(/^Other Models$/i, '其他模型')
    .replace(/^(?:week|weekly)$/i, '每周额度')
    .replace(/^(?:day|daily)$/i, '每日额度')
    .replace(/^(\d+(?:\.\d+)?) hours?$/i, (_match, hours: string) => `${hours} 小时额度`);
/** The window duration is not the time left before reset. */
export function quotaPeriodLabel(window: QuotaWindow): string {
  window = {
    ...window,
    label: quotaWindowLabel(window.label),
  };
  const duration = window.durationMinutes;
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0)
    return window.label.replace(/ · (primary|secondary)$/, ' · 周期未报告');
  const period =
    duration === 10080
      ? '每周额度（7 天）'
      : duration === 1440
        ? '每日额度（24 小时）'
        : duration % 1440 === 0
          ? `${duration / 1440} 天额度`
          : duration % 60 === 0
            ? `${duration / 60} 小时额度`
            : `${duration} 分钟额度`;
  // Preserve provider/model-specific buckets; replace only the legacy numeric suffix.
  if (/ · (\d+(?:\.\d+)? min|primary|secondary)$/.test(window.label)) {
    const bucket = window.label.replace(/ · .*$/, '');
    return bucket.toLowerCase() === 'codex' ? period : `${bucket} · ${period}`;
  }
  return window.label;
}
