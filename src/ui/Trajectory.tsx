import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { takeTurnInspection } from './turn-inspection';
import {
  deriveTimelineGeometry,
  deriveTrajectory,
  isProtocolTrajectoryRow,
  unnamedStageLabel,
} from '../shared/trajectory';
import type { RunRecord } from '../shared/types';
import { shownName, translateInterfaceText, withNames } from './i18n';

type Row = ReturnType<typeof deriveTrajectory>['rows'][number];
type Filter = 'all' | 'tools' | 'errors';
const PAGE_SIZE = 50;
const lanes = ['input', 'model', 'tools', 'status'] as const;
const laneLabels = { input: '输入', model: '模型', tools: '工具', status: '状态' };
const statusLabels = { pending: '等待', running: '执行中', completed: '完成', failed: '失败', info: '记录' };
const recordLabels: Record<string, string> = {
  'User input': '任务输入',
  'Model reply': '模型回复',
  思考: '思考',
  '模型调用（无文字）': '模型调用（无文字）',
  'Tool call': '工具调用',
  Error: '错误',
  Approval: '审批',
  Status: '状态',
  'Run status': '运行状态',
  Usage: '用量',
  'PugPort execution prompt': 'PugPort 执行提示词',
  'PugPort routing': 'PugPort 路由',
  'PugPort execution context': 'PugPort 执行上下文',
  'PugPort communication': 'PugPort 内部沟通',
};
/** PugPort's own name for the row, if it has one (tool and stage names are as reported). */
const interfaceLabel = (row: Row) =>
  recordLabels[row.label] ?? (row.label === unnamedStageLabel ? row.label : undefined);
const usageLabels: Record<string, string> = {
  inputTokens: '输入 token',
  outputTokens: '输出 token',
  cacheReadTokens: '缓存读取 token',
  cacheWriteTokens: '缓存写入 token',
  reasoningOutputTokens: '推理 token',
  totalTokens: '总 token',
  estimatedCostUsd: '估计费用（USD）',
};

function timestamp(value: string | undefined): number | undefined {
  const number = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(number) ? number : undefined;
}

function duration(milliseconds: number): string {
  if (milliseconds < 1000) return `${Math.round(milliseconds)}ms`;
  if (milliseconds < 60000) return `${(milliseconds / 1000).toFixed(1)}s`;
  return `${Math.floor(milliseconds / 60000)}m ${Math.floor((milliseconds % 60000) / 1000)}s`;
}

/**
 * "CLI / account" as trajectory.ts joins it: the CLI name (原生 CLI for an unknown provider) is interface text;
 * the account label after it can be a name the user chose, so it stays as written unless it is PugPort's default.
 */
function executorLabel(executor: string) {
  const [cli, ...account] = executor.split(' / ');
  return (
    <>
      {cli}
      {account.length ? (
        <>
          {' / '}
          <span translate="no">{shownName(account.join(' / '))}</span>
        </>
      ) : null}
    </>
  );
}

/** A row's label: PugPort's record names and actions translate; tool names and account labels stay as written. */
function rowLabelNode(row: Row) {
  const label = interfaceLabel(row);
  if (label) return label;
  if (row.labelParts)
    return (
      <>
        {executorLabel(row.labelParts.executor)}
        {' · '}
        {row.labelParts.action}
      </>
    );
  return <span translate="no">{row.label}</span>;
}

/** The same label as text for attributes, already translated with account names as written (use with data-names). */
function rowLabelText(row: Row) {
  const label = interfaceLabel(row);
  if (label) return translateInterfaceText(label);
  if (!row.labelParts) return row.label;
  const [cli, ...account] = row.labelParts.executor.split(' / ');
  const executor = [translateInterfaceText(cli!), ...(account.length ? [shownName(account.join(' / '))] : [])];
  return `${executor.join(' / ')} · ${translateInterfaceText(row.labelParts.action)}`;
}

