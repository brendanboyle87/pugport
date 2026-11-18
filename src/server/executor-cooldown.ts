import type { DatabaseSync } from 'node:sqlite';
import { isFreePreset } from '../shared/api-providers.ts';
import type { ExecutorCooldown as Cooldown, RunRecord, RuntimeSnapshot, RuntimeTarget } from '../shared/types.ts';

export type { ExecutorCooldown } from '../shared/types.ts';
type Entry = Cooldown & { provider: RuntimeTarget['provider']; runId: string };
const codes = ['runtime-network-error', 'runtime-timeout', 'runtime-process-closed', 'runtime-protocol-incompatible'];
const networkCodes = ['runtime-network-error', 'runtime-timeout'];

export class ExecutorCooldownStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = Date.now,
  ) {
    db.exec('CREATE TABLE IF NOT EXISTS executor_cooldown (runtime_id TEXT PRIMARY KEY, value TEXT NOT NULL)');
  }
  private get(id: string): Entry | undefined {
    const row = this.db.prepare('SELECT value FROM executor_cooldown WHERE runtime_id=?').get(id) as
      { value: string } | undefined;
    return row ? JSON.parse(row.value) : undefined;
  }
  clear(id: string) {
    this.db.prepare('DELETE FROM executor_cooldown WHERE runtime_id=?').run(id);
  }
  forget(id: string) {
    this.clear(id);
  }
  failure(
    target: RuntimeTarget,
    run: RunRecord,
  ): { counted: boolean; streak: number; networkWide: boolean } | undefined {
    if (run.route.runtimeId !== target.id || isFreePreset(target.apiProvider) || run.stepId === 'executor-diagnosis')
      return;
    if (run.status !== 'failed' || !codes.includes(run.errorCode ?? '')) return;
    const previous = this.get(target.id);
    const counted =
      previous?.runId !== run.id && (!previous || Date.parse(run.startedAt) > Date.parse(previous.observedAt));
    const at = this.now();
    let entry = previous;
    if (counted) {
      const streak = (previous?.streak ?? 0) + 1;
      entry = {
        provider: target.provider,
        reason: 'failures',
        streak,
        errorCode: run.errorCode!,
        observedAt: new Date(at).toISOString(),
        retryAt: new Date(at + [1, 5, 15, 60][Math.min(streak - 1, 3)]! * 60000).toISOString(),
        runId: run.id,
      };
      this.db
        .prepare(
          'INSERT INTO executor_cooldown(runtime_id,value) VALUES(?,?) ON CONFLICT(runtime_id) DO UPDATE SET value=excluded.value',
        )
        .run(target.id, JSON.stringify(entry));
    }
    const rows = this.db.prepare('SELECT value FROM executor_cooldown').all() as Array<{ value: string }>;
    const providers = new Set(
      rows
        .map((row) => JSON.parse(row.value) as Entry)
        .filter((item) => networkCodes.includes(item.errorCode) && Date.parse(item.retryAt) > at)
        .map((item) => item.provider),
    );
    return {
      counted,
      streak: entry!.streak,
      networkWide: networkCodes.includes(run.errorCode ?? '') && providers.size >= 2,
    };
  }
  apply(snapshot: RuntimeSnapshot): RuntimeSnapshot {
    const { executorCooldown: _old, ...clean } = snapshot;
    if (isFreePreset(snapshot.apiProvider) || snapshot.costTier === 'free') return clean;
    const entry = this.get(snapshot.id);
    if (!entry || Date.parse(entry.retryAt) <= this.now()) return clean;
    const { provider: _provider, runId: _runId, ...cooldown } = entry;
    return { ...clean, executorCooldown: cooldown };
  }
}
