import type { SentPart } from './conversation-trace.ts';
import type { AccountingMode, UsageMeasures } from './usage.ts';
import type { RunRecord } from './types.ts';

/*
 * Metering contract for Trace › Context.
 *
 * Three scopes are never added to each other:
 * - host-prompt: what PugPort itself sent. Characters are exact; token sizes are estimates (method 'estimate').
 * - provider-context: how full the executor said its context was at one model request (input + cache read +
 *   cache write). It is occupancy, not billing, and includes the executor's own system prompt and tools.
 * - provider-usage: what the executor billed or reported for the run (canonical uncached input, cache read,
 *   cache write, output, reasoning). Reasoning may already be inside output; cache write is not reuse.
 * API runs add a fourth, transcript: tool results and replies Pi returned, sized by estimate.
 *
 * Null always means "not reported" and is shown as such. A reported zero stays zero. Nothing here is
 * interpolated from run totals: a per-request row exists only when the executor reported that request.
 */
export const meteringContract = {
  version: 1,
  scopes: {
    'host-prompt': 'Text PugPort sent. Characters are exact; tokens are estimated (method=estimate).',
    'provider-context':
      'Context occupancy the executor reported for one model request (input + cache read + cache write). Not billing.',
    'provider-usage':
      'Usage the executor reported for the run. inputTokens is uncached input; cache reuse is cacheRead / (input + cacheRead); reasoning may overlap output.',
    transcript: 'API runs only: tool results and model replies Pi returned. Sizes are estimates.',
  },
  coverage: {
    'per-request': 'One row per model request the executor reported.',
    snapshot: 'Occupancy snapshots only; not every model request is represented.',
    'not-reported': 'The executor reported nothing for this value.',
  },
  nullMeans: 'not reported',
  tokenEstimate: { method: 'estimate', cjkTokensPerChar: 1, otherCharsPerToken: 4 },
} as const;

export type MeterMethod = 'exact' | 'estimate' | 'reported';
export type ContextCoverage = keyof typeof meteringContract.coverage;
export type RequestSource =
  | 'pi-assistant-message'
  | 'claude-message-usage'
  | 'codex-last-token-usage'
  | 'cursor-context-update'
  | 'run-context-snapshot';

export type RequestUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningOutputTokens: number | null;
  totalTokens: number | null;
  costUsd: number | null;
};

/** One model request (or occupancy update) the executor reported. Never synthesised from run totals. */
export type RequestObservation = {
  runId: string;
  requestId: string;
  ordinal: number;
  /** Null when the executor did not expose when the request began. */
  startedAt: string | null;
  endedAt: string | null;
  observedAt: string;
  usage: RequestUsage | null;
  contextTokens: number | null;
  contextWindow: number | null;
  /** 'request' rows carry provider usage; 'occupancy' rows only say how full the context was. */
  scope: 'request' | 'occupancy';
  source: RequestSource;
};

export type ToolOperationKind = 'read' | 'write' | 'search' | 'command' | 'web' | 'delegate' | 'other';
export type ToolOperationStatus = 'running' | 'completed' | 'failed' | 'unknown';
/** paired: start and end seen; start-only / end-only: one side missing; unpaired: no call id to join on. */
export type ToolOperationCoverage = 'paired' | 'start-only' | 'end-only' | 'unpaired';

export type ToolOperation = {
  runId: string;
  callId: string;
  ordinal: number;
  name: string;
  kind: ToolOperationKind;
  status: ToolOperationStatus;
  source: 'native' | 'pugport';
  parentCallId: string | null;
  startedAt: string | null;
  endedAt: string | null;
  command: string | null;
  program: string | null;
  exitCode: number | null;
  paths: string[];
  /** Size of the reported result text; null when no result was observed. */
  resultChars: number | null;
  updates: number;
  coverage: ToolOperationCoverage;
};

export type ContextPartGroup = 'memory' | 'instructions' | 'handoff' | 'request' | 'attachments';
export const contextPartGroups: readonly ContextPartGroup[] = [
  'memory',
  'instructions',
  'handoff',
  'request',
  'attachments',
];

export type ContextPart = {
  key: string;
  title: string;
  group: ContextPartGroup;
  chars: number;
  tokens: number;
  method: 'estimate';
  delivery?: SentPart['delivery'];
};

export type TraceContextRun = {
  runId: string;
  workflowId: string;
  depth: 0 | 1;
  /** 1-based attempt number within its own task. */
  attempt: number;
  /** Sub-task label (delegated agent or request), only for depth 1. */
  label: string | null;
  executor: string;
  runtimeId: string;
  provider: string | null;
  transport: 'api' | 'cli' | null;
  status: RunRecord['status'];
  startedAt: string;
  endedAt: string | null;
  relay: RunRecord['relay'] | null;
  error: string | null;
  sessionMode: 'fresh' | 'resumed' | null;
  carriedTools: number | null;
  unconfirmedTools: number | null;
  textOnly: boolean;
  toolless: boolean;
  promptRecorded: boolean;
  parts: ContextPart[];
  sent: { chars: number; tokens: number; method: 'estimate' };
  /** API runs only. */
  transcript: {
    toolResults: { chars: number; tokens: number };
    replies: { chars: number; tokens: number };
    method: 'estimate';
  } | null;
  /** provider-context at the run's last reported request; null = not reported. */
  reported: {
    contextTokens: number;
    contextWindow: number | null;
    at: string;
    source: RequestSource;
  } | null;
  requests: { count: number; coverage: ContextCoverage; sources: RequestSource[] };
  usage: (UsageMeasures & { accountingMode: AccountingMode }) | null;
  tools: { count: number; coverage: 'live' | 'retained-events' | 'none' };
  /** True while a stored run's history was too long to index in one step; a later read continues it. */
  partialHistory: boolean;
  route: {
    reasons: string[];
    warnings: string[];
    targetTier: string | null;
    shortQuotaLeft: number | null;
    shortQuotaWindow: string | null;
  };
  measuredFiles: string[] | null;
};

