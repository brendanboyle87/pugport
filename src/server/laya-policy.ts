import type { LayaInference, LayaPolicy, LayaState } from '../shared/laya.ts';
import type { Provider, RuntimeTarget } from '../shared/types.ts';
import { agentDirectory, normalizeAgentName, resolveAgent } from './agent-names.ts';
import { providerNames } from '../shared/delegation.ts';

type PolicyInput = {
  runtimeId?: string;
  provider?: Provider;
  model?: string;
  effort?: string;
  permissionMode?: 'read-only' | 'workspace-write';
  permissionReauthorized?: boolean;
  explicitWrite?: boolean;
  /** A write task points to a project brief that cannot be read: an implementation of unknown size. */
  briefUnreadable?: boolean;
  /** Without a judgment, the local rules handle this message as a reply rather than a task. */
  replyOnly?: boolean;
};
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const uncertain =
  /如果|假如|倘若|要不|也许|或许|可能|考虑|是否|还是|或者|能不能|可不可以|\b(?:if|unless|maybe|perhaps|might|whether|or)\b/iu;
const reference =
  /^(?:请)?\s*(?:解释|翻译|评价|复述|引用|讨论|分析.*(?:句|词)|说明.*(?:句|词)|explain\b|translate\b|quote\b|discuss\b|paraphrase\b)/iu;

export function layaInputCompacted(inference: LayaInference): boolean {
  if (inference.reason === 'input_too_large') return true;
  const usage = inference.raw?.usage as Record<string, unknown> | undefined;
  if (!usage) return false;
  if (usage.source_compacted === true || usage.message_truncated === true) return true;
  if (Array.isArray(usage.compacted_fields))
    return usage.compacted_fields.some((field) => field === 'message' || field === 'reference_text');
  if (usage.message_truncated === false || usage.context_truncated === true) return false;
  // Older workers without field-level evidence retain their conservative fallback.
  return usage.input_compacted === true || usage.truncated === true;
}

/** Preserve quoted card names, but never execute quoted instructions or reference material. */
function instructionText(message: string, targets: RuntimeTarget[]): string {
  return message
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')
    .replace(/^\s*>.*$/gm, ' ')
    .replace(/"[^"\n]*"|(?<![a-zA-Z0-9_])'[^'\n]*'|“[^”]*”|‘[^’]*’|`[^`\n]*`/g, (quote) => {
      const name = quote.slice(1, -1);
      try {
        resolveAgent(name, targets);
        return name;
      } catch {
        if (targets.some((target) => normalizeAgentName(target.label).includes(normalizeAgentName(name)))) return name;
        return ' ';
      }
    });
}

function currentClause(clause: string): string {
  if (/(?:之前|此前|先前|原先|上次|\bpreviously\b|\bearlier\b)/iu.test(clause)) {
    const correction = /(?:现在|这次|目前|改用|改派给|\bnow\b|\binstead\b)/iu.exec(clause);
    return correction ? clause.slice(correction.index) : '';
  }
  return clause;
}

