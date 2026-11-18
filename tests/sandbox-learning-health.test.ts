import assert from 'node:assert/strict';
import test from 'node:test';
import { LearningHealth } from '../src/server/sandbox/learning-health.ts';

test('learning failures disable exactly once after three consecutive launches and remain provider-local', () => {
  const health = new LearningHealth();
  assert.equal(health.failure('pi', { code: 'backend_error' }), false);
  assert.equal(health.failure('claude', { code: 'sandbox-helper-timeout' }), false);
  assert.equal(health.failure('pi', { code: 'backend_error' }), false);
  assert.equal(health.failure('pi', { code: 'backend_error' }), true);
  for (let i = 0; i < 100; i++) assert.equal(health.failure('pi', { code: 'backend_error' }), false);
  assert.deepEqual(health.snapshot(), {
    pi: { consecutiveFailures: 3, autoDisabled: true, reason: '沙箱启动失败', code: 'backend_error' },
    claude: { consecutiveFailures: 1, autoDisabled: false, reason: '沙箱启动失败', code: 'sandbox-helper-timeout' },
  });
  const snapshot = health.snapshot();
  snapshot.pi!.consecutiveFailures = 0;
  assert.equal(health.snapshot().pi!.consecutiveFailures, 3);
  assert.doesNotThrow(() => JSON.stringify(health.snapshot()));
});

test('successful sandbox launch and owner mode reset start a new failure sequence', () => {
  const health = new LearningHealth();
  health.failure('grok', 'sandbox-helper-crashed');
  health.failure('grok', 'sandbox-helper-crashed');
  health.success('grok');
  assert.deepEqual(health.snapshot(), {});
  assert.equal(health.failure('grok', 'sandbox-helper-crashed'), false);
  assert.equal(health.snapshot().grok!.consecutiveFailures, 1);
  health.failure('grok', 'sandbox-helper-crashed');
  assert.equal(health.failure('grok', 'sandbox-helper-crashed'), true);
  health.reset('grok');
  assert.deepEqual(health.snapshot(), {});
  assert.equal(health.failure('grok', 'sandbox-helper-crashed'), false);
});

test('only fixed reasons, allowlisted codes and exact HRESULT reach health snapshots', () => {
  const health = new LearningHealth();
  const privateText = 'fixture prompt TOKEN=fixture-secret C:\\private\\fixture.log';
  health.failure('pi', { code: privateText, message: privateText, nativeCode: privateText });
  health.failure('claude', { code: 'backend_error', nativeCode: '0x80070005', message: privateText });
  health.failure('grok', privateText);
  health.failure('cursor', { code: 'EPERM', message: privateText });
  assert.equal(health.snapshot().pi!.code, undefined);
  assert.equal(health.snapshot().claude!.code, '0x80070005');
  assert.equal(health.snapshot().grok!.code, undefined);
  assert.equal(health.snapshot().cursor!.code, 'EPERM');
  assert.ok(!JSON.stringify(health.snapshot()).includes(privateText));
});

test('saved disable notes restore with bounded counts and safe codes only', () => {
  const health = new LearningHealth({
    pi: { consecutiveFailures: 3, reason: 'untrusted saved text', code: '0xC0000005' },
    claude: { consecutiveFailures: 2, code: 'backend_error' },
    grok: { consecutiveFailures: 999, code: 'unsafe' },
  });
  assert.equal(health.snapshot().pi?.autoDisabled, true);
  assert.equal(health.snapshot().pi?.code, '0xC0000005');
  assert.equal(health.snapshot().grok, undefined);
  assert.ok(!JSON.stringify(health.snapshot()).includes('untrusted saved text'));
  assert.equal(health.failure('claude', 'backend_error'), true);
});
