import type { MessageInput } from '../shared/types.ts';
import { requestsFileChanges } from './task-file-outcome.ts';

export const writeReauthorization =
  '执行原始请求的剩余工作。本次明确允许写入，替代先前的全局只读要求；其他范围限制仍有效。先核对已有结果，不重放已完成或未确认的操作。';

const explanation = (text: string) =>
  /^(?:请(?:你)?\s*)?(?:解释|讲解|说明|分析|比较|讨论|介绍|看看|如何|怎么|为什么|是否|能否|可不可以|你觉得)/u.test(
    text,
  ) ||
  /^(?:please\s+)?(?:explain|describe|compare|discuss|analy[sz]e|how\b|why\b|what\b|should\b|is\b|could\s+you\s+explain)/i.test(
    text,
  ) ||
  /(?:有什么(?:影响|区别|风险)|会不会|会怎样|会怎么样|是什么意思|是否合适|可行吗)/u.test(text);

const imperative = (text: string) =>
  /^(?:(?:请|请你|帮我|现在|直接|继续|先)\s*)*(?:(?:按|按照|根据)[^，。！？；\n]{1,40}?(?:要求|几点|建议|步骤|说明)\s*)?(?:修改|修复|更新|改|修|重做|重新打包|写入)(?=\s|文件|代码|界面|页面|测试|报告|产物|Mod|[a-zA-Z])/u.test(
    text,
  ) ||
  /^(?:(?:请|请你|帮我|替我|麻烦你|现在|直接|然后)\s*)*(?:创建|新建|生成|制作|实现|修改|修复|更新|删除|重构|编写|写一个|写一份|整理|移动|搬移|搬走|迁移|归档|重命名|搭建|把.{1,80}(?:改成|改为|替换|删除|加上|移动|移到|搬到|搬走|归档|重命名))/u.test(
    text,
  ) ||
  /^(?:(?:那(?:你|就)?|你|就|请(?:你)?|帮我|直接|现在)\s*)*(?:处理|执行|照做|继续|推进)(?:一下|下|吧|啊|呀|好了|好|起来|就行|就好)*[。！!?\s]*$/u.test(
    text,
  ) ||
  /^(?:please\s+)?(?:create|build|implement|edit|modify|fix|update|rewrite|rebuild|repackage|delete|refactor|write|generate|make|move|rename|organize|archive)\b/i.test(
    text,
  ) ||
  /^(?:can|could|would)\s+you\s+(?:please\s+)?(?:create|build|implement|edit|modify|fix|update|rewrite|rebuild|repackage|write|generate|make|move|rename|organize|archive)\b/i.test(
    text,
  );

