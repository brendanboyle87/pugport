import type { RunRecord } from './types.ts';
import { usageMetricKeys, type UsageMeasures, type UsageMetric } from './usage.ts';
import { safeToolEventText, safeToolEventValue } from './tool-event-data.ts';

export type TrajectoryLane = 'input' | 'model' | 'tools' | 'status';
export type TrajectoryStatus = 'pending' | 'running' | 'completed' | 'failed' | 'info';
export type TrajectorySourceEvent = {
  sequence: number;
  sequenceSource: 'event.seq' | 'legacy-index';
  at: string;
  type: string;
  /** Text metadata only; deltas are redacted together in their contiguous reply segment. */
  length?: number;
};
export type TrajectoryRow = {
  /** Internal compact projection input; never included in detailed trajectory responses. */
  compactData?: { native?: Record<string, unknown>; pugport?: Record<string, unknown>; kind?: string };
  key: string;
  lane: TrajectoryLane;
  label: string;
  /** Set when label is `${executor} · ${action}`: the executor holds an account label, the action is interface text. */
  labelParts?: { executor: string; action: string };
  status: TrajectoryStatus;
  text?: string;
  detail?: string;
  /** Only observed events; an update/result alone has no invented start. */
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  nativeToolId?: string;
  toolCallId?: string;
  source?: 'native' | 'pugport' | 'linked';
  detailMissing?: boolean;
  executor?: string;
  executorSource?: 'event' | 'route';
  argumentPreview?: string;
  outcome?: string;
  parentToolCallId?: string;
  stepId?: string;
  children?: TrajectoryRow[];
  sourceEvents?: TrajectorySourceEvent[];
  /** Protocol observations stay inspectable in the list, outside the timeline lanes. */
  protocol?: boolean;
  usage?: Partial<UsageMeasures>;
};
export type ExecutionTrajectory = {
  runId: string;
  needsDetail: boolean;
  rows: TrajectoryRow[];
  toolsCount: number;
  nativeToolsCount: number;
  pugportToolsCount: number;
  /** Zero means complete retention; absent on older records means unknown. */
  eventsDropped?: number;
  usage: UsageMeasures;
  outputSummary: string;
  outputDetail: string;
  metadata: { parentRunId?: string; workflowId?: string; stepId?: string };
};
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const string = (value: unknown): string => (typeof value === 'string' ? value : '');
const timestamp = (value: unknown): string | undefined =>
  typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : undefined;
const sensitiveKey =
  /(?:secret|password|passwd|credential|authorization|cookie|api[_-]?key|access[_-]?key|private[_-]?key|token)/i;
const privateKey = /(?:reasoning|thinking|system|developer|internal|protocol|instructions?|messages?|prompt)/i;
/** PugPort's name for a stage that reported none: interface text, unlike the names stages report. */
export const unnamedStageLabel = '未命名阶段';

