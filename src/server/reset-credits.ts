import { createHash } from 'node:crypto';
import type { ResetCredits } from '../shared/types.ts';
const object = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const timestamp = (v: unknown): string | null => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
  const date = new Date(v * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};
export const resetCreditKey = (id: string): string => createHash('sha256').update(id).digest('hex');
/** Read-only projection of account/rateLimits/read. Never retain redemption IDs. */
export function codexResetCredits(value: unknown, observedAt = new Date().toISOString()): ResetCredits | undefined {
  const raw = object(object(value).rateLimitResetCredits);
  if (!Object.keys(raw).length) return undefined;
  const count = raw.availableCount;
  return {
    availableCount: typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 ? count : null,
    details: Array.isArray(raw.credits)
      ? raw.credits.map((value) => {
          const row = object(value);
          return {
            ...(typeof row.id === 'string' && row.id ? { key: resetCreditKey(row.id) } : {}),
            kind: row.resetType === 'codexRateLimits' ? 'full' : 'unknown',
            status: ['available', 'consumed', 'expired'].includes(String(row.status))
              ? (row.status as 'available' | 'consumed' | 'expired')
              : 'unknown',
            grantedAt: timestamp(row.grantedAt),
            expiresAt: timestamp(row.expiresAt),
          };
        })
      : null,
    source: 'Codex CLI account/rateLimits/read',
    observedAt,
  };
}
