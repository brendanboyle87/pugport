/** What the terminal shows for one reply, derived from the backend's state and live run events. */
import type {
  ConversationMessage,
  ReplyExecutionIdentity,
  RunEvent,
  RunRecord,
  RuntimeTarget,
  Workflow,
} from '../shared/types.ts';

export type ToolView = { id: string; name: string; detail?: string; status: 'running' | 'done' | 'error' };
/** A run as it streams in: its answer text and tool calls so far. */
export type LiveRun = { output: string; tools: Map<string, ToolView>; lastSeq: number; thinking: boolean };

export const settledStatuses = new Set<Workflow['status']>([
  'completed',
  'blocked',
  'failed',
  'cancelled',
  'interrupted',
]);
const outputLimit = 1_000_000;
const toolNames: Record<string, string> = {
  commandExecution: '运行命令',
  fileChange: '修改文件',
  webSearch: '搜索网页',
  reasoning: '思考',
  collabAgentToolCall: '子任务',
  dynamicToolCall: '工具',
};

const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
const oneLine = (value: string, limit = 120) => {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
};

export const newLiveRun = (): LiveRun => ({ output: '', tools: new Map(), lastSeq: 0, thinking: false });

function toolStatus(data: Record<string, unknown>): ToolView['status'] | undefined {
  if (data.isError === true) return 'error';
  const status = text(data.status)?.toLowerCase();
  if (!status) return undefined;
  if (/fail|error|declin|denied|reject|cancel/.test(status)) return 'error';
  if (/complet|done|success|finish|ok/.test(status)) return 'done';
  return 'running';
}

/** Adds one live event; returns false for an event already seen (a replay after reconnecting). */
export function applyRunEvent(run: LiveRun, event: RunEvent): boolean {
  if (event.seq !== undefined) {
    if (event.seq <= run.lastSeq) return false;
    run.lastSeq = event.seq;
  }
  if (event.type === 'reasoning') {
    run.thinking = true;
    return true;
  }
  if (event.type === 'text' && event.text) {
    run.thinking = false;
    run.output = (run.output + event.text).slice(-outputLimit);
  } else if (event.type === 'tool') {
    run.thinking = false;
    const data = event.data ?? {};
    const id = text(data.toolCallId) ?? text(data.itemId) ?? `event-${event.seq ?? run.tools.size}`;
    const previous = run.tools.get(id);
    const kind = text(data.kind);
    const name =
      text(data.tool) ??
      (kind && kind !== 'nativeToolCall' && kind !== 'mcpToolCall' ? (toolNames[kind] ?? kind) : undefined) ??
      previous?.name ??
      oneLine(event.text?.replace(/:\s*(started|completed|output|progress|inProgress)$/i, '') || '工具', 60);
    const detail = text(data.command) ?? text(data.path) ?? text(data.file) ?? text(data.query) ?? previous?.detail;
    run.tools.set(id, {
      id,
      name,
      ...(detail ? { detail: oneLine(detail) } : {}),
      status: toolStatus(data) ?? previous?.status ?? 'running',
    });
  }
  return true;
}

/** A run as the state reports it, for joining one that is already streaming. */
export function liveRunFrom(record: Pick<RunRecord, 'output' | 'events'>): LiveRun {
  const run = newLiveRun();
  for (const event of record.events) if (event.type !== 'text') applyRunEvent(run, event);
  run.output = record.output ?? '';
  run.lastSeq = record.events.reduce((latest, event) => Math.max(latest, event.seq ?? 0), 0);
  return run;
}

/** "Claude B", or the account label when the card is gone. */
export function executorLabel(targets: readonly RuntimeTarget[], runtimeId: string, accountLabel?: string) {
  const target = targets.find((item) => item.id === runtimeId);
  return (target?.label.replace(/\s*·\s*本机$/u, '') ?? accountLabel ?? runtimeId) || '执行器';
}