/** Display text is bounded after redaction, including secrets crossing streamed chunk boundaries. */
function clean(raw: string | undefined, limit = 4000, applicationPrompt = false): string {
  // Older and imported run records may lack output or prompt text.
  const value = raw ?? '';
  const source = applicationPrompt
    ? value
    : value.replace(
        /<(?:system|developer|reasoning|thinking|analysis|internal)[^>]*>[\s\S]*?(?:<\/(?:system|developer|reasoning|thinking|analysis|internal)>|$)/gi,
        '[private content omitted]',
      );
  return source
    .slice(0, limit + 16000)
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/-----BEGIN [^-]*(?:PRIVATE KEY|SECRET)[^-]*-----[\s\S]*?(?:-----END [^-]+-----|$)/g, '[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(
      /(?<![\w.-])(?=["']?[\w.-]+["']?\s*[:=]\s*\S)(["']?(?:[\w.-]*(?:api[_-]?key|access[_-]?key|secret|token|password|passwd|credential|authorization|cookie)[\w.-]*)["']?\s*[:=]\s*)(?:"[^"\r\n]*(?:"|$)|'[^'\r\n]*(?:'|$)|[^\s,;}]+)/gi,
      '$1[redacted]',
    )
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]+|gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|xox[baprs]-[A-Za-z0-9-]+|AKIA[A-Z0-9]{16}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g,
      '[redacted]',
    )
    .replace(/\b[A-Za-z0-9_+/=-]{40,}\b/g, '[redacted]')
    .slice(0, limit);
}
/** Only the explicit PugPort execution prompt/context may use this path. Never native protocol packets. */
export function cleanPrompt(value: string): string {
  return clean(value, value.length, true);
}
/** Only run.reasoning is admitted here, never a native protocol packet. */
export function cleanReasoning(value: string, limit = value.length): string {
  return clean(value.replace(/<\/?(?:thinking|reasoning)\b[^>]*>/gi, ''), limit);
}
// Explicit routing and call IDs are public correlation metadata, not opaque credentials.
const cleanIdentifier = (value: string) => safeToolEventText(value, 200);
const displayPreview = (value: string, limit: number) => {
  const safe = safeToolEventText(value);
  return safe.length > limit ? `${safe.slice(0, limit)}…` : safe;
};
function details(data: Record<string, unknown>, previous: Record<string, unknown> = {}): Record<string, unknown> {
  // Never serialize a whole native packet. Only fields meant for tool display are admitted.
  const display = Object.fromEntries(
    [
      'command',
      'cwd',
      'arguments',
      'input',
      'output',
      'result',
      'detail',
      'exitCode',
      'steps',
      'handler',
      'origin',
      'journal',
      'moved',
      'nativeTool',
      'title',
      'nativePromptId',
      'nativeEventId',
      'executor',
      'provider',
      'runtimeId',
      'transport',
      'outputMode',
      'observedPhase',
      'nativeMethod',
      'captureState',
      'observedFields',
      'failureDetail',
      'failureMessage',
      'durationMs',
      'parentToolCallId',
      'partial',
      'resultObserved',
      'startUnknown',
      'malformedErrorFlag',
    ]
      .filter((key) => data[key] !== undefined)
      .map((key) => [key, safeToolEventValue(data[key])]),
  );
  const merged = { ...previous, ...display };
  // Intermediate output observations remain in history; a later replay cannot replace a full snapshot.
  if (
    ['delta', 'progress'].includes(string(data.outputMode)) &&
    previous.output !== undefined &&
    !['delta', 'progress'].includes(string(previous.outputMode))
  ) {
    merged.output = previous.output;
    if (previous.outputMode === undefined) delete merged.outputMode;
    else merged.outputMode = previous.outputMode;
  } else if (data.output !== undefined && data.outputMode === undefined) delete merged.outputMode;
  return merged;
}
function applicationDetails(data: Record<string, unknown>, allowPrompt = true): string | undefined {
  const explicit = {
    ...object(data.detail),
    ...(data.parentToolCallId ? { parentToolCallId: data.parentToolCallId } : {}),
    ...(data.stepId ? { stepId: data.stepId } : {}),
  };
  const display = Object.fromEntries(
    Object.entries(explicit).flatMap(([key, value]) => {
      // These two fields are admitted only at the explicitly reported application context boundary.
      if (allowPrompt && (key === 'prompt' || key === 'instructions'))
        return [[key, typeof value === 'string' ? cleanPrompt(value) : safeToolEventValue(value)]];
      if (privateKey.test(key)) return [];
      return [[clean(key, 100), sensitiveKey.test(key) ? '[redacted]' : safeToolEventValue(value)]];
    }),
  );
  if (!Object.keys(display).length) return undefined;
  return JSON.stringify(display, null, 2);
}
function renderDetails(display: Record<string, unknown>): string | undefined {
  if (!Object.keys(display).length) return undefined;
  return JSON.stringify(display, null, 2);
}
function status(value: unknown): TrajectoryStatus {
  const phase = string(value).toLowerCase().replace(/[_ -]/g, '');
  if (['failed', 'error', 'denied', 'rejected'].includes(phase)) return 'failed';
  if (['completed', 'complete', 'succeeded', 'success', 'result', 'finished'].includes(phase)) return 'completed';
  if (['started', 'start', 'running', 'inprogress'].includes(phase)) return 'running';
  if (['pending', 'queued'].includes(phase)) return 'pending';
  return 'info';
}
function duration(row: TrajectoryRow): void {
  delete row.durationMs;
  if (row.startedAt && row.endedAt) {
    const elapsed = Date.parse(row.endedAt) - Date.parse(row.startedAt);
    if (elapsed >= 0) row.durationMs = elapsed;
  }
}
const blankUsage = (): UsageMeasures => Object.fromEntries(usageMetricKeys.map((key) => [key, null])) as UsageMeasures;
const aliases: Record<UsageMetric, string[]> = {
  inputTokens: ['inputTokens', 'input_tokens', 'prompt_tokens', 'input'],
  outputTokens: ['outputTokens', 'output_tokens', 'completion_tokens', 'output'],
  cacheReadTokens: ['cacheReadTokens', 'cachedInputTokens', 'cache_read_input_tokens', 'cacheRead'],
  cacheWriteTokens: ['cacheWriteTokens', 'cache_creation_input_tokens', 'cacheWrite'],
  reasoningOutputTokens: ['reasoningOutputTokens', 'reasoning_tokens'],
  totalTokens: ['totalTokens', 'total_tokens'],
  estimatedCostUsd: ['estimatedCostUsd', 'costUsd', 'total_cost_usd'],
};
function messageUsage(data: Record<string, unknown>): Partial<UsageMeasures> {
  const values = { ...object(data.usage), ...data };
  return Object.fromEntries(
    usageMetricKeys.flatMap((metric) => {
      const value = aliases[metric]
        .map((alias) => values[alias])
        .find((item) => typeof item === 'number' && Number.isFinite(item) && item >= 0);
      return typeof value === 'number' ? [[metric, value]] : [];
    }),
  );
}
/** Report usage without deriving or cleaning the run's potentially large payloads. */
export function trajectoryUsage(run: RunRecord): UsageMeasures {
  if (run.summary) return blankUsage();
  const result = blankUsage(),
    delta = blankUsage(),
    cumulative = blankUsage(),
    baseline = blankUsage();
  const seen = new Set<string>();
  for (const event of run.events) {
    if (event.type !== 'usage') continue;
    const data = event.data ?? {};
    const key = string(data.eventId) || JSON.stringify([event.at, data]);
    if (seen.has(key)) continue;
    seen.add(key);
    const total = object(data.total),
      usage = object(data.usage);
    const values = Object.keys(total).length ? total : { ...usage, ...data };
    const session = data.scope === 'session-cumulative' || Object.keys(total).length > 0;
    const summed = session || data.cumulative === true || data.scope === 'run-cumulative';
    for (const metric of usageMetricKeys) {
      const value = aliases[metric]
        .map((alias) => values[alias])
        .find((item) => typeof item === 'number' && Number.isFinite(item) && item >= 0);
      if (typeof value !== 'number') continue;
      if (data.baseline === true) {
        baseline[metric] = value;
        continue;
      }
      if (session && baseline[metric] === null && data.freshSession !== true) continue;
      const amount = session ? Math.max(0, value - (baseline[metric] ?? 0)) : value;
      if (summed) cumulative[metric] = amount;
      else delta[metric] = (delta[metric] ?? 0) + amount;
    }
  }
  for (const metric of usageMetricKeys) result[metric] = cumulative[metric] ?? delta[metric];
  return result;
}

