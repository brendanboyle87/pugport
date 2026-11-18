import {
  categoryLabel,
  modelIn,
  modelsFor,
  parseLegacyRoutingText,
  routingCategories,
  targetIn,
  type RoutingCard,
} from './conversation-routing.ts';
import type { ConversationRouting, RoutingCandidate, RoutingCategory, RoutingRule } from './types.ts';

const categoryWords: Array<[string, RegExp]> = [
  ['other', /非(?:成人|情色|色情)|其他|其余|剩下|the rest|everything else|\bother\b/i],
  ['adult', /成人|情色|色情|露骨|肉戏|nsfw|erotic|\badult\b/i],
  ['code', /代码|编程|开发|\b(?:code|coding|programming)\b/i],
  ['translation', /翻译|\btranslat(?:e|ion)\b/i],
  ['writing', /写作|小说|文案|正文|\b(?:writing|fiction|prose)\b/i],
  ['vision', /图片|图像|识图|\b(?:vision|images?)\b/i],
  ['research', /研究|调研|检索|\bresearch\b/i],
];
const strictWords = /只能|必须|只用|强制|务必|只交给|\b(?:only|must|always)\b/i;
const softWords = /优先|尽量|prefer/i;
const automaticWords = /自动|照旧|auto|best|suitable|合适/i;
const roleWords = /拆分|拆解|理解|扫描|大纲|规划|合并|统稿|整合|汇总|\b(?:split|outline|merge|combine)\b/i;
const coordinatorWords = /作为开始|(?<!优)先用|开头用|规划用|\b(?:starts? with|plan with)\b/i;
const verifierWords = /核验|审核|检查|验收|\b(?:review|verify|verifier)\b/i;
const candidateSeparator = /或者|不行(?:就|换)?|其次|或|、|再(?:用|交给)?|\b(?:or|then|else)\b/i;
const effortWords: Array<[string, RegExp]> = [
  ['xhigh', /\bx-?high\b|超高强度/i],
  ['max', /\bmax\b|最高强度/i],
  ['high', /(?<!x-?)\bhigh\b|(?<!超)高强度/i],
  ['medium', /\bmedium\b|中(?:等)?强度/i],
  ['low', /\blow\b|低强度/i],
];

function candidateIn(text: string, cards: RoutingCard[], inherited?: RoutingCandidate): RoutingCandidate | undefined {
  const named = targetIn(text, cards);
  let target =
    named ??
    (inherited && {
      ...(inherited.runtimeId ? { runtimeId: inherited.runtimeId } : {}),
      ...(inherited.provider ? { provider: inherited.provider } : {}),
    });
  if (!target) {
    const matching = cards.filter((card) => modelIn(text, modelsFor({ runtimeId: card.id }, cards)));
    if (matching.length && matching.every((card) => card.provider === matching[0]!.provider))
      target = { provider: matching[0]!.provider };
  }
  if (!target) return;
  // Generic provider names mean an account pool, even if a card happens to have that exact label.
  const card = cards.find((card) => card.id === target!.runtimeId);
  if (card && card.label.toLowerCase() === card.provider) target = { provider: card.provider };
  const models = modelsFor(target, cards);
  let model = modelIn(text, models);
  if (!model && /\bglm\b/i.test(text))
    model = models.find((model) => model.id === 'glm-5p3') ?? models.find((model) => /glm/i.test(model.id));
  if (/\bglm\b/i.test(text) && !model) return;
  if (!named && inherited && !model) return;
  const effort = model && effortWords.find(([level, words]) => model.efforts.includes(level) && words.test(text))?.[0];
  return { ...target, ...(model ? { model: model.id } : {}), ...(effort ? { effort } : {}) };
}

function candidatesIn(text: string, cards: RoutingCard[], inherited?: RoutingCandidate) {
  return text
    .split(candidateSeparator)
    .filter((part) => part.trim())
    .map((part) => {
      const candidate = candidateIn(part, cards, inherited);
      inherited = candidate;
      return candidate;
    });
}

