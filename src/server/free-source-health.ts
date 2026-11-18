import type { DatabaseSync } from 'node:sqlite';
import { apiPreset, isFreePreset } from '../shared/api-providers.ts';
import type { RunRecord, RuntimeSnapshot, RuntimeTarget } from '../shared/types.ts';
import type { AccountAvailability } from '../shared/accounts.ts';
import type { FreeProbe } from './free-sources.ts';

type Entry = AccountAvailability & { streak: number; runId?: string };
export class FreeSourceHealth {
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = Date.now,
  ) {
    db.exec('CREATE TABLE IF NOT EXISTS free_source_health (runtime_id TEXT PRIMARY KEY, value TEXT NOT NULL)');
  }
  private get(id: string): Entry | undefined {
    const row = this.db.prepare('SELECT value FROM free_source_health WHERE runtime_id=?').get(id) as
      { value: string } | undefined;
    return row ? JSON.parse(row.value) : undefined;
  }
  clear(id: string) {
    this.db.prepare('DELETE FROM free_source_health WHERE runtime_id=?').run(id);
  }
  forget(id: string) {
    this.clear(id);
  }
  probe(target: RuntimeTarget, result: FreeProbe) {
    if (!result.error) {
      // Catalog success clears authentication only; it does not prove inference quota recovery.
      if (this.get(target.id)?.reason === 'authentication') this.clear(target.id);
    } else this.record(target, result.error, result.retryAfterSeconds);
  }
  record(target: RuntimeTarget, code: string, retry?: number, runId?: string) {
    if (!isFreePreset(target.apiProvider)) return;
    const previous = this.get(target.id);
    if (previous?.reason === 'authentication' || (runId && previous?.runId === runId)) return;
    const auth = ['authentication-required', 'api-key-auth-or-configuration'].includes(code);
    const rate = code === 'quota-or-rate-limit';
    const localNetwork =
      apiPreset(target.apiProvider)?.local &&
      ['runtime-network-error', 'runtime-timeout', 'runtime-process-closed'].includes(code);
    if (!auth && !rate && !localNetwork) return;
    const streak = (previous?.streak ?? 0) + (rate ? 1 : 0);
    const seconds = rate
      ? typeof retry === 'number' && Number.isFinite(retry) && retry >= 0
        ? retry
        : [60, 300, 900, 3600][Math.min(streak - 1, 3)]!
      : 30;
    const at = this.now();
    const entry: Entry = {
      reason: auth ? 'authentication' : 'quota',
      observedAt: new Date(at).toISOString(),
      streak,
      runId,
      ...(!auth ? { retryAt: new Date(Math.min(at + seconds * 1000, 8.64e15)).toISOString() } : {}),
    };
    this.db
      .prepare(
        'INSERT INTO free_source_health(runtime_id,value) VALUES(?,?) ON CONFLICT(runtime_id) DO UPDATE SET value=excluded.value',
      )
      .run(target.id, JSON.stringify(entry));
  }
  failure(target: RuntimeTarget, run: RunRecord) {
    if (!isFreePreset(target.apiProvider) || run.route.runtimeId !== target.id) return;
    if (run.status === 'completed') {
      // Only key replacement or a successful probe releases an authentication latch.
      if (this.get(target.id)?.reason !== 'authentication') this.clear(target.id);
    } else if (run.status === 'failed') {
      const timing = [...run.events].reverse().find((event) => typeof event.data?.retryAfterSeconds === 'number')
        ?.data?.retryAfterSeconds;
      this.record(target, run.errorCode ?? '', typeof timing === 'number' ? timing : undefined, run.id);
    }
  }
  apply(snapshot: RuntimeSnapshot): RuntimeSnapshot {
    if (!isFreePreset(snapshot.apiProvider) && snapshot.costTier !== 'free') return snapshot;
    const { availability: _old, ...clean } = snapshot;
    const entry = this.get(snapshot.id);
    if (!entry || (entry.reason === 'quota' && Date.parse(entry.retryAt ?? '') <= this.now())) return clean;
    return {
      ...clean,
      availability: {
        reason: entry.reason,
        observedAt: entry.observedAt,
        ...(entry.retryAt ? { retryAt: entry.retryAt } : {}),
      },
    };
  }
}
