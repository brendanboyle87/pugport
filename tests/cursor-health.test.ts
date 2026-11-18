import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Controller } from '../src/server/controller.ts';
import { createCursorAdapter, cursorAdapter } from '../src/server/adapters/cursor.ts';
import { applyCursorEditorUsage, cursorEditorUsage } from '../src/server/cursor-usage.ts';
import { cursorTimeoutReference, missedCheckReferenceMs } from '../src/shared/runtime-health.ts';
import { collectProcessOutput } from '../src/server/adapters/process.ts';
import { QuotaCard } from '../src/ui/App.tsx';

function fixture(t: TestContext, statusLatency?: number, readUsage = true) {
  const directory = mkdtempSync(join(tmpdir(), 'pugport-cursor-health-'));
  let time = Date.now();
  let mode = 'ready';
  let statusCalls = 0;
  let fetches = 0;
  let editorEmail = 'synthetic@example.test';
  const identity = { isAuthenticated: true, userInfo: { userId: 'auth0|user_SYNTHETIC', email: editorEmail } };
  const controllerOptions = {
    now: () => time,
    readAccountIdentity: () => undefined,
    nativeLogin: { pending: () => false },
  };
  let controller = new Controller(directory, join(directory, 'data'), controllerOptions);
  clearInterval(controller.timer);
  controller.targets = [
    {
      id: 'cursor-native',
      provider: 'cursor',
      label: 'Synthetic Cursor',
      command: 'unused',
      commandDiscovery: 'fixed',
      environment: 'native',
      enabled: true,
    },
  ];
  controller.snapshots = [];
  controller.settings.cursorUsageFromEditor = true;
  const wasEnabled = cursorEditorUsage.enabled;
  cursorEditorUsage.enabled = true;
  const adapter = createCursorAdapter({
    now: () => time,
    capture: async (_target, args, options) => {
      assert.equal(options?.timeoutMs, 30_000, 'all Cursor metadata captures allow 30 seconds');
      if (args[0] === 'status') {
        statusCalls++;
        if (statusLatency !== undefined) {
          let killed = false;
          const child = Object.assign(new EventEmitter(), {
            stdin: new PassThrough(),
            stdout: new PassThrough(),
            stderr: new PassThrough(),
            exitCode: null,
            signalCode: null,
            kill: () => {
              killed = true;
              return true;
            },
          }) as unknown as ChildProcessWithoutNullStreams;
          const result = collectProcessOutput(child, options!.timeoutMs!, options!.acceptedExitCodes);
          if (Number.isFinite(statusLatency)) {
            setTimeout(() => {
              child.stdout.emit('data', Buffer.from(JSON.stringify(identity)));
              child.emit('close', 0);
            }, statusLatency);
            t.mock.timers.tick(statusLatency);
            assert.equal(killed, false);
          } else {
            t.mock.timers.tick(29_999);
            assert.equal(killed, false, 'still waiting just before 30 seconds');
            t.mock.timers.tick(1);
            assert.equal(killed, true, 'never-ending status is killed at 30 seconds');
          }
          return result;
        }
        if (mode === 'timeout' || mode === 'about-mismatch-timeout' || (mode === 'second-timeout' && statusCalls === 2))
          throw new Error('runtime-timeout');
        if (mode === 'auth') return { stdout: JSON.stringify({ isAuthenticated: false }), exitCode: 1 };
        const value =
          mode === 'mismatch' && statusCalls === 2
            ? { isAuthenticated: true, userInfo: { userId: '200000002', email: 'other@example.test' } }
            : identity;
        return { stdout: JSON.stringify(value), exitCode: 0 };
      }
      return {
        stdout:
          args[0] === 'about'
            ? JSON.stringify({
                userEmail: mode === 'about-mismatch-timeout' ? 'other@example.test' : identity.userInfo.email,
                subscriptionTier: 'pro',
              })
            : 'auto - Auto',
        exitCode: 0,
      };
    },
    spawn: async () => {
      const child = new EventEmitter() as ChildProcessWithoutNullStreams;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new Writable({
        write(chunk, _encoding, done) {
          const request = JSON.parse(String(chunk));
          const result =
            request.method === 'initialize'
              ? { protocolVersion: 1, agentCapabilities: { loadSession: true } }
              : { models: [{ value: 'auto', name: 'Auto' }] };
          child.stdout.emit('data', Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n'));
          done();
        },
      });
      return child;
    },
    terminate: async () => {},
    usage: (snapshot, identity, options) =>
      readUsage
        ? applyCursorEditorUsage(snapshot, identity, {
            ...options,
            session: async () => ({ userId: 'user_SYNTHETIC', email: editorEmail, token: 'synthetic.fixture.only' }),
            fetch: (async (url) => {
              fetches++;
              return Response.json(
                String(url).endsWith('/usage-summary')
                  ? {
                      billingCycleEnd: new Date(time + 86400000).toISOString(),
                      individualUsage: { plan: { used: 500, limit: 2000, autoPercentUsed: 25 } },
                    }
                  : {},
              );
            }) as typeof fetch,
          })
        : Promise.resolve(),
  });
  t.mock.method(cursorAdapter, 'discover', adapter.discover);
  t.after(async () => {
    await controller.close();
    cursorEditorUsage.enabled = wasEnabled;
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    get controller() {
      return controller;
    },
    restart: async () => {
      controller.store.setConfig('targets', controller.targets);
      controller.store.setConfig('settings', controller.settings);
      await controller.close();
      cursorEditorUsage.enabled = false; // Simulate losing the process-local usage cache too.
      controller = new Controller(directory, join(directory, 'data'), controllerOptions);
      clearInterval(controller.timer);
      // Only the synthetic target participates in discovery.
      controller.targets = controller.targets.filter((target) => target.id === 'cursor-native');
    },
    snapshot: () => controller.snapshots[0]!,
    clock: () => time,
    advance: (ms: number) => {
      time += ms;
    },
    mode: (value: string) => {
      mode = value;
      statusCalls = 0;
    },
    editor: (email: string) => {
      editorEmail = email;
    },
    fetches: () => fetches,
  };
}

for (const mode of ['timeout', 'second-timeout'])
  test(`Cursor ${mode} retains recent verified usage and renders a soft note without enabling execution`, async (t) => {
    const f = fixture(t);
    await f.controller.refresh();
    const first = f.snapshot();
    assert.equal(first.status, 'ready');
    assert.equal(first.quota.windows[0]?.usedPercent, 25);
    assert.ok(first.cursorVerifiedIdentity);
    assert.ok(!JSON.stringify(first.cursorVerifiedIdentity).includes('synthetic@example.test'));
    f.advance(1000);
    f.mode(mode);
    await f.controller.refresh();
    const missed = f.snapshot();
    assert.deepEqual(missed.cursorVerifiedIdentity, first.cursorVerifiedIdentity);
    assert.equal(missed.accountFingerprint, first.accountFingerprint);
    assert.equal(missed.lastKnownQuota?.windows[0]?.usedPercent, 25);
    assert.equal(missed.lastKnownQuota?.observedAt, first.quota.observedAt);
    assert.equal(missed.quota.status, 'unknown');
    assert.equal(missed.status, 'error');
    assert.equal(missed.capabilities.execute, false);
    assert.equal(cursorTimeoutReference(missed, f.clock()), true);
    const html = renderToStaticMarkup(createElement(QuotaCard, { runtime: missed, now: f.clock(), maxAge: 120 }));
    assert.match(html, /检查超时 · 显示上次读数/);
    assert.doesNotMatch(html, /连接异常/);
    f.advance(1000);
    f.mode('timeout');
    await f.controller.refresh();
    assert.deepEqual(
      f.snapshot().cursorVerifiedIdentity,
      first.cursorVerifiedIdentity,
      'timeouts never renew verification',
    );
  });

for (const scenario of ['mismatch', 'auth', 'expired', 'editor-mismatch', 'future', 'about-mismatch-timeout'])
  test(`Cursor ${scenario} withholds editor usage after a prior verified reading`, async (t) => {
    const f = fixture(t);
    await f.controller.refresh();
    assert.equal(f.snapshot().quota.status, 'known');
    const fetches = f.fetches();
    if (scenario === 'expired') f.advance(missedCheckReferenceMs);
    if (scenario === 'future') f.advance(-1);
    if (scenario === 'editor-mismatch') f.editor('other@example.test');
    f.mode(['auth', 'mismatch', 'about-mismatch-timeout'].includes(scenario) ? scenario : 'timeout');
    await f.controller.refresh();
    assert.equal(f.snapshot().quota.windows.length, 0);
    assert.equal(f.snapshot().lastKnownQuota, undefined);
    assert.equal(cursorTimeoutReference(f.snapshot(), f.clock()), false);
    assert.equal(f.fetches(), fetches, 'unverified or mismatched identities do not fetch usage');
    if (['auth', 'mismatch', 'about-mismatch-timeout'].includes(scenario)) {
      assert.equal(f.snapshot().cursorVerifiedIdentity, undefined);
      f.mode('timeout');
      await f.controller.refresh();
      assert.equal(f.snapshot().lastKnownQuota, undefined, 'a subsequent timeout cannot revive revoked identity');
    }
  });

for (const latency of [20_000, Infinity])
  test(`Cursor status latency ${latency} uses the 30-second capture deadline`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture(t, latency);
    await f.controller.refresh();
    assert.equal(f.snapshot().status, Number.isFinite(latency) ? 'ready' : 'error');
    assert.equal(f.snapshot().quota.status, Number.isFinite(latency) ? 'known' : 'unknown');
    if (!Number.isFinite(latency)) assert.equal(f.snapshot().note, 'runtime-timeout');
  });

test('Cursor identity and quota survive a controller restart as display-only timeout references', async (t) => {
  const f = fixture(t);
  await f.controller.refresh();
  const first = structuredClone(f.snapshot());
  const fetches = f.fetches();
  const record = f.controller.store.config<Record<string, { identity: unknown; quota: typeof first.quota }>>(
    'cursorQuotaReferences',
    {},
  );
  assert.deepEqual(record['cursor-native']?.identity, first.cursorVerifiedIdentity);
  assert.deepEqual(record['cursor-native']?.quota.windows, first.quota.windows);
  assert.ok(first.cursorVerifiedIdentity?.userIdHash, 'opaque user ID is retained only as a hash');
  assert.doesNotMatch(
    JSON.stringify(record),
    /synthetic@example\.test|synthetic\.fixture\.only|200000001|user_SYNTHETIC/,
  );
  assert.equal(JSON.stringify(record).includes('token'), false);
  await f.restart();
  assert.equal(f.controller.snapshots.length, 0, 'a persisted reading never becomes live quota on startup');
  f.advance(1000);
  f.mode('timeout');
  await f.controller.refresh();
  assert.deepEqual(f.snapshot().cursorVerifiedIdentity, first.cursorVerifiedIdentity);
  assert.equal(f.snapshot().lastKnownQuota?.windows[0]?.usedPercent, 25);
  assert.equal(f.snapshot().lastKnownQuota?.observedAt, first.quota.observedAt);
  assert.equal(f.fetches(), fetches, 'a cold cache uses the persisted reading, without another usage request');
  assert.equal(cursorTimeoutReference(f.snapshot(), f.clock()), true);
  assert.equal(f.snapshot().capabilities.execute, false);
  assert.match(
    renderToStaticMarkup(createElement(QuotaCard, { runtime: f.snapshot(), now: f.clock(), maxAge: 120 })),
    /检查超时 · 显示上次读数/,
  );
});

for (const mode of ['auth', 'mismatch', 'about-mismatch-timeout', 'expired'])
  test(`Cursor restart followed by ${mode} revokes its persisted reference`, async (t) => {
    const f = fixture(t);
    await f.controller.refresh();
    await f.restart();
    if (mode === 'expired') f.advance(missedCheckReferenceMs);
    f.mode(mode === 'expired' ? 'timeout' : mode);
    await f.controller.refresh();
    assert.equal(f.snapshot().lastKnownQuota, undefined);
    assert.equal(f.snapshot().quota.windows.length, 0);
    assert.deepEqual(f.controller.store.config('cursorQuotaReferences', {}), {});
    await f.restart();
    f.mode('timeout');
    await f.controller.refresh();
    assert.equal(f.snapshot().lastKnownQuota, undefined, 'another restart cannot revive a revoked reference');
  });

test('simultaneous Cursor refresh requests share one discovery', async (t) => {
  const f = fixture(t);
  const discover = cursorAdapter.discover;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  t.mock.method(cursorAdapter, 'discover', async (...args: Parameters<typeof discover>) => {
    calls++;
    await gate;
    return discover(...args);
  });
  const first = f.controller.refresh({ runtimeIds: ['cursor-native'] });
  const second = f.controller.refresh({ runtimeIds: ['cursor-native'] });
  const shared = (f.controller as unknown as { discoverTarget: typeof cursorAdapter.discover }).discoverTarget(
    f.controller.targets[0]!,
  );
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(calls, 1);
  release();
  await Promise.all([first, second, shared]);
  assert.equal(calls, 1);
});

test('Cursor persisted reference strips raw metadata and redacts private display text', async (t) => {
  const f = fixture(t);
  const discover = cursorAdapter.discover;
  t.mock.method(cursorAdapter, 'discover', async (...args: Parameters<typeof discover>) => {
    const snapshot = await discover(...args);
    Object.assign(snapshot.cursorVerifiedIdentity!, {
      email: 'private@example.test',
      userId: 'raw-private-id',
      token: 'raw-private-token',
    });
    Object.assign(snapshot.quota, { email: 'private@example.test', token: 'raw-private-token' });
    snapshot.quota.note = 'private@example.test token=raw-private-token';
    snapshot.quota.cursorCredits!.grants = [
      { name: 'private@example.test Bearer raw-private-token', remainingUsd: 2, totalUsd: 3, expiresAt: null },
    ];
    return snapshot;
  });
  await f.controller.refresh();
  const record = f.controller.store.config<
    Record<string, { identity: Record<string, unknown>; quota: Record<string, unknown> }>
  >('cursorQuotaReferences', {});
  assert.deepEqual(Object.keys(record['cursor-native']!.identity).sort(), [
    'emailHash',
    'fingerprint',
    'observedAt',
    'userIdHash',
  ]);
  assert.doesNotMatch(
    JSON.stringify(record),
    /private@example\.test|raw-private-id|raw-private-token|synthetic@example\.test|synthetic\.fixture\.only|auth0\|user_SYNTHETIC/,
  );
  assert.equal(record['cursor-native']!.quota.note, undefined);
  assert.equal(record['cursor-native']!.quota.token, undefined);
});

test('Cursor verified identity persists even before the first quota reading', async (t) => {
  const f = fixture(t, undefined, false);
  await f.controller.refresh();
  const record = f.controller.store.config<Record<string, { identity: unknown; quota?: unknown }>>(
    'cursorQuotaReferences',
    {},
  );
  assert.deepEqual(record['cursor-native']?.identity, f.snapshot().cursorVerifiedIdentity);
  assert.equal(record['cursor-native']?.quota, undefined);
  await f.restart();
  f.mode('timeout');
  await f.controller.refresh();
  assert.deepEqual(f.snapshot().cursorVerifiedIdentity, record['cursor-native']?.identity);
  assert.equal(f.snapshot().lastKnownQuota, undefined);
});

for (const clear of ['disabled', 'usage-off'] as const)
  test(`Cursor ${clear} clears the persisted reading before restart`, async (t) => {
    const f = fixture(t);
    await f.controller.refresh();
    if (clear === 'disabled') {
      t.mock.method(f.controller, 'refresh', async () => {});
      f.controller.updateTarget('cursor-native', { enabled: false });
      assert.deepEqual(f.controller.store.config('cursorQuotaReferences', {}), {});
    } else {
      f.controller.updateSettings({ cursorUsageFromEditor: false });
      const record = f.controller.store.config<Record<string, { quota?: unknown }>>('cursorQuotaReferences', {});
      assert.equal(record['cursor-native']?.quota, undefined);
    }
    await f.restart();
    assert.equal(f.controller.snapshots.length, 0);
    const record = f.controller.store.config<Record<string, { quota?: unknown }>>('cursorQuotaReferences', {});
    assert.equal(record['cursor-native']?.quota, undefined);
  });
