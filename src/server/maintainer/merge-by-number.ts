import { z } from 'zod';
import type { ProjectGates } from '../../shared/types.ts';
import { ciState, requiredChecks } from './checks.ts';
import { decide } from '../github-gate.ts';
import { redactToolDiagnostic } from '../tool-diagnostics.ts';
import type { Gh } from './gh.ts';
import type { OutboxItem } from './outbox.ts';
import type { AuditLine } from './audit.ts';
import { repositorySchema } from './config.ts';

export type MergeInput = { repository: string; number: number; judgedSha: string; cardId: string; method?: 'merge' };
export type MergeDeps = {
  gh: Gh;
  card: () => Promise<OutboxItem | undefined>;
  gates?: ProjectGates;
  requiredChecks?: string[];
  now?: () => Date;
  audit: (line: AuditLine) => void;
  signal?: AbortSignal;
};
const sha = z.string().regex(/^[0-9a-f]{40}$/);
const viewSchema = z.object({
  state: z.string(),
  isDraft: z.boolean(),
  headRefOid: sha,
  baseRefName: z.string(),
  isCrossRepository: z.boolean(),
  mergeable: z.string(),
  mergeStateStatus: z.string(),
  statusCheckRollup: z.array(z.record(z.string(), z.unknown())).nullable(),
  labels: z.array(z.object({ name: z.string() })),
  title: z.string(),
  files: z.array(z.object({ path: z.string() })),
});
export async function mergePullByNumber(
  input: MergeInput,
  deps: MergeDeps,
): Promise<{ status: 'merged'; mergeCommit: string } | { status: 'refused'; reason: string }> {
  const now = deps.now ?? (() => new Date());
  const audit = (action: AuditLine['action'], result: AuditLine['result'], detail: string) =>
    deps.audit({
      at: now().toISOString(),
      mode: 'live',
      event: 'pr',
      number: input.number,
      sha: input.judgedSha,
      action,
      result,
      credential: 'gh-desktop',
      detail,
    });
  const refuse = (reason: string, attempted = false) => {
    audit(attempted ? 'error' : 'refused', attempted ? 'error' : 'skipped', reason);
    return { status: 'refused' as const, reason };
  };
  let attempted = false;
  try {
    if (
      !repositorySchema.safeParse(input.repository).success ||
      !Number.isSafeInteger(input.number) ||
      input.number < 1 ||
      !sha.safeParse(input.judgedSha).success ||
      (input.method !== undefined && input.method !== 'merge')
    )
      return refuse('Invalid merge request');
    const card = await deps.card();
    if (
      !card ||
      card.id !== input.cardId ||
      card.number !== input.number ||
      card.resolution ||
      card.supersededBy ||
      (card.expiresAt && Date.parse(card.expiresAt) <= now().getTime()) ||
      card.kind !== 'merge' ||
      card.verdict !== 'pass' ||
      card.judgedSha !== input.judgedSha ||
      card.mode !== 'live'
    )
      return refuse('Merge card is missing, stale or not approved');
    if (card.tier === 'owner' || card.external) return refuse("this PR needs the maintainer's own review on GitHub");
    const url = new URL(card.url);
    if (
      url.hostname !== 'github.com' ||
      url.pathname.toLowerCase() !== `/${input.repository}/pull/${input.number}`.toLowerCase()
    )
      return refuse('Merge card belongs to another repository');
    const view = await deps.gh.json(
      viewSchema,
      [
        'pr',
        'view',
        String(input.number),
        '--repo',
        input.repository,
        '--json',
        Object.keys(viewSchema.shape).join(','),
      ],
      { signal: deps.signal },
    );
    if (view.state !== 'OPEN') return refuse('Pull request is not open');
    if (view.isDraft) return refuse('Pull request is a draft');
    if (view.baseRefName !== card.baseRef)
      return refuse(`base branch changed to ${view.baseRefName}; a new review runs`);
    if (view.headRefOid !== input.judgedSha)
      return refuse(`head moved to ${view.headRefOid.slice(0, 7)}; a new review runs`);
    if (view.labels.some((label) => label.name.toLowerCase() === 'hold'))
      return refuse('Pull request has a hold label');
    if (view.mergeable === 'CONFLICTING') return refuse('Pull request has merge conflicts');
    if (view.mergeStateStatus === 'DIRTY' || view.mergeStateStatus === 'UNKNOWN')
      return refuse('GitHub has not finished checking mergeability; try again');
    const checks = ciState(
      view.statusCheckRollup,
      await requiredChecks(deps.gh, input.repository, view.baseRefName, deps.requiredChecks, deps.signal),
    );
    if (!checks.green)
      return refuse(
        [
          'CI is not green',
          ...checks.missing.map((name) => 'missing: ' + name),
          ...checks.failed.map((name) => 'failed: ' + name),
          ...checks.pending.map((name) => 'pending: ' + name),
        ].join('; '),
      );
    const gate = decide(
      { op: 'merge', repo: input.repository, paths: view.files.map((file) => file.path) },
      deps.gates,
      now(),
    );
    if (gate.outcome === 'refuse') return refuse('Merge is blocked by the configured no-merge window');
    deps.signal?.throwIfAborted();
    attempted = true;
    await deps.gh.text(
      [
        'pr',
        'merge',
        String(input.number),
        '--repo',
        input.repository,
        '--merge',
        '--match-head-commit',
        input.judgedSha,
      ],
      { signal: deps.signal },
    );
    const merged = await deps.gh.json(
      z.object({ state: z.string(), mergeCommit: z.object({ oid: sha }).nullable() }),
      ['pr', 'view', String(input.number), '--repo', input.repository, '--json', 'state,mergeCommit'],
      { signal: deps.signal },
    );
    if (merged.state !== 'MERGED' || !merged.mergeCommit) return refuse('merge reported but not confirmed', true);
    audit('merge', 'ok', `Merged ${merged.mergeCommit.oid}`);
    return { status: 'merged', mergeCommit: merged.mergeCommit.oid };
  } catch (error) {
    return refuse(redactToolDiagnostic(String(error), 400), attempted);
  }
}
