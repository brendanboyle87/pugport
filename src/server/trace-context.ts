import type { Express } from 'express';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import {
  contextParts,
  meteringContract,
  type ContextPart,
  type RunContextDetail,
  type TraceContextPage,
  type TraceContextRun,
} from '../shared/context-trace.ts';
import { runSentParts } from '../shared/conversation-trace.ts';
import type { Provider, RunEvent, RunRecord, Workflow } from '../shared/types.ts';
import { usageMetricKeys, type UsageRun } from '../shared/usage.ts';
import { partialHistory, type RequestLedger } from './usage-requests.ts';
import type { ToolOperationIndex } from './tool-operations.ts';

/*
 * Trace › Context detail. Served only when the Context tab opens, paged by ladder row, never part of
 * /api/state. Each row reads its run once: finished runs keep their prompt composition in a small cache
 * table, so later reads use the run summary instead of parsing the full record.
 */

export type TraceContextDeps = {
  db: DatabaseSync;
  workflow(id: string): Workflow | undefined;
  /** The task's delegated sub-tasks (not deleted), oldest first, selected in SQL. */
  delegatedWorkflows(conversationId: string, parentWorkflowId: string): Workflow[];
  requireConversation(id: string): void;
  /** Full record (live or stored), without merging the audit archive. */
  run(id: string): RunRecord | undefined;
  /** Stored summary (no events, output tail); live runs return their in-memory record. */
  runSummary(id: string): RunRecord | undefined;
  isActive(id: string): boolean;
  runUsage(id: string): UsageRun | undefined;
  executorLabel(run: RunRecord): string;
  provider(run: RunRecord): Provider | undefined;
  requests: RequestLedger;
  tools: ToolOperationIndex;
  /** Retained events read per rebuild step; a longer history stays partial and continues on a later read. */
  backfillLimit?: number;
};

type Composition = { recorded: boolean; parts: ContextPart[]; replyChars: number };
const terminal = (run: RunRecord) => !['queued', 'running', 'waiting-approval'].includes(run.status);
const clamp = (value: unknown, fallback: number, max: number) => {
  const number = typeof value === 'string' ? Number(value) : NaN;
  return Number.isInteger(number) && number >= 0 ? Math.min(number, max) : fallback;
};

export class TraceContext {
  private readonly readComposition: StatementSync;
  private readonly writeComposition: StatementSync;
  private readonly retained: StatementSync;
  private readonly readCursor: StatementSync;
  private readonly writeCursor: StatementSync;
  private readonly clearCursor: StatementSync;
  constructor(private readonly deps: TraceContextDeps) {
    deps.db.exec(
      `CREATE TABLE IF NOT EXISTS run_context_parts (run_id TEXT PRIMARY KEY, final INTEGER NOT NULL, value TEXT NOT NULL);
       CREATE TABLE IF NOT EXISTS run_context_backfill (run_id TEXT PRIMARY KEY, seq INTEGER NOT NULL);`,
    );
    this.readComposition = deps.db.prepare('SELECT final, value FROM run_context_parts WHERE run_id=?');
    this.writeComposition = deps.db.prepare(
      'INSERT INTO run_context_parts(run_id,final,value) VALUES(?,?,?) ON CONFLICT(run_id) DO UPDATE SET final=excluded.final,value=excluded.value',
    );
    // Only event kinds that carry request or tool evidence; text deltas are never read for this.
    this.retained = deps.db.prepare(
      `SELECT seq, value FROM run_audit_events WHERE run_id=? AND seq>? AND json_extract(value,'$.type') IN ('tool','usage','status')
       ORDER BY seq LIMIT ?`,
    );
    // Where a partial rebuild stopped: the last audit seq already indexed.
    this.readCursor = deps.db.prepare('SELECT seq FROM run_context_backfill WHERE run_id=?');
    this.writeCursor = deps.db.prepare(
      'INSERT INTO run_context_backfill(run_id,seq) VALUES(?,?) ON CONFLICT(run_id) DO UPDATE SET seq=excluded.seq',
    );
    this.clearCursor = deps.db.prepare('DELETE FROM run_context_backfill WHERE run_id=?');
  }

