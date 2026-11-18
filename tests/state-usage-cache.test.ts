import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { Controller } from '../src/server/controller.ts';
import { Store } from '../src/server/store.ts';
import { UsageLedger } from '../src/server/usage.ts';
import { installedPlugins } from '../src/server/plugins.ts';
import type { RunRecord, RuntimeTarget } from '../src/shared/types.ts';
test('Controller state serializes 2000 usage rows with no repeated usage JSON parsing', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'studio-state-cache-test-'));
  const store = new Store(join(directory, 'data'));
  t.after(() => {
    store.close();
    const safe = resolve(directory);
    assert.ok(safe.startsWith(resolve(tmpdir()) + sep) && basename(safe).startsWith('studio-state-cache-test-'));
    rmSync(safe, { recursive: true, force: true });
  });
  const ledger = new UsageLedger(store.db);
  const target: RuntimeTarget = {
    id: 'synthetic',
    provider: 'pi',
    label: 'synthetic',
    command: 'unused',
    enabled: false,
    environment: 'native',
  };
  for (let index = 0; index < 2000; index++) {
    const run: RunRecord = {
      id: `run-${index}`,
      prompt: 'synthetic prompt',
      projectPath: directory,
      kind: 'routine',
      status: 'completed',
      startedAt: new Date(Date.UTC(2026, 0, 2) + index * 1000).toISOString(),
      output: '',
      events: [],
      route: { runtimeId: target.id, model: 'synthetic-model', kind: 'routine', reasons: [], warnings: [] },
    };
    ledger.begin(run, target, 'subscription');
  }
  // Exercise the real state/broadcast methods without constructor login probes, credentials or timers.
  const controller = Object.assign(Object.setPrototypeOf(new EventEmitter(), Controller.prototype), {
    root: directory,
    dataDir: directory,
    store,
    usage: ledger,
    targets: [],
    snapshots: [],
    settings: {},
    active: new Map(),
    approvals: new Map(),
    autoResetCards: { records: {} },
    sandboxHealth: { snapshot: () => ({}) },
    inbox: { summary: () => ({ open: [], unread: 0, attention: 0 }) },
    quotaHistory: { summary: () => ({}) },
    judgments: { report: () => ({}) },
  }) as Controller;
  store.runSummaries();
  installedPlugins(directory);
  const original = JSON.parse;
  let parses = 0;
  t.mock.method(JSON, 'parse', (...args: Parameters<typeof JSON.parse>) => {
    if (args[0].includes('"runId":')) parses++;
    return original(...args);
  });
  const cold = controller.state();
  assert.equal(cold.usage!.perRun.length, 200);
  assert.equal(parses, 2000);
  const beforeBytes = JSON.stringify(cold).length;
  parses = 0;
  let emitted = 0;
  controller.on('state', (state) => {
    emitted++;
    assert.equal(JSON.stringify(state).length, beforeBytes);
    assert.equal(state.usage, cold.usage);
  });
  for (let index = 0; index < 20; index++) controller.broadcast();
  assert.equal(emitted, 0);
  controller.flushBroadcast();
  assert.equal(emitted, 1);
  assert.equal(parses, 0);
  assert.equal(controller.state().usage!.byRuntime[0]!.runs, 2000);
  assert.equal(controller.state().usage!.totals.runs, 2000);
  assert.equal(ledger.stateReport([], new Date('2026-01-15')).perRun.length, 2000, 'retain the entire current month');
  const historical = ledger.stateReport(['run-0'], new Date('2026-03-15'));
  assert.equal(historical.perRun.length, 201);
  assert.ok(
    historical.perRun.some((run) => run.runId === 'run-0'),
    'retain visible old task usage',
  );
  assert.deepEqual(historical.totals, ledger.report().totals, 'historical totals remain complete');
  const firstPage = ledger.runPage(0, 200);
  const secondPage = ledger.runPage(firstPage.nextOffset!, 200);
  assert.equal(firstPage.total, 2000);
  assert.equal(new Set([...firstPage.perRun, ...secondPage.perRun].map((run) => run.runId)).size, 400);
  assert.equal(ledger.runPage(1999, 200).nextOffset, undefined);
  assert.throws(() => ledger.runPage(-1));
  t.diagnostic(
    `2000-row Controller.state JSON length cold/cached: ${beforeBytes}/${JSON.stringify(controller.state()).length}; first-state parses: 2000; 20 subsequent broadcasts parses: ${parses}`,
  );
});

test('plugin inventory reuses parsed packages and invalidates on actual install, update and removal', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'studio-plugin-cache-test-'));
  t.after(() => {
    const safe = resolve(directory);
    assert.ok(safe.startsWith(resolve(tmpdir()) + sep) && basename(safe).startsWith('studio-plugin-cache-test-'));
    rmSync(safe, { recursive: true, force: true });
  });
  const packagePath = join(directory, 'node_modules', 'zod', 'package.json');
  mkdirSync(join(directory, 'node_modules', 'zod'), { recursive: true });
  writeFileSync(packagePath, '{"version":"synthetic-v1"}');
  mkdirSync(join(directory, 'reports'));
  const referencesPath = join(directory, 'reports', 'references.json');
  writeFileSync(
    referencesPath,
    JSON.stringify({
      references: [
        {
          name: 'jev-router',
          commit: '123456789012345',
          directory: 'vendor/jev',
          sourceUrl: 'https://example.test/jev',
        },
      ],
    }),
  );
  const first = installedPlugins(directory);
  assert.equal(first.find((plugin) => plugin.id === 'zod')!.version, 'synthetic-v1');
  const original = JSON.parse;
  let parses = 0;
  t.mock.method(JSON, 'parse', (...args: Parameters<typeof JSON.parse>) => {
    parses++;
    return original(...args);
  });
  assert.deepEqual(installedPlugins(directory), first);
  assert.equal(parses, 0);
  assert.ok(!first.some((plugin) => plugin.kind === 'reference'));
  writeFileSync(packagePath, '{"version":"synthetic-version-two"}');
  assert.equal(installedPlugins(directory).find((plugin) => plugin.id === 'zod')!.version, 'synthetic-version-two');
  unlinkSync(packagePath);
  assert.notEqual(installedPlugins(directory).find((plugin) => plugin.id === 'zod')!.version, 'synthetic-version-two');
  writeFileSync(packagePath, '{"version":"synthetic-v3"}');
  assert.equal(installedPlugins(directory).find((plugin) => plugin.id === 'zod')!.version, 'synthetic-v3');
  writeFileSync(referencesPath, '{"references":[]}');
  assert.ok(!installedPlugins(directory).some((plugin) => plugin.kind === 'reference'));
});
