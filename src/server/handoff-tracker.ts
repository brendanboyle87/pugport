import { runDetailHeader, runDetailText, type RunDetailArgs } from './run-detail.ts';
import { isThirdPartyExchange } from '../shared/external-agents.ts';
import type { ConversationMessage, Project, RunInput, RunRecord, Workflow } from '../shared/types.ts';
import { taskListProgress } from '../shared/swarm.ts';
import { handoffNoteBlock, handoffNoteIn, replaceHandoffNote } from '../shared/handoff-note.ts';
import {
  buildHandoffNote,
  buildHandoffDelta,
  captureHandoffBase,
  handoffStaleness,
  measureHandoffState,
  withoutStaleLine,
  type HandoffMeasured,
} from './handoff-note.ts';
import type { WorkspaceStore } from './workspace-store.ts';

/** What the tracker reads from the workspace; all of it is the workspace's own records. */
export type HandoffHost = {
  store: WorkspaceStore;
  /** The running copy of a workflow when there is one, otherwise the saved one. */
  workflow(id: string): Workflow | undefined;
  run(id: string): RunRecord | undefined;
  toolless(workflow: Workflow): boolean;
  /** Sub-tasks this workflow handed out (their states drive a task list). */
  children(workflow: Workflow): Workflow[];
  executionPath?(workflow: Workflow): string;
};

const staleAfterMs = 30_000;
const stoppedLabels: Partial<Record<Workflow['status'], string>> = {
  blocked: '暂停',
  failed: '失败',
  interrupted: '中断',
  cancelled: '被用户停下',
};

/**
 * The workspace side of the handoff note (handoff-note.ts): each running task's start state, the project measured
 * just before a run is handed over, and the note last handed over, so a note used later can say files changed.
 */
export class HandoffTracker {
  /** Start states being measured; saved on the workflow once git answers. */
  private bases = new Map<string, Promise<void>>();
  private measures = new Map<string, { runId: string; measured: HandoffMeasured }>();
  private notes = new Map<string, { note: string; fingerprint?: string; checkedAt: number; projectPath: string }>();
  /** Stops every git call on shutdown, so none is left holding a project folder. */
  private abort = new AbortController();

  constructor(private readonly host: HandoffHost) {}

  private detailReads = new Map<string, number>();

  private trusted(workflow: Workflow): boolean {
    const message = this.host.store.get<ConversationMessage>('message', workflow.userMessageId);
    return (
      !isThirdPartyExchange(workflow.input) &&
      (!message || !isThirdPartyExchange(message)) &&
      !this.host.store.untrustedConversation(workflow.conversationId)
    );
  }

