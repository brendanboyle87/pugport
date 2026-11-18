import type { RunEvent, RunRecord } from '../shared/types.ts';
import { commandCheck } from './command-check.ts';
import { readOnlyCheck } from './handoff-note.ts';
import { fileChangePaths } from './task-file-outcome.ts';

/**
 * PugPort tools that never change files: lookups and analysis (the bridge marks them readOnlyHint), plus the
 * coordination tools, whose children's writes are tracked on the children's own runs. A test keeps this in
 * step with the bridge, so a new read-only tool cannot be mistaken for an unconfirmed write.
 */
export const fileSafeBridgeTools = new Set([
  'report_outcome',
  'web_search',
  'web_fetch',
  'git',
  'read_run_detail',
  'find_files',
  'search_text',
  'read_document',
  'find_similar_images',
  'summarize_folder',
  'find_duplicates',
  'check_style',
  'analyze_media',
  'test_page',
  'list_agents',
  'list_conversations',
  'delegate',
  'delegate_many',
  'get_result',
  'cancel_task',
  'message_task',
  'report_progress',
  'message_parent',
  'list_swarm',
  'message_agent',
  'set_plan',
]);
const readTools = fileSafeBridgeTools;
type Tool = {
  status: string;
  readOnly: boolean;
  failed: boolean;
  successful: boolean;
  sequence: number;
  fileWrite?: boolean;
  paths?: string[];
  command?: ReturnType<typeof commandCheck>;
  metadata: Record<string, unknown>;
};
/** Classified executor errors (see redactError) that describe the connection or account, not the work. */
const transportErrors = new Set([
  'quota-or-rate-limit',
  'runtime-network-error',
  'runtime-timeout',
  'runtime-image-input-unavailable',
  'runtime-image-dropped',
  'authentication-required',
  'runtime-protocol-incompatible',
  'runtime-process-closed',
  'runtime-not-found',
  'api-budget-exhausted',
  'api-budget-expired',
  'api-budget-usage-unknown',
  'operation-cancelled',
]);

/** Observe live events, not the truncated run.events tail. Never infer progress from prose/claims. */
export class TaskContinuationProgress {
  private tools = new Map<string, Tool>();
  private unsafe = false;
  private sequence = 0;
  private errors = new Set<string>();

  constructor(private readonly githubReadTools: readonly string[] = []) {}

  observe(event: RunEvent) {
    if (this.unsafe) return;
    const data = event.data ?? {};
    if (
      event.type === 'approval' ||
      data.executionBlocked === true ||
      data.relayBlocked === true ||
      ['deny', 'decline', 'reject'].includes(String(data.decision)) ||
      data.steeringPhase === 'failed'
    )
      this.unsafe = true;
    if (event.type === 'error') {
      if (this.errors.size >= 16) this.unsafe = true;
      else this.errors.add((event.text ?? '').slice(0, 4000));
    }
    if (event.type !== 'tool') return;
    // Host journals supplement native tool results; they are neither a second tool nor proof of its completion.
    if (data.hostAudit === true) return;
    const id = data.itemId ?? data.toolCallId;
    if (typeof id !== 'string' || !id || id.length > 512) {
      this.unsafe = true; // This adapter cannot prove that its tools settled.
      return;
    }
    const old = this.tools.get(id);
    // The permission extension proved that this command never reached the OS.
    if (data.commandNotExecuted === true && data.status === 'failed') {
      this.tools.set(id, {
        status: 'failed',
        readOnly: true,
        failed: true,
        successful: false,
        sequence: ++this.sequence,
        metadata: { ...data },
      });
      return;
    }
    if (!old && this.tools.size >= 4096) {
      this.unsafe = true;
      this.tools.clear();
      return;
    }
    const status = typeof data.status === 'string' && data.status ? data.status : (old?.status ?? 'unknown');
    if (status.length > 80) {
      this.unsafe = true;
      return;
    }
    const readOnly =
      old?.readOnly === true ||
      (data.kind === 'mcpToolCall' &&
        data.server === 'pugport' &&
        (readTools.has(String(data.tool)) || this.githubReadTools.includes(String(data.tool))));
    const metadata = {
      ...old?.metadata,
      ...Object.fromEntries(
        ['kind', 'nativeTool', 'tool', 'status', 'isError', 'exitCode']
          .filter((key) => data[key] !== undefined)
          .map((key) => [key, data[key]]),
      ),
    };
    const command = commandCheck({
      ...metadata,
      command: old?.command?.command,
      output: old?.command?.reason,
      ...data,
    });
    const failed =
      (!command && old?.failed === true) ||
      command?.failed === true ||
      ['failed', 'cancelled', 'interrupted', 'declined'].includes(status) ||
      data.isError === true ||
      (typeof data.exitCode === 'number' && data.exitCode !== 0);
    // A completed shell invocation is not a successful command without an exit code.
    const successful = command ? command.succeeded : status === 'completed' && !failed;
    const native = String(data.nativeTool ?? data.tool ?? old?.metadata.nativeTool ?? old?.metadata.tool ?? '');
    const kind = String(data.kind ?? old?.metadata.kind ?? '');
    const fileWrite =
      old?.fileWrite === true ||
      kind === 'fileChange' ||
      kind === 'edit' ||
      ['write', 'edit', 'multiedit', 'writefile', 'editfile'].includes(native.replace(/[_-]/g, '').toLowerCase());
    const paths = fileChangePaths(data as Record<string, unknown>);
    this.tools.set(id, {
      status,
      readOnly,
      failed,
      successful,
      command,
      metadata,
      sequence: ++this.sequence,
      ...(fileWrite ? { fileWrite: true } : {}),
      ...((paths.length ? paths : old?.paths)?.length ? { paths: paths.length ? paths : old?.paths } : {}),
    });
  }

