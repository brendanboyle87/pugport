import type { MaintainerMode } from './config.ts';
import type { Tier } from './tiers.ts';

export type VerdictRecord = {
  number: number;
  sha: string;
  verdict: 'pass' | 'fail' | 'blocked' | 'invalid';
  tier: Tier;
  external: boolean;
  mode: MaintainerMode;
  judgedAt: string;
  outcome?: 'merged' | 'closed' | 'superseded';
  outcomeAt?: string;
};
export function recordOutcome(
  records: VerdictRecord[],
  pr: { number: number; headSha: string; merged: boolean; closed: boolean; at: string },
): VerdictRecord[] {
  return records.map((r) =>
    r.number !== pr.number || r.outcome
      ? r
      : {
          ...r,
          ...(r.sha !== pr.headSha
            ? { outcome: 'superseded' as const, outcomeAt: pr.at }
            : pr.merged || pr.closed
              ? { outcome: pr.merged ? ('merged' as const) : ('closed' as const), outcomeAt: pr.at }
              : {}),
        },
  );
}
export function score(records: VerdictRecord[]) {
  const result = {
    judged: 0,
    falsePasses: 0,
    falseFails: 0,
    pending: 0,
    byTier: {
      docs: { judged: 0, falsePasses: 0 },
      code: { judged: 0, falsePasses: 0 },
      owner: { judged: 0, falsePasses: 0 },
    },
  };
  for (const r of records.filter((r) => r.mode === 'shadow' && (r.verdict === 'pass' || r.verdict === 'fail'))) {
    result.judged++;
    result.byTier[r.tier].judged++;
    if (!r.outcome) result.pending++;
    if (r.verdict === 'pass' && r.outcome === 'closed') {
      result.falsePasses++;
      result.byTier[r.tier].falsePasses++;
    }
    if (r.verdict === 'fail' && r.outcome === 'merged') result.falseFails++;
  }
  return result;
}
