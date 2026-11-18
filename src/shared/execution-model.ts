import type { EffectiveModelSelection, Provider, RunRecord } from './types';
import { parseCursorModel } from './model-family';

/** Validate adapter metadata before keeping it in a run or displaying it. */
export function readEffectiveModel(value: unknown): EffectiveModelSelection | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const row = value as Record<string, unknown>;
  if (typeof row.model !== 'string' || !row.model.trim() || row.model.length > 300) return undefined;
  if (typeof row.source !== 'string' || !row.source.trim() || row.source.length > 100) return undefined;
  const parameters =
    row.parameters && typeof row.parameters === 'object'
      ? (Object.fromEntries(
          Object.entries(row.parameters).filter(
            ([key, entry]) => key.length <= 100 && typeof entry === 'string' && entry.length <= 100,
          ),
        ) as Record<string, string>)
      : undefined;
  return {
    model: row.model,
    ...(typeof row.effort === 'string' && row.effort.length <= 30 ? { effort: row.effort } : {}),
    ...(parameters ? { parameters } : {}),
    source: row.source,
  };
}

export function executionModel(run: Pick<RunRecord, 'route' | 'effectiveModel'>) {
  return run.effectiveModel ?? run.route;
}

/** Turn confirmed Cursor flags into a replayable selection; keep the display metadata canonical. */
export function replayModelSelection(
  provider: Provider | undefined,
  selection: Pick<EffectiveModelSelection, 'model' | 'effort' | 'parameters'>,
): { model: string; effort?: string } {
  if (provider !== 'cursor' || !selection.parameters) return { model: selection.model, effort: selection.effort };
  const variant = parseCursorModel(selection.model);
  const effort = selection.effort === 'extra-high' ? 'xhigh' : (selection.effort ?? variant.effort);
  const flag = (name: 'thinking' | 'fast') =>
    selection.parameters?.[name] === undefined ? variant[name] : selection.parameters[name] === 'true';
  if (selection.parameters.thinking === undefined && selection.model === variant.family && !flag('fast'))
    return { model: selection.model, ...(effort ? { effort } : {}) };
  return {
    // An effort-bearing slug without -thinking explicitly restores thinking=false in the native adapter.
    model: `${variant.family}${flag('thinking') ? '-thinking' : ''}${effort ? `-${effort}` : ''}${flag('fast') ? '-fast' : ''}`,
    ...(effort ? { effort } : {}),
  };
}
