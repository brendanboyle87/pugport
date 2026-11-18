import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createCodexAdapter, parseCodexQuota } from '../src/server/adapters/codex.ts';
import { mergeCodexQuotaUpdate } from '../src/server/codex-quota-update.ts';
import type { RunEvent, RuntimeSnapshot, RuntimeTarget } from '../src/shared/types.ts';

const full = () =>
  parseCodexQuota({
    rateLimitsByLimitId: {
      codex: {
        limitName: 'Included usage',
        primary: { usedPercent: 21, resetsAt: 2_000_000_000, windowDurationMins: 300 },
        secondary: { usedPercent: 47, resetsAt: 2_000_100_000, windowDurationMins: 10080 },
      },
      reserve: { primary: { usedPercent: 6, resetsAt: 2_000_200_000, windowDurationMins: 10080 } },
    },
  });

test('a sparse single-bucket notification preserves all other buckets and the unreported secondary window', () => {
  const previous = full();
  previous.observedAt = '2026-10-06T00:00:00Z';
  const original = structuredClone(previous);
  const update = parseCodexQuota({ rateLimits: { limitId: 'codex', primary: { usedPercent: 22 } } });
  update.observedAt = '2026-10-06T00:10:00Z';
  const merged = mergeCodexQuotaUpdate(previous, update);
  assert.deepEqual(
    merged.windows.map((window) => [window.id, window.usedPercent]),
    [
      ['codex:primary', 22],
      ['codex:secondary', 47],
      ['reserve:primary', 6],
    ],
  );
  assert.equal(merged.windows[0]?.resetsAt, previous.windows[0]?.resetsAt);
  assert.equal(merged.windows[0]?.durationMinutes, 300);
  assert.equal(merged.windows[0]?.label, 'Included usage · 300 min');
  assert.equal(merged.observedAt, update.observedAt, 'global ordering follows the latest observation');
  assert.equal(merged.windows[0]?.observedAt, update.observedAt);
  assert.equal(merged.windows[1]?.observedAt, previous.observedAt, 'one live window cannot refresh another window');
  assert.equal(merged.windows[2]?.observedAt, previous.observedAt);
  assert.deepEqual(previous, original, 'merging never mutates the retained snapshot');
  const later = { ...update, observedAt: '2026-10-06T00:20:00Z' };
  const again = mergeCodexQuotaUpdate(merged, later);
  assert.equal(again.windows[0]?.observedAt, later.observedAt);
  assert.equal(again.windows[1]?.observedAt, previous.observedAt, 'repeated live updates preserve each old window age');
});

test('null rolling metadata preserves percentages, plan and reset-credit detail; explicit zero is accepted', () => {
  const previous: RuntimeSnapshot['quota'] = {
    ...full(),
    subscription: { label: 'Pro', source: 'fixture', observedAt: '2026-10-06T00:00:00Z' },
    resetCredits: { availableCount: 2, details: [], source: 'fixture', observedAt: '2026-10-06T00:00:00Z' },
  };
  const update = parseCodexQuota({
    rateLimits: { limitId: 'codex', primary: { usedPercent: null }, secondary: { usedPercent: 0 } },
  });
  previous.observedAt = '2026-10-06T00:00:00Z';
  update.observedAt = '2026-10-06T00:10:00Z';
  const merged = mergeCodexQuotaUpdate(previous, update);
  assert.equal(merged.windows[0]?.usedPercent, 21);
  assert.equal(merged.windows[0]?.observedAt, previous.observedAt, 'missing percentage cannot extend its freshness');
  assert.equal(merged.windows[1]?.usedPercent, 0);
  assert.equal(merged.subscription?.label, 'Pro');
  assert.equal(merged.resetCredits?.availableCount, 2);
  assert.deepEqual(merged.resetCredits?.details, []);
});

test('a new bucket is added, but full reads still describe a replacement snapshot', () => {
  const replacement = parseCodexQuota({ rateLimitsByLimitId: { changed: { primary: { usedPercent: 3 } } } });
  assert.deepEqual(
    replacement.windows.map((window) => window.id),
    ['changed:primary'],
  );
  const sparse = mergeCodexQuotaUpdate(full(), replacement);
  assert.deepEqual(
    sparse.windows.map((window) => window.id),
    ['codex:primary', 'codex:secondary', 'reserve:primary', 'changed:primary'],
  );
});

