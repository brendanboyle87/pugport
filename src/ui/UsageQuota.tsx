import { currentLocale } from './i18n';
import { ExecutorActivity } from './ExecutorActivity';
import { apiCreditPace, type ApiProviderView } from '../shared/api-providers';
import type { ReactNode } from 'react';
import type { RuntimeSnapshot } from '../shared/types';
import {
  quotaBars,
  quotaBarWindows,
  quotaOverviewWindows,
  quotaPlan,
  quotaReadingPending,
} from '../shared/quota-summary';
import { quotaPeriodLabel, quotaWindowLabel } from '../shared/quota-label';
import { webResetLabel } from '../shared/external-agents';
import { accountExecutionStatus } from './AccountQuotaDiagnostics';
import { shownName, translateInterfaceText, withNames } from './i18n';

export const compactQuotaLabel = (label: string) =>
  /^(Cursor Models|Cursor 模型)$/i.test(label) ? 'Cursor' : quotaWindowLabel(label);

const day = 86_400_000;
const usd = (value: number) => `$${value.toFixed(2)}`;
export const quotaTone = (left?: number) =>
  left === undefined ? 'unknown' : left <= 10 ? 'danger' : left <= 30 ? 'warning' : 'healthy';

export function quotaConnectionLabel(note?: string): string | undefined {
  if (!note) return undefined;
  return (
    (
      {
        'runtime-timeout': '检查超时',
        'runtime-network-error': '网络错误',
        'runtime-process-closed': '连接已关闭',
        'runtime-request-failed': '检查失败',
        'runtime-protocol-incompatible': '版本不兼容',
        'runtime-not-found': '未安装',
        'authentication-required': '需要登录',
      } as Record<string, string>
    )[note] ?? (/^runtime-/.test(note) ? '连接异常' : note)
  );
}

export function compactResetLabel(at: string | null | undefined, now: number) {
  const days = (Date.parse(at ?? '') - now) / day;
  const countdown =
    days <= 0
      ? '已到重置时间，待刷新'
      : days === 1
        ? '1 天后重置'
        : days > 1
          ? `${Math.ceil(days)} 天后重置`
          : webResetLabel(at, now);
  return countdown;
}

export function ExpiryChip({
  at,
  now,
  label,
  amount,
  urgentOnly = false,
}: {
  at?: string | null;
  now: number;
  label: string;
  amount?: number | null;
  urgentOnly?: boolean;
}) {
  const days = (Date.parse(at ?? '') - now) / day;
  if (!Number.isFinite(days) || (urgentOnly && (days <= 0 || days >= 7))) return null;
  return (
    <span
      className={`usage-chip${days < 7 ? ' expiry-warning' : ''}${label === '活动赠金' ? ' grant-chip' : ''}`}
      title={at ?? undefined}
    >
      {label} {days <= 0 ? '已到期' : days <= 1 ? '1 天内到期' : `${Math.ceil(days)} 天后到期`}
      {typeof amount === 'number' ? ` · ${usd(amount)}` : ''}
    </span>
  );
}

export function QuotaAttention({
  runtime,
  now,
  compact = false,
}: {
  runtime: RuntimeSnapshot;
  now: number;
  compact?: boolean;
}) {
  const credits = runtime.quota.resetCredits;
  const expired = (credits?.details ?? []).filter(
    (card) => card.status === 'available' && card.expiresAt && Date.parse(card.expiresAt) <= now,
  ).length;
  const count =
    credits?.availableCount === null || credits?.availableCount === undefined
      ? undefined
      : Math.max(0, credits.availableCount - expired);
  return (
    <div className="usage-chips">
      {compact && count !== undefined && count > 0 && <span className="usage-chip">重置卡 {count}</span>}
      {runtime.quota.cursorCredits?.grants.map((grant, index) => (
        <ExpiryChip
          key={`grant-${index}`}
          at={grant.expiresAt}
          now={now}
          label="活动赠金"
          amount={compact ? grant.remainingUsd : undefined}
        />
      ))}
      {(credits?.details ?? [])
        .filter((card) => card.status === 'available')
        .map((card, index) => (
          <ExpiryChip key={`reset-${index}`} at={card.expiresAt} now={now} label="重置卡" urgentOnly />
        ))}
    </div>
  );
}