  /** A later verified write of the same path retires the earlier failure. Shells never recover this way. */
  private recoveredFileWrites(): Set<Tool> {
    const successAt = new Map<string, number>();
    for (const tool of this.tools.values()) {
      if (!tool.fileWrite || !tool.successful) continue;
      for (const path of tool.paths ?? []) successAt.set(path, Math.max(successAt.get(path) ?? 0, tool.sequence));
    }
    return new Set(
      [...this.tools.values()].filter(
        (tool) =>
          tool.fileWrite &&
          !tool.successful &&
          (tool.paths?.length ?? 0) > 0 &&
          tool.paths!.every((path) => (successAt.get(path) ?? 0) > tool.sequence),
      ),
    );
  }

  /** Failed commands recovered by a later identical command no longer leave an uncertain write. */
  private settledCommands(): Set<Tool> {
    const successes = new Map<string, number>();
    for (const tool of this.tools.values())
      if (tool.command?.key && tool.successful)
        successes.set(tool.command.key, Math.max(successes.get(tool.command.key) ?? 0, tool.sequence));
    return new Set(
      [...this.tools.values()].filter(
        (tool) =>
          tool.command &&
          (tool.command.limited ||
            (tool.failed && !!tool.command.key && (successes.get(tool.command.key) ?? 0) > tool.sequence)),
      ),
    );
  }

  completed(run: RunRecord): string[] {
    if (this.unsafe || [...this.errors].some((text) => text !== run.error)) return [];
    const completed: string[] = [];
    const settled = this.settledCommands();
    const recovered = this.recoveredFileWrites();
    for (const [id, tool] of this.tools) {
      if (settled.has(tool) || recovered.has(tool)) continue;
      if (tool.failed) {
        if (run.permissionMode !== 'read-only' && !tool.readOnly) return [];
      } else if (!tool.successful)
        return []; // Unknown or still-running work must be reconciled by a human.
      else if (!(tool.readOnly && tool.metadata.tool === 'report_outcome')) completed.push(id);
    }
    return completed;
  }

  /** Same-session continuation: every tool ended, and any failure was a read-only check or was later redone. */
  terminal(run: RunRecord): boolean {
    if (this.unsafe || [...this.errors].some((text) => text !== run.error)) return false;
    // Tool activity this adapter did not report as tools cannot be shown to have ended.
    if (!this.tools.size && run.hadToolActivity) return false;
    const recovered = this.recoveredFileWrites();
    return [...this.tools.values()].every(
      (tool) =>
        recovered.has(tool) ||
        // A command later rerun successfully; one the sandbox refused may have done part of its work, so it is not.
        (tool.failed &&
          !tool.command?.limited &&
          !!tool.command?.key &&
          [...this.tools.values()].some(
            (other) => other.successful && other.command?.key === tool.command!.key && other.sequence > tool.sequence,
          )) ||
        (['completed', 'failed'].includes(tool.status) &&
          (tool.successful ||
            (tool.failed &&
              (tool.readOnly ||
                (tool.metadata.kind !== 'mcpToolCall' &&
                  readOnlyCheck({ ...tool.metadata, command: tool.command?.command })))))),
    );
  }

