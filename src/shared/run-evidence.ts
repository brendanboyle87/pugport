import type { RunRecord, RuntimeTarget } from './types.ts';

export type VerificationEvidenceReceipt = {
  id: string;
  source: 'host-verification';
  checkedAt: string;
  snapshot?: string;
  revision?: string;
  reused: boolean;
  stable: boolean;
  snapshotDurationMs?: number;
  scope: {
    projectPath: string;
    environment: RuntimeTarget['environment'];
    permissionMode: 'read-only' | 'workspace-write';
    command: string;
  };
};

/** Execution, executor claims, and a bounded host check are separate evidence. */
export function projectRunEvidence(run: Pick<RunRecord, 'status' | 'taskOutcome' | 'verification'>) {
  const verification = run.verification;
  const receipt = verification?.receipt;
  const reported: 'reported' | 'unverified' | 'failed' = ['completed', 'dropped'].includes(
    run.taskOutcome?.status ?? '',
  )
    ? 'reported'
    : ['partial', 'blocked', 'failed'].includes(run.taskOutcome?.status ?? '')
      ? 'failed'
      : 'unverified';
  const check: 'verified' | 'unverified' | 'failed' | 'skipped' | 'cancelled' =
    verification?.status === 'passed'
      ? receipt?.source === 'host-verification' &&
        receipt.scope.command === verification.command &&
        receipt.stable &&
        !!receipt.snapshot
        ? 'verified'
        : 'unverified'
      : (verification?.status ?? 'unverified');
  return { execution: run.status, reported, verification: check, receipt };
}
