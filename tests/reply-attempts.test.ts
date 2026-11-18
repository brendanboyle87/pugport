import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Workflow } from '../src/shared/types.ts';
import { replyAttempts } from '../src/ui/reply-attempts.ts';

const flow = (id: string, createdAt: string, patch: Partial<Workflow> = {}): Workflow => ({
  id,
  conversationId: 'chat',
  projectId: 'project',
  userMessageId: 'asked',
  input: { content: 'draw', mode: 'auto', permissionMode: 'read-only', executionPolicy: 'cli-first' },
  status: 'completed',
  phase: 'summarize',
  plan: [],
  runIds: [],
  memoryRevision: 0,
  memoryExcerpt: '',
  createdAt,
  updatedAt: createdAt,
  ...patch,
});

test('a resend replaces the failed reply and the reply a bare 继续 gave', () => {
  const failed = flow('failed', '2026-11-05T21:52:00Z', { status: 'blocked', supersededBy: 'resent' });
  const continued = flow('continued', '2026-11-05T22:09:00Z', {
    userMessageId: 'blank-marker',
    parentWorkflowId: 'failed',
    continuation: { originalRequest: 'draw', supplements: [] },
  });
  const resent = flow('resent', '2026-11-05T22:30:00Z', { attempt: 2, status: 'running' });
  const attempts = replyAttempts([failed, continued, resent]);
  for (const id of ['failed', 'continued', 'resent']) assert.equal(attempts.get(id)?.latest.id, 'resent', id);
  assert.deepEqual(
    attempts.get('resent')!.completed.map((item) => item.id),
    ['continued'],
  );
});

test('继续 with added words keeps its own row, and a plain 继续 without a resend groups nothing', () => {
  const failed = flow('failed', '2026-11-05T21:52:00Z', { status: 'blocked' });
  const typed = flow('typed', '2026-11-05T22:09:00Z', {
    userMessageId: 'typed-message',
    parentWorkflowId: 'failed',
    continuation: { originalRequest: 'draw', supplements: ['make it blue'] },
  });
  assert.equal(replyAttempts([failed, typed]).size, 0);
  const bare = flow('bare', '2026-11-05T22:09:00Z', {
    userMessageId: 'blank-marker',
    parentWorkflowId: 'failed',
    continuation: { originalRequest: 'draw', supplements: [] },
  });
  assert.equal(replyAttempts([failed, bare]).size, 0);
});
