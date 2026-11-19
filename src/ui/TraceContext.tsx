import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AppState, RunRecord, Workflow } from '../shared/types';
import {
  contextDrops,
  contextPartGroups,
  diffParts,
  type ContextPart,
  type ContextPartGroup,
  type RunContextDetail,
  type TraceContextPage,
  type TraceContextRun,
} from '../shared/context-trace';
import { executionPromptContext, runSentParts } from '../shared/conversation-trace';
import { cacheReuseRate } from '../shared/usage';
import { safeToolEventText } from '../shared/tool-event-data';
import type { Api } from './Workspace';
import { currentLocale, routeTranslator, shownName, translateInterfaceText, withNames } from './i18n';
import { formatConversationDuration } from './WorkflowElapsed';

/*
 * Trace › Context: one task read top to bottom. How each attempt's prompt was assembled (A), what went in
 * (B), what the executor itself reported (C), why PugPort built it this way (D) and what the executor did
 * with it (E). Data comes from /api/workflows/:id/context and /api/runs/:id/context, loaded when this tab
 * opens; nothing here is part of the state broadcast.
 */

export type TraceContextProps = {
  api: Api;
  workflow: Workflow;
  workflows: readonly Workflow[];
  /** Full local records of the selected task's own runs, used for "View" without another request. */
  runs: readonly RunRecord[];
  state: Pick<AppState, 'targets' | 'runtimes'>;
  selectedRunId?: string;
  /** Changes when a run of this task ends, so the ladder reloads once. */
  refresh: string;
  live: boolean;
  onSelectAttempt: (runId: string) => void;
  onOpenCalls: (runId: string) => void;
  onOpenRecord: (workflowId: string) => void;
  onShow: (title: ReactNode, text: string) => void;
};

const safe = (value: string | null | undefined) => safeToolEventText(value ?? '', value?.length ?? 0);
const json = (value: unknown) => safe(JSON.stringify(value, null, 2));
const groupLabels: Record<ContextPartGroup, string> = {
  memory: '记忆与历史',
  instructions: 'PugPort 指令',
  handoff: '交接材料',
  request: '你的请求',
  attachments: '附件',
};
const barOrder: ContextPartGroup[] = ['request', 'instructions', 'memory', 'handoff', 'attachments'];
const statusLabels: Record<RunRecord['status'], string> = {
  queued: '排队中',
  running: '正在执行',
  'waiting-approval': '等待审批',
  completed: '已完成',
  failed: '执行失败',
  cancelled: '已取消',
  interrupted: '已中断',
};
const relayLabels: Record<NonNullable<RunRecord['relay']>['reason'], string> = {
  quota: '额度用完',
  authentication: '登录失效',
  content: '内容受限',
  technical: '技术故障',
  selection: '手动切换',
};
const kindLabels: Record<string, string> = { routine: '日常', general: '通用', design: '设计', architecture: '架构' };
const complexityLabels: Record<string, string> = { simple: '简单', standard: '中等', complex: '困难' };
const intentLabels: Record<string, string> = { question: '提问', action: '要执行操作', uncertain: '意图不确定' };
const planningLabels: Record<string, string> = {
  direct: '直接执行',
  native: '执行器自行规划',
  model: '模型规划',
  resume: '继续上次计划',
};

/** 58,400 → 58.4k; 272,000 → 272k; 1,000,000 → 1M. Locale digits, no false precision. */
export function compact(value: number): string {
  const locale = currentLocale();
  if (value >= 1_000_000)
    return `${(value / 1_000_000).toLocaleString(locale, { maximumFractionDigits: value >= 10_000_000 ? 0 : 1 })}M`;
  if (value >= 100_000) return `${Math.round(value / 1000).toLocaleString(locale)}k`;
  if (value >= 1000) return `${(value / 1000).toLocaleString(locale, { maximumFractionDigits: 1 })}k`;
  return Math.round(value).toLocaleString(locale);
}
const number = (value: number) => value.toLocaleString(currentLocale());
/** Chinese has no plural; English needs "1 attempt" but "2 attempts", so one is its own source string. */
const counted = (value: number, one: string, many: string) =>
  value === 1 ? translateInterfaceText(one) : withNames(many, [number(value)]);

/** Shared axis: the smallest 1-2-2.5-5 step whose three ticks cover the largest bar. */
function niceAxis(max: number): number {
  if (max <= 0) return 1000;
  const raw = max / 3;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((factor) => factor * power).find((value) => value >= raw)!;
  return step * 3;
}