  runDetail(caller: { run: RunRecord }, args: RunDetailArgs) {
    const run = this.host.run(args.run_id);
    const own = caller.run.workflowId ? this.host.workflow(caller.run.workflowId) : undefined;
    const origin = run?.workflowId ? this.host.workflow(run.workflowId) : undefined;
    const project = own && this.host.store.get<Project>('project', own.projectId);
    const deny = () => {
      throw new Error('Run detail is outside trusted history scope.');
    };
    if (
      !run ||
      !own ||
      !origin ||
      !project ||
      origin.projectId !== own.projectId ||
      run.projectPath !== (this.host.executionPath?.(origin) ?? project.path) ||
      caller.run.projectPath !== (this.host.executionPath?.(own) ?? project.path) ||
      !this.trusted(own) ||
      !this.trusted(origin)
    )
      return deny();
    const ancestors = new Set<string>();
    let current: Workflow | undefined = own;
    while (current && !ancestors.has(current.id) && current.projectId === own.projectId && this.trusted(current)) {
      ancestors.add(current.id);
      current = current.parentWorkflowId ? this.host.workflow(current.parentWorkflowId) : undefined;
    }
    const descendants = new Set<string>();
    current = origin;
    while (current && !descendants.has(current.id) && current.projectId === own.projectId && this.trusted(current)) {
      descendants.add(current.id);
      current = current.delegation?.parentId ? this.host.workflow(current.delegation.parentId) : undefined;
    }
    if (!ancestors.has(origin.id) && !descendants.has(own.id) && origin.conversationId !== own.conversationId)
      return deny();
    if (args.part !== undefined && !['tool', 'output', 'events'].includes(args.part))
      throw new Error('Invalid detail part.');
    const offset = args.offset ?? 0;
    const limit = args.limit ?? 4000;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1)
      throw new Error('Invalid detail offset or limit.');
    const key = JSON.stringify([caller.run.id, run.id]);
    const used = this.detailReads.get(key) ?? 0;
    if (used + runDetailHeader.length + 1 >= 40000) throw new Error('Run detail read cap reached.');
    const full = runDetailText(run, args);
    const slice = full.slice(offset, offset + Math.min(limit, 8000, 40000 - used - runDetailHeader.length - 1));
    const text = `${runDetailHeader}\n${slice}`;
    this.detailReads.set(key, used + text.length);
    while (this.detailReads.size > 500) this.detailReads.delete(this.detailReads.keys().next().value!);
    return {
      text,
      total: full.length,
      next_offset: offset + slice.length < full.length ? offset + slice.length : null,
    };
  }

  /** Only writable tasks in a real project folder change files worth measuring. */
  private measured(workflow: Workflow, project: Project) {
    return (
      project.scope !== 'chat' &&
      workflow.input.permissionMode !== 'read-only' &&
      workflow.input.prohibitCommands !== true &&
      !workflow.input.deviceId &&
      !this.host.toolless(workflow)
    );
  }
  private signal(signal: AbortSignal) {
    return AbortSignal.any([signal, this.abort.signal]);
  }

  /** The project's state as a task starts (a continued task keeps its parent's). Never holds the start up. */
  start(workflow: Workflow, project: Project) {
    if (workflow.handoffBase || this.bases.has(workflow.id) || !this.measured(workflow, project)) return;
    const parent = workflow.parentWorkflowId
      ? this.host.store.get<Workflow>('workflow', workflow.parentWorkflowId)
      : undefined;
    if (
      parent?.handoffBase &&
      parent.projectId === workflow.projectId &&
      parent.executionWorkspaceId === workflow.executionWorkspaceId
    ) {
      workflow.handoffBase = parent.handoffBase;
      return;
    }
    const pending = captureHandoffBase(project.path, { signal: this.abort.signal })
      .then((base) => {
        workflow.handoffBase ??= base;
      })
      .catch(() => undefined)
      .finally(() => this.bases.delete(workflow.id));
    this.bases.set(workflow.id, pending);
  }

  /** Measures the project just before a run is handed over; a slow or failing git only leaves the facts out. */
  async prepare(workflow: Workflow, run: RunRecord, projectPath: string, signal: AbortSignal) {
    const project = this.host.store.get<Project>('project', workflow.projectId);
    if (!project || !this.measured(workflow, project) || this.measures.get(workflow.id)?.runId === run.id) return;
    await this.bases.get(workflow.id);
    const measured = await measureHandoffState(projectPath, workflow.handoffBase, {
      signal: this.signal(signal),
    }).catch(() => undefined);
    if (measured) this.measures.set(workflow.id, { runId: run.id, measured });
  }

  /** A note from the task's own records; `anchor` decides which messages count as the latest. */
  private build(
    workflow: Workflow,
    runs: RunRecord[],
    reason: string,
    projectPath: string,
    measured?: HandoffMeasured,
    anchor: Workflow = workflow,
  ) {
    const members = workflow.taskList ? this.host.children(workflow).map((child) => ({ workflow: child })) : [];
    return buildHandoffNote({
      // The user's own words: quoted passages, such as a web agent's reply, stay out.
      request: workflow.input.intentText ?? workflow.input.content,
      reason,
      runs,
      plan: workflow.plan,
      ...(workflow.taskList ? { taskList: taskListProgress(workflow.taskList.items, members) } : {}),
      checkpoints: workflow.delegation?.checkpoints,
      // Context messages already leave a web agent's exchange out; the note drops it again.
      messages: this.host.store.contextMessages(anchor.conversationId, anchor.userMessageId, 4),
      verificationCommand: workflow.input.verificationCommand,
      measured,
      readOnly: anchor.input.permissionMode === 'read-only',
      projectPath,
    });
  }
  private remember(workflowId: string, note: string, projectPath: string, measured?: HandoffMeasured) {
    this.notes.set(workflowId, { note, fingerprint: measured?.fingerprint, checkedAt: Date.now(), projectPath });
  }

  /** The note for a run being handed over: this step's own runs (no image helpers), up to that run. */
  forRun(workflow: Workflow, run: RunRecord, reason: string, projectPath: string) {
    const visual = new Set(workflow.visualRunIds ?? []);
    const step = workflow.plan.find((item) => item.id === run.stepId);
    const runs = [...new Set([...(step?.runIds ?? []), run.id])]
      .filter((id) => id === run.id || !visual.has(id))
      .slice(-4)
      .map((id) => (id === run.id ? run : this.host.run(id)))
      .filter((item): item is RunRecord => !!item);
    const measured = this.measures.get(workflow.id);
    const fresh = measured?.runId === run.id ? measured.measured : undefined;
    const note = this.build(workflow, runs, reason, projectPath, fresh);
    this.remember(workflow.id, note, projectPath, fresh);
    return note;
  }
  /** For the controller's relay prompts (Controller.handoffNote). */
  relay(input: RunInput, saved: RunRecord, reason: string): string | undefined {
    const id = input.workflowId ?? saved.workflowId;
    const workflow = id ? this.host.workflow(id) : undefined;
    return workflow ? this.forRun(workflow, saved, reason, input.projectPath) : undefined;
  }

  /** A note handed over more than 30 s ago (its run waited for an account or capacity) is checked again. */
  recheckDue(workflow: Workflow, input: RunInput) {
    const record = this.notes.get(workflow.id);
    if (!record?.fingerprint || Date.now() - record.checkedAt < staleAfterMs) return false;
    const note = handoffNoteIn(input.prompt);
    return note !== undefined && withoutStaleLine(note) === record.note;
  }
  /** When the files changed since the note was made, it gets one line saying so, with git status. */
  async recheck(workflow: Workflow, input: RunInput, signal: AbortSignal): Promise<RunInput> {
    const record = this.notes.get(workflow.id);
    if (!record) return input;
    record.checkedAt = Date.now();
    const stale = await handoffStaleness(record.projectPath, record.fingerprint, {
      signal: this.signal(signal),
    }).catch(() => undefined);
    return stale?.line
      ? { ...input, prompt: replaceHandoffNote(input.prompt, `${record.note}\n${stale.line}`) }
      : input;
  }

  /**
   * A continued task that may land on another executor gets a note on where the interrupted one stopped. The
   * same executor reusing its native session gets its compact continuation prompt instead, unchanged.
   */
  async resume(workflow: Workflow, project: Project, signal: AbortSignal): Promise<string> {
    const parent = workflow.parentWorkflowId
      ? this.host.store.get<Workflow>('workflow', workflow.parentWorkflowId)
      : undefined;
    // Only a task that stopped part-way; a finished swarm member woken by a message is not a handoff.
    if (
      !parent ||
      !(parent.status in stoppedLabels) ||
      parent.conversationId !== workflow.conversationId ||
      parent.projectId !== workflow.projectId ||
      this.host.toolless(workflow)
    )
      return '';
    const visual = new Set(parent.visualRunIds ?? []);
    const runs = parent.runIds
      .filter((id) => !visual.has(id))
      .slice(-6)
      .map((id) => this.host.run(id))
      .filter((run): run is RunRecord => !!run?.stepId)
      .slice(-4);
    if (!runs.length) return '';
    const measured = this.measured(workflow, project)
      ? await measureHandoffState(project.path, parent.handoffBase ?? workflow.handoffBase, {
          signal: this.signal(signal),
        }).catch(() => undefined)
      : undefined;
    const reason = `原任务${stoppedLabels[parent.status]}${parent.error ? `：${parent.error}` : ''}；用户要求继续，可能换了执行器。`;
    const note = this.build(parent, runs, reason, project.path, measured, workflow);
    this.remember(workflow.id, note, project.path, measured);
    return handoffNoteBlock(note);
  }

  /** One fresh measurement shared by every vendor's catch-up at this dispatch. */
  async delta(
    workflow: Workflow,
    project: Project,
    previous: RunRecord[],
    signal: AbortSignal,
  ): Promise<Map<string, string>> {
    const later = new Map<string, RunRecord[]>();
    for (const anchor of previous) {
      // Select this conversation first; untyped string ids keep the JSON workflow index searchable.
      const rows = this.host.store.db
        .prepare(
          `SELECT run.id FROM workspace_records origin CROSS JOIN runs run
        ON +origin.id=json_extract(run.value,'$.workflowId')
        JOIN runs anchor ON anchor.id=?
        WHERE origin.kind='workflow' AND origin.owner=? AND json_extract(origin.value,'$.projectId')=?
        AND json_extract(run.value,'$.projectPath')=?
        AND (run.started_at > anchor.started_at OR (run.started_at=anchor.started_at AND run.rowid>anchor.rowid))
        AND json_extract(run.value,'$.route.runtimeId') != ?
        AND json_extract(run.value,'$.stepId') IS NOT NULL
        AND COALESCE(json_extract(run.value,'$.visualAssistant'),0)=0
        AND json_extract(run.value,'$.status') IN ('completed','failed','cancelled','interrupted')
        ORDER BY run.started_at DESC,run.rowid DESC LIMIT 4`,
        )
        .all(anchor.id, workflow.conversationId, workflow.projectId, project.path, anchor.route.runtimeId) as {
        id: string;
      }[];
      const runs = rows
        .flatMap(({ id }) => {
          const run = this.host.run(id);
          const origin = run?.workflowId ? this.host.workflow(run.workflowId) : undefined;
          const message = origin
            ? this.host.store.get<ConversationMessage>('message', origin.userMessageId)
            : undefined;
          return run && origin && this.trusted(origin) && (!message || !isThirdPartyExchange(message)) ? [run] : [];
        })
        .reverse();
      if (runs.length) later.set(anchor.id, runs);
    }
    if (!later.size) return new Map();
    const measured = this.measured(workflow, project)
      ? await measureHandoffState(project.path, workflow.handoffBase, { signal: this.signal(signal) }).catch(
          () => undefined,
        )
      : undefined;
    return new Map(
      previous
        .filter((run) => later.has(run.id))
        .map((run) => [
          run.id,
          buildHandoffDelta({ previous: run, runs: later.get(run.id)!, measured, projectPath: project.path }),
        ]),
    );
  }

  /** A workflow stopped running: what was kept for its handoffs goes. */
  finish(workflowId: string) {
    this.measures.delete(workflowId);
    this.notes.delete(workflowId);
  }
  async close() {
    this.abort.abort();
    await Promise.allSettled([...this.bases.values()]);
  }
}
