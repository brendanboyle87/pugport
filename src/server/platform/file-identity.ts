import type { BigIntStats } from 'node:fs';

/** Never derive file identity from number stats: NTFS file IDs can exceed 2^53. */
export function fileIdentity(info: Pick<BigIntStats, 'dev' | 'ino'>) {
  return { dev: info.dev, ino: info.ino };
}

/** Preserve legacy numeric comparisons; new string stamps retain every file-ID bit. */
export function sameIno(a: unknown, b: unknown): boolean {
  const valid = (value: unknown): value is string | number =>
    typeof value === 'number'
      ? Number.isFinite(value) && Number.isInteger(value) && value >= 0
      : typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value);
  if (!valid(a) || !valid(b)) return false;
  return typeof a === 'number' || typeof b === 'number' ? Number(a) === Number(b) : a === b;
}
