import { isApiHarness, isRetiredProvider, providerSpec } from '../shared/provider-registry.ts';
import { sourceMayLog } from '../shared/free-privacy.ts';
import { trustedCommandTurn } from '../shared/permission-reason.ts';
import { apiBudgetConcurrency } from './api-budget.ts';
import { apiCreditPace, isFreePreset } from '../shared/api-providers.ts';
import { effortLevels, nearestEffort, orderedEfforts } from '../shared/effort.ts';
import { isShortQuotaWindow, quotaWindowReservePercent } from '../shared/quota-reserve.ts';
import { routeCategoryLabels, routePolicy, type RouteCategory } from '../shared/route-policy.ts';
import { routeKey, routeKeyLabel } from '../shared/api-providers.ts';
import {
  chooseCursorPool,
  cursorModelPoolLabel,
  quotaWindowsForModel,
  type CursorPool,
} from '../shared/cursor-models.ts';
import {
  cursorEquivalent,
  cursorFamilies,
  cursorModelForPin,
  nativeFamily,
  parseCursorModel,
} from '../shared/model-family.ts';
import { supportsImageInput } from '../shared/image-input.ts';
import { checkedSubscriptionCli } from '../shared/runtime-readiness.ts';
import {
  automaticEffort,
  isEffortLevel,
  modelDemand,
  modelSelectionReasons,
  modelTier,
  strongCostFamilies,
  tierLabels,
  selectAutomaticModel,
  type ModelDemand,
} from './model-selection.ts';
import { memberAllowance, type MemberAllowance } from './member-allocation.ts';
import { automaticApiTarget, automaticExecutorAllowed, paidApiAutoSkipReason } from '../shared/automatic-executors.ts';
import { candidateInputs, checklistCandidateReason, matchRule } from './routing-rules.ts';
import { taskCategory } from './task-category.ts';
import { requestsFileChanges } from './task-file-outcome.ts';
import { isSelfContainedChat, isSimpleFileLookup } from './planning-policy.ts';
import { categoryLabel, targetLabel } from '../shared/conversation-routing.ts';
import { routingModelExcluded } from '../shared/routing-profiles.ts';
import type { BurnRates } from './quota-history.ts';
import {
  estimateResponseLatency,
  type ResponseLatencyEstimate,
  type ResponseLatencySample,
} from './response-latency.ts';
import { quotaPlan } from '../shared/quota-summary.ts';
import {
  availableResetCards,
  cursorGrantWaste,
  creditWaste,
  wasteUrgency,
  quotaName,
  wasteReason,
  whenText,
  windowWaste,
  type QuotaWaste,
} from './quota-waste.ts';
import type {
  ModelInfo,
  Provider,
  QuotaWindow,
  RouteDecision,
  RunInput,
  RuntimeSnapshot,
  Settings,
  TaskKind,
  TaskSchedule,
} from '../shared/types.ts';

export type RouteUnavailableKind = 'quota' | 'refresh' | 'capacity' | 'unavailable';

export class RouteUnavailableError extends Error {
  readonly kind: RouteUnavailableKind;
  readonly retryAt?: string;
  readonly reasons: string[];
  /** Set only by explicit technical/resource rejection branches, never by provider prose. */
  technicalFallbackAllowed = false;
  /** A short wait for the session's own card: rules must not treat it as an unavailable candidate. */
  sessionWait = false;

  constructor(kind: RouteUnavailableKind, reasons: string[], retryAt?: string) {
    super(reasons.join('\n') || '没有已登录且可用的账号。请打开连接页登录或安装 CLI。');
    this.name = 'RouteUnavailableError';
    this.kind = kind;
    this.reasons = [...reasons];
    this.retryAt = retryAt;
  }
}

const concept = '(?:并发|并行|(?:软件|系统)?架构|重构|认证|安全|数据库迁移)';
// Complete definition requests only; project-specific analysis and additional operations keep normal classification.
const conceptExplanations = [
  new RegExp(
    `^(?:请)?(?:(?:简单|简要)(?:地)?)?(?:(?:解释|介绍|说明)(?:一下)?(?:什么是)?|什么是)${concept}(?:的(?:概念|含义|定义|基本原理)|是什么意思)?[。.!？?]?$`,
    'u',
  ),
  new RegExp(`^${concept}(?:是什么|是什么意思)[。.!？?]?$`, 'u'),
  /^(?:please\s+)?(?:(?:briefly|simply)\s+)?(?:explain|define|what is)\s+(?:concurrency|parallelism|(?:software |system )?architecture|refactoring|authentication|security|database migrations?)(?: in (?:simple|plain) (?:terms|English))?[.!?]?$/iu,
];

export function classify(prompt: string): { kind: TaskKind; reason: string } {
  if (isSelfContainedChat(prompt)) return { kind: 'routine', reason: '本地规则识别为独立问候或字面复述' };
  if (isSimpleFileLookup(prompt)) return { kind: 'routine', reason: '本地规则识别为单项文件检索或读取' };
  if (conceptExplanations.some((expression) => expression.test(prompt.trim())))
    return { kind: 'general', reason: '本地规则识别为完整的概念解释请求' };
  if (/(架构|重构|并发|数据库迁移|认证|安全|architecture|refactor|concurren|authentication|security)/i.test(prompt))
    return { kind: 'architecture', reason: '本地规则识别为架构或高复杂度任务' };
  // Generic process/business "design" says nothing about visual or interface work.
  if (
    /(配色|排版|视觉|交互|界面|海报|图标|徽标|(?:设计|美化).{0,20}(?:页面|网页|网站|前端)|(?:页面|网页|网站|前端).{0,20}(?:设计|美化)|\b(?:ui|ux|layout|typography|visual|landing page|graphic design|logo|poster)\b|\b(?:design|redesign|style)\b.{0,40}\b(?:page|website|dashboard|screen|banner)\b)/i.test(
      prompt,
    )
  )
    return { kind: 'design', reason: '本地规则识别为设计任务' };
  if (
    prompt.length < 500 &&
    /(改名|重命名|格式化|拼写|注释|整理|rename|format|typo|spelling|comment|hello|问好)/i.test(prompt)
  )
    return { kind: 'routine', reason: '本地规则识别为范围明确的基础任务' };
  return { kind: 'general', reason: '任务类型不明确，使用通用模型，不激进降级' };
}

type TaskFloor = { demand: ModelDemand; complex: boolean; preferLight: boolean; estimate: number };

/** Shared by the normal route and same-model quota failover. No extra classifier/model request. */
function taskModelPolicy(input: RunInput, settings: Settings) {
  const task = input.taskRoutingPrompt
    ? taskPolicy(
        {
          ...input,
          routingPrompt: input.taskRoutingPrompt,
          taskRoutingPrompt: undefined,
          plannerStep: false,
          kind: 'auto',
        },
        settings,
      )
    : undefined;
  return taskPolicy(input, settings, task);
}

const scopedComplexText =
  /跨模块|多个模块|多个文件|\b(?:multi[- ]module|multiple files|across (?:many|multiple) modules)\b/i;
/** Distinct paths named in a request. */
const requestPaths = (request: string) => [
  ...new Set(
    (request.match(/(?:[a-z0-9_.-]+[\\/])*[a-z0-9_.-]+\.[a-z0-9]+/gi) ?? [])
      .filter((path) => /[\\/]/.test(path) || (/\.[a-z][a-z0-9]*$/i.test(path) && !/^(?:e\.g|i\.e)$/i.test(path)))
      .map((path) => path.toLowerCase()),
  ),
];
/** Distinct paths named, or a stated size such as "about 15 files" / "15 个文件", whichever is larger. */
const requestFileCount = (request: string) =>
  Math.max(
    requestPaths(request).length,
    ...[...request.matchAll(/(\d+)\s*个?\s*(?:files?\b|文件)/giu)].map((match) => Number(match[1])),
  );
const codePath = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kts?|cs|cpp|cc|c|h|hpp|rb|php|swift|scala|sh|ps1|sql|vue|svelte)$/i;

/** A sourced judgment needs synthesis; a factual web lookup alone does not. */
function researchJudgment(request: string): boolean {
  return (
    /联网|上网|网上(?:查|搜)|搜一下|搜索|\b(?:search (?:the )?(?:web|internet)|web search|browse|research online|look (?:it |this )?up online)\b/i.test(
      request,
    ) &&
    /分析|判断|评估|评价|怎么看|(?:是不是|是否)(?:值得|可靠|合理|可信|靠谱|适合|可行)|\b(?:analy[sz]e|analysis|evaluate|assess|judge|trade[- ]offs?|what do you think|worth|reliable|credible)\b/i.test(
      request,
    )
  );
}

/** Local complexity also flags conflicts for Laya's assessment; sourced judgment keeps its routing floor. */
export function locallyComplex(request: string): boolean {
  return (
    classify(request).kind === 'architecture' ||
    scopedComplexText.test(request) ||
    requestFileCount(request) >= 5 ||
    researchJudgment(request)
  );
}

function taskPolicy(input: RunInput, settings: Settings, task?: TaskFloor) {
  const request = input.routingPrompt ?? input.prompt;
  const research = researchJudgment(request);
  const scopedComplex =
    scopedComplexText.test(request) ||
    (input.agentChild === true &&
      /复杂|多约束|根因|综合(?:判断|评估|权衡)|\b(?:complex|trade[- ]offs?|root cause|multi[- ]constraint)\b/i.test(
        request.replace(/不(?:太|算|是)?复杂|\bnot\s+(?:very\s+)?complex\b/gi, ''),
      ));
  // The same bounded lookup stays routine in the main task and in a delegated part.
  const fileCount = requestFileCount(request);
  const itemCount = (request.match(/^[ \t]*(?:\d+[.)、][ \t]*|[-*+][ \t]+)\S/gm) ?? []).length;
  const lookup = !scopedComplex && isSimpleFileLookup(request);
  const inferred = classify(request);
  const judgment = input.taskJudgment;
  const accepted = judgment?.status === 'accepted' && judgment.source === 'jev' ? judgment : undefined;
  let kind = input.kind === 'auto' ? (accepted?.kind ?? inferred.kind) : input.kind;
  if (lookup && !accepted?.kind && (input.kind === 'auto' || input.kind === 'general')) kind = 'routine';
  if (inferred.kind === 'architecture' && (input.kind === 'auto' || input.kind === 'general')) kind = 'architecture';
  if (input.kind === 'auto' && judgment?.requestAttempted && !accepted?.kind && kind === 'routine') kind = 'general';
  // A routine step that reads as architecture is hard work, but keeps its kind for per-kind history and preferences.
  let complex =
    kind === 'architecture' ||
    (input.kind === 'routine' && inferred.kind === 'architecture') ||
    accepted?.complexity === 'complex' ||
    scopedComplex ||
    fileCount >= 5;
  // Advice guides automatic model selection inside the chosen executor or rule; explicit models still win.
  const suggestedTier =
    !input.model &&
    !input.confirmedRoute &&
    !input.resumeRunId &&
    ['light', 'standard', 'strong'].includes(input.suggestedTier ?? '')
      ? input.suggestedTier
      : undefined;
  const goal = settings.routeGoal ?? 'balanced';
  // Outside quality mode Laya's judgment decides the main task's tier; the local text classifier only
  // flags a conflict for the assessment (workspace judgeLaya). Quality mode keeps its strong floor.
  const layaDecides = !!suggestedTier && input.agentChild !== true && goal !== 'quality';
  if (suggestedTier) complex = suggestedTier === 'strong' || (input.agentChild !== true && !layaDecides && complex);
  // Source evaluation keeps a strong floor even when the preliminary judgment calls it a routine lookup.
  complex ||= research;
  const callerTier = input.agentChild === true && !!suggestedTier;
  // Named files raise the floor only for a request to change code, not to rename or translate a couple of files.
  const codeChange =
    fileCount >= 2 && requestPaths(request).some((path) => codePath.test(path)) && requestsFileChanges(request);
  const routineFloor =
    !callerTier &&
    !layaDecides &&
    !lookup &&
    ((input.plannerStep === true && input.kind === 'routine') || codeChange || itemCount >= 2);
  // Research, reading and review handed to a member is light work, unless it is complex or novel writing.
  const lightMember =
    input.agentChild === true && input.readOnlyMember === true && !complex && !input.fiction && !suggestedTier;
  // The swarm coordinator plans, splits and merges: it asks for the strongest tier, without refusing a light-only pin.
  const coordinator = input.coordinator === true && input.agentChild !== true;
  const preferLight =
    goal === 'quality'
      ? false
      : suggestedTier
        ? !complex && !coordinator && suggestedTier === 'light'
        : goal === 'save'
          ? !complex && !coordinator
          : !complex && !coordinator && (kind === 'routine' || accepted?.complexity === 'simple' || lightMember);
  const baseDemand = modelDemand(goal, complex || coordinator, preferLight && !routineFloor);
  const demand =
    research || suggestedTier === 'strong' || (!callerTier && !layaDecides && (scopedComplex || fileCount >= 5))
      ? {
          ...baseDemand,
          tier: 'strong' as const,
          effort: effortLevels.indexOf(baseDemand.effort) < effortLevels.indexOf('high') ? 'high' : baseDemand.effort,
        }
      : baseDemand;
  // Child callers may choose their effort; main-task advice cannot weaken an existing complexity requirement.
  let suggested =
    !input.effort && input.suggestedEffort && isEffortLevel(input.suggestedEffort) ? input.suggestedEffort : undefined;
  if (suggested && routineFloor && effortLevels.indexOf(suggested) < effortLevels.indexOf('medium'))
    suggested = undefined;
  if (
    suggested &&
    (input.agentChild !== true || research) &&
    (complex || coordinator) &&
    effortLevels.indexOf(suggested) < effortLevels.indexOf(demand.effort)
  )
    suggested = undefined;
  let effectiveDemand: ModelDemand = suggested ? { ...demand, effort: suggested } : demand;
  let estimate = estimateTaskMinutes({ prompt: request, kind, schedule: input.schedule });
  // A plan step or a briefed task is never routed below its whole task; caller tiers and simple lookups keep theirs.
  const whole = !callerTier && !lookup ? task : undefined;
  if (whole) {
    const tiers: ModelDemand['tier'][] = ['light', 'standard', 'strong'];
    effectiveDemand = {
      ...effectiveDemand,
      tier:
        tiers.indexOf(whole.demand.tier) > tiers.indexOf(effectiveDemand.tier)
          ? whole.demand.tier
          : effectiveDemand.tier,
      effort:
        effortLevels.indexOf(whole.demand.effort) > effortLevels.indexOf(effectiveDemand.effort)
          ? whole.demand.effort
          : effectiveDemand.effort,
    };
    complex ||= whole.complex;
    estimate = Math.max(estimate, whole.estimate);
  }
  // A build step that must change files gets a model that finishes long writes (see model selection). The minute
  // estimate cannot tell: it defaults to 20 for ordinary work, which would also catch planning and review.
  if (
    input.permissionMode === 'workspace-write' &&
    input.untrustedContent !== true &&
    (input.requiresFileChanges === true || input.checkFileChanges === true)
  )
    effectiveDemand = { ...effectiveDemand, longWrite: true };
  return {
    inferred,
    accepted,
    kind,
    complex,
    preferLight: preferLight && (!whole || whole.preferLight),
    lightMember,
    coordinator,
    demand: effectiveDemand,
    callerEffort: !!suggested && effectiveDemand.effort === suggested,
    estimate,
    longTask:
      effectiveDemand.tier === 'strong' ||
      complex ||
      effortLevels.indexOf(input.effort ?? effectiveDemand.effort) >= effortLevels.indexOf('high') ||
      estimate >= 30,
  };
}

/** Initial planning heuristic, not measured runtime, token demand, or a completion guarantee. */
export function estimateTaskMinutes(input: {
  prompt?: string;
  content?: string;
  kind?: TaskKind;
  mode?: 'auto' | 'chat' | 'build';
  schedule?: TaskSchedule;
}): number {
  const supplied = input.schedule?.estimatedMinutes;
  if (typeof supplied === 'number' && Number.isFinite(supplied) && supplied > 0) return Math.ceil(supplied);
  const text = input.prompt ?? input.content ?? '';
  const kind = !input.kind || input.kind === 'auto' ? classify(text).kind : input.kind;
  const estimates =
    input.mode === 'chat'
      ? { routine: 2, general: 5, design: 8, architecture: 10 }
      : { routine: 5, general: 20, design: 30, architecture: 45 };
  return estimates[kind as Exclude<TaskKind, 'auto'>] + Math.min(15, Math.floor(text.length / 4000) * 5);
}

type Rejection = {
  kind: RouteUnavailableKind;
  reasons: string[];
  retryAt?: number;
  technical?: boolean;
  /** Rejected only because it cannot run tool-less. */
  toolless?: boolean;
};

/** The adapter can answer from the given text alone, with no file, search, shell, web or tool access. */
export const supportsToolless = (snapshot: Pick<RuntimeSnapshot, 'capabilities'> | undefined) =>
  snapshot?.capabilities.toolless === true;
