import { isRetiredProvider } from '../shared/provider-registry.ts';
import type {
  ConversationRoutingData,
  ConversationRoutingRule,
  MessageInput,
  RoutingTarget,
  RuntimeSnapshot,
  RuntimeTarget,
  RunInput,
  Workflow,
} from '../shared/types.ts';
import { cursorEquivalent, cursorModelForPin, parseCursorModel } from '../shared/model-family.ts';
import {
  cardFor,
  isAutomatic,
  mergeWords,
  modelsFor,
  routingLines,
  ruleFor,
  targetLabel,
  upgradeRouting,
  type RoutingCard,
} from '../shared/conversation-routing.ts';
export { upgradeRouting } from '../shared/conversation-routing.ts';
import type { AgentChoice } from './agent-names.ts';
import { involvesMinors } from './content-refusal.ts';
import { matureContent } from './routing.ts';
import { taskCategory } from './task-category.ts';
import { matchRule } from './routing-rules.ts';
import { managedAgentLimits } from '../shared/swarm.ts';

export const routingCards = (targets: RuntimeTarget[], snapshots: RuntimeSnapshot[] = []): RoutingCard[] =>
  targets
    .filter((target) => target.enabled && !isRetiredProvider(target.provider))
    .map((target) => {
      const models = snapshots.find((snapshot) => snapshot.id === target.id)?.models;
      return {
        id: target.id,
        label: target.label,
        provider: target.provider,
        ...(models?.length ? { models: models.map(({ id, label, efforts }) => ({ id, label, efforts })) } : {}),
      };
    });

/** The rule's model and effort, kept only while that executor still reports the model (and the effort for it). */
function choice(rule: ConversationRoutingRule, cards: RoutingCard[]): { model?: string; effort?: string } {
  if (!rule.model) return {};
  const models = modelsFor(rule.target, cards);
  const card = cardFor(rule.target, cards);
  const variant = card?.provider === 'cursor' ? parseCursorModel(rule.model) : undefined;
  const model = models.find((item) => item.id === (variant?.family ?? rule.model));
  if (models.length && !model) return {};
  const requestedEffort = rule.effort ?? variant?.effort;
  const effort = requestedEffort && (!model || model.efforts.includes(requestedEffort)) ? requestedEffort : undefined;
  if (card?.provider === 'cursor') {
    if (requestedEffort && (!effort || (variant?.effort && variant.effort !== requestedEffort)))
      return { model: rule.model, effort: requestedEffort };
    // Persisted variant pins keep speed/thinking flags. Canonical catalogs take effort separately.
    const pin = cursorModelForPin(card.models ?? [], rule.model);
    if (pin) return { model: pin.id, ...(effort && pin.efforts.includes(effort) ? { effort } : {}) };
    if (rule.model !== variant!.family) return { model: rule.model, ...(effort ? { effort } : {}) };
    const id = cursorEquivalent(card.models ?? [], variant!.family, effort);
    return id ? { model: id } : {};
  }
  return { model: rule.model, ...(effort ? { effort } : {}) };
}

function pinned(input: MessageInput, rule: ConversationRoutingRule, cards: RoutingCard[]): MessageInput {
  const target = rule.target;
  const same = target.runtimeId
    ? input.runtimeId === target.runtimeId
    : !input.runtimeId && input.provider === target.provider;
  // A model the user picked for this same executor stays; otherwise the rule's model (or the default) applies.
  if (same && input.model) return input;
  const { model, effort } = choice(rule, cards);
  return {
    ...input,
    provider: target.runtimeId ? undefined : target.provider,
    runtimeId: target.runtimeId,
    model,
    effort,
  };
}

/**
 * Manual choices always win. Only role selection is resolved here; content rules enter route() after task judgment.
 */
export function routedMessage(input: MessageInput, routing: ConversationRoutingData | undefined, cards: RoutingCard[]) {
  if (!routing) return input;
  const userPicked = !!(input.runtimeId || input.provider || input.model || input.effort);
  if (userPicked) return input;
  if (upgradeRouting(routing).roles?.verifier?.length) input = { ...input, review: true };
  // Adult rules must reach the engine too, even when a coordinator role is configured.
  if (ruleFor(routing, 'adult') && matureContent(input.intentText ?? input.content)) return input;
  const coordinator = ruleFor(routing, 'split') ?? (routing.chapterAgents ? ruleFor(routing, 'merge') : undefined);
  if (coordinator && !isAutomatic(coordinator.target)) return pinned(input, coordinator, cards);
  return input;
}

