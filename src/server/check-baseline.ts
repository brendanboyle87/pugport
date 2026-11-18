import { normalizedCommand } from './command-check.ts';
import type { RunRecord } from '../shared/types.ts';

/** Baselines are collected only for an already approved, explicit read-only format check. */
export function baselineCheckCommand(command: string): boolean {
  return (
    /^(?:npm|pnpm|yarn)(?:\.cmd)? (?:run )?format:check$/.test(command.trim()) ||
    /^(?:\.runtime[\\/]node(?:\.exe)?|node(?:\.exe)?) node_modules[\\/]prettier[\\/]bin[\\/]prettier\.cjs --check \.$/.test(
      command.trim(),
    )
  );
}

/** An explicit footer is required: partial, truncated and error output cannot waive a failure. */
export function failingCheckFiles(output: string): string[] | undefined {
  const lines = output
    .replace(/\u001b\[[0-9;]*m/g, '')
    .trim()
    .split(/\r?\n/);
  if (
    !/^\[warn\] Code style issues found in (?:\d+ files?|the above files?)\. Run Prettier with --write to fix\.$/.test(
      lines.at(-1) ?? '',
    )
  )
    return;
  if (!lines.includes('Checking formatting...') || lines.some((line) => line.startsWith('[error]'))) return;
  const files = lines.slice(lines.indexOf('Checking formatting...') + 1, -1);
  if (!files.length || files.some((line) => !/^\[warn\] .+\.[a-z0-9]+$/i.test(line))) return;
  const count = lines.at(-1)!.match(/found in (\d+) files?/);
  if (count && Number(count[1]) !== files.length) return;
  return [...new Set(files.map((line) => line.slice(7).replace(/\\/g, '/')))].sort();
}

export function preexistingCheckFailure(
  baselines: RunRecord['checkBaselines'],
  command: string,
  output: string,
): boolean {
  const baseline = baselines?.find((item) => normalizedCommand(item.command) === normalizedCommand(command));
  const files = baseline && failingCheckFiles(output);
  return !!files?.length && files.every((file) => baseline!.files.includes(file));
}
