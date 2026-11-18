import type { RunEvent, RunRecord } from './types.ts';

export const retainedRunEventLimit = 1000;

/** Merge numbered observations; keep legacy events from one complete snapshot because they have no stable IDs. */
export function mergeRunEventSnapshots(...snapshots: readonly RunEvent[][]): RunEvent[] {
  const numbered = new Map<number, RunEvent>();
  let legacy: RunEvent[] = [];
  for (const snapshot of snapshots) {
    const unnumbered = snapshot.filter((event) => event.seq === undefined);
    if (unnumbered.length > legacy.length) legacy = unnumbered;
    for (const event of snapshot) if (event.seq !== undefined) numbered.set(event.seq, event);
  }
  return [...legacy, ...[...numbered.values()].sort((a, b) => a.seq! - b.seq!)];
}

/** Retain host events, or replay sequenced SSE events without adding the same event twice. */
export function retainRunEvent(run: Pick<RunRecord, 'events' | 'eventsDropped'>, event: RunEvent): RunEvent {
  if (event.type === 'reasoning' || event.data?.messageUsage) return event;
  const latest = run.events.reduce((maximum, item) => Math.max(maximum, item.seq ?? 0), 0);
  if (event.seq !== undefined && event.seq <= latest) return event;
  const retained =
    event.seq === undefined
      ? { ...event, seq: Math.max(latest, run.events.length + (run.eventsDropped ?? 0)) + 1 }
      : event;
  run.events.push(retained);
  if (run.events.length > retainedRunEventLimit) {
    const dropped = run.events.length - retainedRunEventLimit;
    for (let index = 0; index < dropped; index++) {
      // Answer text already lives in run.output. Preserve lifecycle evidence when deltas fill the ledger.
      // Always retain the newest event so its sequence remains the replay high-water mark after reload.
      const oldestText = run.events.findIndex(
        (item, position) => position < run.events.length - 1 && item.type === 'text',
      );
      run.events.splice(oldestText >= 0 ? oldestText : 0, 1);
    }
    // An old capped record may already have lost events without a count; keep that history unknown.
    if (run.eventsDropped !== undefined) run.eventsDropped += dropped;
  }
  return retained;
}