/** Pure view of observed events; hierarchy requires explicit bridge parent IDs. */
export function deriveTrajectory(run: RunRecord, userInput?: string, compact = false): ExecutionTrajectory {
  const projection: ExecutionTrajectory = {
    runId: run.id,
    needsDetail: run.summary === true,
    rows: [],
    toolsCount: 0,
    nativeToolsCount: 0,
    pugportToolsCount: 0,
    eventsDropped: run.eventsDropped,
    usage: trajectoryUsage(run),
    outputSummary: clean(run.output),
    outputDetail: compact ? '' : clean(run.output, run.output?.length ?? 0),
    metadata: { parentRunId: run.parentRunId, workflowId: run.workflowId, stepId: run.stepId },
  };
  if (run.summary) return projection;
  const rows = projection.rows;
  rows.push({
    key: `${run.id}:input`,
    lane: 'input',
    label: 'User input',
    status: 'info',
    text: userInput !== undefined ? clean(userInput) : undefined,
    detail: userInput !== undefined ? clean(userInput, userInput.length) : undefined,
    startedAt: timestamp(run.startedAt),
  });
  const hasExecutionContext = run.events.some(
    (event) =>
      event.type === 'status' &&
      event.data?.source === 'pugport' &&
      event.data?.kind === 'execution-context' &&
      typeof object(event.data.detail).prompt === 'string',
  );
  const hasRouting = run.events.some(
    (event) => event.type === 'status' && event.data?.source === 'pugport' && event.data?.kind === 'routing',
  );
  if (!hasExecutionContext)
    rows.push({
      key: `${run.id}:execution-context`,
      lane: 'input',
      label: 'PugPort execution prompt',
      status: 'info',
      source: 'pugport',
      text: 'The execution prompt assembled by PugPort. Native CLI system prompts are not reported.',
      detail: cleanPrompt(run.prompt),
      startedAt: timestamp(run.startedAt),
    });
  if (!hasRouting)
    rows.push({
      key: `${run.id}:routing`,
      lane: 'status',
      label: 'PugPort routing',
      status: 'info',
      source: 'pugport',
      text: `${cleanIdentifier(run.route.runtimeId)} · ${clean(run.route.model)}${run.route.effort ? ` · ${clean(run.route.effort)}` : ''}`,
      detail: renderDetails({
        runtimeId: cleanIdentifier(run.route.runtimeId),
        model: clean(run.route.model),
        ...(run.route.effort ? { effort: clean(run.route.effort) } : {}),
        reasons: safeToolEventValue(run.route.reasons),
        warnings: safeToolEventValue(run.route.warnings),
      }),
      startedAt: timestamp(run.startedAt),
    });
  const tools = new Map<string, TrajectoryRow>();
  const toolDetails = new Map<string, Record<string, unknown>>();
  const stages = new Map<string, TrajectoryRow>();
  const stageEvents = new Map<string, unknown[]>();
  const routing = object(
    run.events.find((event) => event.data?.source === 'pugport' && event.data?.kind === 'routing')?.data?.detail,
  );
  const provider = string(routing.provider) || run.route.runtimeId.split('-')[0];
  const cli =
    (
      {
        grok: 'Grok CLI',
        codex: 'Codex CLI',
        claude: 'Claude CLI',
        gemini: 'Gemini CLI',
        cursor: 'Cursor CLI',
        pi: 'Pi CLI',
      } as Record<string, string>
    )[provider] || '原生 CLI';
  // "CLI / account label": Trajectory.tsx keeps the part after the first " / " as written (it can be a user's name).
  const executor = [cli, clean(string(routing.executor), 100)].filter(Boolean).join(' / ');
  let reply: TrajectoryRow | undefined;
  let replyChunks: string[] = [];
  const closeReply = () => {
    if (!reply) return;
    const source = replyChunks.join('');
    reply.detail = clean(source, source.length);
    reply.text = reply.detail.slice(0, 4000);
    duration(reply);
    if (reply.durationMs === 0) delete reply.durationMs;
    reply = undefined;
    replyChunks = [];
  };
  for (const [index, event] of run.events.entries()) {
    const data = event.data ?? {};
    const sequence = event.seq ?? index;
    const sourceEvent: TrajectorySourceEvent = {
      sequence,
      sequenceSource: event.seq === undefined ? 'legacy-index' : 'event.seq',
      at: safeToolEventText(event.at),
      type: event.type,
      ...(event.type === 'text' ? { length: event.text?.length ?? 0 } : {}),
    };
    if (event.type === 'reasoning') continue;
    if (['system', 'developer', 'reasoning', 'analysis', 'thinking'].includes(string(data.role).toLowerCase()))
      continue;
    if (event.type === 'text') {
      if (!reply) {
        reply = {
          key: `${run.id}:reply:${sequence}`,
          lane: 'model',
          label: 'Model reply',
          status: 'info',
          startedAt: timestamp(event.at),
        };
        rows.push(reply);
      }
      // Keep the entire contiguous segment until redaction so split credentials cannot leak.
      replyChunks.push(event.text ?? '');
      reply.endedAt = timestamp(event.at);
      (reply.sourceEvents ??= []).push(sourceEvent);
      continue;
    }
    if (event.type === 'usage' && data.scope === 'assistant-message' && data.source === 'Pi RPC') {
      const model: TrajectoryRow = reply ?? {
        key: `${run.id}:model-call:${sequence}`,
        lane: 'model' as const,
        label: '模型调用（无文字）',
        status: 'info' as const,
        startedAt: timestamp(event.at),
      };
      model.usage = messageUsage(data);
      (model.sourceEvents ??= []).push(sourceEvent);
      if (!reply) rows.push(model);
      closeReply();
      continue;
    }
    closeReply();
    if (event.type === 'usage') {
      rows.push({
        key: `${run.id}:usage:${sequence}`,
        lane: 'status',
        label: 'Usage',
        status: 'info',
        protocol: true,
        startedAt: timestamp(event.at),
        sourceEvents: [sourceEvent],
        detail: renderDetails(messageUsage(data)),
      });
      continue;
    }
    if (event.type === 'status' && data.source === 'pugport' && data.kind === 'internal-step') {
      const info = object(data.detail);
      const parentId = string(data.parentToolCallId);
      const stepId = string(data.stepId) || string(info.id);
      // Missing stage IDs remain separate observations. Never infer linkage from labels or time.
      const identity = JSON.stringify([parentId, stepId || `observed:${sequence}`]);
      let stage = stages.get(identity);
      if (!stage) {
        stage = {
          key: `${run.id}:stage:${identity}`,
          lane: 'status',
          source: 'pugport',
          label: clean(string(info.label) || event.text || string(info.name) || stepId || unnamedStageLabel, 200),
          status: 'info',
          parentToolCallId: cleanIdentifier(parentId),
          stepId: cleanIdentifier(stepId),
        };
        stages.set(identity, stage);
        rows.push(stage);
      }
      const observed = status(data.status ?? info.status);
      (stage.sourceEvents ??= []).push(sourceEvent);
      const at = timestamp(event.at);
      if (
        (observed === 'running' || observed === 'pending') &&
        at &&
        (!stage.startedAt || Date.parse(at) < Date.parse(stage.startedAt))
      )
        stage.startedAt = at;
      if (
        (observed === 'completed' || observed === 'failed') &&
        at &&
        (!stage.endedAt || Date.parse(at) > Date.parse(stage.endedAt))
      )
        stage.endedAt = at;
      if (
        stage.status !== 'failed' &&
        !(['completed', 'failed'].includes(stage.status) && ['running', 'pending'].includes(observed))
      )
        stage.status = observed;
      const history = stageEvents.get(identity) ?? [];
      const observedDetail = applicationDetails(data);
      history.push({
        at: safeToolEventText(event.at),
        sequence,
        sequenceSource: sourceEvent.sequenceSource,
        status: observed,
        text: safeToolEventText(event.text ?? ''),
        detail: observedDetail ? JSON.parse(observedDetail) : undefined,
      });
      stageEvents.set(identity, history);
      duration(stage);
      continue;
    }
    if (event.type === 'tool') {
      const id = string(data.toolCallId) || string(data.itemId) || string(data.callId);
      const application = data.source === 'pugport';
      const linked = application ? string(data.nativeToolCallId) : '';
      // Matching names or coincidentally equal call IDs never imply a relationship.
      const identity = linked
        ? `native:${linked}`
        : `${application ? 'pugport' : 'native'}:${id || `observed:${sequence}`}`;
      let row = tools.get(identity);
      const phase = data.status ?? data.phase;
      const observedStatus =
        data.isError === true || (typeof data.exitCode === 'number' && data.exitCode !== 0) ? 'failed' : status(phase);
      if (!row) {
        row = {
          key: `${run.id}:tool:${identity}`,
          lane: 'tools',
          label: clean(string(data.tool) || event.text || string(data.kind) || 'Tool call', 200),
          status: observedStatus,
          source: application ? (linked ? 'linked' : 'pugport') : 'native',
          executor,
          executorSource: 'route',
          ...(application && id ? { toolCallId: cleanIdentifier(id) } : {}),
          ...((!application && id) || linked ? { nativeToolId: cleanIdentifier(linked || id) } : {}),
        };
        tools.set(identity, row);
        rows.push(row);
      }
      if (application) {
        if (id) row.toolCallId = cleanIdentifier(id);
        if (linked) {
          row.nativeToolId = cleanIdentifier(linked);
          row.source = 'linked';
        }
      } else if (row.toolCallId) row.source = 'linked';
      if (string(data.executor) || string(data.provider)) {
        const reportedCli =
          (
            {
              grok: 'Grok CLI',
              codex: 'Codex CLI',
              claude: 'Claude CLI',
              gemini: 'Gemini CLI',
              cursor: 'Cursor CLI',
              pi: 'Pi CLI',
            } as Record<string, string>
          )[string(data.provider)] || cli;
        row.executor = [reportedCli, clean(string(data.executor), 100)].filter(Boolean).join(' / ');
        row.executorSource = 'event';
      }
      const at = timestamp(event.at);
      (row.sourceEvents ??= []).push(sourceEvent);
      if (observedStatus === 'running' || observedStatus === 'pending') {
        if (at && (!row.startedAt || Date.parse(at) < Date.parse(row.startedAt))) row.startedAt = at;
        if (!row.endedAt && row.status !== 'completed' && row.status !== 'failed') row.status = observedStatus;
      } else if (observedStatus === 'completed' || observedStatus === 'failed') {
        if (at && (!row.endedAt || Date.parse(at) > Date.parse(row.endedAt))) row.endedAt = at;
        // Failure is never erased by a replayed success.
        if (row.status !== 'failed') row.status = observedStatus;
      }
      if (string(data.tool)) row.label = clean(string(data.tool), 200);
      const previous = toolDetails.get(identity) ?? {};
      if (compact) {
        const side = application ? 'pugport' : 'native';
        const prior = object(previous[side]);
        // Keep references to the small display envelope. Only visible titles and actual
        // background-task tails need sanitizing; ordinary tool outputs are never rendered.
        const source = { ...prior };
        for (const key of [
          'command',
          'cwd',
          'arguments',
          'input',
          'output',
          'result',
          'exitCode',
          'title',
          'outputMode',
        ])
          if (data[key] !== undefined) source[key] = data[key];
        if (
          ['delta', 'progress'].includes(string(data.outputMode)) &&
          prior.output !== undefined &&
          !['delta', 'progress'].includes(string(prior.outputMode))
        ) {
          source.output = prior.output;
          source.outputMode = prior.outputMode;
        } else if (data.output !== undefined && data.outputMode === undefined) delete source.outputMode;
        const display = { ...previous, [side]: source, kind: string(data.kind) };
        toolDetails.set(identity, display);
        row.compactData = display;
        duration(row);
        continue;
      }
      const display = {
        ...previous,
        [application ? 'pugport' : 'native']: details(data, object(previous[application ? 'pugport' : 'native'])),
        observations: Array.isArray(previous.observations) ? previous.observations : [],
      };
      display.observations.push({
        at: safeToolEventText(event.at),
        sequence,
        sequenceSource: sourceEvent.sequenceSource,
        type: event.type,
        text: safeToolEventText(event.text ?? ''),
        source: application ? 'pugport' : 'native',
        data: {
          ...details(data),
          ...Object.fromEntries(
            [
              'status',
              'phase',
              'kind',
              'tool',
              'isError',
              'toolCallId',
              'nativeToolCallId',
              'itemId',
              'callId',
              'executor',
              'provider',
              'runtimeId',
            ]
              .filter((key) => data[key] !== undefined)
              .map((key) => [key, safeToolEventValue(data[key])]),
          ),
        },
      });
      toolDetails.set(identity, display);
      const sourceDetails = object(display[application ? 'pugport' : 'native']);
      const input = object(sourceDetails.arguments ?? sourceDetails.input);
      const args = Object.keys(object(input.tool_input)).length ? object(input.tool_input) : input;
      const preview = [
        'path',
        'file',
        'file_path',
        'target_file',
        'folder',
        'cwd',
        'query',
        'pattern',
        'command',
        'cmd',
        'url',
      ].flatMap((key) =>
        args[key] !== undefined
          ? [`${key}: ${typeof args[key] === 'string' ? args[key] : JSON.stringify(args[key])}`]
          : [],
      );
      if (!preview.length && sourceDetails.command) preview.push(`command: ${String(sourceDetails.command)}`);
      if (preview.length) row.argumentPreview = displayPreview(preview.join(' · '), 240);
      const rawResult = sourceDetails.result ?? sourceDetails.output;
      const result = object(rawResult);
      const outcome = ['status', 'count', 'total', 'exitCode', 'error', 'message'].flatMap((key) =>
        result[key] !== undefined ? [`${key}: ${String(result[key])}`] : [],
      );
      if (sourceDetails.exitCode !== undefined) outcome.push(`exitCode: ${String(sourceDetails.exitCode)}`);
      if (!outcome.length) {
        const content = Array.isArray(rawResult) ? rawResult : Array.isArray(result.content) ? result.content : [];
        const reportedText =
          string(rawResult) ||
          content
            .map((block) => (object(block).type === 'text' ? string(object(block).text) : ''))
            .filter(Boolean)
            .join(' ') ||
          string(object(result.output).OkayOutput) ||
          string(object(result.output).ErrorOutput);
        if (reportedText) outcome.push(reportedText.replace(/\s+/g, ' '));
      }
      row.outcome = outcome.length ? displayPreview(outcome.join(' · '), 160) : undefined;
      row.detailMissing = !Object.values(display).some((value) => Object.keys(object(value)).length > 0);
      duration(row);
    } else if (['status', 'error', 'approval'].includes(event.type)) {
      const application = data.source === 'pugport';
      const nativeStatus =
        data.source === 'native' &&
        [
          'process-start',
          'process-reuse',
          'process-exit',
          'protocol-unmapped',
          'protocol-observation',
          'model-request',
          'model-confirmed',
          'permission-config',
        ].includes(string(data.kind));
      const fullText = clean(event.text ?? '', event.text?.length ?? 0);
      const applicationDetail = application || nativeStatus ? applicationDetails(data, application) : undefined;
      const reported = object(data.detail);
      const nativeExecutor = [
        (
          {
            grok: 'Grok CLI',
            codex: 'Codex CLI',
            claude: 'Claude CLI',
            gemini: 'Gemini CLI',
            cursor: 'Cursor CLI',
            pi: 'Pi CLI',
          } as Record<string, string>
        )[string(reported.provider)] || cli,
        clean(string(reported.executor), 100),
      ]
        .filter(Boolean)
        .join(' / ');
      const nativeActions: Record<string, string> = {
        'process-start': '启动进程',
        'process-reuse': '复用进程',
        'process-exit': '进程退出',
        'protocol-unmapped': '未映射协议事件',
        'protocol-observation': '协议控制事件',
        'model-request': '请求 API 模型',
        'model-confirmed': '已确认 API 模型',
        'permission-config': '权限配置',
      };
      const applicationLabels: Record<string, string> = {
        routing: 'PugPort routing',
        'execution-context': 'PugPort execution context',
        communication: 'PugPort communication',
      };
      const applicationLabel = application ? applicationLabels[string(data.kind)] : undefined;
      const labelParts = nativeStatus
        ? { executor: nativeExecutor, action: nativeActions[string(data.kind)] }
        : !applicationLabel && event.type === 'status' && /启动|launch|spawn/i.test(event.text ?? '')
          ? { executor, action: '启动执行器' }
          : undefined;
      rows.push({
        key: `${run.id}:${event.type}:${sequence}`,
        ...((nativeStatus && ['protocol-observation', 'protocol-unmapped'].includes(string(data.kind))) ||
        (application && data.kind === 'startup-timing')
          ? { protocol: true }
          : {}),
        sourceEvents: [sourceEvent],
        lane: application && data.kind === 'execution-context' ? 'input' : 'status',
        label: labelParts
          ? `${labelParts.executor} · ${labelParts.action}`
          : (applicationLabel ??
            (event.type === 'error' ? 'Error' : event.type === 'approval' ? 'Approval' : 'Status')),
        ...(labelParts ? { labelParts } : {}),
        ...(application && data.kind === 'execution-context' ? { executor } : {}),
        ...(application ? { source: 'pugport' as const } : {}),
        ...(nativeStatus ? { source: 'native' as const, executor: nativeExecutor } : {}),
        detail: [fullText, applicationDetail].filter(Boolean).join('\n\n'),
        status:
          event.type === 'error'
            ? 'failed'
            : nativeStatus && data.kind === 'process-exit'
              ? typeof reported.exitCode === 'number'
                ? reported.exitCode === 0
                  ? 'completed'
                  : 'failed'
                : 'info'
              : nativeStatus && (data.kind === 'process-start' || data.kind === 'process-reuse')
                ? 'running'
                : event.type === 'approval'
                  ? ['denied', 'cancelled', 'expired'].includes(string(data.status))
                    ? 'failed'
                    : data.status === 'approved'
                      ? 'completed'
                      : 'pending'
                  : 'info',
        text: clean(event.text ?? ''),
        startedAt: timestamp(event.at),
      });
    }
  }
  closeReply();
  // Serialize accumulated observations once, not the whole growing history for every streamed event.
  if (!compact)
    for (const [identity, row] of tools) {
      row.detail = renderDetails({
        ...toolDetails.get(identity),
        ids: { toolCallId: row.toolCallId, nativeToolCallId: row.nativeToolId },
        executor: row.executor,
        executorSource: row.executorSource,
      });
    }
  for (const [identity, stage] of stages) {
    stage.detail = renderDetails({
      parentToolCallId: stage.parentToolCallId,
      stepId: stage.stepId,
      observations: stageEvents.get(identity),
    });
  }
  // Resolve after reading all events, so stages reported before their bridge call also attach.
  const bridgeParents = new Map<string, TrajectoryRow>();
  for (const row of tools.values()) if (row.toolCallId) bridgeParents.set(row.toolCallId, row);
  const nested = new Set<TrajectoryRow>();
  for (const stage of stages.values()) {
    const parent = stage.parentToolCallId ? bridgeParents.get(stage.parentToolCallId) : undefined;
    if (parent) {
      (parent.children ??= []).push(stage);
      nested.add(stage);
    } else stage.text = `父调用未知 · ${stage.parentToolCallId || '未报告调用 ID'}`;
  }
  for (let index = rows.length - 1; index >= 0; index--) if (nested.has(rows[index])) rows.splice(index, 1);
  for (const parent of tools.values())
    if (parent.children?.length)
      parent.detail = renderDetails({
        ...(parent.detail ? JSON.parse(parent.detail) : {}),
        stages: parent.children.map((child) => ({
          label: child.label,
          status: child.status,
          startedAt: child.startedAt,
          endedAt: child.endedAt,
          durationMs: child.durationMs,
          detail: child.detail ? JSON.parse(child.detail) : undefined,
        })),
      });
  projection.toolsCount = tools.size;
  projection.nativeToolsCount = [...tools.values()].filter(
    (row) => row.source === 'native' || row.source === 'linked',
  ).length;
  projection.pugportToolsCount = [...tools.values()].filter(
    (row) => row.source === 'pugport' || row.source === 'linked',
  ).length;
  if (!['queued', 'running', 'waiting-approval'].includes(run.status)) {
    for (const row of tools.values()) {
      if (row.status === 'running' || row.status === 'pending') {
        row.status = 'info';
        row.text = 'Tool completion was not observed before this run ended.';
      }
    }
  }
  if (!rows.some((row) => row.lane === 'model' && row.label === 'Model reply') && run.output)
    rows.push({
      key: `${run.id}:output`,
      lane: 'model',
      label: 'Model reply',
      status: 'info',
      text: projection.outputSummary,
      detail: compact ? clean(run.output, run.output.length) : projection.outputDetail,
    });
  if (run.reasoning?.trim()) {
    const detail = cleanReasoning(run.reasoning);
    const firstModel = rows.findIndex((row) => row.lane === 'model');
    rows.splice(firstModel < 0 ? rows.length : firstModel, 0, {
      key: `${run.id}:reasoning`,
      lane: 'model',
      label: '思考',
      status: 'info',
      text: detail.slice(0, 4000),
      detail,
    });
  }
  if (run.error && !rows.some((row) => row.label === 'Error'))
    rows.push({
      key: `${run.id}:error`,
      lane: 'status',
      label: 'Error',
      status: 'failed',
      text: clean(run.error),
      detail: clean(run.error, run.error.length),
    });
  const state =
    run.status === 'queued' || run.status === 'waiting-approval'
      ? 'pending'
      : run.status === 'running'
        ? 'running'
        : run.status === 'completed'
          ? 'completed'
          : run.status === 'failed'
            ? 'failed'
            : 'info';
  const lifecycle: TrajectoryRow = {
    key: `${run.id}:lifecycle`,
    lane: 'status',
    label: 'Run status',
    status: state,
    text: run.status,
    startedAt: timestamp(run.startedAt),
    endedAt: timestamp(run.endedAt),
  };
  duration(lifecycle);
  rows.push(lifecycle);
  // Empty references distinguish run metadata/fallback rows from observed event rows.
  for (const row of rows) row.sourceEvents ??= [];
  return projection;
}