  unconfirmedChanges(run: RunRecord): boolean {
    const settled = this.settledCommands();
    const recovered = this.recoveredFileWrites();
    return (
      run.permissionMode !== 'read-only' &&
      [...this.tools.values()].some(
        (tool) => !tool.readOnly && !tool.successful && !settled.has(tool) && !recovered.has(tool),
      )
    );
  }

  /** Cross-account handoff needs every native tool to be terminal, including read-only failures. */
  handoffState(
    run: RunRecord,
  ): Pick<
    NonNullable<RunRecord['handoffCheckpoint']>,
    'safe' | 'completedToolIds' | 'unconfirmedTools' | 'blockedReason'
  > {
    const settled = this.settledCommands();
    const recovered = this.recoveredFileWrites();
    const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted', 'declined']);
    const unconfirmedTools = [...this.tools].flatMap(([id, tool]) =>
      !terminal.has(tool.status) ||
      (!tool.successful &&
        run.permissionMode !== 'read-only' &&
        !tool.readOnly &&
        !settled.has(tool) &&
        !recovered.has(tool))
        ? [{ id, status: tool.status }]
        : [],
    );
    const completedToolIds = [...this.tools].filter(([, tool]) => tool.successful).map(([id]) => id);
    // Connection, timeout and rate-limit reports (often retried by the executor itself) say nothing about file
    // state; tool results above are the evidence for that. Any other error still needs a person to look.
    const unexplained = [...this.errors].some(
      (text) => text !== run.error && text !== run.errorCode && !transportErrors.has(text),
    );
    const blockedReason =
      this.unsafe || [...this.tools.values()].some((tool) => tool.status === 'declined')
        ? 'untrusted-progress'
        : unexplained
          ? 'unverified-error'
          : unconfirmedTools.length
            ? 'unconfirmed-tool'
            : !this.tools.size && (run.hadToolActivity || (run.permissionMode !== 'read-only' && run.output.trim()))
              ? 'missing-checkpoint'
              : undefined;
    return {
      safe: blockedReason === undefined,
      completedToolIds,
      unconfirmedTools,
      ...(blockedReason ? { blockedReason } : {}),
    };
  }
}

export type TaskContinuationBudget = { count: number; reports: Set<string>; tools: Set<string> };
export const taskContinuationLimit = 2;

export function hasContinuationProgress(
  run: RunRecord,
  progress: TaskContinuationProgress | undefined,
  budget: TaskContinuationBudget,
): boolean {
  const summary = run.taskOutcome?.summary;
  if (
    budget.count >= taskContinuationLimit ||
    run.status !== 'failed' ||
    run.errorCode ||
    !['executor-report', 'executor-tool'].includes(run.taskOutcome?.source ?? '') ||
    // blocked is the executor naming a real obstacle; only unfinished work continues on its own.
    run.taskOutcome?.status !== 'partial' ||
    !run.nativeSessionId ||
    !summary?.trim() ||
    !run.output.trim() ||
    run.verification?.status === 'failed' ||
    /原生工具拒绝原因/.test(run.error ?? '')
  )
    return false;
  const report = JSON.stringify([run.taskOutcome.summary, run.taskOutcome.claims]);
  if (budget.reports.has(report)) return false;
  // A read-only scan continues only after new progress, as before; a write step only needs every tool to have ended.
  if (run.permissionMode !== 'workspace-write')
    return (progress?.completed(run) ?? []).some((id) => !budget.tools.has(id));
  return progress?.terminal(run) === true;
}

export function recordContinuation(run: RunRecord, progress: TaskContinuationProgress, budget: TaskContinuationBudget) {
  budget.count++;
  budget.reports.add(JSON.stringify([run.taskOutcome?.summary, run.taskOutcome?.claims]));
  for (const id of progress.completed(run)) budget.tools.add(id);
}
