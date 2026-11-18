import assert from 'node:assert/strict';
import test from 'node:test';
import type { RunRecord } from '../src/shared/types.ts';
import { apiRuntimeBusy, noticeResolved } from '../src/ui/notice-lifecycle.ts';

const run = (status: RunRecord['status'], runtimeId = 'api-a') => ({ status, route: { runtimeId } }) as RunRecord;

test('an API edit warning remains while its account runs and clears when that account becomes idle', () => {
  const notice = { resolveWhenApiIdle: 'api-a' };
  assert.equal(noticeResolved(notice), false, 'no state is not proof of resolution');
  assert.equal(noticeResolved(notice, { runs: [run('running')] }), false);
  assert.equal(noticeResolved(notice, { runs: [run('waiting-approval')] }), false);
  assert.equal(noticeResolved(notice, { runs: [run('completed'), run('running', 'api-b')] }), true);
  assert.equal(noticeResolved(notice, { runs: [run('failed')] }), true);
  assert.equal(noticeResolved(notice, { runs: [] }), true);
  assert.equal(apiRuntimeBusy([run('queued')], 'api-a'), false, 'matches the server budget-edit guard');
});

test('unrelated errors are not dismissed by an account finishing', () => {
  assert.equal(noticeResolved({}, { runs: [] }), false);
  assert.equal(noticeResolved({ resolveWhenApiIdle: '' }, { runs: [] }), false);
});
