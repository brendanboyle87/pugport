import { observedLabel, type QuotaLine, type QuotaTotal } from '../shared/quota-summary.ts';
import { truncateToWidth, visibleWidth } from './pi-tui.ts';
import type { Theme } from './theme.ts';

/** The tray's view (`GET /api/tray`): each account's remaining quota and the per-platform totals. */
export type QuotaView = { lines: QuotaLine[]; totals: QuotaTotal[]; running?: number };

const providerNames: Record<string, string> = {
  codex: 'Codex',
  claude: 'Claude',
  grok: 'Grok',
  cursor: 'Cursor',
  gemini: 'Gemini',
  pi: 'API',
};
export const providerName = (provider: string) => providerNames[provider] ?? provider;

/**
 * "Codex 140% · Claude 80%": per platform, each account's tightest window added up, as in the tray (one full
 * account is 100%).
 */
export function totalsSummary(totals: readonly QuotaTotal[], theme?: Theme): string {
  return totals
    .map((total) => {
      const value = total.known ? `${Math.round(total.total * 100)}%` : '—';
      const shown = theme ? theme.tone(total.known ? Math.min(100, total.total * 100) : undefined, value) : value;
      return `${providerName(total.provider)} ${shown}`;
    })
    .join(theme ? theme.fg('dim', ' · ') : ' · ');
}

/** `pugport status`: the same information as the tray popup, one account per line. */
export function quotaReport(view: QuotaView, theme: Theme, now = Date.now()): string {
  if (!view.lines.length) return '还没有可用的订阅账号。在 PugPort 的「执行器」页面添加账号后再看。';
  const labels = view.lines.map((line) => truncateToWidth(line.label, 28));
  const width = Math.max(...labels.map((label) => visibleWidth(label)));
  const rows = view.lines.map((line, index) => {
    const windows = line.windows.length
      ? line.windows
          .map((window) =>
            theme.tone(
              window.remaining,
              `${window.name} ${window.remaining === undefined ? '—' : `${window.remaining}%`}`,
            ),
          )
          .join(theme.fg('dim', ' · '))
      : theme.fg('dim', '额度未知');
    const label = labels[index]!;
    return `  ${label}${' '.repeat(width - visibleWidth(label))}  ${windows}  ${theme.fg('dim', observedLabel(line.observedAt, now))}`;
  });
  const header = [
    `${theme.bold('剩余额度')}  ${totalsSummary(view.totals, theme)}`,
    ...(view.running ? [theme.fg('accent', `${view.running} 个任务正在运行`)] : []),
  ];
  return [...header, ...rows].join('\n');
}