/** Why a task carrying other people's words found no executor at all. */
export const noToollessExecutor =
  '这条任务带有别人写的消息，只能交给不读文件、不用任何工具的执行器（Claude、Grok 或 API 执行器），但现在没有一个可用。请在“执行器”里启用其中一个后再试。';
type Candidate = {
  snapshot: RuntimeSnapshot;
  model: ModelInfo;
  effort?: string;
  warnings: string[];
  fit: number;
  /** Current account and independent quota-pool pressure for automatic task distribution. */
  load: number;
  /** For a sub-task: how many members this account may run at once, and its load against that share. */
  allowance?: MemberAllowance & { inFlight: number };
  fill: number;
  headroom?: number;
  shortQuotaLeft?: number;
  shortQuotaWindow?: string;
  resetOpportunity?: number;
  /** The window that resets last: what is left of it (after in-flight reservations) and when it resets. */
  lasting?: { left: number; resetAt: number };
  /** Straight-line pace of the window furthest ahead: percent left ÷ percent a steady spend to 0% at reset leaves. */
  pace?: { value: number; left: number; ideal: number; what: string; cards: number; cardsExpireAt?: number };
  /** What would still be unused at the reset (or a credit's expiry) at this account's usual pace (quota-waste.ts). */
  waste?: QuotaWaste;
  /** A real HTTP 402 contradicts an inferred billing percentage; the quota counts as unknown. */
  billingConflict?: boolean;
  /** Why PugPort's own Cursor pick drew from this quota pool, in plain words. */
  poolReason?: string;
};

/** Local scheduling reservations, not a provider-reported balance or token estimate. */
export type RouteCapacity = {
  reservations: ReadonlyMap<string, number>;
  settlingPools: ReadonlySet<string>;
  /** Model-scoped quota reservations; shared windows still use the full account reservation. */
  quotaReservations?: ReadonlyMap<string, number>;
  settlingQuotaPools?: ReadonlySet<string>;
  /** Absent means no per-account limit. */
  maxRunsPerPool?: number;
  /** Quota history's pace per account window, for the predicted-waste preference. */
  burn?: BurnRates;
  /** Where a continued conversation's native session lives; waste never moves the conversation off it. */
  continuing?: Array<{ runtimeId: string; accountFingerprint?: string }>;
  /** Whether the task's project is trusted (same value the run gets), for Pi's automatic commands. */
  trustedProject?: boolean;
  /** Local completed short-chat observations, separate from provider-reported quota. */
  responseLatencySamples?: readonly ResponseLatencySample[];
  /** Current connection/configuration identity, constructed by the controller from the target and snapshot. */
  responseLatencyKeys?: ReadonlyMap<string, string>;
};

export function quotaPoolKey(snapshot: Pick<RuntimeSnapshot, 'id' | 'provider' | 'accountFingerprint'>): string {
  return snapshot.accountFingerprint
    ? `account:${snapshot.provider}:${snapshot.accountFingerprint}`
    : `runtime:${snapshot.id}`;
}

/** A model can draw from shared account windows as well as its own family/pool. */
export function quotaReservationKeys(snapshot: RuntimeSnapshot, model: ModelInfo): string[] {
  const account = quotaPoolKey(snapshot);
  const windows = quotaWindowsForModel(snapshot.quota, model, snapshot.provider);
  if (!windows.length) return [account];
  return [
    ...new Set(
      windows.map((window) =>
        window.modelPool
          ? `${account}:pool:${window.modelPool}`
          : window.modelFamily
            ? `${account}:family:${window.modelFamily}`
            : account,
      ),
    ),
  ];
}

/** How many running tasks already draw on the windows a model of this account uses. */
function reservationsFor(capacity: Set<string> | RouteCapacity, s: RuntimeSnapshot): (model: ModelInfo) => number {
  const pool = quotaPoolKey(s);
  const inFlight = capacity instanceof Set ? 0 : (capacity.reservations.get(pool) ?? 0);
  return (candidate) =>
    capacity instanceof Set || !capacity.quotaReservations
      ? inFlight
      : Math.max(
          capacity.quotaReservations.get(pool) ?? 0,
          ...quotaReservationKeys(s, candidate).map((key) => capacity.quotaReservations!.get(key) ?? 0),
        );
}

/** The model's own pool or family windows are fresh and above the reserve line after in-flight buffers. */
function modelQuotaUsable(
  s: RuntimeSnapshot,
  candidate: ModelInfo,
  settings: Settings,
  reserved: number,
  now: number,
): boolean {
  if (s.quota.status !== 'known' || !s.quota.windows.some((window) => window.modelPool || window.modelFamily))
    return true;
  const windows = quotaWindowsForModel(s.quota, candidate, s.provider);
  const reservationBuffer = Math.max(5, settings.reservePercent) * reserved;
  return (
    windows.length > 0 &&
    windows.every((window) => {
      const observed = Date.parse(window.observedAt ?? s.quota.observedAt ?? '');
      return (
        Number.isFinite(observed) &&
        observed <= now &&
        now - observed < settings.maxQuotaAgeSeconds * 1000 &&
        typeof window.usedPercent === 'number' &&
        Number.isFinite(window.usedPercent) &&
        window.usedPercent >= 0 &&
        window.usedPercent < 100 - quotaWindowReservePercent(window, s.quota, settings, now) - reservationBuffer
      );
    })
  );
}

/** The Cursor window with the least spendable quota, paired with its own reserve; undefined if unknown. */
function poolHeadroom(
  s: RuntimeSnapshot,
  model: ModelInfo,
  settings: Settings,
  reserved: number,
  now: number,
): { left: number; reserve: number } | undefined {
  if (s.quota.status !== 'known' || !s.quota.windows.some((window) => window.modelPool)) return undefined;
  const windows = quotaWindowsForModel(s.quota, model, s.provider);
  if (
    !windows.length ||
    windows.some((window) => typeof window.usedPercent !== 'number' || !Number.isFinite(window.usedPercent))
  )
    return undefined;
  const buffer = reserved ? Math.max(5, settings.reservePercent) * reserved : 0;
  return windows
    .map((window) => ({
      left: 100 - window.usedPercent! - buffer,
      reserve: quotaWindowReservePercent(window, s.quota, settings, now),
    }))
    .sort((a, b) => a.left - a.reserve - (b.left - b.reserve))[0];
}

/**
 * PugPort's own pick of a Cursor model: the first quota pool chooseCursorPool names that offers a model fit for the
 * task (`pick` chooses within a pool), with the reason in plain words. Never used for a pinned model.
 */
function pickCursorModel(
  s: RuntimeSnapshot,
  eligible: ModelInfo[],
  settings: Settings,
  demand: ModelDemand,
  complex: boolean,
  reserved: (model: ModelInfo) => number,
  now: number,
  options: { pick?: (models: ModelInfo[]) => ModelInfo | undefined } = {},
): { model: ModelInfo; group: ModelInfo[]; reason?: string } | undefined {
  const poolOf = (model: ModelInfo) => model.quotaPool ?? 'dynamic';
  const pick = options.pick ?? ((models: ModelInfo[]) => selectAutomaticModel(models, 'cursor', demand));
  const groups = new Map(
    (['cursor', 'other', 'dynamic'] as const).map((pool) => {
      const models = eligible.filter((model) => poolOf(model) === pool);
      // Composer is Cursor's own model for everyday work; Grok in the same pool is for tasks that need it.
      const composers =
        pool === 'cursor' && demand.tier !== 'strong'
          ? models.filter((model) => parseCursorModel(model.id).family.startsWith('composer'))
          : [];
      const model = models.length ? pick(composers.length ? composers : models) : undefined;
      // A complex task never settles for a light model when it picks a pool.
      return [
        pool,
        { models, model: model && !(complex && modelTier(model, 'cursor') === 'light') ? model : undefined },
      ];
    }),
  );
  const headroom: Partial<Record<CursorPool, number>> = {};
  const reserveByPool: Partial<Record<CursorPool, number>> = {};
  const pace: Partial<Record<CursorPool, { value: number; resetAt: number }>> = {};
  for (const pool of ['cursor', 'other'] as const) {
    const sample = s.models.find((model) => poolOf(model) === pool);
    const quota = sample ? poolHeadroom(s, sample, settings, reserved(sample), now) : undefined;
    if (quota) {
      headroom[pool] = quota.left;
      reserveByPool[pool] = quota.reserve;
    }
    // The pool's own windows: how far behind its straight line it is (higher means more would go unused).
    for (const w of sample && s.quota.status === 'known' ? quotaWindowsForModel(s.quota, sample, s.provider) : []) {
      const length = windowMs(w, s.provider);
      const reset = Date.parse(w.resetsAt || '');
      if (isShortQuotaWindow(w) || w.usedPercent === null || !(length > 0) || !(reset > now)) continue;
      const value = (100 - w.usedPercent) / Math.max(Math.min(100, (100 * (reset - now)) / length), 1);
      if (!pace[pool] || value < pace[pool]!.value) pace[pool] = { value, resetAt: reset };
    }
  }
  const satisfies = (model?: ModelInfo) => !!model && tierRank[modelTier(model, 'cursor')] >= tierRank[demand.tier];
  const choice = chooseCursorPool({
    tier: demand.tier,
    headroom,
    offered: { cursor: !!groups.get('cursor')!.model, other: !!groups.get('other')!.model },
    reservePercent: settings.reservePercent,
    reserveByPool,
    pace: {
      cursor: pace.cursor?.value,
      other: pace.other?.value,
    },
    resetInHours: {
      cursor: pace.cursor && (pace.cursor.resetAt - now) / 3_600_000,
      other: pace.other && (pace.other.resetAt - now) / 3_600_000,
    },
    fits: {
      cursor: satisfies(groups.get('cursor')!.model),
      other: satisfies(groups.get('other')!.model),
    },
  });
  for (const pool of choice.order) {
    const group = groups.get(pool)!;
    if (group.model) return { model: group.model, group: group.models, reason: choice.reason };
  }
  return undefined;
}

const apiHarness = (snapshot: RuntimeSnapshot) => isApiHarness(snapshot.provider);
const tierRank = { light: 0, standard: 1, strong: 2 } as const;
type LongTaskOption = Pick<Candidate, 'snapshot' | 'model' | 'effort' | 'load'>;

function longTaskAlternative(
  demand: ModelDemand,
  candidate: LongTaskOption,
  scarce: LongTaskOption[],
  estimate: number,
  now: number,
): boolean {
  if (!automaticApiTarget(candidate.snapshot, now)) return false;
  if (demand.goal === 'save') return true;
  const fit = (option: LongTaskOption) => tierRank[modelTier(option.model, option.snapshot.provider)];
  const effort = (option: LongTaskOption) => {
    const value =
      option.effort ?? (option.snapshot.provider === 'cursor' ? parseCursorModel(option.model.id).effort : undefined);
    return value === 'extra-high' ? 'xhigh' : value;
  };
  if (demand.goal === 'quality')
    return scarce.every((source) => {
      const desired = effort(source);
      const actual = effort(candidate);
      return (
        fit(candidate) >= fit(source) &&
        (!desired ||
          actual === desired ||
          (effortLevels.includes(desired) && effortLevels.indexOf(actual ?? '') >= effortLevels.indexOf(desired)))
      );
    });
  if (scarce.some((source) => fit(candidate) < Math.min(tierRank[demand.tier], fit(source)))) return false;
  // If the scarce window resets during this task, keep it rather than add work to a busier alternative.
  return scarce.every(
    (source) =>
      candidate.load <= source.load ||
      !quotaWindowsForModel(source.snapshot.quota, source.model, source.snapshot.provider).some(
        (window) =>
          isShortQuotaWindow(window) &&
          window.usedPercent !== null &&
          window.usedPercent >= 95 &&
          Date.parse(window.resetsAt ?? '') <= now + estimate * 60_000,
      ),
  );
}

function routingLoad(capacity: Set<string> | RouteCapacity, snapshot: RuntimeSnapshot, model: ModelInfo) {
  const inFlight = capacity instanceof Set ? 0 : (capacity.reservations.get(quotaPoolKey(snapshot)) ?? 0);
  return reservationsFor(capacity, snapshot)(model) + inFlight * 0.25;
}

const noLongTaskAlternative = (goal: Settings['routeGoal']) =>
  goal === 'quality' ? '没有同档或更高档的执行器' : '没有其他可用执行器';
/** Below this much quota left (percent), light tasks go to an API platform when one is available. */
export const scarceHeadroom = 30;
/** A continued session below this pace moves to an on-pace account; paces within this share count as equal. */
const yieldPace = 0.7;
/** Cursor's pool windows are monthly billing periods that report no length: 30 days when the period is unknown. */
const billingPeriodMinutes = 30 * 24 * 60;
const windowMs = (window: QuotaWindow, provider: Provider) => {
  const period = Date.parse(window.resetsAt ?? '') - Date.parse(window.periodStartedAt ?? '');
  if (!window.durationMinutes && period > 0) return period;
  return (window.durationMinutes ?? (provider === 'cursor' ? billingPeriodMinutes : 0)) * 60_000;
};
const paceTolerance = 0.2;
/** Expiring credit at least this far behind its line takes a follow-up that starts new work (dollars). */
const newTaskSwitchUsd = 50;
/** Provider prompt caches (per account) last about five minutes; leaving a session re-reads its whole context. */
const cacheTtlMs = 5 * 60_000;
const largeContextTokens = 200_000;
const mediumContextTokens = 50_000;
const tokenText = (tokens: number) => `${Math.max(1, Math.round(tokens / 10_000))} 万 token`;

function unavailable(rejections: Rejection[]): RouteUnavailableError {
  const reasons = rejections.flatMap((rejection) => rejection.reasons);
  const temporary = rejections.filter((rejection) => rejection.kind !== 'unavailable');
  const eligible = rejections.length > 0 && rejections.every((rejection) => rejection.technical === true);
  if (!temporary.length) {
    const error = new RouteUnavailableError('unavailable', reasons);
    error.technicalFallbackAllowed = eligible;
    return error;
  }
  // A running job or a refresh can unblock before an exhausted account resets. Do not invent its ETA.
  const immediate = temporary.filter((rejection) => rejection.retryAt === undefined);
  const next = immediate.length ? immediate : temporary;
  const chosen = [...next].sort(
    (a, b) =>
      (a.retryAt ?? 0) - (b.retryAt ?? 0) ||
      ['capacity', 'refresh', 'quota'].indexOf(a.kind) - ['capacity', 'refresh', 'quota'].indexOf(b.kind),
  )[0]!;
  const error = new RouteUnavailableError(
    chosen.kind,
    reasons,
    chosen.retryAt === undefined ? undefined : new Date(chosen.retryAt).toISOString(),
  );
  error.technicalFallbackAllowed = eligible;
  return error;
}

/**
 * A Grok Build 402 that no later completed run or passing connection test of the same model has answered,
 * while the billing percentage is only inferred from an omitted field. The request evidence wins.
 */
function unansweredBillingFailure(s: RuntimeSnapshot): boolean {
  const failure = s.lastRequestFailure ?? s.availability?.billingFailure;
  if (failure?.statusCode !== 402 || s.quota.grokBilling?.percentSource !== 'implicit-zero') return false;
  const at = Date.parse(failure.at);
  const later = (value: string | undefined) => Date.parse(value ?? '') > at;
  const tested = s.lastConnectionTest?.ok === true && s.lastConnectionTest.model === failure.model;
  return !later(failure.laterSuccessAt) && !(tested && later(s.lastConnectionTest!.at));
}

/** Local content classification uses clear adult-content wording only. */
/**
 * Cursor builds marked "NO ZDR" do not keep zero data retention, and Cursor refuses to start them for an account
 * that requires it, so they are never picked automatically; a user may still pin one.
 */
export const autoPickable = (model: Pick<ModelInfo, 'label' | 'discovered'>) =>
  !model.discovered && !/no\s*zdr/i.test(model.label);

const manualModel = (input: RunInput) =>
  !!input.model && !input.routeRule && input.automaticExecutorSelection !== true && !input.relayReason;
const modelAllowed = (input: RunInput, model: ModelInfo) =>
  manualModel(input) || !routingModelExcluded(model.id, input.routingRules?.excludeModels);

/** Compare percentages only after each candidate has passed its normal capability, freshness and reserve checks. */
function ruleHeadroom(
  decision: RouteDecision,
  snapshots: RuntimeSnapshot[],
  settings: Settings,
  capacity: Set<string> | RouteCapacity,
): number {
  const source = snapshots.find((snapshot) => snapshot.id === decision.runtimeId);
  const model = source?.models.find((model) => model.id === decision.model);
  if (!source || !model) return -1;
  if (source.apiBudgetState?.policy.limitUsd) {
    const left = source.apiBudgetState.remainingUsd;
    return typeof left === 'number' && Number.isFinite(left)
      ? Math.max(0, Math.min(100, (left / source.apiBudgetState.policy.limitUsd) * 100))
      : -1;
  }
  if (source.quota.status !== 'known') return -1;
  if (source.quota.unlimited) return 101;
  const used = quotaWindowsForModel(source.quota, model, source.provider).map((window) => window.usedPercent);
  if (!used.length || used.some((value) => typeof value !== 'number' || !Number.isFinite(value))) return -1;
  return (
    100 -
    Math.max(...(used as number[])) -
    reservationsFor(capacity, source)(model) * Math.max(5, settings.reservePercent)
  );
}

