import type { QuotaWindow, RuntimeSnapshot } from '../shared/types.ts';

type Quota = RuntimeSnapshot['quota'];

/** account/rateLimits/updated is sparse; a missing/null field never clears a full read. */
export function mergeCodexQuotaUpdate(previous: Quota, update: Quota): Quota {
  const windows = new Map<string, QuotaWindow>(
    previous.windows.map((window) => [
      window.id,
      { ...window, observedAt: window.observedAt ?? previous.observedAt ?? undefined },
    ]),
  );
  for (const incoming of update.windows) {
    const old = windows.get(incoming.id);
    if (!old) {
      windows.set(incoming.id, { ...incoming, observedAt: incoming.observedAt ?? update.observedAt ?? undefined });
      continue;
    }
    const merged: QuotaWindow = {
      ...old,
      ...incoming,
      usedPercent: incoming.usedPercent ?? old.usedPercent,
      resetsAt: incoming.resetsAt ?? old.resetsAt,
      durationMinutes: incoming.durationMinutes ?? old.durationMinutes,
      observedAt:
        incoming.usedPercent !== null
          ? (incoming.observedAt ?? update.observedAt ?? undefined)
          : (old.observedAt ?? previous.observedAt ?? undefined),
    };
    if (incoming.usedPercent === null && incoming.resetsAt && old.resetsAt && incoming.resetsAt !== old.resetsAt)
      merged.usedPercent = null; // A newly reported cycle cannot borrow the previous cycle's percentage.
    // The parser must synthesize a label when a rolling update omits bucket metadata.
    // Keep a useful existing name instead of replacing it with an id/slot placeholder.
    const slot = incoming.id.endsWith(':primary') ? 'primary' : 'secondary';
    const bucket = incoming.id.slice(0, -(slot.length + 1));
    if (incoming.label === `${bucket} · ${slot}` || incoming.label.startsWith(`${bucket} · `)) {
      const separator = old.label.lastIndexOf(' · ');
      merged.label =
        incoming.durationMinutes != null && incoming.durationMinutes !== old.durationMinutes && separator >= 0
          ? `${old.label.slice(0, separator)} · ${incoming.durationMinutes} min`
          : old.label;
    }
    windows.set(incoming.id, merged);
  }
  const metadata = Object.fromEntries(Object.entries(update).filter(([, value]) => value != null));
  return {
    ...previous,
    ...metadata,
    status:
      [...windows.values()].some((window) => window.usedPercent !== null) || update.unlimited ? 'known' : 'unknown',
    windows: [...windows.values()],
    ...(update.resetCredits
      ? {
          // Null-only metadata is not a new observation. A partial real observation
          // keeps its unknown field unknown rather than giving old card data a new timestamp.
          resetCredits:
            update.resetCredits.availableCount !== null || update.resetCredits.details !== null
              ? { ...update.resetCredits }
              : previous.resetCredits,
        }
      : {}),
  };
}
