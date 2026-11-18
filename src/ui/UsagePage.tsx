import { currentLocale } from './i18n';
import { DeviceUsage } from './DeviceUsage';
import { isApiHarness } from '../shared/provider-registry';
import { apiCreditGone } from '../shared/api-providers';
import { EvenCards, QuotaZoom } from './QuotaZoom';
import { isCoreRuntime } from './core-runtime';
import { useEffect, useState } from 'react';
import { UsageSpend } from './UsageSpend';
import { Activity, RefreshCw } from 'lucide-react';
import type { AppState, Project } from '../shared/types';
import type { TaskCost, UsageAggregate, UsageReport } from '../shared/usage';
import { showDiscoveredCli } from '../shared/runtime-readiness';
import { QuotaCard, dateLabel, readableError } from './App';
import { Savings } from './Savings';
import { useQuotaDisplay } from './use-quota-display';
import type { Api, Notice } from './Workspace';
import { WebAgentQuotas } from './ExternalAgents';
import { ApiQuotaCard } from './UsageQuota';
import { ExecutorActivityContext } from './ExecutorActivity';
import { executorTasks } from './executor-activity';
import { shownName, translateInterfaceText } from './i18n';
import { useUiUpdateBlocker } from './ui-update-guard';

export { EvenCards, QuotaZoom };

type Metric =
  | 'inputTokens'
  | 'outputTokens'
  | 'cacheReadTokens'
  | 'cacheWriteTokens'
  | 'reasoningOutputTokens'
  | 'totalTokens'
  | 'estimatedCostUsd';
const metrics: { key: Metric; label: string }[] = [
  { key: 'inputTokens', label: '输入词元' },
  { key: 'outputTokens', label: '输出词元' },
  { key: 'cacheReadTokens', label: '缓存读取' },
  { key: 'cacheWriteTokens', label: '缓存写入' },
  { key: 'reasoningOutputTokens', label: '推理输出' },
  { key: 'totalTokens', label: '总词元' },
  { key: 'estimatedCostUsd', label: '参考费用 · 美元' },
];
function numeric(value: number | null | undefined, cost = false) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '未报告';
  return cost
    ? `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`
    : value.toLocaleString(currentLocale());
}
function MetricValue({ aggregate, metric }: { aggregate: UsageAggregate; metric: Metric }) {
  return (
    <span className="usage-number">
      <strong>{numeric(aggregate[metric], metric === 'estimatedCostUsd')}</strong>
    </span>
  );
}
const tableMetrics = (details: boolean) =>
  details ? metrics : metrics.filter(({ key }) => key === 'totalTokens' || key === 'estimatedCostUsd');