export function UsageBar({
  label,
  account,
  left,
  reset,
  resetTitle,
  trackOnly = false,
  stale = false,
}: {
  label: string;
  /** Shown as written: shownName(label) for an account, the translated name for a built-in one. */
  account?: string;
  left?: number;
  reset?: string;
  resetTitle?: string;
  trackOnly?: boolean;
  stale?: boolean;
}) {
  const tone = quotaTone(left);
  return (
    <div
      className={`quota-window ${tone}`}
      style={stale ? { opacity: 0.55 } : undefined}
      title={stale ? '上次读数' : undefined}
    >
      {!trackOnly && (
        <div className="quota-window-heading">
          <span>{label}</span>
          <strong translate="no">
            {withNames(left === undefined ? '未知' : '剩余 {0}%', left === undefined ? [] : [String(left)])}
          </strong>
        </div>
      )}
      <div
        className={`quota-track ${left === undefined ? 'unknown-track' : ''}`}
        role={left === undefined ? undefined : 'progressbar'}
        data-names
        aria-label={withNames('{0} {1}剩余额度', [account ?? '', translateInterfaceText(label)]).trim()}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={left}
      >
        {left !== undefined && <span style={{ width: `${left}%` }} />}
      </div>
      {reset && (
        <span className="reset-time" title={resetTitle}>
          {reset}
        </span>
      )}
    </div>
  );
}

export function CompactQuotaSlots({
  name,
  plan,
  readings,
  main,
  chips,
  activity,
}: {
  /** Shown as written: shownName(label) for an account, the translated name for a built-in one. */
  name: string;
  plan?: string;
  readings: { label: string; left?: number; reset?: string; resetTitle?: string; stale?: boolean }[];
  main?: string;
  chips?: ReactNode;
  activity?: ReactNode;
}) {
  const columns = { gridTemplateColumns: `repeat(${Math.max(1, readings.length)}, minmax(0, 1fr))` };
  return (
    <div className="compact-quota-slots">
      <div className="quota-heading compact-slot-header">
        <h3 title={name} translate="no">
          {name}
        </h3>
        {plan && (
          <span className="plan-badge" title={plan}>
            {plan}
          </span>
        )}
      </div>
      <div className="compact-slot-activity">{activity}</div>
      <div className="compact-slot-main" style={main ? undefined : columns}>
        {main ? (
          <span title={main}>{main}</span>
        ) : (
          readings.map((reading, index) => (
            <div
              className={`compact-reading ${quotaTone(reading.left)}`}
              key={index}
              style={reading.stale ? { opacity: 0.55 } : undefined}
              title={reading.stale ? '上次读数' : undefined}
            >
              <span title={reading.label}>{reading.label}</span>
              <strong>{reading.left === undefined ? '未知' : `${reading.left}%`}</strong>
            </div>
          ))
        )}
      </div>
      <div className="compact-slot-bars" style={columns}>
        {readings.map((reading, index) => (
          <div key={index}>
            {reading.left !== undefined && (
              <UsageBar label={reading.label} account={name} left={reading.left} trackOnly stale={reading.stale} />
            )}
          </div>
        ))}
      </div>
      <div className="compact-slot-reset">
        {readings.map((reading, index) => (
          <span key={index} title={reading.resetTitle}>
            {reading.reset}
          </span>
        ))}
      </div>
      <div className="compact-slot-chips usage-chips">{chips}</div>
    </div>
  );
}

