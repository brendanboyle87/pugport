/**
 * Launch arguments are edited either one per line (friendly) or as a JSON string array (exact).
 * Line mode trims and drops blank lines, so it is only offered when that round-trips losslessly.
 */
export type LaunchArgsMode = 'lines' | 'json';

/** True when `args` survive a join('\n') → split → trim → drop-empty round trip unchanged. */
export function linesAreLossless(args: string[]): boolean {
  return args.every((arg) => arg !== '' && !/[\r\n]/.test(arg) && arg.trim() === arg);
}

export function defaultLaunchArgsMode(args: string[]): LaunchArgsMode {
  return linesAreLossless(args) ? 'lines' : 'json';
}

export function formatLaunchArgs(args: string[], mode: LaunchArgsMode): string {
  return mode === 'lines' ? args.join('\n') : JSON.stringify(args);
}

export function parseLaunchArgs(text: string, mode: LaunchArgsMode): string[] {
  if (mode === 'lines')
    return text
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim() || '[]');
  } catch {
    parsed = undefined;
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string'))
    throw new Error('启动参数必须是 JSON 字符串数组，例如 ["--verbose"]。');
  return parsed as string[];
}
