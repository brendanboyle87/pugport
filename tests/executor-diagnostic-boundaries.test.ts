import assert from 'node:assert/strict';
import test from 'node:test';
import { redactError } from '../src/server/adapters/process.ts';
import { deriveTrajectory } from '../src/shared/trajectory.ts';
import type { RunRecord } from '../src/shared/types.ts';

test('permission and policy denial cannot be disguised as quota, timeout or unsupported transport', () => {
  for (const message of [
    'blocked by policy while checking quota',
    'permission denied after timeout',
    'sandbox rejected unsupported command',
    'rejected by safety policy 429',
  ])
    assert.equal(redactError(new Error(message)), 'runtime-permission-or-sandbox-error');
  assert.equal(redactError(new Error('runtime-timeout')), 'runtime-timeout');
  assert.equal(redactError(new Error('privacy-text-only')), 'privacy-text-only');
  assert.equal(redactError(new Error('quota-or-rate-limit')), 'quota-or-rate-limit');
});

test('public permission configuration appears with native provenance and full policy detail in trajectory', () => {
  const record: RunRecord = {
    id: 'permissions',
    prompt: 'Assembled prompt',
    userInput: 'User request',
    projectPath: 'C:/fixture',
    kind: 'general',
    status: 'completed',
    route: { runtimeId: 'codex', model: 'fixture', kind: 'general', reasons: [], warnings: [] },
    startedAt: '2026-10-09T10:00:00Z',
    output: '',
    events: [
      {
        at: '2026-10-09T10:00:01Z',
        type: 'status',
        text: 'Requested permissions',
        data: {
          source: 'native',
          kind: 'permission-config',
          detail: {
            provider: 'codex',
            provenance: 'requested',
            nativeMethod: 'turn/start',
            approvalPolicy: 'never',
            sandboxPolicy: { type: 'workspaceWrite', writableRoots: ['C:/fixture'], networkAccess: false },
          },
        },
      },
    ],
  };
  const row = deriveTrajectory(record).rows.find((item) => item.label.includes('权限配置'))!;
  assert.ok(row);
  assert.match(row.detail ?? '', /requested/);
  assert.match(row.detail ?? '', /writableRoots/);
  assert.match(row.detail ?? '', /C:\/fixture/);
});
