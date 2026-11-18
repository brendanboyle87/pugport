import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { countChecks } from '../../shared/lane-github.ts';
import type { ProjectGates } from '../../shared/types.ts';
import { readHostFlag, type MaintainerMode } from './config.ts';
import type { Gh } from './gh.ts';
import { JudgeUnavailableError, type NoToolsRunner } from './executor.ts';
import type { Outbox, OutboxItem } from './outbox.ts';
import type { AuditLine } from './audit.ts';
import { fetchPullMaterial, type PrMaterial } from './pr-material.ts';
import { classifyPullRequest, type TierResult } from './tiers.ts';
import { runPrJudge, type PrJudgeOutcome } from './pr-judge.ts';
import { publishReview, type ReviewDone } from './review-comment.ts';
import { ciState, requiredChecks } from './checks.ts';
import { allowedLabels, ownerOnlyLabels } from './labels.ts';
import {
  findDuplicates,
  renderSecurityComment,
  renderTriageComment,
  runIssueTriage,
  type Triage,
  type Duplicate,
} from './issue-triage.ts';
import { checkOutbound } from './outbound.ts';

export type WriteKind = 'comment' | 'judge-status' | 'review' | 'label' | 'label-create';
export function mayWrite(input: {
  kind: WriteKind;
  mode: MaintainerMode;
  author: string;
  repoOwner: string;
  app: boolean;
  writesPaused: boolean;
  flagFile: string;
  now: number;
  issue?: boolean;
}): boolean {
  const flag = readHostFlag(input.flagFile);
  if (
    !flag.host ||
    !flag.repository ||
    !flag.leaseUntil ||
    Date.parse(flag.leaseUntil) <= input.now ||
    !input.app ||
    input.writesPaused
  )
    return false;
  return (
    input.mode === 'live' ||
    (input.mode === 'shadow' &&
      !input.issue &&
      input.author.toLowerCase() === input.repoOwner.toLowerCase() &&
      !!input.repoOwner &&
      ['comment', 'judge-status'].includes(input.kind))
  );
}
export const pullRowSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  url: z.string().url(),
  author: z.object({ login: z.string(), is_bot: z.boolean().optional() }),
  state: z.string(),
  isDraft: z.boolean(),
  headRefOid: z.string().regex(/^[0-9a-f]{40}$/),
  baseRefName: z.string(),
  updatedAt: z.string(),
  labels: z.array(z.object({ name: z.string() })),
  statusCheckRollup: z.array(z.record(z.string(), z.unknown())).nullable().optional(),
});
export type PullListRow = z.infer<typeof pullRowSchema>;
export const pullFields = Object.keys(pullRowSchema.shape).join(',');
export const issueRowSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  url: z.string().url(),
  author: z.object({ login: z.string(), is_bot: z.boolean().optional() }),
  labels: z.array(z.object({ name: z.string() })),
  createdAt: z.string(),
  updatedAt: z.string(),
  body: z.string().optional(),
});
export type IssueListRow = z.infer<typeof issueRowSchema>;
export const issueFields = Object.keys(issueRowSchema.shape)
  .filter((v) => v !== 'body')
  .join(',');
