import type {
  ConversationRouting,
  ConversationRoutingData,
  LegacyConversationRouting,
  ConversationRoutingRule,
  ModelInfo,
  Provider,
  RoutingTarget,
  RoutingTopic,
  RoutingCategory,
} from './types.ts';
import { cursorFamilies } from './model-family.ts';
import { swarmLimits } from './swarm.ts';

export type RoutingModel = Pick<ModelInfo, 'id' | 'label' | 'efforts'>;
/** An executor card a rule can name, with the models it reports (when known). */
export type RoutingCard = { id: string; label: string; provider: Provider; models?: RoutingModel[] };

/**
 * Sub-agents of one task that run at the same time; the rest wait in the queue. Each account also takes only its
 * share by remaining quota (server/member-allocation), so fewer may run when the accounts are busy or low.
 */
export const maxActiveChildAgents = swarmLimits.active;
/** Sub-agents one task may create in total: one per chapter, so a long work fits. */
export const maxChildAgents = swarmLimits.children;

export const routingTopics: RoutingTopic[] = ['split', 'adult', 'other', 'merge'];
export const topicLabel: Record<RoutingTopic, string> = {
  split: '拆分与理解',
  adult: '成人内容',
  other: '其余内容',
  merge: '合并统稿',
};
export const providerLabel: Partial<Record<Provider, string>> = {
  grok: 'Grok',
  claude: 'Claude',
  codex: 'Codex',
  cursor: 'Cursor',
  gemini: 'Gemini',
};

const providerWords: Array<[Provider, RegExp]> = [
  ['cursor', /cursor/i],
  ['gemini', /gemini|双子/i],
  ['grok', /gr[oa]k|gork/i],
  ['claude', /claude|克劳德/i],
  ['codex', /codex|gpt|openai/i],
];
const otherWords =
  /非(?:情色|色情|成人|露骨)|不(?:是|含|涉及)(?:情色|色情|成人|露骨)|其他|其余|剩下|剩余|别的|non-?(?:explicit|adult|erotic)|the rest|everything else|other (?:parts|chapters|content)/i;
const adultWords = /情色|色情|成人|露骨|黄文|肉戏|nsfw|erotic|explicit|sexual|性爱|r-?18|十八禁|18\s*禁/i;
export const mergeWords = /合并|整合|汇总|统稿|拼接|合成|merge|combine|assembl/i;
const splitWords = /拆分|拆解|拆开|扫描|分析|理解|分章|大纲|规划|split|scan|outline|break.{0,10}down|analy[sz]/i;
const autoWords = /合适|适合|自动|最好的|最佳|随便|看着办|auto|best|suitable/i;
const strictWords = /必须|只能|只用|一定|强制|务必|只交给|must|only|always/i;
const chapterWords = /章节|每章|一章|每一章|子\s*agent|子任务|子代理|sub-?agents?|chapters?/i;
const maskWords = /mask|遮|打码|占位|屏蔽|脱敏|placeholder|redact/i;
const effortWords: Array<[string, RegExp]> = [
  ['xhigh', /\bx-?high\b|超高强度/i],
  ['max', /\bmax\b|最高强度/i],
  ['high', /(?<!x-?)\bhigh\b|(?<!超)高强度/i],
  ['medium', /\bmedium\b|中(?:等)?强度/i],
  ['low', /\blow\b|低强度/i],
];
/** Aliases such as "opus" or "default" are matched by their label ("Opus 5.5"), never by the bare word. */
const aliasModel = (id: string) => !/\d/.test(id);

/** The models a rule's executor offers: its own card's, or the first card of that provider. */
export function cardFor(target: RoutingTarget, cards: RoutingCard[]): RoutingCard | undefined {
  return target.runtimeId
    ? cards.find((item) => item.id === target.runtimeId)
    : target.provider
      ? cards.find((item) => item.provider === target.provider && item.models?.length)
      : undefined;
}

/** The models a rule's executor offers. Cursor's are grouped into families ("grok-4.7") with their efforts. */
export function modelsFor(target: RoutingTarget, cards: RoutingCard[]): RoutingModel[] {
  const card = cardFor(target, cards);
  if (card?.provider === 'cursor') return cursorFamilies(card.models ?? []);
  return (card?.models ?? []).filter((model) => !['default', 'auto'].includes(model.id));
}

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** "Opus 5" must not match inside "Opus 5.5"; spaces and hyphens are interchangeable. */
const loose = (value: string) =>
  new RegExp(
    `(?<![\\w.])${value
      .trim()
      .split(/[\s\-_]+/)
      .map(escape)
      .join('[\\s\\-_]*')}(?!\\.?\\d|\\w)`,
    'i',
  );