export function matureContent(prompt: string): boolean {
  return /色情|黄文|情色|成人(?:内容|小说|向|漫画|视频)|十八禁|18\s*禁|r-?18\b|nsfw|porn|hentai|erotic|sexually explicit|性爱描写|裸露描写/i.test(
    prompt,
  );
}

/**
 * Routes a run. When the executor the task is bound to (a picked card, a provider, or a conversation rule) has
 * every account below the reserve line, the same model through Cursor takes over for this run — never for adult
 * material, which stays with the executor the user chose and waits for its reset.
 */
function routeRuleCandidate(
  candidate: RunInput,
  snapshots: RuntimeSnapshot[],
  settings: Settings,
  capacity: Set<string> | RouteCapacity,
  now: number,
): RouteDecision {
  let decision: RouteDecision;
  try {
    decision = routeOnce(candidate, snapshots, settings, capacity, now);
  } catch (error) {
    if (
      !(error instanceof RouteUnavailableError) ||
      error.sessionWait ||
      candidate.runtimeId ||
      candidate.provider !== 'grok' ||
      settings.cursorFallback === false
    )
      throw error;
    // A provider rule permits Grok via Cursor; an account rule never widens to another account/provider.
    const models = snapshots
      .filter((snapshot) => snapshot.provider === 'cursor')
      .flatMap((snapshot) => snapshot.models);
    const model = models.find(
      (model) =>
        modelAllowed({ ...candidate, automaticExecutorSelection: true }, model) &&
        /grok/i.test(model.id) &&
        (!candidate.model ||
          nativeFamily('grok', { id: candidate.model, label: candidate.model }) ===
            parseCursorModel(model.id).family) &&
        (!candidate.effort || model.efforts.includes(candidate.effort)),
    );
    if (!model) throw error;
    try {
      decision = routeOnce({ ...candidate, provider: 'cursor', model: model.id }, snapshots, settings, capacity, now);
      decision.reasons.unshift('规则候选 Grok 当前不可用，改用 Cursor 里的 Grok 模型');
    } catch {
      throw error;
    }
  }
  return decision;
}

/** A step's transport narrows only its first pick; a continued session or a relay uses the task's own policy. */
export const withoutStepTransport = (input: RunInput): RunInput =>
  input.stepTransport ? { ...input, executionPolicy: 'cli-first', stepTransport: undefined } : input;

export function route(
  input: RunInput,
  snapshots: RuntimeSnapshot[],
  settings: Settings,
  capacity: Set<string> | RouteCapacity = new Set(),
  now = Date.now(),
): RouteDecision {
  // The session or confirmed card may be one the step only reached by widening.
  if (input.resumeRunId || input.confirmedRoute) input = withoutStepTransport(input);
  const decision = routeMessagePreference(input, snapshots, settings, capacity, now);
  const by = input.visualContext?.by;
  if (!by) return decision;
  const selected = snapshots.find((snapshot) => snapshot.id === decision.runtimeId);
  const sees =
    supportsImageInput(selected) && selected?.models.find((model) => model.id === decision.model)?.imageInput !== false;
  const note = sees ? `图片已由 ${by} 转述` : `${selected?.label ?? decision.runtimeId} 不能看图，先由 ${by} 转述`;
  return { ...decision, reasons: [note, ...decision.reasons] };
}

/** An executor read from the message is a preference: when it cannot take the task, routing chooses as usual. */
function routeMessagePreference(
  input: RunInput,
  snapshots: RuntimeSnapshot[],
  settings: Settings,
  capacity: Set<string> | RouteCapacity,
  now: number,
): RouteDecision {
  try {
    return routeByStep(input, snapshots, settings, capacity, now);
  } catch (error) {
    const fromMode = !!input.runtimeIdFromMode && !input.runtimeIdFromMessage;
    if (
      !(error instanceof RouteUnavailableError) ||
      !(input.runtimeIdFromMessage || input.runtimeIdFromMode) ||
      !input.runtimeId
    )
      throw error;
    // The saved Navigator route names model and effort for its own card; they do not carry to another card.
    const decision = routeByStep(
      {
        ...input,
        runtimeId: undefined,
        runtimeIdFromMessage: undefined,
        runtimeIdFromMode: undefined,
        ...(fromMode ? { model: undefined, effort: undefined } : {}),
      },
      snapshots,
      settings,
      capacity,
      now,
    );
    const named = snapshots.find((snapshot) => snapshot.id === input.runtimeId)?.label ?? input.runtimeId;
    const chosen = snapshots.find((snapshot) => snapshot.id === decision.runtimeId)?.label ?? decision.runtimeId;
    const note = fromMode
      ? `领航员使用的 ${named} 这次接不了，已自动改用 ${chosen}`
      : `消息里提到的 ${named} 这次接不了，已自动改用 ${chosen}`;
    return { ...decision, reasons: [note, ...decision.reasons], warnings: [note, ...decision.warnings] };
  }
}

function routeByStep(
  input: RunInput,
  snapshots: RuntimeSnapshot[],
  settings: Settings,
  capacity: Set<string> | RouteCapacity,
  now: number,
): RouteDecision {
  try {
    return routeWithinPolicy(input, snapshots, settings, capacity, now);
  } catch (error) {
    // A plan step's transport is a preference: when no card of that kind can take the step, the other kind does.
    if (
      !(error instanceof RouteUnavailableError) ||
      !input.stepTransport ||
      input.allowExecutorFallback === false ||
      input.freeChain ||
      input.confirmedRoute ||
      input.resumeRunId ||
      !(error.kind === 'unavailable' || error.technicalFallbackAllowed)
    )
      throw error;
    const decision = routeWithinPolicy(
      { ...input, executionPolicy: 'cli-first', stepTransport: undefined },
      snapshots,
      settings,
      capacity,
      now,
    );
    const selected = snapshots.find((snapshot) => snapshot.id === decision.runtimeId);
    const preferred = input.stepTransport === 'api' ? 'API 卡' : 'CLI 执行器';
    const causes = [
      ...new Set(error.reasons.map((reason) => reason.slice(reason.indexOf('：') + 1).replace(/[。.\s]+$/, ''))),
    ]
      .slice(0, 3)
      .join('；');
    const note = `这一步首选${preferred}，但${preferred}都不能接${causes ? `（${causes}）` : ''}，改用 ${selected?.label ?? decision.runtimeId}`;
    return { ...decision, reasons: [note, ...decision.reasons], warnings: [note, ...decision.warnings] };
  }
}

function routeWithinPolicy(
  input: RunInput,
  snapshots: RuntimeSnapshot[],
  settings: Settings,
  capacity: Set<string> | RouteCapacity = new Set(),
  now = Date.now(),
): RouteDecision {
  if (input.verifierOf) {
    const answer = input.verifierOf;
    const clean: RunInput = {
      ...input,
      verifierOf: undefined,
      runtimeId: undefined,
      provider: undefined,
      model: undefined,
      effort: undefined,
      confirmedRoute: undefined,
      resumeRunId: undefined,
      freeChain: undefined,
      routeRule: undefined,
      routingRules: undefined,
      stepTransport: undefined,
      excludeProviders: [...new Set([...(input.excludeProviders ?? []), answer.provider])],
      excludeRuntimeIds: [...new Set([...(input.excludeRuntimeIds ?? []), answer.runtimeId])],
    };
    try {
      return routeWithinPolicy(clean, snapshots, settings, capacity, now);
    } catch (error) {
      if (!(error instanceof RouteUnavailableError) || error.sessionWait || error.kind === 'capacity') throw error;
      const models = snapshots.find((s) => s.id === answer.runtimeId)?.models ?? [];
      const model = models.find((m) => m.id === answer.model);
      const cursor = answer.provider === 'cursor' ? parseCursorModel(answer.model) : undefined;
      const supported = cursor
        ? cursorFamilies(models).find((family) => family.id === cursor.family)?.efforts
        : model?.efforts;
      const canonical = (level: string) => (level === 'none' ? 'off' : level === 'extra-high' ? 'xhigh' : level);
      const levels = orderedEfforts(supported ?? []).filter(
        (level, index, all) => all.findIndex((other) => canonical(other) === canonical(level)) === index,
      );
      const previousEffort = answer.effort ?? cursor?.effort ?? model?.defaultEffort;
      const index = previousEffort ? levels.findIndex((level) => canonical(level) === canonical(previousEffort)) : -1;
      const effort = index >= 0 ? (levels[index + 1] ?? levels[index - 1]) : undefined;
      if (!effort)
        throw new RouteUnavailableError('unavailable', [
          ...error.reasons,
          '核验未完成：没有其他平台，原模型也没有不同的推理强度。',
        ]);
      const fallbackModel = cursor ? cursorEquivalent(models, cursor.family, effort) : answer.model;
      if (!fallbackModel) throw error;
      const encodedEffort = cursor && parseCursorModel(fallbackModel).effort;
      const decision = routeAutomatic(
        {
          ...clean,
          verifierCandidates: undefined,
          runtimeId: answer.runtimeId,
          model: fallbackModel,
          effort: encodedEffort ? undefined : effort,
          excludeProviders: input.excludeProviders?.filter((provider) => provider !== answer.provider),
          excludeRuntimeIds: input.excludeRuntimeIds?.filter((id) => id !== answer.runtimeId),
          allowExecutorFallback: false,
        },
        snapshots,
        settings,
        capacity,
        now,
      );
      return {
        ...decision,
        reasons: [
          `核验降级：没有其他可用平台，同一模型以不同推理强度独立核验（${previousEffort} → ${effort}）`,
          ...error.reasons,
          ...decision.reasons,
        ],
      };
    }
  }
  if (input.freeChain) {
    const sources = snapshots
      .filter(
        (source) =>
          isFreePreset(source.apiProvider) &&
          (!input.excludeRuntimeIds?.includes(source.id) ||
            (source.availability?.reason === 'quota' && Date.parse(source.availability.retryAt ?? '') > now)),
      )
      .sort((a, b) => Number(b.local === true) - Number(a.local === true));
    if (input.attachments?.length && sources.length && sources.every(sourceMayLog))
      throw new RouteUnavailableError('unavailable', [
        '免费来源都可能记录内容，不能发送附件；请移除附件或选择不记录内容的来源。',
      ]);
    const failures: RouteUnavailableError[] = [];
    for (const source of sources) {
      try {
        return routeOnce(
          {
            ...input,
            runtimeId: source.id,
            provider: undefined,
            model: undefined,
            effort: undefined,
            confirmedRoute: undefined,
            resumeRunId: undefined,
            routeRule: undefined,
            routingRules: input.routingRules,
            executionPolicy: 'api-only',
            excludeRuntimeIds: input.excludeRuntimeIds?.filter((id) => id !== source.id),
          },
          [source],
          settings,
          capacity,
          now,
        );
      } catch (error) {
        if (!(error instanceof RouteUnavailableError)) throw error;
        failures.push(error);
      }
    }
    const retries = failures.map((error) => Date.parse(error.retryAt ?? '')).filter((at) => at > now);
    if (retries.length) {
      const retryAt = new Date(Math.min(...retries)).toISOString();
      throw new RouteUnavailableError('quota', [`免费来源正在冷却，将于 ${retryAt} 重试；可取消。`], retryAt);
    }
    if (failures.some((error) => error.kind === 'capacity'))
      throw new RouteUnavailableError('capacity', ['免费来源正在忙，等待空闲；可取消。']);
    throw new RouteUnavailableError('unavailable', ['免费来源都暂不可用，请稍后重试。']);
  }
  if (input.confirmedRoute || input.resumeRunId) return routeAutomatic(input, snapshots, settings, capacity, now);
  if (input.routeRule) return routeRuleCandidate(input, snapshots, settings, capacity, now);
  if (input.verifierCandidates?.length && !(input.runtimeId || input.provider || input.model || input.effort)) {
    const reasons: string[] = [];
    const verifierRule = {
      id: 'role:verifier',
      category: input.category?.id ?? 'other',
      candidates: input.verifierCandidates,
      enabled: true,
      strict: false,
      source: 'manual' as const,
    };
    for (const candidate of candidateInputs(verifierRule, input)) {
      const provider = candidate.runtimeId
        ? snapshots.find((snapshot) => snapshot.id === candidate.runtimeId)?.provider
        : candidate.provider;
      if (
        (provider && input.excludeProviders?.includes(provider)) ||
        (candidate.runtimeId && input.excludeRuntimeIds?.includes(candidate.runtimeId))
      ) {
        reasons.push(`核验候选 ${candidate.routeRule!.index + 1} 不可用：已排除该平台或执行器`);
        continue;
      }
      try {
        const decision = routeRuleCandidate(
          { ...candidate, automaticExecutorSelection: true },
          snapshots,
          settings,
          capacity,
          now,
        );
        return {
          ...decision,
          routeRule: { ...candidate.routeRule!, label: '核验' },
          reasons: [`核验：使用候选 ${candidate.routeRule!.index + 1}`, ...reasons, ...decision.reasons],
        };
      } catch (error) {
        if (!(error instanceof RouteUnavailableError) || error.sessionWait) throw error;
        reasons.push(`核验候选 ${candidate.routeRule!.index + 1} 不可用：${error.message}`);
      }
    }
    const decision = routeWithinPolicy({ ...input, verifierCandidates: undefined }, snapshots, settings, capacity, now);
    return { ...decision, reasons: [...reasons, '核验候选均不可用，恢复自动审核', ...decision.reasons] };
  }
  if (!input.routingRules) return routeAutomatic(input, snapshots, settings, capacity, now);
  const category = input.category ?? taskCategory({ ...input, categories: input.routingRules.categories });
  const rule = matchRule(input.routingRules.rules, category);
  const label = categoryLabel(category.id, input.routingRules.categories);
  const classification = `分类：${label}（${category.reason}，置信度${category.confidence === 'high' ? '高' : '低'}）`;
  const lead = rule
    ? `规则「${label} → ${rule.candidates.map((candidate) => [targetLabel(candidate, snapshots), candidate.model, candidate.effort].filter(Boolean).join('·')).join(' ／ ')}」（对话规则·${rule.strict ? '强制' : '优先'}）`
    : '';
  if (
    (input.runtimeId || input.provider || input.model || input.effort) &&
    !(input.agentChild && input.automaticExecutorSelection && rule?.strict)
  ) {
    const decision = routeAutomatic(input, snapshots, settings, capacity, now);
    const selected = snapshots.find((snapshot) => snapshot.id === decision.runtimeId);
    const allowed = rule?.candidates.some(
      (candidate) =>
        (!candidate.runtimeId || candidate.runtimeId === decision.runtimeId) &&
        (!candidate.provider || candidate.provider === selected?.provider) &&
        (!candidate.model || candidate.model === decision.model) &&
        (!candidate.effort || candidate.effort === decision.effort),
    );
    return {
      ...decision,
      ...(allowed && input.agentChild && input.automaticExecutorSelection && rule
        ? {
            routeRule: candidateInputs(rule, input).find(
              (candidate) =>
                (!candidate.runtimeId || candidate.runtimeId === decision.runtimeId) &&
                (!candidate.provider || candidate.provider === selected?.provider) &&
                (!candidate.model || candidate.model === decision.model),
            )?.routeRule,
          }
        : {}),
      reasons: [
        ...(rule
          ? [
              allowed
                ? `按你的指定交给 ${selected?.label ?? decision.runtimeId}（手动选择优先于规则）`
                : `按你的指定交给 ${selected?.label ?? decision.runtimeId}（${label}规则里没有它）`,
            ]
          : []),
        classification,
        ...decision.reasons,
      ],
    };
  }
  if (!rule) {
    const skipped = input.routingRules.rules.some(
      (rule) => rule.enabled && rule.strict && rule.category === category.id,
    );
    const decision = routeAutomatic(input, snapshots, settings, capacity, now);
    return {
      ...decision,
      reasons: [classification, ...(skipped ? ['分类置信度低，本次不触发强制规则'] : []), ...decision.reasons],
    };
  }
  const failures: RouteUnavailableError[] = [];
  const checklistReasons: string[] = [];
  const failureReasons: string[] = [];
  const candidates = candidateInputs(rule, { ...input, category });
  const quotaSelection = input.routingRules.selection === 'quota';
  const installedCandidateProviders = new Set(
    snapshots
      .filter((snapshot) => snapshot.installed && snapshot.capabilities.execute)
      .map((snapshot) => snapshot.provider),
  );
  const uninstalledCandidates = candidates.filter(
    (candidate) => candidate.provider && !candidate.runtimeId && !installedCandidateProviders.has(candidate.provider),
  );
  const uninstalledReason = uninstalledCandidates.length ? '规则指定的执行器未安装，已跳过并回落自动选择' : undefined;
  if (uninstalledReason) checklistReasons.push(uninstalledReason);
  const installedCandidates = candidates.filter(
    (candidate) => !candidate.provider || candidate.runtimeId || installedCandidateProviders.has(candidate.provider),
  );
  const viable: Array<{
    candidate: RunInput;
    decision: RouteDecision;
    headroom: number;
    shortQuota?: { label: string; left: number; window: string };
  }> = [];
  const { demand, estimate } = taskModelPolicy(input, settings);
  const option = (decision: RouteDecision): LongTaskOption => {
    const snapshot = snapshots.find((snapshot) => snapshot.id === decision.runtimeId)!;
    const model =
      (snapshot.provider === 'cursor' ? cursorModelForPin(snapshot.models, decision.model) : undefined) ??
      snapshot.models.find((model) => model.id === decision.model)!;
    return { snapshot, model, effort: decision.effort, load: routingLoad(capacity, snapshot, model) };
  };
  const canReplaceScarce = (decision: RouteDecision) =>
    decision.shortQuotaLeft === undefined &&
    longTaskAlternative(
      demand,
      option(decision),
      viable.filter(({ shortQuota }) => shortQuota).map(({ decision }) => option(decision)),
      estimate,
      now,
    );
  const finish = (
    candidate: RunInput,
    decision: RouteDecision,
    shortQuota?: { label: string; left: number; window: string },
  ): RouteDecision => ({
    ...decision,
    routeRule: candidate.routeRule,
    reasons: [
      ...new Set([
        `${lead}：使用候选 ${candidate.routeRule!.index + 1}`,
        ...(quotaSelection ? ['按方案比较全部可用候选的剩余额度；未知额度不会视为无限额度'] : []),
        classification,
        ...(category.confidence === 'low' ? ['分类置信度低，仅作为软偏好'] : []),
        ...failureReasons,
        ...checklistReasons,
        ...(shortQuota
          ? [
              `${shortQuota.label}：${shortQuota.window}只剩 ${shortQuota.left}%，${noLongTaskAlternative(demand.goal)}，仍按原规则派发长任务`,
            ]
          : viable.flatMap(({ shortQuota }) =>
              shortQuota ? [`${shortQuota.label}：${shortQuota.window}只剩 ${shortQuota.left}%，长任务改派`] : [],
            )),
        ...decision.reasons,
      ]),
    ],
  });
  // A caller may name a member of a strict rule; user pins were handled above.
  const named =
    input.agentChild && input.automaticExecutorSelection
      ? candidates.findIndex((candidate) =>
          candidate.runtimeId
            ? candidate.runtimeId === input.runtimeId
            : !!candidate.provider &&
              candidate.provider === (input.provider ?? snapshots.find((s) => s.id === input.runtimeId)?.provider),
        )
      : -1;
  if (named > 0) candidates.unshift(...candidates.splice(named, 1));
  installedCandidates.sort((a, b) => candidates.indexOf(a) - candidates.indexOf(b));
  for (const candidate of installedCandidates) {
    const checklistReason = checklistCandidateReason(candidate, snapshots, settings);
    if (checklistReason) checklistReasons.push(checklistReason);
    try {
      const decision = routeRuleCandidate(
        { ...candidate, automaticExecutorSelection: true },
        snapshots,
        settings,
        capacity,
        now,
      );
      const source = snapshots.find((snapshot) => snapshot.id === decision.runtimeId);
      const shortQuota =
        decision.shortQuotaLeft !== undefined
          ? { label: source!.label, left: decision.shortQuotaLeft, window: decision.shortQuotaWindow ?? '5 小时额度' }
          : undefined;
      if (!quotaSelection && !shortQuota && (!viable.length || canReplaceScarce(decision)))
        return finish(candidate, decision);
      viable.push({ candidate, decision, headroom: ruleHeadroom(decision, snapshots, settings, capacity), shortQuota });
    } catch (error) {
      if (!(error instanceof RouteUnavailableError) || error.sessionWait) throw error;
      failures.push(error);
      failureReasons.push(`候选 ${candidate.routeRule!.index + 1} 不可用：${error.message}`);
    }
  }
  if (viable.length) {
    if (quotaSelection)
      viable.sort((a, b) => b.headroom - a.headroom || a.candidate.routeRule!.index - b.candidate.routeRule!.index);
    const original = viable[0]!;
    const selected = original.shortQuota
      ? (viable.find(({ decision }) => canReplaceScarce(decision)) ?? original)
      : original;
    return finish(selected.candidate, selected.decision, selected.shortQuota);
  }
  const reasons = [lead, classification, ...failureReasons, ...checklistReasons];
  if (rule.strict && installedCandidates.length > 0) {
    const failure = unavailable(
      failures.map((error) => {
        const retry = Date.parse(error.retryAt ?? '');
        return {
          kind: error.kind,
          reasons: [],
          retryAt: Number.isFinite(retry) && retry > now ? retry : undefined,
        };
      }),
    );
    throw new RouteUnavailableError(failure.kind, [...reasons, '强制规则的候选均不可用，不自动改派'], failure.retryAt);
  }
  const decision = routeAutomatic(input, snapshots, settings, capacity, now);
  return {
    ...decision,
    reasons: [...reasons, '优先候选均不可用，恢复自动选择', ...decision.reasons],
  };
}

