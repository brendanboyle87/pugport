import { quotaWindowsForModel } from '../shared/cursor-models.ts';
import { automaticExecutorAllowed } from '../shared/automatic-executors.ts';
import { windowName } from '../shared/quota-summary.ts';
import { isShortQuotaWindow, quotaWindowReservePercent } from '../shared/quota-reserve.ts';
import type { ApiBudgetView } from '../shared/api-providers.ts';
import type { QuotaWindow, RuntimeSnapshot, Settings } from '../shared/types.ts';
import { accountKey, burnKey, cursorGrantWindowId, type BurnRates, type WindowBurn } from './quota-history.ts';

/*
 * Predicted waste: how much of what an account has left will still be unused when it resets, at the pace it is
 * usually used. Smart scoring (stage 3 of docs/ROUTING-RULES-DESIGN.md) prefers such quota among candidates that
 * already passed every filter, rule, capability and reserve check. Pure and synchronous: quota history supplies the
 * periods that ended, the snapshot the one under way. The pace includes the work PugPort itself sent there, so
 * sending more to a wasteful account lowers its estimate.
 */

const minute = 60_000;
const hour = 60 * minute;
/** Below this much predicted waste (percent) nothing is called wasteful; larger amounts compare in steps of it. */
export const wasteStep = 10;

export type QuotaWaste = {
  /** Window percentage points or credit percent; ordinary window estimates are damped for thin evidence. */
  percent: number;
  /** Percent left now, and when it resets or expires. */
  left: number;
  resetAt: number;
  /** "周额度", "Cursor Models 额度". */
  what: string;
  /** An API credit or Cursor grant, in dollars. */
  usd?: { left: number; unused: number };
  cards?: { count: number; expiresAt: number; percent: number };
};

/** Predicted unused percentage points per hour remaining; ignore noise and expired resources. */
export function wasteUrgency(waste: Pick<QuotaWaste, 'percent' | 'resetAt'> | undefined, now: number): number {
  return waste && waste.percent >= wasteStep && waste.resetAt > now
    ? waste.percent / Math.max((waste.resetAt - now) / hour, 1)
    : 0;
}

/** One period's worth of evidence is trusted half, three periods three quarters. */
const trust = (evidence: number) => evidence / (evidence + 1);
export const quotaName = (window: QuotaWindow) => {
  const name = windowName(window);
  return /^[一-鿿]/.test(name) ? `${name}额度` : `${name} 额度`;
};

/** The same weighted pace and confidence for both window waste and reset-card forecasts. */
function windowPace(window: QuotaWindow, burn: WindowBurn | undefined, now: number) {
  const used = window.usedPercent!;
  const resetAt = Date.parse(window.resetsAt!);
  const hoursLeft = (resetAt - now) / hour;
  const length = window.durationMinutes && window.durationMinutes > 0 ? window.durationMinutes * minute : undefined;
  let sum = 0;
  let evidence = 0;
  if (burn && burn.periods > 0) {
    sum += burn.perHour * burn.periods;
    evidence += burn.periods;
  }
  // The period under way: its own pace so far, counted by how much of it has passed. Without a known length it
  // starts at PugPort's first reading, which can only make the pace look faster.
  const start = length
    ? resetAt - length
    : burn?.current && Math.abs(burn.current.resetsAt - resetAt) <= 10 * minute
      ? burn.current.since
      : undefined;
  if (start !== undefined && start < now) {
    const elapsed = (now - start) / hour;
    const share = length ? Math.min(1, (now - start) / length) : elapsed / (elapsed + hoursLeft);
    sum += (used / elapsed) * share;
    evidence += share;
  }
  if (!evidence) return undefined;
  return { perHour: sum / evidence, confidence: trust(evidence) };
}

function windowEstimate(window: QuotaWindow, burn: WindowBurn | undefined, now: number, inFlight: number) {
  const used = window.usedPercent!;
  const resetAt = Date.parse(window.resetsAt!);
  const length = window.durationMinutes && window.durationMinutes > 0 ? window.durationMinutes * minute : undefined;
  // A window nobody has touched may not have started (Codex starts it at first use): waiting loses nothing.
  if (used <= 0 && (!length || resetAt - now >= length - 10 * minute)) return 0;
  const pace = windowPace(window, burn, now);
  if (!pace) return undefined;
  const left = Math.max(0, 100 - used - inFlight);
  return Math.max(0, left - pace.perHour * ((resetAt - now) / hour)) * pace.confidence;
}

