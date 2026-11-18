import type { RunEvent, SteeringProgress } from './types.ts';

/** Apply only native delivery receipts; streamed prose alone does not prove a correction was used. */
export function steeringProgressFromEvent(
  previous: SteeringProgress | undefined,
  event: RunEvent,
): SteeringProgress | undefined {
  if (event.type !== 'status') return previous;
  const phase = event.data?.steeringPhase;
  const id = event.data?.steeringId;
  if (typeof id !== 'string' || !id || id.length > 200 || !Number.isFinite(Date.parse(event.at))) return previous;
  if (previous && Date.parse(event.at) < Date.parse(previous.at)) return previous;
  if (phase === 'sending') {
    const mode = event.data?.steeringMode;
    if ((mode !== 'interrupt' && mode !== 'append') || previous?.id === id) return previous;
    return { id, phase, at: event.at, mode };
  }
  // A late acknowledgment from a previous message cannot change the current message's progress.
  if (!previous || id !== previous.id || previous.phase === 'failed') return previous;
  if (phase === 'received' && (previous.phase === 'sending' || previous.phase === 'received')) {
    const reportedMode = event.data?.steeringMode;
    const mode = reportedMode === 'interrupt' || reportedMode === 'append' ? reportedMode : previous.mode;
    // A native receipt can report that a requested interruption was delivered only as appended input.
    return { ...previous, phase, mode, at: event.at };
  }
  if (phase === 'resuming' && (previous.phase === 'sending' || previous.phase === 'received'))
    return { ...previous, phase, at: event.at };
  if (phase === 'failed') return { ...previous, phase, at: event.at };
  return previous;
}
