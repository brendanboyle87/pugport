import { nativeCliProviders } from '../shared/provider-registry.ts';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { quotaOverviewWindows } from '../shared/quota-summary.ts';
import type {
  CursorCredits,
  Provider,
  QuotaUtilization,
  QuotaUtilizationFigure,
  RuntimeSnapshot,
} from '../shared/types.ts';

/*
 * How much of each subscription's quota actually got used. The CLIs only report the current reading, so
 * this keeps, per account and quota window, the highest share seen in each period. Usage only grows inside a
 * period, so that peak is how much of the period's quota was used (at least, if PugPort missed its end).
 */

const nativeProviders = new Set<Provider>(nativeCliProviders);
const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;
/** Claude adds sub-second jitter to its reset time and Codex slides an unused window's reset forward. */
const sameReset = 10 * minute;
/** The last-seen time is only saved this often; peaks and period changes are saved at once. */
const touchEvery = 15 * minute;
const keepFor = 120 * day;
const lookback = 30 * day;
/** On average PugPort saw less than this share of the periods counted. */
const thinCoverage = 0.5;

type Period = {
  id: number;
  runtimeId: string;
  provider: Provider;
  windowId: string;
  /** Hash of the logged-in account, so a different login on the same card starts afresh; '' when unknown. */
  account: string;
  durationMinutes: number | null;
  firstAt: number;
  firstUsed: number | null;
  lastAt: number;
  resetsAt: number;
  peak: number;
  endedAt: number | null;
};
type Row = {
  id: number;
  runtime_id: string;
  provider: string;
  window_id: string;
  account: string;
  duration_minutes: number | null;
  first_at: number;
  first_used: number | null;
  last_at: number;
  resets_at: number;
  peak: number;
  ended_at: number | null;
};
const fromRow = (row: Row): Period => ({
  id: Number(row.id),
  runtimeId: row.runtime_id,
  provider: row.provider as Provider,
  windowId: row.window_id,
  account: row.account,
  durationMinutes: row.duration_minutes,
  firstAt: row.first_at,
  firstUsed: row.first_used,
  lastAt: row.last_at,
  resetsAt: row.resets_at,
  peak: row.peak,
  endedAt: row.ended_at,
});
const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
/** The stored form of a login: a short hash, so a different login on the same card starts afresh; '' when unknown. */
export const accountKey = (fingerprint: string | undefined) =>
  fingerprint ? createHash('sha256').update(fingerprint).digest('hex').slice(0, 16) : '';

/** How fast one account window gets used, from its periods that ended in the last 30 days (see quota-waste.ts). */
export type WindowBurn = {
  /** The login these periods belong to (`accountKey`); '' when unknown. */
  account: string;
  /** Share of the window used per hour in those periods, on average (percent). */
  perHour: number;
  /** How many periods that average stands on, each counted by how much of it PugPort saw before it ended. */
  periods: number;
  /** The period still running: first reading and reset, plus a grant's initial used percentage when known. */
  current?: { since: number; resetsAt: number; firstUsed?: number };
};
/** Keyed by `burnKey`. */
export type BurnRates = ReadonlyMap<string, WindowBurn>;
export const burnKey = (runtimeId: string, windowId: string) => `${runtimeId}\n${windowId}`;
/** Separate grant lifetimes from subscription windows, without storing the provider's display name. */
export const cursorGrantWindowId = (grant: CursorCredits['grants'][number]) =>
  `cursor-grant:${createHash('sha256')
    .update(JSON.stringify([grant.name, grant.expiresAt, grant.totalUsd]))
    .digest('hex')
    .slice(0, 16)}`;

type AccountResult = { provider: Provider; percent: number; periods: number; coverage: number[] };