/** Cuts long recorded text; the note after the cut is interface text (i18n.ts translates `.trajectory-more`). */
function bounded(value: string | undefined, limit: number) {
  if (!value || value.length <= limit) return value ?? '';
  return (
    <>
      {`${value.slice(0, limit)}\n`}
      <span className="trajectory-more">…（查看详细记录）</span>
    </>
  );
}

export function TrajectoryDetailDialog({
  title,
  text,
  incomplete,
  onClose,
}: {
  title: ReactNode;
  text: string;
  incomplete?: boolean;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const [copyStatus, setCopyStatus] = useState('');
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    return () => {
      alive.current = false;
      previous?.focus();
    };
  }, []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      if (alive.current) setCopyStatus('全文已复制。');
    } catch {
      if (alive.current) setCopyStatus('复制失败，请在记录中选择并复制。');
    }
  };
  return (
    <div className="modal-backdrop trajectory-detail-backdrop">
      <div
        className="modal trajectory-detail-modal"
        ref={dialog}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onClose();
          }
          if (event.key === 'Tab') {
            const elements = [
              ...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]'),
            ];
            const first = elements[0],
              last = elements.at(-1);
            if (
              event.shiftKey &&
              (document.activeElement === first || document.activeElement === event.currentTarget)
            ) {
              event.preventDefault();
              last?.focus();
            } else if (
              !event.shiftKey &&
              (document.activeElement === last || document.activeElement === event.currentTarget)
            ) {
              event.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <div className="modal-heading">
          <h2 id={titleId}>{title}</h2>
          <div className="trajectory-detail-actions">
            <button type="button" onClick={() => void copy()}>
              复制全文
            </button>
            <button type="button" onClick={onClose} aria-label="关闭完整记录">
              关闭
            </button>
          </div>
        </div>
        <p>显示本次已采集记录的全部可展示内容，敏感凭据已脱敏。原生 CLI 未报告的系统提示与隐藏推理不在记录中。</p>
        {incomplete ? (
          <p className="trajectory-note">历史采集范围可能不完整；源端缺失或已截短的内容无法恢复。</p>
        ) : null}
        {text ? (
          <pre className="trajectory-full-text" tabIndex={0} translate="no">
            {text}
          </pre>
        ) : (
          <p className="trajectory-note">此记录没有采集到更多内容。</p>
        )}
        <p role="status">{copyStatus}</p>
      </div>
    </div>
  );
}

