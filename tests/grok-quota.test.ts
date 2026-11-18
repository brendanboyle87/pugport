import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { RuntimeTarget } from '../src/shared/types.js';
import { grokBillingQuota, readGrokQuota } from '../src/server/grok-quota.ts';

const at = '2026-09-27T00:00:00.000Z';
const period = {
  type: 'USAGE_PERIOD_TYPE_WEEKLY',
  start: '2026-09-21T02:17:59.504+00:00',
  end: '2026-09-28T02:17:59.504+00:00',
};
const target: RuntimeTarget = {
  id: 'grok-fixture',
  provider: 'grok',
  label: 'Grok fixture',
  command: 'unused',
  enabled: true,
  environment: 'native',
};
function peer(respond: (packet: Record<string, unknown>) => unknown) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
  }) as unknown as ChildProcessWithoutNullStreams;
  const requests: Record<string, unknown>[] = [];
  child.stdin.on('data', (bytes: Buffer) => {
    for (const line of bytes.toString('utf8').trim().split('\n')) {
      const packet = JSON.parse(line) as Record<string, unknown>;
      requests.push(packet);
      const response = respond(packet);
      if (response !== undefined)
        queueMicrotask(() => (child.stdout as PassThrough).write(JSON.stringify(response) + '\n'));
    }
  });
  return { child, requests };
}

test('billing preserves actual subscription percentage and cycle, omitting paid balances and identities', () => {
  const quota = grokBillingQuota(
    {
      config: {
        creditUsagePercent: 42.5,
        currentPeriod: period,
        onDemandCap: { val: 2000 },
        onDemandUsed: { val: 500 },
        prepaidBalance: { val: 1000 },
      },
      email: 'private@example.invalid',
    },
    at,
  );
  assert.equal(quota.status, 'known');
  assert.equal(quota.observedAt, at);
  assert.deepEqual(quota.grokBilling, { isUnifiedBillingUser: null, percentSource: 'cli-reported' });
  assert.deepEqual(quota.windows, [
    {
      id: 'included',
      label: '每周额度',
      usedPercent: 42.5,
      resetsAt: '2026-09-28T02:17:59.504Z',
      durationMinutes: 10080,
    },
  ]);
  assert.ok(!JSON.stringify(quota).includes('private'));
  assert.equal(quota.windows.length, 1, 'on-demand spending must not block an included subscription allowance');
});

test('missing, null and malformed billing percentages never become 100 percent remaining', () => {
  for (const value of [undefined, null, '0', -1, 100.01, 150, Number.NaN, Number.POSITIVE_INFINITY]) {
    const quota = grokBillingQuota(
      { config: { creditUsagePercent: value, currentPeriod: period, onDemandCap: { val: 100 } } },
      at,
    );
    assert.equal(quota.status, 'unknown');
    assert.equal(quota.windows[0]?.usedPercent, null);
    assert.match(quota.note!, /未知/);
  }
  assert.equal(grokBillingQuota({ config: { creditUsagePercent: 0 } }, at).windows[0]!.usedPercent, 0);
  assert.equal(grokBillingQuota({ config: { creditUsagePercent: 100 } }, at).windows[0]!.usedPercent, 100);
  assert.equal(grokBillingQuota({ config: null }, at).status, 'unknown');
});

test('legacy billing needs both explicit values and reset absence stays unknown independently', () => {
  assert.equal(
    grokBillingQuota({ config: { monthlyLimit: { val: 1000 }, used: { val: 250 } } }, at).windows[0]!.usedPercent,
    25,
  );
  for (const config of [
    { monthlyLimit: { val: 1000 }, used: {} },
    { monthlyLimit: { val: 0 }, used: { val: 0 } },
    { creditUsagePercent: null, monthlyLimit: { val: 1000 }, used: { val: 0 } },
    { monthlyLimit: { val: 100 }, used: { val: 101 } },
  ])
    assert.equal(grokBillingQuota({ config }, at).status, 'unknown');
  const quota = grokBillingQuota(
    { config: { creditUsagePercent: 5, currentPeriod: { type: 'USAGE_PERIOD_TYPE_MONTHLY', end: 'invalid' } } },
    at,
  );
  assert.equal(quota.status, 'known');
  assert.equal(quota.windows[0]!.resetsAt, null);
  assert.equal(quota.windows[0]!.durationMinutes, undefined, 'a month is not fabricated as thirty days');
  assert.equal(
    grokBillingQuota({ config: { monthlyLimit: { val: 100 }, used: { val: 25 } } }, at).grokBilling?.percentSource,
    'legacy-calculated',
  );
});

