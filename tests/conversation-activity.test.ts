import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conversationActivity } from '../src/ui/queue-utils.ts';
import type { Workflow } from '../src/shared/types.ts';

const flow = (conversationId: string, status: Workflow['status']) =>
  ({ conversationId, status, createdAt: new Date().toISOString() }) as Workflow;

test('sidebar dot: running beats waiting-for-you beats queued, and idle shows nothing', () => {
  assert.equal(conversationActivity([flow('a', 'running'), flow('a', 'waiting-approval')], 'a'), 'running');
  assert.equal(conversationActivity([flow('a', 'planning')], 'a'), 'running');
  assert.equal(conversationActivity([flow('a', 'queued'), flow('a', 'waiting-confirmation')], 'a'), 'attention');
  assert.equal(conversationActivity([flow('a', 'waiting-resource')], 'a'), 'queued');
  assert.equal(conversationActivity([flow('a', 'completed'), flow('a', 'failed')], 'a'), 'attention');
  assert.equal(conversationActivity([flow('b', 'running')], 'a'), undefined);
});

test('load choices need attention only while waiting for resources', () => {
  const pending = { ...flow('a', 'waiting-resource'), machineLoadChoice: 'pending' } as Workflow;
  assert.equal(conversationActivity([pending], 'a'), 'queued');
  assert.equal(conversationActivity([{ ...pending, status: 'cancelled' }], 'a'), undefined);
});

test('superseded stopped work leaves a queued conversation queued', () => {
  const stopped = { ...flow('a', 'failed'), supersededAt: new Date().toISOString() };
  assert.equal(conversationActivity([stopped, flow('a', 'queued')], 'a'), 'queued');
});
