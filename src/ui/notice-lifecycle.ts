import type { AppState } from '../shared/types';

export const apiRuntimeBusy = (runs: AppState['runs'], runtimeId: string) =>
  runs.some(
    (run) => run.route.runtimeId === runtimeId && (run.status === 'running' || run.status === 'waiting-approval'),
  );

export const noticeResolved = (notice: { resolveWhenApiIdle?: string }, state?: Pick<AppState, 'runs'> | null) =>
  Boolean(state && notice.resolveWhenApiIdle && !apiRuntimeBusy(state.runs, notice.resolveWhenApiIdle));
