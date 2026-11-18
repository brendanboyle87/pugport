import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Controller } from '../src/server/controller.ts';
import { claudeAdapter } from '../src/server/adapters/claude.ts';
import { quotaLines, quotaTotals } from '../src/shared/quota-summary.ts';
import type { RuntimeSnapshot } from '../src/shared/types.ts';

const ready = (observedAt: string): RuntimeSnapshot => ({
  id: 'fixture-claude',
  provider: 'claude',
  label: 'Fixture Claude',
  environment: 'native',
  installed: true,
  status: 'ready',
  models: [{ id: 'fixture-model', label: 'Fixture model', efforts: ['low'] }],
  quota: {
    status: 'known',
    source: 'Fixture subscription',
    observedAt,
    windows: [{ id: 'week', label: 'week', usedPercent: 40, resetsAt: '2026-10-17T00:00:00Z' }],
  },
  capabilities: { execute: true, resume: true, cancel: true, approvals: true },
  refreshedAt: observedAt,
});
// What an adapter reports when its check does not finish: no identity, no quota.
const timedOut = (): RuntimeSnapshot => ({
  id: 'fixture-claude',
  provider: 'claude',
  label: 'Fixture Claude',
  environment: 'native',
  installed: false,
  status: 'error',
  models: [],
  note: 'runtime-timeout',
  quota: { status: 'unknown', source: 'fixture', observedAt: null, windows: [] },
  capabilities: { execute: false, resume: false, cancel: false, approvals: false },
  refreshedAt: '2026-10-10T12:10:00Z',
});

function fixture(t: TestContext, now: string) {
  const directory = mkdtempSync(join(tmpdir(), 'pugport-discovery-misses-'));
  const controller = new Controller(directory, join(directory, 'data'), { now: () => Date.parse(now) });
  t.after(async () => {
    await controller.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  clearInterval(controller.timer);
  controller.targets = [
    {
      id: 'fixture-claude',
      provider: 'claude',
      label: 'Fixture Claude',
      command: 'never-spawned',
      environment: 'native',
      enabled: true,
    },
  ];
  const current = () => controller.snapshots.find((snapshot) => snapshot.id === 'fixture-claude')!;
  return { controller, current };
}

test('a timed-out check keeps showing the last reading, dated, while the error still blocks routing', async (t) => {
  const f = fixture(t, '2026-10-10T12:10:00Z');
  const replies = [ready('2026-10-10T12:00:00Z'), timedOut()];
  t.mock.method(claudeAdapter, 'discover', async () => replies.shift()!);
  await f.controller.refresh();
  await f.controller.refresh();
  const snapshot = f.current();
  assert.equal(snapshot.status, 'error', 'the failure is not concealed');
  assert.equal(snapshot.capabilities.execute, false);
  assert.equal(snapshot.quota.status, 'unknown', 'routing never sees the old reading as live');
  assert.equal(snapshot.lastKnownQuota?.windows[0]?.usedPercent, 40);
  assert.match(snapshot.lastKnownQuota!.note!, /刚才检查超时，显示的是上次的读数/);

  const [line] = quotaLines(f.controller.snapshots, f.controller.targets);
  assert.equal(line!.reference, true);
  assert.equal(line!.observedAt, '2026-10-10T12:00:00Z', 'the tray shows how old the reading is');
  assert.deepEqual(line!.windows, [{ name: 'week', remaining: 60, resetsAt: '2026-10-17T00:00:00Z' }]);
  assert.equal(quotaTotals([line!])[0]!.stale, true, 'a total that includes an old reading is marked');
});

test('no reference when the last reading is too old or the account never worked', async (t) => {
  const old = fixture(t, '2026-10-10T19:00:00Z');
  const replies = [ready('2026-10-10T12:00:00Z'), timedOut()];
  t.mock.method(claudeAdapter, 'discover', async () => replies.shift()!);
  await old.controller.refresh();
  await old.controller.refresh();
  assert.equal(old.current().lastKnownQuota, undefined, 'seven hours old is too old to show');

  const never = fixture(t, '2026-10-10T12:10:00Z');
  t.mock.method(claudeAdapter, 'discover', async () => timedOut());
  await never.controller.refresh();
  assert.equal(never.current().status, 'error');
  assert.equal(never.current().lastKnownQuota, undefined);
});
