import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { AppState } from '../shared/types';
import type { FailureType, InsightBreakdown, InsightFilters, UsageInsights } from '../shared/usage-insights';
import type { Api } from './Workspace';
import { AggregateTable, RunUsageTable, TaskCostTable } from './UsagePage';
import {
  ChartCard,
  TimeChart,
  RangePlot,
  Sparkline,
  executorColors,
  gapNote,
  money,
  number,
  percent,
  seconds,
  type Series,
} from './charts/UsageCharts';
import { currentLocale, shownName, translateInterfaceText as tr, withNames } from './i18n';
import { useUiUpdateBlocker } from './ui-update-guard';
import { UsageRouting, routingIsPartial } from './UsageRouting';
import { SpendLedger } from './SpendLedger';
import type { SpendFilters, SpendOverview, SpendDetails, SpendDetailsGroup } from '../shared/spend-ledger';

const selectionKey = 'pugport-usage-selection';
type Selection = { filters: SpendFilters; group: 'task' | 'project' | 'run' };
function restore(): Selection {
  try {
    const saved = JSON.parse(sessionStorage.getItem(selectionKey) ?? 'null');
    if (Array.isArray(saved))
      return {
        filters: {
          range:
            saved[4] === 'today'
              ? '24h'
              : saved[4] === 'month'
                ? '30d'
                : ['24h', '7d', '30d', 'all'].includes(saved[4])
                  ? saved[4]
                  : '7d',
          kind: 'all',
          billing: ['all', 'subscription', 'usage'].includes(saved[7]) ? saved[7] : 'all',
          account: typeof saved[8] === 'string' ? saved[8] : '',
          project: typeof saved[2] === 'string' ? saved[2] : '',
          runtime: typeof saved[3] === 'string' ? saved[3] : '',
        },
        group: ['task', 'project', 'run'].includes(saved[5]) ? saved[5] : 'task',
      };
  } catch {
    /* Storage can be unavailable in private sessions. */
  }
  return { filters: { range: '7d', kind: 'all', billing: 'all', project: '', runtime: '' }, group: 'task' };
}
export function insightsQuery(filters: InsightFilters) {
  const query = new URLSearchParams({ range: filters.range, kind: filters.kind });
  if (filters.project) query.set('project', filters.project);
  if (filters.runtime) query.set('runtime', filters.runtime);
  return `/api/usage/insights?${query}`;
}
const rate = (v: number | null) => percent(v == null ? null : v * 100);
const failureLabels: Record<FailureType, string> = {
  'rate-limit': '限流或额度',
  timeout: '已超时',
  auth: '认证',
  tool: '工具或沙箱',
  network: '网络',
  content: '内容拒绝',
  unclassified: '未分类',
};