test('Grok billing keeps unified mode tri-state and explicit zero distinct from missing or malformed percentages', () => {
  for (const [raw, expected] of [
    [true, true],
    [false, false],
    [undefined, null],
    [null, null],
    ['true', null],
  ] as const) {
    const quota = grokBillingQuota({ config: { isUnifiedBillingUser: raw, currentPeriod: period } }, at);
    assert.deepEqual(quota.grokBilling, { isUnifiedBillingUser: expected, percentSource: 'unknown' });
    assert.equal(quota.status, 'unknown');
    assert.equal(quota.windows[0]?.usedPercent, null);
  }
  assert.deepEqual(
    grokBillingQuota({ config: { isUnifiedBillingUser: true, creditUsagePercent: 0 } }, at).grokBilling,
    { isUnifiedBillingUser: true, percentSource: 'cli-reported' },
  );
  assert.equal(grokBillingQuota({ config: { creditUsagePercent: 150 } }, at).grokBilling?.percentSource, 'unknown');
});

test('ACP quota probe uses the exact target, only initialize and billing, and stops its owned child', async () => {
  const { child, requests } = peer((packet) => ({
    jsonrpc: '2.0',
    id: packet.id,
    result:
      packet.method === 'initialize'
        ? { protocolVersion: 1 }
        : { config: { creditUsagePercent: 11, currentPeriod: period } },
  }));
  let terminated = 0;
  const quota = await readGrokQuota(target, {
    spawn: async (runtime, args) => {
      assert.equal(runtime, target);
      assert.deepEqual(args, ['agent', 'stdio']);
      return child;
    },
    terminate: async (process) => {
      assert.equal(process, child);
      terminated++;
    },
    now: () => at,
  });
  assert.equal(quota.windows[0]!.usedPercent, 11);
  assert.deepEqual(
    requests.map((row) => row.method),
    ['initialize', '_x.ai/billing'],
  );
  assert.equal(terminated, 1);
});

test('independent native targets retain independent billing responses', async () => {
  const one = { ...target, id: 'grok-one', accountHome: 'fixture-one' },
    two = { ...target, id: 'grok-two', accountHome: 'fixture-two' };
  const spawn = async (runtime: RuntimeTarget) =>
    peer((packet) => ({
      jsonrpc: '2.0',
      id: packet.id,
      result:
        packet.method === 'initialize'
          ? { protocolVersion: 1 }
          : { config: { creditUsagePercent: runtime === one ? 55 : 3 } },
    })).child;
  const results = await Promise.all(
    [one, two].map((runtime) => readGrokQuota(runtime, { spawn, terminate: async () => {}, now: () => at })),
  );
  assert.deepEqual(
    results.map((quota) => quota.windows[0]!.usedPercent),
    [55, 3],
  );
});

test('unsupported billing, auth failure and timeout stay explicit without raw diagnostics', async () => {
  for (const failure of [
    { code: -32601, message: 'secret@example.invalid token=secret' },
    { code: -32000, message: 'Authentication required secret@example.invalid' },
  ]) {
    const { child } = peer((packet) => ({ jsonrpc: '2.0', id: packet.id, error: failure }));
    const quota = await readGrokQuota(target, { spawn: async () => child, terminate: async () => {} });
    assert.equal(quota.status, failure.code === -32601 ? 'unknown' : 'error');
    assert.equal(quota.windows.length, 0);
    assert.equal(quota.observedAt, null);
    assert.ok(!JSON.stringify(quota).includes('secret'));
  }
  const { child } = peer(() => undefined);
  let terminated = false;
  const quota = await readGrokQuota(target, {
    spawn: async () => child,
    terminate: async () => {
      terminated = true;
    },
    timeoutMs: 10,
  });
  assert.equal(quota.status, 'error');
  assert.match(quota.note!, /超时/);
  assert.equal(terminated, true);
});

test('malformed or oversized ACP output is bounded, redacted and terminates the probe', async () => {
  for (const output of ['not-json private@example.invalid\n', 'x'.repeat(1024 * 1024 + 1)]) {
    const { child } = peer(() => undefined);
    child.stdin.once('data', () => queueMicrotask(() => (child.stdout as PassThrough).write(output)));
    let terminated = false;
    const quota = await readGrokQuota(target, {
      spawn: async () => child,
      terminate: async () => {
        terminated = true;
      },
    });
    assert.equal(quota.status, 'unknown');
    assert.equal(quota.windows.length, 0);
    assert.ok(!JSON.stringify(quota).includes('private'));
    assert.equal(terminated, true);
  }
});

test('quota probe rejects server tool/permission requests without starting a session', async () => {
  const { child, requests } = peer((packet) => {
    if (packet.method === 'initialize') return { jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } };
    if (packet.method === '_x.ai/billing')
      return { jsonrpc: '2.0', id: 'server-1', method: 'session/request_permission', params: { toolCall: {} } };
    if (packet.id === 'server-1') return { jsonrpc: '2.0', id: 2, result: { config: { creditUsagePercent: 7 } } };
  });
  const quota = await readGrokQuota(target, { spawn: async () => child, terminate: async () => {} });
  assert.equal(quota.status, 'known');
  assert.deepEqual(requests[2]!.error, { code: -32601, message: 'Unsupported by quota probe.' });
});

