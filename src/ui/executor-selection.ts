import { executionModel } from '../shared/execution-model';
import type { RunRecord } from '../shared/types';

export type ExecutorSelectionResult = {
  state: 'unchanged' | 'applied' | 'finishing-current' | 'switching' | 'continued';
  runtimeLabel?: string;
  workflowId?: string;
  requestedAt?: string;
};

/** Requested effort must not read as confirmed native execution metadata. */
export function executionSelectionLabel(run: Pick<RunRecord, 'route' | 'effectiveModel'>) {
  const selection = executionModel(run);
  const effort = run.effectiveModel?.effort ? selection.effort : run.route.effort ? `请求强度 ${run.route.effort}` : '';
  return [selection.model, effort].filter(Boolean).join(' · ');
}

export function executorSelectionStatus(result: ExecutorSelectionResult, fallback = '自动调度') {
  const label = result.runtimeLabel || fallback;
  if (result.state === 'finishing-current') return '后续任务已设为自动调度，当前任务继续完成';
  if (result.state === 'switching') return `切换中 · ${label}`;
  if (result.state === 'unchanged') return `当前选择 · ${label}`;
  return `已切换到 ${label}`;
}