/** Reviewer roles come from the parent's captured profile, never a later settings edit or a manual parent pin. */
export function reviewerCandidates(parent: Pick<Workflow, 'ownSelection' | 'input' | 'routingContext'> | undefined) {
  if (!parent) return;
  const own = parent.ownSelection ?? parent.input;
  if (own.runtimeId || own.provider || own.model || own.effort) return;
  return parent.routingContext?.routingRules?.roles?.verifier;
}

/**
 * The executor a strict adult rule binds this message to, when it applies (the message is adult material and the
 * rule names an executor); undefined otherwise. Steering into a running task must respect it too.
 */
export function strictRoute(
  input: MessageInput,
  routing: ConversationRoutingData | undefined,
  cards: RoutingCard[],
): (RoutingTarget & { label: string }) | undefined {
  if (input.runtimeId || input.provider || input.model || input.effort) return;
  const adult = ruleFor(routing, 'adult');
  if (!adult?.strict || isAutomatic(adult.target) || !matureContent(input.intentText ?? input.content)) return;
  const target = adult.target;
  if (isAutomatic(target)) return;
  return { ...target, label: targetLabel(target, cards) };
}

const sameExecutor = (agent: AgentChoice, target: RoutingTarget) =>
  target.runtimeId ? agent.runtimeId === target.runtimeId : agent.provider === target.provider;

/**
 * A sub-task's executor, model and effort under the conversation's rules. Adult material bound for another
 * executor is redirected to the adult executor when the rule is strict or the user asked for masking. A task
 * that lands on a rule's executor runs with that rule's model and effort. Sexual content involving minors goes
 * nowhere.
 */
export function routedDelegation(
  agent: AgentChoice,
  task: string,
  routing: ConversationRoutingData | undefined,
  cards: RoutingCard[],
  context: { parentCategory?: RunInput['category']; pinned?: boolean } = {},
): { agent: AgentChoice; redirected: boolean; model?: string; effort?: string } {
  const mature = context.parentCategory?.id === 'adult' || matureContent(task);
  if (mature && involvesMinors.test(task)) throw new Error('涉及未成年人的性内容不能交给任何执行器。');
  if (!routing) return { agent, redirected: false };
  if (context.pinned) return { agent, redirected: false };
  if ('version' in routing && routing.version === 2) {
    const category = taskCategory({
      prompt: task,
      categories: routing.categories,
      parentCategory: context.parentCategory,
    });
    const rule = matchRule(routing.rules, category);
    const candidate = rule?.candidates.find((candidate) => sameExecutor(agent, candidate));
    const selected =
      candidate ?? (rule?.strict || (category.id === 'adult' && routing.mask) ? rule?.candidates[0] : undefined);
    if (selected) {
      const target = selected;
      const card = cards.find((item) => item.id === target.runtimeId);
      const redirected = !candidate && !isAutomatic(target);
      return {
        agent: redirected
          ? card
            ? { label: card.label, provider: card.provider, runtimeId: card.id }
            : { label: targetLabel(target, cards), provider: target.provider, runtimeId: target.runtimeId }
          : agent,
        redirected,
        ...(selected.model ? { model: selected.model } : {}),
        ...(selected.effort ? { effort: selected.effort } : {}),
      };
    }
    return { agent, redirected: false };
  }
  const adult = ruleFor(routing, 'adult');
  if (adult && !isAutomatic(adult.target) && mature && (adult.strict || routing.mask)) {
    const target = adult.target;
    if (!isAutomatic(target) && !sameExecutor(agent, target)) {
      const card = cards.find((item) => item.id === target.runtimeId);
      return {
        agent: card
          ? { label: card.label, provider: card.provider, runtimeId: card.id }
          : {
              label: targetLabel(target, cards),
              provider: target.provider,
              ...(target.runtimeId ? { runtimeId: target.runtimeId } : {}),
            },
        redirected: true,
        ...choice(adult, cards),
      };
    }
  }
  const lands = (rule?: ConversationRoutingRule) =>
    rule && !isAutomatic(rule.target) && sameExecutor(agent, rule.target) ? rule : undefined;
  const rule =
    (mature ? lands(adult) : undefined) ??
    (mergeWords.test(task) ? lands(ruleFor(routing, 'merge')) : undefined) ??
    lands(ruleFor(routing, 'other')) ??
    lands(ruleFor(routing, 'split'));
  return { agent, redirected: false, ...(rule ? choice(rule, cards) : {}) };
}