/** A deliberately narrow grammar: ambiguous prose stays with normal routing and a visible conflict. */
export function layaPolicy(
  state: LayaState,
  inference: LayaInference,
  input: PolicyInput,
  targets: RuntimeTarget[],
): LayaPolicy {
  const policy: LayaPolicy = { applied: false, reasons: [], conflicts: [], excludeRuntimeIds: [] };
  const conflict = (reason: string) => {
    if (!policy.conflicts.includes(reason)) policy.conflicts.push(reason);
  };
  const compacted = layaInputCompacted(inference);
  const choices = inference.status === 'ok' && !compacted ? inference.choices : undefined;
  const directory = agentDirectory(targets);
  const names = [
    ...new Set([
      ...targets.flatMap((target) => [target.label, target.id]),
      ...directory.flatMap((agent) => [agent.label, agent.provider, providerNames[agent.provider]]),
    ]),
  ]
    .filter((name) => normalizeAgentName(name))
    .sort((a, b) => b.length - a.length)
    .map((name) => ({
      name,
      pattern: new RegExp(
        '^' + [...normalizeAgentName(name)].map(escape).join('[\\s·•・\\-_.:：,，()（）\\[\\]【】]*') + '(?![a-z0-9_])',
        'iu',
      ),
    }));
  const assignments = new Set<string>();
  const clauses = instructionText(state.message, targets)
    .split(/[\n。！？!?；;]|\.(?=\s)/u)
    .map((clause) => currentClause(clause.trim()))
    .filter((clause) => clause && !reference.test(clause));
  let commandRequested = false;
  let browserRequested = false;
  let attachmentRequested = false;
  let ignoredAttachments = false;

  for (const clause of clauses) {
    const conditional = uncertain.test(clause);
    const readOnly =
      /(?:^|[，,:：])\s*(?:请|帮我|请你)?(?:保持|使用)?(?:只读|仅(?:阅读|查看))|(?:不要|禁止)(?:修改|写入|改动)(?:(?:任何|所有)?文件)?\s*(?=$|[，,、])|(?:^|[,;:])\s*(?:please\s+)?(?:(?:remain|stay|use|do)\s+)?read[- ]only\b|\bin\s+read[- ]only\s+mode\b|\b(?:do not|don't|never)\s+(?:edit|modify|write)(?:\s+(?:any\s+)?(?:files?|anything))?\s*(?=$|[,;:])/iu.test(
        clause,
      );
    const noCommands =
      /(?:不要|别|禁止|不允许)(?:实际|真正)?(?:运行|执行)(?:(?:任何|所有|一切)?命令|(?=$|[，,、]))|不(?:实际|真正)(?:运行|执行)(?=$|[，,、])|\b(?:do not|don't|never)\s+(?:actually\s+)?(?:run|execute)\s+(?:(?:any|all)\s+)?commands?\b|\b(?:do not|don't|never)\s+(?:actually\s+)?(?:run|execute)\s*$|\bno\s+(?:actual\s+)?(?:execution|commands)\b/iu.test(
        clause,
      );
    const operationRestriction =
      /(?:不要|别|禁止|不允许)(?:实际|真正)?(?:运行|执行|跑)|\b(?:do not|don't|never)\s+(?:actually\s+)?(?:run|execute)\b/iu.test(
        clause,
      );
    if (conditional && (readOnly || noCommands || /只读|\bread[- ]only\b/iu.test(clause)))
      conflict('Permission restriction is conditional; clarify it.');
    if (!conditional && readOnly && !input.permissionReauthorized && !input.explicitWrite) {
      policy.permissionMode = 'read-only';
      policy.reasons.push('Current message explicitly limits project access to read-only.');
    }
    if (!conditional && noCommands) {
      policy.prohibitCommands = true;
      policy.reasons.push('Current message explicitly prohibits command execution.');
    }
    if (
      !conditional &&
      !operationRestriction &&
      /(?:运行|执行|跑)(?:一下|实际|这些|全部|所有|单元)?\s*(?:tests?|测试|命令|npm|pnpm|pytest)|\b(?:run|execute)\s+(?:the\s+)?(?:tests?|commands?|npm|pnpm|pytest)\b/iu.test(
        clause,
      )
    )
      commandRequested = true;
    if (
      !conditional &&
      /(?:已登录|登录后的|当前)(?:的)?(?:网页|网站|页面)|\b(?:logged[- ]in|signed[- ]in|current)\s+(?:web\s*)?(?:page|website|browser)\b/iu.test(
        clause,
      ) &&
      /点击|打开|填写|操作|提交|\b(?:click|open|fill|submit|navigate)\b/iu.test(clause)
    )
      browserRequested = true;
    ignoredAttachments ||=
      /(?:不用|不要使用|忽略|不看|无需(?:读取|分析))(?:这些|所附|任何)?(?:附件|图片|图像|音频|视频)|\b(?:ignore|skip)\s+(?:the\s+)?(?:attachments?|images?|audio|video)\b|\b(?:do not|don't)\s+use\s+(?:the\s+)?attachments?\b/iu.test(
        clause,
      );
    attachmentRequested ||=
      /(?:分析|读取|查看|识别|听|转录)(?:一下|所附|这张|这段|这个|该)?(?:附件|图片|图像|截图|音频|视频)|\b(?:analy[sz]e|read|inspect|transcribe)\s+(?:the\s+)?(?:attached\s+)?(?:image|attachment|audio|video)\b/iu.test(
        clause,
      );

    const commands =
      /(?:不要|别|禁止|不再|不)(?:再)?(?:使用|调用|用|让)|排除|改派给|改用|换用|换成|交给|委派给|调用|使用|用|让|请|\b(?:do not use|don't use|exclude|switch to|reassign to|assign to|use|ask)\s+/giu;
    for (const match of clause.matchAll(commands)) {
      const tail = clause.slice(match.index! + match[0].length).trimStart();
      const named = names.find(({ pattern }) => pattern.test(tail));
      // Partial names are resolved by the existing directory, including its ambiguity checks.
      const token = /^[a-z][a-z0-9_.:-]*/iu.exec(tail)?.[0];
      const partial =
        token && directory.some((agent) => normalizeAgentName(agent.label).includes(normalizeAgentName(token)));
      if (!named && !partial) continue;
      if (conditional) {
        conflict('Executor request is conditional or ambiguous; clarify the selection.');
        continue;
      }
      try {
        const agent = resolveAgent(named?.name ?? token!, targets);
        if (!agent.runtimeId || targets.find((target) => target.id === agent.runtimeId)?.executionDisabledByUser) {
          conflict('Executor name does not identify one enabled callable runtime.');
          continue;
        }
        const exclude = /不要|别|禁止|不再|^不|排除|do not|don't|exclude/iu.test(match[0]);
        if (exclude) policy.excludeRuntimeIds.push(agent.runtimeId);
        else assignments.add(agent.runtimeId);
      } catch {
        conflict('Executor name matches multiple cards; clarify the selection.');
      }
    }
  }
  // Laya judges whether a name is an instruction. A topic mention ("when is DeepSeek cheapest?") must not pin a card.
  if (choices && (choices.executor_intent === 'none' || choices.executor_intent === 'mention_only')) {
    assignments.clear();
    policy.excludeRuntimeIds = [];
  }
  policy.excludeRuntimeIds = [...new Set(policy.excludeRuntimeIds)];
  if (assignments.size > 1) conflict('Multiple executor assignments need clarification.');
  const assigned = assignments.size === 1 ? [...assignments][0] : undefined;
  if (assigned && policy.excludeRuntimeIds.includes(assigned))
    conflict('The same executor is both assigned and excluded.');
  if (
    input.runtimeId &&
    ((assigned && assigned !== input.runtimeId) || policy.excludeRuntimeIds.includes(input.runtimeId))
  )
    conflict('Current executor request conflicts with the explicit UI runtime selection.');
  if (input.provider && assigned && targets.find((target) => target.id === assigned)?.provider !== input.provider)
    conflict('Current executor request conflicts with the explicit UI provider selection.');
  if (assigned && !policy.conflicts.length && !input.runtimeId && !input.provider) {
    policy.runtimeId = assigned;
    policy.reasons.push('Current message explicitly names this executor; normal routing constraints still apply.');
  }
  if (policy.excludeRuntimeIds.length) policy.reasons.push('Current message explicitly excludes these executors.');

  if (choices) {
    if (policy.permissionMode === 'read-only' && choices.project_access === 'write')
      conflict('Model project-access judgment conflicts with the explicit read-only instruction.');
    if (policy.prohibitCommands && choices.run_commands === 'yes')
      conflict('Model command judgment conflicts with the explicit execution prohibition.');
    if (commandRequested && choices.run_commands === 'no')
      conflict('Model command judgment missed an explicit request to run tests or commands.');
    if (browserRequested && choices.browser_use === 'no')
      conflict('Model browser judgment missed an explicit action on a logged-in webpage.');
    if (
      attachmentRequested &&
      !ignoredAttachments &&
      state.attachments.length &&
      choices.input_modality === 'text' &&
      state.attachments.some((attachment) => /image|audio|video/iu.test(attachment.kind + ' ' + attachment.mime_type))
    )
      conflict('Model input-modality judgment conflicts with an explicit request to inspect attached media.');
    if (
      (choices.executor_intent === 'assign' ||
        choices.executor_intent === 'reassign' ||
        choices.executor_intent === 'exclude') &&
      !assignments.size &&
      !policy.excludeRuntimeIds.length
    )
      conflict('Model executor intent lacks an unambiguous current-message instruction.');
    if (!policy.conflicts.some((item) => /Model (?:command|input-modality|browser) judgment/.test(item))) {
      const category = {
        conversation: 'other',
        coding: 'code',
        research: 'research',
        writing: 'writing',
        translation: 'translation',
        data_analysis: 'code',
        automation: 'code',
        media: choices.input_modality === 'image' && choices.media_output === 'none' ? 'vision' : 'other',
      }[choices.task_type as Exclude<typeof choices.task_type, 'mixed' | 'unclear'>];
      if (category)
        policy.category = {
          id: category,
          confidence: 'low',
          reason: 'Laya suggestion; existing strict rules and explicit selections take precedence.',
        };
      if (choices.difficulty !== 'unclear') {
        if (!input.model)
          policy.suggestedTier = { simple: 'light', standard: 'standard', complex: 'strong' }[
            choices.difficulty
          ] as LayaPolicy['suggestedTier'];
        if (!input.effort)
          policy.suggestedEffort = { simple: 'low', standard: 'medium', complex: 'high' }[
            choices.difficulty
          ] as LayaPolicy['suggestedEffort'];
      }
    }
  } else policy.reasons.push('Incomplete or unavailable model judgment; semantic choices are not applied.');
  const unjudged =
    compacted ||
    (inference.status === 'fallback' &&
      ['warming', 'starting', 'timeout', 'busy', 'cooldown', 'error', 'input_too_large', 'invalid_state'].includes(
        inference.reason,
      ));
  // The strong/high precaution is for work of unknown size. When the judge simply did not answer, and the local
  // rules will handle the message as a reply (no task, no planning, no file changes), it keeps the ordinary tier:
  // the judge was unavailable for about a quarter of messages, and each plain question then went to the strongest
  // model at high effort. A compacted input or an unreadable brief is still treated as work of unknown size.
  const reply = unjudged && !compacted && !input.briefUnreadable && input.replyOnly === true;
  if (reply) policy.reasons.push('Classifier unavailable; the rules handle this as a reply at the ordinary tier.');
  else if (unjudged || input.briefUnreadable) {
    policy.needsAssessment = true;
    policy.reasons.push(
      unjudged
        ? 'Classifier input was compacted or unavailable; use provisional strong/high advice and assess the full request in parallel.'
        : 'The referenced brief cannot be read; treat the task as an implementation of unknown size: provisional strong/high advice and a parallel assessment.',
    );
    if (!input.model) policy.suggestedTier = 'strong';
    if (!input.effort) policy.suggestedEffort = 'high';
  }
  policy.applied = !!(
    policy.runtimeId ||
    policy.excludeRuntimeIds.length ||
    policy.permissionMode ||
    policy.prohibitCommands ||
    policy.category ||
    policy.suggestedTier ||
    policy.suggestedEffort
  );
  return policy;
}