type CardAccount = Pick<RuntimeSnapshot, 'id' | 'accountFingerprint'> &
  Partial<Pick<RuntimeSnapshot, 'provider' | 'quota'>>;

/** Only known, live Codex cards count, never the summary count or an unknown reset kind. */
export function availableResetCards(snapshot: CardAccount, now: number) {
  return snapshot.provider === 'codex'
    ? (snapshot.quota?.resetCredits?.details ?? [])
        .filter((card) => card.kind === 'full' && card.status === 'available' && Date.parse(card.expiresAt ?? '') > now)
        .sort((a, b) => Date.parse(a.expiresAt!) - Date.parse(b.expiresAt!))
    : [];
}

function ownBurn(snapshot: CardAccount, window: Pick<QuotaWindow, 'id'>, burn: BurnRates | undefined) {
  const account = accountKey(snapshot.accountFingerprint);
  const history = burn?.get(burnKey(snapshot.id, window.id));
  return history && (!history.account || !account || history.account === account) ? history : undefined;
}

/** Forecast expiring card capacity at each deadline, without counting future cards as already due. */
function cardWaste(
  snapshot: CardAccount,
  windows: QuotaWindow[],
  burn: BurnRates | undefined,
  now: number,
  inFlight: number,
) {
  const available = availableResetCards(snapshot, now);
  if (!available.length || !windows.length) return;
  let best: { count: number; expiresAt: number; percent: number } | undefined;
  for (const expiresAt of new Set(available.map((card) => Date.parse(card.expiresAt!)))) {
    const cards = available.filter((card) => Date.parse(card.expiresAt!) <= expiresAt);
    const hoursLeft = (expiresAt - now) / hour;
    // A session window refills every few hours: it limits speed, not what the cards add.
    const long = windows.filter((window) => !isShortQuotaWindow(window));
    if (!long.length) return;
    const forecasts = long.map((window) => {
      const pace = windowPace(window, ownBurn(snapshot, window, burn), now);
      const resetAt = Date.parse(window.resetsAt ?? '');
      const length = window.durationMinutes && window.durationMinutes > 0 ? window.durationMinutes * minute : 0;
      // Each natural reset before the cards expire brings another full window.
      const resets = resetAt < expiresAt ? 1 + (length ? Math.floor((expiresAt - resetAt) / length) : 0) : 0;
      if (
        !pace ||
        !Number.isFinite(pace.perHour) ||
        pace.perHour < 0 ||
        !(resetAt > now) ||
        window.usedPercent === null ||
        !Number.isFinite(window.usedPercent) ||
        window.usedPercent < 0 ||
        window.usedPercent > 100
      )
        return;
      return Math.max(
        0,
        100 - window.usedPercent - inFlight + (cards.length + resets) * 100 - pace.perHour * hoursLeft,
      );
    });
    // A full reset restores every window; count it once, conservatively against the smallest estimate.
    if (forecasts.some((value) => value === undefined)) return;
    const percent = Math.min(cards.length * 100, ...(forecasts as number[]));
    const result = { count: cards.length, expiresAt, percent };
    if (
      percent > 0 &&
      (!best ||
        wasteUrgency({ percent, resetAt: expiresAt }, now) >
          wasteUrgency({ percent: best.percent, resetAt: best.expiresAt }, now))
    )
      best = result;
  }
  return best;
}

/**
 * Subscription quota a model draws on. Windows resetting within an hour of each other each
 * cap what can still be used before that reset, so the smallest estimate counts, and a window with no evidence caps
 * it at what it has left. `inFlight` (percent) is what PugPort has running there now; it counts as used.
 */
export function windowWaste(
  snapshot: CardAccount,
  windows: QuotaWindow[],
  burn: BurnRates | undefined,
  now: number,
  inFlight = 0,
): QuotaWaste | undefined {
  const timed = windows.filter(
    (window) =>
      typeof window.usedPercent === 'number' &&
      window.usedPercent >= 0 &&
      window.usedPercent <= 100 &&
      Date.parse(window.resetsAt ?? '') > now,
  );
  if (!timed.length) return;
  const groups: QuotaWindow[][] = [];
  for (const window of [...timed].sort((a, b) => Date.parse(a.resetsAt!) - Date.parse(b.resetsAt!))) {
    const group = groups.at(-1);
    if (group && Date.parse(window.resetsAt!) - Date.parse(group[0]!.resetsAt!) <= hour) group.push(window);
    else groups.push([window]);
  }
  let best: QuotaWaste | undefined;
  for (const group of groups) {
    let measured = false;
    let result: QuotaWaste | undefined;
    for (const window of group) {
      const estimate = windowEstimate(window, ownBurn(snapshot, window, burn), now, inFlight);
      measured ||= estimate !== undefined;
      const left = 100 - window.usedPercent!;
      const percent = estimate ?? Math.max(0, left - inFlight);
      if (!result || percent < result.percent)
        result = { percent, left, resetAt: Date.parse(window.resetsAt!), what: quotaName(window) };
    }
    if (measured && result && (!best || wasteUrgency(result, now) > wasteUrgency(best, now))) best = result;
  }
  const cards = cardWaste(snapshot, windows, burn, now, inFlight);
  if (cards) {
    const result = { percent: cards.percent, left: cards.count * 100, resetAt: cards.expiresAt, what: '重置卡', cards };
    if (!best || wasteUrgency(result, now) > wasteUrgency(best, now)) best = result;
  }
  return best;
}

