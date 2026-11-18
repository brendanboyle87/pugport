import assert from 'node:assert/strict';
import test from 'node:test';
import { InstaboxMonitor } from '../src/server/instabox.ts';
import { fakeHost, fakeTree } from './helpers/fake-host.ts';

const row = { id: 'm_fixture1', name: 'Fixture', state: 'paused' };
function setup(initial = [row], advance?: (ms: number) => Promise<void>) {
  let now = 0;
  let rows = initial;
  const calls: string[][] = [];
  const monitor = new InstaboxMonitor(
    fakeHost('linux', {
      env: { PATH: '/fixture' },
      fs: fakeTree({ '/fixture/instabox': 'exec' }),
      run: async (_file, args) => {
        calls.push([...args]);
        if (args[0] === 'ls') return { stdout: JSON.stringify(rows), stderr: '' };
        if (args[0] === 'metrics')
          return {
            stdout: JSON.stringify({
              // Same shape as the real CLI output (checked read-only 10-29).
              metrics: [
                {
                  timestamp: new Date(now).toISOString(),
                  cpuUsedPct: 40,
                  cpuCount: 4,
                  memUsed: 1024,
                  memTotal: 2048,
                  diskTotal: 4096,
                },
              ],
            }),
            stderr: '',
          };
        return { stdout: '{}', stderr: '' };
      },
    }),
    () => now,
    async (ms) => {
      now += ms;
      await advance?.(ms);
    },
  );
  return {
    monitor,
    calls,
    set: (value: typeof initial) => {
      rows = value;
    },
    tick: () => {
      now += 180_000;
    },
  };
}
const status = (expected: number) => (error: unknown) => (error as { status: number }).status === expected;

test('Round 2 running cooldown is read-only', async () => {
  const f = setup([{ ...row, state: 'running', cooldownUntil: '2099-01-01T00:00:00Z' } as typeof row]);
  await f.monitor.wake(row.id);
  assert.deepEqual(f.calls, [['ls', '--json']]);
});

test('Round 2 malformed cooldown does not discard machines', async () => {
  for (const cooldownUntil of [1234567890, '2026-10-29T12:00:00']) {
    const f = setup([{ ...row, cooldownUntil } as typeof row]);
    const view = await f.monitor.view(true);
    assert.equal(view?.error, undefined);
    assert.equal(view?.machines.length, 1);
    assert.equal(view?.machines[0].cooldownUntil, undefined);
  }
});

test('Round 2 pause during readiness cancels wake promptly', async () => {
  let paused = false;
  const f = setup([{ ...row, state: 'running' }], async () => {
    if (!paused) {
      paused = true;
      await f.monitor.action({ machineId: row.id, action: 'pause' });
    }
  });
  await assert.rejects(
    f.monitor.wake(row.id, async () => false),
    status(409),
  );
  assert.equal(f.calls.filter((args) => args[0] === 'resume').length, 0);
  assert.ok(f.calls.filter((args) => args[0] === 'ls').length < 5);
});

test('Round 2 pause can interrupt a pending resume even when the CLI settles immediately', async () => {
  let pauses = 0;
  const f = setup([row], async () => {
    if (++pauses === 1) await f.monitor.action({ machineId: row.id, action: 'pause' });
  });
  await assert.rejects(f.monitor.wake(row.id), status(409));
  assert.equal(f.calls.filter((args) => args[0] === 'suspend').length, 1);
  assert.equal(f.calls.filter((args) => args[0] === 'resume').length, 1);
  assert.equal(pauses, 1);
});