/** Quoted examples are evidence, while an explicitly adopted requirement still governs this action. */
export function actionText(content: string): string {
  const adopted = (offset: number) =>
    /(?:按(?:下面|以下)要求执行|遵守(?:下面|以下)要求|本次要求|follow (?:these|the following) instructions|current requirements)\s*[：:]\s*$/iu.test(
      content.slice(0, offset),
    );
  return content
    .replace(/```[^]*?```|~~~[^]*?~~~|(?:^[ \t]*>[^\n]*(?:\n|$))+/gmu, (quote, offset: number) =>
      adopted(offset) ? quote.replace(/^```[^\n]*\n|^~~~[^\n]*\n|```$|~~~$|^[ \t]*>[ \t]?/gmu, '') : '',
    )
    .replace(
      /(?:引用|原话|(?:之前|此前|上次)(?:模型|助手)?说|他说|她说|别人说|注意事项示例)\s*[：:]?\s*(?:“[^”]*”|「[^」]*」|"[^"\n]*"|'[^'\n]*')/gu,
      '',
    )
    .replace(/(?:他说|她说|别人说|之前模型说)\s*[：:][^。！？\n]*(?:[。！？]|$)/gu, '')
    .replace(
      /\b(?:quote|example|previously said|they said|he said|she said)\s*:?\s*(?:“[^”]*”|"[^"\n]*"|'[^'\n]*')/giu,
      '',
    )
    .replace(/(?:本次要求|这次要求|当前要求)\s*[：:]\s*[“「"]([^”」"]*)[”」"]/gu, '$1')
    .trim();
}

function globalProhibition(text: string, prohibition: RegExp, target: RegExp): string | undefined {
  for (const match of text.matchAll(prohibition)) {
    if (/(?:只读文件|用户设置|配置文件)\s*$/u.test(text.slice(0, match.index))) continue;
    const tail = target.exec(text.slice(match.index + match[0].length));
    if (tail) return (match[0] + tail[0]).trim();
  }
}

function deniesExecution(text: string): string | undefined {
  // Recognize current general bans; a named file or operation remains an executor scope constraint.
  const chineseTarget =
    /^[ \t]*(?:(?:(?:任何(?:的)?|所有(?:的)?|这些|这份|那份|这|我的|项目中的)?(?:文件|代码|内容|正文|文档|原文))|任何(?:东西|事情)?|它)?(?:了|啦|吧|啊|呀)?[ \t]*(?=$|[\r\n，。！？、；：,!?;:]|\.(?:\s|$))/u;
  const englishTarget =
    /^[ \t]*(?:anything|everything|(?:(?:any|all|the|these|those|my|your|project)\s+)*(?:files?|code|content|documents?|commands?))?(?:[ \t]+(?:yet|now|at\s+all|for\s+now))?[ \t]*(?=$|[\r\n,!?;:]|\.(?:\s|$)|\b(?:but|and|then)\b)/i;
  return (
    // Colloquial stop instructions use "改" alone. Do not confuse "别改用 Claude"
    // (an executor preference) or descriptive read-only attributes with a file permission change.
    // Chinese has no whitespace word boundary: 别 inside 分别/特别/类别 etc. is not a stop instruction.
    globalProhibition(
      text,
      /(?:不要|(?<![分个特级差告辨鉴识性区离类组甄派道永送作国])别|无需|不用|先不|暂不|不应|禁止)(?:再|直接|实际|立即|真正|擅自)?改/gu,
      chineseTarget,
    ) ||
    globalProhibition(text, /(?:只|仅)(?:需|要)?(?:看|查看|检查|分析)[^，。！？；\n]{0,30}不改/gu, chineseTarget) ||
    /(?:^|[，。！？；,;\n])\s*(?:本次|这次|当前)?\s*(?:先|暂时)?\s*(?:保持|改为|设为|切到)?只读(?:模式)?(?=$|[\s，。！？、；：,.!?;:]|(?:检查|查看|分析|审查|审核|核对|文件|代码|正文|文档|内容))/u.exec(
      text,
    )?.[0] ||
    globalProhibition(text, /(?:^|[，。！？；,;\n])\s*(?:本次|这次|当前)?\s*(?:先|暂时)?\s*不改/gu, chineseTarget) ||
    globalProhibition(
      text,
      /(?:不要|(?<![分个特级差告辨鉴识性区离类组甄派道永送作国])别|无需|不用|先不|暂不|不应|禁止|只(?:需|要))(?:再|直接|实际|立即|真正|擅自)?(?:修改|改动|创建|实现|写入|执行|运行|编辑|处理|动|碰)/gu,
      chineseTarget,
    ) ||
    globalProhibition(
      text,
      /(?:不做|不作|不进行|不要做|不要进行)(?:任何|实际的?|文件)?(?:修改|改动|编辑|写入|操作)/gu,
      chineseTarget,
    ) ||
    /(?:只|仅)(?:需|要)?(?:给出?|提供|生成|讨论|分析|解释|描述|说明)(?:一份|一个)?(?:计划|方案|建议|思路|说明)/u.exec(
      text,
    )?.[0] ||
    globalProhibition(
      text,
      /\b(?:do\s+not|don't|don’t|never|without)\s+(?:(?:actually|directly|yet)\s+)?(?:(?:delet(?:e|ing)|mov(?:e|ing)|renam(?:e|ing)|archiv(?:e|ing))\s+(?:and|or)\s+)*(?:edit(?:ing)?|chang(?:e|ing)|creat(?:e|ing)|writ(?:e|ing)|implement(?:ing)?|run(?:ning)?|execut(?:e|ing)|modif(?:y|ying)|touch(?:ing)?|alter(?:ing)?)(?:\s+(?:and|or)\s+(?:edit(?:ing)?|chang(?:e|ing)|creat(?:e|ing)|writ(?:e|ing)|implement(?:ing)?|run(?:ning)?|execut(?:e|ing)|delet(?:e|ing)|modif(?:y|ying)|touch(?:ing)?|alter(?:ing)?|mov(?:e|ing)|renam(?:e|ing)|archiv(?:e|ing)))*\b/gi,
      englishTarget,
    ) ||
    globalProhibition(
      text,
      /\b(?:do\s+not|don't|don’t|never|without)\s+(?:mak(?:e|ing)|perform(?:ing)?|apply(?:ing)?)\s+(?:(?:any|actual|file|code|further)\s+)*(?:edits?|changes?|modifications?|writes?|operations?)\b/gi,
      englishTarget,
    ) ||
    globalProhibition(
      text,
      /\bno\s+(?:(?:file|code|actual)\s+)?(?:edits?|changes?|modifications?|writes?|execution)\b/gi,
      englishTarget,
    ) ||
    /\b(?:only|just)\s+(?:explain|discuss|analy[sz]e|describe|plan)\b/i.exec(text)?.[0] ||
    /\b(?:write|edit)\s+(?:access|permissions?)\s+(?:is|are|must\s+(?:be|remain)|should\s+(?:be|remain))\s+(?:disabled|forbidden|denied|off)\b/i.exec(
      text,
    )?.[0] ||
    /(?:^|[,.!?;\n])\s*(?:please\s+)?(?:keep\s+(?:this|it|everything)\s+)?read[- ]only\b/i.exec(text)?.[0] ||
    undefined
  );
}

function hasPlanFileTarget(text: string): boolean {
  // A prose plan is not permission to write a file; an explicit save target is.
  return (
    /\b(?:write|save|create|generate|put)\b[^\n;；]*\b(?:to|into|in|as)\s+(?:(?:a|the|new)\s+)?(?:file\b|[`"']?[^\s`"'<>]+\.(?:md|txt|rst|docx|pdf)\b)/i.test(
      text,
    ) ||
    /^(?:please\s+)?(?:write|create|generate)\s+(?:(?:a|the|new)\s+)?[`"']?[^\s`"'<>]+\.(?:md|txt|rst|docx|pdf)\b/i.test(
      text,
    ) ||
    /(?:写入|保存到|保存为|存到|写到)[^\n;；]*(?:文件|\.(?:md|txt|rst|docx|pdf)\b)/iu.test(text)
  );
}

function isProsePlanRequest(text: string): boolean {
  return (
    /^(?:(?:please|just|only)\s+)*(?:(?:can|could|would)\s+you\s+(?:please\s+)?)?(?:create|write|generate|draft|provide|make|outline)\s+(?:(?:an?|the)\s+)?(?:(?:detailed|implementation|migration|development|action|change|project|test|release|rollout)\s+)*(?:plan|proposal|outline)(?=\s+(?:for|to|of|about|with|that|in|on|as|using)\b|[,.!?;:]|$)/i.test(
      text,
    ) ||
    /^(?:(?:请|请你|帮我|替我|麻烦你|先|只|仅)\s*)*(?:生成|创建|编写|写|制定|拟定|提供|给出|整理)(?:一(?:份|个|套))?[^，。！？；\n]{0,20}(?:计划|方案|提纲)(?=[，。！？；：\s]|$)/u.test(
      text,
    )
  );
}

/** Asked as a question ("how do I…", "怎么…", "有什么影响") rather than as something to do. */
function questionShaped(text: string): boolean {
  return (
    explanation(text) ||
    /^(?:请(?:你)?\s*)?(?:如何|怎么|为什么|是否|能否|可不可以|你觉得)/u.test(text) ||
    /^(?:please\s+)?(?:how|why|what|should|is|can\s+I|could\s+I)\b/i.test(text) ||
    // Ends as a question: "处理器性能怎么样？", "Could you assess the two alternatives?".
    /(?:[？?]|吗|呢|怎么样|怎样|是什么|为什么|多少)[\s。！!）)、，,~～]*$/u.test(text)
  );
}

/** Positive request evidence from the words alone, for when no task judgment is available. */
export function inspectActionIntent(content: string): {
  explicitAction: boolean;
  prohibitsWrite: boolean;
  readOnlyTrigger?: string;
} {
  const text = actionText(content);
  const clauses = text
    .split(/(?:[。！？!?;；\n]+|\b(?:and\s+then|then)\b|然后|并且|接着)/iu)
    .map((clause) => clause.trim())
    .filter(Boolean);
  const fileTarget = hasPlanFileTarget(text);
  const action = (clause: string) =>
    !explanation(clause) &&
    (imperative(clause) ||
      /^(?:I\s+(?:want|need)\s+you\s+to|let'?s)\s+(?:create|build|implement|edit|modify|fix|update|delete|refactor|write|generate|make)\b/i.test(
        clause,
      ) ||
      /^(?:我(?:想|需要|希望)你|请你帮我)(?:创建|新建|生成|实现|修改|修复|更新|删除|重构|编写)/u.test(clause));
  const concreteAction = clauses.some((clause) => action(clause) && !isProsePlanRequest(clause));
  const planningOnly = !fileTarget && !concreteAction && clauses.some(isProsePlanRequest);
  const trigger = deniesExecution(text) || (planningOnly ? clauses.find(isProsePlanRequest) : undefined);
  const prohibitsWrite = !!trigger;
  const question =
    /^(?:请(?:你)?\s*)?(?:如何|怎么|为什么|是否|能否|可不可以|你觉得)/u.test(text) ||
    /^(?:please\s+)?(?:how|why|what|should|is|can\s+I|could\s+I)\b/i.test(text);
  return {
    explicitAction: !prohibitsWrite && !question && ((fileTarget && clauses.some(action)) || concreteAction),
    prohibitsWrite,
    ...(trigger
      ? {
          readOnlyTrigger: trigger
            .replace(/^[\s，。！？；,.!?;]+|[\s，。！？；,.!?;]+$/gu, '')
            .trim()
            .slice(0, 100),
        }
      : {}),
  };
}

function readonly(input: MessageInput, mode = input.mode): MessageInput {
  return {
    ...input,
    mode,
    permissionMode: 'read-only',
    verificationCommand: undefined,
    permissionOrigin: { ...(input.permissionOrigin ?? { source: 'user' }), mode: 'read-only' },
  };
}

// These short standalone stops also select reply handling. Current global bans in longer messages
// are resolved separately; quotations and scoped operation restrictions do not revoke write access.
export function globalReadOnlyTrigger(text: string): string | undefined {
  const phrase = text
    .trim()
    .replace(/[。.!！]+$/u, '')
    .trim();
  return [
    /^只看不改$/u,
    /^只给(?:出)?方案$/u,
    /^只读$/u,
    /^不要改任何文件$/u,
    /^don['’]t change anything$/i,
    /^read-only please$/i,
  ].some((pattern) => pattern.test(phrase))
    ? phrase
    : undefined;
}

export function hasExplicitWrite(input: MessageInput): boolean {
  return (
    input.explicitWrite === true ||
    input.permissionReauthorized === true ||
    (input.explicitWrite === undefined && input.mode === 'build')
  );
}

function messageScopeNote(text: string): string | undefined {
  const restrictions = text
    .split(/[。！？!?;；\n]+/u)
    .map((part) => part.trim())
    .filter(
      (part) =>
        deniesExecution(part) ||
        /(?:不要|禁止|先不|暂不|(?<![分个特级差告辨鉴识性区离类组甄派道永送作国])别)(?:再|直接|擅自)?(?:删|移动|搬走|搬移|迁移|重命名|归档|改|动|碰|写|编辑|执行|运行)|\b(?:do\s+not|don't|don’t|never|without)\s+(?:\w+\s+)?(?:delete|move|rename|archive|edit|change|modify|write|touch|alter|create|implement|run|execute)\b/iu.test(
          part,
        ),
    );
  return (
    restrictions
      .map((part) => part.replace(/[。.!！]+$/u, ''))
      .join('；')
      .replace(/\s+/g, ' ') || inspectActionIntent(text).readOnlyTrigger
  );
}

export function scopePrompt(input: MessageInput): string {
  const note =
    input.scopeNote ??
    (input.explicitWrite && input.permissionMode === 'workspace-write' ? input.readOnlyTrigger : undefined);
  return note ? `范围限制（来自你的消息）：${note.replace(/\s+/g, ' ')}` : '';
}

/**
 * The file permission is the user's choice in the composer: "可写入" stays writable and "只读" stays read-only.
 * A current global stop narrows it only without an explicit write grant. The wording decides how the message is
 * handled (a direct reply, or a task with planning), never what it may do: a follow-up like "可以去分类了吗？"
 * reads as a question but is a request.
 */
export function resolveOneForAllInput(input: MessageInput): MessageInput {
  const words = actionText(input.intentText ?? input.content);
  const intent = inspectActionIntent(words);
  const explicitWrite = hasExplicitWrite(input);
  const stop = globalReadOnlyTrigger(words);
  // Keep an already resolved stop visible when a later layer sees the resulting chat mode.
  const clauseStop = input.routeDecision
    ? words
        .split(/[，,;；。！？!?\n]/u)
        .map(globalReadOnlyTrigger)
        .find(Boolean)
    : undefined;
  const trigger = !explicitWrite ? stop || clauseStop : undefined;
  input = {
    ...input,
    explicitWrite,
    readOnlyTrigger: trigger,
    scopeNote: trigger ? undefined : messageScopeNote(words),
  };
  const bounded =
    input.permissionOrigin?.mode === input.permissionMode && !['user', 'text'].includes(input.permissionOrigin.source);
  input.permissionOrigin = bounded
    ? input.permissionOrigin
    : trigger
      ? { mode: 'read-only', source: 'text', note: trigger }
      : input.scopeNote && input.permissionMode === 'workspace-write'
        ? { mode: 'workspace-write', source: 'text', note: input.scopeNote }
        : { mode: input.permissionMode, source: 'user' };
  if (trigger) {
    input = readonly(input);
    if (stop) return readonly(input, 'chat');
  }
  if (input.mode === 'chat') return explicitWrite ? reply(input) : readonly(input);
  if (input.mode !== 'auto') return input.permissionMode === 'read-only' ? readonly(input) : { ...input };
  const decision = input.routeDecision;
  if (decision) {
    const requestedWrite = input.permissionMode === 'workspace-write' && writeTask(input);
    if (requestedWrite) input.routeDecision = { ...decision, handling: 'task', writes: true };
    const mode = decision.handling === 'reply' && !requestedWrite ? 'chat' : 'build';
    return input.permissionMode === 'read-only'
      ? readonly(input, mode)
      : mode === 'chat'
        ? reply(input)
        : { ...input, mode };
  }
  const text = words.trim();
  if (input.permissionMode === 'read-only')
    return readonly(input, imperative(text) && !explanation(text) && intent.explicitAction ? 'build' : 'chat');
  return !intent.explicitAction && !writeTask(input) && (questionShaped(text) || intent.prohibitsWrite)
    ? reply(input)
    : { ...input, mode: 'build' };
}

/** A writable message that asks for file changes is a task however it is worded: never a reply-only plan. */
function writeTask(input: MessageInput): boolean {
  return hasExplicitWrite(input) && requestsFileChanges(input.intentText ?? input.content, true);
}

/** A direct reply that keeps the user's permission (no planning, no verification command). */
function reply(input: MessageInput): MessageInput {
  return { ...input, mode: 'chat', verificationCommand: undefined };
}

/** Call with the original input, before local resolution has consumed its auto mode. */
export function applyTaskJudgment(
  input: MessageInput,
  judgment: { status: string; intent?: 'question' | 'action' | 'uncertain' },
): MessageInput {
  const local = resolveOneForAllInput(input);
  if (input.routeDecision) return local;
  if (judgment.status !== 'accepted' || input.mode !== 'auto') return local;
  if (local.permissionMode === 'read-only') return judgment.intent === 'question' ? readonly(local, 'chat') : local;
  // The judgment sees the message without the conversation: it shapes the handling, the permission stays.
  if (judgment.intent === 'question') return local.mode === 'build' && writeTask(local) ? local : reply(local);
  // Worded as a question ("How do I…?") it stays a direct reply, which may still act on its own words.
  if (judgment.intent === 'action') return local.mode === 'chat' ? local : { ...local, mode: 'build' };
  return local;
}
