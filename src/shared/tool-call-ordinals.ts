import type { RunEvent } from './types.ts';

/** One-based ordinals for distinct calls, in first-appearance order across all tool events. */
export function toolCallOrdinals(events: RunEvent[]): Map<string, number> {
  const ordinals = new Map<string, number>();
  for (const event of events) {
    if (event.type !== 'tool') continue;
    const id = event.data?.toolCallId ?? event.data?.itemId;
    if (typeof id === 'string' && id && !ordinals.has(id)) ordinals.set(id, ordinals.size + 1);
  }
  return ordinals;
}