export function TrajectoryPanel({
  run,
  relatedRuns = [],
  onInspectRun,
  userInput,
  onLoadFullAudit,
  auditLoading = false,
  hideContextRows = false,
  filterRequest,
}: {
  run: RunRecord;
  relatedRuns?: readonly RunRecord[];
  onInspectRun?: (runId: string) => void;
  userInput?: string;
  onLoadFullAudit?: () => void;
  auditLoading?: boolean;
  hideContextRows?: boolean;
  /** Trace › Context opens Calls filtered to tools; each request (new id) applies once. */
  filterRequest?: { filter: Filter; id: number };
}) {
  const active = ['queued', 'running', 'waiting-approval'].includes(run.status);
  const [liveTick, setLiveTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setLiveTick((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [run.id, active]);
  // Streaming deltas change both events and output. Sample the whole live projection once per tick;
  // a different run or a terminal transition bypasses the live clock immediately.
  const trajectory = useMemo(
    () => deriveTrajectory(run, userInput),
    [
      run.id,
      active,
      active ? liveTick : undefined,
      active ? undefined : run.events.length,
      active ? undefined : run.events.at(-1)?.seq,
      active ? undefined : run.reasoning,
      active ? undefined : run.status,
      active ? undefined : run.summary,
      active ? undefined : run.output,
      active ? undefined : run.prompt,
      active ? undefined : run.userInput,
      active ? undefined : run.startedAt,
      active ? undefined : run.endedAt,
      active ? undefined : run.eventsDropped,
      active ? undefined : run.auditEventsMissing,
      active ? undefined : userInput,
    ],
  );
  const reportedUsage = Object.entries(trajectory.usage ?? {}).filter(
    ([, value]) => typeof value === 'number' && Number.isFinite(value),
  );
  const [mode, setMode] = useState<'duration' | 'sequence'>('duration');
  const [filter, setFilter] = useState<Filter>(filterRequest?.filter ?? 'all');
  useEffect(() => {
    if (filterRequest) setFilter(filterRequest.filter);
  }, [filterRequest?.id]);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [detailKey, setDetailKey] = useState<string>();
  const [protocolOpen, setProtocolOpen] = useState(false);
  const [protocolLimit, setProtocolLimit] = useState(100);
  const isExpanded = (row: Row) => expanded.has(row.key);
  useEffect(() => {
    setLimit(PAGE_SIZE);
    setExpanded(new Set());
    setDetailKey(undefined);
    setProtocolOpen(false);
    setProtocolLimit(100);
  }, [run.id]);
  useEffect(() => {
    const select = () => {
      const key = takeTurnInspection(run.id);
      if (key) setDetailKey(key);
    };
    select();
    window.addEventListener('pugport:turn-inspection', select);
    return () => window.removeEventListener('pugport:turn-inspection', select);
  }, [run.id]);
  const filtered = useMemo(
    () =>
      trajectory.rows.filter((row) => {
        if (
          hideContextRows &&
          (row.lane === 'input' ||
            ['PugPort execution prompt', 'PugPort execution context', 'PugPort routing'].includes(row.label))
        )
          return false;
        return filter === 'tools'
          ? row.lane === 'tools'
          : filter === 'errors'
            ? row.status === 'failed' || row.children?.some((child) => child.status === 'failed')
            : true;
      }),
    [trajectory, hideContextRows, filter],
  );
  const protocolRows = filtered.filter(isProtocolTrajectoryRow);
  const listRows = filtered.filter((row) => !isProtocolTrajectoryRow(row) || row === protocolRows[0]);
  const geometry = useMemo(() => {
    const latestRowTime = trajectory.rows.reduce(
      (latest, row) => Math.max(latest, timestamp(row.startedAt) ?? 0, timestamp(row.endedAt) ?? 0),
      timestamp(run.startedAt) ?? 0,
    );
    return deriveTimelineGeometry(filtered, {
      startedAt: run.startedAt,
      endedAt: run.endedAt ?? new Date(latestRowTime).toISOString(),
    });
  }, [filtered, trajectory, run.startedAt, run.endedAt]);
  const windowScope = `${run.id}:${Boolean(run.summary)}:${trajectory.eventsDropped === 0}:${run.auditEventsMissing !== undefined}:${filter}:${hideContextRows}`;
  const windowBaseline = useRef({ scope: windowScope, count: listRows.length });
  // Loading a complete archive is a new window, rather than thousands of appended live records.
  if (windowBaseline.current.scope !== windowScope)
    windowBaseline.current = { scope: windowScope, count: listRows.length };
  // Appended live records extend the initial window so reading a row does not evict it.
  const visible = listRows.slice(-(limit + Math.max(0, listRows.length - windowBaseline.current.count)));
  const visibleWithProtocol =
    protocolRows.length && !visible.includes(protocolRows[0]) ? [protocolRows[0], ...visible] : visible;
  const start = timestamp(run.startedAt);
  const elapsed = geometry.elapsedMs;
  const unknownTiming = geometry.unknownTiming;
  const toggleRow = (row: Row) => {
    const key = row.key;
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const inspectMarker = (row: Row) => {
    setDetailKey(row.key);
  };
  const relationships: Array<{ id: string; label: string }> = [];
  const detailRow = trajectory.rows
    .flatMap((row) => [row, ...(row.children ?? [])])
    .find((row) => row.key === detailKey);
  const outputDetail = detailKey === `${run.id}:full-output`;
  const detailBody = outputDetail
    ? trajectory.outputDetail
    : detailRow?.detailMissing
      ? ['此调用的参数、输入或结果未被这份历史记录采集，无法补推。', detailRow.detail].filter(Boolean).join('\n\n')
      : (detailRow?.detail ?? detailRow?.text ?? '');
  const detailText = detailRow?.sourceEvents?.length
    ? `${JSON.stringify({ sourceEvents: detailRow.sourceEvents }, null, 2)}\n\n${detailBody}`
    : detailBody;
  if (trajectory.metadata.parentRunId) relationships.push({ id: trajectory.metadata.parentRunId, label: '父运行' });
  if (run.relay) relationships.push({ id: run.relay.fromRunId, label: '接力来源' });
  if (run.visualContext) relationships.push({ id: run.visualContext.fromRunId, label: '读图辅助' });
  for (const related of relatedRuns) {
    if (related.id === run.id) continue;
    if (related.parentRunId === run.id) relationships.push({ id: related.id, label: '子运行' });
    if (related.relay?.fromRunId === run.id) relationships.push({ id: related.id, label: '接力后续' });
    if (related.visualContext?.fromRunId === run.id) relationships.push({ id: related.id, label: '交回主任务' });
  }
  const renderRow = (row: Row) => (
    <article className={`trajectory-row trajectory-${row.status}`} key={row.key}>
      <button
        type="button"
        className="trajectory-row-heading"
        aria-expanded={isExpanded(row)}
        onClick={() => toggleRow(row)}
      >
        <span className="trajectory-row-dot" aria-hidden="true" />
        <span className="trajectory-row-title">
          <small>{laneLabels[row.lane]}</small>
          <strong>{rowLabelNode(row)}</strong>
          {row.source ? (
            <small className="trajectory-source">
              {row.executor ? (
                <>
                  {executorLabel(row.executor)}
                  {' · '}
                </>
              ) : null}
              {row.source === 'pugport'
                ? row.lane === 'tools'
                  ? 'PugPort 工具执行'
                  : 'PugPort'
                : row.source === 'linked'
                  ? '原生 + PugPort（显式关联）'
                  : row.lane === 'tools'
                    ? '原生调用'
                    : '原生执行事件'}
              {row.executorSource === 'route' ? ' · 执行器来自运行路由' : ''}
            </small>
          ) : null}
        </span>
        <span className="trajectory-row-state">{statusLabels[row.status]}</span>
        <span className="trajectory-row-time">
          {row.durationMs !== undefined
            ? duration(row.durationMs)
            : timestamp(row.startedAt) !== undefined && start !== undefined
              ? `+${duration(Math.max(0, timestamp(row.startedAt)! - start))}`
              : '时间未知'}
        </span>
        <span aria-hidden="true">{isExpanded(row) ? '−' : '+'}</span>
      </button>
      {row.argumentPreview || row.outcome ? (
        <p className="trajectory-tool-summary" translate="no">
          {row.argumentPreview}
          {row.outcome ? ` · ${row.outcome}` : ''}
        </p>
      ) : null}
      {row.text ? (
        <p className="trajectory-row-text" translate="no">
          {bounded(row.text, 300)}
        </p>
      ) : null}
      {row.usage ? (
        <div className="trajectory-row-usage">
          {Object.entries(row.usage)
            .filter(([, value]) => typeof value === 'number' && Number.isFinite(value))
            .map(([key, value]) => (
              <span key={key}>
                {usageLabels[key] ?? key}: {value?.toLocaleString()}
              </span>
            ))}
        </div>
      ) : null}
      {isExpanded(row) ? (
        <div className="trajectory-row-detail">
          {row.sourceEvents?.length ? (
            <p className="trajectory-note">
              来源事件 ·{' '}
              {row.sourceEvents
                .slice(0, 20)
                .map((event) =>
                  event.sequenceSource === 'event.seq' ? `# ${event.sequence}` : `旧记录局部索引  ${event.sequence}`,
                )
                .join(' · ')}
              {row.sourceEvents.length > 20 ? ' · 全部索引见详细记录' : ''}
            </p>
          ) : null}
          {row.lane === 'tools' ? (
            <div className="trajectory-call-ids">
              {row.nativeToolId ? (
                <span>
                  原生调用 ID · <code>{row.nativeToolId}</code>
                </span>
              ) : null}
              {row.toolCallId ? (
                <span>
                  PugPort 调用 ID · <code>{row.toolCallId}</code>
                </span>
              ) : null}
            </div>
          ) : null}
          {row.lane === 'tools' ? (
            <p className="trajectory-note">
              详细记录保留每次观测的顺序、时间、状态、参数和结果；执行阶段按显式父调用 ID 归属。
            </p>
          ) : null}
          {row.label === 'PugPort execution prompt' || row.label === 'PugPort execution context' ? (
            <p className="trajectory-note">这是 PugPort 组装并发送的执行提示词。原生 CLI 自身的系统提示未报告。</p>
          ) : null}
          {row.detailMissing ? (
            <p className="trajectory-note">此调用的参数、输入或结果未被这份历史记录采集，无法补推。</p>
          ) : (row.detail ?? row.text) ? (
            <pre>{bounded(row.detail ?? row.text, 1200)}</pre>
          ) : (
            <p className="trajectory-note">没有更多已报告的细节。</p>
          )}
          {row.children?.length ? (
            <details className="trajectory-stages">
              <summary>PugPort 执行阶段（{row.children.length}）</summary>
              {row.children.map((stage) => (
                <div className={`trajectory-stage trajectory-${stage.status}`} key={stage.key}>
                  <strong>{rowLabelNode(stage)}</strong>
                  <span>
                    {statusLabels[stage.status]} ·{' '}
                    {stage.durationMs !== undefined ? duration(stage.durationMs) : '耗时未报告'}
                  </span>
                  <small>
                    父调用 · <code>{stage.parentToolCallId}</code> · 阶段 ·{' '}
                    {stage.stepId ? <code>{stage.stepId}</code> : '未报告 ID'}
                  </small>
                  <small>
                    开始 · {stage.startedAt || '未报告'} · 结束 · {stage.endedAt || '未报告'}
                  </small>
                  <button type="button" className="trajectory-read-more" onClick={() => setDetailKey(stage.key)}>
                    查看阶段完整记录
                  </button>
                </div>
              ))}
            </details>
          ) : null}
        </div>
      ) : null}
      <button
        type="button"
        className="trajectory-read-more"
        onClick={() => setDetailKey(row.key)}
        title={withNames('{0} · 查看详细记录', [rowLabelText(row)])}
        data-names
      >
        查看详细记录
      </button>
    </article>
  );
  return (
    <section className="trajectory-panel" aria-label="执行轨迹">
      <header className="trajectory-heading">
        <strong>执行轨迹</strong>
        {run.agentPreset ? (
          <span className="trajectory-role" title={run.agentPreset.id}>
            角色 · {run.agentPreset.name}
          </span>
        ) : null}
        {!trajectory.needsDetail && (
          <span>
            {trajectory.toolsCount} 条工具记录 · 原生 {trajectory.nativeToolsCount} · PugPort{' '}
            {trajectory.pugportToolsCount}
            {trajectory.rows.some((row) => row.source === 'linked') ? '（显式关联记录同时属于两层）' : ''}
          </span>
        )}
        <span>{elapsed === undefined ? '时间未报告' : `已记录 ${duration(elapsed)}`}</span>
      </header>
      {trajectory.needsDetail ? (
        <p className="trajectory-note" role="status">
          正在加载完整运行记录…
        </p>
      ) : null}
      {run.auditEventsMissing !== undefined ? (
        run.auditEventsMissing > 0 ? (
          <p className="trajectory-note">
            完整公开事件审计缺少 {run.auditEventsMissing} 条事件；历史未采集内容无法恢复。
          </p>
        ) : null
      ) : trajectory.eventsDropped ? (
        'auditVersion' in run && run.auditVersion === 1 ? (
          <div className="trajectory-note">
            <p>实时视图省略了较早事件；完整公开事件审计可以从本地记录读取。</p>
            {onLoadFullAudit ? (
              <button type="button" className="trajectory-read-more" disabled={auditLoading} onClick={onLoadFullAudit}>
                {auditLoading ? '正在读取完整事件记录…' : '读取完整事件记录'}
              </button>
            ) : null}
          </div>
        ) : (
          <p className="trajectory-note">部分较早事件已移除，轨迹可能不完整。</p>
        )
      ) : null}
      {!trajectory.needsDetail && trajectory.eventsDropped === undefined && (
        <p className="trajectory-note">旧记录未标记事件保留范围，轨迹可能不完整。</p>
      )}
      {!trajectory.needsDetail && !('auditVersion' in run && run.auditVersion === 1) ? (
        <p className="trajectory-note">旧记录只显示当时采集的事件，未采集的参数、结果或内部沟通无法补造。</p>
      ) : null}
      <div className="trajectory-controls">
        <div role="group" aria-label="轨迹视图">
          {(['duration', 'sequence'] as const).map((value) => (
            <button key={value} type="button" aria-pressed={mode === value} onClick={() => setMode(value)}>
              {value === 'duration' ? '时间视图' : '顺序视图'}
            </button>
          ))}
        </div>
        <div role="group" aria-label="轨迹筛选">
          {(['all', 'tools', 'errors'] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={filter === value}
              onClick={() => {
                setFilter(value);
                setLimit(PAGE_SIZE);
              }}
            >
              {value === 'all' ? '全部' : value === 'tools' ? '工具' : '错误'}
            </button>
          ))}
        </div>
      </div>
      {mode === 'duration' ? (
        <div className="trajectory-overview" aria-label="按运行时间排列的轨道">
          <div className="trajectory-axis">
            <span>0</span>
            <span>{elapsed === undefined ? '时间未知' : duration(elapsed)}</span>
          </div>
          {lanes
            .filter((lane) => !hideContextRows || lane !== 'input')
            .map((lane) => (
              <div className="trajectory-lane" key={lane}>
                <span>{laneLabels[lane]}</span>
                <div className="trajectory-track">
                  {geometry.marks
                    .filter((mark) => mark.lane === lane)
                    .map((mark) => {
                      const row = mark.row;
                      const at = timestamp(row.startedAt ?? row.endedAt)!;
                      const hasSpan = (row.lane === 'tools' || row.lane === 'model') && (row.durationMs ?? 0) > 0;
                      return (
                        <button
                          type="button"
                          key={mark.key}
                          className={`trajectory-marker trajectory-${row.status}${hasSpan ? ' trajectory-span' : ''}`}
                          style={{
                            left: `min(${mark.leftPercent}%, calc(100% - 3px))`,
                            width: `${mark.widthPercent}%`,
                          }}
                          data-lane={lane}
                          data-count={mark.count}
                          aria-label={[
                            rowLabelText(row),
                            translateInterfaceText(statusLabels[row.status]),
                            duration(Math.max(0, at - start!)),
                            translateInterfaceText(hasSpan ? `耗时 ${duration(row.durationMs!)}` : '事件时间'),
                          ].join(' · ')}
                          title={`${rowLabelText(row)} · ${translateInterfaceText(hasSpan ? `观测耗时 ${duration(row.durationMs!)}` : '事件时间，耗时未报告')} · ×${mark.count}`}
                          data-names
                          onClick={() => inspectMarker(row)}
                        />
                      );
                    })}
                </div>
              </div>
            ))}
          <p className="trajectory-note">
            短标记表示事件时间；条形表示已记录的模型回复或工具耗时。
            {unknownTiming ? ` ${unknownTiming} 条记录未报告时间，见下方。` : ''}
          </p>
          {geometry.protocolCount ? (
            <p className="trajectory-note">{withNames('另有 {0} 条协议事件', [String(geometry.protocolCount)])}</p>
          ) : null}
        </div>
      ) : null}
      <div className="trajectory-list" aria-label="轨迹记录">
        {listRows.length > visible.length ? (
          <button type="button" className="trajectory-earlier" onClick={() => setLimit((value) => value + PAGE_SIZE)}>
            加载更早的记录（剩余 {listRows.length - visible.length} 条）
          </button>
        ) : null}
        {visibleWithProtocol.map((row) =>
          row === protocolRows[0] ? (
            <div className="trajectory-protocol" key={row.key}>
              <button
                type="button"
                className="trajectory-protocol-toggle"
                aria-expanded={protocolOpen}
                onClick={() => setProtocolOpen(!protocolOpen)}
              >
                {withNames('协议事件 ×{0}', [String(protocolRows.length)])}
              </button>
              {protocolOpen ? (
                <div className="trajectory-protocol-rows">
                  {protocolRows.slice(0, protocolLimit).map(renderRow)}
                  {protocolRows.length > protocolLimit ? (
                    <button
                      type="button"
                      className="trajectory-earlier"
                      onClick={() => setProtocolLimit((value) => value + 100)}
                    >
                      {withNames('显示更多协议事件（剩余 {0} 条）', [String(protocolRows.length - protocolLimit)])}
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : (
            renderRow(row)
          ),
        )}
        {!visible.length ? <p className="trajectory-note">没有符合筛选条件的记录。</p> : null}
      </div>
      <div className="trajectory-usage" aria-label="已报告用量">
        {reportedUsage.length ? (
          reportedUsage.map(([key, value]) => (
            <span key={key}>
              {usageLabels[key] ?? key}: {value?.toLocaleString()}
            </span>
          ))
        ) : (
          <span>用量未报告</span>
        )}
      </div>
      {trajectory.outputSummary ? (
        <p className="trajectory-output">
          <strong>输出摘要</strong> <span translate="no">{bounded(trajectory.outputSummary, 500)}</span>
          <button
            type="button"
            className="trajectory-read-more"
            disabled={trajectory.needsDetail}
            onClick={() => setDetailKey(`${run.id}:full-output`)}
          >
            查看完整输出
          </button>
        </p>
      ) : null}
      {detailRow || outputDetail ? (
        <TrajectoryDetailDialog
          title={
            outputDetail ? (
              '完整模型输出'
            ) : (
              <>
                {rowLabelNode(detailRow!)}
                {' · 详细记录'}
              </>
            )
          }
          text={detailText}
          incomplete={
            (run.auditEventsMissing !== undefined
              ? run.auditEventsMissing > 0
              : trajectory.eventsDropped !== 0 || !('auditVersion' in run && run.auditVersion === 1)) ||
            detailRow?.detailMissing ||
            /capture.?truncated|\[truncated\]|\[截断\]/i.test(detailText)
          }
          onClose={() => setDetailKey(undefined)}
        />
      ) : null}
      {relationships.length || trajectory.metadata.workflowId || trajectory.metadata.stepId ? (
        <footer className="trajectory-related">
          {trajectory.metadata.workflowId ? <span>工作流 {trajectory.metadata.workflowId}</span> : null}
          {trajectory.metadata.stepId ? <span>步骤 {trajectory.metadata.stepId}</span> : null}
          {relationships.map((item) =>
            onInspectRun ? (
              <button
                type="button"
                key={`${item.label}:${item.id}`}
                title={`${item.label} ${item.id}`}
                onClick={() => onInspectRun(item.id)}
              >
                {item.label} · {item.id}
              </button>
            ) : (
              <span key={`${item.label}:${item.id}`}>
                {item.label} · {item.id}
              </span>
            ),
          )}
        </footer>
      ) : null}
    </section>
  );
}
