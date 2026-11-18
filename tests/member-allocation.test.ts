import assert from 'node:assert/strict';
import { test } from 'node:test';
import { localRunLimit, memberAllowance, memberLimits } from '../src/server/member-allocation.ts';
import { quotaPoolKey, route, type RouteCapacity } from '../src/server/routing.ts';
import type { ModelInfo, RunInput, RuntimeSnapshot, Settings } from '../src/shared/types.ts';

const now = Date.parse('2026-10-10T12:00:00Z');
const hour = 3_600_000;
const GB = 1024 ** 3;

test('member allowance: more quota left takes more members, quota that resets soon a little more', () => {
  const allowance = (headroom: number, resetIn = 120 * hour) =>
    memberAllowance({ headroom, resetAt: now + resetIn, reservePercent: 10, now }).members;
  const table: Array<[number, number, number]> = [
    // headroom %, hours to reset, members
    [97, 120, 4],
    [97, 6, 5],
    [70, 120, 3],
    [50, 120, 2],
    [30, 120, 1],
    [30, 6, 2],
    [15, 120, 1],
    [15, 6, 1],
    [10, 6, 0],
    [5, 6, 0],
  ];
  for (const [headroom, hours, members] of table)
    assert.equal(allowance(headroom, hours * hour), members, `${headroom}% left, resets in ${hours} h`);
  assert.equal(allowance(97, 24 * hour), 5, 'a window ending within a day counts as soon');
  assert.equal(allowance(97, 25 * hour), 4);
  const soon = memberAllowance({ headroom: 97, resetAt: now + 2 * hour, reservePercent: 10, now });
  assert.match(soon.reason, /剩 97%，约 2 小时后重置，快重置的额度多用/);
  assert.match(memberAllowance({ headroom: 8, reservePercent: 10, now }).reason, /已到保留线/);
});

test('member allowance: unlimited, usage-priced and unknown quota, and the light-member extra', () => {
  assert.equal(memberAllowance({ unlimited: true, reservePercent: 10, now }).members, memberLimits.perAccount);
  assert.equal(memberAllowance({ usage: true, reservePercent: 10, now }).members, 4);
  assert.equal(memberAllowance({ reservePercent: 10, now }).members, 2, 'unknown quota stays cautious');
  const light = (headroom?: number, extra: Partial<Parameters<typeof memberAllowance>[0]> = {}) =>
    memberAllowance({ headroom, resetAt: now + 6 * hour, reservePercent: 10, light: true, now, ...extra }).members;
  assert.equal(light(97), memberLimits.perAccount + memberLimits.lightExtra, 'light members never exceed the cap');
  assert.equal(light(70), 6);
  assert.equal(light(25), 2, 'little left gets no light extra');
  assert.equal(light(undefined), 2, 'unknown quota gets no light extra');
  assert.equal(light(undefined, { usage: true }), 6);
});

test('member allowance: a rate-limited account takes none while cooling, then one more every ten minutes', () => {
  const recovering = (minutesAgo: number) =>
    memberAllowance({
      headroom: 97,
      resetAt: now + 6 * hour,
      reservePercent: 10,
      cooldownUntil: now - minutesAgo * 60_000,
      now,
    });
  const cooling = memberAllowance({ headroom: 97, reservePercent: 10, cooldownUntil: now + 60_000, now });
  assert.deepEqual([cooling.members, /冷却/.test(cooling.reason)], [0, true]);
  assert.deepEqual(
    [0, 9, 10, 25, 39, 40, 120].map((minutes) => recovering(minutes).members),
    [1, 1, 2, 3, 4, 5, 5],
  );
  assert.match(recovering(12).reason, /限流后恢复中，先放 2 个/);
  assert.doesNotMatch(recovering(120).reason, /恢复中/);
});

test('local run limit follows memory and cores, and stops new starts when free memory runs low', () => {
  assert.deepEqual(localRunLimit({ totalBytes: 16 * GB, availableMemoryBytes: 8 * GB, cpus: 8 }), {
    limit: 16,
    reason: 'machine',
  });
  assert.equal(
    localRunLimit({ totalBytes: 8 * GB, availableMemoryBytes: 4 * GB, cpus: 8 }).limit,
    8,
    'memory bounds it',
  );
  assert.equal(
    localRunLimit({ totalBytes: 64 * GB, availableMemoryBytes: 32 * GB, cpus: 4 }).limit,
    8,
    'cores bound it',
  );
  assert.equal(localRunLimit({ totalBytes: 256 * GB, availableMemoryBytes: 128 * GB, cpus: 64 }).limit, 32);
  assert.equal(
    localRunLimit({ totalBytes: 4 * GB, availableMemoryBytes: 3 * GB, cpus: 2 }).limit,
    2,
    'never below two',
  );
  const low = { totalBytes: 32 * GB, availableMemoryBytes: 0.5 * GB, cpus: 16 };
  assert.deepEqual(localRunLimit(low), { limit: 32, reason: 'memory' }, 'pressure preserves the fixed process cap');
  assert.equal(localRunLimit({ totalBytes: 32 * GB, availableMemoryBytes: 1.2 * GB, cpus: 16 }).reason, 'memory');
  assert.equal(localRunLimit({ totalBytes: Number.NaN, cpus: 0 }).limit, 16);
});

test('without an available-memory reading (macOS and Linux for now) only the fixed limit applies', () => {
  assert.deepEqual(localRunLimit({ totalBytes: 16 * GB, cpus: 8 }), { limit: 16, reason: 'machine' });
  assert.equal(
    localRunLimit({ totalBytes: 16 * GB, cpus: 8, availableMemoryBytes: Number.NaN }).reason,
    'machine',
    'an unreadable figure is no reading, not a low one',
  );
});

