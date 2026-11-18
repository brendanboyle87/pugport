import { executorCards, validateAutomaticExecutors } from '../shared/automatic-executors.ts';
import { providerNames } from '../shared/delegation.ts';
import type { Provider, RuntimeTarget } from '../shared/types.ts';
import { normalizeAgentName, resolveAgent } from './agent-names.ts';

/** Resolve names before creating a task. A task allow list overrides inherited checklists; exclude subtracts. */
export function taskExecutors(
  input: { executors?: string[]; exclude?: string[] },
  targets: RuntimeTarget[],
  inherited?: string[],
  explicitPin = false,
): string[] | undefined {
  if (input.executors === undefined && input.exclude === undefined) return;
  const cards = executorCards(targets);
  const resolve = (names: string[]) =>
    names.flatMap((name) => {
      const normalized = normalizeAgentName(name);
      const provider = (Object.keys(providerNames) as Provider[]).find(
        (key) => normalizeAgentName(key) === normalized || normalizeAgentName(providerNames[key]) === normalized,
      );
      if (provider && cards.some((card) => card.provider === provider))
        return cards.filter((card) => card.provider === provider).map((card) => card.id);
      const matches = cards.filter((card) => normalizeAgentName(card.label) === normalized || card.id === name);
      if (matches.length === 1) return [matches[0]!.id];
      // Keep existing disabled/ambiguous-name diagnostics, but never accept a fuzzy match for a checklist.
      resolveAgent(name, targets);
      throw new Error(`未知执行器：${name}`);
    });
  const allowed =
    input.executors === undefined ? (inherited ?? cards.map((card) => card.id)) : resolve(input.executors);
  const excluded = new Set(resolve(input.exclude ?? []));
  const ids = [...new Set(allowed)].filter((id) => !excluded.has(id));
  validateAutomaticExecutors(ids, targets, explicitPin);
  return ids;
}
