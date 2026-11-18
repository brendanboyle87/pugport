import assert from 'node:assert/strict';
import test from 'node:test';
import { auditPermissionConfig } from '../src/server/adapters/execution-audit.ts';
import type { ExecuteContext, RunEvent } from '../src/shared/types.ts';

test('public permission audit admits only explicit fields, redacts values and leaves unknown observations absent', () => {
  const events: RunEvent[] = [];
  const ctx: ExecuteContext = {
    target: {
      id: 'fixture',
      provider: 'grok',
      label: 'Synthetic',
      command: 'never-spawned',
      environment: 'native',
      enabled: true,
    },
    input: { prompt: 'Synthetic', projectPath: process.cwd(), kind: 'general', permissionMode: 'read-only' },
    route: { runtimeId: 'fixture', model: 'fixture', kind: 'general', reasons: [], warnings: [] },
    signal: new AbortController().signal,
    approve: async () => false,
    emit: (event: RunEvent) => events.push(event),
  };
  auditPermissionConfig(ctx, 'session/info', 'observed', {
    permissionMode: 'auto',
    tools: ['Read', 'token=SECRET_TOOL'],
    headers: { Authorization: 'SECRET_HEADER' },
    token: 'SECRET_TOKEN',
    env: { API_KEY: 'SECRET_ENV' },
    prompt: 'PRIVATE_PROMPT',
    systemPrompt: 'PRIVATE_SYSTEM',
  });
  const detail = events[0]!.data!.detail as Record<string, unknown>;
  assert.equal(detail.provenance, 'observed');
  assert.equal(detail.permissionMode, 'auto');
  assert.equal(detail.approvalMode, undefined);
  assert.equal(detail.permissionsReady, undefined);
  assert.doesNotMatch(JSON.stringify(events), /SECRET_|PRIVATE_/);
  auditPermissionConfig(ctx, 'session/info', 'observed', { token: 'SECRET' });
  assert.equal(events.length, 1);
});
