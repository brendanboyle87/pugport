import type { ModelInfo, Provider } from './types.ts';

/**
 * The same model reached through different CLIs. Older Cursor catalogs encode effort and speed in the id
 * ("grok-4.7-high-fast", "claude-opus-5-thinking-high"); parameterized Cursor catalogs name the model and
 * take effort separately, like Grok, Claude and Codex. A family is the shared part: "grok-4.7",
 * "claude-opus-5", "claude-opus-5-5", "gpt-5.6-sol".
 */
export const effortOrder = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

export type CursorVariant = { id: string; family: string; effort?: string; fast: boolean; thinking: boolean };

export function parseCursorModel(id: string): CursorVariant {
  let rest = id.toLowerCase().replace(/^cursor-/, '');
  const fast = /-fast$/.test(rest);
  if (fast) rest = rest.slice(0, -'-fast'.length);
  const thinking = /-thinking(?=-|$)/.test(rest);
  rest = rest.replace(/-thinking(?=-|$)/, '');
  let effort: string | undefined;
  const match = /-(extra-high|none|minimal|low|medium|high|xhigh|max|ultra)$/.exec(rest);
  if (match) {
    effort = match[1] === 'extra-high' ? 'xhigh' : match[1];
    rest = rest.slice(0, match.index);
  }
  return { id, family: rest, ...(effort ? { effort } : {}), fast, thinking };
}

/** The family of a model as the Grok, Claude or Codex CLI names it; aliases resolve through their label. */
export function nativeFamily(provider: Provider, model: Pick<ModelInfo, 'id' | 'label'>): string | undefined {
  const id = model.id.toLowerCase();
  if (provider === 'claude') {
    if (/^claude-/.test(id)) return id;
    const named = /^(opus|fable|sonnet|haiku)\s+(\d+(?:\.\d+)?)/i.exec(model.label.trim());
    return named ? `claude-${named[1]!.toLowerCase()}-${named[2]!.replace('.', '-')}` : undefined;
  }
  if (provider === 'grok' || provider === 'codex') return /\d/.test(id) ? id : undefined;
  return undefined;
}

const distance = (a?: string, b?: string) =>
  a && b && effortOrder.includes(a) && effortOrder.includes(b)
    ? Math.abs(effortOrder.indexOf(a) - effortOrder.indexOf(b))
    : a === b
      ? 0
      : 9;

type CursorModel = Pick<ModelInfo, 'id'> & Partial<Pick<ModelInfo, 'efforts' | 'defaultEffort'>>;

/** Keep a saved variant pin usable against a canonical catalog without adding aliases to the UI catalog. */
export function cursorModelForPin<T extends CursorModel>(models: T[], id: string): T | undefined {
  const exact = models.find((model) => model.id === id);
  if (exact) return exact;
  const variant = parseCursorModel(id);
  const canonical = models.find((model) => model.id === variant.family);
  if (!canonical || (variant.effort && !canonical.efforts?.includes(variant.effort))) return;
  return {
    ...canonical,
    id,
    ...(variant.effort ? { efforts: [variant.effort], defaultEffort: variant.effort } : {}),
  };
}

/**
 * Cursor's id for a family at an effort: the standard-speed variant with the nearest effort, preferring the
 * thinking variant for Claude (the Claude CLI always thinks). Undefined when Cursor does not offer the family.
 */
export function cursorEquivalent(models: CursorModel[], family: string, effort?: string): string | undefined {
  const canonical = models.find((model) => model.id === family);
  if (canonical) return !effort || canonical.efforts?.includes(effort) ? canonical.id : undefined;
  const variants = models.map((model) => parseCursorModel(model.id)).filter((variant) => variant.family === family);
  if (!variants.length) return undefined;
  const wanted = effort ?? 'high';
  const claude = family.startsWith('claude-');
  return [...variants].sort(
    (a, b) =>
      Number(a.fast) - Number(b.fast) ||
      distance(a.effort, wanted) - distance(b.effort, wanted) ||
      (claude ? Number(b.thinking) - Number(a.thinking) : Number(a.thinking) - Number(b.thinking)),
  )[0]!.id;
}

/** Cursor's models grouped into families with the efforts each offers, for choosing "grok-4.7 · high". */
export function cursorFamilies(models: CursorModel[]): Array<Pick<ModelInfo, 'id' | 'label' | 'efforts'>> {
  const families = new Map<string, Set<string>>();
  for (const model of models) {
    if (['auto', 'default'].includes(model.id)) continue;
    const variant = parseCursorModel(model.id);
    const efforts = families.get(variant.family) ?? new Set<string>();
    if (!variant.fast)
      for (const effort of model.efforts ?? []) efforts.add(effort === 'extra-high' ? 'xhigh' : effort);
    if (variant.effort && !variant.fast) efforts.add(variant.effort);
    families.set(variant.family, efforts);
  }
  return [...families].map(([family, efforts]) => ({
    id: family,
    label: family,
    efforts: effortOrder.filter((effort) => efforts.has(effort)),
  }));
}