/**
 * A time-limited API credit: what is left, less what spending at its pace since the budget started would use before
 * it expires. Pay-as-you-go money, a prepaid amount with no expiry, or a budget opted out of expiry urgency never
 * counts: waiting loses none of it.
 */
export function creditWaste(budget: ApiBudgetView | undefined, now: number): QuotaWaste | undefined {
  const limit = budget?.policy.limitUsd;
  const expires = Date.parse(budget?.policy.expiresAt ?? '');
  const started = Date.parse(budget?.policy.startedAt ?? '');
  if (!budget || !limit || !budget.policy.preferExpiring || !(expires > now) || !(started < now)) return;
  if (budget.phase === 'expired' || budget.phase === 'exhausted') return;
  const left = budget.remainingUsd ?? Math.max(0, limit - budget.spentUsd - budget.reservedUsd);
  const elapsed = now - started;
  // The credit's whole life is one period: the share of it seen so far is the evidence.
  const unused =
    Math.max(0, left - (budget.spentUsd / elapsed) * (expires - now)) * trust(elapsed / (expires - started));
  return {
    percent: (unused / limit) * 100,
    left: (left / limit) * 100,
    resetAt: expires,
    what: '赠金',
    usd: { left, unused },
  };
}

/** Cursor grants have no start date: use their first reading, with the same thin-evidence damping as API credits. */
export function cursorGrantWaste(snapshot: RuntimeSnapshot, now: number, burn?: BurnRates): QuotaWaste | undefined {
  if (snapshot.provider !== 'cursor' || snapshot.quota.status !== 'known') return;
  const observed = Date.parse(snapshot.quota.observedAt ?? '');
  if (!Number.isFinite(observed) || observed > now) return;
  let total = 0;
  let left = 0;
  let unused = 0;
  let resetAt = Infinity;
  for (const grant of snapshot.quota.cursorCredits?.grants ?? []) {
    const expires = Date.parse(grant.expiresAt ?? '');
    const limit = grant.totalUsd;
    const remaining = grant.remainingUsd;
    if (
      !(expires > now) ||
      limit === null ||
      !Number.isFinite(limit) ||
      limit <= 0 ||
      remaining === null ||
      !Number.isFinite(remaining) ||
      remaining <= 0 ||
      remaining > limit
    )
      continue;
    const history = ownBurn(snapshot, { id: cursorGrantWindowId(grant) }, burn);
    const current = history?.current?.resetsAt === expires ? history.current : undefined;
    // Legacy rows have no baseline. Use only the latest reading as evidence until a new period is recorded.
    const start = current?.firstUsed !== undefined ? current.since : observed;
    const elapsed = now - start;
    const used = ((limit - remaining) / limit) * 100;
    const observedSpent = current?.firstUsed !== undefined ? (Math.max(0, used - current.firstUsed) * limit) / 100 : 0;
    total += limit;
    left += remaining;
    resetAt = Math.min(resetAt, expires);
    if (elapsed > 0)
      unused +=
        Math.max(0, remaining - (observedSpent / elapsed) * (expires - now)) * trust(elapsed / (expires - start));
  }
  if (!total) return;
  return { percent: (unused / total) * 100, left: (left / total) * 100, resetAt, what: '赠金', usd: { left, unused } };
}

const dollars = (value: number) => `$${value >= 10 ? Math.round(value) : value.toFixed(2)}`;

/** 「今天」「明天」「后天」「5 天后」 by local calendar days; under half a day, the hours. */
export function whenText(at: number, now: number): string {
  const hours = (at - now) / hour;
  if (hours < 12) return `约 ${Math.max(1, Math.round(hours))} 小时后`;
  const midnight = (value: number) => new Date(value).setHours(0, 0, 0, 0);
  const days = Math.round((midnight(at) - midnight(now)) / (24 * hour));
  return days <= 0 ? '今天' : days === 1 ? '明天' : days === 2 ? '后天' : `${days} 天后`;
}