function routeAutomatic(
  input: RunInput,
  snapshots: RuntimeSnapshot[],
  settings: Settings,
  capacity: Set<string> | RouteCapacity = new Set(),
  now = Date.now(),
): RouteDecision {
  try {
    return routeOnce(input, snapshots, settings, capacity, now);
  } catch (error) {
    if (
      error instanceof RouteUnavailableError &&
      error.technicalFallbackAllowed &&
      input.allowExecutorFallback === true &&
      !input.confirmedRoute &&
      !input.resumeRunId &&
      (input.runtimeId || input.provider || input.model)
    ) {
      const preferred = input.runtimeId ? snapshots.find((snapshot) => snapshot.id === input.runtimeId) : undefined;
      const provider = preferred?.provider ?? input.provider;
      const selectedCatalogs = preferred
        ? [preferred]
        : snapshots.filter((snapshot) => !provider || snapshot.provider === provider);
      const policyBlocked =
        (input.toolApprovalMode ?? settings.toolApprovalMode ?? 'auto') === 'auto' &&
        !!input.model &&
        selectedCatalogs.some((snapshot) =>
          snapshot.models.some((model) => model.id === input.model && model.noAutoApproval),
        );
      // An absent saved target may have been explicitly disabled; do not widen that selection.
      if ((!input.runtimeId || preferred) && !isRetiredProvider(provider) && !policyBlocked) {
        const flexible: RunInput = {
          ...input,
          automaticExecutorSelection: true,
          runtimeId: undefined,
          provider: undefined,
          model: undefined,
          effort: undefined,
        };
        const samePlatform = provider ? snapshots.filter((snapshot) => snapshot.provider === provider) : [];
        try {
          let decision: RouteDecision;
          try {
            if (!samePlatform.length) throw error;
            decision = routeOnce(flexible, samePlatform, settings, capacity, now);
          } catch {
            const cursor =
              error.kind === 'quota' ? cursorFallback(input, snapshots, settings, capacity, now) : undefined;
            if (cursor && !input.excludeProviders?.includes('cursor')) {
              try {
                decision = routeOnce(
                  { ...cursor.input, excludeProviders: input.excludeProviders },
                  snapshots,
                  settings,
                  capacity,
                  now,
                );
              } catch {
                decision = routeOnce(flexible, snapshots, settings, capacity, now);
              }
            } else decision = routeOnce(flexible, snapshots, settings, capacity, now);
          }
          const note = `首选执行器 ${preferred?.label ?? provider ?? input.model} 的技术能力或资源当前不可用，已自动切换到 ${decision.runtimeId} / ${decision.model}`;
          return {
            ...decision,
            reasons: [
              note,
              ...error.reasons.map((reason) => reason.replace('不会自动替换已指定的执行器。', '')),
              ...decision.reasons,
            ],
            warnings: [note, ...decision.warnings],
          };
        } catch (fallbackError) {
          // The remaining pool's actual resource state controls waiting, not the first capability failure.
          if (fallbackError instanceof RouteUnavailableError) throw fallbackError;
          throw error;
        }
      }
    }
    const fallback =
      error instanceof RouteUnavailableError && error.kind === 'quota'
        ? cursorFallback(input, snapshots, settings, capacity, now)
        : undefined;
    if (!fallback) throw error;
    try {
      const decision = routeOnce(fallback.input, snapshots, settings, capacity, now);
      return {
        ...decision,
        reasons: [
          fallback.note,
          ...fallback.selectionReasons,
          ...decision.reasons.filter((reason) => !reason.startsWith('用户指定模型：')),
        ],
        warnings: [fallback.note, ...decision.warnings],
      };
    } catch {
      throw error;
    }
  }
}

function cursorFallback(
  input: RunInput,
  snapshots: RuntimeSnapshot[],
  settings: Settings,
  capacity: Set<string> | RouteCapacity,
  now: number,
): { input: RunInput; note: string; selectionReasons: string[] } | undefined {
  if (
    (input.model && input.allowExecutorFallback === false && input.relayReason !== 'technical') ||
    settings.cursorFallback === false ||
    input.relayReason === 'content' ||
    input.confirmedRoute ||
    input.resumeRunId
  )
    return;
  if (input.attachments?.some((file) => file.kind === 'image')) return;
  const pinned = input.runtimeId ? snapshots.find((s) => s.id === input.runtimeId) : undefined;
  const provider = pinned?.provider ?? input.provider;
  if (!provider || !providerSpec(provider)?.modelsOnCursor) return;
  const judgment = input.taskJudgment;
  const accepted = judgment?.status === 'accepted' && judgment.source === 'jev' ? judgment : undefined;
  const text = input.routingPrompt ?? input.prompt;
  if (accepted?.content === 'adult' || (accepted?.content !== 'standard' && matureContent(text))) return;
  const source = pinned ?? snapshots.find((s) => s.provider === provider && s.models.length);
  const cursor = snapshots.find(
    (s) =>
      s.provider === 'cursor' &&
      s.installed &&
      s.models.length &&
      automaticExecutorAllowed({ ...input, automaticExecutorSelection: true }, settings, s.id) &&
      !input.excludeProviders?.includes(s.provider) &&
      !input.excludeRuntimeIds?.includes(s.id),
  );
  if (!source || !cursor) return;
  const { demand, complex, callerEffort } = taskModelPolicy(input, settings);
  const automatic = (input.toolApprovalMode ?? settings.toolApprovalMode ?? 'auto') === 'auto';
  const eligible = source.models.filter(
    (model) =>
      modelAllowed(input, model) &&
      nativeFamily(provider, model) &&
      !(automatic && model.noAutoApproval) &&
      (!input.effort || model.efforts.includes(input.effort)),
  );
  const native = input.model
    ? eligible.find((model) => model.id === input.model)
    : selectAutomaticModel(eligible, provider, demand);
  const family = native && nativeFamily(provider, native);
  if (!native || !family) return;
  if (!input.model && complex && modelTier(native, provider) === 'light') return;
  const nativeEffort = input.effort ?? automaticEffort(native, demand.effort);
  const fits = (candidate: ModelInfo, wanted?: string) =>
    !wanted || candidate.efforts.includes(wanted) || parseCursorModel(candidate.id).effort === wanted;
  const sameFamily = (candidate: ModelInfo) =>
    parseCursorModel(candidate.id).family === family && fits(candidate, nativeEffort);
  const sameModel = (models: ModelInfo[]) =>
    selectAutomaticModel(models.filter(sameFamily), 'cursor', { ...demand, effort: nativeEffort ?? demand.effort });
  // The task is bound to this executor (a picked card, a provider, a conversation rule or an @ mention), so the
  // fallback stays with the same model family whatever the task's difficulty; only the pool follows the headroom.
  const same = cursor.models.filter(
    (candidate) =>
      modelAllowed({ ...input, automaticExecutorSelection: true }, candidate) &&
      autoPickable(candidate) &&
      !(automatic && candidate.noAutoApproval) &&
      sameFamily(candidate),
  );
  const reserved = reservationsFor(capacity, cursor);
  const byHeadroom = input.model
    ? undefined
    : pickCursorModel(
        cursor,
        same.filter((candidate) => modelQuotaUsable(cursor, candidate, settings, reserved(candidate), now)),
        settings,
        { ...demand, tier: 'standard' },
        false,
        reserved,
        now,
        { pick: sameModel },
      );
  // With no usable reading, routing the same model still checks its quota and keeps the original wait.
  const selected = byHeadroom?.model ?? sameModel(same);
  if (!selected) return;
  const model = selected.id;
  const pool = selected.quotaPool;
  const effort = nativeEffort;
  const sourceLabel = pinned?.label ?? source.label;
  const cooling = Date.parse(pinned?.executorCooldown?.retryAt ?? '') > now;
  const note = cooling
    ? pool
      ? `${sourceLabel} 连续技术失败，正在冷却，这次改由 ${cursor.label} 的 ${model} 运行（同款模型 ${family}，计入 ${cursorModelPoolLabel(pool)} 额度）`
      : `${sourceLabel} 连续技术失败，正在冷却，这次改由 ${cursor.label} 的 ${model} 运行（同款模型 ${family}）`
    : pool
      ? `${sourceLabel} 的额度已低于保留线，这次改由 ${cursor.label} 的 ${model} 运行（同款模型 ${family}，计入 ${cursorModelPoolLabel(pool)} 额度）`
      : `${sourceLabel} 的额度已低于保留线，这次改由 ${cursor.label} 的 ${model} 运行（同款模型 ${family}）`;
  return {
    input: {
      ...input,
      provider: undefined,
      automaticExecutorSelection: true,
      runtimeId: cursor.id,
      model,
      effort: effort && selected.efforts.includes(effort) ? effort : undefined,
      excludeProviders: input.excludeProviders,
    },
    note,
    selectionReasons: [
      `已指定 ${sourceLabel}：额度回退只换成 Cursor 里的同款模型，不按任务难度换别的模型`,
      ...modelSelectionReasons(native, provider, demand, !!input.model, effort, !!input.effort, callerEffort),
    ],
  };
}

export function freeTierAllowed(
  input: RunInput,
  snapshot: RuntimeSnapshot,
  task?: { complex: boolean; coordinator: boolean; kind: TaskKind; goal: Settings['routeGoal'] },
): boolean {
  if (snapshot.costTier !== 'free' && !isFreePreset(snapshot.apiProvider)) return true;
  if (sourceMayLog(snapshot) && (!input.textOnlyPrompt?.trim() || input.attachments?.length)) return false;
  return (
    input.freeChain === true ||
    (input.runtimeId === snapshot.id &&
      input.automaticExecutorSelection !== true &&
      input.routeRule?.derived !== true &&
      (!input.relayReason || input.relayReason === 'selection') &&
      input.agentChild !== true) ||
    (task?.goal === 'save' &&
      (input.freeRelayCount ?? 0) < 2 &&
      !task.complex &&
      !task.coordinator &&
      !input.coordinator &&
      !input.agentCalls &&
      (task.kind === 'routine' || input.permissionMode === 'read-only' || input.untrustedContent === true))
  );
}