// The router applies the allowance to sub-tasks (stage 3 of docs/ROUTING-RULES-DESIGN.md).
const config: Settings = {
  refreshSeconds: 60,
  reservePercent: 10,
  maxQuotaAgeSeconds: 180,
  preferCli: true,
  designProvider: 'claude',
  architectureProvider: 'codex',
  routineProvider: 'codex',
  unknownQuotaPolicy: 'manual-only',
  defaultProjectPath: '/fixture',
  maxConcurrentRuns: 0,
};
const child: RunInput = {
  prompt: 'Review this implementation',
  projectPath: '/fixture',
  kind: 'general',
  agentChild: true,
  executionPolicy: 'cli-only',
};
const model = (id: string): ModelInfo => ({ id, label: id, efforts: ['low', 'medium', 'high'] });
const account = (
  id: string,
  provider: RuntimeSnapshot['provider'],
  used: number,
  resetIn: number,
): RuntimeSnapshot => ({
  id,
  provider,
  label: id,
  environment: 'native',
  installed: true,
  status: 'ready',
  accountFingerprint: id,
  models: [model(provider === 'claude' ? 'claude-sonnet-5' : 'gpt-6-sol')],
  refreshedAt: new Date(now).toISOString(),
  capabilities: { execute: true, resume: true, cancel: true, approvals: false },
  quota: {
    status: 'known',
    source: 'Fixture only',
    observedAt: new Date(now).toISOString(),
    windows: [{ id: 'week', label: 'Week', usedPercent: used, resetsAt: new Date(now + resetIn).toISOString() }],
  },
});
const load = (entries: Array<[RuntimeSnapshot, number]>): RouteCapacity => ({
  reservations: new Map(entries.map(([snapshot, count]) => [quotaPoolKey(snapshot), count])),
  settlingPools: new Set(),
});

test('sub-tasks spread over accounts in proportion to the quota each has left', () => {
  const settings = { ...config, routePreferencesEnabled: true };
  // 97% left resetting tonight takes 5 members; 40% left resetting next week takes 2.
  const rich = account('rich', 'codex', 3, 6 * hour);
  const poor = account('poor', 'claude', 60, 120 * hour);
  const pick = (richLoad: number, poorLoad: number) =>
    route(
      child,
      [rich, poor],
      settings,
      load([
        [rich, richLoad],
        [poor, poorLoad],
      ]),
      now,
    ).runtimeId;
  assert.equal(pick(0, 0), 'rich', 'with nothing running, the usual preference decides');
  assert.equal(pick(2, 0), 'poor');
  assert.equal(pick(2, 1), 'rich', '2 of 5 is a lighter share than 1 of 2');
  assert.equal(pick(3, 1), 'poor');
  assert.equal(pick(4, 2), 'rich', 'a full account is skipped while another has room');
  assert.throws(
    () =>
      route(
        child,
        [rich, poor],
        settings,
        load([
          [rich, 5],
          [poor, 2],
        ]),
        now,
      ),
    (error: Error & { kind?: string }) =>
      error.kind === 'capacity' && /同时最多 5 个成员[\s\S]*同时最多 2 个成员/.test(error.message),
  );
  const decision = route(
    child,
    [rich, poor],
    settings,
    load([
      [rich, 1],
      [poor, 2],
    ]),
    now,
  );
  assert.ok(
    decision.reasons.some((reason) => /成员分配：rich 剩 97%.*同时最多 5 个成员（加上这个共 2 个）/.test(reason)),
  );
});

test('a named account and the user’s per-account limit both still apply, and main tasks are not held to a share', () => {
  const poor = account('poor', 'claude', 60, 120 * hour);
  assert.throws(
    () => route({ ...child, runtimeId: 'poor' }, [poor], config, load([[poor, 2]]), now),
    /同时最多 2 个成员/,
    'a named account takes members only up to its share',
  );
  assert.equal(route({ ...child, agentChild: false }, [poor], config, load([[poor, 2]]), now).runtimeId, 'poor');
  const rich = account('rich', 'codex', 3, 6 * hour);
  assert.throws(
    () => route(child, [rich], config, { ...load([[rich, 1]]), maxRunsPerPool: 1 }, now),
    /并发容量/,
    'maxRunsPerAccount still caps every account',
  );
});

test('after a rate limit the account takes sub-tasks back gradually, and a reset-soon window gets the extra member', () => {
  const recovering = {
    ...account('recovering', 'codex', 3, 6 * hour),
    cooldownEndedAt: new Date(now - 5 * 60_000).toISOString(),
  };
  assert.equal(route(child, [recovering], config, load([[recovering, 0]]), now).runtimeId, 'recovering');
  assert.throws(() => route(child, [recovering], config, load([[recovering, 1]]), now), /限流后恢复中，先放 1 个/);
  const later = { ...recovering, cooldownEndedAt: new Date(now - 25 * 60_000).toISOString() };
  assert.equal(route(child, [later], config, load([[later, 2]]), now).runtimeId, 'recovering');
  // Same quota left: the window ending tonight takes one member more than the one ending next week.
  const tonight = account('tonight', 'codex', 60, 5 * hour);
  const nextWeek = account('next-week', 'claude', 60, 150 * hour);
  assert.equal(route(child, [tonight], config, load([[tonight, 2]]), now).runtimeId, 'tonight');
  assert.throws(() => route(child, [nextWeek], config, load([[nextWeek, 2]]), now), /同时最多 2 个成员/);
});