/** Label and detail are ready to show as written (translate="no"): names and paths as they are, PugPort's translated. */
export type AggregateRow = UsageAggregate & { key: string; label: string; detail?: string };
export function AggregateTable({ rows, title, details }: { rows: AggregateRow[]; title: string; details: boolean }) {
  const [visible, setVisible] = useState(20);
  const rowKey = rows.map((row) => row.key).join('\0');
  useEffect(() => setVisible(20), [rowKey]);
  const displayedRows = rows.slice(0, visible);
  return (
    <div className="usage-table-wrap">
      <table className="usage-table">
        <caption className="sr-only">{title}</caption>
        <thead>
          <tr>
            <th>{title}</th>
            <th>调用记录</th>
            {tableMetrics(details).map((metric) => (
              <th key={metric.key}>{metric.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {displayedRows.map((row) => (
            <tr key={row.key}>
              <th scope="row">
                <span title={row.label} translate="no">
                  {row.label}
                </span>
                {row.detail && (
                  <small title={row.detail} translate="no">
                    {row.detail}
                  </small>
                )}
              </th>
              <td>{row.runs}</td>
              {tableMetrics(details).map((metric) => (
                <td key={metric.key}>
                  <MetricValue aggregate={row} metric={metric.key} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length && (
        <div className="usage-empty">
          <Activity size={21} />
          <p>当前筛选下暂无调用记录</p>
          <span>通过工作台运行任务后，用量会保存到对应项目。</span>
        </div>
      )}
      {visible < rows.length && (
        <button className="button tiny secondary usage-table-more" onClick={() => setVisible((value) => value + 20)}>
          再显示 20 条
        </button>
      )}
    </div>
  );
}

export function UsagePage({
  state,
  api,
  project,
  now,
  refreshing,
  refresh,
  notify,
  onInspect,
  onConversation,
  view,
}: {
  view?: 'quota' | 'usage';
  state: AppState;
  api: Api;
  project?: Project;
  now: number;
  refreshing: boolean;
  refresh: () => Promise<void>;
  notify: (notice: Notice) => void;
  onInspect: (id: string) => void;
  onConversation?: (id: string) => void;
}) {
  const [savedTab] = useState(() => {
    try {
      return JSON.parse(sessionStorage.getItem('pugport-usage-selection') ?? 'null')?.[0] === 'usage'
        ? 'usage'
        : 'quota';
    } catch {
      return 'quota';
    }
  });
  const tab = view ?? savedTab;
  useEffect(() => {
    if (tab !== 'quota') return;
    try {
      const saved = JSON.parse(sessionStorage.getItem('pugport-usage-selection') ?? 'null');
      const selection = Array.isArray(saved) ? saved : ['quota', 'expanded', '', '', '7d', 'task', 'all'];
      selection[0] = 'quota';
      sessionStorage.setItem('pugport-usage-selection', JSON.stringify(selection));
    } catch {
      // A failed storage write keeps automatic updates blocked until navigation is restorable.
    }
  }, [tab]);
  useUiUpdateBlocker(
    () => tab === 'quota' && JSON.parse(sessionStorage.getItem('pugport-usage-selection') ?? 'null')?.[0] !== 'quota',
    'usage-quota',
  );
  const [webUpdatedAt, setWebUpdatedAt] = useState<string>();
  const [deviceUpdatedAt, setDeviceUpdatedAt] = useState<string>();
  const [revision, setRevision] = useState(0);
  // Pi is a model-execution component, not a separate account or quota source.
  const quotaRuntimes = useQuotaDisplay(
    state.runtimes.filter((runtime) => {
      if (!isCoreRuntime(runtime) || isApiHarness(runtime.provider)) return false;
      const target = state.targets.find((value) => value.id === runtime.id);
      return !target || showDiscoveredCli(target, runtime);
    }),
  );
  const [zoomed, setZoomed] = useState<{ id: string; from: DOMRect }>();
  const zoomedRuntime = zoomed && quotaRuntimes.find((runtime) => runtime.id === zoomed.id);
  const apiRuntime = (id: string) => state.runtimes.find((runtime) => runtime.id === id);
  const apiProviders = (state.apiProviders ?? []).filter((provider) => {
    const budget = apiRuntime(provider.targetId)?.apiBudgetState ?? provider.budget;
    const policy = budget?.policy;
    // Settings still lists a spent one-time credit, so it can be cleared for pay-per-use.
    if (apiCreditGone(budget, now)) return false;
    return (
      (typeof policy?.limitUsd === 'number' && policy.limitUsd > 0) ||
      Number.isFinite(Date.parse(policy?.expiresAt ?? ''))
    );
  });
  const zoomedApi = zoomed && apiProviders.find((provider) => provider.targetId === zoomed.id);
  const apiSpend = (id: string) => {
    const provider = apiProviders.find((item) => item.targetId === id);
    const budget = apiRuntime(id)?.apiBudgetState ?? provider?.budget;
    if (budget) return budget.spentUsd;
    const start = new Date(now);
    start.setDate(1);
    start.setHours(0, 0, 0, 0);
    const runs = state.usage?.perRun.filter(
      (run) => run.runtimeId === id && Date.parse(run.startedAt) >= start.getTime(),
    );
    if (!runs) return undefined;
    const priced = runs.filter((run) => run.estimatedCostUsd !== null);
    return runs.length && !priced.length ? undefined : priced.reduce((sum, run) => sum + run.estimatedCostUsd!, 0);
  };
  const monthStart = new Date(now);
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const hasSavings =
    state.quotaUtilization || state.usage?.perRun.some((run) => Date.parse(run.startedAt) >= monthStart.getTime());
  const updatedAt = [...state.runtimes.map((runtime) => runtime.quota.observedAt), webUpdatedAt, deviceUpdatedAt]
    .filter((at): at is string => !!at && Number.isFinite(Date.parse(at)))
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0];
  if (tab === 'usage')
    return <UsageSpend state={state} api={api} onInspect={onInspect} onConversation={onConversation} />;
  return (
    <ExecutorActivityContext.Provider
      value={{ tasks: executorTasks(state), conversations: state.conversations ?? [], now, onConversation }}
    >
      <div className="management-heading">
        <div>
          <h1>用量</h1>
        </div>
        <div className="heading-actions">
          {updatedAt && (
            <time
              className="quiet-text"
              dateTime={updatedAt}
              title={new Date(updatedAt).toLocaleString(currentLocale())}
            >
              更新于 {dateLabel(updatedAt)}
            </time>
          )}
          <button
            className="button secondary"
            disabled={Boolean(refreshing || state.refreshing)}
            onClick={() => {
              if (tab === 'quota') void refresh();
              setRevision((value) => value + 1);
            }}
          >
            <RefreshCw size={14} className={refreshing || state.refreshing ? 'spinning' : ''} />
            刷新
          </button>
        </div>
      </div>
      {hasSavings && <Savings state={state} now={now} />}
      <section className="usage-accounts" role="tabpanel" aria-label="订阅额度与连接">
        <EvenCards onOpen={(id, from) => setZoomed({ id, from })}>
          {quotaRuntimes.map((runtime) => (
            <QuotaCard
              key={runtime.id}
              runtime={runtime}
              now={now}
              maxAge={state.settings.maxQuotaAgeSeconds}
              autoUseResetCards={state.settings.autoUseResetCards}
              zoomable
            />
          ))}
          {apiProviders.map((provider) => (
            <ApiQuotaCard
              key={provider.targetId}
              provider={provider}
              runtime={apiRuntime(provider.targetId)}
              now={now}
              spend={apiSpend(provider.targetId)}
              linkedRuntime={apiRuntime}
              zoomable
            />
          ))}
        </EvenCards>
        {zoomedRuntime && zoomed && (
          <QuotaZoom from={zoomed.from} label={zoomedRuntime.label} onClose={() => setZoomed(undefined)}>
            <QuotaCard
              runtime={zoomedRuntime}
              now={now}
              maxAge={state.settings.maxQuotaAgeSeconds}
              autoUseResetCards={state.settings.autoUseResetCards}
            />
          </QuotaZoom>
        )}
        {zoomedApi && zoomed && (
          <QuotaZoom from={zoomed.from} label={zoomedApi.label} onClose={() => setZoomed(undefined)}>
            <ApiQuotaCard
              provider={zoomedApi}
              runtime={apiRuntime(zoomedApi.targetId)}
              now={now}
              spend={apiSpend(zoomedApi.targetId)}
              linkedRuntime={apiRuntime}
            />
          </QuotaZoom>
        )}
        <WebAgentQuotas api={api} now={now} onUpdated={setWebUpdatedAt} />
        <DeviceUsage api={api} now={now} notify={notify} refreshRevision={revision} onUpdated={setDeviceUpdatedAt} />
      </section>
    </ExecutorActivityContext.Provider>
  );
}

/** One row per task: everything it took (subtasks, reviews, fixes, retries) and what that cost in all. */
export function TaskCostTable({
  tasks,
  onOpen,
  details,
}: {
  tasks?: TaskCost[];
  onOpen: (id: string) => void;
  details: boolean;
}) {
  const [visible, setVisible] = useState(20);
  const taskKey = tasks?.map((task) => task.taskId).join('\0');
  useEffect(() => setVisible(20), [taskKey]);
  if (!tasks)
    return (
      <div className="usage-empty" role="status">
        正在读取任务消耗…
      </div>
    );
  const displayedTasks = tasks.slice(0, visible);
  return (
    <div className="usage-table-wrap">
      <table className="usage-table">
        <caption className="sr-only">每个任务的总消耗</caption>
        <thead>
          <tr>
            <th>任务</th>
            <th>怎么完成的</th>
            {tableMetrics(details).map((metric) => (
              <th key={metric.key}>{metric.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {displayedTasks.map((task) => (
            <tr key={task.taskId}>
              <th scope="row">
                {task.title ? (
                  <span title={task.title} translate="no">
                    {task.title}
                  </span>
                ) : (
                  <span>（无标题）</span>
                )}
                <small>
                  {dateLabel(task.startedAt)} · {taskStatusLabel(task.status)}
                </small>
              </th>
              <td>
                <span translate="no">{task.executors.map(shownName).join('、')}</span>
                <small>
                  {[
                    task.runs === 1 ? '共 1 次调用' : `共 ${task.runs} 次调用`,
                    task.subtasks ? `子任务 ${task.subtasks}` : '',
                    task.reviews ? `审核 ${task.reviews}` : '',
                    task.fixes ? `修正或续接 ${task.fixes}` : '',
                    task.retries ? `重试 ${task.retries}` : '',
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </small>
              </td>
              {tableMetrics(details).map((metric) => (
                <td key={metric.key}>{numeric(task[metric.key], metric.key === 'estimatedCostUsd')}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {!tasks.length && <div className="usage-empty">当前筛选下还没有任务记录。</div>}
      {visible < tasks.length && (
        <button className="button tiny secondary usage-table-more" onClick={() => setVisible((value) => value + 20)}>
          再显示 20 条
        </button>
      )}
      <p className="resource-footnote" hidden={!details}>
        一个任务的总账包括它派出的子任务、自动审核、审核后的修正和每次重试；单价最低的执行器不一定让整个任务最省。
      </p>
    </div>
  );
}
const taskStatusLabel = (status: string) =>
  status === 'completed'
    ? '已完成'
    : status === 'failed'
      ? '失败'
      : status === 'blocked'
        ? '受阻'
        : status === 'cancelled'
          ? '已取消'
          : '进行中';

export function RunUsageTable({
  report,
  state,
  onInspect,
  details,
}: {
  details: boolean;
  report: UsageReport;
  state: AppState;
  onInspect: (id: string) => void;
}) {
  const [visible, setVisible] = useState(20);
  const runKey = report.perRun.map((run) => run.runId).join('\0');
  useEffect(() => setVisible(20), [runKey]);
  const displayedRuns = report.perRun.slice(0, visible);
  return (
    <div className="usage-table-wrap">
      <table className="usage-table">
        <caption className="sr-only">每次调用消耗</caption>
        <thead>
          <tr>
            <th>调用 / 项目</th>
            <th>执行器 / 模型</th>
            {tableMetrics(details).map((metric) => (
              <th key={metric.key}>{metric.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {displayedRuns.map((item) => (
            <tr key={item.runId}>
              <th scope="row">
                {state.runs.some((run) => run.id === item.runId) ? (
                  <button className="inline-link" onClick={() => onInspect(item.runId)}>
                    {item.runId.slice(0, 10)}
                  </button>
                ) : (
                  <code title={item.runId}>{item.runId.slice(0, 10)}</code>
                )}
                <small>{dateLabel(item.startedAt)}</small>
                <small title={item.projectPath} translate="no">
                  {item.projectPath.split(/[\\/]/).filter(Boolean).at(-1) || translateInterfaceText('未关联项目')}
                </small>
                {item.notes.length > 0 && (
                  <details className="usage-run-notes">
                    <summary>{item.uncertain ? '报告存在不确定项' : '统计说明'}</summary>
                    <p>{item.notes.join('；')}</p>
                  </details>
                )}
              </th>
              <td>
                <span translate="no">
                  {shownName(
                    item.runtimeLabel ||
                      state.targets.find((target) => target.id === item.runtimeId)?.label ||
                      item.runtimeId,
                  )}
                </span>
                <small>{item.model}</small>
                <small>
                  {item.accountingMode === 'usage'
                    ? '按用量统计'
                    : item.accountingMode === 'subscription'
                      ? '订阅调用'
                      : '计费类型未确认'}
                </small>
              </td>
              {tableMetrics(details).map((metric) => (
                <td key={metric.key}>{numeric(item[metric.key], metric.key === 'estimatedCostUsd')}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {!report.perRun.length && <div className="usage-empty">当前筛选下暂无调用记录。</div>}
      {visible < report.perRun.length && (
        <button className="button tiny secondary usage-table-more" onClick={() => setVisible((value) => value + 20)}>
          再显示 20 条
        </button>
      )}
    </div>
  );
}