export function CompactQuotaCard({
  runtime: live,
  now,
  maxAge,
  onOpen,
}: {
  runtime: RuntimeSnapshot;
  now: number;
  maxAge: number;
  onOpen: (from: DOMRect) => void;
}) {
  const reference = live.quota.status !== 'known' && live.lastKnownQuota?.status === 'known';
  const runtime = reference ? { ...live, quota: live.lastKnownQuota! } : live;
  const known = runtime.quota.status === 'known';
  const pending = quotaReadingPending(runtime);
  const windows = known ? runtime.quota.windows : [];
  const shares = quotaOverviewWindows({ ...runtime, quota: { ...runtime.quota, windows } }).flatMap((window) =>
    window.usedPercent === null ? [] : [Math.max(0, Math.round(100 - window.usedPercent))],
  );
  const tightest = shares.length ? Math.min(...shares) : undefined;
  const bars = quotaBars(windows, tightest);
  const selected = quotaBarWindows(windows, tightest);
  const stale =
    reference ||
    [runtime.quota.observedAt, ...windows.map((window) => window.observedAt)].some(
      (at) => at && (!Number.isFinite(Date.parse(at)) || Date.parse(at) > now || now - Date.parse(at) >= maxAge * 1000),
    );
  const error =
    accountExecutionStatus(live, now) ||
    (live.quota.status === 'error'
      ? quotaConnectionLabel(live.quota.note) || '额度读取失败'
      : live.status === 'error' ||
          live.status === 'auth-required' ||
          live.status === 'missing' ||
          live.note?.startsWith('runtime-')
        ? quotaConnectionLabel(live.note) || '连接异常'
        : live.lastConnectionTest?.ok === false
          ? quotaConnectionLabel(live.lastConnectionTest.error) || '实际请求失败'
          : undefined);
  return (
    <article
      className="quota-card compact-quota-card"
      data-runtime-id={runtime.id}
      role="button"
      tabIndex={0}
      aria-label={withNames('{0} 额度详情', [shownName(runtime.label)])}
      data-names
      aria-haspopup="dialog"
      onClick={(event) => onOpen(event.currentTarget.getBoundingClientRect())}
      onKeyDown={(event) => {
        if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault();
          onOpen(event.currentTarget.getBoundingClientRect());
        }
      }}
    >
      <CompactQuotaSlots
        activity={
          <ExecutorActivity
            id={runtime.id}
            error={
              live.availability?.reason === 'quota' && !['error', 'auth-required', 'missing'].includes(live.status)
                ? undefined
                : error
            }
            idle={error || '就绪'}
          />
        }
        name={shownName(runtime.label)}
        plan={quotaPlan(runtime)?.label ?? '订阅'}
        main={pending ? '正在读取额度…' : known && runtime.quota.unlimited ? '不限量' : undefined}
        readings={
          pending || (known && runtime.quota.unlimited)
            ? []
            : bars.map((left, index) => ({
                label: selected[index] ? compactQuotaLabel(quotaPeriodLabel(selected[index])) : '额度',
                left,
                reset: compactResetLabel(selected[index]?.resetsAt, now),
                resetTitle: selected[index]?.resetsAt
                  ? new Date(selected[index].resetsAt!).toLocaleString(currentLocale())
                  : undefined,
                stale,
              }))
        }
        chips={
          <>
            <QuotaAttention runtime={runtime} now={now} compact />
            {error && (
              <span className="usage-chip usage-error" title={error}>
                {error}
              </span>
            )}
          </>
        }
      />
    </article>
  );
}