  /** Composition of what PugPort sent (exact characters, estimated tokens), computed once per finished run. */
  composition(run: RunRecord, full?: RunRecord): Composition {
    const cached = this.readComposition.get(run.id) as { final: number; value: string } | undefined;
    if (cached?.final) return JSON.parse(cached.value) as Composition;
    const source = full ?? this.deps.run(run.id) ?? run;
    const { recorded, parts } = contextParts(runSentParts(source));
    const value: Composition = { recorded, parts, replyChars: source.output.length };
    const final = terminal(source) && !this.deps.isActive(source.id);
    this.writeComposition.run(run.id, final ? 1 : 0, JSON.stringify(value));
    return value;
  }

  /**
   * Builds the request ledger and tool index for stored runs that predate them, one bounded chunk of retained
   * events per read. A history longer than the chunk stays marked partial (never complete) and the next read
   * continues after the last indexed event.
   */
  private ensureIndexed(run: RunRecord) {
    if (this.deps.isActive(run.id)) return;
    const pending = (source: string | undefined) => !source || source === partialHistory;
    const needRequests = pending(this.deps.requests.indexed(run.id));
    const needTools = pending(this.deps.tools.indexed(run.id));
    if (!needRequests && !needTools) return;
    const limit = this.deps.backfillLimit ?? 20_000;
    const cursor = (this.readCursor.get(run.id) as { seq: number } | undefined)?.seq ?? -1;
    let rows: { seq: number; value: string }[];
    try {
      rows = this.retained.all(run.id, cursor, limit + 1) as { seq: number; value: string }[];
    } catch {
      rows = [];
    }
    const partial = rows.length > limit;
    if (partial) rows = rows.slice(0, limit);
    let events = rows.map((row) => JSON.parse(row.value) as RunEvent);
    if (!events.length && cursor < 0) events = this.deps.run(run.id)?.events ?? [];
    const { db } = this.deps;
    db.exec('SAVEPOINT run_context_backfill');
    try {
      if (needRequests)
        this.deps.requests.backfill(run.id, this.deps.provider(run), run.route.model, events, { partial });
      if (needTools) this.deps.tools.backfill(run.id, events, { partial });
      if (partial) this.writeCursor.run(run.id, rows.at(-1)!.seq);
      else this.clearCursor.run(run.id);
      db.exec('RELEASE run_context_backfill');
    } catch (error) {
      db.exec('ROLLBACK TO run_context_backfill; RELEASE run_context_backfill');
      throw error;
    }
  }

  private partial(runId: string) {
    return this.deps.requests.indexed(runId) === partialHistory || this.deps.tools.indexed(runId) === partialHistory;
  }

