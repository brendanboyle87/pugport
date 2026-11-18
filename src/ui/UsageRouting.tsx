import { useState } from 'react';
import type { UsageInsights } from '../shared/usage-insights';
import { ChartCard, TimeChart, gapNote, number, percent, seconds, type Series } from './charts/UsageCharts';
import { currentLocale, translateInterfaceText as tr, withNames } from './i18n';

type Routing = UsageInsights['routing'];
const outcomeLabels: Record<string, string> = {
  okLocal: '成功 · 本地 GPU',
  okCloud: '成功 · 云端',
  timeout: '已超时',
  warming: '预热中',
  busy: '繁忙',
  error: '错误',
  skipped: '已跳过 · 隐私',
  okUnknown: '成功 · 位置未知',
  skippedOther: '已跳过 · 其他',
};
const taskLabels: Record<string, string> = {
  conversation: '对话',
  coding: '编程',
  research: '研究',
  writing: '写作',
  translation: '翻译',
  data_analysis: '数据分析',
  media: '媒体',
  automation: '自动化',
  mixed: '混合任务',
  unclear: '不明确',
};
const difficultyLabels: Record<string, string> = {
  simple: '简单',
  standard: '标准',
  complex: '复杂',
  unclear: '不明确',
};
const rate = (value: number | null) => percent(value === null ? null : value * 100);