test('only an account-bound missing percentage can use a same-period billing supplement; failure retains ACP reset', async () => {
  let value: number | undefined,
    identity = 'fixture-identity',
    throwSupplement = false,
    calls = 0;
  const spawn = async () =>
    peer((packet) => ({
      jsonrpc: '2.0',
      id: packet.id,
      result:
        packet.method === 'initialize'
          ? { protocolVersion: 1 }
          : {
              config: {
                ...(value === undefined ? {} : { creditUsagePercent: value }),
                currentPeriod: period,
                isUnifiedBillingUser: true,
              },
            },
    })).child;
  const supplement = async (runtime: RuntimeTarget, fingerprint: string, observed: typeof period) => {
    calls++;
    assert.equal(runtime, target);
    assert.equal(fingerprint, 'fixture-identity');
    assert.deepEqual(observed, period);
    if (throwSupplement) throw new Error('private diagnostic');
    return { usedPercent: 0, implicitZero: true };
  };
  const deps = { spawn, terminate: async () => {}, identity: () => identity || undefined, supplement, now: () => at };
  const known = await readGrokQuota(target, deps);
  assert.equal(known.status, 'known');
  assert.equal(known.windows[0]!.usedPercent, 0);
  assert.deepEqual(known.grokBilling, { isUnifiedBillingUser: true, percentSource: 'implicit-zero' });
  assert.match(known.note!, /推算.*并非供应商明确报告/);
  assert.equal(calls, 1);
  throwSupplement = true;
  const failed = await readGrokQuota(target, deps);
  assert.equal(failed.status, 'unknown');
  assert.deepEqual(failed.grokBilling, { isUnifiedBillingUser: true, percentSource: 'unknown' });
  assert.equal(failed.windows[0]!.resetsAt, '2026-09-28T02:17:59.504Z');
  assert.equal(calls, 2);
  assert.ok(!JSON.stringify(failed).includes('private'));
  value = 3;
  assert.equal((await readGrokQuota(target, deps)).grokBilling?.percentSource, 'cli-reported');
  assert.equal(calls, 2, 'published ACP percentage makes no extra HTTP request');
  value = undefined;
  identity = '';
  await readGrokQuota(target, deps);
  assert.equal(calls, 2, 'unknown account cannot borrow default credentials');
});

test('wire-published web supplementation retains unified mode and labels its percentage as reported', async () => {
  const { child } = peer((packet) => ({
    jsonrpc: '2.0',
    id: packet.id,
    result:
      packet.method === 'initialize'
        ? { protocolVersion: 1 }
        : { config: { currentPeriod: period, isUnifiedBillingUser: false } },
  }));
  const quota = await readGrokQuota(target, {
    spawn: async () => child,
    terminate: async () => {},
    identity: () => 'same-synthetic',
    supplement: async () => ({ usedPercent: 12.5, implicitZero: false }),
    now: () => at,
  });
  assert.deepEqual(quota.grokBilling, { isUnifiedBillingUser: false, percentSource: 'web-reported' });
  assert.equal(quota.windows[0]!.usedPercent, 12.5);
  assert.equal(quota.note, undefined);
});

test('extra usage credits come from the CLI billing reply; auto top-up is one bound read-only lookup', async () => {
  assert.deepEqual(
    grokBillingQuota({ config: { creditUsagePercent: 18, currentPeriod: period, prepaidBalance: { val: 1250 } } }, at)
      .grokCredits,
    { extraUsd: 12.5, autoTopup: null },
  );
  // proto3 drops a zero value: an empty balance message is $0.00, a missing one is not reported at all.
  assert.deepEqual(grokBillingQuota({ config: { currentPeriod: period, prepaidBalance: {} } }, at).grokCredits, {
    extraUsd: 0,
    autoTopup: null,
  });
  assert.equal(
    grokBillingQuota({ config: { creditUsagePercent: 1, currentPeriod: period } }, at).grokCredits,
    undefined,
  );

  let identity = 'fixture-identity',
    calls = 0,
    answer: boolean | undefined = false;
  const spawn = async () =>
    peer((packet) => ({
      jsonrpc: '2.0',
      id: packet.id,
      result:
        packet.method === 'initialize'
          ? { protocolVersion: 1 }
          : { config: { creditUsagePercent: 18, currentPeriod: period, prepaidBalance: { val: 0 } } },
    })).child;
  const autoTopup = async (runtime: RuntimeTarget, fingerprint: string) => {
    calls++;
    assert.equal(runtime, target);
    assert.equal(fingerprint, 'fixture-identity');
    return answer;
  };
  const deps = { spawn, terminate: async () => {}, identity: () => identity || undefined, autoTopup, now: () => at };
  assert.deepEqual((await readGrokQuota(target, deps)).grokCredits, { extraUsd: 0, autoTopup: false });
  answer = true;
  assert.deepEqual((await readGrokQuota(target, deps)).grokCredits, { extraUsd: 0, autoTopup: true });
  answer = undefined;
  assert.deepEqual((await readGrokQuota(target, deps)).grokCredits, { extraUsd: 0, autoTopup: null });
  identity = '';
  assert.deepEqual((await readGrokQuota(target, deps)).grokCredits, { extraUsd: 0, autoTopup: null });
  assert.equal(calls, 3, 'an unbound account never borrows a credential for the lookup');
});