type Segment = { key: string; className: string; tokens: number; title: string; group?: ContextPartGroup };
function segments(
  row: TraceContextRun,
  mode: 'whole' | 'sent',
): { parts: Segment[]; remainder: number; total: number } {
  const parts: Segment[] = [];
  for (const group of barOrder) {
    const items = row.parts.filter((part) => part.group === group);
    const tokens = items.reduce((sum, part) => sum + part.tokens, 0);
    if (tokens > 0)
      parts.push({
        key: group,
        className: `group-${group}`,
        tokens,
        group,
        title: withNames('{0} · {1} 字 · ≈{2} token', [
          translateInterfaceText(groupLabels[group]),
          number(items.reduce((sum, part) => sum + part.chars, 0)),
          compact(tokens),
        ]),
      });
  }
  if (mode === 'whole' && row.transcript) {
    if (row.transcript.toolResults.tokens > 0)
      parts.push({
        key: 'tools',
        className: 'transcript-tools',
        tokens: row.transcript.toolResults.tokens,
        title: withNames('工具结果 ≈{0} token', [compact(row.transcript.toolResults.tokens)]),
      });
    if (row.transcript.replies.tokens > 0)
      parts.push({
        key: 'replies',
        className: 'transcript-replies',
        tokens: row.transcript.replies.tokens,
        title: withNames('模型回复 ≈{0} token', [compact(row.transcript.replies.tokens)]),
      });
  }
  const known = parts.reduce((sum, part) => sum + part.tokens, 0);
  const reported = mode === 'whole' ? row.reported?.contextTokens : undefined;
  const remainder = reported !== undefined ? Math.max(0, reported - known) : 0;
  const total = Math.max(known, reported ?? 0);
  // Share of the bar, so a hover says how much of this context the part is.
  for (const part of parts)
    part.title = `${part.title} · ${Math.max(1, Math.round((part.tokens / Math.max(1, total)) * 100))}%`;
  return { parts, remainder, total };
}

const activeStatuses = new Set<TraceContextRun['status']>(['queued', 'running', 'waiting-approval']);

