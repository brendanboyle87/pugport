export const effortLevels = ['off', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'extra-high', 'max', 'ultra'];

const names: Record<string, string> = {
  none: '关闭思考',
  off: '关闭思考',
  minimal: '极低',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '很高',
  'extra-high': '很高',
  max: '最高',
  ultra: '极限',
};
export const effortName = (effort: string): string => names[effort] ?? effort;

const rank = (effort: string) =>
  ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].indexOf(
    effort === 'none' ? 'off' : effort === 'extra-high' ? 'xhigh' : effort,
  );

export function orderedEfforts(levels: string[]): string[] {
  return [...new Set(levels)].sort((a, b) => rank(a) - rank(b));
}

/** Explicit choices may include off; equal distances prefer the lower supported level. */
export function nearestEffort(levels: string[], requested: string): string | undefined {
  if (levels.includes(requested)) return requested;
  return orderedEfforts(levels.filter((level) => effortLevels.includes(level))).sort(
    (a, b) => Math.abs(rank(a) - rank(requested)) - Math.abs(rank(b) - rank(requested)),
  )[0];
}