export type TraceContextPage = {
  workflowId: string;
  contract: typeof meteringContract;
  scope: { attempts: number; subtasks: number; handoffs: number };
  total: number;
  offset: number;
  limit: number;
  runs: TraceContextRun[];
};

export type Tally = { name: string; count: number };
export type RunContextDetail = {
  runId: string;
  /** Same meaning as TraceContextRun.partialHistory. */
  partialHistory: boolean;
  requests: {
    total: number;
    offset: number;
    limit: number;
    coverage: ContextCoverage;
    items: RequestObservation[];
  };
  tools: {
    total: number;
    offset: number;
    limit: number;
    coverage: 'live' | 'retained-events' | 'none';
    items: ToolOperation[];
    topTools: Tally[];
    topCommands: Tally[];
    commandCount: number;
    filesRead: Tally[];
    filesEdited: string[];
  };
};

/** Rough token size: CJK characters ≈ 1 token each, other text ≈ 4 characters per token. Always an estimate. */
export function estimateTokens(text: string): number {
  let cjk = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (
      (code >= 0x3000 && code <= 0x9fff) ||
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xff00 && code <= 0xffef)
    )
      cjk++;
  }
  return Math.ceil(cjk + (text.length - cjk) / 4);
}

// Titles whose SentPart.kind is a generic 'prompt' but which belong to a more specific group.
const groupOverrides: Record<string, ContextPartGroup> = {
  上次尝试: 'handoff',
  继续任务指令: 'handoff',
  上轮结果: 'handoff',
  子任务汇总: 'handoff',
  原始需求: 'request',
  当前问题: 'request',
  当前有效需求: 'request',
  '补充（插话）': 'request',
  补充约束: 'request',
};

export function partGroup(part: Pick<SentPart, 'title' | 'kind'>): ContextPartGroup {
  const override = groupOverrides[part.title];
  if (override) return override;
  if (part.kind === 'user' || part.kind === 'steering') return 'request';
  if (part.kind === 'memory') return 'memory';
  if (part.kind === 'handoff') return 'handoff';
  if (part.kind === 'attachments') return 'attachments';
  return 'instructions';
}

/**
 * The parts that together make up what was sent, without double counting: the full prompt and the
 * environment are views of the same text, the attachment list is metadata, and the user's original text is
 * already inside the recorded prompt. Returns no parts when the record kept no prompt.
 */
export function contextParts(parts: readonly SentPart[]): { recorded: boolean; parts: ContextPart[] } {
  const recorded = parts.some((part) => part.key === 'prompt');
  if (!recorded) return { recorded: false, parts: [] };
  return {
    recorded: true,
    parts: parts
      .filter((part) => !['prompt', 'environment', 'attachments', 'user'].includes(part.key))
      .map((part) => ({
        key: part.key,
        title: part.title,
        group: partGroup(part),
        chars: part.chars,
        tokens: estimateTokens(part.text),
        method: 'estimate' as const,
        ...(part.delivery ? { delivery: part.delivery } : {}),
      })),
  };
}

export type PartChange = { kind: 'new' } | { kind: 'same' } | { kind: 'changed'; delta: number } | { kind: 'dropped' };

const partIdentity = (parts: readonly Pick<ContextPart, 'title'>[]) => {
  const seen = new Map<string, number>();
  return parts.map((part) => {
    const index = seen.get(part.title) ?? 0;
    seen.set(part.title, index + 1);
    return `${part.title}\u0000${index}`;
  });
};

/** Matches parts by title, and by order for repeated titles. Dropped parts come back with their old size. */
export function diffParts(
  previous: readonly ContextPart[] | undefined,
  current: readonly ContextPart[],
): { changes: Map<string, PartChange>; dropped: ContextPart[] } {
  const changes = new Map<string, PartChange>();
  if (!previous) return { changes, dropped: [] };
  const before = new Map(partIdentity(previous).map((id, index) => [id, previous[index]!]));
  const ids = partIdentity(current);
  current.forEach((part, index) => {
    const old = before.get(ids[index]!);
    before.delete(ids[index]!);
    changes.set(
      part.key,
      !old
        ? { kind: 'new' }
        : old.chars === part.chars
          ? { kind: 'same' }
          : { kind: 'changed', delta: part.chars - old.chars },
    );
  });
  return { changes, dropped: [...before.values()] };
}

/** Context per request: a fall of at least 10% and 2,000 tokens is flagged; the cause is never asserted. */
export function contextDrops(
  series: readonly { ordinal: number; contextTokens: number | null }[],
): { ordinal: number; shrankBy: number }[] {
  const drops: { ordinal: number; shrankBy: number }[] = [];
  let previous: number | null = null;
  for (const item of series) {
    if (item.contextTokens === null) continue;
    if (previous !== null && previous - item.contextTokens >= Math.max(2000, previous * 0.1))
      drops.push({ ordinal: item.ordinal, shrankBy: previous - item.contextTokens });
    previous = item.contextTokens;
  }
  return drops;
}
