import type { ModelInfo, Provider } from './types.ts';

/** One catalog row, shared by list_agents and bounded validation errors. */
export function agentModelLine(card: { label: string; provider: Provider }, model: ModelInfo): string {
  const clean = (text: string) => text.replace(/\s+/g, ' ').trim();
  return `${clean(card.label)} | ${card.provider} | ${clean(model.id)} | ${clean(model.label)} | efforts: ${model.efforts.map(clean).join(', ') || '(none)'}`;
}