const tierLabels = ['tier:docs', 'tier:code', 'tier:owner'];
export type PullRecord = {
  number: number;
  sha: string;
  phase:
    | 'queued'
    | 'judging'
    | 'awaiting-cla'
    | 'awaiting-ci'
    | 'awaiting-suite'
    | 'write-pending'
    | 'carded'
    | 'done'
    | 'closed';
  tier?: TierResult;
  external?: boolean;
  verdict?: PrJudgeOutcome['verdict'];
  judgeId?: string;
  judgedAt?: string;
  ci?: OutboxItem['ci'];
  suite?: OutboxItem['suite'];
  done?: ReviewDone;
  writeAttempts?: number;
  writesStopped?: boolean;
  quiet?: string[];
  queuedAt?: string;
  updatedAt: string;
  row: PullListRow;
  outcome?: PrJudgeOutcome;
  material?: PrMaterial;
  queuedStatus?: boolean;
  /** The pending status says the pinned judge is unavailable rather than "Review queued". */
  queuedNote?: 'unavailable';
  suiteFailure?: { body: string; posted?: boolean };
  decision?: 'declined' | 'merged';
};
export type IssueRecord = {
  row: IssueListRow;
  phase: 'queued' | 'done' | 'write-pending';
  done?: { label?: boolean; comment?: boolean };
  writeAttempts?: number;
  queuedAt?: string;
  triage?: Triage;
  duplicates?: Duplicate[];
  runId?: string;
};
export type PipelineDeps = {
  gh: Gh;
  labels: () => Promise<string[]>;
  runner: NoToolsRunner;
  outbox: Outbox;
  repository: string;
  flagFile: string;
  mode: 'shadow' | 'live';
  repoOwner: string;
  defaultBranch: string;
  botLogin: string;
  signal: AbortSignal;
  gates?: ProjectGates;
  now: () => number;
  trust: (login: string) => Promise<boolean>;
  audit: (line: AuditLine) => Promise<void>;
  may: (kind: WriteKind, author: string, issue?: boolean) => Promise<boolean>;
  write: (kind: WriteKind, author: string, args: string[], body?: object, issue?: boolean) => Promise<boolean>;
  save: (record: PullRecord) => void;
  current: (record: PullRecord) => boolean;
  refresh: (record: PullRecord) => void;
  admit: (kind: 'judge' | 'triage', number: number, author: string, consume?: boolean) => Promise<boolean>;
  verdict: (record: PullRecord) => void;
};
export async function auditSkip(deps: PipelineDeps, event: 'pr' | 'issue', number: number, detail: string) {
  await deps.audit({
    at: new Date(deps.now()).toISOString(),
    mode: deps.mode,
    event,
    number,
    action: 'skip',
    result: 'skipped',
    credential: 'none',
    detail,
  });
}
export function pullCard(record: PullRecord, deps: PipelineDeps, kind: OutboxItem['kind'], reasons: string[] = []) {
  deps.refresh(record);
  if (record.decision) return;
  if (deps.signal.aborted || !deps.current(record)) return;
  return deps.outbox.raise({
    kind,
    mode: deps.mode,
    number: record.number,
    title: record.row.title.slice(0, 200),
    url: record.row.url,
    author: record.row.author.login,
    external: record.external ?? true,
    tier: record.tier?.tier,
    judgedSha: record.sha,
    baseRef: record.row.baseRefName,
    verdict: record.verdict,
    judgeId: record.judgeId,
    ci: record.ci,
    suite: record.suite,
    reasons,
  });
}
export async function evaluatePull(record: PullRecord, deps: PipelineDeps): Promise<void> {
  if (!record.outcome || !deps.current(record) || deps.signal.aborted) return;
  deps.refresh(record);
  if (record.decision) {
    record.phase = 'done';
    deps.save(record);
    return;
  }
  let mergeable = false;
  const labels = record.row.labels.map((l) => l.name);
  record.ci = { ...countChecks(record.row.statusCheckRollup), unavailable: !record.row.statusCheckRollup?.length };
  if (record.verdict === 'blocked' || record.verdict === 'invalid') {
    pullCard(record, deps, 'ruling', ['Review needs the maintainer']);
    record.phase = 'carded';
  } else if (
    record.external ||
    record.tier?.tier === 'owner' ||
    labels.some((l) => ['size:large', 'hold'].includes(l)) ||
    record.row.baseRefName !== deps.defaultBranch
  ) {
    pullCard(record, deps, 'review');
    record.phase = 'carded';
  } else if (record.verdict !== 'pass' || deps.mode === 'shadow') record.phase = 'done';
  else {
    const required = await requiredChecks(
      deps.gh,
      deps.repository,
      record.row.baseRefName,
      readHostFlag(deps.flagFile).requiredChecks,
      deps.signal,
    );
    deps.refresh(record);
    if (!deps.current(record) || deps.signal.aborted) return;
    if (record.decision) {
      record.phase = 'done';
      deps.save(record);
      return;
    }
    if (!ciState(record.row.statusCheckRollup, required).green) record.phase = 'awaiting-ci';
    else if (record.suite && record.suite.state !== 'passed') record.phase = 'awaiting-suite';
    else {
      mergeable = true;
      pullCard(record, deps, 'merge');
      record.phase = 'carded';
    }
  }
  if (!mergeable)
    for (const card of deps.outbox.all(deps.repository).filter((c) => c.kind === 'merge' && c.number === record.number))
      deps.outbox.resolve(card.id, { outcome: 'superseded', at: new Date(deps.now()).toISOString() });
  if (pullWritesPending(record)) record.phase = 'write-pending';
  if (record.writesStopped) record.phase = 'carded';
  deps.save(record);
}
export function pullWritesPending(record: PullRecord): boolean {
  return (
    !!record.outcome &&
    !record.writesStopped &&
    (['label', 'comment', 'status', 'review', 'needsRuling'] as const).some((key) => !record.done?.[key])
  );
}
export async function publishPull(record: PullRecord, deps: PipelineDeps) {
  if (!record.material || !record.outcome || !record.tier || !deps.current(record) || record.writesStopped) return;
  const done = (record.done ??= { label: false, comment: false, status: false, review: false, needsRuling: false });
  record.writeAttempts = (record.writeAttempts ?? 0) + 1;
  const author = record.row.author.login;
  const may = async (kind: WriteKind) => {
    if (
      deps.mode === 'shadow' &&
      (author.toLowerCase() !== deps.repoOwner.toLowerCase() || !['comment', 'judge-status'].includes(kind))
    )
      return false;
    return deps.may(kind, author);
  };
  const label = async (key: 'label' | 'needsRuling', name: string) => {
    if (done[key]) return;
    if (deps.mode === 'shadow') {
      done[key] = true;
      return;
    }
    const args = ['pr', 'edit', String(record.number), '--repo', deps.repository, '--add-label', name];
    if (name.startsWith('tier:'))
      for (const old of record.row.labels.filter((l) => tierLabels.includes(l.name) && l.name !== name))
        args.push('--remove-label', old.name);
    done[key] = await deps.write('label', author, args);
    deps.save(record);
  };
  await label('label', record.tier.label);
  if (['blocked', 'invalid'].includes(record.outcome.verdict)) await label('needsRuling', 'needs-owner-ruling');
  else done.needsRuling = true;
  if (deps.mode === 'shadow') {
    done.review = true;
    if (author.toLowerCase() !== deps.repoOwner.toLowerCase()) done.comment = done.status = true;
  }
  try {
    await publishReview(
      {
        material: record.material,
        outcome: record.outcome,
        tier: record.tier,
        trusted: !record.external,
        suite: record.suite,
        next: record.verdict === 'fail' ? 'changes-requested' : 'waiting',
        mode: deps.mode,
        authorIsOwner: author.toLowerCase() === deps.repoOwner.toLowerCase(),
        done,
      },
      {
        readGh: deps.gh,
        write: deps.write,
        botLogin: deps.botLogin,
        outbox: deps.outbox,
        now: deps.now,
        audit: deps.audit,
        save: () => deps.save(record),
        may,
      },
    );
  } catch (error) {
    if (deps.signal.aborted) throw error;
  }
  if (pullWritesPending(record) && record.writeAttempts >= 5) {
    record.writesStopped = true;
    pullCard(record, deps, 'ruling', ['GitHub writes keep failing']);
  }
  if (deps.current(record)) deps.save(record);
}
function requestSuite(record: PullRecord, deps: PipelineDeps) {
  if (deps.mode === 'live' && !record.external && readHostFlag(deps.flagFile).suiteConfigured && !record.suite) {
    record.suite = { state: 'queued' };
    pullCard(record, deps, 'suite');
    deps.save(record);
  }
}
async function quietSkip(record: PullRecord, deps: PipelineDeps, detail: string) {
  if (record.quiet?.includes(detail)) return;
  (record.quiet ??= []).push(detail);
  deps.save(record);
  await auditSkip(deps, 'pr', record.number, detail);
}
export async function handlePullEvent(record: PullRecord, deps: PipelineDeps): Promise<void> {
  deps.refresh(record);
  if (record.decision) {
    record.phase = 'done';
    deps.save(record);
    return;
  }
  const pr = record.row;
  const fresh = () => {
    deps.signal.throwIfAborted();
    if (!deps.current(record)) throw new Error('Superseded pull request');
  };
  if (pr.isDraft) {
    await quietSkip(record, deps, 'draft');
    return;
  }
  if (pr.author.is_bot || pr.author.login.endsWith('[bot]')) {
    pullCard(record, deps, 'review', ['Bot contribution needs the maintainer']);
    record.phase = 'carded';
    deps.save(record);
    return;
  }
  if (record.outcome) {
    requestSuite(record, deps);
    if (pullWritesPending(record)) await publishPull(record, deps);
    await evaluatePull(record, deps);
    return;
  }
  if (!(await deps.admit('judge', pr.number, pr.author.login, false))) return;
  const material = await fetchPullMaterial(deps.gh, deps.repository, pr.number, undefined, deps.signal);
  fresh();
  if ('headSha' in material && (material.headSha !== record.sha || material.baseRef !== pr.baseRefName)) return;
  record.external = !(await deps.trust(pr.author.login));
  fresh();
  record.tier = classifyPullRequest({
    paths: material.paths,
    pathsTruncated: material.pathsTruncated,
    authorIsCollaborator: !record.external,
    gates: deps.gates,
  });
  const required = await requiredChecks(
    deps.gh,
    deps.repository,
    pr.baseRefName,
    readHostFlag(deps.flagFile).requiredChecks,
    deps.signal,
  );
  if (
    pr.author.login.toLowerCase() !== deps.repoOwner.toLowerCase() &&
    required.includes('CLA') &&
    !ciState(pr.statusCheckRollup, ['CLA']).green
  ) {
    if (!pr.labels.some((label) => label.name === 'needs-cla'))
      await deps.write('label', pr.author.login, [
        'pr',
        'edit',
        String(pr.number),
        '--repo',
        deps.repository,
        '--add-label',
        'needs-cla',
      ]);
    record.phase = 'awaiting-cla';
    deps.save(record);
    await quietSkip(record, deps, 'CLA required');
    return;
  }
  record.phase = 'judging';
  deps.save(record);
  const maxPromptKB = readHostFlag(deps.flagFile).judge?.maxPromptKB;
  let outcome: PrJudgeOutcome;
  try {
    outcome = await runPrJudge(
      {
        material,
        tier: record.tier,
        trusted: !record.external,
        mode: deps.mode,
        ...(maxPromptKB ? { maxPromptBytes: maxPromptKB * 1000 } : {}),
      },
      {
        runner: {
          ...deps.runner,
          dispatch: async (input) => {
            // Checked before the budget so a refused run does not use up a judge start.
            const unavailable = deps.runner.unavailable?.();
            if (unavailable) throw new JudgeUnavailableError(unavailable);
            if (!(await deps.admit('judge', pr.number, pr.author.login))) throw new Error('Judge budget unavailable');
            return deps.runner.dispatch(input);
          },
        },
        now: deps.now,
        signal: deps.signal,
      },
    );
  } catch (error) {
    if (!(error instanceof JudgeUnavailableError)) throw error;
    // No verdict and no other executor: the record stays queued and a later poll tries the pinned judge again.
    deps.signal.throwIfAborted();
    if (deps.current(record)) {
      record.phase = 'queued';
      deps.save(record);
    }
    await auditSkip(deps, 'pr', pr.number, `Review unavailable: ${error.message}`);
    return;
  }
  fresh();
  record.outcome = { ...outcome, sha: record.sha };
  record.verdict = outcome.verdict;
  record.judgeId = outcome.judgeId;
  record.judgedAt = outcome.endedAt;
  record.material =
    'blocked' in material
      ? {
          repository: deps.repository,
          number: pr.number,
          title: pr.title,
          url: pr.url,
          author: pr.author.login,
          authorIsBot: false,
          body: '',
          isCrossRepository: false,
          isDraft: false,
          state: pr.state,
          labels: pr.labels.map((l) => l.name),
          baseRef: pr.baseRefName,
          baseSha: record.sha,
          headRef: '',
          headSha: record.sha,
          additions: 0,
          deletions: 0,
          changedFiles: material.paths.length,
          diff: '',
          diffBytes: 0,
          files: [],
          paths: material.paths,
          pathsTruncated: material.pathsTruncated,
          relatedTests: [],
          checks: countChecks(pr.statusCheckRollup),
          omitted: [material.blocked],
        }
      : material;
  record.done = { label: false, comment: false, status: false, review: false, needsRuling: false };
  deps.save(record);
  deps.verdict(record);
  requestSuite(record, deps);
  await publishPull(record, deps);
  await evaluatePull(record, deps);
}
export async function handleIssueEvent(record: IssueRecord, deps: PipelineDeps): Promise<void> {
  const issue = await deps.gh.json(
    issueRowSchema.extend({ body: z.string() }),
    ['issue', 'view', String(record.row.number), '--repo', deps.repository, '--json', `${issueFields},body`],
    { signal: deps.signal },
  );
  if (issue.number !== record.row.number) throw new Error('Issue changed');
  record.row = issue;
  const author = issue.author.login;
  if (
    author.toLowerCase() === deps.repoOwner.toLowerCase() ||
    issue.author.is_bot ||
    author.endsWith('[bot]') ||
    issue.labels.some((l) => l.name.startsWith('tier:') || ownerOnlyLabels.includes(l.name))
  ) {
    record.phase = 'done';
    await auditSkip(deps, 'issue', issue.number, 'owner, bot or human process label');
    return;
  }
  const comments = await deps.gh.json(
    z.array(z.array(z.object({ body: z.string(), user: z.object({ login: z.string() }) }))),
    ['api', `repos/${deps.repository}/issues/${issue.number}/comments`, '--paginate', '--slurp'],
    { signal: deps.signal },
  );
  if (
    !record.triage &&
    comments
      .flat()
      .some(
        (c) => c.user.login === deps.botLogin && /<!-- pugport-maintainer run=it-\d{8}-[0-9a-f]{8} -->/.test(c.body),
      )
  ) {
    record.phase = 'done';
    await auditSkip(deps, 'issue', issue.number, 'already triaged');
    return;
  }
  if (!record.triage) {
    if (!(await deps.admit('triage', issue.number, author))) return;
    const result = await runIssueTriage(issue, { runner: deps.runner, signal: deps.signal, mode: deps.mode });
    if (!result.triage) {
      record.phase = 'done';
      await auditSkip(deps, 'issue', issue.number, 'invalid triage');
      return;
    }
    record.triage = result.triage;
    record.runId = `it-${new Date(deps.now()).toISOString().slice(0, 10).replaceAll('-', '')}-${randomBytes(4).toString('hex')}`;
  }
  deps.signal.throwIfAborted();
  const triage = record.triage;
  const security = triage.looksLikeSecurity || triage.type === 'security';
  record.duplicates ??= security
    ? []
    : await findDuplicates(deps.gh, deps.repository, issue.number, triage.keywords, deps.signal);
  const cardKind = security
    ? 'security'
    : triage.duplicateHint || record.duplicates.some((d) => d.state.toLowerCase() === 'open')
      ? 'close'
      : undefined;
  deps.signal.throwIfAborted();
  if (cardKind)
    deps.outbox.raise({
      kind: cardKind,
      mode: deps.mode,
      number: issue.number,
      title: issue.title.slice(0, 200),
      url: issue.url,
      author,
      external: true,
      reasons: [
        security ? 'Private security reporting recommended' : 'Possible duplicate; maintainer decision required',
      ],
    });
  let body = security
    ? renderSecurityComment(record.runId!)
    : renderTriageComment({ triage, duplicates: record.duplicates, runId: record.runId! });
  if (!checkOutbound([{ field: 'comment', value: body }]).ok) {
    await auditSkip(deps, 'issue', issue.number, 'Outbound details withheld');
    body = renderTriageComment({ triage: { ...triage, missingInfo: [] }, duplicates: [], runId: record.runId! });
  }
  const done = (record.done ??= {});
  record.writeAttempts = (record.writeAttempts ?? 0) + 1;
  if (!done.label) {
    try {
      const labels = security || deps.mode === 'shadow' ? [] : allowedLabels(triage.labels, await deps.labels());
      done.label =
        !labels.length ||
        (await deps.write(
          'label',
          author,
          ['issue', 'edit', String(issue.number), '--repo', deps.repository, '--add-label', labels.join(',')],
          undefined,
          true,
        ));
    } catch (error) {
      if (deps.signal.aborted) throw error;
    }
  }
  if (!done.comment)
    done.comment = await deps.write(
      'comment',
      author,
      ['api', '-X', 'POST', `repos/${deps.repository}/issues/${issue.number}/comments`, '--input', '-'],
      { body },
      true,
    );
  record.phase = (done.label && done.comment) || deps.mode === 'shadow' ? 'done' : 'write-pending';
  if (record.phase === 'write-pending' && record.writeAttempts >= 5) {
    record.phase = 'done';
    await auditSkip(deps, 'issue', issue.number, 'GitHub writes keep failing; issue retries exhausted');
  }
}
