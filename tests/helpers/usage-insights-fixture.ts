import { usageInsights } from '../../src/server/usage-insights.ts';
import {
  usageMetricKeys,
  type UsageReport,
  type UsageRun,
  type UsageMeasures,
  type UsageMetric,
} from '../../src/shared/usage.ts';
import type { InsightFilters } from '../../src/shared/usage-insights.ts';
import type { Workflow } from '../../src/shared/types.ts';
import type { LayaChoices } from '../../src/shared/laya.ts';

export const insightNow = new Date('2026-11-01T12:00:00Z');
export function insightFixture(filters: InsightFilters = { range: '7d', kind: 'all' }, empty = false) {
  const rows: UsageRun[] = empty
    ? []
    : Array.from({ length: 126 }, (_, i) => {
        const runtime = i % 4;
        const started = insightNow.getTime() - (i + 1) * 2.6 * 3_600_000;
        return {
          runId: `synthetic-run-${i}`,
          workflowId: `synthetic-workflow-${i}`,
          runtimeId: `executor-${runtime}`,
          runtimeLabel: ['Atlas', 'Cedar', 'Harbor', 'Willow'][runtime],
          provider: runtime < 2 ? 'codex' : 'pi',
          executionKind: runtime < 2 ? 'cli' : 'api',
          projectPath: i % 3 === 0 ? 'C:/Synthetic/Research' : 'C:/Synthetic/Workspace',
          model: `model-${i % 2 ? 'balanced' : 'fast'}`,
          accountingMode: runtime === 0 ? 'subscription' : 'usage',
          status: i % 11 === 0 ? 'failed' : i % 17 === 0 ? 'cancelled' : 'completed',
          startedAt: new Date(started).toISOString(),
          endedAt: new Date(started + 18000 + (i % 8) * 13000).toISOString(),
          adapterStartedAt: new Date(started + 500).toISOString(),
          firstTextAt: i % 5 === 0 ? null : new Date(started + 1900 + (i % 7) * 400).toISOString(),
          errorCode: i % 22 === 0 ? 'quota-or-rate-limit' : i % 33 === 0 ? null : 'network-error',
          relay:
            i % 13 === 0
              ? {
                  fromRunId: `synthetic-run-${i + 1}`,
                  fromRuntimeId: `executor-${(runtime + 1) % 4}`,
                  reason: 'technical',
                }
              : null,
          inputTokens: 1100 + i * 25,
          cacheReadTokens: i % 7 === 0 ? null : 700 + i * 80,
          outputTokens: 450 + i * 3,
          reasoningOutputTokens: i % 8 === 0 ? null : 120,
          cacheWriteTokens: 0,
          totalTokens: 2500 + i * 108,
          estimatedCostUsd: i % 9 === 0 ? null : 0.02 + (i % 9) * 0.018,
          eventCount: 1,
          historyImported: false,
          uncertain: false,
          notes: [],
          sources: ['synthetic'],
        } as UsageRun;
      });
  const source = {
    generatedAt: insightNow.toISOString(),
    filters: {},
    perRun: rows,
    byProject: [],
    byRuntime: [],
    byModel: [],
    note: 'Synthetic observations',
    totals: {
      ...(Object.fromEntries(usageMetricKeys.map((key) => [key, null])) as UsageMeasures),
      runs: rows.length,
      reportedRuns: 0,
      tokenReportedRuns: 0,
      costReportedRuns: 0,
      historyImportedRuns: 0,
      uncertainRuns: 0,
      accountingRuns: { subscription: 0, usage: 0, unknown: 0 },
      metricReportedRuns: Object.fromEntries(usageMetricKeys.map((key) => [key, 0])) as Record<UsageMetric, number>,
    },
  } as UsageReport;
  const workflows: Workflow[] = rows.map((row, index) => {
    const outcome = index % 10;
    const ok = outcome < 3 || outcome === 9;
    const taskType = (
      [
        'conversation',
        'coding',
        'research',
        'writing',
        'translation',
        'data_analysis',
        'automation',
        'media',
        'mixed',
        'unclear',
      ] as const
    )[Math.floor(index / 3) % 10];
    const choices: LayaChoices = {
      task_type: taskType,
      difficulty: (['simple', 'standard', 'complex', 'unclear'] as const)[index % 4],
      web_search: taskType === 'research' ? 'yes' : 'no',
      input_modality: 'text',
      document_read: 'no',
      media_output: 'none',
      project_access: taskType === 'coding' ? 'write' : 'none',
      run_commands: taskType === 'coding' ? 'yes' : 'no',
      browser_use: 'no',
      executor_intent: 'none',
    };
    return {
      id: row.workflowId!,
      conversationId: `synthetic-conversation-${index % 12}`,
      projectId: row.projectPath === 'C:/Synthetic/Research' ? 'research' : 'workspace',
      userMessageId: `synthetic-message-${index}`,
      input: {
        mode: 'auto',
        permissionMode: 'read-only',
        executionPolicy: 'cli-first',
        content: [
          'Summarize the findings from this research note.',
          'Inspect the implementation and explain the next change.',
          'Draft a short update for this project.',
          'Help me understand the tradeoffs in this example.',
        ][index % 4],
      },
      status: row.status === 'failed' ? 'failed' : 'completed',
      phase: 'summarize',
      plan: [],
      runIds: [row.runId],
      createdAt: row.startedAt,
      updatedAt: row.endedAt!,
      memoryRevision: 0,
      memoryExcerpt: '',
      handlingSource: index % 19 === 0 ? undefined : ok && index % 4 !== 0 ? 'laya' : 'rules',
      laya: {
        inference: {
          status: ok ? 'ok' : outcome >= 7 ? 'skipped' : 'fallback',
          reason: [
            'local_cuda',
            'cloud',
            'cloud',
            'timeout',
            'warming_up',
            'busy',
            'service_error',
            'privacy',
            'disabled',
            'legacy',
          ][outcome],
          device: outcome === 0 ? 'cuda:0' : outcome === 1 || outcome === 2 ? 'cloud' : undefined,
          latencyMs: outcome === 2 && index % 3 === 0 ? NaN : 80 + (index % 8) * 110,
          modelVersion: 'pugport-laya-v4',
          ...(ok && index % 23 !== 0 ? { choices } : {}),
        },
        policy: { applied: ok, reasons: [], conflicts: [], excludeRuntimeIds: [] },
      },
    } as Workflow;
  });
  if (workflows[0])
    workflows.push({
      ...workflows[0],
      id: 'synthetic-delegated-child',
      delegation: { parentId: workflows[0].id, role: 'worker', requestId: 'synthetic-child-request' },
    });
  return usageInsights(source, workflows, filters, insightNow, [
    { id: 'research', path: 'C:/Synthetic/Research' },
    { id: 'workspace', path: 'C:/Synthetic/Workspace' },
  ]);
}