/** Offline draft only: unknown clauses remain visible and are passed to the coordinator. */
export function parseRoutingRules(
  text: string,
  cards: RoutingCard[],
  categories: RoutingCategory[] = [],
): Omit<ConversationRouting, 'updatedAt'> {
  const rules = new Map<string, RoutingRule>();
  const unparsed: string[] = [];
  const legacy = parseLegacyRoutingText(text, cards);
  let explicitCoordinator: RoutingCandidate | undefined;
  const verifier: RoutingCandidate[] = [];
  let previousRole: 'coordinator' | 'verifier' | undefined;
  let previous: string | undefined;
  for (const raw of text.split(/[，,。；;\n！!？?]+/)) {
    const clause = raw.trim();
    if (!clause) continue;
    const role = verifierWords.test(clause)
      ? 'verifier'
      : coordinatorWords.test(clause)
        ? 'coordinator'
        : previousRole === 'verifier' && /^(?:不行|其次|再用|or\b|else\b)/i.test(clause)
          ? 'verifier'
          : undefined;
    if (role) {
      const candidates = candidatesIn(
        clause,
        cards,
        role === 'verifier' && previousRole === 'verifier' && !verifierWords.test(clause) ? verifier.at(-1) : undefined,
      );
      if (candidates.length && candidates.every((candidate) => candidate)) {
        if (role === 'coordinator') explicitCoordinator = candidates[0];
        else verifier.push(...(candidates as RoutingCandidate[]));
        previousRole = role;
      } else unparsed.push(clause);
      continue;
    }
    if (explicitCoordinator && /^(?:不需要判断|无需判断|不用判断)$/.test(clause)) continue;
    if (/^(?:然后)?后面分配具体的任务给不同的模型和强度$/.test(clause)) continue;
    const category =
      categories.find((category) => clause.includes(category.label))?.id ??
      categoryWords.find(([, words]) => words.test(clause))?.[0];
    if (!category) {
      // A separated effort belongs to the last candidate, as in "Claude Opus 5，高强度".
      const last = previous ? rules.get(previous)?.candidates.at(-1) : undefined;
      const level = effortWords.find(([, words]) => words.test(clause))?.[0];
      if (
        last?.model &&
        level &&
        modelsFor(last, cards)
          .find((model) => model.id === last.model)
          ?.efforts.includes(level)
      )
        last.effort = level;
      else if (
        !roleWords.test(clause) ||
        !legacy.rules.some((rule) => rule.topic === 'split' || rule.topic === 'merge')
      ) {
        if (!/每.{0,3}章|章节.{0,6}agent|mask|打码|占位|遮|屏蔽|脱敏/i.test(clause)) unparsed.push(clause);
      }
      continue;
    }
    previous = category;
    const candidates = candidatesIn(clause, cards);
    if (candidates.some((candidate) => !candidate)) {
      unparsed.push(clause);
      continue;
    }
    const cleared =
      candidates.length === 1 && candidates[0] && !Object.keys(candidates[0]).length && automaticWords.test(clause);
    rules.set(category, {
      id: `parsed:${category}`,
      category,
      candidates: cleared ? [] : (candidates as RoutingCandidate[]),
      strict: strictWords.test(clause) || (category === 'adult' && !softWords.test(clause)),
      enabled: true,
      source: 'parsed',
      clause,
    });
  }
  const role = (topic: 'split' | 'merge') => {
    const rule = legacy.rules.find((rule) => rule.topic === topic);
    return rule
      ? {
          ...rule.target,
          ...(rule.model ? { model: rule.model } : {}),
          ...(rule.effort ? { effort: rule.effort } : {}),
        }
      : undefined;
  };
  const coordinator = explicitCoordinator ?? role('split'),
    merger = role('merge');
  return {
    version: 2,
    text: text.trim(),
    rules: [...rules.values()],
    unparsed,
    ...(categories.length ? { categories } : {}),
    chapterAgents: legacy.chapterAgents,
    mask: legacy.mask,
    ...(coordinator || merger || verifier.length
      ? {
          roles: {
            ...(coordinator ? { coordinator } : {}),
            ...(merger ? { merger } : {}),
            ...(verifier.length ? { verifier } : {}),
          },
        }
      : {}),
  };
}

/** Accessible arrow controls and drag/drop use the same immutable ordering operation. */
export function reorderCandidates(rule: RoutingRule, from: number, to: number): RoutingRule {
  if (from < 0 || to < 0 || from >= rule.candidates.length || to >= rule.candidates.length || from === to) return rule;
  const candidates = [...rule.candidates];
  candidates.splice(to, 0, candidates.splice(from, 1)[0]!);
  return { ...rule, candidates, source: 'manual' };
}

export { routingCategories, categoryLabel };