function routeOnce(
  input: RunInput,
  snapshots: RuntimeSnapshot[],
  settings: Settings,
  capacity: Set<string> | RouteCapacity = new Set(),
  now = Date.now(),
): RouteDecision {
  // Validate the selected channel strictly first. Only route() may relax an explicitly flexible preference.
  const pinned = input.runtimeId ? snapshots.find((s) => s.id === input.runtimeId) : undefined;
  if (input.runtimeId === 'pi-magpie' || pinned?.gateway === 'magpie')
    throw new RouteUnavailableError('unavailable', ['Magpie 网关已移除，请选择原生 CLI 或已配置的 API 执行器']);
  const schedule = input.schedule;
  const notBefore = schedule?.notBefore === undefined ? undefined : Date.parse(schedule.notBefore);
  const deadline = schedule?.deadlineAt === undefined ? undefined : Date.parse(schedule.deadlineAt);
  if (notBefore !== undefined && !Number.isFinite(notBefore))
    throw new RouteUnavailableError('unavailable', ['任务最早开始时间无效']);
  if (deadline !== undefined && !Number.isFinite(deadline))
    throw new RouteUnavailableError('unavailable', ['任务截止时间无效']);
  if (notBefore !== undefined && notBefore > now) {
    throw new RouteUnavailableError(
      'capacity',
      [`任务尚未到最早开始时间 ${new Date(notBefore).toISOString()}`],
      new Date(notBefore).toISOString(),
    );
  }
  const routingPrompt = input.routingPrompt ?? input.prompt;
  const judgment = input.taskJudgment;
  const { inferred, accepted, kind, complex, preferLight, coordinator, demand, callerEffort, estimate, longTask } =
    taskModelPolicy(input, settings);
  // Adult content goes where the category policy says (Grok by default), whatever its domain.
  const mature = accepted?.content === 'adult' || (accepted?.content !== 'standard' && matureContent(routingPrompt));
  const category: RouteCategory = mature ? 'mature' : kind === 'auto' ? 'general' : kind;
  const allowed = settings.routePreferencesEnabled === true ? routePolicy(settings)[category] : [];
  // Only a category that sends work to Grok alone binds an unpinned Cursor to its Grok models.
  const grokBound = !input.runtimeId && allowed.length > 0 && allowed.every((key) => key === 'grok');
  const preferred: string =
    allowed[0] ??
    (settings.routePreferencesEnabled !== true
      ? ''
      : kind === 'design'
        ? settings.designProvider
        : kind === 'routine'
          ? settings.routineProvider
          : settings.architectureProvider);
  // Finishing shortly before a reset is useful too. A deadline constrains completion, not reset time.
  const opportunityMinutes = Math.max(estimate * 2, 60);
  const opportunityHorizon = now + opportunityMinutes * 60_000;
  const preferExpiring = schedule?.preferExpiringQuota !== false && !input.runtimeId;
  const burn = capacity instanceof Set ? undefined : capacity.burn;
  const continuing =
    capacity instanceof Set || (!input.continuationRunId && !input.continuationAlternates?.length)
      ? undefined
      : capacity.continuing;
  // A warm cache makes the session sticky in proportion to what a switch would re-read on another account.
  const session = input.continuationContext;
  const cacheWarm = !!continuing && now - Date.parse(session?.endedAt ?? '') < cacheTtlMs;
  const sessionTokens = cacheWarm ? (session?.tokens ?? 0) : 0;
  // Unknown session size keeps the usual threshold; a cache known to be cold costs the same on any account.
  const yieldBelow =
    !session || session.tokens === undefined
      ? yieldPace
      : !cacheWarm
        ? 1
        : sessionTokens >= largeContextTokens
          ? 0.5
          : sessionTokens >= mediumContextTokens || !input.continuationNewTask
            ? yieldPace
            : 1;
  const sessionCard = (s: RuntimeSnapshot) =>
    continuing?.some(
      (item) => item.runtimeId === s.id && (item.accountFingerprint ?? '') === (s.accountFingerprint ?? ''),
    ) ?? false;
  const settlingSession = new Set<string>();
  const preferCli = input.executionPolicy === 'cli-first' || settings.preferCli;
  const strongFit = (c: Pick<Candidate, 'snapshot' | 'model'>) =>
    demand.tier !== 'strong' || modelTier(c.model, c.snapshot.provider) === 'strong';
  const distributeChildren = input.agentChild === true && !input.runtimeId && !input.model;
  const hasFreeSource = snapshots.some(
    (source) =>
      automaticExecutorAllowed(input, settings, source.id) &&
      (source.costTier === 'free' || isFreePreset(source.apiProvider)),
  );
  // Open main-task routing may compare platforms dynamically. Human choices and configured policies keep priority.
  const openMain =
    input.agentChild !== true &&
    !input.runtimeId &&
    !input.provider &&
    !input.model &&
    !input.routeRule &&
    !input.confirmedRoute &&
    !input.resumeRunId &&
    settings.routePreferencesEnabled !== true &&
    (demand.goal !== 'save' || !hasFreeSource);
  const distributeMain = openMain && !input.continuationRunId && !input.continuationAlternates?.length;
  // Read-only members on a light model are cheap and quick, so a healthy account may take a few more of them.
  const lightMember = input.agentChild === true && input.readOnlyMember === true && demand.tier === 'light';
  const rejections: Rejection[] = [];
  const candidates: Candidate[] = [];
  const fullApiCards = new Set<string>();

  const automaticRoute =
    input.automaticExecutorSelection === true ||
    input.routeRule?.derived === true ||
    (!input.runtimeId && !input.provider);
  // Choosing API-only is an explicit opt-in to paid API cards.
  // A write with automatic approval that names tests, builds or commands needs a shell.
  const commandRequest =
    !!input.verificationCommand ||
    /测试|构建|编译|类型检查|跑一下|运行|命令|\b(?:tests?|build|compile|typecheck|tsc|lint|npm|pnpm|yarn|node|git|shell|run)\b/iu.test(
      routingPrompt,
    );
  // So does work for local programs: Laya's run-commands judgment, or a request to download, transcode, extract
  // frames, convert to a file format or package files.
  const localPrograms =
    input.needsLocalPrograms === true ||
    /下载(?:下来|到本地|这个|这些|视频|音频|文件)|转码|截帧|抽帧|截出|截取|(?:截|抽|提取)出?关键帧|关键帧截图|打包成|压缩成|解压|(?:转换|转|导出)成\s*(?:html|pdf|mp4|mp3|gif|png|jpe?g|wav|webm|zip|视频|音频|图片|网页)|\b(?:download (?:this|the|these|it)|transcode|ffmpeg|yt-dlp|(?:extract|grab) (?:the )?(?:key ?frames?|frames?|audio|subtitles|screenshots?)|(?:convert|export|turn) (?:\w+ ){0,3}(?:to|into) (?:an? )?(?:html|pdf|mp4|mp3|gif|png|jpe?g|wav|webm)|zip (?:up|it|them|the)|unzip)\b/iu.test(
      routingPrompt,
    );
  const needsCommands =
    input.permissionMode === 'workspace-write' &&
    (input.toolApprovalMode ?? settings.toolApprovalMode ?? 'auto') === 'auto' &&
    input.prohibitCommands !== true &&
    !trustedCommandTurn(input, !(capacity instanceof Set) && capacity.trustedProject === true) &&
    (commandRequest || localPrograms);
  const filterPaidApi =
    automaticRoute && input.executionPolicy !== 'api-only' && !(input.memoryDistillation && input.runtimeId);
  const paidApiExcluded = filterPaidApi ? snapshots.filter((s) => !automaticApiTarget(s, now)) : [];
  const paidApiReason = paidApiExcluded.length
    ? `${paidApiAutoSkipReason}（这次未参与：${[...new Set(paidApiExcluded.map((s) => s.label))].join('、')}）`
    : undefined;
  const checklistExcluded = snapshots.filter((s) => !automaticExecutorAllowed(input, settings, s.id));
  const checklistReason = checklistExcluded.length
    ? `已按勾选排除：${[...new Set(checklistExcluded.map((s) => s.label))].join('、')}`
    : undefined;
  const freeExcluded = snapshots.filter(
    (s) =>
      automaticExecutorAllowed(input, settings, s.id) &&
      !freeTierAllowed(input, s, {
        complex: complex || inferred.kind === 'architecture',
        coordinator,
        kind,
        goal: demand.goal,
      }),
  );
  const freeReason = freeExcluded.length
    ? `免费模型未满足轻量简单任务或纯文本隐私条件，已排除：${[...new Set(freeExcluded.map((s) => s.label))].join('、')}`
    : undefined;
  const images = input.attachments?.some((file) => file.kind === 'image') === true;
  for (const s of snapshots) {
    if (isRetiredProvider(s.provider)) continue;
    if (filterPaidApi && !automaticApiTarget(s, now)) continue;
    if (!automaticExecutorAllowed(input, settings, s.id)) continue;
    if (
      !freeTierAllowed(input, s, {
        complex: complex || inferred.kind === 'architecture',
        coordinator,
        kind,
        goal: demand.goal,
      })
    )
      continue;
    if (input.provider && s.provider !== input.provider) continue;
    if (input.excludeProviders?.includes(s.provider)) continue;
    if (input.excludeRuntimeIds?.includes(s.id) || (input.relayProvider && s.provider !== input.relayProvider))
      continue;
    if (input.executionPolicy === 'cli-only' && apiHarness(s)) continue;
    if (input.executionPolicy === 'api-only' && !apiHarness(s)) continue;
    if (input.runtimeId && s.id !== input.runtimeId) continue;
    const reject = (
      why: string,
      failureKind: RouteUnavailableKind = 'unavailable',
      retryAt?: number,
      technical = false,
    ) => {
      rejections.push({ kind: failureKind, reasons: [`${s.label}：${why}`], retryAt, technical });
    };
    if (s.gateway === 'magpie' || s.id === 'pi-magpie') {
      reject('Magpie 网关已移除，请选择原生 CLI 或已配置的 API 执行器');
      continue;
    }
    if (s.environment === 'wsl' || s.id === 'codex-wsl') {
      reject('WSL 执行入口已移除，请选择本机执行器');
      continue;
    }
    // Pi has no OS sandbox, so with automatic approval it refuses every shell command: a write that must run tests,
    // builds or other commands would end unverified there.
    if (automaticRoute && apiHarness(s) && input.executionPolicy !== 'api-only' && needsCommands) {
      // Name the one condition this turn misses, in trustedCommandTurn's order of what usually decides.
      const cause = !(!(capacity instanceof Set) && capacity.trustedProject)
        ? '项目不在可信列表里'
        : input.webDriven
          ? '本轮上下文带网页搜索结果'
          : '不满足可信可写的条件';
      reject(
        commandRequest
          ? `Pi 只在可信项目的可写任务里自动执行命令；这一轮${cause}，这个写任务要跑测试或命令，交给能执行命令的执行器`
          : `Pi 只在可信项目的可写任务里自动执行命令；这一轮${cause}，这个任务要用本机程序（下载、转换、截帧等），交给能执行命令的执行器`,
      );
      continue;
    }
    // Other people's words go only where no tool can be reached: a read-only executor could still read files.
    if (input.untrustedContent && !supportsToolless(s)) {
      rejections.push({
        kind: 'unavailable',
        reasons: [
          input.runtimeId || input.provider
            ? `${s.label}：只读时仍能读取电脑上的文件，不能处理带有别人消息的任务。不会自动替换已指定的执行器。`
            : `${s.label}：只读时仍能读取电脑上的文件，不能处理带有别人消息的任务。`,
        ],
        technical: true,
        toolless: true,
      });
      continue;
    }
    if (images && !supportsImageInput(s)) {
      // route() strips the pin notice again when an allowed fallback replaces the executor.
      reject(
        input.runtimeId || input.provider
          ? '当前执行器的图片输入通道不可用。不会自动替换已指定的执行器。'
          : '当前执行器的图片输入通道不可用。',
        'unavailable',
        undefined,
        true,
      );
      continue;
    }
    if (s.availability?.reason === 'authentication') {
      reject('账号认证已失效；重新登录并检查此账号后再使用', 'unavailable', undefined, true);
      continue;
    }
    if (s.availability?.reason === 'quota') {
      const retry = Date.parse(s.availability.retryAt ?? '');
      if (!Number.isFinite(retry) || retry > now) {
        reject(
          '账号刚返回额度不足或限流，等待复查；不会推断额度恢复',
          'quota',
          Number.isFinite(retry) ? retry : undefined,
          true,
        );
        continue;
      }
    }
    if (!s.installed || !s.capabilities.execute || ['missing', 'error', 'auth-required'].includes(s.status)) {
      reject(
        s.note || '当前不可执行',
        'unavailable',
        undefined,
        !s.installed || ['missing', 'auth-required'].includes(s.status),
      );
      continue;
    }
    // Repeated technical failures pause automatic picks until retryAt; a card the user named still runs.
    const cooldownUntil = Date.parse(s.executorCooldown?.retryAt ?? '');
    if (automaticRoute && cooldownUntil > now) {
      reject(
        `连续 ${s.executorCooldown!.streak} 次技术失败，冷却到 ${new Date(cooldownUntil).toTimeString().slice(0, 5)}`,
        'quota',
        cooldownUntil,
      );
      continue;
    }
    if (s.status === 'refreshing') {
      reject(s.note || '资源正在刷新', 'refresh');
      continue;
    }
    if (!s.models.length) {
      reject('尚无可用模型目录', 'unavailable', undefined, true);
      continue;
    }

    // Validate capability and explicit pins before temporary resource checks. Waiting cannot add a model.
    // Automatic execution needs the CLI's own auto mode; a model without it would stop at the first tool.
    const automatic = (input.toolApprovalMode ?? settings.toolApprovalMode ?? 'auto') === 'auto';
    const pinnedModel = s.provider === 'cursor' && input.model ? cursorModelForPin(s.models, input.model) : undefined;
    const allowedModels = (pinnedModel ? [pinnedModel] : s.models).filter(
      (model) =>
        modelAllowed(input, model) &&
        (input.model
          ? model.id === input.model
          : !(automatic && model.noAutoApproval) &&
            autoPickable(model) &&
            // Adult material, and tasks the category sends to Grok, go to Cursor's Grok models only.
            (!(mature || grokBound) || s.provider !== 'cursor' || /grok/.test(model.id))),
    );
    // An API card can hold text-only and vision models side by side; images go only to a model that reads them.
    const models = images ? allowedModels.filter((model) => model.imageInput !== false) : allowedModels;
    if (allowedModels.length && !models.length) {
      reject('模型不支持图片输入', 'unavailable', undefined, true);
      continue;
    }
    // A pinned executor's automatic model still follows routing; map effort only after that choice.
    const mapEffort = !!input.runtimeId && !input.model && !!input.effort && effortLevels.includes(input.effort);
    const compatibleModels =
      input.effort && !mapEffort ? models.filter((model) => model.efforts.includes(input.effort!)) : models;
    if (models.length && input.effort && !mapEffort && !compatibleModels.length) {
      reject(`模型不支持 ${input.effort} effort`, 'unavailable', undefined, true);
      continue;
    }
    const pool = quotaPoolKey(s);
    const inFlight = capacity instanceof Set ? 0 : (capacity.reservations.get(pool) ?? 0);
    if (s.apiBudgetState) {
      const budget = s.apiBudgetState;
      if (budget.phase === 'expired') {
        reject('API 配置的有效期已结束，不再派发新请求', 'unavailable', undefined, true);
        continue;
      }
      if (budget.phase === 'exhausted') {
        reject(
          'API 本地预算不足以预留下一次运行',
          inFlight > 0 ? 'capacity' : 'unavailable',
          undefined,
          inFlight === 0,
        );
        continue;
      }
      const maxConcurrentRuns = apiBudgetConcurrency(budget, automaticRoute, now);
      if (inFlight >= maxConcurrentRuns) {
        if (automaticRoute && (apiCreditPace(budget, now)?.priority ?? 0) > 0) {
          fullApiCards.add(s.id);
        } else {
          reject('API 当前节奏的并发已满，等待已有运行结算', 'capacity');
          continue;
        }
      }
    }
    const modelReservations = reservationsFor(capacity, s);
    // Independent model pools must not disable the entire account. When the user has not pinned
    // a model, prefer candidates with usable quota; the full validation below still checks freshness.
    const pricedModels =
      s.apiBudgetState && !input.model
        ? compatibleModels.filter(
            (candidate) =>
              candidate.price &&
              Number.isFinite(candidate.price.input) &&
              Number.isFinite(candidate.price.output) &&
              candidate.price.input >= 0 &&
              candidate.price.output >= 0,
          )
        : compatibleModels;
    const availableModels = pricedModels.filter((candidate) =>
      modelQuotaUsable(s, candidate, settings, modelReservations(candidate), now),
    );
    const eligibleModels = !input.model && availableModels.length ? availableModels : pricedModels;
    // PugPort's own Cursor pick weighs the task against Cursor's two quota pools. Adult material keeps its Grok models.
    const cursorPick =
      s.provider === 'cursor' && !input.model && !mature
        ? pickCursorModel(s, eligibleModels, settings, demand, complex, modelReservations, now)
        : undefined;
    let model = input.model
      ? models[0]
      : (cursorPick?.model ?? selectAutomaticModel(eligibleModels, s.provider, demand));
    if (distributeChildren && model) {
      const tier = modelTier(model, s.provider);
      const sameTier = (cursorPick?.group ?? eligibleModels).filter(
        (candidate) => modelTier(candidate, s.provider) === tier,
      );
      const leastPressure = Math.min(...sameTier.map(modelReservations));
      model = selectAutomaticModel(
        sameTier.filter((candidate) => modelReservations(candidate) === leastPressure),
        s.provider,
        demand,
      );
    }
    if (!model) {
      reject(
        s.apiBudgetState && compatibleModels.length && !pricedModels.length
          ? '没有可核验价格的模型，不能用于本地预算调度'
          : `未发现指定模型 ${input.model}`,
        'unavailable',
        undefined,
        true,
      );
      continue;
    }
    if (
      s.apiBudgetState &&
      (!model.price ||
        !Number.isFinite(model.price.input) ||
        !Number.isFinite(model.price.output) ||
        model.price.input < 0 ||
        model.price.output < 0)
    ) {
      reject('模型没有可核验的价格，不能用于本地预算调度', 'unavailable', undefined, true);
      continue;
    }
    if (automaticRoute && s.gateway === 'api' && demand.goal === 'quality' && !strongFit({ snapshot: s, model })) {
      reject('API 模型不满足质量档要求，不能为消耗到期额度降档');
      continue;
    }
    if (automatic && model.noAutoApproval) {
      reject(`${model.label} 不支持自动执行模式；请换模型，或在设置里把工具执行改为逐项确认`);
      continue;
    }
    if (!input.model && complex && modelTier(model, s.provider) === 'light') {
      reject('仅有轻量模型，不满足当前架构任务或复杂任务的默认能力要求');
      continue;
    }
    if (distributeChildren && demand.tier !== 'light' && modelTier(model, s.provider) === 'light') {
      reject('子任务需要常规或更高能力模型；不会为了分散额度自动降到轻量模型');
      continue;
    }
    if (input.effort && !mapEffort && !model.efforts.includes(input.effort)) {
      reject(`模型不支持 ${input.effort} effort`);
      continue;
    }
    if (capacity instanceof Set && capacity.has(s.provider)) {
      reject('该平台正在执行其他任务，等待其额度结算', 'capacity');
      continue;
    }
    // An API card's spend is PugPort's own reservation and usage record, so it has no post-run quota to wait for.
    if (
      !(capacity instanceof Set) &&
      !s.apiBudgetState &&
      (capacity.settlingQuotaPools
        ? capacity.settlingQuotaPools.has(pool) ||
          quotaReservationKeys(s, model).some((key) => capacity.settlingQuotaPools!.has(key))
        : capacity.settlingPools.has(pool))
    ) {
      // The session's own card is only settling the run that just ended: wait for it if it is still the pick.
      if (sessionCard(s) && now - Date.parse(session?.endedAt ?? '') < 5_000) settlingSession.add(s.id);
      else {
        reject('此账号正在同步任务后的额度结算，其他账号仍可执行', 'capacity');
        continue;
      }
    }
    if (!(capacity instanceof Set) && capacity.maxRunsPerPool && inFlight >= capacity.maxRunsPerPool) {
      if (automaticRoute && (apiCreditPace(s.apiBudgetState, now)?.priority ?? 0) > 0) {
        fullApiCards.add(s.id);
      } else {
        reject('此账号的并发容量已满，其他账号仍可执行', 'capacity');
        continue;
      }
    }
    const effort = mapEffort
      ? nearestEffort(model.efforts, input.effort!)
      : input.effort || automaticEffort(model, demand.effort);
    const quotaInFlight = modelReservations(model);
    const warnings: string[] = [];
    let headroom: number | undefined;
    let resetOpportunity: number | undefined;
    let lasting: Candidate['lasting'];
    let pace: Candidate['pace'];
    let waste: QuotaWaste | undefined = preferExpiring ? creditWaste(s.apiBudgetState, now) : undefined;
    let shortQuotaLeft: number | undefined;
    let shortQuotaWindow: string | undefined;
    // Members bind to the least spare after each window's reserve, before in-flight buffers.
    let tightest: { left: number; reserve: number; resetAt?: number } | undefined;
    if (s.quota.status === 'known') {
      const observed = Date.parse(s.quota.observedAt || '');
      if (!Number.isFinite(observed) || observed > now || now - observed >= settings.maxQuotaAgeSeconds * 1000) {
        reject('额度数据已过期，请刷新', 'refresh');
        continue;
      }
      const windows = quotaWindowsForModel(s.quota, model, s.provider);
      if (!windows.length && !s.quota.unlimited) {
        reject('额度窗口缺失', 'refresh');
        continue;
      }
      const windowReasons: string[] = [];
      const blockingResets: number[] = [];
      const opportunityResets: number[] = [];
      let needsRefresh = false;
      for (const w of windows) {
        // A sparse notification updates one pool; it cannot renew the age of the other pools.
        const windowObserved = Date.parse(w.observedAt ?? s.quota.observedAt ?? '');
        if (
          !Number.isFinite(windowObserved) ||
          windowObserved > now ||
          now - windowObserved >= settings.maxQuotaAgeSeconds * 1000
        ) {
          windowReasons.push(`${s.label}：${w.label} 额度读数需要更新`);
          needsRefresh = true;
        }
        const validUse =
          w.usedPercent !== null && Number.isFinite(w.usedPercent) && w.usedPercent >= 0 && w.usedPercent <= 100;
        const reset = Date.parse(w.resetsAt || '');
        const validReset = Number.isFinite(reset) && reset > now;
        const unreportedReset = w.resetsAt === null && w.resetNotReported === true;
        if (!validUse) {
          windowReasons.push(`${s.label}：${w.label} 额度未知`);
          needsRefresh = true;
        }
        if (!validReset && !unreportedReset) {
          windowReasons.push(`${s.label}：${w.label} 需要重新获取重置后的额度`);
          needsRefresh = true;
        }
        if (unreportedReset)
          warnings.push(`${s.label}：${w.label} 未报告重置时间，仅按新鲜额度读数判断，不参与重置时间排序`);
        const reserve = quotaWindowReservePercent(w, s.quota, settings, now);
        const left = 100 - w.usedPercent!;
        const short = isShortQuotaWindow(w);
        // Any nearly spent window, not only the 5-hour one, cannot carry a long or demanding task.
        if (
          validUse &&
          left <= 5 &&
          left < (shortQuotaLeft ?? Infinity) &&
          (longTask || effortLevels.indexOf(effort ?? '') >= effortLevels.indexOf('high'))
        ) {
          shortQuotaLeft = left;
          shortQuotaWindow = short ? undefined : quotaName(w);
        }
        if (validUse && left <= reserve) {
          windowReasons.push(`${s.label}：${w.label} 剩余额度不足保护阈值`);
          if (validReset) blockingResets.push(reset);
        }
        if (validUse && (!tightest || left - reserve < tightest.left - tightest.reserve))
          tightest = { left, reserve, ...(validReset ? { resetAt: reset } : {}) };
        if (
          !short &&
          validUse &&
          left > reserve &&
          left <= settings.reservePercent &&
          reserve < settings.reservePercent
        )
          warnings.push(`${s.label}：${w.label} 临近重置，本窗口保留线从 ${settings.reservePercent}% 降为 ${reserve}%`);
        if (validReset && left > Math.max(5, settings.reservePercent) * (quotaInFlight + 1))
          opportunityResets.push(reset);
      }
      if (windowReasons.length) {
        rejections.push({
          kind: needsRefresh ? 'refresh' : 'quota',
          technical: !needsRefresh,
          reasons: windowReasons,
          // Every blocking window on this candidate must reset before a fresh check could admit it.
          retryAt: blockingResets.length ? Math.max(...blockingResets) : undefined,
        });
        continue;
      }
      headroom = windows.length ? Math.min(...windows.map((w) => 100 - w.usedPercent!)) : undefined;
      if (quotaInFlight && headroom !== undefined) {
        // Providers expose percentages, not an accurate future cost for an arbitrary task.
        // Reserve a conservative buffer per in-flight attempt; never display it as real spend.
        const buffer = Math.max(5, settings.reservePercent) * quotaInFlight;
        if (tightest && tightest.left - buffer <= tightest.reserve) {
          reject('此账号的剩余额度需为执行中的任务预留，等待任务完成后复查', 'capacity');
          continue;
        }
        headroom -= buffer;
        warnings.push(`${s.label} 已为 ${quotaInFlight} 个执行中的任务预留调度余量；这是本地缓冲，不是实际消耗`);
      }
      const nextReset = Math.min(...opportunityResets);
      if (nextReset <= opportunityHorizon) resetOpportunity = nextReset;
      const last = windows
        .filter((w) => w.usedPercent !== null && Number.isFinite(Date.parse(w.resetsAt || '')))
        .sort((x, y) => Date.parse(y.resetsAt!) - Date.parse(x.resetsAt!))[0];
      if (last)
        lasting = {
          left: 100 - last.usedPercent! - (quotaInFlight ? Math.max(5, settings.reservePercent) * quotaInFlight : 0),
          resetAt: Date.parse(last.resetsAt!),
        };
      // Session windows keep their own reserve rule. Each available reset card adds one more window of capacity,
      // to be spent by the time the first card expires when that comes before the window's reset.
      const resetCards = availableResetCards(s, now);
      const cards = resetCards.length;
      const cardsExpireAt = cards ? Date.parse(resetCards[0]!.expiresAt!) : Infinity;
      for (const w of windows) {
        const length = windowMs(w, s.provider);
        const reset = Date.parse(w.resetsAt || '');
        if (isShortQuotaWindow(w) || !(length > 0) || !(reset > now)) continue;
        const deadline = Math.min(reset, cardsExpireAt);
        const ideal = Math.min(100, (100 * (deadline - now)) / length) * (1 + cards);
        const left =
          100 * (1 + cards) -
          w.usedPercent! -
          (quotaInFlight ? Math.max(5, settings.reservePercent) * quotaInFlight : 0);
        const value = left / Math.max(ideal, 1);
        if (!pace || value < pace.value)
          pace = {
            value,
            left,
            ideal,
            what: quotaName(w),
            cards,
            ...(deadline < reset ? { cardsExpireAt: deadline } : {}),
          };
      }
      if (preferExpiring) {
        const window = windowWaste(
          s,
          windows,
          burn,
          now,
          quotaInFlight ? Math.max(5, settings.reservePercent) * quotaInFlight : 0,
        );
        if (window && (!waste || wasteUrgency(window, now) > wasteUrgency(waste, now))) waste = window;
        const grant = cursorGrantWaste(s, now, burn);
        if (grant && (!waste || wasteUrgency(grant, now) > wasteUrgency(waste, now))) waste = grant;
      }
      if (model.quotaPool === 'dynamic' && windows.some((window) => window.modelPool))
        warnings.push('Cursor 将按实际使用的模型扣费；Auto 或未确认归属的模型会同时检查两池额度');
      if (unansweredBillingFailure(s)) {
        // Still a candidate (a later probe may succeed), but after every account with a real reading.
        headroom = undefined;
        resetOpportunity = undefined;
        lasting = undefined;
        pace = undefined;
        waste = undefined;
        tightest = undefined;
        warnings.push(`${s.label}：上次请求返回余额已用完（HTTP 402），账单比例只是推算，按额度未知排在后面`);
      }
    } else if (s.accounting?.mode === 'usage') {
      warnings.push(
        s.apiBudgetState
          ? `${s.label} 按 Pi 报价估算本地预算；已发送的请求可能超出预估，平台账单硬限额需在控制台设置`
          : `${s.label} 按实际报告的消耗统计；没有剩余额度门槛，也不保证账户余额充足`,
      );
    } else {
      const checkedCli = checkedSubscriptionCli(s);
      if (!(checkedCli || settings.unknownQuotaPolicy === 'allow' || input.allowUnknownQuota)) {
        reject('额度未知；可明确允许本次使用未知额度的执行器', 'refresh');
        continue;
      }
      if (checkedCli && Math.max(inFlight, quotaInFlight) > 0) {
        reject('额度未知的订阅账号一次只尝试一个任务，等待当前任务结束', 'capacity');
        continue;
      }
      warnings.push(`${s.label} 的剩余额度未知，本次不是按已知余额派发`);
    }
    // Sub-tasks share an account by its remaining quota; a named account follows the same share.
    let allowance: Candidate['allowance'];
    if (input.agentChild) {
      const cooldown = Date.parse(s.cooldownEndedAt ?? '');
      allowance = {
        ...memberAllowance({
          headroom: tightest?.left,
          resetAt: tightest?.resetAt,
          reservePercent: tightest?.reserve ?? settings.reservePercent,
          unlimited: s.quota.status === 'known' && s.quota.unlimited === true,
          usage: s.quota.status !== 'known' && s.accounting?.mode === 'usage',
          ...(Number.isFinite(cooldown) ? { cooldownUntil: cooldown } : {}),
          light: lightMember,
          now,
        }),
        ...(s.quota.status !== 'known' && checkedSubscriptionCli(s)
          ? { members: 1, reason: '额度未知，一次只尝试一个任务' }
          : {}),
        inFlight,
      };
      if (inFlight >= allowance.members && !fullApiCards.has(s.id)) {
        reject(
          `按剩余额度同时最多 ${allowance.members} 个成员（${allowance.reason}），现已满；其他账号仍可执行`,
          'capacity',
        );
        continue;
      }
    }
    const load = routingLoad(capacity, s, model);
    candidates.push({
      snapshot: s,
      model,
      effort,
      warnings,
      headroom,
      shortQuotaLeft,
      ...(shortQuotaWindow ? { shortQuotaWindow } : {}),
      resetOpportunity,
      lasting,
      ...(pace ? { pace } : {}),
      ...(waste ? { waste } : {}),
      billingConflict: s.quota.status === 'known' && unansweredBillingFailure(s),
      ...(cursorPick?.reason && cursorPick.model.quotaPool === model.quotaPool
        ? { poolReason: cursorPick.reason }
        : {}),
      // A coarse catalog-based floor, not a benchmark or a claim that providers are equally good. A sub-task that
      // asks for the light tier fits on one.
      fit:
        input.model || kind === 'routine' || demand.tier === 'light' || modelTier(model, s.provider) !== 'light'
          ? 1
          : 0,
      load,
      ...(allowance ? { allowance } : {}),
      // Load against the account's share, so an account with more quota left takes proportionally more members.
      fill: allowance ? load / Math.max(1, allowance.members) : load,
    });
  }

  // The mode sets the capability floor; normal quota and load ordering still chooses among eligible alternatives.
  const redirected = candidates.filter((candidate) => candidate.shortQuotaLeft !== undefined);
  const alternatives = redirected.length
    ? candidates.filter(
        (candidate) =>
          candidate.shortQuotaLeft === undefined && longTaskAlternative(demand, candidate, redirected, estimate, now),
      )
    : [];
  if (!input.runtimeId && redirected.length) {
    if (alternatives.length)
      for (const candidate of redirected)
        rejections.push({
          kind: 'quota',
          reasons: [
            `${candidate.snapshot.label}：${candidate.shortQuotaWindow ?? '5 小时额度'}只剩 ${candidate.shortQuotaLeft}%，长任务改派`,
          ],
        });
    candidates.splice(0, candidates.length, ...(alternatives.length ? alternatives : redirected));
  }

  // Each configured API platform has its own route key, even when it uses the same Pi harness.
  const byProvider = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const platform = routeKey(candidate.snapshot);
    const group = byProvider.get(platform) || [];
    group.push(candidate);
    byProvider.set(platform, group);
  }
  const resetOrder = (a: Candidate, b: Candidate) => {
    if (!preferExpiring) return 0;
    if (a.resetOpportunity === b.resetOpportunity) return 0;
    if (a.resetOpportunity === undefined) return 1;
    if (b.resetOpportunity === undefined) return -1;
    return a.resetOpportunity - b.resetOpportunity;
  };
  // A follow-up that starts new work may leave its native session for an expiring credit far behind its line.
  const creditBehind = (candidate: Candidate) => {
    const pace = apiCreditPace(candidate.snapshot.apiBudgetState, now);
    return pace && pace.priority > 0 ? pace.plannedUsd - candidate.snapshot.apiBudgetState!.spentUsd : 0;
  };
  const creditPriority = (candidate: Candidate) =>
    preferExpiring &&
    (!input.continuationRunId ||
      (input.continuationNewTask === true &&
        sessionTokens < largeContextTokens &&
        creditBehind(candidate) >= newTaskSwitchUsd)) &&
    (!allowed.length || allowed.includes(routeKey(candidate.snapshot))) &&
    tierRank[modelTier(candidate.model, candidate.snapshot.provider)] >= tierRank[demand.tier]
      ? (apiCreditPace(candidate.snapshot.apiBudgetState, now)?.priority ?? 0)
      : 0;
  // Every expiring resource competes on predicted unused capacity per remaining hour.
  // Existing API eligibility, category, model tier and native-session constraints still apply.
  const creditOrder = (a: Candidate, b: Candidate) =>
    Math.floor(Date.parse(a.snapshot.apiBudgetState!.policy.expiresAt!) / 3_600_000) -
      Math.floor(Date.parse(b.snapshot.apiBudgetState!.policy.expiresAt!) / 3_600_000) ||
    creditPriority(b) - creditPriority(a);
  const firstCredit = candidates.filter((candidate) => creditPriority(candidate) > 0).sort(creditOrder)[0];
  // Give eligible credits one cross-resource score so their expiry order stays transitive with CLI candidates.
  const urgency = (candidate: Candidate) =>
    preferExpiring &&
    (!input.continuationRunId || creditPriority(candidate) > 0) &&
    (!allowed.length || allowed.includes(routeKey(candidate.snapshot))) &&
    tierRank[modelTier(candidate.model, candidate.snapshot.provider)] >= tierRank[demand.tier]
      ? wasteUrgency(creditPriority(candidate) > 0 ? firstCredit?.waste : candidate.waste, now)
      : 0;
  // Behind-pace expiring credit goes first: a nearly spent credit forecasts little waste in percent of its limit,
  // so window waste of another card must not outrank it. Other resources then compete on waste per hour.
  const expiryOrder = (a: Candidate, b: Candidate) =>
    Number(creditPriority(b) > 0) - Number(creditPriority(a) > 0) ||
    urgency(b) - urgency(a) ||
    (creditPriority(a) > 0 && creditPriority(b) > 0 ? creditOrder(a, b) : 0);
  // The cheapest executor is not the cheapest finished task: one that keeps failing this kind of task goes last.
  const strugglingIds = new Set(input.runtimeId ? [] : (input.struggling?.[kind] ?? []));
  const struggle = (c: Candidate) => Number(strugglingIds.has(c.snapshot.id));
  // A struggling executor goes last only among those offering the demanded tier: struggle never downgrades the model.
  const missesTier = (c: Candidate) =>
    Number(tierRank[modelTier(c.model, c.snapshot.provider)] < tierRank[demand.tier]);
  const unlimited = (c: Candidate) => c.snapshot.quota.status === 'known' && c.snapshot.quota.unlimited === true;
  const limitedAttempt = (c: Candidate) => c.snapshot.quota.status !== 'known' && checkedSubscriptionCli(c.snapshot);
  const checkedQuotaOrder = (a: Candidate, b: Candidate) =>
    limitedAttempt(a) || limitedAttempt(b)
      ? Number(b.headroom !== undefined || unlimited(b)) - Number(a.headroom !== undefined || unlimited(a))
      : 0;
  // Quota that would otherwise reset unused goes first: the share left of an account's longest window per hour
  // until it resets. Paces within a fifth of each other count as equal, and then more remaining quota wins.
  const resetShare = (c: Candidate) =>
    c.lasting ? c.lasting.left / Math.max((c.lasting.resetAt - now) / 3_600_000, 0.5) : undefined;
  const comparePace = (a: Candidate, b: Candidate) => {
    const left = resetShare(a),
      right = resetShare(b);
    if (!preferExpiring || left === undefined || right === undefined) return 0;
    return Math.abs(left - right) <= Math.max(left, right) * 0.2 ? 0 : right - left;
  };
  const compareQuota = (a: Candidate, b: Candidate) =>
    Number(unlimited(b)) - Number(unlimited(a)) || comparePace(a, b) || (b.headroom ?? -1) - (a.headroom ?? -1);
  // Quota predicted to go unused at its reset goes first, compared in steps of `wasteStep`. It never moves work to a
  // model below the tier the task asks for: such a candidate's waste does not count.
  const targetTierOrder = {
    light: ['light', 'standard', 'strong'],
    standard: ['standard', 'strong', 'light'],
    strong: ['strong', 'standard', 'light'],
  }[demand.tier];
  const mainTierOrder = (a: Candidate, b: Candidate) =>
    openMain
      ? targetTierOrder.indexOf(modelTier(a.model, a.snapshot.provider)) -
        targetTierOrder.indexOf(modelTier(b.model, b.snapshot.provider))
      : 0;
  const strongCostOrder = (a: Candidate, b: Candidate) => {
    if (!openMain || demand.tier !== 'strong' || stays(a) || stays(b)) return 0;
    const rank = (c: Candidate) => {
      const index = strongCostFamilies.indexOf(c.snapshot.provider as (typeof strongCostFamilies)[number]);
      return index < 0 ? strongCostFamilies.length : index;
    };
    return rank(a) - rank(b);
  };
  const wasteRank = (c: Candidate) => urgency(c);
  const wasteOrder = (a: Candidate, b: Candidate) => wasteRank(b) - wasteRank(a);
  // A single small tie-break, after actual quota: cards never add headroom or member slots.
  const spare = (c: Candidate) =>
    Number(
      c.headroom !== undefined &&
        availableResetCards(c.snapshot, now).length > 0 &&
        tierRank[modelTier(c.model, c.snapshot.provider)] >= tierRank[demand.tier],
    );
  const spareOrder = (a: Candidate, b: Candidate) => spare(b) - spare(a);
  const tierOf = (c: Candidate) => modelTier(c.model, c.snapshot.provider);
  // An on-pace account of the same tier: an account ahead of plan yields to it.
  const onPaceAlternative = (c: Candidate) =>
    candidates.find(
      (other) => other !== c && tierOf(other) === tierOf(c) && !struggle(other) && (other.pace?.value ?? 0) >= 1,
    );
  // A continued conversation keeps the account its native session lives on, so waste cannot break the session.
  // Only an account clearly ahead of plan hands the next turn to an on-pace account of the same tier.
  const continued = (c: Candidate) =>
    continuing?.some(
      (session) =>
        c.snapshot.id === session.runtimeId &&
        (c.snapshot.accountFingerprint ?? '') === (session.accountFingerprint ?? ''),
    ) ?? false;
  const stays = (c: Candidate) =>
    continued(c) && !(preferExpiring && c.pace && c.pace.value < yieldBelow && onPaceAlternative(c));
  const stayOrder = (a: Candidate, b: Candidate) => Number(stays(b)) - Number(stays(a));
  // Anchor tolerance bands to their highest pace; pairwise ties can create sorting cycles.
  const paceRanks = new Map<Candidate, number>();
  for (const tier of new Set(candidates.map(tierOf))) {
    const paced = candidates
      .filter((c) => tierOf(c) === tier && c.pace && !stays(c))
      .sort((a, b) => b.pace!.value - a.pace!.value);
    let anchor = Infinity,
      rank = -1;
    for (const c of paced) {
      const value = c.pace!.value;
      if (!Number.isFinite(anchor) || (anchor >= 1 && value < 1) || anchor - value > anchor * paceTolerance) {
        anchor = value;
        rank++;
      }
      paceRanks.set(c, rank);
    }
  }
  const paceOrder = (a: Candidate, b: Candidate) => {
    if (!preferExpiring || tierOf(a) !== tierOf(b) || !paceRanks.has(a) || !paceRanks.has(b)) return 0;
    return paceRanks.get(a)! - paceRanks.get(b)!;
  };
  // Close paces: the bigger plan's remaining quota is more work. Only a multiplier in the plan name counts, and only
  // between plans of one platform: Claude's 20x and Codex's Pro are not the same unit.
  // Claude's renamed plans carry no multiplier in the name: Ultra was Max 20x, Max is the old Max 5x.
  const planSize = (c: Candidate) => {
    const label = quotaPlan(c.snapshot)?.label ?? '';
    const named = c.snapshot.provider === 'claude' ? ({ Ultra: 20, Max: 5 } as Record<string, number>)[label] : 0;
    return Number(label.match(/(\d+)x\b/i)?.[1]) || named || undefined;
  };
  const planCapacity = (c: Candidate) => (planSize(c) ?? 1) * c.pace!.left;
  const capacityOrder = (a: Candidate, b: Candidate) =>
    !preferExpiring ||
    distributeChildren ||
    a.snapshot.provider !== b.snapshot.provider ||
    tierOf(a) !== tierOf(b) ||
    !a.pace ||
    !b.pace ||
    stays(a) ||
    stays(b)
      ? 0
      : planCapacity(b) - planCapacity(a);
  const representatives = [...byProvider.values()].map(
    (group) =>
      group.sort((a, b) => {
        const pacingOrder = expiryOrder(a, b);
        if (pacingOrder) return pacingOrder;
        const checkedOrder = checkedQuotaOrder(a, b);
        if (checkedOrder) return checkedOrder;
        if (missesTier(a) !== missesTier(b)) return missesTier(a) - missesTier(b);
        if (struggle(a) !== struggle(b)) return struggle(a) - struggle(b);
        if (settings.preferNative !== false && a.snapshot.environment !== b.snapshot.environment)
          return a.snapshot.environment === 'native' ? -1 : 1;
        return (
          b.fit - a.fit ||
          // Within one platform, prefer an account offering the requested model tier before comparing its quota.
          Number(modelTier(b.model, b.snapshot.provider) === demand.tier) -
            Number(modelTier(a.model, a.snapshot.provider) === demand.tier) ||
          (input.agentChild !== true ? stayOrder(a, b) : 0) ||
          paceOrder(a, b) ||
          capacityOrder(a, b) ||
          (distributeMain ? a.load - b.load : 0) ||
          (distributeChildren ? a.fill - b.fill : 0) ||
          resetOrder(a, b) ||
          stayOrder(a, b) ||
          wasteOrder(a, b) ||
          compareQuota(a, b) ||
          spareOrder(a, b) ||
          Number(b.snapshot.id === `${b.snapshot.provider}-native`) -
            Number(a.snapshot.id === `${a.snapshot.provider}-native`) ||
          a.snapshot.id.localeCompare(b.snapshot.id)
        );
      })[0]!,
  );
  // Only automatic first-turn chats consume response timings. Explicit rules and native continuation keep their
  // established choices, and account allocation within each platform remains quota-based above.
  const latencyEligible =
    input.latencySensitiveChat === true &&
    !input.runtimeId &&
    !input.provider &&
    !input.model &&
    !input.routeRule &&
    !input.confirmedRoute &&
    !input.resumeRunId &&
    !input.continuationRunId &&
    !input.continuationAlternates?.length &&
    !input.relayFromRunId &&
    !input.agentChild &&
    !input.coordinator;
  const responseEstimates = new Map<Candidate, ResponseLatencyEstimate>();
  if (latencyEligible && !(capacity instanceof Set))
    for (const candidate of candidates) {
      const key = capacity.responseLatencyKeys?.get(candidate.snapshot.id);
      if (!key) continue;
      const estimate = estimateResponseLatency(
        capacity.responseLatencySamples ?? [],
        {
          runtimeId: candidate.snapshot.id,
          key,
          model: candidate.model.id,
          effort: candidate.effort,
          sessionMode: 'new',
        },
        now,
      );
      if (estimate) responseEstimates.set(candidate, estimate);
    }
  // Assign every candidate a fixed two-second bucket before sorting. Pairwise "unknown is a tie" comparisons
  // can form a cycle with the old platform preference; missing evidence uses this round's median instead.
  const measuredBuckets = [...responseEstimates.values()]
    .map((estimate) => Math.floor(estimate.milliseconds / 2000))
    .sort((a, b) => a - b);
  const middle = Math.floor(measuredBuckets.length / 2);
  const unknownBucket = measuredBuckets.length
    ? Math.floor((measuredBuckets[middle]! + measuredBuckets[Math.floor((measuredBuckets.length - 1) / 2)]!) / 2)
    : 0;
  const responseBuckets = new Map(
    candidates.map((candidate) => [
      candidate,
      responseEstimates.has(candidate)
        ? Math.floor(responseEstimates.get(candidate)!.milliseconds / 2000)
        : unknownBucket,
    ]),
  );
  // Use the same tier preference as automatic model selection before comparing response times. In particular,
  // quality's strong model must not lose to a light-only catalog merely because that catalog responds faster.
  const responseOrder = (a: Candidate, b: Candidate) =>
    responseEstimates.size
      ? targetTierOrder.indexOf(modelTier(a.model, a.snapshot.provider)) -
          targetTierOrder.indexOf(modelTier(b.model, b.snapshot.provider)) ||
        responseBuckets.get(a)! - responseBuckets.get(b)!
      : 0;
  // Work the category policy sends to Grok may run on a Grok model through Cursor (adult material: after native Grok).
  const standIn = (c: Candidate) =>
    (mature ? allowed.includes('grok') : grokBound) &&
    c.snapshot.provider === 'cursor' &&
    !allowed.includes(routeKey(c.snapshot)) &&
    /grok/.test(c.model.id);
  const compareRepresentatives = (a: Candidate, b: Candidate) => {
    const pacingOrder = expiryOrder(a, b);
    if (pacingOrder) return pacingOrder;
    const checkedOrder = checkedQuotaOrder(a, b);
    if (checkedOrder) return checkedOrder;
    if (demand.goal === 'save') {
      const costRank = (c: Candidate) =>
        c.snapshot.costTier === 'free' || isFreePreset(c.snapshot.apiProvider)
          ? c.snapshot.local
            ? 0
            : 1
          : apiHarness(c.snapshot)
            ? 3
            : 2;
      const savingOrder =
        costRank(a) - costRank(b) || b.fit - a.fit || struggle(a) - struggle(b) || stayOrder(a, b) || wasteOrder(a, b);
      if (savingOrder) return savingOrder;
    }
    // Fixed per-candidate keys keep three-way comparisons transitive. CLI-first retains its established
    // expiring-credit exception, then open main tasks compare tier and continuation before soft inventory gains.
    const transportRank = (c: Candidate) => {
      if (apiHarness(c.snapshot)) return Number(preferCli && !(preferExpiring && creditPriority(c)));
      // Keep the scarce-subscription policy for new light work without pair-dependent API/CLI comparisons.
      // Existing native sessions remain ahead of this soft saving preference.
      return distributeMain &&
        preferLight &&
        c.headroom !== undefined &&
        c.headroom < scarceHeadroom &&
        candidates.some((candidate) => apiHarness(candidate.snapshot))
        ? 2
        : 0;
    };
    const expiredCreditOrder =
      b.fit - a.fit ||
      missesTier(a) - missesTier(b) ||
      struggle(a) - struggle(b) ||
      (openMain ? transportRank(a) - transportRank(b) : 0) ||
      mainTierOrder(a, b) ||
      (openMain ? paceOrder(a, b) || capacityOrder(a, b) : 0) ||
      strongCostOrder(a, b) ||
      (openMain ? stayOrder(a, b) : 0) ||
      (creditPriority(a) || creditPriority(b) ? Number(strongFit(b)) - Number(strongFit(a)) : 0);
    if (expiredCreditOrder) return expiredCreditOrder;
    // The category's platforms come first; with several, the one with more quota left wins (expiring quota first).
    const listed = (c: Candidate) => !allowed.length || allowed.includes(routeKey(c.snapshot)) || standIn(c);
    // When a subscription is nearly used up, light work moves to an API platform so the rest of the
    // subscription is kept for work that needs it. (An exhausted subscription is already out of the list.)
    if (demand.goal !== 'save' && preferLight && apiHarness(a.snapshot) !== apiHarness(b.snapshot)) {
      const cli = apiHarness(a.snapshot) ? b : a;
      if (cli.headroom !== undefined && cli.headroom < scarceHeadroom) return apiHarness(a.snapshot) ? -1 : 1;
    }
    // CLI-first yields when the category explicitly names an API platform and not the CLI.
    if (
      demand.goal !== 'save' &&
      preferCli &&
      apiHarness(a.snapshot) !== apiHarness(b.snapshot) &&
      (distributeChildren || listed(a) === listed(b))
    )
      return apiHarness(a.snapshot) ? 1 : -1;
    const rank = (c: Candidate) =>
      allowed.length
        ? allowed.includes(routeKey(c.snapshot))
          ? allowed.indexOf(routeKey(c.snapshot))
          : 99
        : Number(routeKey(c.snapshot) !== preferred);
    const knownOrder =
      Number(b.headroom !== undefined || unlimited(b)) - Number(a.headroom !== undefined || unlimited(a));
    const quotaOrder = openMain || allowed.length > 1 ? compareQuota(a, b) : 0;
    return (
      b.fit - a.fit ||
      missesTier(a) - missesTier(b) ||
      struggle(a) - struggle(b) ||
      // The coordinator goes where the strongest tier is on offer.
      (coordinator && !input.model ? Number(strongFit(b)) - Number(strongFit(a)) : 0) ||
      (distributeChildren
        ? Number(modelTier(b.model, b.snapshot.provider) === demand.tier) -
          Number(modelTier(a.model, a.snapshot.provider) === demand.tier)
        : 0) ||
      (distributeChildren ? knownOrder || paceOrder(a, b) || a.fill - b.fill : 0) ||
      Number(listed(b)) - Number(listed(a)) ||
      // Native Grok comes first for adult material; otherwise Cursor's Grok competes with it on pace.
      (!mature && standIn(a) !== standIn(b) ? paceOrder(a, b) : 0) ||
      Number(standIn(a)) - Number(standIn(b)) ||
      mainTierOrder(a, b) ||
      strongCostOrder(a, b) ||
      knownOrder ||
      (input.agentChild !== true ? stayOrder(a, b) : 0) ||
      (openMain || allowed.length > 1 ? paceOrder(a, b) || capacityOrder(a, b) : 0) ||
      (distributeMain ? a.load - b.load : 0) ||
      resetOrder(a, b) ||
      stayOrder(a, b) ||
      wasteOrder(a, b) ||
      responseOrder(a, b) ||
      quotaOrder ||
      rank(a) - rank(b) ||
      a.snapshot.provider.localeCompare(b.snapshot.provider)
    );
  };
  representatives.sort(compareRepresentatives);

  // A behind credit card at its pace cap is skipped unless the next pick would be another behind card: then wait for it.
  const full = representatives[0] && fullApiCards.has(representatives[0].snapshot.id) ? representatives[0] : undefined;
  const chosen = full ? representatives.find((c) => !fullApiCards.has(c.snapshot.id)) : representatives[0];
  if (full && (!chosen || creditPriority(chosen) > 0))
    throw new RouteUnavailableError('capacity', [full.snapshot.label + '：API 当前节奏的并发已满，等待已有运行结算']);
  // A pinned choice keeps its own reasons, so route() may still relax the pin.
  if (
    !chosen &&
    input.untrustedContent &&
    !input.runtimeId &&
    !input.provider &&
    rejections.length &&
    rejections.every((rejection) => rejection.toolless)
  )
    throw new RouteUnavailableError('unavailable', [noToollessExecutor]);
  if (!chosen) {
    const error = unavailable(rejections);
    if (checklistReason || freeReason || paidApiReason) {
      error.reasons.unshift(
        ...[checklistReason, freeReason, paidApiReason].filter((reason): reason is string => !!reason),
      );
      error.message = error.reasons.join('\n');
    }
    throw error;
  }
  const s = chosen.snapshot;
  if (settlingSession.has(s.id)) {
    const wait = new RouteUnavailableError(
      'capacity',
      [
        sessionTokens
          ? `${s.label}：等上一步结算约 5 秒，为缓存留在原卡（上下文约 ${tokenText(sessionTokens)}）`
          : `${s.label}：等上一步结算约 5 秒，为缓存留在原卡`,
      ],
      new Date(now + 5_000).toISOString(),
    );
    wait.sessionWait = true;
    throw wait;
  }
  const scheduleReasons: string[] = [];
  if (!input.runtimeId && !input.routeRule?.derived && chosen.shortQuotaLeft !== undefined)
    scheduleReasons.push(
      `${s.label}：${chosen.shortQuotaWindow ?? '5 小时额度'}只剩 ${chosen.shortQuotaLeft}%，${noLongTaskAlternative(demand.goal)}，仍按原规则派发长任务`,
    );
  const warnings = [...chosen.warnings];
  if (manualModel(input) && routingModelExcluded(chosen.model.id, input.routingRules?.excludeModels))
    scheduleReasons.push('手动指定的模型优先于方案的模型排除列表');
  if (responseEstimates.size) {
    const estimate = responseEstimates.get(chosen);
    scheduleReasons.push(
      estimate
        ? estimate.scope === 'model'
          ? `响应速度：${s.label} 最近 ${estimate.samples} 次同模型首轮简短对话，首段文字中位数约 ${(estimate.milliseconds / 1000).toFixed(1)} 秒；仅在能力与路由策略允许时优先`
          : `响应速度：${s.label} 最近 ${estimate.samples} 次同执行器首轮简短对话，首段文字中位数约 ${(estimate.milliseconds / 1000).toFixed(1)} 秒；这是执行器回退估计，并非同模型实测`
        : '响应速度：当前执行器暂无可用样本，按本轮候选中位速度排序，不视为零延迟',
    );
  }
  if (s.apiBudgetState) {
    const budget = s.apiBudgetState;
    scheduleReasons.push(
      budget.remainingUsd === undefined
        ? `API 本地预算：已用 $${budget.spentUsd.toFixed(4)}，已预留 $${budget.reservedUsd.toFixed(4)}；每次预留 $${budget.policy.perRunUsd.toFixed(4)}`
        : `API 本地预算：已用 $${budget.spentUsd.toFixed(4)}，已预留 $${budget.reservedUsd.toFixed(4)}，可调度 $${budget.remainingUsd.toFixed(4)}；每次预留 $${budget.policy.perRunUsd.toFixed(4)}`,
    );
    const pacing = apiCreditPace(budget, now);
    if (pacing && creditPriority(chosen) > 0)
      scheduleReasons.push(
        `API 额度 ${Math.ceil((Date.parse(budget.policy.expiresAt!) - now) / 86400000)} 天后到期，落后计划（应已用 $${pacing.plannedUsd.toFixed(2)}，实际 $${budget.spentUsd.toFixed(2)}），优先用`,
      );
    if (budget.unreportedRuns)
      warnings.push(`${budget.unreportedRuns} 次运行费用未知：报过用量的仍按预留估算，没收到任何回复的不占预留`);
  }
  // Behind-pace expiring credit goes first; name each such card left out this time and the reason.
  const creditSkipReason = (other: RuntimeSnapshot) => {
    const own = candidates.filter((c) => c.snapshot.id === other.id);
    if (!own.length) {
      const rejected = rejections.find((r) => r.reasons[0]?.startsWith(`${other.label}：`))?.reasons[0];
      if (rejected) return rejected.slice(other.label.length + 1);
      if (!automaticExecutorAllowed(input, settings, other.id)) return '已按勾选排除';
      if (input.executionPolicy === 'cli-only') return '本次只用 CLI';
      return '未通过本次检查';
    }
    if (fullApiCards.has(other.id)) return '按节奏的并发已满，等已有运行结算';
    if (own.some((c) => creditPriority(c) > 0))
      return Date.parse(other.apiBudgetState!.policy.expiresAt!) >= Date.parse(s.apiBudgetState?.policy.expiresAt ?? '')
        ? `先用更早到期的 ${s.label}`
        : `排在 ${s.label} 之后`;
    if (input.continuationRunId) return '这条消息续接原会话，不换卡';
    if (allowed.length && !allowed.includes(routeKey(other))) return '任务类别规则指定了其他平台';
    return `没有达到任务所需${tierLabels[demand.tier]}档的模型`;
  };
  if (preferExpiring)
    for (const other of snapshots)
      if (other.id !== s.id && (apiCreditPace(other.apiBudgetState, now)?.priority ?? 0) > 0)
        scheduleReasons.push(`${other.label} 的到期额度落后计划，这次没用：${creditSkipReason(other)}`);
  if (schedule) {
    scheduleReasons.push(`本次耗时估计为 ${estimate} 分钟，不保证完成时间`);
    if (schedule.priority === 'high') scheduleReasons.push('高优先级由任务队列优先安排，不绕过能力和额度保护');
  }
  if (deadline !== undefined) {
    const remaining = (deadline - now) / 60_000;
    if (remaining < estimate) {
      const warning =
        remaining <= 0
          ? '任务截止时间已过；继续执行不能保证按时完成'
          : `距截止时间仅 ${Math.ceil(remaining)} 分钟，少于 ${estimate} 分钟的耗时估计；不为赶截止时间自动降低能力要求`;
      warnings.push(warning);
      scheduleReasons.push(warning);
    } else
      scheduleReasons.push(
        `预计可在截止时间 ${new Date(deadline).toISOString()} 前安排本次任务；实际耗时仍可能超出估计`,
      );
  }
  const defaultCandidate = representatives.find((candidate) => routeKey(candidate.snapshot) === preferred);
  const resetChangedProvider =
    preferExpiring &&
    routeKey(s) !== preferred &&
    defaultCandidate &&
    chosen.fit === defaultCandidate.fit &&
    apiHarness(s) === apiHarness(defaultCandidate.snapshot) &&
    resetOrder(chosen, defaultCandidate) < 0;
  const wasteFirst =
    wasteRank(chosen) > 0 && candidates.some((other) => other !== chosen && wasteRank(other) < wasteRank(chosen));
  if (wasteFirst) scheduleReasons.push(wasteReason(s.label, chosen.waste!, now));
  else if (stays(chosen) && candidates.some((other) => !stays(other)))
    scheduleReasons.push(
      sessionTokens
        ? `为缓存留在原卡：续接本对话的原生会话，留在 ${s.label}（上下文约 ${tokenText(sessionTokens)}，换卡要全部重读）`
        : `续接本对话的原生会话，留在 ${s.label}；快浪费的额度留给新任务`,
    );
  if (
    input.continuationRunId &&
    creditPriority(chosen) > 0 &&
    !continued(chosen) &&
    candidates.some((other) => continued(other))
  )
    scheduleReasons.push(
      sessionTokens
        ? `赠金落后 $${Math.round(creditBehind(chosen))}，新任务换卡：这条后续消息不续接原会话，换到 ${s.label}，带上下文继续，换卡要重读约 ${tokenText(sessionTokens)}`
        : `赠金落后 $${Math.round(creditBehind(chosen))}，新任务换卡：这条后续消息不续接原会话，换到 ${s.label}，带上下文继续`,
    );
  const aheadText = (c: Candidate) =>
    c.pace!.cards
      ? `${c.snapshot.label} ${c.pace!.what}超前（剩 ${Math.round(c.pace!.left)}%，含 ${c.pace!.cards} 张重置卡，按进度应剩 ${Math.round(c.pace!.ideal)}%）`
      : `${c.snapshot.label} ${c.pace!.what}超前（剩 ${Math.round(c.pace!.left)}%，按进度应剩 ${Math.round(c.pace!.ideal)}%）`;
  const sameTier = candidates.filter((other) => other !== chosen && other.pace && tierOf(other) === tierOf(chosen));
  const yielded = sameTier.find((other) => continued(other) && !stays(other));
  const ahead = sameTier.filter((other) => other.pace!.value < 1).sort((a, b) => b.pace!.left - a.pace!.left)[0];
  if (preferExpiring && chosen.pace && !wasteFirst) {
    if (chosen.pace.cardsExpireAt && sameTier.length) {
      const when = whenText(chosen.pace.cardsExpireAt, now);
      scheduleReasons.push(
        /^\d/.test(when)
          ? `${s.label} 有 ${chosen.pace.cards} 张重置卡 ${when}到期，按进度应优先用`
          : `${s.label} 有 ${chosen.pace.cards} 张重置卡${when}到期，按进度应优先用`,
      );
    }
    if (yielded)
      scheduleReasons.push(
        sessionTokens
          ? `${aheadText(yielded)}，本轮换到同档进度正常的 ${s.label}，带上下文继续，换卡要重读约 ${tokenText(sessionTokens)}`
          : `${aheadText(yielded)}，本轮换到同档进度正常的 ${s.label}，带上下文继续`,
      );
    else if (ahead && chosen.pace.value >= 1)
      scheduleReasons.push(`${aheadText(ahead)}，同档 ${s.label} 进度正常，优先它`);
    else if (ahead && !sameTier.some((other) => other.pace!.value >= 1))
      scheduleReasons.push(`同档账号额度都超前，${aheadText(chosen)}，超前最少，先用它`);
    const smaller = sameTier.filter((other) => !paceOrder(chosen, other) && capacityOrder(chosen, other) < 0);
    if (smaller.length) {
      const unknown = [chosen, ...smaller].filter((c) => !planSize(c)).map((c) => c.snapshot.label);
      scheduleReasons.push(
        unknown.length
          ? `进度相近，按套餐容量（倍数 × 剩余）先用 ${s.label}；${unknown.join('、')} 套餐名里没有倍数，按 1 倍算`
          : `进度相近，按套餐容量（倍数 × 剩余）先用 ${s.label}`,
      );
    }
  }
  // Say so when an account with more quota left waited because this one resets sooner.
  if (
    !wasteFirst &&
    chosen.lasting &&
    candidates.some(
      (other) =>
        other !== chosen &&
        (other.headroom ?? -1) > (chosen.headroom ?? -1) &&
        comparePace(chosen, other) < 0 &&
        (routeKey(other.snapshot) === routeKey(s) || allowed.length > 1),
    )
  )
    scheduleReasons.push(
      `优先用快重置的额度：${s.label} 还剩 ${Math.round(chosen.lasting.left)}%，约 ${Math.max(1, Math.round((chosen.lasting.resetAt - now) / 3_600_000))} 小时后重置，不用就会作废`,
    );
  if (preferExpiring && chosen.resetOpportunity !== undefined && (schedule || candidates.length > 1)) {
    scheduleReasons.push(
      `未来 ${opportunityMinutes} 分钟的近期机会窗口内，${s.provider} 有额度窗口将在 ${new Date(chosen.resetOpportunity).toISOString()} 重置，优先使用这一近期机会`,
    );
    warnings.push('临近重置排序是启发式；平台能力没有实测等价保证，重置只代表刷新观察点，不承诺额度恢复或足够完成任务');
  }
  return {
    accountFingerprint: s.accountFingerprint,
    ...(input.routeRule ? { routeRule: input.routeRule } : {}),
    runtimeId: s.id,
    model: chosen.model.id,
    effort: chosen.effort,
    shortQuotaLeft: chosen.shortQuotaLeft,
    ...(chosen.shortQuotaWindow ? { shortQuotaWindow: chosen.shortQuotaWindow } : {}),
    modelFit: chosen.fit,
    targetTier: demand.tier,
    kind,
    reasons: [
      ...(demand.goal === 'save' ? ['轻量模式：优先本地免费、托管免费、订阅、付费 API；临期赠金保留优先机会'] : []),
      ...(demand.goal === 'save' && sourceMayLog(s)
        ? ['此免费来源可能记录内容：仅发送纯文本对话，不发送项目上下文或附件']
        : []),
      ...(checklistReason ? [checklistReason] : []),
      ...(freeReason ? [freeReason] : []),
      ...(paidApiReason ? [paidApiReason] : []),
      ...(distributeChildren
        ? [`自动分散子任务：按模型能力、账号与独立额度池的当前负载选择 ${s.label} / ${chosen.model.id}`]
        : []),
      ...(distributeMain
        ? [
            `新任务动态分配：先匹配模型档位与额度进度，再比较当前负载、重置机会、预计浪费、可用响应记录与剩余额度，选择 ${s.label} / ${chosen.model.id}`,
          ]
        : []),
      ...(chosen.allowance
        ? [
            `成员分配：${s.label} ${chosen.allowance.reason}，同时最多 ${chosen.allowance.members} 个成员（加上这个共 ${chosen.allowance.inFlight + 1} 个）`,
          ]
        : []),
      ...(coordinator && !input.model ? ['蜂群协调者：拆分、派活和最后合并用最强的一档模型和较高思考强度'] : []),
      ...(chosen.model.quotaPool ? [`模型额度归属：${cursorModelPoolLabel(chosen.model.quotaPool)}`] : []),
      ...(chosen.poolReason ? [chosen.poolReason] : []),
      allowed.length > 1
        ? `任务分类：${routeCategoryLabels[category]} → ${allowed.map(routeKeyLabel).join(' / ')}（按剩余额度）`
        : `任务分类：${routeCategoryLabels[category]} → ${allowed.length ? allowed.map(routeKeyLabel).join(' / ') : '任意平台'}`,
      ...(standIn(chosen)
        ? [
            mature
              ? '原生 Grok 现在接不了这条成人内容，改用 Cursor 里的 Grok 模型'
              : '这类任务按规则用 Grok，改用 Cursor 里的同款 Grok 模型（按额度进度比较）',
          ]
        : []),
      accepted
        ? `历史任务判断：${accepted.kind ?? '类型用本地规则'} / ${accepted.complexity ?? '难度未判断'}；作为路由依据，仍通过能力与额度检查`
        : input.kind === 'auto'
          ? inferred.reason
          : `任务类型：${kind}`,
      // Preserve the meaning of captured legacy advice when resuming an old task.
      ...(judgment?.status === 'fallback' && judgment.requestAttempted
        ? [`历史判断未采纳（${judgment.reason}），使用本地保守策略`]
        : []),
      input.routeRule?.derived
        ? '按规则候选选择执行器'
        : input.runtimeId
          ? '用户锁定执行器'
          : routeKey(s) === preferred
            ? `优先使用 ${preferred}`
            : resetChangedProvider
              ? `候选均满足当前能力要求，临近重置偏好优先于默认平台 ${preferred}`
              : `根据当前执行策略与能力要求选择 ${s.provider}`,
      ...(settings.preferNative !== false ? ['同一平台使用已连接且通过资源检查的本机执行器'] : []),
      ...modelSelectionReasons(
        chosen.model,
        s.provider,
        demand,
        !!input.model,
        chosen.effort,
        !!input.effort,
        callerEffort,
        s.models,
      ),
      ...(input.effort && chosen.effort !== input.effort
        ? [`所选模型不支持 ${input.effort}，改用 ${chosen.effort ?? '模型默认'}`]
        : []),
      s.quota.status === 'known'
        ? chosen.billingConflict
          ? '额度按未知处理：上次请求返回余额已用完（HTTP 402），账单比例只是推算'
          : chosen.headroom === undefined
            ? '供应商报告本账期不限量'
            : `适用于所选模型的额度窗口均通过检查；最紧窗口剩余 ${chosen.headroom}%，该比例不用于跨平台比较或推算可完成任务量`
        : s.accounting?.mode === 'usage'
          ? '记录 token 与参考费用，不把用量当作余额'
          : '根据显式的未知额度策略执行',
      ...scheduleReasons,
      ...rejections.flatMap((rejection) => rejection.reasons),
    ],
    warnings,
  };
}
