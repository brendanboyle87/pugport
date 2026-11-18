import { useState, type CSSProperties } from 'react';
import type { SpendOverview, SpendAccount } from '../shared/spend-ledger';
import { executorColors, number, percent } from './charts/UsageCharts';
import { currentLocale, translateInterfaceText as tr, withNames } from './i18n';

const money = (v: number | null | undefined) =>
  v == null ? '—' : '$' + v.toLocaleString(currentLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const count = (v: number, kind: 'run' | 'subtask' | 'handoff') => {
  const one = new Intl.PluralRules(currentLocale()).select(v) === 'one';
  const keys = {
    run: one ? '{0} 次运行（单数）' : '{0} 次运行',
    subtask: one ? '{0} 个子任务（单数）' : '{0} 个子任务',
    handoff: one ? '{0} 次交接（单数）' : '{0} 次交接',
  };
  return withNames(keys[kind], [String(v)]);
};
const date = (value: string | null) =>
  value ? new Date(value).toLocaleDateString(currentLocale(), { month: 'short', day: 'numeric' }) : tr('未报告');
const groups = { usage: '按次计费', credit: '会过期的赠金', subscription: '订阅额度', unknown: '未知计费类型' };
function leftText(row: SpendAccount) {
  const left = row.left;
  if (!left || left.kind === 'unreported') return tr('未报告');
  if (left.kind === 'quota')
    return `${percent(left.leftPercent)} · ${left.resetNotReported ? tr('未报告重置时间') : date(left.resetsAt)}`;
  if (left.phase === 'expired') return tr('已过期');
  return left.noCap
    ? tr('未设上限')
    : `${money(left.remainingUsd)} · ${left.expiresAt ? date(left.expiresAt) : tr('无到期时间')}`;
}
export function SpendLedger({
  data,
  onAccount,
  onDay,
  onInspect,
  onPrefer,
}: {
  data: SpendOverview;
  onAccount: (key: string) => void;
  onDay: (key: string, day: string) => void;
  onInspect: (id: string) => void;
  onPrefer: (id: string) => Promise<void>;
}) {
  const [sort, setSort] = useState<'billed' | 'runs'>('billed');
  const [confirm, setConfirm] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [focus, setFocus] = useState([0, 55]);
  const focusRow = Math.min(focus[0], Math.max(0, data.accounts.length - 1));
  const [tooltip, setTooltip] = useState('');
  const { summary } = data.insights;
  const ids = data.options.runtimes.map((r) => r.id).sort();
  const color = (row: SpendAccount) => executorColors[Math.min(6, Math.max(0, ids.indexOf(row.runtimes[0]?.id ?? '')))];
  const quota = data.kpis.tightestQuota,
    credit = data.kpis.lapse,
    balance = data.kpis.creditLeft;
  const tiles = [
    [
      '实际计费',
      money(summary.spendUsd),
      withNames('{0} 次按量运行 · {1} 次未报告费用', [
        String(summary.coverage.usageRuns),
        String(data.insights.tiles.spend.missing),
      ]),
    ],
    [
      credit ? '可能过期' : '赠金余额',
      money(credit?.lapseUsd ?? balance?.remainingUsd ?? null),
      credit ? `${credit.label} · ${date(credit.endsAt)}` : (balance?.label ?? tr('无即将到期的赠金')),
    ],
    [
      '最紧额度',
      percent(quota?.leftPercent ?? null),
      quota ? `${quota.label} · ${date(quota.resetsAt)}` : tr('未报告'),
    ],
    ['订阅参考价', money(summary.subscriptionReferenceUsd), tr('按 API 价格估算 · 不计入账单')],
    [
      '单任务',
      money(summary.costPerSuccessfulTask),
      withNames('仅计实际费用 · {0} 个已完成任务', [String(summary.successfulTasks)]),
    ],
  ];
  const maxima = Object.fromEntries(
    Object.keys(groups).map((group) => [
      group,
      Math.max(
        1,
        ...data.accounts
          .filter((a) => a.group === group)
          .flatMap((a) =>
            a.cells.map((c) =>
              group === 'subscription' || group === 'unknown' ? (c?.runs ?? 0) : (c?.billedUsd ?? 0),
            ),
          ),
      ),
    ]),
  );
  const now = Date.parse(data.generatedAt),
    horizon = 14 * 86400000;
  const position = (at: string | null) => Math.max(0, Math.min(100, ((Date.parse(at ?? '') - now) / horizon) * 100));
  const tasks = [...(sort === 'runs' ? data.insights.tasksByRuns : data.insights.tasks)].sort((a, b) =>
    sort === 'runs' ? b.runs - a.runs : (b.billedUsd ?? -1) - (a.billedUsd ?? -1),
  );
  return (
    <>
      <div className="spend-kpis">
        {tiles.map(([title, value, note], i) => (
          <article key={title} className={i === 1 && credit ? 'warning' : ''}>
            <h2>{title}</h2>
            <strong>{value}</strong>
            <p title={note}>{note}</p>
          </article>
        ))}
      </div>
      {data.insights.tiles.spend.missing > 0 && <p className="insight-partial-page">部分数据 · 仅统计已报告的样本</p>}
      <section className="spend-panel">
        <header>
          <h2>按账号记账</h2>
          <span>
            少 <i className="spend-scale" /> 多
          </span>
        </header>
        <p className="spend-note">最近 56 个本地自然日；按量格按美元、订阅格按运行数着色。本期合计遵循上方筛选。</p>
        {!summary.runs && <p className="insight-empty">此时间范围内没有运行记录</p>}
        <div className="spend-ledger-scroll">
          <div className="spend-grid">
            <div className="spend-grid-head">
              <span>账号</span>
              <div className="spend-dates">
                {data.days.map((day, i) => (
                  <span key={day}>{i % 14 === 0 || i === 55 ? day.slice(5) : ''}</span>
                ))}
              </div>
              <span>本期合计</span>
              <span>余量 · 重置</span>
            </div>
            {Object.entries(groups).map(([group, label]) => (
              <div key={group} className="spend-group">
                {data.accounts.some((a) => a.group === group) && <h3>{label}</h3>}
                {data.accounts.map((row, ri) =>
                  row.group !== group ? null : (
                    <div
                      key={row.key}
                      className="spend-account"
                      data-selected={data.filters.account === row.key}
                      style={{ '--account-color': color(row) } as CSSProperties}
                    >
                      <button
                        className="spend-account-name"
                        aria-pressed={data.filters.account === row.key}
                        onClick={() => onAccount(row.key)}
                      >
                        <i className={row.known ? '' : 'unknown'} />
                        <span translate="no">
                          {row.label}
                          <small>
                            {row.left?.kind === 'api'
                              ? (row.executionKind === 'cli' ? 'CLI · ' : row.executionKind === 'api' ? 'API · ' : '') +
                                (row.left.noCap
                                  ? tr('未设上限')
                                  : row.group === 'credit'
                                    ? tr('会过期的赠金')
                                    : money(row.left.limitUsd))
                              : 'CLI · ' + (row.left?.kind === 'quota' ? row.left.windowLabel : tr('未报告'))}
                          </small>
                        </span>
                      </button>
                      <div className="spend-cells" role="group" aria-label={row.label}>
                        {row.cells.map((cell, ci) => {
                          const value =
                            group === 'subscription' || group === 'unknown'
                              ? (cell?.runs ?? 0)
                              : (cell?.billedUsd ?? 0);
                          const tip = `${data.days[ci]} · ${row.label} · ${group === 'subscription' || group === 'unknown' ? number(cell?.runs ?? 0) : cell ? money(cell.billedUsd) : money(0)} · ${withNames('{0} 次运行 · {1} 个任务', [String(cell?.runs ?? 0), String(cell?.tasks ?? 0)])}${cell?.missingCost ? ' · ' + tr('费用未完整报告') : ''}`;
                          return (
                            <button
                              key={ci}
                              className="spend-cell"
                              data-today={ci === 55}
                              data-before={!cell && !!row.creditSince && data.days[ci] < row.creditSince}
                              data-missing={!!cell?.missingCost}
                              style={
                                {
                                  '--heat': value
                                    ? 0.18 +
                                      (0.82 * value) /
                                        (group === 'subscription' || group === 'unknown'
                                          ? Math.max(1, ...row.cells.map((c) => c?.runs ?? 0))
                                          : maxima[group])
                                    : 0,
                                } as CSSProperties
                              }
                              title={tip}
                              aria-label={tip}
                              tabIndex={focusRow === ri && focus[1] === ci ? 0 : -1}
                              onMouseEnter={() => setTooltip(tip)}
                              onFocus={() => {
                                setFocus([ri, ci]);
                                setTooltip(tip);
                              }}
                              onClick={() => onDay(row.key, data.days[ci])}
                              onKeyDown={(e) => {
                                const keys: Record<string, number[]> = {
                                  ArrowLeft: [ri, Math.max(0, ci - 1)],
                                  ArrowRight: [ri, Math.min(55, ci + 1)],
                                  ArrowUp: [Math.max(0, ri - 1), ci],
                                  ArrowDown: [Math.min(data.accounts.length - 1, ri + 1), ci],
                                };
                                if (keys[e.key]) {
                                  e.preventDefault();
                                  const [r, c] = keys[e.key];
                                  setFocus([r, c]);
                                  const root = e.currentTarget.closest('.spend-grid');
                                  root
                                    ?.querySelectorAll('.spend-account')
                                    [r]?.querySelectorAll<HTMLButtonElement>('.spend-cell')
                                    [c]?.focus();
                                }
                              }}
                            />
                          );
                        })}
                      </div>
                      <div className="spend-period">
                        <strong>
                          {row.group === 'subscription' || row.group === 'unknown'
                            ? count(row.period.runs, 'run')
                            : money(row.period.billedUsd)}
                        </strong>
                        {row.group !== 'subscription' && <small>{count(row.period.runs, 'run')}</small>}
                      </div>
                      <div className="spend-left">
                        {row.left && row.left.kind !== 'unreported' && (
                          <meter
                            min="0"
                            max="100"
                            value={
                              row.left.kind === 'quota'
                                ? row.left.leftPercent
                                : row.left.limitUsd
                                  ? (100 * (row.left.remainingUsd ?? 0)) / row.left.limitUsd
                                  : 0
                            }
                          />
                        )}
                        <small>{leftText(row)}</small>
                      </div>
                    </div>
                  ),
                )}
              </div>
            ))}
          </div>
        </div>
        <p className="spend-tooltip" role="status">
          {tooltip || tr('选择账号筛选全页，选择日期格查看当日调用。')}
        </p>
      </section>
      <div className="spend-columns">
        <section className="spend-panel">
          <h2>余量与到期</h2>
          <p className="spend-note">按最近 7 天速度推算未来 14 天。◆ 表示重置或到期；没有读数时不预测。</p>
          <div className="spend-runway-axis">
            <span>今天</span>
            <span>+7d</span>
            <span>+14d</span>
          </div>
          {data.runway.map((row) => (
            <div className="spend-runway-row" key={row.runtimeId}>
              <div translate="no">
                <b>{row.label}</b>
                <small>
                  {row.unit === 'usd' ? money(row.left) : percent(row.left)} ·{' '}
                  {row.pacePerDay === null
                    ? tr('缺少速度样本')
                    : withNames('{0} / 天', [row.unit === 'usd' ? money(row.pacePerDay) : percent(row.pacePerDay)])}
                </small>
                {row.plannedUsd !== null && (
                  <small>
                    {tr('按计划应已用 $')}
                    {row.plannedUsd.toFixed(2)}
                  </small>
                )}
              </div>
              <div className="spend-runway-track">
                {row.pacePerDay !== null && (
                  <i style={{ width: `${row.runsOutAt ? position(row.runsOutAt) : 100}%` }} />
                )}
                {(row.lapseUsd ?? 0) > 0 && row.endsAt && (
                  <i
                    className="spend-lapse"
                    style={{
                      left: `${position(row.endsAt)}%`,
                      width: `${Math.max(0, (row.runsOutAt ? position(row.runsOutAt) : 100) - position(row.endsAt))}%`,
                    }}
                  />
                )}
                {row.endsAt && (
                  <span style={{ left: `${position(row.endsAt)}%` }} title={date(row.endsAt)}>
                    ◆
                  </span>
                )}
              </div>
              <div className={row.outBeforeEnd || (row.lapseUsd ?? 0) > 0 ? 'warning' : ''}>
                {row.outBeforeEnd
                  ? tr('重置前用完')
                  : row.lapseUsd
                    ? withNames('{0} 可能过期', [money(row.lapseUsd)])
                    : row.runsOutAt
                      ? date(row.runsOutAt)
                      : tr('尚无法预测')}
                {row.kind === 'credit' && !row.preferExpiring && (
                  <button className="spend-link" onClick={() => setConfirm(row.runtimeId)}>
                    优先使用此赠金
                  </button>
                )}
              </div>
            </div>
          ))}
          {data.runwayUnreported.length > 0 && (
            <p className="spend-note">
              {withNames('{0} 未报告额度，不参与预测。', [data.runwayUnreported.map((r) => r.label).join(' · ')])}
            </p>
          )}
          {confirm && (
            <div className="spend-confirm" role="dialog" aria-label={tr('优先使用此赠金')}>
              <p>确认开启赠金优先？只影响符合条件的后续任务。</p>
              <button
                disabled={saving}
                className="button"
                onClick={() => {
                  setSaving(true);
                  setError('');
                  void onPrefer(confirm)
                    .then(() => setConfirm(undefined))
                    .catch((e) => setError(String(e)))
                    .finally(() => setSaving(false));
                }}
              >
                确认
              </button>
              <button className="button secondary" disabled={saving} onClick={() => setConfirm(undefined)}>
                取消
              </button>
              {error && <p role="alert">{error}</p>}
            </div>
          )}
        </section>
        <section className="spend-panel">
          <h2>花费构成</h2>
          <h3>按计费类型</h3>
          <div className="spend-mix">
            {Object.entries(data.billing).map(([kind, v]) => (
              <i
                key={kind}
                className={`mix-${kind}`}
                style={{ flex: v.runs }}
                title={tr(groups[kind as keyof typeof groups])}
              />
            ))}
          </div>
          {Object.entries(data.billing)
            .filter(([, v]) => v.runs)
            .map(([kind, v]) => (
              <p className="spend-mix-row" key={kind}>
                <span>{groups[kind as keyof typeof groups]}</span>
                <span>
                  {v.runs} · {percent(summary.runs ? (v.runs / summary.runs) * 100 : 0)}
                </span>
                <b>{kind === 'subscription' ? money(0) : money(v.billedUsd)}</b>
              </p>
            ))}
          <h3>项目实际费用</h3>
          {data.projects.slice(0, 8).map((p) => (
            <div className="spend-project" key={p.projectPath}>
              <span title={p.projectPath} translate="no">
                {p.projectPath.split(/[\\/]/).at(-1)}
              </span>
              <meter
                min="0"
                max={Math.max(1, ...data.projects.map((p) => p.billedUsd ?? 0))}
                value={p.billedUsd ?? 0}
              />
              <b>{money(p.billedUsd)}</b>
            </div>
          ))}
        </section>
      </div>
      <section className="spend-panel">
        <header>
          <h2>最贵的任务</h2>
          <div className="insight-segmented">
            <button aria-pressed={sort === 'billed'} onClick={() => setSort('billed')}>
              实际计费
            </button>
            <button aria-pressed={sort === 'runs'} onClick={() => setSort('runs')}>
              运行数
            </button>
          </div>
        </header>
        <div className="spend-tasks">
          {tasks.map((task) => (
            <article key={task.taskId}>
              <header>
                <h3 translate="no">{task.title}</h3>
                <b>{money(task.billedUsd)}</b>
              </header>
              <p translate="no">
                {task.projectPath.split(/[\\/]/).at(-1)} · {date(task.startedAt)}
              </p>
              <footer>
                <small>
                  {[
                    count(task.runs, 'run'),
                    task.subtasks ? count(task.subtasks, 'subtask') : '',
                    task.handoffs ? count(task.handoffs, 'handoff') : '',
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </small>
                <button className="spend-link" onClick={() => onInspect(task.traceWorkflowId)}>
                  打开轨迹 →
                </button>
              </footer>
            </article>
          ))}
        </div>
      </section>
    </>
  );
}