test('null-only reset-card metadata cannot refresh old cards or invent an observation', () => {
  const previous: RuntimeSnapshot['quota'] = {
    ...full(),
    resetCredits: {
      availableCount: 2,
      details: [{ kind: 'full', status: 'available', grantedAt: null, expiresAt: '2026-10-20T00:00:00Z' }],
      source: 'full read',
      observedAt: '2026-10-06T00:00:00Z',
    },
  };
  const update: RuntimeSnapshot['quota'] = {
    ...parseCodexQuota({ rateLimits: { primary: { usedPercent: 22 } } }),
    resetCredits: { availableCount: null, details: null, source: 'sparse update', observedAt: '2026-10-06T00:10:00Z' },
  };
  const merged = mergeCodexQuotaUpdate(previous, update);
  assert.deepEqual(
    merged.resetCredits,
    previous.resetCredits,
    'unknown metadata preserves the original source and time',
  );
  assert.equal(mergeCodexQuotaUpdate(full(), update).resetCredits, undefined);
});

test('partial reset-card observations do not borrow old data under the new timestamp; zero and empty detail are real', () => {
  const previous: RuntimeSnapshot['quota'] = {
    ...full(),
    resetCredits: { availableCount: 2, details: [], source: 'full read', observedAt: '2026-10-06T00:00:00Z' },
  };
  for (const fields of [
    { availableCount: 0, details: null },
    { availableCount: 1, details: null },
    { availableCount: null, details: [] },
    { availableCount: 0, details: [] },
  ]) {
    const credits = { ...fields, source: 'sparse update', observedAt: '2026-10-06T00:10:00Z' };
    const update = { ...parseCodexQuota({ rateLimits: { primary: { usedPercent: 22 } } }), resetCredits: credits };
    assert.deepEqual(mergeCodexQuotaUpdate(previous, update).resetCredits, credits);
  }
});

test('an explicit new cycle with an unreported percentage does not reuse the previous cycle percentage', () => {
  const previous = parseCodexQuota({ rateLimits: { primary: { usedPercent: 21, resetsAt: 2_000_000_000 } } });
  const update = parseCodexQuota({ rateLimits: { primary: { usedPercent: null, resetsAt: 2_000_100_000 } } });
  const merged = mergeCodexQuotaUpdate(previous, update);
  assert.equal(merged.windows[0]?.usedPercent, null);
  assert.equal(merged.status, 'unknown');
  assert.equal(merged.windows[0]?.resetsAt, update.windows[0]?.resetsAt);
});

test('a changed window duration keeps the named bucket but updates its time label', () => {
  const merged = mergeCodexQuotaUpdate(
    full(),
    parseCodexQuota({ rateLimits: { primary: { usedPercent: 23, windowDurationMins: 1440 } } }),
  );
  assert.equal(merged.windows[0]?.durationMinutes, 1440);
  assert.equal(merged.windows[0]?.label, 'Included usage · 1440 min');
});

test('the native adapter identifies rolling quota notifications separately from full reads', async () => {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: 999999,
    exitCode: null as number | null,
    signalCode: null,
  });
  const send = (packet: unknown) => child.stdout.write(`${JSON.stringify(packet)}\n`);
  let buffer = '';
  child.stdin.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    let split: number;
    while ((split = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, split);
      buffer = buffer.slice(split + 1);
      if (!line) continue;
      const packet = JSON.parse(line);
      if (packet.method === 'initialize') send({ id: packet.id, result: {} });
      if (packet.method === 'thread/start') send({ id: packet.id, result: { thread: { id: 'fixture-thread' } } });
      if (packet.method === 'turn/start') {
        send({ id: packet.id, result: { turn: { id: 'fixture-turn' } } });
        send({
          method: 'account/rateLimits/updated',
          params: { rateLimits: { limitId: 'codex', primary: { usedPercent: 23 } } },
        });
        send({
          method: 'turn/completed',
          params: { threadId: 'fixture-thread', turn: { id: 'fixture-turn', status: 'completed' } },
        });
      }
    }
  });
  const target: RuntimeTarget = {
    id: 'fixture-codex',
    provider: 'codex',
    label: 'Fixture',
    command: 'fixture',
    environment: 'native',
    enabled: true,
  };
  const events: RunEvent[] = [];
  const adapter = createCodexAdapter({
    spawn: async () => child as unknown as ChildProcessWithoutNullStreams,
    terminate: async () => {},
    targetPath: async (_target, path) => path,
  });
  await adapter.execute({
    target,
    input: { prompt: 'fixture', projectPath: process.cwd(), kind: 'general', permissionMode: 'read-only' },
    route: { runtimeId: target.id, model: 'fixture-model', kind: 'general', reasons: [], warnings: [] },
    signal: new AbortController().signal,
    emit: (event) => events.push(event),
    approve: async () => false,
  });
  const quota = events.find((event) => event.type === 'quota');
  assert.equal(quota?.data?.quotaUpdate, 'sparse');
  assert.equal((quota?.data?.quota as RuntimeSnapshot['quota']).source, 'Codex app-server account/rateLimits/updated');
});