/** What the coordinator (or a sub-agent) is told about this conversation's rules. */
export function routingInstructions(routing: ConversationRoutingData, cards: RoutingCard[], child: boolean): string {
  const rules = routingLines(routing, cards)
    .map((line) => `- ${line}`)
    .join('\n');
  if (child)
    return [
      `本对话有用户确认的路由规则：\n${rules}`,
      '你只完成交给你的这一部分。',
      '让你审稿时，只指出问题：行号、原句、哪里不自然、为什么。不要写改好的句子。',
      '写作技能只当写法参考：可以读它的规则，但不要运行它自带的流程、状态文件或脚本。',
      routing.mask ? '内容里出现【场景1】这样的占位符时保持原样，不要补写或删除。' : '',
    ]
      .filter(Boolean)
      .join('\n');
  const merge = ruleFor(routing, 'merge');
  const names = [...new Set(cards.map((card) => card.label))].join('、');
  return [
    `本对话的路由规则（用户已确认）：\n${rules}`,
    routing.text ? `用户原话（参考）：${routing.text}` : '',
    '按这些规则工作：',
    `- 需要分工时，用 PugPort 工具 delegate 把各部分交给对应执行器（agent 填执行器名称：${names || 'Grok、Claude、Codex、Cursor'}，或直接写 Grok、Claude、Codex、Cursor）。标了“强制”的规则由应用执行：成人内容派给其他执行器时，会被改派给成人内容执行器。`,
    routing.chapterAgents
      ? `- 长篇每一章都按这个流程：
  1. 先说清这次要改什么或写什么：本章目标、冲突、转折、章末钩子、出场人物，写新章节时存成书目录下的「细纲/第N章.md」。
  2. 交给一个写手（write=true，files 只写这一章的文件），写手按这个项目的写作偏好来。交给它：写作要求、本章细纲或这次的修改要求、有关人物的设定、前两章摘要，以及本章用得上的旧事。它先通读整章和上一章结尾。改稿时只改有问题的段落和前后衔接；只有整章结构失控时才整章重写。
  3. 写完交给一位编辑（只读）通读整章：动作接不接得上，人物为什么这样做，对白像不像这个人，有没有丢掉重要信息，没读过前文的人看不看得懂。编辑可以直接说「这一版可以了」，不必非找出问题；有问题就写清第几段、原句、哪里不对、为什么，不写改好的句子。check_style 的结果只作提示，不作结论。
  4. 只有涉及复杂时间线、医学或法律细节时，才另派一个只读的专项检查。
  5. 按编辑意见交回同一个写手修改，最多两轮。两轮后还有分歧，就把分歧写清楚交给用户决定。
  6. 定稿后由你更新书目录下「状态/」里的文件：章节摘要.md（这一章 200～300 字）、人物状态.md（每个人现在在哪、知道什么、不知道什么）、读者已知.md（读者已经知道、而人物还不知道的事）、伏笔与时间线.md。状态只记在这里，只在定稿后更新，不要另建别的状态目录。
- 写新章节要一章接一章地写，后一章要用前一章定稿后的摘要；只是修改已有章节、彼此不依赖时，才可以按章同时派出，你负责拆分、核对和合并。普通聊天一个主任务最多 ${managedAgentLimits.children} 个子 agent；各章文件不重叠时最多 ${managedAgentLimits.active} 个写手同时写（每个账号按剩余额度分到几个，其余排队；显式蜂群按其独立上限），用 delegate_many 一次派出，再用 get_result 的 task_ids 一起等；它们写的期间不要改它们的文件。
- 一次只改用户指定的章节，不要自己决定批量重写全书。
- 已安装的写作技能（如 story-deslop）只当写法参考：可以读它的规则，但不要运行它自带的流程、状态文件或脚本。`
      : '- 让子 agent 审稿时，只让它指出问题：行号、原句、哪里不自然、为什么。不要让它给改写句子，也不要只让它读零散的几行：至少读完整一段，最好整章。\n- 要改时，一章交给一个负责写作的执行器：先通读整章（和上一章结尾），再按问题清单在上下文里重写有问题的段落，保持全章语气一致。不要按行号把别人给的句子逐句替换进去。',
    routing.mask
      ? '- 把章节交给非成人内容执行器之前，先把露骨段落换成【场景1】【场景2】这样的占位符，并告诉它保持占位符原样；露骨段落单独交给成人内容执行器写。合并时把占位符换回对应段落。'
      : '',
    merge && !isAutomatic(merge.target)
      ? `- 全部完成后由“${targetLabel(merge.target, cards)}”合并统稿；你就是它时直接合并，否则用 delegate 交给它。`
      : '- 全部完成后由你合并统稿，检查前后人物、时间线和文风一致。',
    '- 向用户汇报时用大白话：先说结论，再举一两个原句说明问题在哪、打算怎么办。不要用“报幕”“接尾”这类自己起的说法，不要堆行号表格；需要定位时说第几章哪一段。',
    '- 任何涉及未成年人的性内容一律拒绝，不交给任何执行器。',
  ]
    .filter(Boolean)
    .join('\n');
}
