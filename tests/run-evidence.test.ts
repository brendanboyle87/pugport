import assert from 'node:assert/strict';
import test from 'node:test';
import { projectRunEvidence, type VerificationEvidenceReceipt } from '../src/shared/run-evidence.ts';

const receipt: VerificationEvidenceReceipt = {
  id: 'synthetic-receipt',
  source: 'host-verification',
  checkedAt: '2026-10-24T00:00:00.000Z',
  reused: false,
  stable: true,
  snapshot: 'synthetic-snapshot',
  scope: { projectPath: '/synthetic', environment: 'native', permissionMode: 'read-only', command: 'check' },
};

test('executor completion and self-reported verified claims remain separate from host checks', () => {
  const projection = projectRunEvidence({
    status: 'completed',
    taskOutcome: { status: 'completed', source: 'executor-report', claims: [{ claim: 'all works', verified: true }] },
  });
  assert.equal(projection.execution, 'completed');
  assert.equal(projection.reported, 'reported');
  assert.equal(projection.verification, 'unverified');
});

test('host receipts verify only their matching command while incomplete task reports remain incomplete', () => {
  const verification = { command: 'check', status: 'passed' as const, exitCode: 0, output: '', receipt };
  const projection = projectRunEvidence({
    status: 'failed',
    taskOutcome: { status: 'partial', source: 'executor-report' },
    verification,
  });
  assert.equal(projection.execution, 'failed');
  assert.equal(projection.reported, 'failed');
  assert.equal(projection.verification, 'verified');
  assert.equal(
    projectRunEvidence({ status: 'completed', verification: { ...verification, receipt: undefined } }).verification,
    'unverified',
  );
  assert.equal(
    projectRunEvidence({ status: 'completed', verification: { ...verification, command: 'another' } }).verification,
    'unverified',
  );
  assert.equal(
    projectRunEvidence({
      status: 'completed',
      verification: { ...verification, receipt: { ...receipt, stable: false } },
    }).verification,
    'unverified',
  );
});

test('failed, skipped and cancelled host checks retain their exact evidence state', () => {
  for (const status of ['failed', 'skipped', 'cancelled'] as const) {
    const evidence = projectRunEvidence({
      status: 'completed',
      verification: { command: 'check', status, exitCode: null, output: '' },
    });
    assert.equal(evidence.reported, 'unverified');
    assert.equal(evidence.verification, status);
  }
});

test('failed and dropped tool reports retain their structured evidence status', () => {
  assert.equal(
    projectRunEvidence({ status: 'failed', taskOutcome: { status: 'failed', source: 'executor-tool' } }).reported,
    'failed',
  );
  const dropped = projectRunEvidence({
    status: 'completed',
    taskOutcome: { status: 'dropped', source: 'executor-tool' },
  });
  assert.equal(dropped.reported, 'reported');
  assert.equal(dropped.verification, 'unverified');
});
