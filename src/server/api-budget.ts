import { z } from 'zod';
import { apiCreditPace, type ApiBudgetPolicy, type ApiBudgetView } from '../shared/api-providers.ts';

export const apiBudgetInput = z
  .object({
    limitUsd: z.number().finite().positive().max(1_000_000).optional(),
    expiresAt: z.string().datetime({ offset: true }).optional(),
    perRunUsd: z.number().finite().positive().max(10_000).default(1),
    maxConcurrentRuns: z.number().int().min(1).max(16).default(1),
    burstConcurrentRuns: z.number().int().min(1).max(16).default(4),
    preferExpiring: z.boolean().default(true),
    monthlyUsd: z.number().finite().positive().max(1_000_000).optional(),
    linkedAccountId: z.string().min(1).max(200).optional(),
    reset: z.boolean().optional(),
  })
  .strict()
  .refine((value) => value.burstConcurrentRuns >= value.maxConcurrentRuns, {
    message: '冲刺并发不能低于常态并发。',
  })
  .refine((value) => value.limitUsd === undefined || value.perRunUsd <= value.limitUsd, {
    message: '单次预留不能大于整个预算。',
  })
  .refine((value) => value.monthlyUsd === undefined || (value.expiresAt && value.perRunUsd <= value.monthlyUsd), {
    message: '每月续期赠金需要填下次续期日，且不能小于单次预留。',
  })
  .refine((value) => value.linkedAccountId === undefined || value.monthlyUsd !== undefined, {
    message: '只有每月续期赠金可以关联账号。',
  });

/** The plan a subscription account currently reports, e.g. 'Pro'; undefined when unknown. */
type PlanOf = (accountId: string) => string | undefined;
const paid = (plan: string | undefined) => !!plan && plan !== 'Free';

/** A linked account that now reports the free plan has lost its credit, before the renewal date too. */
export const linkedCreditLapsed = (policy: ApiBudgetPolicy, planOf: PlanOf) =>
  !!policy.linkedAccountId && planOf(policy.linkedAccountId) === 'Free';

export function apiBudgetPolicy(
  value: unknown,
  previous?: ApiBudgetPolicy,
  at = new Date().toISOString(),
  planOf: PlanOf = () => undefined,
): ApiBudgetPolicy {
  const { reset, ...policy } = apiBudgetInput.parse(value);
  const linked = policy.linkedAccountId;
  // Re-saving keeps an existing link even while the account is briefly unreadable.
  if (linked && linked !== previous?.linkedAccountId && !paid(planOf(linked)))
    throw new Error('关联的账号没有读到付费会员，暂时不能关联。');
  return {
    ...policy,
    ...(policy.limitUsd === undefined && policy.monthlyUsd ? { limitUsd: policy.monthlyUsd } : {}),
    startedAt: previous && !reset ? previous.startedAt : at,
  };
}

/** The same day next month in local time, clamped to the month's last day. */
function nextMonth(iso: string) {
  const date = new Date(iso);
  const day = date.getDate();
  date.setDate(1);
  date.setMonth(date.getMonth() + 1);
  // shortcut: a 29th-31st renewal drifts after a short month (Jan 31 → Feb 28 → Mar 28); the user can correct the date.
  date.setDate(Math.min(day, new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()));
  return date.toISOString();
}

/**
 * A monthly credit past its renewal starts a new period at the full monthly amount; unused credit does not roll over.
 * A linked account earns new credit only while it reports a paid plan (Pro, Plus…); until then the card stays expired.
 */
export function renewedApiBudget(
  policy: ApiBudgetPolicy,
  at: number,
  planOf: PlanOf = () => undefined,
): ApiBudgetPolicy | undefined {
  if (!policy.monthlyUsd || !policy.expiresAt || !(Date.parse(policy.expiresAt) <= at)) return;
  if (policy.linkedAccountId && !paid(planOf(policy.linkedAccountId))) return;
  let expiresAt = new Date(policy.expiresAt).toISOString();
  let startedAt = expiresAt;
  while (Date.parse(expiresAt) <= at) [startedAt, expiresAt] = [expiresAt, nextMonth(expiresAt)];
  return { ...policy, limitUsd: policy.monthlyUsd, startedAt, expiresAt };
}

export function apiBudgetView(
  policy: ApiBudgetPolicy,
  spentUsd: number,
  reservedUsd: number,
  unreportedRuns = 0,
  at = Date.now(),
  lapsed = false,
): ApiBudgetView {
  const expires = Date.parse(policy.expiresAt ?? '');
  const daysRemaining = Number.isFinite(expires) ? (expires - at) / 86_400_000 : undefined;
  const remainingUsd =
    policy.limitUsd === undefined ? undefined : Math.max(0, policy.limitUsd - spentUsd - reservedUsd);
  const phase =
    lapsed || (daysRemaining !== undefined && daysRemaining <= 0)
      ? 'expired'
      : remainingUsd !== undefined && remainingUsd + 1e-9 < policy.perRunUsd
        ? 'exhausted'
        : !policy.preferExpiring || daysRemaining === undefined || daysRemaining > 7
          ? 'normal'
          : daysRemaining < 1
            ? 'sprint'
            : daysRemaining <= 3
              ? 'accelerated'
              : 'priority';
  const concurrency =
    phase === 'sprint'
      ? policy.burstConcurrentRuns
      : phase === 'accelerated'
        ? Math.ceil((policy.maxConcurrentRuns + policy.burstConcurrentRuns) / 2)
        : policy.maxConcurrentRuns;
  return {
    policy,
    spentUsd,
    reservedUsd,
    unreportedRuns,
    phase,
    maxConcurrentRuns: concurrency,
    ...(remainingUsd === undefined ? {} : { remainingUsd }),
    ...(daysRemaining === undefined ? {} : { daysRemaining }),
  };
}

/** Automatic catch-up shares the same cap for new runs and parked runs. */
export function apiBudgetConcurrency(view: ApiBudgetView, automatic: boolean, now: number): number {
  const pace = automatic ? apiCreditPace(view, now) : undefined;
  const catchUp =
    pace && pace.priority > 0
      ? Math.min(view.policy.burstConcurrentRuns, 1 + Math.floor((pace.plannedUsd - view.spentUsd) / 20))
      : 0;
  const base = automatic && view.phase === 'normal' ? 1 : view.maxConcurrentRuns;
  const remaining = Math.min(
    view.remainingUsd ?? Infinity,
    (view.policy.limitUsd ?? Infinity) - view.spentUsd - view.reservedUsd,
  );
  return Math.max(
    0,
    Math.min(
      view.policy.burstConcurrentRuns,
      Math.max(base, catchUp),
      Math.floor((remaining + view.reservedUsd + 1e-9) / view.policy.perRunUsd),
    ),
  );
}

/**
 * No per-run cap: a run may spend whatever the card has left, other runs' reservations excluded. perRunUsd stays an
 * estimate for reservations and concurrency. A card without a limit still needs a finite number for Pi.
 */
export function apiRunCostLimit(view: ApiBudgetView, ownReservedUsd: number): number {
  return view.remainingUsd === undefined ? Number.MAX_SAFE_INTEGER : view.remainingUsd + ownReservedUsd;
}