  private row(
    run: RunRecord,
    workflowId: string,
    depth: 0 | 1,
    attempt: number,
    label: string | null,
    previous: RunRecord | undefined,
  ): TraceContextRun {
    const full = this.deps.isActive(run.id) ? run : undefined;
    const composition = this.composition(run, full);
    this.ensureIndexed(run);
    const requests = this.deps.requests.summary(run.id);
    const tools = this.deps.tools.summary(run.id);
    const toolSource = this.deps.tools.indexed(run.id);
    const partialHistory = this.partial(run.id);
    const provider = this.deps.provider(run) ?? run.account?.provider ?? null;
    const transport = run.executionKind ?? (run.apiProvider || provider === 'pi' ? 'api' : provider ? 'cli' : null);
    const sentChars = composition.parts.reduce((sum, part) => sum + part.chars, 0);
    const sentTokens = composition.parts.reduce((sum, part) => sum + part.tokens, 0);
    const usage = this.deps.runUsage(run.id);
    const reported = requests.last
      ? requests.last
      : run.context
        ? {
            contextTokens: run.context.tokens,
            contextWindow: run.context.window ?? null,
            at: run.context.at,
            source: 'run-context-snapshot' as const,
          }
        : null;
    return {
      runId: run.id,
      workflowId,
      depth,
      attempt,
      label,
      executor: this.deps.executorLabel(run),
      runtimeId: run.route.runtimeId,
      provider,
      transport,
      status: run.status,
      startedAt: run.startedAt,
      endedAt: run.endedAt ?? null,
      relay: run.relay ?? null,
      error: run.error ?? null,
      sessionMode: !previous
        ? null
        : run.nativeSessionId && run.nativeSessionId === previous.nativeSessionId
          ? 'resumed'
          : 'fresh',
      carriedTools: run.handoffCheckpoint ? run.handoffCheckpoint.completedToolIds.length : null,
      unconfirmedTools: run.handoffCheckpoint ? run.handoffCheckpoint.unconfirmedTools.length : null,
      textOnly: !!run.textOnly,
      toolless: !!run.toolless,
      promptRecorded: composition.recorded,
      parts: composition.parts,
      sent: { chars: sentChars, tokens: sentTokens, method: 'estimate' },
      transcript:
        transport === 'api'
          ? {
              toolResults: { chars: tools.resultChars, tokens: Math.ceil(tools.resultChars / 4) },
              replies: { chars: composition.replyChars, tokens: estimateReply(composition.replyChars) },
              method: 'estimate',
            }
          : null,
      reported,
      requests: {
        count: requests.count,
        coverage: requests.count ? requests.coverage : reported ? 'snapshot' : 'not-reported',
        sources: requests.count ? requests.sources : reported ? [reported.source] : [],
      },
      usage: usage
        ? {
            ...(Object.fromEntries(usageMetricKeys.map((key) => [key, usage[key]])) as Pick<
              UsageRun,
              (typeof usageMetricKeys)[number]
            >),
            accountingMode: usage.accountingMode,
          }
        : null,
      tools: {
        count: tools.count,
        coverage: toolSource === 'live' ? 'live' : toolSource ? 'retained-events' : 'none',
      },
      partialHistory,
      route: {
        reasons: run.route.reasons ?? [],
        warnings: run.route.warnings ?? [],
        targetTier: run.route.targetTier ?? null,
        shortQuotaLeft: run.route.shortQuotaLeft ?? null,
        shortQuotaWindow: run.route.shortQuotaWindow ?? null,
      },
      measuredFiles: run.measuredFileChanges?.paths.slice(0, 50) ?? null,
    };
  }

  /** Ladder rows: the task's attempts in order, each followed by the sub-tasks it spawned. */
  page(workflowId: string, offset = 0, limit = 40): TraceContextPage {
    const workflow = this.deps.workflow(workflowId);
    if (!workflow || workflow.deletedAt) throw new TraceContextNotFound();
    this.deps.requireConversation(workflow.conversationId);
    const load = (id: string) => this.deps.runSummary(id);
    const attempts = [...new Set([...workflow.runIds, ...(workflow.visualRunIds ?? [])])]
      .flatMap((id) => {
        const run = load(id);
        return run ? [run] : [];
      })
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    const children = this.deps
      .delegatedWorkflows(workflow.conversationId, workflow.id)
      .filter((child) => child.delegation?.parentId === workflow.id && !child.deletedAt)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    type Plan = {
      run?: RunRecord;
      runId: string;
      workflow: Workflow;
      depth: 0 | 1;
      attempt: number;
      label: string | null;
    };
    const plan: Plan[] = attempts.map((run, index) => ({
      run,
      runId: run.id,
      workflow,
      depth: 0,
      attempt: index + 1,
      label: null,
    }));
    for (const child of children) {
      const anchor = attempts.reduce(
        (found, run, index) => (run.startedAt <= child.createdAt ? index : found),
        attempts.length ? 0 : -1,
      );
      const label = child.delegation?.agent?.label ?? child.input.content.slice(0, 160);
      const rows: Plan[] = child.runIds.map((runId, index) => ({
        runId,
        workflow: child,
        depth: 1,
        attempt: index + 1,
        label,
      }));
      // Insert after the anchor attempt and any rows already nested under it.
      let position = plan.findIndex((row) => row.depth === 0 && row.runId === attempts[anchor]?.id);
      if (position < 0) position = plan.length - 1;
      while (plan[position + 1]?.depth === 1) position++;
      plan.splice(position + 1, 0, ...rows);
    }
    const slice = plan.slice(offset, offset + limit);
    const runs = slice.flatMap((item) => {
      const run = item.run ?? load(item.runId);
      if (!run) return [];
      const previous = item.depth === 0 && item.attempt > 1 ? attempts[item.attempt - 2] : undefined;
      return [this.row(run, item.workflow.id, item.depth, item.attempt, item.label, previous)];
    });
    return {
      workflowId,
      contract: meteringContract,
      scope: {
        attempts: attempts.length,
        subtasks: children.length,
        handoffs: Math.max(0, attempts.length - 1),
      },
      total: plan.length,
      offset,
      limit,
      runs,
    };
  }