/** The model a clause names among the executor's models: the longest label or versioned id that appears. */
export function modelIn(clause: string, models: RoutingModel[]): RoutingModel | undefined {
  let best: { model: RoutingModel; length: number } | undefined;
  for (const model of models)
    for (const name of [
      model.label,
      model.label.replace(/^Claude\s+/i, ''),
      ...(aliasModel(model.id) ? [] : [model.id]),
      ...(/(?:^|-)astra(?:-|$)/i.test(model.id) ? ['astra'] : []),
      ...(/(?:^|-)sol(?:-|$)/i.test(model.id) ? ['sol'] : []),
    ])
      if (name && loose(name).test(clause) && (!best || name.length > best.length))
        best = { model, length: name.length };
  return best?.model;
}

const squash = (value: string) =>
  value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s·・\-_]/g, '');

/** The executor a clause names: a card label first, then a provider; "合适/自动" means automatic. */
export function targetIn(clause: string, cards: RoutingCard[]): RoutingTarget | undefined {
  const text = squash(clause);
  for (const card of [...cards].sort((a, b) => b.label.length - a.label.length)) {
    const label = squash(card.label);
    const at = label.length >= 2 ? text.indexOf(label) : -1;
    // "Grok B" must not match inside "grok bot".
    if (at >= 0 && !/[a-z0-9]/.test(text[at + label.length] ?? ''))
      return { runtimeId: card.id, provider: card.provider };
  }
  const named = providerWords.filter(([, words]) => words.test(clause)).map(([provider]) => provider);
  // "cursor 的 grok" is Cursor running a Grok model: the executor is Cursor.
  if (named.length) return { provider: named[0] };
  if (autoWords.test(clause)) return {};
  return undefined;
}

function topicOf(clause: string): RoutingTopic | undefined {
  if (otherWords.test(clause)) return 'other';
  if (mergeWords.test(clause)) return 'merge';
  if (adultWords.test(clause)) return 'adult';
  if (splitWords.test(clause)) return 'split';
  return undefined;
}

/**
 * Turns the user's own words into a rule list they confirm before it applies. Deterministic and offline:
 * the same words always give the same rules, and anything unclear is left for the user to set.
 */
export function parseLegacyRoutingText(
  text: string,
  cards: RoutingCard[],
): Omit<LegacyConversationRouting, 'updatedAt'> {
  const rules: ConversationRoutingRule[] = [];
  let previous: RoutingTopic | undefined;
  for (const clause of text.split(/[，,。；;\n！!？?]+|然后|之后|接着|最后/)) {
    if (!clause.trim()) continue;
    const topic = topicOf(clause) ?? previous;
    const target = targetIn(clause, cards);
    if (topic && target && !rules.some((rule) => rule.topic === topic)) {
      const model = modelIn(clause, modelsFor(target, cards));
      const effort =
        model && effortWords.find(([level, words]) => model.efforts.includes(level) && words.test(clause))?.[0];
      rules.push({
        topic,
        target,
        strict: topic === 'adult' || strictWords.test(clause),
        ...(model ? { model: model.id } : {}),
        ...(effort ? { effort } : {}),
      });
    } else if (!target && !topicOf(clause)) {
      // "其余用 Claude Opus 5，高强度": an effort said on its own belongs to the rule just before it.
      const last = rules.find((rule) => rule.topic === previous);
      const model = last?.model ? modelsFor(last.target, cards).find((item) => item.id === last.model) : undefined;
      const effort =
        model && effortWords.find(([level, words]) => model.efforts.includes(level) && words.test(clause))?.[0];
      if (last && effort && !last.effort) last.effort = effort;
    }
    if (topicOf(clause)) previous = topic;
  }
  return {
    text: text.trim(),
    rules: routingTopics.flatMap((topic) => rules.filter((rule) => rule.topic === topic)),
    chapterAgents: chapterWords.test(text),
    mask: maskWords.test(text),
  };
}

export const routingCategories: RoutingCategory[] = [
  { id: 'adult', label: '成人内容' },
  { id: 'code', label: '代码' },
  { id: 'writing', label: '写作' },
  { id: 'translation', label: '翻译' },
  { id: 'vision', label: '图片' },
  { id: 'research', label: '研究' },
  { id: 'other', label: '其余内容' },
];
export { parseRoutingRules as parseRoutingText } from './routing-parser.ts';
export function categoryLabel(id: string, categories: RoutingCategory[] = []) {
  return [...categories, ...routingCategories].find((category) => category.id === id)?.label ?? id;
}

