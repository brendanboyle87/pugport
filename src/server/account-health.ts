import { nativeCliProviders } from '../shared/provider-registry.ts';
import type { DatabaseSync } from 'node:sqlite';
import type { Provider, RunRecord, RuntimeSnapshot, RuntimeTarget } from '../shared/types.ts';
import type { AccountAvailability, AccountRequestFailure } from '../shared/accounts.ts';
import { grokBuildBillingMessage, observedGrokBuildBalanceFailure } from './grok-billing-failure.ts';

export type AccountHealthEntry = {
  runtimeId: string;
  provider: Provider;
  accountFingerprint?: string;
  reason: AccountAvailability['reason'];
  observedAt: string;
  retryAt?: string;
  runId: string;
  /** Actual Build request evidence, kept separately from an advisory percentage. */
  billingSource?: 'grok-build';
  billingFailure?: AccountRequestFailure;
  /** Consecutive Build 402s on this account since its last completed run or billing period end. */
  billingStreak?: number;
  /** Billing period end seen with the latest 402; once it passes the next 402 starts a new streak. */
  billingResetAt?: string;
  /** Latest completed run on this account after its Build 402. It does not end the current wait. */
  succeededAt?: string;
};
type Identity = { runtimeId: string; provider: Provider; accountFingerprint?: string };
type Fingerprinted = { accountFingerprint?: string };
type Availability = AccountAvailability;
type HealthSnapshot = RuntimeSnapshot & Fingerprinted & { availability?: Availability };
const nativeProviders = new Set<Provider>(nativeCliProviders);
const fallbackDelayMs = 60_000;
/** How long after a quota cooldown ends the account is still reported as recovering (see member-allocation). */
const recoveryWindowMs = 60 * 60_000;
/** Repeated Build 402s on one account wait longer each time: 15 min, 1 h, 4 h, then 24 h. */
const billingProbeDelaysMs = [15 * 60_000, 60 * 60_000, 4 * 60 * 60_000, 24 * 60 * 60_000];
const fingerprint = (value: string | undefined) =>
  typeof value === 'string' && value.trim() && value.length <= 256 ? value : undefined;
const identityOf = (target: { id: string; provider: Provider } & Fingerprinted): Identity => ({
  runtimeId: target.id,
  provider: target.provider,
  ...(fingerprint(target.accountFingerprint) ? { accountFingerprint: fingerprint(target.accountFingerprint) } : {}),
});
const keyOf = (identity: Identity) =>
  identity.accountFingerprint
    ? `account:${identity.provider}:${identity.accountFingerprint}`
    : `runtime:${identity.provider}:${identity.runtimeId}`;
const runtimeKey = (identity: Identity) => keyOf({ runtimeId: identity.runtimeId, provider: identity.provider });
function billingFailure(run: RunRecord, at: number): AccountRequestFailure | undefined {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(run.id)) return;
  const model = run.effectiveModel?.model ?? run.route.model;
  const ended = Date.parse(run.endedAt ?? run.startedAt);
  return {
    runId: run.id,
    ...(/^[a-zA-Z0-9._:/-]{1,256}$/.test(model) ? { model } : {}),
    at: new Date(Number.isFinite(ended) ? ended : at).toISOString(),
    source: 'Grok Build ACP',
    statusCode: 402,
    errorCode: 'quota-or-rate-limit',
    message: grokBuildBillingMessage,
  };
}