export function UsageSpend({
  state,
  api,
  onInspect,
  onConversation,
}: {
  state: AppState;
  api: Api;
  onInspect: (id: string) => void;
  onConversation?: (id: string) => void;
}) {
  const [initial] = useState(restore);
  const [filters, setFilters] = useState<SpendFilters>(initial.filters);
  const [data, setData] = useState<SpendOverview>();
  const [page, setPage] = useState<SpendDetails>();
  const [loading, setLoading] = useState(true);
  const [pageLoading, setPageLoading] = useState(false);
  const [error, setError] = useState('');
  const [pageError, setPageError] = useState('');
  const [revision, setRevision] = useState(0);
  const [group, setGroup] = useState<SpendDetailsGroup>(initial.group);
  const [expanded, setExpanded] = useState(false);
  const [details, setDetails] = useState(false);
  const [offset, setOffset] = useState(0);
  const [day, setDay] = useState<string>();
  const [failure, setFailure] = useState<FailureType>();
  const detailRef = useRef<HTMLDetailsElement>(null);
  const query = new URLSearchParams(Object.entries(filters).filter(([, value]) => !!value)).toString();
  const liveVersion = state.usage?.generatedAt;
  const active = state.runs?.some((run) => run.status === 'running' || run.status === 'waiting-approval');
  const [usageVersion, setUsageVersion] = useState(liveVersion);
  const lastRefresh = useRef(Date.now());
  useEffect(() => {
    if (liveVersion === usageVersion) return;
    const refresh = () => {
      lastRefresh.current = Date.now();
      setUsageVersion(liveVersion);
    };
    const delay = active ? Math.max(0, 30_000 - (Date.now() - lastRefresh.current)) : 0;
    if (!delay) {
      refresh();
      return;
    }
    const timer = setTimeout(refresh, delay);
    return () => clearTimeout(timer);
  }, [liveVersion, usageVersion, active]);
  const selection = JSON.stringify([
    'usage',
    'expanded',
    filters.project ?? '',
    filters.runtime ?? '',
    filters.range,
    group,
    filters.kind,
    filters.billing,
    filters.account ?? '',
  ]);
  useEffect(() => {
    try {
      sessionStorage.setItem(selectionKey, selection);
    } catch {}
  }, [selection]);
  useUiUpdateBlocker(() => expanded || sessionStorage.getItem(selectionKey) !== selection, 'usage-view');
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');
    void api<SpendOverview>('/api/usage/spend?' + query, undefined, 'GET')
      .then((value) => {
        if (alive) setData(value);
      })
      .catch((e) => {
        if (alive) setError(String(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [api, query, revision, usageVersion]);
  useEffect(() => {
    if (!expanded) return;
    let alive = true;
    setPageLoading(true);
    setPageError('');
    const q = new URLSearchParams(query);
    q.set('group', group);
    q.set('offset', String(offset));
    q.set('limit', '20');
    if (day) q.set('day', day);
    if (failure) q.set('failure', failure);
    void api<SpendDetails>('/api/usage/spend/details?' + q, undefined, 'GET')
      .then((value) => {
        if (alive) setPage(value);
      })
      .catch((e) => {
        if (alive) setPageError(String(e));
      })
      .finally(() => {
        if (alive) setPageLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [api, query, group, day, failure, offset, expanded, revision, usageVersion]);
  const change = <K extends keyof SpendFilters>(key: K, value: SpendFilters[K]) => {
    if (filters[key] === value) return;
    setFilters((f) => ({ ...f, [key]: value }));
    setData(undefined);
    setOffset(0);
    setDay(undefined);
    setFailure(undefined);
    setPage(undefined);
  };
  const projectLabel = (path: string) =>
    state.projects?.find((p) => p.path === path)?.name ?? path.split(/[\\/]/).at(-1) ?? path;
  const openDay = (key: string, value: string) => {
    if (filters.account !== key) setData(undefined);
    setFilters((f) => ({ ...f, account: key }));
    setDay(value);
    setFailure(undefined);
    setOffset(0);
    setGroup('run');
    setExpanded(true);
    setPage(undefined);
    requestAnimationFrame(() => detailRef.current?.scrollIntoView({ block: 'start' }));
  };
  const health: UsageInsights | undefined = data
    ? {
        ...data.insights,
        report: { ...data.insights.report, perRun: [] },
        buckets: data.insights.buckets.map((b) => ({
          ...b,
          failureRunIds: {
            'rate-limit': [],
            timeout: [],
            auth: [],
            tool: [],
            network: [],
            content: [],
            unclassified: [],
          },
        })),
      }
    : undefined;
  return (
    <div className="usage-insights">
      <div className="management-heading">
        <div>
          <h1>消耗</h1>
          <p className="quiet-text">费用去向与剩余额度</p>
        </div>
        <button className="button secondary" disabled={loading} onClick={() => setRevision((v) => v + 1)}>
          <RefreshCw size={14} />
          刷新
        </button>
      </div>
      <section role="tabpanel" aria-label="累计消耗">
        <div className="insight-filters">
          <div className="insight-filter">
            <span>时间范围</span>
            <div className="insight-segmented">
              {(['24h', '7d', '30d', 'all'] as const).map((value) => (
                <button key={value} aria-pressed={filters.range === value} onClick={() => change('range', value)}>
                  {value === 'all' ? '全部' : value}
                </button>
              ))}
            </div>
          </div>
          <div className="insight-filter">
            <span>计费类型</span>
            <div className="insight-segmented">
              {(['all', 'subscription', 'usage'] as const).map((value) => (
                <button key={value} aria-pressed={filters.billing === value} onClick={() => change('billing', value)}>
                  {value === 'all' ? '全部' : value === 'subscription' ? '订阅' : '按次计费'}
                </button>
              ))}
            </div>
          </div>
          <label className="insight-filter">
            <span>项目范围</span>
            <select
              aria-label="用量项目范围"
              value={filters.project ?? ''}
              onChange={(e) => change('project', e.target.value)}
            >
              <option value="">全部项目</option>
              {data?.options.projects.map((path) => (
                <option key={path} value={path} translate="no">
                  {projectLabel(path)}
                </option>
              ))}
            </select>
          </label>
          <label className="insight-filter">
            <span>执行器</span>
            <select
              aria-label="用量执行器范围"
              value={filters.runtime ?? ''}
              onChange={(e) => change('runtime', e.target.value)}
            >
              <option value="">全部执行器</option>
              {data?.options.runtimes.map((r) => (
                <option key={r.id} value={r.id} translate="no">
                  {shownName(r.label)}
                </option>
              ))}
            </select>
          </label>
          {filters.account && (
            <button className="button tiny secondary" onClick={() => change('account', '')}>
              {data?.options.accounts.find((a) => a.key === filters.account)?.label ?? tr('账号')} ×
            </button>
          )}
        </div>
        {error && (
          <div className="inline-error" role="alert">
            {error}
            <button onClick={() => setRevision((v) => v + 1)}>重试</button>
          </div>
        )}
        {loading && <p role="status">正在读取统计…</p>}
        {data && (
          <div aria-busy={loading} style={{ opacity: loading ? 0.6 : 1 }}>
            <p className="spend-note">
              {new Date(data.insights.interval.from).toLocaleDateString(currentLocale())} —{' '}
              {new Date(data.insights.interval.to).toLocaleDateString(currentLocale())} · {data.timeZone}
            </p>
            <SpendLedger
              data={data}
              onAccount={(key) => change('account', filters.account === key ? '' : key)}
              onDay={openDay}
              onInspect={onInspect}
              onPrefer={async (id) => {
                await api('/api/api-providers/' + encodeURIComponent(id) + '/budget', { preferExpiring: true }, 'PUT');
                setRevision((v) => v + 1);
              }}
            />
            <section className="spend-panel spend-health">
              <h2>健康与明细</h2>
              {health && (
                <InsightsDashboard
                  data={health}
                  collapsed
                  onConversation={onConversation}
                  onFailure={(type) => {
                    setFailure(type);
                    setDay(undefined);
                    setGroup('run');
                    setOffset(0);
                    setExpanded(true);
                  }}
                />
              )}
              <details ref={detailRef} open={expanded} onToggle={(e) => setExpanded(e.currentTarget.open)}>
                <summary>
                  <span>按任务、项目或调用查看</span>
                  <small />
                  <span className="spend-show">显示</span>
                </summary>
                <div className="insight-details-heading">
                  <div className="insight-segmented">
                    {(['task', 'project', 'run'] as const).map((value) => (
                      <button
                        key={value}
                        aria-pressed={group === value}
                        onClick={() => {
                          if (value !== group) {
                            setGroup(value);
                            setOffset(0);
                            setPage(undefined);
                          }
                        }}
                      >
                        {value === 'task' ? '按任务' : value === 'project' ? '按项目' : '每次调用'}
                      </button>
                    ))}
                  </div>
                  <button className="button tiny secondary" onClick={() => setDetails((v) => !v)}>
                    详情
                  </button>
                </div>
                {(day || failure) && (
                  <p>
                    {day} {failure ? tr(failureLabels[failure]) : ''}
                    <button
                      onClick={() => {
                        setDay(undefined);
                        setFailure(undefined);
                        setOffset(0);
                      }}
                    >
                      清除筛选
                    </button>
                  </p>
                )}
                {pageLoading && <p role="status">正在读取统计…</p>}
                {pageError && (
                  <p role="alert">
                    {pageError}
                    <button onClick={() => setRevision((v) => v + 1)}>重试</button>
                  </p>
                )}
                {page && (
                  <div aria-busy={pageLoading}>
                    {group === 'task' ? (
                      <TaskCostTable tasks={page.tasks} onOpen={onInspect} details={details} />
                    ) : group === 'project' ? (
                      <AggregateTable
                        rows={page.report.byProject
                          .filter((r) => page.projects.some((p) => p.projectPath === r.projectPath))
                          .map((r) => ({
                            ...r,
                            key: r.projectPath,
                            label: projectLabel(r.projectPath),
                            detail: r.projectPath,
                          }))}
                        title="项目"
                        details={details}
                      />
                    ) : (
                      <RunUsageTable report={page.report} state={state} onInspect={onInspect} details={details} />
                    )}
                    <div className="spend-pagination">
                      <button
                        className="button tiny secondary"
                        disabled={pageLoading || !offset}
                        onClick={() => setOffset(Math.max(0, offset - 20))}
                      >
                        上一页
                      </button>
                      <span>
                        {Math.min(offset + 1, page.total)}–{Math.min(offset + 20, page.total)} / {page.total}
                      </span>
                      <button
                        className="button tiny secondary"
                        disabled={pageLoading || page.nextOffset === undefined}
                        onClick={() => setOffset(page.nextOffset!)}
                      >
                        下一页
                      </button>
                    </div>
                  </div>
                )}
              </details>
            </section>
            <p className="resource-footnote">
              费用为估算，以平台账单为准；未报告的数据不计入总额。订阅参考费用不计入按用量费用。
              <span>账本仅计任务运行；余额与速度还包含额外 API 用量。</span>
            </p>
          </div>
        )}
      </section>
    </div>
  );
}

function CollapsedChart({ headline, ...props }: React.ComponentProps<typeof ChartCard> & { headline?: string }) {
  return (
    <details>
      <summary>
        <span>{props.title}</span>
        <small>{headline}</small>
        <span className="spend-show">显示</span>
      </summary>
      <ChartCard {...props} />
    </details>
  );
}

export function InsightsDashboard({
  data,
  onFailure,
  onConversation,
  collapsed = false,
}: {
  data: UsageInsights;
  collapsed?: boolean;
  onFailure: (type: FailureType, ids: string[]) => void;
  onConversation?: (id: string) => void;
}) {
  const Card = (props: React.ComponentProps<typeof ChartCard>) =>
    collapsed ? (
      <CollapsedChart
        {...props}
        headline={
          props.id === 'tokens'
            ? rate(data.summary.cacheHitRate)
            : props.id === 'reliability'
              ? rate(data.summary.failureRate)
              : props.id === 'speed'
                ? seconds(data.summary.duration.p50) + ' / ' + seconds(data.summary.duration.p95)
                : money(data.summary.spendUsd)
        }
      />
    ) : (
      <ChartCard {...props} />
    );
  const [cumulative, setCumulative] = useState(false);
  const { summary: summary, buckets, tiles } = data;
  const executorIds = data.runtimes.map((r) => r.id).sort();
  const color = (id: string) =>
    executorColors[id === '__other' ? 6 : Math.min(6, Math.max(0, executorIds.indexOf(id)))];
  const visibleIds = data.executors.map((e) => e.runtimeId).sort();
  const named = visibleIds.slice(0, 6);
  const labels = buckets.map((b) =>
    new Date(b.start).toLocaleString(
      currentLocale(),
      data.interval.bucket === 'hour'
        ? { month: 'short', day: 'numeric', hour: '2-digit' }
        : { month: 'short', day: 'numeric' },
    ),
  );
  const spend: Series[] = [...named, ...(visibleIds.length > 6 ? ['__other'] : [])].map((id) => ({
    id,
    label: id === '__other' ? '其他' : shownName(data.runtimes.find((r) => r.id === id)?.label ?? id),
    color: color(id),
    dashed: (id === '__other' ? visibleIds.slice(6) : [id]).every((key) => {
      const kinds = data.executors.find((e) => e.runtimeId === key)?.executionKinds;
      return kinds?.length === 1 && kinds[0] === 'cli';
    }),
    values: buckets.map((b) => {
      const keys = (id === '__other' ? visibleIds.slice(6) : [id]).filter((key) => key in b.spendByRuntime);
      if (!keys.length) return 0;
      const values = keys.map((key) => b.spendByRuntime[key]).filter((value) => value != null);
      return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
    }),
  }));
  let running = 0;
  const totalLine = buckets.map((b) => (b.spendUsd == null ? null : (running += b.spendUsd)));
  const tokenSeries: Series[] = (
    [
      ['input', '未缓存输入'],
      ['cache', '缓存读取'],
      ['output', '输出词元'],
      ['reasoning', '推理输出'],
    ] as const
  ).map(([id, label], i) => ({ id, label, color: executorColors[i], values: buckets.map((b) => b.tokens[id]) }));
  const { coverage } = summary;
  const spendGap = gapNote(
    '{1} 次运行中有 {0} 次未报告费用',
    coverage.usageRuns - coverage.usageCost,
    coverage.usageRuns,
  );
  const tokenGap = gapNote('{1} 次运行中有 {0} 次未报告词元', summary.runs - coverage.tokens, summary.runs);
  const cacheGap = gapNote('{1} 次运行中有 {0} 次未报告缓存', summary.runs - coverage.cache, summary.runs);
  const failureGap = gapNote(
    '{1} 次失败中有 {0} 次未分类',
    summary.failed - coverage.classifiedFailures,
    summary.failed,
  );
  const durationGap = gapNote('{1} 次运行中有 {0} 次未报告运行时间', summary.runs - coverage.duration, summary.runs);
  const partial =
    [spendGap, tokenGap, cacheGap, failureGap, durationGap].some(Boolean) ||
    data.executors.some((row) => row.coverage.cost < row.runs) ||
    routingIsPartial(data.routing);
  const tileDefs = [
    {
      key: 'spend',
      title: '按用量费用',
      format: money,
      detail: withNames('订阅参考费用 {0}', [money(summary.subscriptionReferenceUsd)]),
    },
    { key: 'success', title: '成功任务', format: number, detail: withNames('成功率 {0}', [rate(summary.successRate)]) },
    {
      key: 'failure',
      title: '失败率',
      format: rate,
      detail: withNames('取消 {0} · 中断 {1}，不计入失败率', [String(summary.cancelled), String(summary.interrupted)]),
    },
    { key: 'duration', title: '运行时间 p50 / p95', format: seconds, detail: '包含工具执行与等待时间' },
    { key: 'fallback', title: '回退率', format: rate, detail: '发生执行器切换的任务根占比' },
  ] as const;
  const speedRows = data.executors
    .flatMap((e) => (e.models.length ? e.models : [e]))
    .map((row) => ({
      id: `${row.runtimeId}/${row.model ?? ''}`,
      label: `${shownName(row.label)}${row.model ? ` / ${row.model}` : ''}`,
      color: color(row.runtimeId),
      ...row.duration,
      dashed: row.executionKinds.includes('cli'),
    }));
  const firstRows = data.executors
    .filter((e) => e.firstText.n)
    .map((e) => ({
      id: e.runtimeId,
      label: shownName(e.label),
      color: color(e.runtimeId),
      ...e.firstText,
      dashed: e.executionKinds.includes('cli'),
    }));
  return (
    <div className="insight-dashboard" key={JSON.stringify(data.filters)}>
      {partial && !collapsed && <p className="insight-partial-page">部分数据 · 仅统计已报告的样本</p>}
      {!collapsed && (
        <div className="insight-kpis">
          {tileDefs.map((def) => {
            const tile = tiles[def.key];
            return (
              <article className="insight-kpi" key={def.key} title={tr(def.detail)}>
                <h2>{def.title}</h2>
                <div className="insight-kpi-value">
                  {def.format(tile.value)}
                  {def.key === 'duration' && <small> / {seconds(tile.secondary)}</small>}
                </div>
                <div className="insight-kpi-trend">
                  <Sparkline values={tile.sparkline} />
                  {tile.delta != null && (
                    <span title={tr('与上一等长时段相比')}>
                      {tile.delta > 0 ? '+' : ''}
                      {percent(tile.delta * 100)}
                    </span>
                  )}
                </div>
                <p>{def.detail}</p>
                <small>{withNames('n = {0} · {1} 缺少数据', [String(tile.sample), String(tile.missing)])}</small>
              </article>
            );
          })}
        </div>
      )}
      <Card
        id="spend"
        title="费用趋势"
        description="按执行器汇总每个时段的按用量费用，单位为美元。"
        gap={spendGap}
        empty={!summary.runs}
        action={
          <label className="insight-toggle">
            <input type="checkbox" checked={cumulative} onChange={(e) => setCumulative(e.target.checked)} />
            累计
          </label>
        }
      >
        <TimeChart
          labels={labels}
          series={spend}
          mode="bar"
          format={money}
          overlay={cumulative ? totalLine : undefined}
        />
        <p className="insight-chart-note">斜纹表示 CLI，实色表示 API。</p>
      </Card>
      <div className="insight-chart-pair">
        <Card
          id="tokens"
          title="词元与缓存"
          description="仅堆叠能够确认互不重叠的输入、缓存、输出与推理词元。"
          gap={[tokenGap, cacheGap].filter(Boolean).join(' · ') || undefined}
          empty={!summary.runs}
        >
          <TimeChart labels={labels} series={tokenSeries} mode="area" height={175} />
          <h3>缓存复用率</h3>
          <p className="insight-chart-note">不含首次写入缓存的部分</p>
          <TimeChart
            labels={labels}
            series={(['cli', 'api'] as const).map((kind) => ({
              id: kind,
              label: `${tr('缓存复用率')} · ${kind.toUpperCase()}`,
              color: 'var(--accent-text)',
              dashed: kind === 'cli',
              values: buckets.map((b) => b.cacheByKind[kind]),
            }))}
            format={rate}
            height={125}
            cap={1}
          />
        </Card>
        <Card
          id="reliability"
          title="可靠性"
          description="失败率仅包含成功与失败的运行；点击失败类型查看调用。"
          gap={failureGap}
          empty={!summary.runs}
        >
          <TimeChart
            labels={labels}
            series={[
              { id: 'failure', label: '失败率', color: 'var(--danger)', values: buckets.map((b) => b.failureRate) },
            ]}
            format={rate}
            height={125}
            cap={1}
          />
          <h3>失败类型</h3>
          <TimeChart
            labels={labels}
            series={(Object.keys(failureLabels) as FailureType[]).map((type, i) => ({
              id: type,
              label: failureLabels[type],
              color: executorColors[i],
              values: buckets.map((b) => b.failures[type]),
            }))}
            mode="bar"
            height={175}
            onSelect={(index, type) =>
              onFailure(type as FailureType, buckets[index].failureRunIds[type as FailureType])
            }
          />
        </Card>
      </div>
      {collapsed ? (
        <details>
          <summary>
            <span>路由（Task Router）</span>
            <small>{rate(data.routing.decidedShare)}</small>
            <span className="spend-show">显示</span>
          </summary>
          <UsageRouting data={data.routing} onConversation={onConversation} />
        </details>
      ) : (
        <UsageRouting data={data.routing} onConversation={onConversation} />
      )}
      <Card
        id="speed"
        title="运行速度"
        description="按执行器与模型比较运行时间；不是模型生成延迟。"
        gap={durationGap}
        empty={!summary.runs}
      >
        <RangePlot rows={speedRows} />
        <h3>首段文本时间</h3>
        <p className="insight-chart-note">仅包含记录了启动与首段公开文本时间的运行。</p>
        {firstRows.length ? <RangePlot rows={firstRows} /> : <div className="insight-empty">没有首段文本时间样本</div>}
      </Card>
      {collapsed ? (
        <details>
          <summary>
            <span>执行器与模型</span>
            <small>{data.executors.length}</small>
            <span className="spend-show">显示</span>
          </summary>
          <ExecutorTable rows={data.executors} color={color} />
        </details>
      ) : (
        <ExecutorTable rows={data.executors} color={color} />
      )}
    </div>
  );
}

export function ExecutorTable({ rows, color }: { rows: InsightBreakdown[]; color: (id: string) => string }) {
  const [expanded, setExpanded] = useState<string[]>([]);
  const [sort, setSort] = useState<keyof InsightBreakdown>('spendUsd');
  const [ascending, setAscending] = useState(false);
  const columns: Array<{ key: keyof InsightBreakdown; label: string }> = [
    { key: 'runs', label: '运行数' },
    { key: 'successRate', label: '成功率' },
    { key: 'duration', label: 'p50 / p95' },
    { key: 'fallbacks', label: '回退' },
    { key: 'spendUsd', label: '费用' },
    { key: 'costPerSuccessfulTask', label: '每个成功任务费用' },
  ];
  const sorted = (values: InsightBreakdown[]) =>
    [...values].sort((a, b) => {
      const av = sort === 'duration' ? a.duration.p50 : a[sort],
        bv = sort === 'duration' ? b.duration.p50 : b[sort];
      return ((typeof av === 'number' ? av : -1) - (typeof bv === 'number' ? bv : -1)) * (ascending ? 1 : -1);
    });
  const row = (entry: InsightBreakdown, child = false) => (
    <tr key={`${entry.runtimeId}/${entry.model ?? ''}`} className={child ? 'insight-model-row' : ''}>
      <th scope="row">
        <div className="insight-executor-name">
          <i style={{ background: color(entry.runtimeId) }} />
          {!child && (
            <button
              className="insight-expand"
              aria-expanded={expanded.includes(entry.runtimeId)}
              aria-label={withNames('展开 {0} 的模型', [shownName(entry.label)])}
              onClick={() =>
                setExpanded((value) =>
                  value.includes(entry.runtimeId)
                    ? value.filter((id) => id !== entry.runtimeId)
                    : [...value, entry.runtimeId],
                )
              }
            >
              {expanded.includes(entry.runtimeId) ? '−' : '+'}
            </button>
          )}
          <span title={child ? entry.model : shownName(entry.label)} translate="no">
            {child ? entry.model : shownName(entry.label)}
          </span>
        </div>
        <small>{entry.executionKinds.map((k) => k.toUpperCase()).join(' / ')}</small>
      </th>
      <td>{entry.runs}</td>
      <td>{rate(entry.successRate)}</td>
      <td>
        {seconds(entry.duration.p50)} / {seconds(entry.duration.p95)}
      </td>
      <td>{entry.fallbacks}</td>
      <td>
        {money(entry.spendUsd)}
        <small>
          {entry.coverage.usageCost}/{entry.coverage.usageRuns}
        </small>
      </td>
      <td>{money(entry.costPerSuccessfulTask)}</td>
      <td>
        <Sparkline values={entry.spendTrend} color={color(entry.runtimeId)} />
      </td>
    </tr>
  );
  return (
    <ChartCard
      id="executors"
      title="执行器与模型"
      description="展开执行器查看模型；费用列仅包含按用量计费的估算。"
      gap={gapNote(
        '{1} 次运行中有 {0} 次未报告费用',
        rows.reduce((sum, r) => sum + Math.max(0, r.runs - r.coverage.cost), 0),
        rows.reduce((sum, r) => sum + r.runs, 0),
      )}
      empty={!rows.length}
    >
      <div className="usage-table-wrap insight-executor-table">
        <table className="usage-table">
          <caption className="sr-only">执行器与模型</caption>
          <thead>
            <tr>
              <th>执行器 / 模型</th>
              {columns.map((column) => (
                <th
                  key={column.key}
                  aria-sort={sort === column.key ? (ascending ? 'ascending' : 'descending') : 'none'}
                >
                  <button
                    onClick={() => {
                      setSort(column.key);
                      setAscending(sort === column.key ? !ascending : false);
                    }}
                  >
                    {column.label}
                    {sort === column.key ? (ascending ? ' ↑' : ' ↓') : ''}
                  </button>
                </th>
              ))}
              <th>费用趋势</th>
            </tr>
          </thead>
          <tbody>
            {sorted(rows).flatMap((entry) => [
              row(entry),
              ...(expanded.includes(entry.runtimeId) ? sorted(entry.models).map((model) => row(model, true)) : []),
            ])}
          </tbody>
        </table>
      </div>
    </ChartCard>
  );
}
