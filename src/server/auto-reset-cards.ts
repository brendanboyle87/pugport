import type { RuntimeSnapshot, Settings } from '../shared/types.ts';
import { quotaWindowReservePercent } from '../shared/quota-reserve.ts';
import { availableResetCards } from './quota-waste.ts';

/** Owner's rule: a card no waiting work needs is used in its last ten minutes, once any usage has been spent. */
const lastCallMs = 10 * 60_000;
/** From fifteen minutes before, the account is read every minute so that last call is not missed. */
const watchMs = 15 * 60_000;
const watchEveryMs = 60_000;

/** The card's last minutes: it is used then even while the account runs a task. */
export const lastCall = (card: { expiresAt?: string | null }, now: number) =>
  Date.parse(card.expiresAt ?? '') - now <= lastCallMs;

/** A failure before the redemption request was sent: no card can have been spent, so it may be tried again. */
export const markNotSent = (error: unknown) =>
  Object.assign(error instanceof Error ? error : new Error(String(error)), { resetNotSent: true });
const notSent = (error: unknown) => (error as { resetNotSent?: boolean } | undefined)?.resetNotSent === true;

/** An account whose next usable card enters its last fifteen minutes and was last read a minute or more ago. */
export function cardRefreshDue(snapshot: RuntimeSnapshot, now: number): boolean {
  const card = availableResetCards(snapshot, now).find((value) => value.key);
  return (
    !!card && Date.parse(card.expiresAt!) - now <= watchMs && !(now - Date.parse(snapshot.refreshedAt) < watchEveryMs)
  );
}

export function autoResetCard(
  snapshot: RuntimeSnapshot,
  settings: Pick<Settings, 'autoUseResetCards' | 'maxQuotaAgeSeconds' | 'reservePercent'>,
  now: number,
  waiting = false,
) {
  if (
    settings.autoUseResetCards !== true ||
    snapshot.authMode !== 'chatgpt' ||
    snapshot.environment !== 'native' ||
    snapshot.gateway ||
    !snapshot.accountFingerprint ||
    !snapshot.installed ||
    snapshot.status !== 'ready' ||
    snapshot.availability?.reason === 'authentication' ||
    snapshot.quota.status !== 'known'
  )
    return;
  const fresh = (at: string | null | undefined) => {
    const age = now - Date.parse(at ?? '');
    return age >= 0 && age < settings.maxQuotaAgeSeconds * 1000;
  };
  if (!fresh(snapshot.quota.observedAt) || !fresh(snapshot.quota.resetCredits?.observedAt)) return;
  const card = availableResetCards(snapshot, now).find((value) => value.key);
  if (!card) return;
  const windows = snapshot.quota.windows.filter(
    (window) =>
      typeof window.usedPercent === 'number' &&
      Number.isFinite(window.usedPercent) &&
      window.usedPercent >= 0 &&
      window.usedPercent <= 100 &&
      fresh(window.observedAt ?? snapshot.quota.observedAt) &&
      (!window.resetsAt || Date.parse(window.resetsAt) > now),
  );
  const used = Math.max(...windows.map((window) => window.usedPercent!));
  // Waiting work redeems at the reserve line routing stops at, not only at 100%.
  const atReserve = windows.some(
    (window) => 100 - window.usedPercent! <= quotaWindowReservePercent(window, snapshot.quota, settings, now),
  );
  // Otherwise routing spends the account down first, and the card goes in its last minutes if anything was used.
  if ((waiting && atReserve) || (lastCall(card, now) && used > 0)) return card;
}

/** Used only to ask the normal router whether waiting work would select this account after a reset. */
export function afterReset(snapshot: RuntimeSnapshot): RuntimeSnapshot {
  return {
    ...snapshot,
    availability: snapshot.availability?.reason === 'quota' ? undefined : snapshot.availability,
    quota: {
      ...snapshot.quota,
      windows: snapshot.quota.windows.map((window) => ({
        ...window,
        usedPercent:
          typeof window.usedPercent === 'number' &&
          Number.isFinite(window.usedPercent) &&
          window.usedPercent >= 0 &&
          window.usedPercent <= 100
            ? 0
            : window.usedPercent,
      })),
    },
  };
}

export type AutoResetRecord = {
  key: string;
  startedAt: number;
  finishedAt?: number;
  waitingForQuota: boolean;
  notes: string[];
};

/** Persist the latch before sending a request: a restart or an uncertain response must not spend another card. */
export class AutoResetCards {
  private busy = new Set<string>();
  constructor(
    readonly records: Record<string, AutoResetRecord>,
    private save: () => void,
    private now: () => number,
  ) {}

  observe(snapshot: RuntimeSnapshot, readStartedAt: number) {
    const record = this.records[snapshot.accountFingerprint ?? ''];
    const after = record?.finishedAt ?? record?.startedAt;
    if (
      record?.waitingForQuota &&
      !this.busy.has(snapshot.accountFingerprint!) &&
      after !== undefined &&
      readStartedAt > after &&
      snapshot.quota.status === 'known' &&
      Date.parse(snapshot.quota.observedAt ?? '') > after &&
      Date.parse(snapshot.quota.resetCredits?.observedAt ?? '') > after
    ) {
      record.waitingForQuota = false;
      this.save();
    }
  }

  async use(snapshot: RuntimeSnapshot, key: string, expiresAt: string, redeem: () => Promise<{ outcome: string }>) {
    const identity = snapshot.accountFingerprint!;
    const previous = this.records[identity];
    if (this.busy.has(identity) || previous?.waitingForQuota || previous?.key === key) return false;
    this.busy.add(identity);
    const record: AutoResetRecord = {
      key,
      startedAt: this.now(),
      waitingForQuota: true,
      notes: previous?.notes ?? [],
    };
    this.records[identity] = record;
    let unsent = false;
    try {
      this.save();
      const result = await redeem();
      if (result.outcome === 'reset' || result.outcome === 'alreadyRedeemed') {
        const minutes = Math.max(1, Math.ceil((Date.parse(expiresAt) - record.startedAt) / 60_000));
        record.notes = [
          ...record.notes,
          minutes < 60
            ? `已自动用掉 1 张重置卡（原本 ${minutes} 分钟后到期）`
            : `已自动用掉 1 张重置卡（原本 ${Math.ceil(minutes / 60)} 小时后到期）`,
        ];
      }
    } catch (error) {
      // Nothing was sent: restore the previous latch so the next reading can try again before the card expires.
      unsent = notSent(error);
      if (!unsent) record.notes = [...record.notes, '自动用卡结果未确认，请刷新额度和卡片后核对。'];
    } finally {
      if (!unsent) record.finishedAt = this.now();
      else if (previous) this.records[identity] = previous;
      else delete this.records[identity];
      this.busy.delete(identity);
      this.save();
    }
    return !unsent;
  }
}