/** Which account and model answered, from what was saved with the reply. */
export function identityLabel(identity: ReplyExecutionIdentity | undefined, targets: readonly RuntimeTarget[]) {
  if (identity?.kind === 'system') return 'PugPort 系统提示';
  const run = identity?.runs.at(-1);
  return run ? `${executorLabel(targets, run.runtimeId, run.accountLabel)} · ${run.model}` : undefined;
}

export type ReplyView = {
  workflowId: string;
  status: Workflow['status'];
  settled: boolean;
  /** Who is answering: role, account and model. */
  label?: string;
  /** Short progress line while it runs. */
  activity: string;
  text: string;
  tools: ToolView[];
  error?: string;
  note?: string;
};

const waiting: Partial<Record<Workflow['status'], string>> = {
  queued: '排队中',
  'waiting-resource': '在等有额度的账号',
  'waiting-confirmation': '等你在 PugPort 桌面应用里确认用哪个账号',
  'waiting-approval': '等你在 PugPort 桌面应用里批准一个操作',
  planning: '正在规划',
};
const endings: Partial<Record<Workflow['status'], string>> = {
  failed: '没有完成',
  blocked: '暂停了，可以在 PugPort 里继续',
  cancelled: '已取消',
  interrupted: '中断了，可以在 PugPort 里继续',
};

export function replyView(input: {
  workflow: Workflow;
  runs: readonly RunRecord[];
  live: ReadonlyMap<string, LiveRun>;
  targets: readonly RuntimeTarget[];
  finalMessage?: ConversationMessage;
}): ReplyView {
  const { workflow, targets } = input;
  const settled = settledStatuses.has(workflow.status);
  const runIds = workflow.runIds.filter((id) => !workflow.visualRunIds?.includes(id));
  const currentId = runIds.at(-1);
  const record = currentId ? input.runs.find((run) => run.id === currentId) : undefined;
  const live = currentId ? input.live.get(currentId) : undefined;
  const role = workflow.agentPreset && workflow.agentPreset.id !== 'standard' ? workflow.agentPreset.name : undefined;
  const runLabel = record
    ? `${executorLabel(targets, record.route.runtimeId, record.account?.label)} · ${record.effectiveModel?.model ?? record.route.model}`
    : undefined;
  const who = (settled ? identityLabel(input.finalMessage?.replyIdentity, targets) : undefined) ?? runLabel;
  const label = [role, who].filter(Boolean).join(' · ') || undefined;
  const final = settled && input.finalMessage?.role === 'assistant' ? input.finalMessage.content : undefined;
  const streamed = live?.output || record?.output || '';
  let activity: string;
  if (settled) activity = workflow.status === 'completed' ? '完成' : (endings[workflow.status] ?? workflow.status);
  else if (workflow.status === 'waiting-confirmation' && workflow.planReview === 'pending')
    activity = '等你在 PugPort 桌面应用里批准计划';
  else if (waiting[workflow.status]) activity = waiting[workflow.status]!;
  else if (workflow.phase === 'route') activity = '正在挑选账号';
  else if (workflow.phase === 'plan') activity = '正在规划';
  else if (workflow.phase === 'verify') activity = '正在检查结果';
  else if (workflow.phase === 'summarize') activity = '正在整理答复';
  else if (live?.thinking) activity = `${who ?? 'PugPort'} 正在思考`;
  else activity = `${who ?? 'PugPort'} 正在回复`;
  const note = !settled && workflow.status === 'waiting-resource' ? workflow.scheduling?.reason : undefined;
  return {
    workflowId: workflow.id,
    status: workflow.status,
    settled,
    ...(label ? { label } : {}),
    activity,
    // A stopped task keeps whatever it had written, with the reason below it.
    text: final ?? streamed,
    tools: live ? [...live.tools.values()] : [],
    ...(settled && workflow.status !== 'completed'
      ? { error: workflow.error || endings[workflow.status] || workflow.status }
      : {}),
    ...(note ? { note } : {}),
  };
}
