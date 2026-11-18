import { currentLocale } from './i18n';
import { providerNames } from '../shared/delegation';
import type { AppState, QuotaUtilization } from '../shared/types';

/*
 * "这个月": how well PugPort used what the user already pays for. Subscription quota utilization comes from the
 * server's quota history; the subscription/API split uses state already sent.
 * Parts with nothing to report stay hidden.
 */

const day = 86_400_000;
/** "$12", "$12.50", "$180"; amounts too small to show in cents are not rounded down to nothing. */
export function usd(value: number) {
  if (value > 0 && value < 0.01) return '<$0.01';
  if (value >= 100) return `$${Math.round(value)}`;
  return `$${value.toFixed(2).replace(/\.00$/, '')}`;
}
const shortDate = (at: number) =>
  new Date(at).toLocaleDateString(currentLocale(), { month: 'numeric', day: 'numeric' });
const monthStart = (now: number) => {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  date.setDate(1);
  return date.getTime();
};

function Track({ percent, label }: { percent: number; label: string }) {
  const value = Math.max(0, Math.min(100, percent));
  return (
    <div
      className="quota-track"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value)}
    >
      <span style={{ width: `${value}%` }} />
    </div>
  );
}

function Utilization({ figure, now }: { figure: QuotaUtilization; now: number }) {
  const ended = figure.basis === 'ended';
  const since = Date.parse(figure.since);
  const scope = ended
    ? [
        `近 30 天结束的 ${figure.periods} 个额度周期`,
        `${figure.accounts} 个账号`,
        Number.isFinite(since) && since > now - 30 * day ? `${shortDate(since)} 开始记录` : '',
      ]
    : ['还没有结束的周期，结束后才算出利用率'];
  const providers =
    figure.byProvider.length > 1
      ? figure.byProvider
          .map((item) =>
            item.basis === 'current' && ended
              ? `${providerNames[item.provider]} 进行中 ${item.percent}%`
              : `${providerNames[item.provider]} ${item.percent}%`,
          )
          .join(' · ')
      : '';
  return (
    <div
      title={[...scope, providers, figure.partial ? '有些周期 PugPort 没有全程看到，实际用得可能更多' : '']
        .filter(Boolean)
        .join(' · ')}
      tabIndex={0}
    >
      <dt>{ended ? '订阅额度利用率' : '订阅额度（本周期进行中）'}</dt>
      <dd>{ended ? `${figure.percent}%` : `已用 ${figure.percent}%`}</dd>
      <Track percent={figure.percent} label="订阅额度利用率" />
      <small>{ended ? `近 30 天 · ${figure.periods} 个周期` : '本周期进行中'}</small>
    </div>
  );
}

export function Savings({ state, now }: { state: AppState; now: number }) {
  const figure = state.quotaUtilization;
  const start = monthStart(now);
  const runs = (state.usage?.perRun ?? []).filter((run) => Date.parse(run.startedAt) >= start);
  const subscription = runs.filter((run) => run.accountingMode === 'subscription').length;
  const api = runs.filter((run) => run.accountingMode === 'usage');
  const unknown = runs.length - subscription - api.length;
  const priced = api.filter((run) => run.estimatedCostUsd !== null);
  const apiCost = priced.reduce((sum, run) => sum + run.estimatedCostUsd!, 0);
  if (!figure && !runs.length)
    return (
      <p className="quiet-text savings-empty">PugPort 记录到订阅额度和任务后，这里会显示这个月用掉了多少已付的额度。</p>
    );
  return (
    <section className="savings" aria-label="这个月">
      <h2>这个月</h2>
      <dl className="exec-stats">
        {figure && <Utilization figure={figure} now={now} />}
        {runs.length > 0 && (
          <div>
            <dt>任务分配</dt>
            <dd>{`${runs.length} 次执行`}</dd>
            <small
              title={[
                subscription === runs.length
                  ? '全部用已付的订阅额度'
                  : subscription
                    ? `${subscription} 次用已付的订阅额度`
                    : '',
                !api.length
                  ? ''
                  : !priced.length
                    ? `${api.length} 次走 API，费用未报告`
                    : `${api.length} 次走 API，估算 ${usd(apiCost)}${priced.length < api.length ? `（${api.length - priced.length} 次未报告费用）` : ''}`,
                unknown ? `${unknown} 次计费类型未确认` : '',
              ]
                .filter(Boolean)
                .join(' · ')}
            >
              {`订阅 ${subscription} 次 · 按量 ${api.length} 次${unknown ? ` · 未确认 ${unknown} 次` : ''}`}
            </small>
          </div>
        )}
      </dl>
    </section>
  );
}
