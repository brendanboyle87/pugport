import type { Workflow } from '../../src/shared/types.ts';
import type { UsageReport, UsageRun } from '../../src/shared/usage.ts';
import { insightFixture } from './usage-insights-fixture.ts';

/** No credentials, provider calls or user data: a deterministic desktop workload. */
export function spendFixture(runCount = 320, workflowCount = 80) {
  const now = new Date('2026-11-03T18:00:00.000Z');
  const base = insightFixture();
  const names = [
    'Codex — Plus',
    'Claude Code — Max',
    'Pi · Anthropic card',
    'Pi · OpenAI grant',
    'Cursor — Pro',
    'Grok',
  ];
  const titles = [
    'Migrate the image pipeline',
    'Rewrite the API quick start',
    'Audit infrastructure drift',
    'Summarize support threads',
    'Fix search indexing',
    'Repair the upload retry test',
  ];
  const workflows = Array.from(
    { length: workflowCount },
    (_, i) =>
      ({
        id: `spend-task-${i}`,
        conversationId: `spend-conversation-${i}`,
        projectId: `project-${i % 3}`,
        status: 'completed',
        phase: 'summarize',
        input: { content: titles[i % titles.length]!, mode: 'auto', permissionMode: 'read-only' },
        createdAt: new Date(now.getTime() - (i % 29) * 86400000).toISOString(),
        updatedAt: now.toISOString(),
        plan: [],
        runIds: [],
        memoryRevision: 0,
        memoryExcerpt: '',
      }) as unknown as Workflow,
  );
  const rows = Array.from({ length: runCount }, (_, i) => {
    const executor = i % names.length;
    const task = workflows[i % workflowCount]!;
    const start = new Date(
      now.getTime() - ((Math.floor(i / 6) * 17 + Math.floor(i / 42) * 3) % 55) * 86400000 - (i % 12) * 3600000,
    );
    const row = {
      ...base.report.perRun[i % base.report.perRun.length]!,
      runId: `spend-run-${i}`,
      workflowId: task.id,
      runtimeId: `executor-${executor}`,
      runtimeLabel: names[executor]!,
      projectPath: `C:/Synthetic/${['atlas-web', 'docs-site', 'infra-scripts'][i % 3]}`,
      provider:
        executor === 0 ? 'codex' : executor === 1 ? 'claude' : executor < 4 ? 'pi' : executor === 4 ? 'cursor' : 'grok',
      executionKind: executor === 2 || executor === 3 ? 'api' : 'cli',
      accountingMode: executor === 2 || executor === 3 ? 'usage' : 'subscription',
      startedAt: start.toISOString(),
      endedAt: new Date(start.getTime() + 48000).toISOString(),
      adapterStartedAt: start.toISOString(),
      firstTextAt: new Date(start.getTime() + 900).toISOString(),
      estimatedCostUsd: i % 31 === 0 ? null : ((i % 17) + 1) * 0.087,
    } as UsageRun;
    task.runIds.push(row.runId);
    return row;
  });
  const report: UsageReport = { ...base.report, generatedAt: now.toISOString(), perRun: rows };
  const projects = ['atlas-web', 'docs-site', 'infra-scripts'].map((name, i) => ({
    id: `project-${i}`,
    path: `C:/Synthetic/${name}`,
    name,
  }));
  const accounts = new Map(
    rows.map((row) => [
      row.runId,
      {
        key:
          row.runtimeId === 'executor-2' || row.runtimeId === 'executor-3'
            ? `api:${row.runtimeId}`
            : `acct:${row.runtimeId}`,
        label: row.runtimeLabel,
        provider: row.provider,
        source: (row.executionKind === 'api' ? 'api-card' : 'login') as 'api-card' | 'login',
      },
    ]),
  );
  const live = names.map((label, i) => ({
    runtimeId: `executor-${i}`,
    label,
    provider: rows.find((r) => r.runtimeId === `executor-${i}`)!.provider,
    accountKey: i === 2 || i === 3 ? `api:executor-${i}` : `acct:executor-${i}`,
    accountingMode: (i === 2 || i === 3 ? 'usage' : 'subscription') as 'usage' | 'subscription',
    ...(i === 3
      ? {
          budget: {
            policy: {
              limitUsd: 100,
              startedAt: '2026-10-08T00:00:00Z',
              expiresAt: '2026-11-07T00:00:00Z',
              perRunUsd: 1,
              maxConcurrentRuns: 2,
              burstConcurrentRuns: 4,
              preferExpiring: false,
            },
            spentUsd: 41,
            reservedUsd: 0,
            remainingUsd: 59,
            unreportedRuns: 0,
            phase: 'priority' as const,
            maxConcurrentRuns: 2,
          },
        }
      : i !== 2 && i !== 5
        ? {
            quotaWindows: [
              { id: 'weekly', label: 'Weekly', usedPercent: 46 + i * 7, resetsAt: '2026-11-05T18:00:00Z' },
            ],
          }
        : {}),
  }));
  return { now, report, workflows, projects, names, accounts, live };
}