test('wake joins concurrent callers, resumes once and waits for readiness', async () => {
  let ready = 0;
  const f = setup([row], async () => f.set([{ ...row, state: 'running' }]));
  await Promise.all([
    f.monitor.wake(row.id, async () => {
      ready++;
      return true;
    }),
    f.monitor.wake(row.id),
  ]);
  assert.equal(f.calls.filter((args) => args[0] === 'resume').length, 1);
  assert.equal(ready, 1);
  assert.deepEqual(
    f.calls.find((args) => args[0] === 'resume'),
    ['resume', row.id, '--no-wait'],
  );
});
test('wake running is read-only; unknown and stopped are refused', async () => {
  const f = setup([{ ...row, state: 'running' }]);
  await f.monitor.wake(row.id);
  assert.deepEqual(f.calls, [['ls', '--json']]);
  await assert.rejects(f.monitor.wake('m_missing'), status(404));
  f.set([{ ...row, state: 'stopped' }]);
  await assert.rejects(f.monitor.wake(row.id), status(409));
  assert.ok(f.calls.every((args) => args[0] === 'ls'));
});
test('cooldown survives parsing and refuses wake without writing', async () => {
  const f = setup([{ ...row, cooldownUntil: '2099-01-01T00:00:00Z' } as typeof row]);
  assert.equal((await f.monitor.view(true))?.machines[0].cooldownUntil, '2099-01-01T00:00:00Z');
  await assert.rejects(f.monitor.wake(row.id), status(409));
  assert.ok(f.calls.every((args) => args[0] === 'ls'));
});
test('pausing waits for paused; unknown state refuses writes', async () => {
  let steps = 0;
  const f = setup([{ ...row, state: 'pausing' }], async () =>
    f.set([{ ...row, state: ++steps === 1 ? 'paused' : 'running' }]),
  );
  await f.monitor.wake(row.id);
  assert.equal(f.calls.filter((args) => args[0] === 'resume').length, 1);
  f.set([{ ...row, state: 'future-state' }]);
  await assert.rejects(f.monitor.wake(row.id), status(409));
});
test('timeout releases waking entry and leaves reads unblocked', async () => {
  let readDuringWait = false;
  const f = setup([row], async () => {
    assert.equal((await f.monitor.view(false))?.machines.length, 1);
    readDuringWait = true;
  });
  await assert.rejects(f.monitor.wake(row.id), status(504));
  assert.equal(readDuringWait, true);
  assert.equal((await f.monitor.view(false))?.machines.length, 1);
  f.set([{ ...row, state: 'running' }]);
  await f.monitor.wake(row.id);
});
test('different machine wakes queue writes instead of conflicting', async () => {
  const other = { ...row, id: 'm_fixture2' };
  const f = setup([row, other], async () => {
    f.set(
      [row, other].map((machine) => ({
        ...machine,
        state: f.calls.some((args) => args[0] === 'resume' && args[1] === machine.id) ? 'running' : 'paused',
      })),
    );
  });
  await Promise.all([f.monitor.wake(row.id), f.monitor.wake(other.id)]);
  for (const id of [row.id, other.id])
    assert.equal(f.calls.filter((args) => args[0] === 'resume' && args[1] === id).length, 1);
});
test('metrics require visible refresh, running fresh state and are throttled', async () => {
  const f = setup([{ ...row, state: 'running' }]);
  await f.monitor.view(true);
  assert.equal(f.calls.filter((args) => args[0] === 'metrics').length, 0);
  const value = await f.monitor.view(true, true);
  assert.equal(value?.machines[0].live?.cpuPercent, 40);
  await f.monitor.view(true, true);
  assert.equal(f.calls.filter((args) => args[0] === 'metrics').length, 1);
  assert.deepEqual(
    f.calls.find((args) => args[0] === 'metrics'),
    ['metrics', row.id, '--since', '5m', '--json'],
  );
  for (const state of ['paused', 'starting', 'stopped']) {
    f.set([{ ...row, state }]);
    f.tick();
    assert.equal((await f.monitor.view(true, true))?.machines[0].live, undefined);
  }
  assert.equal(f.calls.filter((args) => args[0] === 'metrics').length, 1);
});
test('ssh config validates fresh identity and uses fixed argv', async () => {
  const f = setup();
  await f.monitor.sshConfig(row.id);
  assert.deepEqual(f.calls, [
    ['ls', '--json'],
    ['ssh-config', row.id, '--json'],
  ]);
  f.set([]);
  await assert.rejects(f.monitor.sshConfig(row.id), status(404));
  assert.equal(f.calls.filter((args) => args[0] === 'ssh-config').length, 1);
});

test('metrics skip stale, pending and missing machines and hide malformed samples', async () => {
  let now = 0;
  let mode = 'running';
  let metricCalls = 0;
  const monitor = new InstaboxMonitor(
    fakeHost('linux', {
      env: { PATH: '/fixture' },
      fs: fakeTree({ '/fixture/instabox': 'exec' }),
      run: (_file, args) => {
        if (args[0] === 'metrics') {
          metricCalls++;
          return { stdout: '{"metrics":[{"cpuUsedPct":0}]}', stderr: '' };
        }
        if (args[0] !== 'ls') return { stdout: '{}', stderr: '' };
        if (mode === 'stale') throw new Error('offline');
        return { stdout: JSON.stringify(mode === 'missing' ? [] : [{ ...row, state: 'running' }]), stderr: '' };
      },
    }),
    () => now,
  );
  assert.equal((await monitor.view(true, true))?.machines[0].live, undefined);
  assert.equal(metricCalls, 1);
  await monitor.action({ machineId: row.id, action: 'pause' });
  now += 180_000;
  await monitor.view(false, true);
  assert.equal(metricCalls, 1);
  for (const next of ['stale', 'missing']) {
    mode = next;
    now += 180_000;
    await monitor.view(true, true);
    assert.equal(metricCalls, 1);
  }
});

test('readiness retries inside the wake budget and failure releases the promise', async () => {
  const f = setup([{ ...row, state: 'running' }]);
  const budgets: number[] = [];
  await assert.rejects(
    f.monitor.wake(row.id, async (ms) => {
      budgets.push(ms);
      return false;
    }),
    status(504),
  );
  assert.ok(budgets.length > 1);
  assert.equal(budgets[0], 60_000);
  assert.ok(budgets.at(-1)! < budgets[0]);
  await f.monitor.wake(row.id, async () => true);
  assert.ok(f.calls.every((args) => args[0] === 'ls'));
});
test('pending pause suppresses metrics before the first metrics request', async () => {
  const f = setup([{ ...row, state: 'running' }]);
  await f.monitor.view(true);
  await f.monitor.action({ machineId: row.id, action: 'pause' });
  assert.equal((await f.monitor.view(true, true))?.machines[0].pendingAction, 'pause');
  assert.equal(f.calls.filter((args) => args[0] === 'metrics').length, 0);
});

test('old metrics do not reappear when a machine resumes after a long pause', async () => {
  const f = setup([{ ...row, state: 'running' }]);
  assert.equal((await f.monitor.view(true, true))?.machines[0].live?.cpuPercent, 40);
  f.set([{ ...row, state: 'paused' }]);
  f.tick();
  await f.monitor.view(true);
  f.tick();
  f.set([{ ...row, state: 'running' }]);
  assert.equal((await f.monitor.view(true))?.machines[0].live, undefined);
});
