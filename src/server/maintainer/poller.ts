import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { WorkspaceStore } from '../workspace-store.ts';
import type { ProjectGates } from '../../shared/types.ts';
import {
  githubHostRequestSchema,
  githubResolveSchema,
  githubStatusSchema,
  type GitHubHostRequest,
  type GitHubResolve,
  type GitHubStatus,
} from '../node/peer-protocol.ts';
import { readHostFlag, writeHostFlag, type MaintainerMode } from './config.ts';
import { createWriteGh, ghNotWritable, rateLimit, type Gh } from './gh.ts';
import type { GitHubAppAuth } from './github-app.ts';
import type { NoToolsRunner } from './executor.ts';
import type { Outbox, OutboxItem } from './outbox.ts';
import { failureReason, type MaintainerAudit, type AuditLine } from './audit.ts';
import { collaboratorPermission } from './tiers.ts';
import { bootstrapLabels, listLabels } from './labels.ts';
import { recordOutcome, score, type VerdictRecord } from './shadow-score.ts';
import { checkOutbound } from './outbound.ts';
import { inertSection } from './review-comment.ts';
import {
  mayWrite,
  pullWritesPending,
  handlePullEvent,
  handleIssueEvent,
  evaluatePull,
  pullFields,
  pullRowSchema,
  issueFields,
  issueRowSchema,
  type PullRecord,
  type PullListRow,
  type IssueRecord,
  type PipelineDeps,
  type WriteKind,
} from './pipeline.ts';

type Store = Pick<WorkspaceStore, 'get' | 'list' | 'save'>;
type HostState = {
  mode: MaintainerMode;
  cursor?: string;
  issueCursor?: string;
  sweptAt?: string;
  owner?: string;
  defaultBranch?: string;
  labelsReady?: boolean;
  lastPollAt?: string;
  nextPollAt?: string;
  backoffUntil?: number;
  rateRemaining?: number;
  judgeStarts: number[];
  triageStarts: { at: number; author: string }[];
  invalidStreak: number;
  writesPausedUntil?: number;
  forbidden: number;
  overflowDay?: string;
  invalidCard?: boolean;
  writes: number;
  checked: Record<string, number>;
  problem?: string;
  prLimit?: number;
  issueLimit?: number;
  issueFloor?: string;
};
const initialState = (): HostState => ({
  mode: 'off',
  judgeStarts: [],
  triageStarts: [],
  invalidStreak: 0,
  forbidden: 0,
  writes: 0,
  checked: {},
});
type Dependencies = {
  flagFile: string;
  dataDir: string;
  store: Store;
  gh: Gh;
  writeGh?: Gh;
  app: Pick<GitHubAppAuth, 'token' | 'botLogin' | 'forget'>;
  runner: NoToolsRunner;
  outbox: Outbox;
  audit: MaintainerAudit;
  gates?: () => ProjectGates | undefined;
  now?: () => number;
  intervalMs?: number;
  channelPoll?: (repository: string) => Promise<void>;
};