  /** Per-request series and tool operations for one run, paged independently. */
  detail(
    runId: string,
    paging: { requestOffset?: number; requestLimit?: number; toolOffset?: number; toolLimit?: number } = {},
  ): RunContextDetail {
    const run = this.deps.runSummary(runId);
    if (!run) throw new TraceContextNotFound();
    const workflow = run.workflowId ? this.deps.workflow(run.workflowId) : undefined;
    if (!workflow || workflow.deletedAt) throw new TraceContextNotFound();
    this.deps.requireConversation(workflow.conversationId);
    this.ensureIndexed(run);
    const requestOffset = paging.requestOffset ?? 0,
      requestLimit = paging.requestLimit ?? 200,
      toolOffset = paging.toolOffset ?? 0,
      toolLimit = paging.toolLimit ?? 50;
    const requests = this.deps.requests.page(runId, requestOffset, requestLimit);
    const summary = this.deps.requests.summary(runId);
    const tools = this.deps.tools.page(runId, toolOffset, toolLimit);
    const source = this.deps.tools.indexed(runId);
    return {
      runId,
      partialHistory: this.partial(runId),
      requests: {
        total: requests.total,
        offset: requestOffset,
        limit: requestLimit,
        coverage: summary.coverage,
        items: requests.items,
      },
      tools: {
        total: tools.total,
        offset: toolOffset,
        limit: toolLimit,
        coverage: source === 'live' ? 'live' : source ? 'retained-events' : 'none',
        items: tools.items,
        ...this.deps.tools.aggregates(runId),
      },
    };
  }
}

/** Replies are mostly the user's language; without the text only a Latin-rate estimate is honest. */
const estimateReply = (chars: number) => Math.ceil(chars / 4);

export class TraceContextNotFound extends Error {
  constructor() {
    super('Record not found');
  }
}

/** Register behind the application's existing origin and access checks. */
export function registerTraceContextRoutes(app: Express, context: () => TraceContext) {
  const send = (res: import('express').Response, build: () => unknown) => {
    try {
      res.json(build());
    } catch (error) {
      if (error instanceof TraceContextNotFound) res.status(404).json({ error: 'Record not found' });
      else throw error;
    }
  };
  app.get('/api/workflows/:id/context', (req, res) =>
    send(res, () =>
      context().page(req.params.id, clamp(req.query.offset, 0, 100_000), clamp(req.query.limit, 40, 100) || 40),
    ),
  );
  app.get('/api/runs/:id/context', (req, res) =>
    send(res, () =>
      context().detail(req.params.id, {
        requestOffset: clamp(req.query.requestOffset, 0, 1_000_000),
        requestLimit: clamp(req.query.requestLimit, 200, 500) || 200,
        toolOffset: clamp(req.query.toolOffset, 0, 1_000_000),
        toolLimit: clamp(req.query.toolLimit, 50, 200) || 50,
      }),
    ),
  );
}
