import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import express from 'express';
import { SpendService, SpendLedger } from '../src/server/spend-ledger.ts';
import { Store } from '../src/server/store.ts';
import { WorkspaceStore } from '../src/server/workspace-store.ts';
import { UsageLedger } from '../src/server/usage.ts';
import type { RunRecord, RuntimeTarget, Workflow } from '../src/shared/types.ts';
import { spendFixture } from './helpers/spend-fixture.ts';

test('Spend overview HTTP: synthetic 800 workflows / 10000 runs; cold and warm metrics', async () => {
  const fixture = spendFixture(10_000, 800);
  const directoryDb = mkdtempSync(resolve(tmpdir(), 'spend-scale-'));
  const store = new Store(directoryDb);
  const workspace = new WorkspaceStore(store.db, { recoverInterrupted: false });
  let usage = new UsageLedger(store.db);
  const ledger = new SpendLedger(store.db, () => fixture.now.getTime());
  store.db.exec('BEGIN');
  try {
    for (const workflow of fixture.workflows)
      workspace.save('workflow', workflow.id, workflow.conversationId, workflow);
    for (const project of fixture.projects) workspace.save('project', project.id, project.id, project);
    for (const row of fixture.report.perRun) {
      const run: RunRecord = {
        id: row.runId,
        prompt: 'synthetic',
        output: '',
        events: [],
        kind: 'routine',
        status: 'completed',
        projectPath: row.projectPath,
        workflowId: row.workflowId,
        startedAt: row.startedAt,
        endedAt: row.endedAt,
        executionKind: row.executionKind ?? undefined,
        route: { runtimeId: row.runtimeId, model: 'fixture', kind: 'routine', reasons: [], warnings: [] },
      };
      const target = {
        id: row.runtimeId,
        label: row.runtimeLabel,
        provider: row.provider,
        command: 'unused',
        environment: 'native',
        enabled: true,
        ...(row.executionKind === 'api' ? { gateway: 'api' } : {}),
      } as RuntimeTarget;
      store.saveRun(run);
      usage.record(
        run,
        target,
        {
          type: 'usage',
          at: row.startedAt,
          data: {
            scope: 'run',
            cumulative: true,
            inputTokens: 100,
            outputTokens: 20,
            ...(row.estimatedCostUsd === null ? {} : { costUsd: row.estimatedCostUsd }),
          },
        },
        row.accountingMode,
      );
    }
    for (const item of fixture.live)
      if ('budget' in item && item.budget)
        ledger.recordBudget(
          item.runtimeId,
          undefined,
          item.budget.policy,
          'created',
          Date.parse(item.budget.policy.startedAt),
        );
    store.db.exec('COMMIT');
  } catch (error) {
    store.db.exec('ROLLBACK');
    store.db.close();
    throw error;
  }
  usage = new UsageLedger(store.db);
  let loads = 0;
  const service = new SpendService({
    report: () => usage.report(),
    accounts: () => usage.accountsByRun(),
    workflows: () => {
      loads++;
      return workspace.list<Workflow>('workflow', undefined, -1);
    },
    revision: () => (store.db.prepare('SELECT n FROM workspace_revision WHERE id=1').get() as { n: number }).n,
    projects: () => workspace.projects(true),
    ledger,
    live: () => fixture.live,
    now: () => fixture.now,
  });
  const app = express();
  app.get('/api/usage/spend', (_req, res) => res.json(service.overview({ range: '30d', billing: 'all', kind: 'all' })));
  const server = createServer(app).listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address() as { port: number };
    const request = async () => {
      const before = process.memoryUsage();
      const start = performance.now();
      const response = await fetch(`http://127.0.0.1:${address.port}/api/usage/spend`);
      assert.equal(response.status, 200);
      const text = await response.text();
      const ms = performance.now() - start;
      const after = process.memoryUsage();
      const data = JSON.parse(text);
      assert.equal(data.days.length, 56);
      assert.equal('perRun' in data.insights.report, false);
      assert.ok(data.insights.tasks.length <= 6);
      assert.ok(data.insights.buckets.every((b: object) => !('failureRunIds' in b)));
      return {
        ms,
        bytes: Buffer.byteLength(text),
        heapDeltaBytes: after.heapUsed - before.heapUsed,
        rssDeltaBytes: after.rss - before.rss,
        heapUsedBytes: after.heapUsed,
        rssBytes: after.rss,
      };
    };
    const cold = await request();
    const warm = await request();
    assert.equal(loads, 1, 'warm cache reuses workflow index');
    workspace.save('workflow', fixture.workflows[0]!.id, fixture.workflows[0]!.conversationId, {
      ...fixture.workflows[0],
      updatedAt: new Date().toISOString(),
    });
    const revisionChanged = await request();
    assert.equal(loads, 2, 'revision change reloads persisted workflows');
    assert.ok(cold.bytes < 2_000_000, 'overview does not serialize 10000 details');
    const result = {
      os: process.platform,
      node: process.version,
      workflows: 800,
      runs: 10000,
      cold,
      warm,
      revisionChanged,
      stats: service.stats(),
      note: 'Temporary on-disk SQLite, real Store/WorkspaceStore/UsageLedger/SpendLedger and SpendService over loopback HTTP. Includes database reads, aggregation, serialization and client read; synthetic live account snapshots. Excludes Controller startup and real providers. Memory includes fixture and HTTP client. Temporary database retained for inspection.',
    };
    const directory = resolve('.design/context-insight/impl-spend');
    mkdirSync(directory, { recursive: true });
    writeFileSync(resolve(directory, 'performance.json'), JSON.stringify(result, null, 2) + '\n');
    console.log('SPEND_PERFORMANCE ' + JSON.stringify(result));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    store.db.close();
  }
});