/** Lazy and lossless: old role rules move out of content categories. */
export function upgradeRouting(routing: ConversationRoutingData): ConversationRouting {
  if ('version' in routing && routing.version === 2) return routing;
  const legacy = routing as LegacyConversationRouting;
  const candidate = (rule: ConversationRoutingRule) => ({
    ...rule.target,
    ...(rule.model ? { model: rule.model } : {}),
    ...(rule.effort ? { effort: rule.effort } : {}),
  });
  const coordinator = legacy.rules.find((rule) => rule.topic === 'split');
  const merger = legacy.rules.find((rule) => rule.topic === 'merge');
  return {
    version: 2,
    text: legacy.text,
    unparsed: [],
    updatedAt: legacy.updatedAt,
    chapterAgents: legacy.chapterAgents,
    mask: legacy.mask,
    ...(legacy.automaticExecutors !== undefined ? { automaticExecutors: legacy.automaticExecutors } : {}),
    rules: legacy.rules
      .filter((rule) => rule.topic === 'adult' || rule.topic === 'other')
      .map((rule) => ({
        id: `migrated:${rule.topic}`,
        category: rule.topic,
        candidates: [candidate(rule)],
        strict: rule.strict,
        enabled: true,
        source: 'migrated',
      })),
    ...(coordinator || merger
      ? {
          roles: {
            ...(coordinator ? { coordinator: candidate(coordinator) } : {}),
            ...(merger ? { merger: candidate(merger) } : {}),
          },
        }
      : {}),
  };
}

/** Compatibility for the existing delegation/role paths; TODO stage 4: use the whole candidate list. */
export function ruleFor(
  routing: ConversationRoutingData | undefined,
  topic: RoutingTopic,
): ConversationRoutingRule | undefined {
  if (!routing) return;
  const current = upgradeRouting(routing);
  const rule = current.rules.find((rule) => rule.category === topic && rule.enabled);
  const selected =
    topic === 'split' ? current.roles?.coordinator : topic === 'merge' ? current.roles?.merger : rule?.candidates[0];
  if (!selected) return;
  const { model, effort, ...target } = selected;
  return { topic, target, strict: rule?.strict ?? false, ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
}

export function targetLabel(target: RoutingTarget, cards: RoutingCard[]): string {
  if (target.runtimeId) return cards.find((card) => card.id === target.runtimeId)?.label ?? '已移除的执行器';
  if (target.provider) return providerLabel[target.provider] ?? target.provider;
  return '自动选择';
}

export const isAutomatic = (target: RoutingTarget) => !target.runtimeId && !target.provider;

/** "Opus 5 · high" for a rule that sets its model and effort; empty when it uses the executor's defaults. */
export function modelNote(rule: Pick<ConversationRoutingRule, 'target' | 'model' | 'effort'>, cards: RoutingCard[]) {
  const model = rule.model
    ? (modelsFor(rule.target, cards).find((item) => item.id === rule.model)?.label ?? rule.model)
    : '';
  return [model, rule.effort].filter(Boolean).join(' · ');
}

/** The rules as plain lines, for the coordinator's instructions and the panel summary. */
export function routingLines(data: ConversationRoutingData, cards: RoutingCard[]): string[] {
  const routing = upgradeRouting(data);
  const roleLine = (topic: 'split' | 'merge') => {
    const role = ruleFor(routing, topic);
    return role
      ? [
          `${topicLabel[topic]} → ${targetLabel(role.target, cards)}${modelNote(role, cards) ? `（${modelNote(role, cards)}）` : ''}（优先）`,
        ]
      : [];
  };
  return [
    ...roleLine('split'),
    ...routing.rules
      .filter((rule) => rule.enabled)
      .map(
        (rule) =>
          `${categoryLabel(rule.category, routing.categories)} → ${
            rule.candidates
              .map((candidate) => {
                const note = modelNote({ target: candidate, ...candidate }, cards);
                return `${targetLabel(candidate, cards)}${note ? `（${note}）` : ''}`;
              })
              .join(' ／ ') || '自动选择'
          }${rule.strict ? '（强制，由应用执行）' : '（优先）'}`,
      ),
    ...roleLine('merge'),
    ...(routing.roles?.verifier?.length
      ? [
          `核验 → ${routing.roles.verifier.map((candidate) => [targetLabel(candidate, cards), modelNote({ target: candidate, ...candidate }, cards)].filter(Boolean).join(' · ')).join(' ／ ')}`,
        ]
      : []),
    ...routing.unparsed.map((clause) => `未识别：${clause}`),
    ...(routing.chapterAgents ? ['每一章（或每一节）交给一个独立的子 agent'] : []),
    ...(routing.mask ? ['成人段落先换成占位符，再把章节交给非成人内容执行器'] : []),
  ];
}
