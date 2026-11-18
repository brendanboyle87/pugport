import type { DatabaseSync } from 'node:sqlite';
import type { TaskJudgment, JudgmentUsageReport } from '../shared/task-judgment.ts';

/** Separate from execution tokens: a classifier request is not a CLI task. */
export class JudgmentStore {
  constructor(private db: DatabaseSync) {
    db.exec(
      'CREATE TABLE IF NOT EXISTS task_judgments (workflow_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, value TEXT NOT NULL)',
    );
  }
  save(workflowId: string, projectId: string, value: TaskJudgment) {
    this.db
      .prepare(
        'INSERT INTO task_judgments(workflow_id,project_id,value) VALUES(?,?,?) ON CONFLICT(workflow_id) DO UPDATE SET value=excluded.value',
      )
      .run(workflowId, projectId, JSON.stringify(value));
  }
  get(workflowId: string): TaskJudgment | undefined {
    const row = this.db.prepare('SELECT value FROM task_judgments WHERE workflow_id=?').get(workflowId) as
      { value: string } | undefined;
    return row ? JSON.parse(row.value) : undefined;
  }
  report(): JudgmentUsageReport {
    const empty = () => ({
      calls: 0,
      attemptedCalls: 0,
      inputTokens: null as number | null,
      outputTokens: null as number | null,
      totalTokens: null as number | null,
      costUsd: null,
    });
    const total = empty(),
      projects = new Map<string, ReturnType<typeof empty>>();
    const rows = this.db.prepare('SELECT project_id,value FROM task_judgments').all() as {
      project_id: string;
      value: string;
    }[];
    for (const row of rows) {
      const value = JSON.parse(row.value) as TaskJudgment;
      const project = projects.get(row.project_id) ?? empty();
      projects.set(row.project_id, project);
      for (const aggregate of [total, project]) {
        aggregate.calls++;
        if (value.requestAttempted) aggregate.attemptedCalls++;
        for (const metric of ['inputTokens', 'outputTokens', 'totalTokens'] as const) {
          const n = value.usage[metric];
          if (typeof n === 'number' && Number.isFinite(n) && n >= 0) aggregate[metric] = (aggregate[metric] ?? 0) + n;
        }
      }
    }
    return { ...total, byProject: [...projects].map(([projectId, metrics]) => ({ projectId, ...metrics })) };
  }
}