// Newest records read per poll; older closed PRs and triaged issues no longer matter.
const recordLimit = 2000;
// Stages 1-3 are reported only; they have no behavioral effect yet.
export class MaintainerHost {
  private state: HostState;
  private repository: string;
  private now: () => number;
  private timer?: ReturnType<typeof setInterval>;
  private polling?: Promise<void>;
  private worker?: Promise<void>;
  private suiteWrites = new Map<string, Promise<void>>();
  private resolving = new Map<number, AbortController>();
  private controllers = new Set<AbortController>();
  private active?: { number: number; sha: string; controller: AbortController };
  private stopped = false;
  private expired = false;
  private modeKnown = false;
  private appReady = false;
  private ghReady = false;
  private labelCache?: { at: number; names: string[] };
  private notices = new Set<string>();
  private trustCache = new Map<string, { at: number; trusted: boolean }>();
  constructor(private readonly deps: Dependencies) {
    this.now = deps.now ?? Date.now;
    this.repository = readHostFlag(deps.flagFile).repository ?? '';
    this.state = deps.store.get<HostState>('maintainer-state', this.repository) ?? initialState();
    for (const r of this.prs())
      if (r.phase === 'judging') {
        r.phase = 'queued';
        this.save(r);
      }
  }
  private persist() {
    this.deps.store.save('maintainer-state', this.repository, 'maintainer', this.state);
  }
  private prs() {
    return this.deps.store.list<PullRecord>('maintainer-pr', this.repository, recordLimit);
  }
  private issues() {
    return this.deps.store.list<IssueRecord>('maintainer-issue', this.repository, recordLimit);
  }
  // The judge material (diff and base files) is kept only while a skipped write may still be replayed.
  private save = (r: PullRecord) =>
    this.deps.store.save('maintainer-pr', `${this.repository}#${r.number}`, this.repository, {
      ...r,
      material: pullWritesPending(r) ? r.material : undefined,
    });
  private current = (r: PullRecord) => {
    const saved = this.deps.store.get<PullRecord>('maintainer-pr', `${this.repository}#${r.number}`);
    return saved?.sha === r.sha && saved.phase !== 'closed' && saved.row.baseRefName === r.row.baseRefName;
  };
  private async audit(
    action: AuditLine['action'],
    detail: string,
    event: AuditLine['event'] = 'poll',
    number?: number,
    result: AuditLine['result'] = 'skipped',
  ) {
    await this.deps.audit.append({
      at: new Date(this.now()).toISOString(),
      mode: this.state.mode,
      event,
      number,
      action,
      result,
      credential:
        result === 'ok' && ['comment', 'status', 'label', 'label-create', 'review'].includes(action) ? 'app' : 'none',
      detail,
    });
  }
  private notice(key: string) {
    if (this.notices.has(key)) return false;
    if (this.notices.size >= recordLimit * 10) this.notices.delete(this.notices.values().next().value!);
    this.notices.add(key);
    return true;
  }
  private async itemError(event: 'pr' | 'issue', number: number, version: string, error: unknown) {
    if (this.notice(`${event}:${this.repository}:${number}:${version}:error`))
      await this.audit(
        'error',
        `${event === 'pr' ? 'PR' : 'Issue'} processing failed: ${failureReason(error)}`,
        event,
        number,
        'error',
      );
  }
  hosting(): boolean {
    const flag = readHostFlag(this.deps.flagFile);
    if (flag.host && (!flag.leaseUntil || Date.parse(flag.leaseUntil) <= this.now())) {
      this.expired = true;
      for (const controller of this.controllers) controller.abort();
    }
    return !this.stopped && !this.expired && flag.host && flag.repository === this.repository;
  }
  start(): void {
    this.stopped = false;
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.poll();
    }, this.deps.intervalMs ?? 120_000);
    this.timer.unref();
    void this.poll();
  }
  private abort(except?: AbortController) {
    for (const controller of this.controllers) if (controller !== except) controller.abort();
  }
  async close(): Promise<void> {
    this.stopped = true;
    this.modeKnown = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.abort();
    await Promise.allSettled([this.polling, this.worker]);
  }
  async set(request: GitHubHostRequest): Promise<{ githubHost: boolean }> {
    const value = githubHostRequestSchema.parse(request);
    if (value.host && this.hosting()) {
      const { leaseMinutes, ...next } = value;
      const { leaseUntil: _leaseUntil, ...current } = readHostFlag(this.deps.flagFile);
      if (isDeepStrictEqual(current, JSON.parse(JSON.stringify(next)))) {
        // Renewals must not cancel a judge already running for this hosting configuration.
        writeHostFlag(this.deps.flagFile, {
          ...next,
          leaseUntil: new Date(this.now() + leaseMinutes * 60_000).toISOString(),
        });
        this.start();
        return { githubHost: true };
      }
    }
    if (!value.host) writeHostFlag(this.deps.flagFile, { host: false, stage: 0 });
    await this.close();
    if (value.host) {
      const { leaseMinutes, ...flag } = value;
      if (this.repository !== value.repository) {
        this.repository = value.repository;
        this.state = this.deps.store.get<HostState>('maintainer-state', this.repository) ?? initialState();
        this.trustCache.clear();
        this.labelCache = undefined;
        this.notices.clear();
      }
      writeHostFlag(this.deps.flagFile, {
        ...flag,
        leaseUntil: new Date(this.now() + leaseMinutes * 60_000).toISOString(),
      });
      this.expired = false;
      this.stopped = false;
      this.start();
    }
    return { githubHost: this.hosting() };
  }
  resumeJudge(): void {
    this.state.invalidStreak = 0;
    this.state.invalidCard = false;
    this.persist();
  }
  async status(): Promise<GitHubStatus> {
    const flag = readHostFlag(this.deps.flagFile);
    const hosting = this.hosting();
    const problem = this.expired
      ? 'Hosting lease expired'
      : this.state.invalidStreak >= 3
        ? 'Judging paused after three invalid verdicts'
        : (this.state.writesPausedUntil ?? 0) > this.now()
          ? 'Writes paused for one hour after two 403 responses'
          : !this.deps.runner.toollessReady()
            ? (this.deps.runner.unavailable?.() ?? 'No tool-less executor')
            : this.state.problem;
    return githubStatusSchema.parse({
      githubHost: hosting,
      mode: hosting ? this.state.mode : 'off',
      repository: flag.repository,
      stage: flag.stage,
      judgingPaused: this.state.invalidStreak >= 3,
      writesPausedUntil: this.state.writesPausedUntil
        ? new Date(this.state.writesPausedUntil).toISOString()
        : undefined,
      lastPollAt: this.state.lastPollAt,
      nextPollAt: this.state.nextPollAt,
      rateRemaining: this.state.rateRemaining,
      backoffUntil: this.state.backoffUntil ? new Date(this.state.backoffUntil).toISOString() : undefined,
      ready: { gh: this.ghReady, app: this.appReady, toolless: this.deps.runner.toollessReady(), problem },
      counts: {
        prs: this.prs().length,
        issues: this.issues().length,
        judges: this.state.judgeStarts.length,
        writes: this.state.writes,
      },
      score: score(this.deps.store.list<VerdictRecord>('maintainer-verdict', this.repository, recordLimit)),
      recent: this.deps.audit.recent(20),
    });
  }
  poll(): Promise<void> {
    if (this.polling) return this.polling;
    const work = this.cycle()
      .catch(async (error) => {
        if (this.hosting()) {
          this.state.problem = `GitHub poll failed: ${failureReason(error)}`;
          await this.audit('error', this.state.problem, 'poll', undefined, 'error');
        }
      })
      .finally(() => {
        this.polling = undefined;
      });
    this.polling = work;
    return work;
  }
  private async cycle() {
    if (!this.hosting() || (this.state.backoffUntil ?? 0) > this.now()) return;
    const controller = new AbortController();
    this.controllers.add(controller);
    const signal = controller.signal;
    const gh = this.readGh(signal);
    try {
      const rate = await rateLimit(gh);
      this.ghReady = true;
      this.state.rateRemaining = rate.remaining;
      if (rate.remaining < 500) {
        this.state.backoffUntil = rate.reset * 1000;
        await this.audit('skip', 'Rate limit below 500');
        this.persist();
        return;
      }
      this.state.backoffUntil = undefined;
      const repo = await gh.json(
        z.object({
          private: z.boolean().optional(),
          owner: z.object({ login: z.string().min(1) }),
          default_branch: z.string().min(1),
        }),
        ['api', `repos/${this.repository}`],
      );
      signal.throwIfAborted();
      const previous = this.state.mode;
      this.modeKnown = typeof repo.private === 'boolean';
      if (!this.modeKnown) {
        await this.audit('skip', 'Repository visibility unknown');
        return;
      }
      this.state.mode = repo.private ? 'shadow' : 'live';
      this.state.owner = repo.owner.login;
      this.state.defaultBranch = repo.default_branch;
      await this.deps.channelPoll?.(this.repository);
      if (previous !== this.state.mode) {
        this.abort(controller);
        if (previous === 'shadow' && this.state.mode === 'live')
          for (const record of this.prs().filter((r) => r.phase !== 'closed')) await this.observe(record.row, true);
        if (this.state.mode === 'shadow')
          for (const card of this.deps.outbox.all(this.repository).filter((c) => c.kind === 'merge'))
            this.deps.outbox.resolve(card.id, { outcome: 'superseded', at: new Date(this.now()).toISOString() });
        await this.audit('skip', `Mode ${previous} -> ${this.state.mode}`, 'repo', undefined, 'ok');
      }
      const context = await this.context(controller);
      if (this.state.mode === 'live' && !this.state.labelsReady && (await context.may('label-create', ''))) {
        const labels = await bootstrapLabels(
          gh,
          this.repository,
          (args) => context.write('label-create', '', args),
          await context.labels(),
        );
        this.labelCache!.names.push(...labels.created);
        this.state.labelsReady = labels.complete;
      }
      const at = new Date(this.now()).toISOString();
      const first = !this.state.cursor;
      this.state.issueCursor ??= at;
      this.state.issueFloor ??= this.state.issueCursor;
      this.state.sweptAt ??= at;
      this.persist();
      const overlap = (s: string, ms = 600_000) => new Date(Date.parse(s) - ms).toISOString();
      // Once an hour every open PR and the last day of issues are listed again, so a row the search index
      // returned late, or one that failed to parse, is not lost; the cursors do not move on a sweep.
      const sweep = !first && Date.parse(this.state.sweptAt ?? '1970-01-01T00:00:00Z') <= this.now() - 3600_000;
      const openPulls = first || sweep || (previous === 'shadow' && this.state.mode === 'live');
      const args = ['pr', 'list', '--repo', this.repository, '--state', openPulls ? 'open' : 'all'];
      if (!openPulls) args.push('--search', `updated:>=${overlap(this.state.cursor!)}`);
      args.push('--limit', String(this.state.prLimit ?? 100), '--json', pullFields);
      const listedPulls = await gh.json(z.array(z.unknown()), args);
      const rows: PullListRow[] = [];
      for (const raw of listedPulls) {
        const parsed = pullRowSchema.safeParse(raw);
        if (!parsed.success) {
          await this.itemError(
            'pr',
            z.object({ number: z.number() }).safeParse(raw).data?.number ?? 0,
            'invalid-list-row',
            'Invalid GitHub response',
          );
          continue;
        }
        const row = parsed.data;
        try {
          await this.observe(row, previous === 'shadow' && this.state.mode === 'live');
          rows.push(row);
        } catch (error) {
          await this.itemError('pr', row.number, row.headRefOid, error);
        }
      }
      const newest = (listed: { updatedAt: string }[], previous?: string) =>
        listed.reduce<string | undefined>(
          (latest, row) => (!latest || Date.parse(row.updatedAt) > Date.parse(latest) ? row.updatedAt : latest),
          undefined,
        ) ?? previous;
      if (sweep) {
        // Leave the cursor where it was: closed PRs since then still come from the next search.
      } else if (listedPulls.length < (this.state.prLimit ?? 100)) {
        this.state.cursor = newest(rows, this.state.cursor);
        this.state.prLimit = 100;
      } else this.state.prLimit = (this.state.prLimit ?? 100) + 100;
      this.persist();
      const candidates = this.prs()
        .filter((r) => r.phase !== 'closed')
        .sort(
          (a, b) =>
            (this.state.checked[a.number] ?? 0) - (this.state.checked[b.number] ?? 0) ||
            (a.queuedAt ?? a.updatedAt).localeCompare(b.queuedAt ?? b.updatedAt) ||
            a.number - b.number,
        )
        .slice(0, 20);
      const ready: number[] = [];
      // Set only for a pinned judge without fallback; the pending status then says the review is unavailable.
      const unavailable = this.deps.runner.unavailable?.() ? ('unavailable' as const) : undefined;
      for (const candidate of candidates) {
        try {
          const context = await this.context(controller, candidate);
          const row = await gh.json(pullRowSchema, [
            'pr',
            'view',
            String(candidate.number),
            '--repo',
            this.repository,
            '--json',
            pullFields,
          ]);
          if (row.number !== candidate.number) throw new Error('Wrong pull request');
          await this.observe(row);
          this.state.checked[row.number] = this.now();
          let record = this.deps.store.get<PullRecord>('maintainer-pr', `${this.repository}#${row.number}`)!;
          if (record.phase === 'closed') continue;
          // A draft or a bot PR is not judged, so it gets no "Review queued" status that would never finish.
          const judged = !row.isDraft && !row.author.is_bot && !row.author.login.endsWith('[bot]');
          if (
            judged &&
            (!record.queuedStatus || record.queuedNote !== unavailable) &&
            !record.outcome &&
            this.active?.number !== record.number
          ) {
            const queuedStatus = await context.write(
              'judge-status',
              row.author.login,
              ['api', '-X', 'POST', `repos/${this.repository}/statuses/${record.sha}`, '--input', '-'],
              {
                context: 'pugport/judge',
                state: 'pending',
                description: unavailable ? 'Review unavailable for now; it will be retried' : 'Review queued',
              },
            );
            const latest = this.deps.store.get<PullRecord>('maintainer-pr', `${this.repository}#${row.number}`);
            if (!latest || latest.sha !== record.sha || latest.phase === 'closed') continue;
            latest.queuedStatus ||= queuedStatus;
            if (queuedStatus) {
              if (unavailable) latest.queuedNote = unavailable;
              else delete latest.queuedNote;
            }
            this.save(latest);
            record = latest;
          }
          if (this.active?.number === record.number) continue;
          if (record.outcome && !pullWritesPending(record)) await evaluatePull(record, context);
          else ready.push(record.number);
          if (record.suiteFailure && !record.suiteFailure.posted) await this.publishSuiteFailure(record, context);
        } catch (error) {
          if (signal.aborted) break;
          await this.itemError('pr', candidate.number, candidate.sha, error);
          this.state.checked[candidate.number] = this.now();
        }
      }
      const listedIssues = await gh.json(z.array(z.unknown()), [
        'issue',
        'list',
        '--repo',
        this.repository,
        '--state',
        'open',
        '--search',
        `updated:>=${overlap(this.state.issueCursor, sweep ? 86_400_000 : 600_000)}`,
        '--limit',
        String(this.state.issueLimit ?? 100),
        '--json',
        issueFields,
      ]);
      const issues: { updatedAt: string }[] = [];
      for (const raw of listedIssues) {
        const parsed = issueRowSchema.safeParse(raw);
        if (!parsed.success) {
          await this.itemError(
            'issue',
            z.object({ number: z.number() }).safeParse(raw).data?.number ?? 0,
            'invalid-list-row',
            'Invalid GitHub response',
          );
          continue;
        }
        const row = parsed.data;
        try {
          if (Date.parse(row.updatedAt) < Date.parse(this.state.issueFloor)) continue;
          const old = this.deps.store.get<IssueRecord>('maintainer-issue', `${this.repository}#${row.number}`);
          if (!old || old.phase !== 'done')
            this.deps.store.save('maintainer-issue', `${this.repository}#${row.number}`, this.repository, {
              ...old,
              row,
              phase: old?.phase ?? 'queued',
              queuedAt: old?.queuedAt ?? at,
            } satisfies IssueRecord);
          issues.push(row);
        } catch (error) {
          await this.itemError('issue', row.number, row.updatedAt, error);
        }
      }
      // Grow full pages without moving past rows that have not been listed yet.
      if (sweep) this.state.sweptAt = at;
      else if (listedIssues.length < (this.state.issueLimit ?? 100)) {
        this.state.issueCursor = newest(issues, this.state.issueCursor);
        this.state.issueLimit = 100;
      } else this.state.issueLimit = (this.state.issueLimit ?? 100) + 100;
      this.state.lastPollAt = at;
      this.state.nextPollAt = new Date(this.now() + (this.deps.intervalMs ?? 120_000)).toISOString();
      this.state.problem = undefined;
      this.persist();
      if (!this.deps.runner.toollessReady())
        await this.audit('skip', this.deps.runner.unavailable?.() ?? 'noToollessExecutor');
      const records = this.prs();
      this.kick(
        ready.sort((a, b) => {
          const queued = (n: number) => records.find((r) => r.number === n)?.queuedAt ?? '';
          return queued(a).localeCompare(queued(b)) || a - b;
        }),
      );
    } finally {
      this.controllers.delete(controller);
    }
  }
  private async observe(row: PullListRow, requeue = false) {
    const old = this.deps.store.get<PullRecord>('maintainer-pr', `${this.repository}#${row.number}`);
    if (row.state !== 'OPEN') {
      this.resolving.get(row.number)?.abort();
      if (old) {
        old.row = row;
        old.phase = 'closed';
        this.save(old);
      }
      this.active?.number === row.number && this.active.controller.abort();
      for (const card of this.deps.outbox.all(this.repository).filter((c) => c.number === row.number))
        this.deps.outbox.resolve(card.id, { outcome: 'superseded', at: new Date(this.now()).toISOString() });
      this.outcomes(row, true);
      return;
    }
    const baseChanged = old && old.row.baseRefName !== row.baseRefName;
    if (!old || old.sha !== row.headRefOid || old.phase === 'closed' || requeue || baseChanged) {
      if (this.active?.number === row.number) this.active.controller.abort();
      this.resolving.get(row.number)?.abort();
      this.deps.outbox.supersede(row.number, row.headRefOid, this.repository);
      if (requeue || baseChanged)
        for (const card of this.deps.outbox
          .open(this.repository)
          .filter((c) => c.number === row.number && (baseChanged || c.kind !== 'suite')))
          this.deps.outbox.resolve(card.id, { outcome: 'superseded', at: new Date(this.now()).toISOString() });
      this.outcomes(row, false);
      this.save({
        number: row.number,
        sha: row.headRefOid,
        phase: 'queued',
        updatedAt: row.updatedAt,
        queuedAt: new Date(this.now()).toISOString(),
        row,
        ...(requeue && old?.sha === row.headRefOid && !baseChanged
          ? {
              suite:
                old.suite?.state === 'queued' &&
                !this.deps.outbox
                  .open(this.repository)
                  .some(
                    (c) =>
                      c.kind === 'suite' &&
                      c.mode === 'live' &&
                      c.number === row.number &&
                      c.judgedSha === row.headRefOid,
                  )
                  ? undefined
                  : old.suite,
              suiteFailure: old.suiteFailure,
            }
          : {}),
      });
    } else {
      old.row = row;
      this.save(old);
    }
  }
  private outcomes(row: PullListRow, closed: boolean) {
    const records = this.deps.store.list<VerdictRecord>('maintainer-verdict', this.repository, recordLimit);
    for (const [index, record] of recordOutcome(records, {
      number: row.number,
      headSha: row.headRefOid,
      merged: row.state === 'MERGED',
      closed,
      at: new Date(this.now()).toISOString(),
    }).entries()) {
      if (isDeepStrictEqual(records[index], record)) continue;
      this.deps.store.save(
        'maintainer-verdict',
        `${this.repository}#${record.number}:${record.sha}:${record.mode}`,
        this.repository,
        record,
      );
    }
  }
  private readGh(signal: AbortSignal): Gh {
    const run: Gh['run'] = (args, opts) => {
      signal.throwIfAborted();
      return this.deps.gh.run(args, { ...opts, signal });
    };
    return this.ghFromRun(run);
  }
  private ghFromRun(run: Gh['run']): Gh {
    const gh: Gh = {
      run,
      text: async (args, opts) => {
        const r = await run(args, opts);
        if (r.code) throw new Error(r.stderr || `gh exit ${r.code}`);
        return r.stdout;
      },
      json: async (schema, args, opts) => schema.parse(JSON.parse(await gh.text(args, opts))),
    };
    return gh;
  }
  private async context(controller: AbortController, item?: PullRecord | IssueRecord): Promise<PipelineDeps> {
    const signal = controller.signal;
    const mode = this.state.mode === 'live' ? 'live' : 'shadow';
    const repository = this.repository;
    const gh = this.readGh(signal);
    this.appReady = !!(await this.deps.app.token(signal));
    const botLogin = (await this.deps.app.botLogin(signal)) ?? 'unconfigured[bot]';
    const may = async (kind: WriteKind, author: string, issue = false) => {
      const app = !!(await this.deps.app.token(signal));
      this.appReady = app;
      const allowed =
        !signal.aborted &&
        this.hosting() &&
        this.modeKnown &&
        this.state.mode === mode &&
        this.repository === repository &&
        mayWrite({
          kind,
          mode,
          author,
          repoOwner: this.state.owner ?? '',
          app,
          writesPaused: (this.state.writesPausedUntil ?? 0) > this.now(),
          flagFile: this.deps.flagFile,
          now: this.now(),
          issue,
        });
      let logRefusal =
        !allowed &&
        this.notice(
          `refused:${repository}:${item && ('sha' in item ? `${item.number}:${item.sha}` : `issue:${item.row.number}`)}:${kind}`,
        );
      if (logRefusal && item && 'sha' in item) {
        const saved = this.deps.store.get<PullRecord>('maintainer-pr', `${repository}#${item.number}`);
        if (saved?.sha === item.sha) {
          const key = `refused:${kind}`;
          logRefusal = !saved.quiet?.includes(key);
          if (logRefusal) {
            (saved.quiet ??= []).push(key);
            this.save(saved);
          }
        }
      }
      if (logRefusal)
        await this.audit(
          'refused',
          `${kind} write refused`,
          issue ? 'issue' : 'pr',
          item?.row.number,
          mode === 'shadow' &&
            (issue ||
              author.toLowerCase() !== this.state.owner?.toLowerCase() ||
              !['comment', 'judge-status'].includes(kind))
            ? 'shadow-only'
            : 'skipped',
        );
      return allowed;
    };
    const raw =
      this.deps.writeGh ??
      createWriteGh({
        tmpRoot: this.deps.dataDir,
        appToken: async () => {
          const token = await this.deps.app.token(signal);
          return !signal.aborted && this.hosting() && this.modeKnown && this.state.mode === mode ? token : undefined;
        },
      });
    const runWrite = async (kind: WriteKind, author: string, issue: boolean, args: string[], input?: string) => {
      if (!(await may(kind, author, issue))) throw new Error(ghNotWritable);
      if (input && !checkOutbound([{ field: kind, value: input }]).ok) {
        await this.audit('refused', 'Outbound check', issue ? 'issue' : 'pr');
        throw new Error('Outbound check');
      }
      signal.throwIfAborted();
      try {
        const result = await raw.run(args, { input, signal });
        if (result.code !== 0) {
          if (/\b403\b/.test(result.stderr)) {
            this.deps.app.forget();
            this.state.forbidden++;
            if (this.state.forbidden >= 2) this.state.writesPausedUntil = this.now() + 3600_000;
          } else this.state.forbidden = 0;
          this.persist();
          await this.audit('error', `${kind} write failed`, issue ? 'issue' : 'pr', undefined, 'error');
          throw new Error('GitHub write failed');
        }
        this.state.forbidden = 0;
        this.state.writes++;
        this.persist();
        await this.audit(
          kind === 'judge-status' ? 'status' : kind,
          `body sha256=${createHash('sha256')
            .update(input ?? JSON.stringify(args))
            .digest('hex')}`,
          issue ? 'issue' : 'pr',
          undefined,
          'ok',
        );
        return result;
      } catch (error) {
        if (String(error).includes(ghNotWritable))
          await this.audit('refused', 'App credential unavailable', issue ? 'issue' : 'pr');
        throw error;
      }
    };
    const write: PipelineDeps['write'] = async (kind, author, args, body, issue = false) => {
      try {
        await runWrite(kind, author, issue, args, body ? JSON.stringify(body) : undefined);
        return true;
      } catch (error) {
        if (signal.aborted) throw error;
        return false;
      }
    };
    const refresh = (record: PullRecord) => {
      const saved = this.deps.store.get<PullRecord>('maintainer-pr', `${this.repository}#${record.number}`);
      if (saved?.sha === record.sha) {
        record.quiet = [...new Set([...(record.quiet ?? []), ...(saved.quiet ?? [])])];
        if (saved.suite && saved.suite.state !== 'queued') record.suite = saved.suite;
        if (saved.suiteFailure) record.suiteFailure = saved.suiteFailure;
        if (saved.decision) record.decision = saved.decision;
      }
    };
    return {
      gh,
      labels: async () => {
        if (!this.labelCache || this.now() - this.labelCache.at >= 3600_000)
          this.labelCache = { at: this.now(), names: await listLabels(gh, repository) };
        return this.labelCache.names;
      },
      runner: this.deps.runner,
      outbox: this.deps.outbox,
      repository,
      flagFile: this.deps.flagFile,
      mode,
      repoOwner: this.state.owner ?? '',
      defaultBranch: this.state.defaultBranch ?? '',
      botLogin,
      signal,
      gates: readHostFlag(this.deps.flagFile).gates ?? this.deps.gates?.(),
      now: this.now,
      may,
      write,
      audit: (line) => this.deps.audit.append(line),
      refresh,
      save: (r) => {
        if (this.current(r) && !signal.aborted) {
          refresh(r);
          this.save(r);
        }
      },
      current: this.current,
      trust: async (login) => {
        const old = this.trustCache.get(login);
        if (old && this.now() - old.at < 3600_000) return old.trusted;
        const { trusted } = await collaboratorPermission((args) => gh.text(args), repository, login);
        this.trustCache.set(login, { at: this.now(), trusted });
        return trusted;
      },
      admit: (kind, number, author, consume = true) => this.admit(kind, number, author, consume),
      verdict: (record) => {
        this.state.invalidStreak = record.verdict === 'invalid' ? this.state.invalidStreak + 1 : 0;
        const value: VerdictRecord = {
          number: record.number,
          sha: record.sha,
          verdict: record.verdict!,
          tier: record.tier!.tier,
          external: !!record.external,
          mode,
          judgedAt: record.judgedAt!,
        };
        this.deps.store.save(
          'maintainer-verdict',
          `${repository}#${record.number}:${record.sha}:${mode}`,
          repository,
          value,
        );
        if (this.state.invalidStreak >= 3 && !this.state.invalidCard) {
          this.summary('Judging paused after three invalid verdicts', record.number);
          this.state.invalidCard = true;
        }
        this.persist();
      },
    };
  }
  private summary(reason: string, number: number) {
    this.deps.outbox.raise({
      kind: 'ruling',
      mode: this.state.mode === 'live' ? 'live' : 'shadow',
      number,
      title: reason,
      url: `https://github.com/${this.repository}`,
      author: this.state.owner ?? '',
      external: false,
      reasons: [reason],
    });
  }
  private async admit(kind: 'judge' | 'triage', number: number, author: string, consume = true) {
    const now = this.now(),
      day = new Date(now).toISOString().slice(0, 10);
    this.state.judgeStarts = this.state.judgeStarts.filter((at) => now - at < 86400_000);
    this.state.triageStarts = this.state.triageStarts.filter((v) => now - v.at < 86400_000);
    const allowed =
      kind === 'judge'
        ? this.state.invalidStreak < 3 &&
          this.state.judgeStarts.length < 20 &&
          this.state.judgeStarts.filter((at) => now - at < 3600_000).length < 3
        : this.state.triageStarts.length < 30 &&
          this.state.triageStarts.filter((v) => now - v.at < 3600_000).length < 6 &&
          this.state.triageStarts.filter((v) => v.author.toLowerCase() === author.toLowerCase()).length < 2;
    if (allowed && consume) {
      if (kind === 'judge') this.state.judgeStarts.push(now);
      else this.state.triageStarts.push({ at: now, author });
    } else if (!allowed && this.state.overflowDay !== day && !(kind === 'judge' && this.state.invalidStreak >= 3)) {
      this.summary('Daily maintenance queue summary: work deferred by budgets', number);
      this.state.overflowDay = day;
    }
    this.persist();
    if (
      !allowed &&
      this.notice(`budget:${this.repository}:${number}:${this.prs().find((r) => r.number === number)?.sha ?? 'issue'}`)
    )
      await this.audit('skip', `${kind} deferred by budget or judge pause`, kind === 'judge' ? 'pr' : 'issue', number);
    return allowed;
  }
  private kick(numbers: number[]) {
    if (this.worker || !this.hosting()) return;
    const controller = new AbortController();
    this.controllers.add(controller);
    this.worker = (async () => {
      for (const number of numbers) {
        if (!this.hosting() || controller.signal.aborted) break;
        const record = this.deps.store.get<PullRecord>('maintainer-pr', `${this.repository}#${number}`);
        if (!record || record.phase === 'closed') continue;
        if (!record.outcome && !this.deps.runner.toollessReady()) continue;
        this.active = { number, sha: record.sha, controller };
        try {
          const context = await this.context(controller, record);
          // The queue may have waited behind a long judge; verify its head again before acting.
          const row = await context.gh.json(pullRowSchema, [
            'pr',
            'view',
            String(number),
            '--repo',
            this.repository,
            '--json',
            pullFields,
          ]);
          await this.observe(row);
          if (!this.current(record) || row.headRefOid !== record.sha) continue;
          record.row = row;
          await handlePullEvent(record, context);
        } catch (error) {
          const current = this.deps.store.get<PullRecord>('maintainer-pr', `${this.repository}#${number}`);
          if (current?.sha === record.sha && current.phase === 'judging') {
            current.phase = 'queued';
            this.save(current);
          }
          if (!controller.signal.aborted) await this.itemError('pr', number, record.sha, error);
        } finally {
          this.active = undefined;
        }
      }
      for (const issue of this.issues()
        .filter((i) => i.phase !== 'done')
        .sort(
          (a, b) =>
            (a.queuedAt ?? a.row.createdAt).localeCompare(b.queuedAt ?? b.row.createdAt) || a.row.number - b.row.number,
        )) {
        if (!this.hosting() || controller.signal.aborted) break;
        if (!issue.triage && !this.deps.runner.toollessReady()) continue;
        try {
          const context = await this.context(controller, issue);
          await handleIssueEvent(issue, context);
          this.deps.store.save('maintainer-issue', `${this.repository}#${issue.row.number}`, this.repository, issue);
        } catch (error) {
          if (!controller.signal.aborted) await this.itemError('issue', issue.row.number, issue.row.createdAt, error);
        }
      }
    })()
      .catch(async () => {
        if (!controller.signal.aborted)
          await this.audit('error', 'Maintenance worker failed', 'poll', undefined, 'error');
      })
      .finally(() => {
        this.controllers.delete(controller);
        this.active = undefined;
        this.worker = undefined;
      });
  }
  private async publishSuiteFailure(record: PullRecord, context: PipelineDeps) {
    const key = `${record.number}:${record.sha}`;
    const pending = this.suiteWrites.get(key);
    if (pending) {
      await pending;
      context.refresh(record);
      return;
    }
    const work = (async () => {
      context.refresh(record);
      if (!record.suiteFailure || record.suiteFailure.posted || !this.current(record)) return;
      const marker = `<!-- pugport-maintainer suite=${record.sha} -->`;
      const comments = await context.gh.json(
        z.array(z.array(z.object({ body: z.string(), user: z.object({ login: z.string() }) }))),
        ['api', `repos/${this.repository}/issues/${record.number}/comments`, '--paginate', '--slurp'],
      );
      if (!this.current(record)) return;
      const posted =
        comments.flat().some((c) => c.user.login === context.botLogin && c.body.includes(marker)) ||
        (await context.write(
          'comment',
          record.row.author.login,
          ['api', '-X', 'POST', `repos/${this.repository}/issues/${record.number}/comments`, '--input', '-'],
          { body: record.suiteFailure.body + '\n' + marker },
        ));
      const latest = this.deps.store.get<PullRecord>('maintainer-pr', `${this.repository}#${record.number}`);
      if (!latest || !this.current(record) || context.signal.aborted) return;
      latest.suiteFailure = { body: record.suiteFailure.body, posted };
      if (!posted) {
        latest.phase = 'write-pending';
      }
      this.save(latest);
      context.refresh(record);
    })();
    this.suiteWrites.set(key, work);
    try {
      await work;
    } finally {
      this.suiteWrites.delete(key);
    }
  }
  async resolve(id: string, request: GitHubResolve): Promise<boolean> {
    const r = githubResolveSchema.parse(request);
    const card = this.deps.outbox.all(this.repository).find((item) => item.id === id);
    if (!card) return false;
    if (r.outcome === 'declined' || r.outcome === 'merged' || r.outcome === 'failed') {
      const record = this.deps.store.get<PullRecord>('maintainer-pr', `${this.repository}#${card.number}`);
      if (
        record &&
        record.sha === card.judgedSha &&
        (r.outcome === 'declined' || r.outcome === 'merged') &&
        card.kind !== 'suite'
      ) {
        record.decision = r.outcome;
        record.phase = 'done';
        this.save(record);
      }
      this.deps.outbox.resolve(id, {
        outcome: r.outcome,
        at: new Date(this.now()).toISOString(),
        mergeCommit: r.mergeCommit,
        detail: r.detail,
      });
      return true;
    }
    if (card.kind !== 'suite' || !card.judgedSha) return false;
    const record = this.deps.store.get<PullRecord>('maintainer-pr', `${this.repository}#${card.number}`);
    if (!record || record.phase === 'closed' || record.sha !== card.judgedSha) return false;
    if (r.outcome === 'suite-started') {
      record.suite = { state: 'running' };
      this.save(record);
      return true;
    }
    // Batch 2 owns the wire schema. Older peers may omit a structured suite result.
    const result = z
      .object({
        sha: z.string().regex(/^[0-9a-f]{40}$/),
        failed: z.number().int().nonnegative(),
        failingFiles: z.array(z.string()),
        status: z.enum(['passed', 'failed', 'error']),
      })
      .safeParse((r as { suite?: unknown }).suite);
    if (!result.success || result.data.sha !== record.sha) return false;
    const suite = result.data;
    record.suite = { state: suite.status === 'error' ? 'error' : suite.failed ? 'failed' : suite.status };
    if (record.suite.state === 'failed') {
      let body = `Remote full suite at \`${record.sha.slice(0, 7)}\`: ${suite.failed} failed${suite.failingFiles.length ? '\n' + inertSection(suite.failingFiles.join(', ')) : ''}`;
      if (!checkOutbound([{ field: 'comment', value: body }]).ok)
        body = `Remote full suite at \`${record.sha.slice(0, 7)}\`: ${suite.failed} failed (file details withheld).`;
      record.suiteFailure = { body };
    }
    this.save(record);
    this.deps.outbox.resolve(id, { outcome: 'suite-result', at: new Date(this.now()).toISOString() });
    if (!this.hosting() || !this.modeKnown) return true;
    const controller = new AbortController();
    this.controllers.add(controller);
    this.resolving.set(record.number, controller);
    try {
      const context = await this.context(controller, record);
      const row = await context.gh.json(pullRowSchema, [
        'pr',
        'view',
        String(record.number),
        '--repo',
        this.repository,
        '--json',
        pullFields,
      ]);
      await this.observe(row);
      if (!this.current(record)) return true;
      record.row = row;
      await this.publishSuiteFailure(record, context);
      await evaluatePull(record, context);
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    } finally {
      this.controllers.delete(controller);
      this.resolving.delete(record.number);
    }
    return true;
  }
}
