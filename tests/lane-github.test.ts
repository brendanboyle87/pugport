import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  countChecks,
  deriveLaneGitHubState,
  issueFromBranch,
  newsStates,
  type PullObservation,
} from '../src/shared/lane-github.ts';

const view = (patch: Partial<PullObservation> = {}, checks: Partial<PullObservation['checks']> = {}) =>
  ({
    state: 'OPEN',
    draft: false,
    headSha: 'abc',
    reviewDecision: '',
    reviewRequests: 0,
    ...patch,
    checks: { passed: 0, failed: 0, pending: 0, failing: [], ...checks },
  }) satisfies PullObservation;

test('PR state is derived in priority order, first hit wins', () => {
  const rows: Array<[PullObservation, string]> = [
    [view({ state: 'merged', draft: true }, { failed: 1 }), 'merged'],
    [view({ state: 'CLOSED', draft: true }), 'closed'],
    [view({ draft: true, reviewDecision: 'CHANGES_REQUESTED' }), 'draft'],
    [view({ reviewDecision: 'CHANGES_REQUESTED' }, { failed: 1 }), 'changes-requested'],
    [view({}, { failed: 1, pending: 2 }), 'checks-failing'],
    [view({ reviewDecision: 'APPROVED' }, { pending: 1, passed: 1 }), 'checks-running'],
    [view({ reviewDecision: 'APPROVED' }, { passed: 1 }), 'approved'],
    [view({ reviewRequests: 1 }, { passed: 1 }), 'review-requested'],
    [view({}, { passed: 1 }), 'checks-passing'],
    [view(), 'open'],
    [view({ draft: true, reviewDecision: 'APPROVED' }), 'draft'],
  ];
  for (const [input, expected] of rows) assert.equal(deriveLaneGitHubState(input), expected, JSON.stringify(input));
  assert.deepEqual([...newsStates].sort(), [
    'approved',
    'changes-requested',
    'checks-failing',
    'checks-passing',
    'review-requested',
  ]);
});

test('checks count CheckRuns and StatusContexts and list failing names safely', () => {
  const long = 'x'.repeat(100);
  const result = countChecks([
    { name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { context: 'lint', state: 'PENDING' },
    { name: 'neutral', status: 'COMPLETED', conclusion: 'NEUTRAL' },
    { name: 'skipped', status: 'COMPLETED', conclusion: 'SKIPPED' },
    { name: 'zeta', status: 'COMPLETED', conclusion: 'CANCELLED' },
    { name: 'timed', status: 'COMPLETED', conclusion: 'TIMED_OUT' },
    { name: 'act\u0007ion]', status: 'COMPLETED', conclusion: 'ACTION_REQUIRED' },
    { context: 'status', state: 'FAILURE' },
    { name: long, status: 'COMPLETED', conclusion: 'STARTUP_FAILURE' },
    { name: 'queued', status: 'QUEUED' },
  ]);
  assert.equal(result.passed, 3);
  assert.equal(result.failed, 5);
  assert.equal(result.pending, 2);
  assert.deepEqual(result.failing, ['action', 'status', 'timed', 'x'.repeat(80), 'zeta']);
  assert.deepEqual(countChecks({ name: 'not an array' }), { passed: 0, failed: 0, pending: 0, failing: [] });
});

test('an issue number comes only from a <who>/<issue>-<slug> branch', () => {
  assert.equal(issueFromBranch('alex/123-fix'), 123);
  assert.equal(issueFromBranch('alex/0-fix'), undefined);
  for (const branch of ['alice/fix-thing', '123-fix', 'release/2026-10', 'alex/12345678-fix', undefined])
    assert.equal(issueFromBranch(branch), undefined, String(branch));
});