export function ApiQuotaCard({
  provider,
  runtime,
  now,
  compact = false,
  zoomable = false,
  onOpen,
  spend,
  linkedRuntime,
}: {
  provider: ApiProviderView;
  runtime?: RuntimeSnapshot;
  /** Looks up the subscription account a recurring credit is linked to. */
  linkedRuntime?: (id: string) => RuntimeSnapshot | undefined;
  now: number;
  compact?: boolean;
  zoomable?: boolean;
  onOpen?: (from: DOMRect) => void;
  spend?: number | null;
}) {
  const budget = runtime?.apiBudgetState ?? provider.budget;
  const pacing = apiCreditPace(budget, now);
  const limit = budget?.policy.limitUsd;
  const capped = typeof limit === 'number' && limit > 0;
  const expired = budget?.phase === 'expired' || Date.parse(budget?.policy.expiresAt ?? '') <= now;
  const left =
    capped && budget
      ? expired
        ? 0
        : Math.max(0, budget.remainingUsd ?? limit - budget.spentUsd - budget.reservedUsd)
      : undefined;
  const stopped = !!budget && (expired || budget.phase === 'exhausted');
  const monthly = budget?.policy.monthlyUsd;
  // A recurring credit is measured against its full monthly grant, not the (possibly partial) current period.
  const axis = monthly ?? limit;
  const leftPercent = left === undefined || !axis ? undefined : Math.round(Math.min(100, (left / axis) * 100));
  const amount = capped
    ? monthly
      ? `${usd(left ?? 0)} / ${usd(monthly)}`
      : `${usd(budget!.spentUsd)} / ${usd(limit)}`
    : undefined;
  const linked = budget?.policy.linkedAccountId ? linkedRuntime?.(budget.policy.linkedAccountId) : undefined;
  const linkedChip = budget?.policy.linkedAccountId && (
    <span className="usage-chip" title={linked?.subscription?.label}>
      <span translate="no">
        {withNames('{0} 会员赠金', [shownName(linked?.label ?? budget.policy.linkedAccountId)])}
      </span>
    </span>
  );
  const expiryChip =
    monthly && left !== undefined && !expired ? (
      <span className="usage-chip" title={budget.policy.expiresAt}>
        {compactResetLabel(budget.policy.expiresAt, now)} ·{' '}
        <span translate="no">{withNames('重置为 {0}', [usd(monthly)])}</span>
      </span>
    ) : monthly && expired ? (
      <span className="usage-chip expiry-warning">赠金暂停 · 等关联会员恢复</span>
    ) : (
      <ExpiryChip at={budget?.policy.expiresAt} now={now} label="API 额度" />
    );
  const error =
    provider.balance?.error ||
    (runtime && accountExecutionStatus(runtime, now)) ||
    (runtime && ['error', 'auth-required', 'missing'].includes(runtime.status)
      ? quotaConnectionLabel(runtime.note) || '连接异常'
      : undefined);
  return (
    <article
      className={`quota-card ${compact ? 'compact-quota-card' : ''}`}
      data-runtime-id={provider.targetId}
      role={onOpen || zoomable ? 'button' : undefined}
      tabIndex={onOpen || zoomable ? 0 : undefined}
      aria-label={onOpen || zoomable ? withNames('{0} 额度详情', [shownName(provider.label)]) : undefined}
      data-names
      aria-haspopup={onOpen || zoomable ? 'dialog' : undefined}
      onClick={
        onOpen
          ? (event) => {
              if (!(event.target as HTMLElement).closest('button, summary, a'))
                onOpen(event.currentTarget.getBoundingClientRect());
            }
          : undefined
      }
      onKeyDown={
        onOpen
          ? (event) => {
              if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) {
                event.preventDefault();
                onOpen(event.currentTarget.getBoundingClientRect());
              }
            }
          : undefined
      }
    >
      {compact ? (
        <CompactQuotaSlots
          activity={
            <ExecutorActivity
              id={provider.targetId}
              error={
                runtime?.availability?.reason === 'quota' &&
                !['error', 'auth-required', 'missing'].includes(runtime.status)
                  ? undefined
                  : error
              }
              idle={error || '就绪'}
            />
          }
          name={shownName(provider.label)}
          plan={capped ? 'API 额度' : 'API 按量计费'}
          main={
            capped
              ? `${monthly ? '本月剩余' : '已用'} ${amount}`
              : `本期消耗 ${spend === undefined || spend === null ? '未报告' : usd(spend)}`
          }
          readings={
            capped
              ? [
                  {
                    label: '额度',
                    left: leftPercent,
                  },
                ]
              : []
          }
          chips={
            <>
              {linkedChip}
              {expiryChip}
              {error && (
                <span className="usage-chip usage-error" title={error}>
                  {error}
                </span>
              )}
              {!!budget?.unreportedRuns && <span className="usage-chip">有调用未报告费用</span>}
            </>
          }
        />
      ) : (
        <>
          <div className="quota-heading">
            <div>
              <h3 translate="no">{shownName(provider.label)}</h3>
              <ExecutorActivity
                id={provider.targetId}
                error={
                  runtime?.availability?.reason === 'quota' &&
                  !['error', 'auth-required', 'missing'].includes(runtime.status)
                    ? undefined
                    : error
                }
                idle={error || '就绪'}
              />
            </div>
            <span className="plan-badge">{capped ? 'API 额度' : 'API 按量计费'}</span>
          </div>
          <div className="quota-body">
            <p className="api-usage-spend cursor-credit">
              <span>{capped ? (monthly ? '本月剩余' : '已用') : '本期消耗'}</span>
              <strong>{capped ? amount : spend === undefined || spend === null ? '未报告' : usd(spend)}</strong>
            </p>
            {capped && <UsageBar trackOnly label="额度" account={shownName(provider.label)} left={leftPercent} />}
            <div className="usage-chips">
              {linkedChip}
              {expiryChip}
              {error && (
                <span className="usage-chip usage-error" title={error}>
                  {error}
                </span>
              )}
              {!!budget?.unreportedRuns && <span className="usage-chip">有调用未报告费用</span>}
            </div>
          </div>
        </>
      )}
      {stopped && (
        <p className="panel-note">额度已用完或暂停：钉选时也不会按次计费。要按次付费，请在设置里清除额度。</p>
      )}
      {pacing && budget && !stopped && (
        <p className="panel-note">
          {`按计划应已用 $${pacing.plannedUsd.toFixed(2)}，实际 $${budget.spentUsd.toFixed(2)}`}
          {pacing.priority > 0 && <span> · 正在优先用掉</span>}
        </p>
      )}
      {!compact && (
        <footer className="quota-footer">
          <details className="quota-details">
            <summary>详情</summary>
            <p className="quota-note">费用为本机记录的美元估算，以平台账单为准。</p>
            {budget && (
              <p className="quota-note">
                统计起点：{new Date(budget.policy.startedAt).toLocaleString(currentLocale())} · 已预留{' '}
                {usd(budget.reservedUsd)}
              </p>
            )}
          </details>
        </footer>
      )}
    </article>
  );
}
