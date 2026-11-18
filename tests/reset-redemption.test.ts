import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { consumeCodexReset } from '../src/server/adapters/codex.ts';
import { resetCreditKey } from '../src/server/reset-credits.ts';
import type { RuntimeTarget } from '../src/shared/types.ts';
const target: RuntimeTarget = {
  id: 'fixture-codex',
  provider: 'codex',
  label: 'Fixture',
  command: 'not-used',
  environment: 'native',
  enabled: true,
};
const account = 'synthetic-account';
const fingerprint = createHash('sha256')
  .update(JSON.stringify(['codex', 'account_id', account]))
  .digest('hex');
function peer(options: { auth?: string; account?: string; status?: string; expired?: boolean; outcome?: string } = {}) {
  const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
  });
  child.stdin.on('data', (chunk) => {
    const p = JSON.parse(chunk.toString());
    if (!p.id) return;
    calls.push(p);
    let result: unknown = {};
    if (p.method === 'account/read') result = { account: { type: options.auth ?? 'chatgpt' } };
    if (p.method === 'account/rateLimits/read')
      result = {
        accountId: options.account ?? account,
        rateLimits: { primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 4102444800 } },
        rateLimitResetCredits: {
          availableCount: 1,
          credits: [
            {
              id: 'synthetic-card',
              status: options.status ?? 'available',
              resetType: 'codexRateLimits',
              expiresAt: options.expired ? 1 : 4102444800,
            },
          ],
        },
      };
    if (p.method === 'account/rateLimitResetCredit/consume') result = { outcome: options.outcome ?? 'reset' };
    queueMicrotask(() => child.stdout.write(JSON.stringify({ id: p.id, result }) + '\n'));
  });
  const deps = { spawn: async () => child, terminate: async () => {} } as unknown as NonNullable<
    Parameters<typeof consumeCodexReset>[3]
  >;
  return { calls, deps };
}
test('confirmed native redemption selects exactly the requested card with stable retry idempotency', async () => {
  const keys = [];
  for (let i = 0; i < 2; i++) {
    const p = peer();
    const result = await consumeCodexReset(
      target,
      resetCreditKey('synthetic-card'),
      fingerprint,
      p.deps,
      () => fingerprint,
    );
    assert.equal(result.outcome, 'reset');
    const calls = p.calls.filter((c) => c.method.endsWith('/consume'));
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.params?.creditId, 'synthetic-card');
    keys.push(calls[0]?.params?.idempotencyKey);
  }
  assert.equal(keys[0], keys[1]);
});
test('wrong account, API authentication, expired or unavailable cards never reach consume', async () => {
  for (const option of [{ auth: 'apiKey' }, { account: 'other' }, { expired: true }, { status: 'consumed' }]) {
    const p = peer(option);
    await assert.rejects(
      consumeCodexReset(target, resetCreditKey('synthetic-card'), fingerprint, p.deps, () => fingerprint),
    );
    assert.equal(
      p.calls.some((c) => c.method.endsWith('/consume')),
      false,
    );
  }
  const p = peer();
  await assert.rejects(
    consumeCodexReset(target, resetCreditKey('missing-card'), fingerprint, p.deps, () => fingerprint),
  );
  assert.equal(
    p.calls.some((c) => c.method.endsWith('/consume')),
    false,
  );
});
test('no eligible usage or no credits remain terminal outcomes; no card fallback', async () => {
  for (const outcome of ['noCredit', 'nothingToReset', 'alreadyRedeemed']) {
    const p = peer({ outcome });
    assert.equal(
      (await consumeCodexReset(target, resetCreditKey('synthetic-card'), fingerprint, p.deps, () => fingerprint))
        .outcome,
      outcome,
    );
    assert.equal(p.calls.filter((c) => c.method.endsWith('/consume')).length, 1);
  }
});

test('automatic authorization sees the newly read quota and can stop consume at the last moment', async () => {
  const p = peer();
  await assert.rejects(
    consumeCodexReset(
      target,
      resetCreditKey('synthetic-card'),
      fingerprint,
      p.deps,
      () => fingerprint,
      (quota) => {
        assert.equal(quota.windows[0]?.usedPercent, 100);
        assert.equal(quota.resetCredits?.details?.[0]?.status, 'available');
        throw Error('automatic setting switched off');
      },
    ),
    /switched off/,
  );
  assert.equal(p.calls.filter((call) => call.method.endsWith('/consume')).length, 0);
});