/** Snapshot paths are project-relative; tool paths may be absolute or use the other separator. */
const filePath = (path: string) => path.replaceAll('\\', '/').replace(/^\.\//, '');
export const sameFile = (a: string, b: string) => {
  const left = filePath(a),
    right = filePath(b);
  return left === right || left.endsWith(`/${right}`) || right.endsWith(`/${left}`);
};

const duration = (row: TraceContextRun) =>
  row.endedAt ? formatConversationDuration(Date.parse(row.endedAt) - Date.parse(row.startedAt), currentLocale()) : '';

export function TraceContext({
  api,
  workflow,
  workflows,
  runs,
  state,
  selectedRunId,
  refresh,
  live,
  onSelectAttempt,
  onOpenCalls,
  onOpenRecord,
  onShow,
}: TraceContextProps) {
  const [page, setPage] = useState<TraceContextPage>();
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [error, setError] = useState('');
  const [limit, setLimit] = useState(40);
  const [reload, setReload] = useState(0);
  const [tick, setTick] = useState(0);
  const [mode, setMode] = useState<'whole' | 'sent'>('whole');
  const [picked, setPicked] = useState<string>();
  const [flash, setFlash] = useState<string>();
  const animated = useRef(false);
  const partsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setTick((value) => value + 1), 2000);
    return () => clearInterval(timer);
  }, [live, workflow.id]);
  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    api<TraceContextPage>(`/api/workflows/${encodeURIComponent(workflow.id)}/context?limit=${limit}`, undefined, 'GET')
      .then((value) => {
        if (cancelled || value.workflowId !== workflow.id) return;
        setPage(value);
        setStatus('ready');
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setError(safe(reason instanceof Error ? reason.message : String(reason)));
        setStatus('failed');
      });
    return () => {
      cancelled = true;
    };
  }, [api, workflow.id, refresh, limit, reload, tick]);
  useEffect(() => {
    setPicked(undefined);
    setPage((previous) => (previous?.workflowId === workflow.id ? previous : undefined));
  }, [workflow.id]);

  const rows = page?.workflowId === workflow.id ? page.runs : [];
  const attempts = rows.filter((row) => row.depth === 0);
  const fallback = rows.find((row) => row.runId === selectedRunId && row.depth === 0) ?? attempts.at(-1) ?? rows[0];
  const selected = rows.find((row) => row.runId === picked) ?? fallback;
  const previous =
    selected?.depth === 0
      ? attempts[attempts.findIndex((row) => row.runId === selected.runId) - 1]
      : rows.find((row) => row.workflowId === selected?.workflowId && row.attempt === (selected?.attempt ?? 0) - 1);

  const [detail, setDetail] = useState<RunContextDetail>();
  const detailRun = selected?.runId;
  // The detail follows the ladder only while its run is active, and only when the run reported something new;
  // a finished run's detail is read once, not on every 2 s ladder poll.
  const detailVersion =
    selected && activeStatuses.has(selected.status)
      ? `${selected.status}:${selected.requests.count}:${selected.tools.count}`
      : 'settled';
  useEffect(() => {
    if (!detailRun) return;
    let cancelled = false;
    api<RunContextDetail>(`/api/runs/${encodeURIComponent(detailRun)}/context`, undefined, 'GET')
      .then((value) => {
        if (!cancelled && value.runId === detailRun) setDetail(value);
      })
      .catch(() => {
        if (!cancelled) setDetail(undefined);
      });
    return () => {
      cancelled = true;
    };
  }, [api, detailRun, detailVersion]);
  const shownDetail = detail?.runId === detailRun ? detail : undefined;

  useEffect(() => {
    if (!flash) return;
    partsRef.current?.querySelector(`[data-group="${flash}"]`)?.scrollIntoView({ block: 'nearest' });
    const timer = setTimeout(() => setFlash(undefined), 900);
    return () => clearTimeout(timer);
  }, [flash]);
  useEffect(() => {
    if (rows.length) animated.current = true;
  });

  const choose = (row: TraceContextRun) => {
    setPicked(row.runId);
    if (row.depth === 0) onSelectAttempt(row.runId);
  };
  const executor = (row: TraceContextRun) => safe(shownName(row.executor));
  const axis = useMemo(() => niceAxis(Math.max(0, ...rows.map((row) => segments(row, mode).total))), [rows, mode]);
  const loading = status === 'loading';

  if (status === 'failed' && !rows.length)
    return (
      <div className="conversation-trace-failure" role="alert">
        <strong>上下文加载失败</strong>
        <p translate="no">{error}</p>
        <button type="button" className="button secondary" onClick={() => setReload((value) => value + 1)}>
          重试
        </button>
      </div>
    );
  if (!loading && page && !page.total)
    return <p className="trace-context-empty">还没有发送任何内容。第一次尝试开始后，这里会显示提示词。</p>;

  const partText = async (row: TraceContextRun, key: string) => {
    const local = runs.find((item) => item.id === row.runId);
    const record =
      local && !local.summary
        ? local
        : await api<RunRecord>(`/api/runs/${encodeURIComponent(row.runId)}`, undefined, 'GET');
    if (key === 'prompt') return executionPromptContext(record).prompt;
    return runSentParts(record).find((part) => part.key === key)?.text ?? '';
  };
  const view = (row: TraceContextRun, key: string, title: ReactNode) =>
    void partText(row, key).then(
      (text) => onShow(title, text),
      () => onShow(title, ''),
    );

  return (
    <div className="trace-context-root" aria-busy={loading}>
      {loading && (
        <p className="sr-only" role="status">
          正在加载上下文…
        </p>
      )}
      <div className="trace-context-scope">
        <strong>整个任务</strong>
        {page && (
          <span translate="no">
            {[
              counted(page.scope.attempts, '一次尝试', '{0} 次尝试'),
              counted(page.scope.handoffs, '一次交接', '{0} 次交接'),
              counted(page.scope.subtasks, '一个子任务', '{0} 个子任务'),
            ].join(' · ')}
          </span>
        )}
        <div className="trace-context-legend">
          <span>
            <i className="swatch exact" />
            PugPort 发送
          </span>
          <span>
            <i className="swatch transcript" />
            记录中可见 ≈
          </span>
          <span>
            <i className="swatch reported" />
            已报告，未细分
          </span>
          <span>
            <i className="swatch none" />
            未报告
          </span>
        </div>
      </div>

      <section className="trace-context-card trace-context-ladder" data-animate={!animated.current || undefined}>
        <div className="trace-context-head">
          <h3>上下文如何组装</h3>
          <div className="trace-context-toggle" role="group" aria-label="刻度">
            <button type="button" aria-pressed={mode === 'whole'} onClick={() => setMode('whole')}>
              整个上下文
            </button>
            <button type="button" aria-pressed={mode === 'sent'} onClick={() => setMode('sent')}>
              PugPort 部分
            </button>
          </div>
        </div>
        <p className="trace-context-sub">每次尝试一条，按它最后一次模型请求计 token。选一条查看发送内容。</p>
        <div className="trace-context-axis" aria-hidden="true">
          <span />
          <div className="ticks" translate="no">
            {[0, 1, 2, 3].map((index) => (
              <span key={index} style={{ left: `${(index / 3) * 100}%` }}>
                {compact((axis / 3) * index)}
              </span>
            ))}
          </div>
          <span />
        </div>
        <div
          className="trace-context-rows"
          role="listbox"
          aria-label="尝试"
          onKeyDown={(event) => {
            const index = rows.findIndex((row) => row.runId === selected?.runId);
            const next =
              event.key === 'ArrowDown'
                ? Math.min(index + 1, rows.length - 1)
                : event.key === 'ArrowUp'
                  ? Math.max(index - 1, 0)
                  : undefined;
            if (next === undefined || next === index) return;
            event.preventDefault();
            choose(rows[next]!);
            event.currentTarget.querySelectorAll<HTMLElement>('[role="option"]')[next]?.focus();
          }}
        >
          {!rows.length &&
            loading &&
            [0, 1].map((index) => <div key={index} className="trace-context-row skeleton" aria-hidden="true" />)}
          {rows.map((row) => {
            const bar = segments(row, mode);
            const position = row.depth === 0 ? attempts.findIndex((item) => item.runId === row.runId) : -1;
            const priorAttempt = position > 0 ? attempts[position - 1] : undefined;
            const nextAttempt = position >= 0 ? attempts[position + 1] : undefined;
            const barWidth = `${Math.max(0.6, Math.min(100, (bar.total / axis) * 100))}%`;
            const share = (tokens: number) => `${(tokens / Math.max(1, bar.total)) * 100}%`;
            const window = row.reported?.contextWindow;
            const active = ['queued', 'running', 'waiting-approval'].includes(row.status);
            return (
              <div key={row.runId} className="trace-context-entry">
                {priorAttempt && (
                  <Handoff
                    from={priorAttempt}
                    to={row}
                    executor={executor(row)}
                    onJump={(group) => {
                      choose(row);
                      setFlash(group);
                    }}
                  />
                )}
                <div
                  role="option"
                  tabIndex={row.runId === selected?.runId ? 0 : -1}
                  aria-selected={row.runId === selected?.runId}
                  className="trace-context-row"
                  data-depth={row.depth}
                  data-run-id={row.runId}
                  onClick={() => choose(row)}
                >
                  <div className="who">
                    <b translate="no">
                      {row.depth === 0 ? `${row.attempt} · ${executor(row)}` : safe(row.label ?? executor(row))}
                    </b>
                    <small>
                      <span className="tag">
                        {row.transport === 'api' ? 'API' : row.transport === 'cli' ? 'CLI' : '—'}
                      </span>
                      {row.depth === 1 && <span translate="no">{executor(row)}</span>}
                      {row.depth === 0 && <span>{statusLabels[row.status]}</span>}
                      {nextAttempt?.relay && (
                        <>
                          <span>·</span>
                          <span>{relayLabels[nextAttempt.relay.reason]}</span>
                        </>
                      )}
                      {row.depth === 0 && !nextAttempt?.relay && duration(row) && (
                        <span translate="no">· {duration(row)}</span>
                      )}
                      {active && <span className="tag live">实时</span>}
                      {(row.textOnly || row.toolless) && <span className="tag">仅文字</span>}
                    </small>
                  </div>
                  <div className="track">
                    <div className="bar" style={{ width: barWidth }} data-loading={loading || undefined}>
                      {bar.parts.map((part) => (
                        <i
                          key={part.key}
                          className={part.className}
                          style={{ width: share(part.tokens) }}
                          title={part.title}
                          data-names
                          onClick={(event) => {
                            if (!part.group) return;
                            event.stopPropagation();
                            choose(row);
                            setFlash(part.group);
                          }}
                        />
                      ))}
                      {bar.remainder > 0 && (
                        <i
                          className="reported"
                          style={{ width: share(bar.remainder) }}
                          title={withNames('{0} 自身 ≈{1}（未细分）', [executor(row), compact(bar.remainder)])}
                          data-names
                        />
                      )}
                    </div>
                    {mode === 'whole' && !row.reported && (
                      <span
                        className="noreport"
                        style={{ left: `${Math.min(70, Math.max(0.6, (bar.total / axis) * 100))}%` }}
                        title="这个执行器没有报告总量"
                      >
                        这个 CLI 没有报告总量
                      </span>
                    )}
                  </div>
                  <div className="figs" translate="no">
                    {row.reported ? (
                      <>
                        <b>{compact(row.reported.contextTokens)}</b>
                        <small>
                          {[
                            window
                              ? withNames('{0}% / {1}', [
                                  String(Math.round((row.reported.contextTokens / window) * 100)),
                                  compact(window),
                                ])
                              : withNames('窗口未报告', []),
                            withNames('发送 ≈{0}', [compact(row.sent.tokens)]),
                          ].join(' · ')}
                        </small>
                      </>
                    ) : (
                      <>
                        <b>≈{compact(row.sent.tokens)}</b>
                        <small>{withNames('仅发送部分', [])}</small>
                      </>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        {page && page.total > rows.length && (
          <button
            type="button"
            className="button subtle trace-context-more"
            onClick={() => setLimit((value) => value + 40)}
          >
            {withNames('再显示 {0} 条', [String(Math.min(40, page.total - rows.length))])}
          </button>
        )}
        <div className="trace-context-keys">
          {barOrder.map((group) => (
            <span key={group}>
              <i className={`swatch group-${group}`} />
              {groupLabels[group]}
            </span>
          ))}
          <span>
            <i className="swatch transcript-tools" />
            工具结果 ≈
          </span>
          <span>
            <i className="swatch transcript-replies" />
            模型回复 ≈
          </span>
          <span>
            <i className="swatch reported" />
            执行器自身（未细分）
          </span>
        </div>
      </section>

      {selected && (
        <div className="trace-context-detail" key={selected.runId}>
          {(selected.partialHistory || shownDetail?.partialHistory) && (
            <p className="trace-context-note trace-context-partial" role="note">
              部分历史：这次运行的记录较长，目前只整理了前一部分，之后打开会继续补齐。
            </p>
          )}
          <div className="trace-context-grid">
            <section className="trace-context-card" ref={partsRef}>
              <WhatWentIn
                row={selected}
                previous={previous}
                flash={flash}
                onView={(key, title) => view(selected, key, title)}
              />
            </section>
            <div className="trace-context-stack">
              <section className="trace-context-card">
                <Reported row={selected} detail={shownDetail} executor={executor(selected)} />
              </section>
              <section className="trace-context-card">
                <Why
                  row={selected}
                  workflow={workflows.find((item) => item.id === selected.workflowId) ?? workflow}
                  state={state}
                  onShow={onShow}
                />
              </section>
            </div>
          </div>
          <section className="trace-context-card trace-context-did">
            <Did
              row={selected}
              detail={shownDetail}
              executor={executor(selected)}
              onOpenCalls={() =>
                selected.depth === 0 ? onOpenCalls(selected.runId) : onOpenRecord(selected.workflowId)
              }
            />
          </section>
          {selected.depth === 1 && (
            <button type="button" className="button subtle" onClick={() => onOpenRecord(selected.workflowId)}>
              打开这个子任务的记录 →
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function Handoff({
  from,
  to,
  executor,
  onJump,
}: {
  from: TraceContextRun;
  to: TraceContextRun;
  executor: string;
  /** A chip jumps to that part's group in "What went in". */
  onJump?: (group: ContextPartGroup) => void;
}) {
  const { changes, dropped } = diffParts(from.parts, to.parts);
  const added = to.parts.filter((part) => {
    const change = changes.get(part.key);
    return change?.kind === 'new';
  });
  const grown = to.parts.filter((part) => {
    const change = changes.get(part.key);
    return change?.kind === 'changed' && Math.abs(change.delta) >= 500;
  });
  const reason = to.relay ? relayLabels[to.relay.reason] : '同执行器重试';
  const lines = [
    withNames(to.sessionMode === 'resumed' ? '继续原会话 · {0}' : '新会话 · {0}', [executor]),
    ...(to.carriedTools ? [withNames('带过去 {0} 个工具结果', [String(to.carriedTools)])] : []),
    withNames('变化按字符计', []),
  ];
  return (
    <div className="trace-context-handoff">
      <div className="label">
        <span>交接点</span>
        <span aria-hidden="true">·</span>
        <span>{reason}</span>
      </div>
      <div className="chips">
        <span className="line" translate="no">
          {lines.join(' · ')}
        </span>
        {added.slice(0, 6).map((part) => (
          <button
            type="button"
            key={part.key}
            className="chip add"
            data-group={part.group}
            onClick={() => onJump?.(part.group)}
          >
            <b>+</b>
            <i className={`dot group-${part.group}`} />
            <span>{part.title}</span>
            <span translate="no"> {compact(part.chars)}</span>
          </button>
        ))}
        {grown.slice(0, 4).map((part) => {
          const change = changes.get(part.key) as { kind: 'changed'; delta: number };
          return (
            <button
              type="button"
              key={part.key}
              className="chip"
              data-group={part.group}
              onClick={() => onJump?.(part.group)}
            >
              <b>{change.delta > 0 ? '+' : '−'}</b>
              <i className={`dot group-${part.group}`} />
              <span>{part.title}</span>
              <span translate="no"> {compact(Math.abs(change.delta))}</span>
            </button>
          );
        })}
        {dropped.slice(0, 4).map((part) => (
          <button type="button" key={`dropped-${part.key}`} className="chip drop" onClick={() => onJump?.(part.group)}>
            <b>−</b>
            <span>{part.title}</span>
            <span translate="no"> {compact(part.chars)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function WhatWentIn({
  row,
  previous,
  flash,
  onView,
}: {
  row: TraceContextRun;
  previous?: TraceContextRun;
  flash?: string;
  onView: (key: string, title: ReactNode) => void;
}) {
  const { changes, dropped } = diffParts(previous?.promptRecorded ? previous.parts : undefined, row.parts);
  const groups = contextPartGroups
    .map((group) => {
      const parts = row.parts.filter((part) => part.group === group);
      const gone = dropped.filter((part) => part.group === group);
      return {
        group,
        parts,
        gone,
        chars: parts.reduce((sum, part) => sum + part.chars, 0),
        tokens: parts.reduce((sum, part) => sum + part.tokens, 0),
      };
    })
    .filter((item) => item.parts.length || item.gone.length)
    .sort((a, b) => b.chars - a.chars);
  const badge = (part: ContextPart) => {
    const change = changes.get(part.key);
    if (!change || !previous) return null;
    if (change.kind === 'new') return <span className="badge new">新加入</span>;
    if (change.kind === 'same') return <span className="badge same">相同</span>;
    if (change.kind === 'changed')
      return (
        <span className="badge changed" translate="no">
          {change.delta > 0 ? '+' : '−'}
          {number(Math.abs(change.delta))}
        </span>
      );
    return null;
  };
  return (
    <>
      <div className="trace-context-head">
        <h3>发送了什么</h3>
        {previous && (
          <span className="right" translate="no">
            {row.depth === 0
              ? withNames('尝试 {0} 对比 {1}', [String(row.attempt), String(previous.attempt)])
              : withNames('对比上一次', [])}
          </span>
        )}
      </div>
      {!row.promptRecorded ? (
        <p className="trace-context-note">这条较早的记录没有保留发送内容。</p>
      ) : (
        <table className="trace-context-parts">
          <thead>
            <tr>
              <th>部分</th>
              <th />
              <th className="r">字符</th>
              <th className="r">≈ token</th>
              <th />
            </tr>
          </thead>
          <tbody>{groups.map((item) => groupRows({ item, flash: flash === item.group, badge, onView }))}</tbody>
        </table>
      )}
      <p className="trace-context-note">
        <span>字符数是准确的；token 是估算，PugPort 不运行执行器的分词器。</span>{' '}
        {row.promptRecorded && (
          <button type="button" className="link-button" onClick={() => onView('prompt', '完整执行提示词')}>
            完整执行提示词
          </button>
        )}
      </p>
      {row.transport === 'api' ? (
        <p className="trace-context-note">Pi 的内置系统提示未上报。</p>
      ) : (
        <p className="trace-context-note">原生 CLI 自己的系统提示 PugPort 看不到，这里只有 PugPort 发出的内容。</p>
      )}
    </>
  );
}

/** A plain render helper (not a component), so the rows render with their table. */
function groupRows({
  item,
  flash,
  badge,
  onView,
}: {
  item: { group: ContextPartGroup; parts: ContextPart[]; gone: ContextPart[]; chars: number; tokens: number };
  flash: boolean;
  badge: (part: ContextPart) => ReactNode;
  onView: (key: string, title: ReactNode) => void;
}) {
  return (
    <Fragment key={item.group}>
      <tr className="group" data-group={item.group} data-flash={flash || undefined}>
        <td colSpan={2}>
          <i className={`dot group-${item.group}`} />
          {groupLabels[item.group]}
        </td>
        <td className="r" translate="no">
          {number(item.chars)}
        </td>
        <td className="r" translate="no">
          {compact(item.tokens)}
        </td>
        <td />
      </tr>
      {item.parts.map((part) => (
        <tr key={part.key}>
          <td className="name">
            <span>{part.title}</span>
            {part.delivery && (
              <small className="muted"> · {part.delivery === 'delivered' ? '已送达' : '未确认送达'}</small>
            )}
          </td>
          <td className="badge-cell">{badge(part)}</td>
          <td className="r" translate="no">
            {number(part.chars)}
          </td>
          <td className="r" translate="no">
            {compact(part.tokens)}
          </td>
          <td className="r">
            <button type="button" className="link-button" onClick={() => onView(part.key, part.title)}>
              查看原文
            </button>
          </td>
        </tr>
      ))}
      {item.gone.map((part) => (
        <tr key={`gone-${part.key}`} className="dropped">
          <td className="name">
            <span className="struck">{part.title}</span>
          </td>
          <td className="badge-cell">
            <span className="badge same">已移除</span>
          </td>
          <td className="r" translate="no">
            {number(part.chars)}
          </td>
          <td className="r">—</td>
          <td />
        </tr>
      ))}
    </Fragment>
  );
}

export function Reported({
  row,
  detail,
  executor,
}: {
  row: TraceContextRun;
  detail?: RunContextDetail;
  executor: string;
}) {
  const usage = row.usage;
  const series = (detail?.requests.items ?? []).filter((item) => item.contextTokens !== null);
  const drops = contextDrops(series);
  const maxSeries = Math.max(1, ...series.map((item) => item.contextTokens ?? 0));
  const reported = row.reported;
  const sent = Math.min(row.sent.tokens, reported?.contextTokens ?? row.sent.tokens);
  const value = (key: keyof NonNullable<typeof usage>) => {
    const raw = usage?.[key];
    return typeof raw === 'number' ? number(raw) : null;
  };
  const hit = usage ? cacheReuseRate([usage]) : null;
  const billing = !usage
    ? null
    : usage.accountingMode === 'subscription'
      ? translateInterfaceText('订阅')
      : usage.estimatedCostUsd !== null
        ? withNames('${0} 计费', [usage.estimatedCostUsd.toLocaleString(currentLocale(), { maximumFractionDigits: 4 })])
        : usage.accountingMode === 'usage'
          ? withNames('费用未报告', [])
          : null;
  const anyUsage =
    usage &&
    ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'estimatedCostUsd'].some(
      (key) => usage[key as keyof typeof usage] !== null,
    );
  return (
    <>
      <div className="trace-context-head">
        <h3 translate="no">{withNames('{0} 的报告', [executor])}</h3>
      </div>
      {reported ? (
        <div className="trace-context-meter">
          <div className="big" translate="no">
            <b>{compact(reported.contextTokens)}</b>
            <span>
              {reported.contextWindow
                ? withNames('/ {0} 已用', [compact(reported.contextWindow)])
                : withNames('已用，窗口未报告', [])}
            </span>
            {reported.contextWindow ? (
              <em>{Math.round((reported.contextTokens / reported.contextWindow) * 100)}%</em>
            ) : null}
          </div>
          <div className="mbar">
            <i
              className="group-request"
              style={{ width: `${(sent / (reported.contextWindow ?? reported.contextTokens)) * 100}%` }}
            />
            <i
              className="reported"
              style={{
                width: `${((reported.contextTokens - sent) / (reported.contextWindow ?? reported.contextTokens)) * 100}%`,
              }}
            />
          </div>
          <div className="mlegend" translate="no">
            <span>
              <i className="swatch group-request" />
              {withNames('PugPort 发送 ≈{0}', [compact(sent)])}
            </span>
            <span>
              <i className="swatch reported" />
              {withNames('{0} 自身 ≈{1}', [executor, compact(Math.max(0, reported.contextTokens - sent))])}
            </span>
          </div>
        </div>
      ) : (
        <p className="trace-context-note" translate="no">
          {anyUsage
            ? withNames('{0} 没有报告上下文占用。', [executor])
            : withNames('{0} 没有报告这次运行的 token 用量。', [executor])}
        </p>
      )}
      <dl className="trace-context-kv">
        <dt>未缓存输入</dt>
        <dd translate="no">{value('inputTokens') ?? <NotReported />}</dd>
        <dt>缓存读取 · 命中率</dt>
        <dd translate="no">
          {value('cacheReadTokens') !== null ? (
            <>
              {value('cacheReadTokens')}
              {hit !== null ? ` · ${(hit * 100).toLocaleString(currentLocale(), { maximumFractionDigits: 1 })}%` : ''}
            </>
          ) : (
            <NotReported />
          )}
        </dd>
        <dt>缓存写入</dt>
        <dd translate="no">{value('cacheWriteTokens') ?? <NotReported />}</dd>
        <dt>输出</dt>
        <dd translate="no">{value('outputTokens') ?? <NotReported />}</dd>
        {usage?.reasoningOutputTokens !== null && usage?.reasoningOutputTokens !== undefined && (
          <>
            <dt>推理输出</dt>
            <dd translate="no">{value('reasoningOutputTokens')}</dd>
          </>
        )}
        <dt>计费</dt>
        <dd translate="no">{billing ?? <NotReported />}</dd>
        <dt>耗时 · 工具</dt>
        <dd translate="no">
          {[duration(row) || '—', counted(row.tools.count, '一次工具调用', '{0} 次工具调用')].join(' · ')}
        </dd>
      </dl>
      <div className="trace-context-subhead" translate="no">
        <span>{withNames('每次模型请求的上下文 · {0}', [series.length ? String(series.length) : '—'])}</span>
        {series.length > 1 && (
          <span>
            {compact(series[0]!.contextTokens!)} → {compact(series.at(-1)!.contextTokens!)}
          </span>
        )}
      </div>
      {series.length ? (
        <>
          <div className="trace-context-spark" aria-hidden="true">
            {series.slice(-60).map((item) => (
              <i
                key={item.requestId}
                data-drop={drops.some((drop) => drop.ordinal === item.ordinal) || undefined}
                style={{ height: `${Math.max(4, ((item.contextTokens ?? 0) / maxSeries) * 100)}%` }}
                title={withNames('第 {0} 次请求 · {1}', [String(item.ordinal), compact(item.contextTokens ?? 0)])}
                data-names
              />
            ))}
          </div>
          {drops.slice(-1).map((drop) => (
            <p key={drop.ordinal} className="trace-context-note" translate="no">
              {withNames('第 {0} 次请求缩小了 {1}。执行器没有说明原因，通常表示它压缩了历史。', [
                String(drop.ordinal),
                compact(drop.shrankBy),
              ])}
            </p>
          ))}
          {detail?.requests.coverage === 'snapshot' && (
            <p className="trace-context-note">这些是占用快照，并非每次模型请求都有。</p>
          )}
        </>
      ) : (
        <p className="trace-context-note">这个执行器没有逐次请求的上下文数据。</p>
      )}
    </>
  );
}

const NotReported = () => <span className="muted">{translateInterfaceText('未报告')}</span>;

export function Why({
  row,
  workflow,
  state,
  onShow,
}: {
  row: TraceContextRun;
  workflow: Workflow;
  state: Pick<AppState, 'targets' | 'runtimes'>;
  onShow: (title: ReactNode, text: string) => void;
}) {
  const translate = routeTranslator(
    new Set([...(state.targets ?? []).map((item) => item.label), ...(state.runtimes ?? []).map((item) => item.label)]),
  );
  const judgment = workflow.taskJudgment;
  const judgmentLine = judgment
    ? [
        judgment.kind && kindLabels[judgment.kind],
        judgment.complexity && complexityLabels[judgment.complexity],
        judgment.intent && intentLabels[judgment.intent],
        workflow.input.permissionMode === 'workspace-write' ? '可写入' : '只读',
      ]
        .filter((item): item is string => !!item)
        .map((item) => translateInterfaceText(item))
        .join(' · ')
    : '';
  const reasons = [...row.route.reasons, ...row.route.warnings].map((reason) => safe(translate(reason) ?? reason));
  const memory = workflow.memoryRetrieval;
  return (
    <>
      <div className="trace-context-head">
        <h3>为何这样组装</h3>
      </div>
      <dl className="trace-context-why">
        <div>
          <dt>任务判断</dt>
          <dd>
            {judgment ? (
              <>
                <span translate="no">{judgmentLine}</span>
                <br />
                <small>{workflow.handlingSource === 'laya' ? '由 Task Router 判断' : '按规则判断'}</small>
              </>
            ) : (
              <span className="muted">没有记录任务判断</span>
            )}
            {judgment && (
              <button
                type="button"
                className="link-button"
                onClick={() =>
                  onShow(
                    '任务判断',
                    json({
                      handlingSource: workflow.handlingSource ?? 'rules',
                      routeDecision: workflow.input.routeDecision,
                      ...judgment,
                    }),
                  )
                }
              >
                查看原文
              </button>
            )}
          </dd>
        </div>
        <div>
          <dt>执行路径</dt>
          <dd>
            {reasons.length ? (
              <span translate="no">{reasons.slice(0, 3).join(' ')}</span>
            ) : (
              <span className="muted">没有记录选路理由</span>
            )}
            {row.relay?.notice && <small translate="no"> {safe(row.relay.notice)}</small>}
            {(reasons.length > 0 || row.relay) && (
              <button
                type="button"
                className="link-button"
                onClick={() =>
                  onShow('为何选择这条执行路径', [...reasons, ...(row.relay ? [json(row.relay)] : [])].join('\n'))
                }
              >
                查看原文
              </button>
            )}
          </dd>
        </div>
        <div>
          <dt>记忆检索</dt>
          <dd>
            {memory ? (
              <span translate="no">
                {memory.status === 'error'
                  ? withNames('检索失败', [])
                  : [
                      counted(memory.excerpts, '一条摘录', '{0} 条摘录'),
                      counted(memory.verifiedPaths.length, '一个路径已核实', '{0} 个路径已核实'),
                      `${number(Math.round(memory.elapsedMs))} ms`,
                    ].join(' · ')}
              </span>
            ) : (
              <span className="muted">这个任务没有检索记忆</span>
            )}
            <br />
            <small translate="no">{withNames('项目记忆版本 {0}', [String(workflow.memoryRevision)])}</small>
            {memory && (
              <button type="button" className="link-button" onClick={() => onShow('记忆检索', json(memory))}>
                查看原文
              </button>
            )}
          </dd>
        </div>
        {workflow.planning && (
          <div>
            <dt>规划策略</dt>
            <dd>
              <span>{planningLabels[workflow.planning.strategy] ?? workflow.planning.strategy}</span>
              <button type="button" className="link-button" onClick={() => onShow('规划策略', json(workflow.planning))}>
                查看原文
              </button>
            </dd>
          </div>
        )}
      </dl>
    </>
  );
}

export function Did({
  row,
  detail,
  executor,
  onOpenCalls,
}: {
  row: TraceContextRun;
  detail?: RunContextDetail;
  executor: string;
  onOpenCalls: () => void;
}) {
  const tools = detail?.tools;
  const changed = row.measuredFiles ?? [];
  const edited = changed.length ? [] : (tools?.filesEdited ?? []);
  const reads = tools?.filesRead ?? [];
  // A changed file is one row that also says how often it was read; it is never listed again as read.
  const readsOf = (path: string) => reads.filter((item) => sameFile(item.name, path)).reduce((n, i) => n + i.count, 0);
  const read = reads.filter((item) => ![...changed, ...edited].some((path) => sameFile(item.name, path)));
  const writtenRow = (path: string, label: string) => {
    const count = readsOf(path);
    return count ? withNames('{0} · 读取 ×{1}', [label, String(count)]) : label;
  };
  const tally = (items: { name: string; count: number }[], mono = false) => {
    const max = Math.max(1, ...items.map((item) => item.count));
    return items.map((item) => (
      <button type="button" className="tally" key={item.name} onClick={onOpenCalls}>
        <span className={mono ? 'mono' : undefined} translate="no">
          {safe(item.name)}
        </span>
        <span className="track2">
          <i style={{ width: `${(item.count / max) * 100}%` }} />
        </span>
        <span translate="no">{number(item.count)}</span>
      </button>
    ));
  };
  return (
    <>
      <div className="trace-context-head">
        <h3>执行动作</h3>
        <span className="right" translate="no">
          {row.depth === 0
            ? withNames('尝试 {0} · 来自 {1} 的记录', [String(row.attempt), executor])
            : withNames('来自 {0} 的记录', [executor])}
        </span>
      </div>
      {row.toolless || (detail && tools?.total === 0) ? (
        <p className="trace-context-note">这次运行没有使用工具。</p>
      ) : !detail ? (
        <p className="trace-context-note" role="status">
          正在加载执行动作…
        </p>
      ) : (
        <div className="trace-context-did-cols">
          <div>
            <h4>
              <span>工具调用次数</span>
              <span translate="no">{number(tools!.total)}</span>
            </h4>
            {tally(tools!.topTools, true)}
          </div>
          <div>
            <h4>
              <span>执行的命令</span>
              <span translate="no">{number(tools!.commandCount)}</span>
            </h4>
            {tools!.topCommands.length ? tally(tools!.topCommands, true) : <p className="muted">没有命令</p>}
          </div>
          <div>
            <h4>
              <span>涉及的文件</span>
              <span translate="no">
                {withNames('{0} 个文件 · {1} 个改动', [
                  String((changed.length || edited.length) + read.length),
                  String(changed.length || edited.length),
                ])}
              </span>
            </h4>
            <ul className="trace-context-files">
              {changed.slice(0, 6).map((path) => (
                <li key={`c:${path}`}>
                  <span className="mono" translate="no">
                    {safe(path)}
                  </span>
                  <span className="changed" translate="no">
                    {writtenRow(path, translateInterfaceText('已改动'))}
                  </span>
                </li>
              ))}
              {edited.slice(0, 6).map((path) => (
                <li key={`e:${path}`}>
                  <span className="mono" translate="no">
                    {safe(path)}
                  </span>
                  <span className="changed" translate="no">
                    {writtenRow(path, translateInterfaceText('工具写入'))}
                  </span>
                </li>
              ))}
              {read.slice(0, Math.max(2, 8 - changed.length - edited.length)).map((item) => (
                <li key={`r:${item.name}`}>
                  <span className="mono" translate="no">
                    {safe(item.name)}
                  </span>
                  <span className="read" translate="no">
                    {withNames('读取 ×{0}', [String(item.count)])}
                  </span>
                </li>
              ))}
              {!changed.length && !edited.length && !read.length && <li className="muted">没有文件记录</li>}
            </ul>
          </div>
        </div>
      )}
      <p className="trace-context-note">
        <span>改动的文件来自 PugPort 的前后项目快照；读取来自执行器的工具调用。</span>
        {tools?.coverage === 'retained-events' && <span> 这条记录的工具来自保留的事件，可能不完整。</span>}
      </p>
    </>
  );
}