export function RoutingBars({
  rows,
  title,
}: {
  rows: Array<{ key: string; label: string; count: number }>;
  title: string;
}) {
  const [active, setActive] = useState<string>();
  const maximum = Math.max(1, ...rows.map((row) => row.count));
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  return (
    <div className="insight-routing-bars">
      <div className="insight-legend">
        <span>
          <i style={{ background: 'var(--accent-text)' }} />
          判断数量
        </span>
      </div>
      {rows.length ? (
        rows.map((row) => {
          const tip = `${tr(row.label)}: ${number(row.count)} · ${rate(total ? row.count / total : null)}`;
          return (
            <div
              key={row.key}
              className="insight-routing-bar"
              tabIndex={0}
              role="img"
              aria-label={tip}
              onFocus={() => setActive(tip)}
              onBlur={() => setActive(undefined)}
              onMouseEnter={() => setActive(tip)}
              onMouseLeave={() => setActive(undefined)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') setActive(undefined);
              }}
            >
              <span title={tr(row.label)}>{row.label}</span>
              <svg viewBox="0 0 100 14" preserveAspectRatio="none" aria-hidden="true">
                <rect width="100" height="14" rx="3" className="insight-routing-track" />
                <rect width={(row.count / maximum) * 100} height="14" rx="3" fill="var(--accent-text)" />
              </svg>
              <strong>{number(row.count)}</strong>
            </div>
          );
        })
      ) : (
        <div className="insight-empty">没有已报告的分类</div>
      )}
      <div className="insight-tooltip" role="status">
        {active ?? <span>悬停或聚焦查看数量与占比</span>}
      </div>
      <table className="sr-only">
        <caption>{title}</caption>
        <thead>
          <tr>
            <th>分类</th>
            <th>数量</th>
            <th>占比</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              <th scope="row">{row.label}</th>
              <td>{row.count}</td>
              <td>{rate(total ? row.count / total : null)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function routingIsPartial(data: Routing) {
  return (
    data.judged > 0 &&
    (data.handlingUnknown > 0 ||
      data.decisions.unknown > 0 ||
      data.latency.n < data.available ||
      data.taskTypes.reduce((sum, row) => sum + row.count, 0) < data.available ||
      data.difficulty.reduce((sum, row) => sum + row.count, 0) < data.available)
  );
}

export function UsageRouting({ data, onConversation }: { data: Routing; onConversation?: (id: string) => void }) {
  const labels = data.buckets.map((bucket) =>
    new Date(bucket.start).toLocaleString(
      currentLocale(),
      data.interval.bucket === 'hour'
        ? { month: 'short', day: 'numeric', hour: '2-digit' }
        : { month: 'short', day: 'numeric' },
    ),
  );
  const outcomeGroups = [
    { label: '成功', keys: ['okLocal', 'okCloud', 'okUnknown'] },
    { label: '回退到规则', keys: ['timeout', 'warming', 'busy', 'error'] },
    { label: '已跳过', keys: ['skipped', 'skippedOther'] },
  ];
  const outcomeColors: Record<string, string> = {
    okLocal: '#1d5f99',
    okCloud: '#4a90cf',
    okUnknown: '#a3c8e8',
    timeout: '#9a4a10',
    warming: '#cf6f1d',
    busy: '#e6985a',
    error: '#f2c496',
    skipped: '#69727d',
    skippedOther: '#aab1ba',
  };
  const outcomes = outcomeGroups
    .flatMap((group) => group.keys)
    .filter(
      (key) =>
        !['okUnknown', 'skippedOther'].includes(key) ||
        data.buckets.some((bucket) => bucket.outcomes[key as keyof typeof bucket.outcomes] > 0),
    );
  const outcomeSeries: Series[] = outcomes.map((key) => ({
    id: key,
    label: outcomeLabels[key],
    color: outcomeColors[key],
    values: data.buckets.map((bucket) => bucket.outcomes[key as keyof typeof bucket.outcomes]),
  }));
  const legendGroups = outcomeGroups.map((group) => ({
    label: tr(group.label),
    ids: group.keys.filter((key) => outcomes.includes(key)),
  }));
  const decisionRows = [
    { key: 'reply', label: '直接回复', count: data.decisions.reply },
    { key: 'task', label: '执行任务', count: data.decisions.task },
    ...(data.decisions.unknown ? [{ key: 'unknown', label: '未报告', count: data.decisions.unknown }] : []),
  ];
  const latencyGap = gapNote('{1} 条成功判断中有 {0} 条未报告延迟', data.available - data.latency.n, data.available);
  const handlingGap = gapNote('{1} 条已判断消息中有 {0} 条未报告处理来源', data.handlingUnknown, data.judged);
  const decisionGap = gapNote('{1} 条成功判断中有 {0} 条未报告处理判断', data.decisions.unknown, data.available);
  const taskTypeCount = data.taskTypes.reduce((sum, row) => sum + row.count, 0);
  const difficultyCount = data.difficulty.reduce((sum, row) => sum + row.count, 0);
  const taskGap = gapNote('{1} 条成功判断中有 {0} 条未报告任务类型', data.available - taskTypeCount, data.available);
  const difficultyGap = gapNote(
    '{1} 条成功判断中有 {0} 条未报告难度',
    data.available - difficultyCount,
    data.available,
  );
  const outcomeGap = [handlingGap, latencyGap].filter(Boolean).join(' · ') || undefined;
  return (
    <section className="insight-routing" aria-labelledby="routing-title">
      <header className="insight-routing-heading">
        <div>
          <h2 id="routing-title">路由</h2>
          <p>消息如何被判断，以及 Laya 是否可用。</p>
          <p>沿用时间与项目筛选；执行方式与执行器筛选不适用。</p>
        </div>
        <div className="insight-filter">
          <span>执行方式 · 不适用</span>
          <div className="insight-segmented" role="group" aria-label="路由执行方式筛选" aria-disabled="true">
            {['全部', 'CLI', 'API'].map((label, index) => (
              <button key={label} disabled aria-pressed={index === 0}>
                {label}
              </button>
            ))}
          </div>
        </div>
      </header>
      <div className="insight-routing-tiles">
        <article className="insight-routing-tile">
          <h3>由 Laya 决定</h3>
          <div className="insight-kpi-value">{rate(data.decidedShare)}</div>
          <p>按实际采用的处理来源统计。</p>
          <small>
            {withNames('Laya {0} · 规则 {1} · 未知 {2}', [
              String(data.handlingLaya),
              String(data.handlingRules),
              String(data.handlingUnknown),
            ])}
          </small>
          <small>{withNames('n = {0} 条已判断消息', [String(data.judged)])}</small>
        </article>
        <article className="insight-routing-tile">
          <h3>Laya 可用率</h3>
          <div className="insight-kpi-value">{rate(data.availability)}</div>
          <p>成功判断 / 尝试判断；隐私跳过不算失败。</p>
          <small>{withNames('成功 {0} / 尝试 {1}', [String(data.available), String(data.attempted)])}</small>
          <small>{withNames('隐私跳过 {0} · 其他跳过 {1}', [String(data.skipped), String(data.otherSkipped)])}</small>
        </article>
        <article className="insight-routing-tile">
          <h3>Laya 响应 p50 / p95</h3>
          <div className="insight-kpi-value">
            {seconds(data.latency.p50)}
            <small> / {seconds(data.latency.p95)}</small>
          </div>
          <p>仅包含成功判断的已报告延迟。</p>
          <small>
            {withNames('n = {0} · 本地 GPU {1} · 云端 {2} · 位置未知 {3}', [
              String(data.latency.n),
              String(data.localSamples),
              String(data.cloudSamples),
              String(data.unknownSamples),
            ])}
          </small>
          <small>
            {withNames('本地 p50 / p95 {0} / {1} · 云端 {2} / {3}', [
              seconds(data.localLatency.p50),
              seconds(data.localLatency.p95),
              seconds(data.cloudLatency.p50),
              seconds(data.cloudLatency.p95),
            ])}
          </small>
        </article>
      </div>
      {!data.judged ? (
        <div className="insight-empty">此时间范围内没有路由判断</div>
      ) : (
        <>
          <ChartCard
            id="routing-outcomes"
            title="Laya 判断结果"
            description="每个时段的判断结果；隐私跳过单独展示。"
            gap={outcomeGap}
          >
            <TimeChart labels={labels} series={outcomeSeries} legendGroups={legendGroups} mode="bar" height={185} />
            <h3>成功判断延迟 p50 / p95</h3>
            <p className="insight-chart-note">与上方共享时间范围；延迟单独使用秒刻度。</p>
            <TimeChart
              labels={labels}
              series={[
                {
                  id: 'p50',
                  label: 'p50',
                  color: 'var(--accent-text)',
                  values: data.buckets.map((bucket) => bucket.latency.p50),
                },
                {
                  id: 'p95',
                  label: 'p95',
                  color: 'var(--accent-text)',
                  dashed: true,
                  values: data.buckets.map((bucket) => bucket.latency.p95),
                },
              ]}
              format={seconds}
              height={135}
            />
          </ChartCard>
          <div className="insight-routing-decisions">
            <ChartCard
              id="routing-handling"
              title="回复或任务"
              description="Laya 的处理判断，不代表最终采用的处理方式。"
              gap={decisionGap}
            >
              <RoutingBars title="回复或任务" rows={data.available ? decisionRows : []} />
            </ChartCard>
            <ChartCard
              id="routing-task-types"
              title="任务类型"
              description="按已报告的任务类型数量排序。"
              gap={taskGap}
            >
              <RoutingBars
                title="任务类型"
                rows={[...data.taskTypes]
                  .sort((a, b) => b.count - a.count)
                  .map((row) => ({ ...row, label: taskLabels[row.key] ?? row.key }))}
              />
            </ChartCard>
            <ChartCard
              id="routing-difficulty"
              title="难度分布"
              description="成功判断中已报告的难度分类。"
              gap={difficultyGap}
            >
              <RoutingBars
                title="难度分布"
                rows={data.difficulty.map((row) => ({ ...row, label: difficultyLabels[row.key] ?? row.key }))}
              />
            </ChartCard>
          </div>
        </>
      )}
      <details className="insight-routing-recent">
        <summary>
          最近的路由判断 <span>{Math.min(50, data.recent.length)}</span>
        </summary>
        <p className="insight-chart-note">最多显示最近 50 条；点击消息打开对应对话。</p>
        <div className="usage-table-wrap">
          <table className="usage-table">
            <caption className="sr-only">最近的路由判断</caption>
            <thead>
              <tr>
                <th>时间</th>
                <th>消息摘要</th>
                <th>Laya 结果或回退原因</th>
                <th>延迟</th>
                <th>采用来源</th>
                <th>后续运行失败</th>
              </tr>
            </thead>
            <tbody>
              {data.recent.slice(0, 50).map((row) => (
                <tr key={row.workflowId}>
                  <td>
                    <time dateTime={row.at}>
                      {new Date(row.at).toLocaleString(currentLocale(), {
                        month: 'short',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </time>
                  </td>
                  <td>
                    <a
                      href={`#conversation=${encodeURIComponent(row.conversationId)}`}
                      translate="no"
                      onClick={(event) => {
                        event.preventDefault();
                        onConversation?.(row.conversationId);
                      }}
                    >
                      {Array.from(row.excerpt).slice(0, 60).join('') || tr('打开对话')}
                    </a>
                  </td>
                  <td>
                    <span>{outcomeLabels[row.outcome] ?? row.outcome}</span>
                    {row.decision && <small>{row.decision === 'reply' ? '直接回复' : '执行任务'}</small>}
                    {row.reason && <small translate="no">{row.reason}</small>}
                  </td>
                  <td>{seconds(row.latencyMs)}</td>
                  <td>{row.handling === 'laya' ? 'Laya' : row.handling === 'rules' ? '规则' : '未报告'}</td>
                  <td>{row.failed === null ? '未报告' : row.failed ? '是' : '否'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!data.recent.length && <p className="insight-chart-note">此时间范围内没有路由判断</p>}
      </details>
    </section>
  );
}
