import { categoryLabel } from '../shared/conversation-routing.ts';
import { automaticExecutorAllowed } from '../shared/automatic-executors.ts';
import type { RoutingRule, RoutingRuleSet, RunInput, RuntimeSnapshot, Settings } from '../shared/types.ts';

/** Scope replacement, including cleared rules. */
export function effectiveRules(global?: RoutingRuleSet, conversation?: RoutingRuleSet): RoutingRule[] {
  const rules = new Map((global?.rules ?? []).map((rule) => [rule.category, rule]));
  for (const rule of conversation?.rules ?? []) rules.set(rule.category, rule);
  return [...rules.values()];
}

export function checklistCandidateReason(
  input: RunInput,
  snapshots: RuntimeSnapshot[],
  settings: Settings,
): string | undefined {
  const candidates = snapshots.filter(
    (s) => (!input.runtimeId || s.id === input.runtimeId) && (!input.provider || s.provider === input.provider),
  );
  if (candidates.length && candidates.every((s) => !automaticExecutorAllowed(input, settings, s.id)))
    return `候选 ${input.routeRule!.index + 1} 未勾选为自动可选，跳过`;
}

export function matchRule(rules: RoutingRule[], category: RunInput['category']): RoutingRule | undefined {
  if (!category) return;
  return rules.find(
    (rule) =>
      rule.enabled &&
      rule.candidates.length &&
      rule.category === category.id &&
      (!rule.strict || category.confidence === 'high' || category.id === 'adult'),
  );
}

export function candidateInputs(rule: RoutingRule, input: RunInput): RunInput[] {
  return rule.candidates.map((candidate, index) => ({
    ...input,
    runtimeId: candidate.runtimeId,
    provider: candidate.runtimeId ? undefined : candidate.provider,
    model: candidate.model,
    effort: candidate.effort,
    allowExecutorFallback: false,
    routeRule: {
      id: rule.id,
      label: categoryLabel(rule.category, input.routingRules?.categories),
      index,
      strict: rule.strict,
      derived: true,
    },
  }));
}
