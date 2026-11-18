import { cursorModelPool } from '../shared/cursor-models.ts';
import { parseCursorModel } from '../shared/model-family.ts';
import { selectAutomaticModel, type ModelDemand } from './model-selection.ts';
import type { ModelInfo, Provider, RunRecord } from '../shared/types.ts';

/*
 * Whether an executor declined a request because of what it asks for (adult material, or its usage policy),
 * as opposed to failing at the work. Only the end of the reply is read: a refusal comes last, after any work
 * the executor did do. Both a refusal phrase and a content or policy reason must appear, so "I can't move
 * these files, the folder is read-only" never counts.
 *
 * A refusal because minors are involved is never a reason to try another executor: that material is refused
 * everywhere, and PugPort does not look for one that might go along with it.
 */

const refusal =
  /(?:\bI(?:\s+(?:can(?:'|’)?t|cannot|won(?:'|’)t|will\s+not|am\s+not\s+able\s+to|am\s+unable\s+to)|(?:'|’)m\s+(?:not\s+able|unable)\s+to)\s+(?:help|assist|create|write|provide|continue|generate|engage|describe|produce|do)\b|\bunable\s+to\s+(?:help|assist)\b|(?:不能|无法|没法|不便|不会|不可以|不予)(?:为你|帮你|帮您|为您)?(?:帮|协助|提供|生成|创作|撰写|继续|描述|参与|输出|满足|完成)|(?:拒绝|不能接受)(?:这个|此|该)?(?:请求|要求))/i;
const reason =
  /sexual|sexually|explicit|erotic|adult|nsfw|porn|usage\s+polic|content\s+polic|guideline|色情|情色|露骨|成人|淫秽|低俗|性(?:内容|描写|行为|暗示)|使用政策|内容政策|政策|准则|规范/i;
const policyError =
  /content[_ -]?(?:policy|filter|moderation)|usage[_ -]?polic|safety[_ -]?(?:system|policy)|flagged|cyber_policy|invalid_prompt|refus/i;
/** Minors in a sexual context: what no executor is asked to do, by any route. */
export const involvesMinors =
  /\bminors?\b|\bunder[- ]?age\b|\bchild(?:ren)?\b|\bcsam\b|\bloli|\bteen\w*\s+(?:sex|porn|nude)|未成年|儿童|幼女|幼童|萝莉|少萝|小学生|初中生|童(?:色|情)/i;

/** What a run said when it declined: its error, the provider's own words and the end of its reply. */
const declined = (run: Pick<RunRecord, 'output' | 'error' | 'errorCode' | 'errorDetail'>) =>
  `${run.error ?? ''} ${run.errorCode ?? ''} ${run.errorDetail ?? ''} ${run.output.trim().slice(-800)}`;

/** The refusal mentions minors, so the request goes nowhere else. */
export const refusalMentionsMinors = (run: Pick<RunRecord, 'output' | 'error' | 'errorCode' | 'errorDetail'>) =>
  involvesMinors.test(declined(run));

/** The failure code for a provider that blocked the request under its usage or content policy. */
export const providerRefusedCode = 'provider-refused';

/*
 * A provider's own policy block, as its API or Pi reports it: Anthropic's `refusal` stop reason and its Usage
 * Policy block, OpenAI and Azure content filters and safety-system rejections, xAI usage guidelines, Gemini block
 * reasons, DeepSeek, Moonshot and Zhipu moderation. Bad requests, sandbox or permission denials and closed
 * connections never match: each pattern names a policy or a filter, not merely a rejection.
 */
const providerRefusal = new RegExp(
  [
    String.raw`\bstop_reason["']?\s*[:=]\s*["']?refusal\b`,
    String.raw`\bmodel refused to complete the request`,
    String.raw`\bprovider (?:stopped with|finish_reason):\s*sensitive\b`,
    String.raw`\b(?:blocked|rejected|flagged|violat\w*)\b.{0,80}\b(?:usage|content|acceptable[ -]use)[ _-]?(?:polic|guideline)`,
    String.raw`\bcontent_filter\b|content_policy_violation|ResponsibleAIPolicyViolation|cyber_policy`,
    String.raw`\brejected as a result of (?:our|the) safety system`,
    String.raw`\bblockReason["']?\s*[:=]\s*["']?(?:SAFETY|PROHIBITED_CONTENT|BLOCKLIST)`,
    String.raw`\bContent Exists Risk\b`,
    String.raw`\bconsidered (?:as )?high risk\b`,
    String.raw`包含不安全或敏感内容`,
  ].join('|'),
  'i',
);

/** The provider blocked the request on policy grounds, judged from its error message only. */
export const providerRefused = (message: string | undefined) => !!message && providerRefusal.test(message);

/** A turn tries at most this many model vendors after a policy block, the first one included. */
export const maxRefusalVendors = 3;

const vendorModels: [RegExp, string][] = [
  [/^(?:claude|opus|sonnet|haiku|fable)\b/, 'anthropic'],
  [/^(?:gpt|chatgpt|codex|o\d)\b/, 'openai'],
  [/^grok/, 'xai'],
  [/^(?:gemini|gemma)/, 'google'],
  [/^glm/, 'zhipu'],
  [/^(?:kimi|moonshot)/, 'moonshot'],
  [/^deepseek/, 'deepseek'],
  [/^qwen/, 'qwen'],
  [/^minimax/, 'minimax'],
  [/^(?:mistral|codestral|devstral|magistral)/, 'mistral'],
  [/^(?:llama|meta)/, 'meta'],
];
const vendorProviders: Record<string, string> = {
  claude: 'anthropic',
  codex: 'openai',
  grok: 'xai',
  gemini: 'google',
  'gemini-free': 'google',
  'moonshot-cn': 'moonshot',
  'zai-cn': 'zhipu',
  'qwen-cn': 'qwen',
  'minimax-cn': 'minimax',
  'meta-model-api': 'meta',
};

/**
 * Whose usage policy a run is held to: the model's vendor, whichever CLI, card or Cursor pool carries it. A
 * refusal by Anthropic's API therefore also rules out Claude Code and Claude through Cursor for that turn.
 */
export function refusalVendor(provider: Provider | undefined, apiProvider: string | undefined, model: string): string {
  const id = (provider === 'cursor' ? parseCursorModel(model).family : model).toLowerCase().split('/').at(-1) ?? '';
  const known = vendorModels.find(([pattern]) => pattern.test(id))?.[1];
  if (known) return known;
  const source = provider === 'pi' || apiProvider ? (apiProvider ?? 'pi') : (provider ?? 'unknown');
  return vendorProviders[source] ?? source;
}

export function refusedForContent(run: Pick<RunRecord, 'status' | 'output' | 'error' | 'errorCode'>): boolean {
  if (refusalMentionsMinors(run)) return false;
  if (run.status === 'failed' && policyError.test(`${run.error ?? ''} ${run.errorCode ?? ''}`)) return true;
  if (run.status !== 'completed' && run.status !== 'failed') return false;
  const tail = run.output.trim().slice(-800);
  return !!tail && refusal.test(tail) && reason.test(tail);
}

/**
 * Where a message Codex or Claude refused for its content goes next, in order: native Grok, Grok through Cursor
 * (Cursor's own pool), then GLM through Cursor. Each step runs once, and a message is relayed at most twice.
 */
export const contentRelaySteps = ['grok', 'cursor-grok', 'cursor-glm'] as const;
export type ContentRelayStep = (typeof contentRelaySteps)[number];
export const maxContentRelays = 2;
export const contentRelayLimit = (candidateCount = 0) => Math.min(4, Math.max(maxContentRelays, candidateCount));

/** The relay step a run belongs to, from the executor and model it ran on. */
export function contentRelayStep(provider: Provider | undefined, model: string): ContentRelayStep | undefined {
  if (provider === 'grok') return 'grok';
  if (provider !== 'cursor') return undefined;
  const family = parseCursorModel(model).family;
  return /^grok-/.test(family) ? 'cursor-grok' : /^glm-/.test(family) ? 'cursor-glm' : undefined;
}

const version = (id: string) =>
  (/(\d+(?:[.p]\d+)*)/.exec(parseCursorModel(id).family)?.[1] ?? '').split(/[.p]/).map(Number);
const newer = (a: number[], b: number[]) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++)
    if ((b[i] ?? 0) !== (a[i] ?? 0)) return (b[i] ?? 0) - (a[i] ?? 0);
  return 0;
};

/**
 * The Cursor model a step runs on: the newest Grok in Cursor's own pool, or GLM 5.3 (`glm-5p3`), else the newest
 * full GLM, else a lighter one (Flash, Air). Undefined when Cursor offers none of them.
 */
export function contentRelayModel(
  models: ModelInfo[],
  step: Exclude<ContentRelayStep, 'grok'>,
  demand: ModelDemand,
): ModelInfo | undefined {
  const family = (model: ModelInfo) => parseCursorModel(model.id).family;
  if (step === 'cursor-grok')
    return selectAutomaticModel(
      models.filter(
        (model) => /^grok-/.test(family(model)) && (model.quotaPool ?? cursorModelPool(model.id)) === 'cursor',
      ),
      'cursor',
      demand,
    );
  const glm = models.filter((model) => /^glm-/.test(family(model)));
  const exact = glm.filter((model) => family(model) === 'glm-5p3');
  if (exact.length) return selectAutomaticModel(exact, 'cursor', demand);
  const light = (model: ModelInfo) => /flash|air|mini|lite/i.test(family(model));
  return [...glm].sort(
    (a, b) =>
      Number(light(a)) - Number(light(b)) ||
      newer(version(a.id), version(b.id)) ||
      Number(parseCursorModel(a.id).fast) - Number(parseCursorModel(b.id).fast),
  )[0];
}