export class QuotaHistory {
  /** Each account window's period still in progress, keyed by runtime id and window id. */
  private readonly open = new Map<string, Period & { savedLastAt: number; savedResetsAt: number }>();
  private version = 0;
  private cached?: { version: number; minute: number; value: QuotaUtilization | undefined };
  private burnCached?: { version: number; minute: number; value: BurnRates };
  private prunedAt = 0;

  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = Date.now,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS quota_periods (id INTEGER PRIMARY KEY AUTOINCREMENT, runtime_id TEXT NOT NULL,
      provider TEXT NOT NULL, window_id TEXT NOT NULL, account TEXT NOT NULL, duration_minutes INTEGER,
      first_at INTEGER NOT NULL, first_used REAL, last_at INTEGER NOT NULL, resets_at INTEGER NOT NULL, peak REAL NOT NULL, ended_at INTEGER);
      CREATE INDEX IF NOT EXISTS quota_periods_end ON quota_periods(COALESCE(ended_at, resets_at));`);
    const columns = db.prepare('PRAGMA table_info(quota_periods)').all() as { name: string }[];
    if (!columns.some((column) => column.name === 'first_used')) {
      db.exec('ALTER TABLE quota_periods ADD COLUMN first_used REAL');
      // Grant rows predate the baseline by hours at most, and a grant's use only grows: its peak is the
      // closest known first reading. Subscription windows keep NULL.
      db.exec("UPDATE quota_periods SET first_used = peak WHERE window_id LIKE 'cursor-grant:%'");
    }
    this.prune();
    const rows = db.prepare('SELECT * FROM quota_periods WHERE ended_at IS NULL ORDER BY id').all() as Row[];
    for (const row of rows) {
      const period = fromRow(row);
      this.open.set(`${period.runtimeId}\n${period.windowId}`, {
        ...period,
        savedLastAt: period.lastAt,
        savedResetsAt: period.resetsAt,
      });
    }
  }

  /** Records fresh readings. History is only a report: a failed write never stops a quota refresh. */
  observe(snapshots: readonly RuntimeSnapshot[]): void {
    try {
      for (const snapshot of snapshots) this.observeSnapshot(snapshot);
      if (this.now() - this.prunedAt >= day) this.prune();
    } catch {
      /* The next reading tries again. */
    }
  }

  private observeSnapshot(snapshot: RuntimeSnapshot) {
    if (!nativeProviders.has(snapshot.provider) || snapshot.quota.status !== 'known') return;
    // An inferred Grok share is not a reading of what was used.
    const source = snapshot.quota.grokBilling?.percentSource;
    if (source === 'implicit-zero' || source === 'unknown') return;
    const account = accountKey(snapshot.accountFingerprint);
    for (const window of quotaOverviewWindows(snapshot)) {
      const used = window.usedPercent;
      const at = Date.parse(window.observedAt ?? snapshot.quota.observedAt ?? '');
      const resetsAt = Date.parse(window.resetsAt ?? '');
      if (typeof used !== 'number' || !Number.isFinite(used) || used < 0 || used > 100) continue;
      // Without a reset still ahead there is no telling which period a reading belongs to.
      if (!Number.isFinite(at) || !Number.isFinite(resetsAt) || resetsAt <= at) continue;
      const duration =
        typeof window.durationMinutes === 'number' && window.durationMinutes > 0 ? window.durationMinutes : null;
      this.record(snapshot.id, snapshot.provider, window.id, account, duration, used, at, resetsAt);
    }
    if (snapshot.provider === 'cursor') {
      const at = Date.parse(snapshot.quota.observedAt ?? '');
      for (const grant of snapshot.quota.cursorCredits?.grants ?? []) {
        const resetsAt = Date.parse(grant.expiresAt ?? '');
        const total = grant.totalUsd;
        const left = grant.remainingUsd;
        if (
          !Number.isFinite(at) ||
          at > this.now() ||
          !(resetsAt > at) ||
          total === null ||
          !Number.isFinite(total) ||
          total <= 0 ||
          left === null ||
          !Number.isFinite(left) ||
          left < 0 ||
          left > total
        )
          continue;
        this.record(
          snapshot.id,
          snapshot.provider,
          cursorGrantWindowId(grant),
          account,
          null,
          ((total - left) / total) * 100,
          at,
          resetsAt,
        );
      }
    }
  }

  private record(
    runtimeId: string,
    provider: Provider,
    windowId: string,
    account: string,
    duration: number | null,
    used: number,
    at: number,
    resetsAt: number,
  ) {
    const key = `${runtimeId}\n${windowId}`;
    const open = this.open.get(key);
    if (open) {
      const sameAccount = !account || !open.account || account === open.account;
      const sameResetTime = Math.abs(resetsAt - open.resetsAt) <= sameReset;
      if (at < open.lastAt) {
        // A late, older reading may still raise its own period's peak; it never moves periods along.
        if (sameAccount && sameResetTime && used > open.peak) {
          open.peak = used;
          this.save(open);
        }
        return;
      }
      const idle = open.peak === 0 && used === 0;
      const ended =
        !sameAccount ||
        at >= open.resetsAt ||
        // A reset moved and usage fell: the quota was reset early.
        (!sameResetTime && used < open.peak) ||
        // A window nobody used keeps sliding its reset forward; each full length of it unused is a period.
        (idle && open.durationMinutes !== null && at - open.firstAt >= open.durationMinutes * minute);
      if (!ended) {
        const changed =
          used > open.peak ||
          Math.abs(resetsAt - open.savedResetsAt) > sameReset ||
          at - open.savedLastAt >= touchEvery ||
          (!open.account && !!account);
        open.peak = Math.max(open.peak, used);
        open.lastAt = at;
        open.resetsAt = resetsAt;
        open.durationMinutes = duration ?? open.durationMinutes;
        open.account ||= account;
        if (changed) this.save(open);
        return;
      }
      open.endedAt = sameAccount ? Math.min(open.resetsAt, at) : open.lastAt;
      this.save(open);
      this.open.delete(key);
    }
    const inserted = this.db
      .prepare(
        `INSERT INTO quota_periods(runtime_id,provider,window_id,account,duration_minutes,first_at,first_used,last_at,resets_at,peak,ended_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,NULL)`,
      )
      .run(runtimeId, provider, windowId, account, duration, at, used, at, resetsAt, used);
    this.open.set(key, {
      id: Number(inserted.lastInsertRowid),
      runtimeId,
      provider,
      windowId,
      account,
      durationMinutes: duration,
      firstAt: at,
      firstUsed: used,
      lastAt: at,
      resetsAt,
      peak: used,
      endedAt: null,
      savedLastAt: at,
      savedResetsAt: resetsAt,
    });
    this.version++;
  }

  private save(period: Period & { savedLastAt: number; savedResetsAt: number }) {
    this.db
      .prepare(
        'UPDATE quota_periods SET account=?,duration_minutes=?,last_at=?,resets_at=?,peak=?,ended_at=? WHERE id=?',
      )
      .run(
        period.account,
        period.durationMinutes,
        period.lastAt,
        period.resetsAt,
        period.peak,
        period.endedAt,
        period.id,
      );
    period.savedLastAt = period.lastAt;
    period.savedResetsAt = period.resetsAt;
    this.version++;
  }

  private prune() {
    const cutoff = this.now() - keepFor;
    this.db.prepare('DELETE FROM quota_periods WHERE COALESCE(ended_at, resets_at) < ?').run(cutoff);
    for (const [key, period] of this.open) if (period.resetsAt < cutoff) this.open.delete(key);
    this.prunedAt = this.now();
    this.version++;
  }

  /**
   * Per account, its binding window: the longest one (the weekly limit over the 5-hour one), and of equally long
   * ones the one used most. Utilization is the average peak of that window's periods that ended in the last 30
   * days; until one has ended, the current period's share so far.
   */
  summary(): QuotaUtilization | undefined {
    const now = this.now();
    const bucket = Math.floor(now / minute);
    if (this.cached?.version === this.version && this.cached.minute === bucket) return this.cached.value;
    const value = this.compute(now);
    this.cached = { version: this.version, minute: bucket, value };
    return value;
  }

  private compute(now: number): QuotaUtilization | undefined {
    const rows = (
      this.db
        .prepare('SELECT * FROM quota_periods WHERE COALESCE(ended_at, resets_at) >= ? ORDER BY id')
        .all(now - lookback) as Row[]
    )
      .map(fromRow)
      .filter((period) => !period.windowId.startsWith('cursor-grant:'));
    if (!rows.length) return undefined;
    const byAccount = new Map<string, Period[]>();
    for (const row of rows) byAccount.set(row.runtimeId, [...(byAccount.get(row.runtimeId) ?? []), row]);
    const ended: AccountResult[] = [];
    const current: AccountResult[] = [];
    // A period whose reset has passed has ended, even if PugPort was closed when it did.
    const end = (period: Period) => period.endedAt ?? (period.resetsAt <= now ? period.resetsAt : null);
    for (const periods of byAccount.values()) {
      const provider = periods.at(-1)!.provider;
      // A finished 5-hour period does not stand in for a weekly one still in progress.
      const binding = bindingWindow(periods);
      const counted = periods.filter((period) => period.windowId === binding);
      const finished = counted.filter((period) => end(period) !== null);
      if (finished.length) {
        ended.push({
          provider,
          percent: mean(finished.map((period) => period.peak)),
          periods: finished.length,
          coverage: finished.map((period) => coverage(period, end(period)!)),
        });
        continue;
      }
      const running = counted.find((period) => end(period) === null);
      if (running) current.push({ provider, percent: running.peak, periods: 0, coverage: [] });
    }
    const since = (
      this.db
        .prepare("SELECT MIN(first_at) AS at FROM quota_periods WHERE window_id NOT LIKE 'cursor-grant:%'")
        .get() as { at: number | null }
    ).at;
    const combine = (results: AccountResult[], basis: 'ended' | 'current'): QuotaUtilizationFigure => {
      const coverages = results.flatMap((result) => result.coverage);
      return {
        basis,
        percent: Math.round(mean(results.map((result) => result.percent))),
        accounts: results.length,
        periods: results.reduce((sum, result) => sum + result.periods, 0),
        partial: coverages.length > 0 && mean(coverages) < thinCoverage,
      };
    };
    const overall = ended.length ? combine(ended, 'ended') : current.length ? combine(current, 'current') : undefined;
    if (!overall) return undefined;
    const providers = [...new Set([...ended, ...current].map((result) => result.provider))];
    return {
      ...overall,
      byProvider: providers.map((provider) => {
        const own = ended.filter((result) => result.provider === provider);
        return {
          provider,
          ...(own.length
            ? combine(own, 'ended')
            : combine(
                current.filter((result) => result.provider === provider),
                'current',
              )),
        };
      }),
      since: new Date(since ?? now).toISOString(),
    };
  }

  /**
   * Per account window, how fast its periods that ended in the last 30 days got used, for the waste estimate. Only
   * the card's latest login counts. A period PugPort stopped seeing before it ended may have been used more, so it
   * counts for less.
   */
  burnRates(): BurnRates {
    const now = this.now();
    const bucket = Math.floor(now / minute);
    if (this.burnCached?.version === this.version && this.burnCached.minute === bucket) return this.burnCached.value;
    const value = this.computeBurn(now);
    this.burnCached = { version: this.version, minute: bucket, value };
    return value;
  }

  private computeBurn(now: number): BurnRates {
    const rows = (
      this.db
        .prepare('SELECT * FROM quota_periods WHERE COALESCE(ended_at, resets_at) >= ? ORDER BY id')
        .all(now - lookback) as Row[]
    ).map(fromRow);
    const byWindow = new Map<string, Period[]>();
    for (const row of rows) {
      const key = burnKey(row.runtimeId, row.windowId);
      byWindow.set(key, [...(byWindow.get(key) ?? []), row]);
    }
    const result = new Map<string, WindowBurn>();
    for (const [key, periods] of byWindow) {
      const account = [...periods].reverse().find((period) => period.account)?.account ?? '';
      const own = periods.filter((period) => !period.account || !account || period.account === account);
      let used = 0;
      let seen = 0;
      for (const period of own) {
        const end = period.endedAt ?? (period.resetsAt <= now ? period.resetsAt : null);
        if (end === null) continue;
        const start = periodStart(period);
        // An early reset makes a period shorter; a window that slid before it started does not make it longer.
        const length =
          period.durationMinutes === null ? end - start : Math.min(end - start, period.durationMinutes * minute);
        if (length < hour) continue;
        const share = Math.max(0, Math.min(1, (Math.min(period.lastAt, end) - start) / (end - start)));
        used += (period.peak / (length / hour)) * share;
        seen += share;
      }
      const live = this.open.get(key);
      const open = live && live.resetsAt > now && own.some((period) => period.id === live.id) ? live : undefined;
      if (!seen && !open) continue;
      result.set(key, {
        account,
        perHour: seen ? used / seen : 0,
        periods: seen,
        ...(open
          ? {
              current: {
                since: open.firstAt,
                resetsAt: open.resetsAt,
                ...(open.windowId.startsWith('cursor-grant:') && open.firstUsed !== null
                  ? { firstUsed: open.firstUsed }
                  : {}),
              },
            }
          : {}),
      });
    }
    return result;
  }
}

/** A period starts a full length before its reset, or at the first reading when the length is unknown or it slid. */
function periodStart(period: Period): number {
  return period.durationMinutes === null
    ? period.firstAt
    : Math.min(period.firstAt, period.resetsAt - period.durationMinutes * minute);
}

/** The longest window (unknown lengths last); of equally long ones, the one used most on average. */
function bindingWindow(periods: Period[]): string | undefined {
  const windows = new Map<string, { length: number; peaks: number[] }>();
  for (const period of periods) {
    const entry = windows.get(period.windowId) ?? { length: -1, peaks: [] };
    entry.length = Math.max(entry.length, period.durationMinutes ?? -1);
    entry.peaks.push(period.peak);
    windows.set(period.windowId, entry);
  }
  return [...windows.entries()].sort(([, a], [, b]) => b.length - a.length || mean(b.peaks) - mean(a.peaks))[0]?.[0];
}

/**
 * The share of a period PugPort saw, from its first reading to its last. A period starts a full length before
 * its reset (or at the first reading when the length is unknown or the window had not started).
 */
function coverage(period: Period, end: number): number {
  const start = periodStart(period);
  const length = end - start;
  if (length <= 0) return 1;
  return Math.max(0, Math.min(1, (Math.min(period.lastAt, end) - period.firstAt) / length));
}
