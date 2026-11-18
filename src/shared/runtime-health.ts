import type { RuntimeSnapshot } from './types.ts';

/** Shared lifetime for missed-check readings and their identity evidence. */
export const missedCheckReferenceMs = 6 * 3_600_000;

export function recentCursorIdentity(identity: RuntimeSnapshot['cursorVerifiedIdentity'], now: number): boolean {
  const observed = Date.parse(identity?.observedAt ?? '');
  return !!identity && Number.isFinite(observed) && observed <= now && now - observed < missedCheckReferenceMs;
}

export function cursorTimeoutReference(snapshot: RuntimeSnapshot, now: number): boolean {
  return (
    snapshot.provider === 'cursor' &&
    snapshot.status === 'error' &&
    snapshot.note === 'runtime-timeout' &&
    snapshot.availability?.reason !== 'authentication' &&
    !!snapshot.accountFingerprint &&
    snapshot.accountFingerprint === snapshot.cursorVerifiedIdentity?.fingerprint &&
    recentCursorIdentity(snapshot.cursorVerifiedIdentity, now) &&
    snapshot.lastKnownQuota?.status === 'known'
  );
}
