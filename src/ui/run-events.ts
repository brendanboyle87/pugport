import type { AppState, RunEvent, RunRecord } from '../shared/types';
import { retainRunEvent } from '../shared/run-events';
import { readEffectiveModel } from '../shared/execution-model';
import { steeringProgressFromEvent } from '../shared/steering-progress';

export type RunUpdate = { runId: string; event: RunEvent; context?: RunRecord['context'] };

export function applyRunUpdate(previous: AppState, { runId, event, context }: RunUpdate): AppState {
  let changed = false;
  const runs = previous.runs.map((run) => {
    if (run.id !== runId || (event.seq !== undefined && run.events.some((item) => (item.seq ?? 0) >= event.seq!)))
      return run;
    changed = true;
    const retained = { events: [...run.events], eventsDropped: run.eventsDropped };
    retainRunEvent(retained, event);
    const sessionId =
      event.type === 'session'
        ? (event.data?.nativeSessionId ?? event.data?.threadId ?? event.data?.sessionId)
        : undefined;
    const effectiveModel = event.type === 'session' ? readEffectiveModel(event.data?.effectiveModel) : undefined;
    return {
      ...run,
      ...(context ? { context } : {}),
      steeringProgress: steeringProgressFromEvent(run.steeringProgress, event),
      events: retained.events,
      eventsDropped: retained.eventsDropped,
      output: event.type === 'text' ? (run.output + (event.text ?? '')).slice(-1_000_000) : run.output,
      ...(event.type === 'reasoning'
        ? { reasoning: ((run.reasoning ?? '') + (event.text ?? '')).slice(-200_000) }
        : {}),
      ...(typeof sessionId === 'string' ? { nativeSessionId: sessionId } : {}),
      ...(effectiveModel ? { effectiveModel } : {}),
    };
  });
  return changed ? { ...previous, runs } : previous;
}
