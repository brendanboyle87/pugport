import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codexFailure } from '../src/server/adapters/codex.ts';
import type { ExecuteContext, RunEvent } from '../src/shared/types.ts';
import { syntheticCodex } from './helpers/codex-rpc.ts';

const error = (codexErrorInfo: unknown) => ({ message: 'Provider diagnostic token=must-not-leak', codexErrorInfo });
function context() {
  const events: RunEvent[] = [];
  const ctx: ExecuteContext = {
    target: {
      id: 'codex-fixture',
      provider: 'codex',
      label: 'Synthetic Codex',
      command: 'never-spawned',
      environment: 'native',
      enabled: true,
    },
    input: { prompt: 'Synthetic request', projectPath: process.cwd(), kind: 'general', permissionMode: 'read-only' },
    route: {
      runtimeId: 'codex-fixture',
      model: 'gpt-fixture',
      effort: 'low',
      kind: 'general',
      reasons: [],
      warnings: [],
    },
    signal: new AbortController().signal,
    emit: (event) => events.push(event),
    approve: async () => false,
  };
  return { ctx, events };
}

test('Codex typed usage/429 and unauthorized/401 errors have exact safe account-health classifications', () => {
  assert.equal(codexFailure(error('usageLimitExceeded')), 'quota-or-rate-limit');
  assert.equal(codexFailure(error('rateLimitExceeded')), 'quota-or-rate-limit');
  assert.equal(codexFailure(error('unauthorized')), 'authentication-required');
  for (const kind of [
    'httpConnectionFailed',
    'responseStreamConnectionFailed',
    'responseStreamDisconnected',
    'responseTooManyFailedAttempts',
  ]) {
    assert.equal(codexFailure(error({ [kind]: { httpStatusCode: 429 } })), 'quota-or-rate-limit');
    assert.equal(codexFailure(error({ [kind]: { httpStatusCode: 401 } })), 'authentication-required');
    for (const status of [400, 402, 403, 408, 500, 503])
      assert.equal(codexFailure(error({ [kind]: { httpStatusCode: status } })), 'runtime-request-failed');
    assert.equal(codexFailure(error({ [kind]: { httpStatusCode: null } })), 'runtime-network-error');
  }
});

test('typed context limits, policy blocks, overload and ordinary messages cannot trigger account rotation', () => {
  for (const kind of [
    'contextWindowExceeded',
    'sessionBudgetExceeded',
    'serverOverloaded',
    'internalServerError',
    'cyberPolicy',
    'misalignmentPolicyViolation',
    'badRequest',
    'other',
    'futureUnknownVariant',
  ]) {
    assert.equal(
      codexFailure({ message: 'Quota exceeded Unauthorized 429', codexErrorInfo: kind }),
      'runtime-request-failed',
    );
  }
  assert.equal(codexFailure(error('sandboxError')), 'runtime-permission-or-sandbox-error');
  for (const message of [
    'Request 429 could not be processed',
    'Quota configuration is invalid',
    'Something went wrong',
  ])
    assert.equal(codexFailure({ message }), 'runtime-request-failed');
  assert.equal(codexFailure({ message: 'Rate limit exceeded' }), 'quota-or-rate-limit');
  assert.equal(codexFailure({ message: 'Authentication required token=hidden' }), 'authentication-required');
  assert.equal(codexFailure({ code: -32601, message: 'Quota exceeded' }), 'runtime-protocol-incompatible');
});

test('failed turn and terminal error notification classify structured details without leaking diagnostics or assistant output', async () => {
  for (const notificationOnly of [false, true]) {
    const { ctx, events } = context();
    await assert.rejects(syntheticCodex({ failure: error('usageLimitExceeded'), notificationOnly }).execute(ctx), {
      message: 'quota-or-rate-limit',
    });
    assert.equal(events.filter((event) => event.type === 'text').length, 0);
    assert.ok(events.some((event) => event.type === 'error' && event.text === 'quota-or-rate-limit'));
    assert.ok(!JSON.stringify(events).includes('must-not-leak'));
  }
});

test('request failures use structured JSON-RPC data before the human message', async () => {
  const { ctx, events } = context();
  await assert.rejects(
    syntheticCodex({
      requestFailure: {
        code: -32000,
        message: 'Provider diagnostic token=must-not-leak',
        data: { codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 401 } } },
      },
    }).execute(ctx),
    { message: 'authentication-required' },
  );
  assert.equal(events.filter((event) => event.type === 'text').length, 0);
  assert.ok(!JSON.stringify(events).includes('must-not-leak'));
  assert.ok(!JSON.stringify(events).includes('Provider diagnostic'));
});

test('a retryable Codex notification does not end a turn which later succeeds', async () => {
  const { ctx } = context();
  const result = await syntheticCodex({
    transientFailure: error({ responseStreamDisconnected: { httpStatusCode: 429 } }),
  }).execute(ctx);
  assert.equal(result.output, 'Synthetic Codex response');
});

test('a failed Codex file change keeps the redacted native error from its output', async () => {
  const { ctx, events } = context();
  await syntheticCodex({
    prefix: [
      {
        method: 'item/fileChange/outputDelta',
        params: { itemId: 'write', delta: 'EPERM: operation not permitted token=secret https://github.com/o/r' },
      },
      {
        method: 'item/completed',
        params: { item: { id: 'write', type: 'fileChange', status: 'failed', changes: [{ path: 'a.txt' }] } },
      },
    ],
  }).execute(ctx);
  const failed = events.find(
    (event) => event.type === 'tool' && event.data?.itemId === 'write' && event.data?.status === 'failed',
  );
  assert.match(String(failed?.data?.output), /EPERM/);
  assert.doesNotMatch(String(failed?.data?.output), /secret/);
  assert.match(String(failed?.data?.output), /\[redacted URL\]/);
});