export function isProtocolTrajectoryRow(row: TrajectoryRow): boolean {
  return row.protocol === true;
}

export type TrajectoryTimelineMark = {
  key: string;
  rowKeys: string[];
  row: TrajectoryRow;
  lane: TrajectoryLane;
  leftPercent: number;
  widthPercent: number;
  count: number;
};
export type TrajectoryTimelineGeometry = {
  marks: TrajectoryTimelineMark[];
  elapsedMs?: number;
  protocolCount: number;
  unknownTiming: number;
};

/** All supplied rows participate; the list's display window never limits the timeline. */
export function deriveTimelineGeometry(
  rows: readonly TrajectoryRow[],
  run: Pick<RunRecord, 'startedAt' | 'endedAt'>,
  buckets = 240,
): TrajectoryTimelineGeometry {
  const readTime = (value: string | undefined) => (timestamp(value) ? Date.parse(value!) : undefined);
  const start = readTime(run.startedAt);
  let end = readTime(run.endedAt) ?? start;
  for (const row of rows) {
    for (const value of [row.startedAt, row.endedAt]) {
      const at = readTime(value);
      if (at !== undefined) end = Math.max(end ?? at, at);
    }
  }
  const elapsedMs = start !== undefined && end !== undefined && end >= start ? end - start : undefined;
  const scale = Math.max(elapsedMs ?? 0, 1);
  const bucketCount = Number.isFinite(buckets) ? Math.max(1, Math.floor(buckets)) : 240;
  const floor = 100 / bucketCount;
  const merged = new Map<string, TrajectoryTimelineMark>();
  const statusPriority = { failed: 4, running: 3, pending: 2, completed: 1, info: 0 };
  let protocolCount = 0;
  let unknownTiming = 0;
  for (const row of rows) {
    if (isProtocolTrajectoryRow(row)) {
      protocolCount++;
      continue;
    }
    if (row.lane === 'model' && row.label === '思考') continue;
    const rowStart = readTime(row.startedAt);
    if (rowStart === undefined) unknownTiming++;
    const at = rowStart ?? readTime(row.endedAt);
    if (at === undefined || start === undefined) continue;
    const offset = Math.min(100, Math.max(0, ((at - start) / scale) * 100));
    const bucket = Math.min(bucketCount - 1, Math.floor(offset / floor));
    const leftPercent = Math.min(100 - floor, offset);
    const span =
      (row.lane === 'tools' || row.lane === 'model') &&
      typeof row.durationMs === 'number' &&
      Number.isFinite(row.durationMs) &&
      row.durationMs > 0
        ? (row.durationMs / scale) * 100
        : 0;
    const widthPercent = Math.min(100 - leftPercent, Math.max(floor, span));
    const identity = `${row.lane}:${bucket}`;
    const existing = merged.get(identity);
    if (existing) {
      const right = Math.max(existing.leftPercent + existing.widthPercent, leftPercent + widthPercent);
      existing.leftPercent = Math.min(existing.leftPercent, leftPercent);
      existing.widthPercent = right - existing.leftPercent;
      existing.rowKeys.push(row.key);
      existing.count++;
      if (
        statusPriority[row.status] > statusPriority[existing.row.status] ||
        (row.status === existing.row.status && (row.durationMs ?? 0) > (existing.row.durationMs ?? 0))
      )
        existing.row = row;
    } else {
      merged.set(identity, {
        key: identity,
        rowKeys: [row.key],
        row,
        lane: row.lane,
        leftPercent,
        widthPercent,
        count: 1,
      });
    }
  }
  return { marks: [...merged.values()], elapsedMs, protocolCount, unknownTiming };
}