// Independent TypeScript implementation. Method references (both MIT):
// Magpie 84f001da08281/internal/gateway/routing.go restAfter distinguishes quota
// from transient rate limits; CLIProxyAPI 4a2c81864f31/sdk/cliproxy/auth/selector.go
// availabilityBlock separates credential identity from per-request selection.
// Here cooldown is a dispatch gate persisted by PugPort, not a second proxy.
export class AccountHealth {
  private readonly identities = new Map<string, Identity>();
  constructor(
    private readonly db: DatabaseSync,
    private readonly now: () => number = Date.now,
  ) {
    db.exec(
      'CREATE TABLE IF NOT EXISTS native_account_health (health_key TEXT PRIMARY KEY, runtime_id TEXT NOT NULL, value TEXT NOT NULL)',
    );
  }
  /** Drops everything remembered about an account that has been cleared out for good. */
  forget(runtimeId: string) {
    this.identities.delete(runtimeId);
    this.db.prepare('DELETE FROM native_account_health WHERE runtime_id=?').run(runtimeId);
  }
  private get(key: string): AccountHealthEntry | undefined {
    const row = this.db.prepare('SELECT value FROM native_account_health WHERE health_key=?').get(key) as
      { value: string } | undefined;
    return row ? (JSON.parse(row.value) as AccountHealthEntry) : undefined;
  }
  /** Backfill only an existing billing observation from its exact archived run. */
  enrichExistingEvidence(readRun: (runId: string) => RunRecord | undefined): number {
    const entries = this.db
      .prepare(
        "SELECT health_key,value FROM native_account_health WHERE json_extract(value,'$.billingSource')='grok-build' AND json_extract(value,'$.billingFailure') IS NULL",
      )
      .all() as { health_key: string; value: string }[];
    let enriched = 0;
    for (const row of entries) {
      try {
        const entry = JSON.parse(row.value) as AccountHealthEntry;
        if (entry.provider !== 'grok' || !/^[a-zA-Z0-9_-]{1,128}$/.test(entry.runId)) continue;
        const run = readRun(entry.runId);
        if (
          !run ||
          run.id !== entry.runId ||
          run.route.runtimeId !== entry.runtimeId ||
          run.status !== 'failed' ||
          run.errorCode !== 'quota-or-rate-limit' ||
          !observedGrokBuildBalanceFailure(run) ||
          (run.account?.provider !== 'grok' &&
            !run.events.some(
              (event) =>
                event.data?.source === 'native' &&
                event.data?.kind === 'billing-exhausted' &&
                (event.data?.detail as { provider?: unknown } | undefined)?.provider === 'grok',
            ))
        )
          continue;
        const diagnostic = billingFailure(run, this.now());
        if (!diagnostic) continue;
        // Preserve the row's identity, observation, runId and exact retry time.
        this.db
          .prepare('UPDATE native_account_health SET value=? WHERE health_key=?')
          .run(JSON.stringify({ ...entry, billingFailure: diagnostic }), row.health_key);
        enriched++;
      } catch {
        // Missing/corrupt history supplies no new evidence and cannot alter the latch.
      }
    }
    return enriched;
  }
  /** A completed run after a Build 402 restarts its escalation; only a fresh probe ends the current wait. */
  private succeeded(target: RuntimeTarget & Fingerprinted, run: RunRecord): void {
    if (
      target.environment !== 'native' ||
      target.gateway ||
      !nativeProviders.has(target.provider) ||
      run.route.runtimeId !== target.id
    )
      return;
    const ended = Date.parse(run.endedAt ?? '');
    const at = Number.isFinite(ended) ? ended : this.now();
    const identity = identityOf(target);
    for (const key of new Set([keyOf(identity), runtimeKey(identity)])) {
      const entry = this.get(key);
      if (!entry?.billingFailure || !(at > Date.parse(entry.billingFailure.at))) continue;
      this.db
        .prepare('UPDATE native_account_health SET value=? WHERE health_key=?')
        .run(JSON.stringify({ ...entry, billingStreak: 0, succeededAt: new Date(at).toISOString() }), key);
    }
  }
  failure(target: RuntimeTarget & Fingerprinted, run: RunRecord, snapshot?: RuntimeSnapshot): void {
    if (run.status === 'completed') return this.succeeded(target, run);
    const errorCode = run.errorCode ?? run.error;
    if (
      target.environment !== 'native' ||
      target.gateway ||
      !nativeProviders.has(target.provider) ||
      run.status !== 'failed' ||
      run.route.runtimeId !== target.id ||
      !['quota-or-rate-limit', 'authentication-required'].includes(errorCode ?? '')
    )
      return;
    const identity = identityOf(target),
      key = keyOf(identity),
      previous = this.get(key);
    const billing = target.provider === 'grok' && observedGrokBuildBalanceFailure(run);
    const diagnostic = billing ? billingFailure(run, this.now()) : previous?.billingFailure;
    this.identities.set(target.id, identity);
    // An authentication failure is latched until an explicit successful check clears it.
    // Replaying the same failed run must not move its retry time after a restart.
    if (
      (previous?.reason === 'authentication' && errorCode !== 'authentication-required') ||
      (previous?.runId === run.id &&
        previous.reason === (errorCode === 'authentication-required' ? 'authentication' : 'quota'))
    ) {
      // Replaying a known failure can enrich old observations without moving
      // the already persisted cooldown or claiming restored capacity.
      if (
        previous &&
        diagnostic &&
        (!previous.billingFailure ||
          (billing && (!previous.billingSource || previous.billingFailure.runId !== diagnostic.runId)))
      )
        this.db.prepare('UPDATE native_account_health SET value=? WHERE health_key=?').run(
          JSON.stringify({
            ...previous,
            ...(billing ? { billingSource: 'grok-build' } : {}),
            billingFailure: diagnostic,
          }),
          key,
        );
      return;
    }
    const at = this.now(),
      reason = errorCode === 'authentication-required' ? 'authentication' : 'quota';
    const entry: AccountHealthEntry = { ...identity, reason, observedAt: new Date(at).toISOString(), runId: run.id };
    if (billing || previous?.billingSource === 'grok-build') entry.billingSource = 'grok-build';
    if (diagnostic) entry.billingFailure = diagnostic;
    // Other failures of this account keep the 402 escalation state.
    if (previous?.billingStreak) entry.billingStreak = previous.billingStreak;
    if (previous?.billingResetAt) entry.billingResetAt = previous.billingResetAt;
    // A later authentication fault must not erase the independently observed
    // billing cooldown when login metadata succeeds again.
    if (reason === 'authentication' && entry.billingSource && previous?.retryAt) entry.retryAt = previous.retryAt;
    if (reason === 'quota') {
      const snapshotIdentity = (snapshot as (RuntimeSnapshot & Fingerprinted) | undefined)?.accountFingerprint;
      const sameIdentity = !identity.accountFingerprint || identity.accountFingerprint === snapshotIdentity;
      const matching =
        sameIdentity &&
        snapshot?.id === target.id &&
        snapshot.provider === target.provider &&
        snapshot.quota.status === 'known';
      // This gate applies to the entire account, so only shared limits can establish a long
      // cooldown. Independent model pools remain enforced by routing against fresh quota;
      // even a failure in the exhausted pool must not lock its funded siblings until reset.
      const windows = matching
        ? snapshot.quota.windows.filter((window) => !window.modelPool && !window.modelFamily)
        : [];
      const resetTimes = windows.flatMap((window) => {
        const reset = Date.parse(window.resetsAt ?? '');
        return typeof window.usedPercent === 'number' &&
          Number.isFinite(window.usedPercent) &&
          window.usedPercent >= 100 &&
          Number.isFinite(reset) &&
          reset > at
          ? [reset]
          : [];
      });
      let billingRetry = 0;
      if (billing) {
        // Each further 402 waits longer, until a completed run or the end of the billing period.
        const periodEnds = windows.flatMap((window) => {
          const reset = Date.parse(window.resetsAt ?? '');
          return Number.isFinite(reset) && reset > at ? [reset] : [];
        });
        const periodEnd = periodEnds.length ? Math.min(...periodEnds) : undefined;
        const lastPeriodEnd = Date.parse(previous?.billingResetAt ?? '');
        const streak = (Number.isFinite(lastPeriodEnd) && lastPeriodEnd <= at ? 0 : (previous?.billingStreak ?? 0)) + 1;
        entry.billingStreak = streak;
        // Without a fresh reading, keep an earlier period end only while it still lies ahead.
        if (periodEnd !== undefined) entry.billingResetAt = new Date(periodEnd).toISOString();
        else if (!(lastPeriodEnd > at)) delete entry.billingResetAt;
        billingRetry = at + billingProbeDelaysMs[Math.min(streak, billingProbeDelaysMs.length) - 1]!;
        // A new billing period may restore the balance: probe then, but never sooner than the first wait.
        if (periodEnd !== undefined && periodEnd < billingRetry)
          billingRetry = Math.max(at + billingProbeDelaysMs[0]!, periodEnd);
      }
      const previousRetry = previous?.reason === 'quota' ? Date.parse(previous.retryAt ?? '') : Number.NaN;
      entry.retryAt = new Date(
        Math.max(
          billing ? billingRetry : resetTimes.length ? Math.max(...resetTimes) : at + fallbackDelayMs,
          Number.isFinite(previousRetry) && previousRetry > at ? previousRetry : 0,
        ),
      ).toISOString();
    }
    this.db
      .prepare(
        'INSERT INTO native_account_health(health_key,runtime_id,value) VALUES(?,?,?) ON CONFLICT(health_key) DO UPDATE SET runtime_id=excluded.runtime_id,value=excluded.value',
      )
      .run(key, target.id, JSON.stringify(entry));
  }
  apply(snapshot: RuntimeSnapshot & Fingerprinted): RuntimeSnapshot {
    if (snapshot.environment !== 'native' || !nativeProviders.has(snapshot.provider)) return snapshot;
    // API credentials belong to this runtime, not a previously observed ChatGPT
    // subscription. Keep API failures while ignoring stale subscription health.
    const apiKey = snapshot.provider === 'codex' && snapshot.authMode === 'apiKey';
    let identity: Identity = apiKey ? { runtimeId: snapshot.id, provider: snapshot.provider } : identityOf(snapshot);
    if (!apiKey && !identity.accountFingerprint) {
      const remembered = this.identities.get(snapshot.id);
      const persisted = (
        this.db.prepare('SELECT value FROM native_account_health WHERE runtime_id=?').all(snapshot.id) as {
          value: string;
        }[]
      )
        .map((row) => JSON.parse(row.value) as AccountHealthEntry)
        .filter((value) => value.provider === snapshot.provider && value.accountFingerprint)
        .sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt))[0];
      const previous =
        remembered?.provider === snapshot.provider && remembered.accountFingerprint ? remembered : persisted;
      if (previous?.accountFingerprint) identity = { ...identity, accountFingerprint: previous.accountFingerprint };
    }
    this.identities.set(snapshot.id, identity);
    // An earlier error without identity still belongs to this runtime only; do not
    // spread it to other accounts merely because a later discovery learns a hash.
    const entries = [
      this.get(keyOf(identity)),
      identity.accountFingerprint ? this.get(runtimeKey(identity)) : undefined,
    ].filter((entry): entry is AccountHealthEntry => !!entry);
    const auth = entries.find((entry) => entry.reason === 'authentication');
    const quota = entries
      .filter((entry) => entry.reason === 'quota' && Date.parse(entry.retryAt ?? '') > this.now())
      .sort((a, b) => Date.parse(b.retryAt!) - Date.parse(a.retryAt!))[0];
    const entry = auth ?? quota;
    const {
      availability: _previous,
      lastRequestFailure: _lastFailure,
      cooldownEndedAt: _ended,
      ...clean
    } = snapshot as HealthSnapshot;
    // A cooldown that ended within the hour: routing lets the account take sub-tasks back one at a time.
    const ended = entries
      .filter((value) => value.reason === 'quota')
      .map((value) => Date.parse(value.retryAt ?? ''))
      .filter((at) => Number.isFinite(at) && at <= this.now() && this.now() - at < recoveryWindowMs)
      .sort((a, b) => b - a)[0];
    if (ended !== undefined && !entry) (clean as HealthSnapshot).cooldownEndedAt = new Date(ended).toISOString();
    const latest = entries
      .filter((value) => value.billingFailure)
      .sort((a, b) => Date.parse(b.billingFailure!.at) - Date.parse(a.billingFailure!.at))[0];
    const lastRequestFailure =
      latest?.billingFailure &&
      (Date.parse(latest.succeededAt ?? '') > Date.parse(latest.billingFailure.at)
        ? { ...latest.billingFailure, laterSuccessAt: latest.succeededAt }
        : latest.billingFailure);
    const observed = lastRequestFailure ? { ...clean, lastRequestFailure } : clean;
    if (!entry) return observed;
    const availability: Availability = {
      reason: entry.reason,
      observedAt: entry.observedAt,
      ...(entry.retryAt ? { retryAt: entry.retryAt } : {}),
      ...(entry.billingFailure ? { billingFailure: entry.billingFailure } : {}),
    };
    return {
      ...observed,
      availability,
    } as HealthSnapshot;
  }
  /** Explicit account metadata can clear authentication, not prove Build balance recovery. */
  clear(runtimeId: string): void {
    const identity = this.identities.get(runtimeId);
    // Before this process has observed an identity, checks affect only failures
    // recorded on this runtime, never every account of the provider.
    const keys = identity
      ? [...new Set([keyOf(identity), runtimeKey(identity)])]
      : (
          this.db.prepare('SELECT health_key FROM native_account_health WHERE runtime_id=?').all(runtimeId) as {
            health_key: string;
          }[]
        ).map((row) => row.health_key);
    for (const key of keys) {
      const entry = this.get(key);
      // Checking metadata never proves a request fault recovered. Even after
      // its cooldown ends, retain the last actual failure as historical evidence.
      if (entry?.billingSource === 'grok-build') {
        if (entry.reason === 'authentication')
          this.db
            .prepare('UPDATE native_account_health SET value=? WHERE health_key=?')
            .run(JSON.stringify({ ...entry, reason: 'quota' }), key);
      } else this.db.prepare('DELETE FROM native_account_health WHERE health_key=?').run(key);
    }
  }
  /** Includes expired quota observations as history; expiration does not prove replenishment. */
  report(): AccountHealthEntry[] {
    return (this.db.prepare('SELECT value FROM native_account_health ORDER BY health_key').all() as { value: string }[])
      .map((row) => JSON.parse(row.value) as AccountHealthEntry)
      .filter((entry) => nativeProviders.has(entry.provider));
  }
}