/** 「Codex 周额度后天重置，还剩 60%，按平时用量会剩约 40% 用不掉，先用它」 */
export function wasteReason(label: string, waste: QuotaWaste, now: number): string {
  if (waste.cards)
    return `${label} 有 ${waste.cards.count} 张重置卡${waste.cards.count > 1 ? '（截至' : ' '}${whenText(waste.cards.expiresAt, now)}到期${waste.cards.count > 1 ? '）' : ''}，按平时用量到时还用不上，先多用它`;
  const text = whenText(waste.resetAt, now);
  const when = /^\d/.test(text) ? ` ${text}` : text;
  return waste.usd
    ? `${label} 赠金${when}到期，还剩 ${dollars(waste.usd.left)}，按平时用量约 ${dollars(waste.usd.unused)} 会用不掉，先用它`
    : `${label} ${waste.what}${when}重置，还剩 ${Math.round(waste.left)}%，按平时用量会剩约 ${Math.round(waste.percent)}% 用不掉，先用它`;
}

export type WastingAccount = {
  runtimeId: string;
  label: string;
  /** A model that draws on the wasteful quota; absent for account-wide credits and grants. */
  model?: string;
  waste: QuotaWaste;
  reason: string;
};

/**
 * For background work that can run on any account (a later feature distils memory on such quota): the accounts whose
 * quota would go to waste if left unused, most first. Only ready accounts with fresh readings above the reserve line
 * count; the work itself still goes through route(), which applies every rule.
 */
export function wastingAccounts(
  snapshots: readonly RuntimeSnapshot[],
  burn: BurnRates | undefined,
  settings: Pick<Settings, 'reservePercent' | 'maxQuotaAgeSeconds' | 'excludedExecutors'>,
  now: number,
): WastingAccount[] {
  const found: WastingAccount[] = [];
  for (const s of snapshots) {
    if (!s.installed || !s.capabilities.execute || s.status !== 'ready') continue;
    if (!automaticExecutorAllowed({ automaticExecutorSelection: true }, settings, s.id)) continue;
    const retry = Date.parse(s.availability?.retryAt ?? '');
    if (s.availability?.reason === 'authentication' || (s.availability?.reason === 'quota' && !(retry <= now)))
      continue;
    let best: { model?: string; waste: QuotaWaste } | undefined;
    const credit = creditWaste(s.apiBudgetState, now);
    if (credit) best = { waste: credit };
    else if (
      s.quota.status === 'known' &&
      Date.parse(s.quota.observedAt ?? '') <= now &&
      now - Date.parse(s.quota.observedAt ?? '') < settings.maxQuotaAgeSeconds * 1000
    ) {
      const grant = cursorGrantWaste(s, now, burn);
      for (const model of s.models) {
        const windows = quotaWindowsForModel(s.quota, model, s.provider);
        if (
          (!windows.length && !s.quota.unlimited) ||
          windows.some((w) => {
            const observed = Date.parse(w.observedAt ?? s.quota.observedAt ?? '');
            return (
              !(observed <= now) ||
              now - observed >= settings.maxQuotaAgeSeconds * 1000 ||
              w.usedPercent === null ||
              !Number.isFinite(w.usedPercent) ||
              w.usedPercent < 0 ||
              w.usedPercent > 100 ||
              100 - w.usedPercent <= quotaWindowReservePercent(w, s.quota, settings, now) ||
              !(Date.parse(w.resetsAt ?? '') > now || (w.resetsAt === null && w.resetNotReported === true))
            );
          })
        )
          continue;
        const waste = windowWaste(s, windows, burn, now);
        if (waste && (!best || wasteUrgency(waste, now) > wasteUrgency(best.waste, now)))
          best = { model: model.id, waste };
        if (grant && (!best || wasteUrgency(grant, now) > wasteUrgency(best.waste, now))) best = { waste: grant };
      }
    }
    if (best && best.waste.percent >= wasteStep)
      found.push({
        runtimeId: s.id,
        label: s.label,
        ...(best.model ? { model: best.model } : {}),
        waste: best.waste,
        reason: wasteReason(s.label, best.waste, now).replace(/，先多?用它$/, ''),
      });
  }
  return found.sort((a, b) => wasteUrgency(b.waste, now) - wasteUrgency(a.waste, now));
}
