export type LaneGitHubState =
  | 'draft'
  | 'open'
  | 'checks-running'
  | 'checks-failing'
  | 'checks-passing'
  | 'review-requested'
  | 'changes-requested'
  | 'approved'
  | 'merged'
  | 'closed';

/** Count a PR's statusCheckRollup rows; `failing` names are cleaned for a bracketed host observation. */
export function countChecks(value: unknown) {
  const items = Array.isArray(value) ? value : [];
  let passed = 0;
  let failed = 0;
  let pending = 0;
  const failing: string[] = [];
  for (const item of items) {
    const row = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
    // A StatusContext has `state`; a CheckRun has `status`, and its result is `conclusion` once COMPLETED.
    const status = String(row.status ?? '').toUpperCase();
    const state = String(row.state ?? (status === 'COMPLETED' ? row.conclusion : status) ?? '').toUpperCase();
    if (['SUCCESS', 'PASS', 'PASSED', 'NEUTRAL', 'SKIPPED'].includes(state)) passed += 1;
    else if (
      ['FAILURE', 'FAILED', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(state)
    ) {
      failed += 1;
      failing.push(
        String(row.name ?? row.context ?? '')
          .replace(/[\u0000-\u001F[\]]/g, '')
          .slice(0, 80),
      );
    } else pending += 1;
  }
  return { passed, failed, pending, failing: failing.sort().slice(0, 20) };
}

export type PullObservation = {
  state: string;
  draft: boolean;
  headSha: string;
  url?: string;
  reviewDecision: string;
  reviewRequests: number;
  checks: ReturnType<typeof countChecks>;
};

export function deriveLaneGitHubState(view: PullObservation): LaneGitHubState {
  const state = view.state.toUpperCase();
  if (state === 'MERGED') return 'merged';
  if (state === 'CLOSED') return 'closed';
  if (view.draft) return 'draft';
  if (view.reviewDecision === 'CHANGES_REQUESTED') return 'changes-requested';
  if (view.checks.failed > 0) return 'checks-failing';
  if (view.checks.pending > 0) return 'checks-running';
  if (view.reviewDecision === 'APPROVED') return 'approved';
  if (view.reviewRequests > 0) return 'review-requested';
  if (view.checks.passed > 0) return 'checks-passing';
  return 'open';
}

/** States worth waking the coordinator for, once that head's checks have settled. */
export const newsStates: ReadonlySet<LaneGitHubState> = new Set<LaneGitHubState>([
  'checks-failing',
  'checks-passing',
  'changes-requested',
  'approved',
  'review-requested',
]);

/** `<who>/<issue>-<slug>`; a digit after the dash (release/2026-10) is a date, not an issue. */
export function issueFromBranch(branch?: string) {
  const match = branch && /^[^/]+\/(\d{1,7})-(?!\d)/.exec(branch);
  const issue = match ? Number(match[1]) : 0;
  return issue > 0 ? issue : undefined;
}
