import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { X, ExternalLink, FolderOpen } from 'lucide-react';
import type { AppState, ConversationMessage, RunRecord, Workflow } from '../shared/types';
import { sentParts, traceRecords } from '../shared/conversation-trace';
import { imagePipeline } from '../shared/image-generation';
import { mergeRunEventSnapshots } from '../shared/run-events';
import { trajectoryUsage } from '../shared/trajectory';
import { safeToolEventText } from '../shared/tool-event-data';
import { permissionLine } from '../shared/permission-reason';
import { usageMetricKeys } from '../shared/usage';
import type { Api, Notify } from './Workspace';
import { requestExecutionRecord, type ExecutionRecordRequestState } from './execution-records';
import { executionSelectionLabel } from './executor-selection';
import { WorkflowElapsed } from './WorkflowElapsed';
import { isExecutingWorkflow, workflowDisplayStatus } from './queue-utils';
import { TrajectoryDetailDialog, TrajectoryPanel } from './Trajectory';
import { TraceContext } from './TraceContext';
import { generatedImageCaption, MessageAttachments } from './MessageAttachments';
import { revealReplyPath } from './ReplyPaths';
import { currentLocale, routeTranslator, shownName, shownTitle, translateInterfaceText, withNames } from './i18n';

export type TraceTab = 'overview' | 'context' | 'calls' | 'result';
const traceTabs: [TraceTab, string][] = [
  ['overview', '概览'],
  ['context', '上下文'],
  ['calls', '过程'],
  ['result', '结果'],
];

export type ConversationTraceProps = {
  conversation: { id: string; title: string };
  workflows: Workflow[];
  messages: ConversationMessage[];
  state: AppState;
  api: Api;
  notify: Notify;
  initialWorkflowId?: string;
  initialRunId?: string;
  /** Sub-page to open first; Usage › Spend opens Context. */
  initialTab?: TraceTab;
  onClose: () => void;
  onInspect: (runId: string) => void;
};

const activeRun = (run: RunRecord) => ['queued', 'running', 'waiting-approval'].includes(run.status);
const runLabels: Record<RunRecord['status'], string> = {
  queued: '排队中',
  running: '正在执行',
  'waiting-approval': '等待审批',
  completed: '已完成',
  failed: '执行失败',
  cancelled: '已取消',
  interrupted: '已中断',
};
const policyLabels = { 'cli-only': '仅 CLI', 'api-only': '仅 API', 'cli-first': 'CLI 优先' };
const usageLabels = {
  inputTokens: '输入 token',
  outputTokens: '输出 token',
  cacheReadTokens: '缓存读取 token',
  cacheWriteTokens: '缓存写入 token',
  reasoningOutputTokens: '推理 token',
  totalTokens: '总 token',
  estimatedCostUsd: '估计费用（USD）',
};
const safe = (value: string | undefined) => safeToolEventText(value ?? '', value?.length ?? 0);
const json = (value: unknown) => safe(JSON.stringify(value, null, 2));
const date = (value: string | undefined) => (value ? new Date(value).toLocaleString(currentLocale()) : '—');

/** An inspectable layer over the conversation column; the caller hides (never unmounts) the composer while it is open. */
export function ConversationTrace({
  conversation,
  workflows,
  messages,
  state,
  api,
  notify,
  initialWorkflowId,
  initialRunId,
  initialTab = 'overview',
  onClose,
  onInspect,
}: ConversationTraceProps) {
  const [tab, setTab] = useState<TraceTab>(initialTab);
  const [callsFilter, setCallsFilter] = useState<{ filter: 'tools'; id: number }>();
  const tabId = useId();
  const [loadedFamily, setLoadedFamily] = useState<{ workflows: Workflow[]; messages: ConversationMessage[] }>({
    workflows: [],
    messages: [],
  });
  const allWorkflows = useMemo(
    () => [...new Map([...loadedFamily.workflows, ...workflows].map((item) => [item.id, item])).values()],
    [loadedFamily.workflows, workflows],
  );
  const allMessages = useMemo(
    () => [...new Map([...loadedFamily.messages, ...messages].map((item) => [item.id, item])).values()],
    [loadedFamily.messages, messages],
  );
  const records = useMemo(
    () => traceRecords(conversation.id, allWorkflows, allMessages),
    [conversation.id, allWorkflows, allMessages],
  );
  const [selectedId, setSelectedId] = useState(
    () =>
      records.find((record) => record.id === initialWorkflowId)?.id ??
      records.find((record) => initialRunId && record.runIds.includes(initialRunId))?.id ??
      records.at(-1)?.id,
  );
  const selected = records.find((record) => record.id === selectedId) ?? records.at(-1);
  const [runId, setRunId] = useState(initialRunId);
  const [request, setRequest] = useState<ExecutionRecordRequestState>();
  const [attempt, setAttempt] = useState(0);
  const [dialog, setDialog] = useState<{ title: ReactNode; text: string }>();
  const [audit, setAudit] = useState<RunRecord>();
  const [auditLoading, setAuditLoading] = useState(false);
  const auditGeneration = useRef(0);
  const layer = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    layer.current?.querySelector<HTMLButtonElement>('.conversation-trace-close')?.focus();
    return () => previous?.focus();
  }, []);

  const knownRunIds = new Set(selected?.runIds);
  const terminalSignature = state.runs
    .filter((run) => !activeRun(run) && (knownRunIds.has(run.id) || run.workflowId === selected?.id))
    .map((run) => `${run.id}:${run.status}:${run.endedAt ?? ''}`)
    .sort()
    .join('|');
  const workflowId = selected?.id;
  const hasRuns = Boolean(selected?.runIds.length);
  const removed = selected?.removed ?? false;
  useEffect(() => {
    if (!selected?.runIds.length) {
      setRequest(undefined);
      return;
    }
    const workflow = selected.workflow;
    const firstRun = selected.runIds.includes(runId ?? '') ? runId! : selected.runIds.at(-1)!;
    if (!removed) {
      const pending = requestExecutionRecord(api, workflow.id, firstRun, (next) => {
        setRequest((previous) => ({
          ...next,
          record: next.record ?? (previous?.workflowId === next.workflowId ? previous.record : undefined),
        }));
        if (next.status === 'ready' && next.record) {
          const record = next.record;
          setLoadedFamily((previous) => ({
            workflows: [
              ...new Map(
                [...previous.workflows, ...(record.relatedWorkflows ?? [])].map((item) => [item.id, item]),
              ).values(),
            ],
            messages: [
              ...new Map([...previous.messages, ...(record.messages ?? [])].map((item) => [item.id, item])).values(),
            ],
          }));
        }
      });
      return pending.cancel;
    }
    let cancelled = false;
    setRequest((previous) => ({
      workflowId: workflow.id,
      selectedRunId: firstRun,
      status: 'loading',
      record: previous?.workflowId === workflow.id ? previous.record : undefined,
    }));
    // Removed tasks retain their run audit; bound this exceptional recovery to the newest 20 attempts.
    void Promise.all(
      selected.runIds.slice(-20).map(async (id) => {
        const run = await api<RunRecord>(`/api/runs/${encodeURIComponent(id)}`, undefined, 'GET');
        if (run.id !== id || (run.workflowId && run.workflowId !== workflow.id))
          throw new Error('返回的执行记录与所选记录不一致。');
        return run;
      }),
    )
      .then((runs) => {
        if (!cancelled)
          setRequest({
            workflowId: workflow.id,
            selectedRunId: firstRun,
            status: 'ready',
            record: { workflow, runs, relatedRuns: [] },
          });
      })
      .catch((error: unknown) => {
        if (!cancelled)
          setRequest({
            workflowId: workflow.id,
            selectedRunId: firstRun,
            status: 'failed',
            error: safe(error instanceof Error ? error.message : String(error)),
          });
      });
    return () => {
      cancelled = true;
    };
    // Changing an attempt within the selected workflow reuses its complete record. Streaming is merged below.
  }, [api, workflowId, terminalSignature, hasRuns, removed, attempt]);

  const snapshot = request && request.workflowId === workflowId ? request.record : undefined;
  const workflow = useMemo(() => {
    if (!selected) return undefined;
    if (!snapshot) return selected.workflow;
    const archivedSteps = new Map(snapshot.workflow.plan.map((step) => [step.id, step]));
    return {
      ...snapshot.workflow,
      ...selected.workflow,
      // Broadcast summaries deliberately blank plan instructions and may shorten the input.
      input: snapshot.workflow.input,
      plan: selected.workflow.plan.map((step) => ({
        ...archivedSteps.get(step.id),
        ...step,
        instruction: archivedSteps.get(step.id)?.instruction ?? step.instruction,
      })),
    };
  }, [selected?.workflow, snapshot]);
  const liveById = new Map(state.runs.map((run) => [run.id, run]));
  const storedById = new Map([...(snapshot?.relatedRuns ?? []), ...(snapshot?.runs ?? [])].map((run) => [run.id, run]));
  const runs = [...new Set([...(selected?.runIds ?? []), ...(snapshot?.runs.map((item) => item.id) ?? [])])]
    .flatMap((id) => {
      const stored = storedById.get(id),
        live = liveById.get(id);
      if (!stored) return live ? [live] : [];
      if (!live) return [stored];
      return [
        {
          ...stored,
          ...live,
          prompt: live.prompt || stored.prompt,
          output: live.summary ? stored.output : live.output,
          reasoning: live.reasoning ?? stored.reasoning,
          summary: stored.summary,
          events: mergeRunEventSnapshots(stored.events, live.events),
        },
      ];
    })
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const current = runs.find((run) => run.id === runId) ?? runs.at(-1);
  const run =
    current && audit?.id === current.id
      ? {
          ...audit,
          ...current,
          prompt: audit.prompt || current.prompt,
          output: current.output.length >= audit.output.length ? current.output : audit.output,
          reasoning:
            (current.reasoning?.length ?? 0) >= (audit.reasoning?.length ?? 0) ? current.reasoning : audit.reasoning,
          events: mergeRunEventSnapshots(audit.events, current.events),
          summary: false,
          auditVersion: audit.auditVersion,
          auditEventsMissing: audit.auditEventsMissing,
          eventsDropped: audit.eventsDropped,
        }
      : current;
  useEffect(() => {
    auditGeneration.current++;
    setAudit(undefined);
    setAuditLoading(false);
    return () => {
      auditGeneration.current++;
    };
  }, [workflowId, current?.id]);
  const lastEvent = run?.events.at(-1);
  const parts = useMemo(
    () =>
      workflow
        ? sentParts(workflow, run, snapshot?.userInput ?? selected?.text, selected?.userMessage?.attachments ?? [])
        : [],
    [
      workflow,
      run?.id,
      run?.prompt,
      run?.events.length,
      lastEvent?.seq,
      snapshot?.userInput,
      selected?.text,
      selected?.userMessage?.attachments,
    ],
  );
  const usage = useMemo(() => {
    const totals = Object.fromEntries(usageMetricKeys.map((key) => [key, null])) as Record<
      (typeof usageMetricKeys)[number],
      number | null
    >;
    for (const item of runs)
      for (const [key, value] of Object.entries(trajectoryUsage(item.id === run?.id ? run : item))) {
        if (value !== null) totals[key as keyof typeof totals] = (totals[key as keyof typeof totals] ?? 0) + value;
      }
    return totals;
  }, [
    runs.map((item) => `${item.id}:${item.status}:${item.events.length}:${item.events.at(-1)?.seq ?? ''}`).join('|'),
    run?.id,
    run?.events.length,
    lastEvent?.seq,
    run?.summary,
  ]);
  const children = records.filter((record) => record.parentId === selected?.id);
  const bridgeRows = useMemo(
    () =>
      run?.events.filter((event) => {
        const detail = event.data?.detail as { source?: unknown; toWorkflowId?: unknown } | undefined;
        return (
          event.type === 'status' &&
          event.data?.source === 'pugport' &&
          ((event.data.kind === 'communication' && (!event.data.steeringPhase || Boolean(detail?.source))) ||
            (event.data.kind === 'routing' && Boolean(detail?.toWorkflowId)))
        );
      }) ?? [],
    [run?.id, run?.events.length, lastEvent?.seq, lastEvent?.at],
  );
  const translateRoute = routeTranslator(
    new Set([...(state.targets ?? []).map((item) => item.label), ...(state.runtimes ?? []).map((item) => item.label)]),
  );
  const executor = (item: RunRecord) =>
    safe(
      shownName(
        state.targets?.find((target) => target.id === item.route.runtimeId)?.label ??
          item.account?.label ??
          item.route.runtimeId,
      ),
    );
  const attemptLabel = (item: RunRecord, index: number) => (
    <>
      <span>{withNames('尝试 {0}', [String(index + 1)])}</span>
      <span translate="no"> · {executor(item)}</span>
    </>
  );
  const recordLabel = (record: (typeof records)[number]) => {
    const task = record.id === workflow?.id ? workflow : record.workflow;
    const number = task.attempt ?? (task.supersededBy ? 1 : undefined);
    const status = record.removed
      ? '已移除'
      : number && task.status === 'cancelled' && task.stopped
        ? '已停止'
        : workflowDisplayStatus(task, state.runs).label;
    const reason =
      number && ['failed', 'blocked', 'interrupted', 'cancelled'].includes(task.status)
        ? safe(
            task.error ||
              [...record.runIds]
                .reverse()
                .map((id) => liveById.get(id) ?? storedById.get(id))
                .find((item) => item?.error)?.error,
          )
        : '';
    return (
      <>
        {number && <span>{withNames('第 {0} 次', [String(number)])} · </span>}
        <span>{status}</span>
        {reason && <span translate="no"> · {reason}</span>}
      </>
    );
  };
  const select = (id: string) => {
    setSelectedId(id);
    setRunId(undefined);
    setDialog(undefined);
  };
  const show = (title: ReactNode, text: string) => setDialog({ title, text });
  const payload = (key: string, title: ReactNode, text: string, limit = 300) => (
    <div className="conversation-trace-payload" key={key}>
      <details>
        <summary>
          <span>{title}</span>
          <span className="conversation-trace-size" translate="no">
            {withNames('{0} 字', [text.length.toLocaleString(currentLocale())])}
          </span>
        </summary>
        <pre className="conversation-trace-preview" translate="no">
          {text.slice(0, limit)}
          {text.length > limit ? '…' : ''}
        </pre>
      </details>
      {text.length > limit && (
        <button type="button" className="button subtle" onClick={() => show(title, text)}>
          查看完整内容
        </button>
      )}
    </div>
  );
  const loadFullAudit = async () => {
    if (!run || auditLoading) return;
    const id = run.id,
      generation = ++auditGeneration.current;
    setAuditLoading(true);
    try {
      const value = await api<RunRecord>(`/api/runs/${encodeURIComponent(id)}`, undefined, 'GET');
      if (generation !== auditGeneration.current) return;
      if (value.id !== id) throw new Error('返回的执行记录与所选记录不一致。');
      setAudit(value);
    } catch (error) {
      if (generation === auditGeneration.current)
        notify({ tone: 'error', message: safe(error instanceof Error ? error.message : String(error)) });
    } finally {
      if (generation === auditGeneration.current) setAuditLoading(false);
    }
  };
  const pipeline = run ? imagePipeline(run) : undefined;
  // The reply that shows this run's images, with the same attachments, viewer and caption as the chat.
  const imageReply = run
    ? allMessages.find((message) => message.generatedImages?.some((image) => image.runId === run.id))
    : undefined;
  const replyImages = (imageReply?.attachments ?? []).filter((attachment) =>
    imageReply?.generatedImages?.some((image) => image.attachmentId === attachment.id),
  );
  const imageCaption = imageReply?.generatedImages?.length
    ? generatedImageCaption(imageReply.generatedImages)
    : run?.generatedImages?.length
      ? generatedImageCaption(run.generatedImages.map((image) => ({ ...image, edit: pipeline?.edit })))
      : '';
  const reveal = (path: string) =>
    void revealReplyPath(path, api).catch((error: unknown) =>
      notify({ tone: 'error', message: safe(error instanceof Error ? error.message : String(error)) }),
    );
  const fileName = (path: string) => path.split(/[\\/]/).at(-1) || path;
  const finalOutput = safe(run?.id === runs.at(-1)?.id ? (snapshot?.finalOutput ?? run?.output) : run?.output);
  const inspectId = run?.id ?? (selected?.runIds.includes(runId ?? '') ? runId : selected?.runIds.at(-1));
  const busy = request && request.workflowId === workflowId && request.status === 'loading';
  const failure =
    request && request.workflowId === workflowId && request.status === 'failed' ? request.error : undefined;

  return (
    <div
      className="conversation-trace"
      ref={layer}
      role="dialog"
      aria-label="对话轨迹"
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !dialog && !event.defaultPrevented) {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <header className="conversation-trace-header">
        <button type="button" className="icon-button conversation-trace-close" aria-label="关闭轨迹" onClick={onClose}>
          <X size={17} />
        </button>
        <div className="conversation-trace-heading">
          <h2 translate="no">{withNames('轨迹 · {0}', [safe(shownTitle(conversation.title))])}</h2>
          <span>
            {withNames('{0} 条记录', [String(records.length)])}
            {records.some((record) => isExecutingWorkflow(record.workflow))
              ? ` · ${withNames('{0} 条进行中', [String(records.filter((record) => isExecutingWorkflow(record.workflow)).length)])}`
              : ''}
          </span>
        </div>
        {inspectId && (
          <button
            type="button"
            className="button subtle conversation-trace-inspect"
            onClick={() => onInspect(inspectId)}
          >
            <ExternalLink size={14} />
            在执行记录中打开
          </button>
        )}
      </header>
      {!selected || !workflow ? (
        <p className="conversation-trace-empty">这条对话还没有任务</p>
      ) : (
        <div className="conversation-trace-body">
          <nav className="conversation-trace-records" aria-label="任务记录">
            <h3>任务记录</h3>
            <div
              role="listbox"
              aria-label="任务记录"
              onKeyDown={(event) => {
                const index = records.findIndex((record) => record.id === selected.id);
                const next =
                  event.key === 'ArrowDown'
                    ? Math.min(index + 1, records.length - 1)
                    : event.key === 'ArrowUp'
                      ? Math.max(index - 1, 0)
                      : event.key === 'Home'
                        ? 0
                        : event.key === 'End'
                          ? records.length - 1
                          : undefined;
                if (next === undefined) return;
                event.preventDefault();
                select(records[next]!.id);
                event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]')[next]?.focus();
              }}
            >
              {records.map((record) => (
                <button
                  type="button"
                  role="option"
                  key={record.id}
                  className="conversation-trace-record"
                  data-depth={record.depth}
                  data-removed={record.removed || undefined}
                  data-workflow-id={record.id}
                  aria-selected={record.id === selected.id}
                  tabIndex={record.id === selected.id ? 0 : -1}
                  onClick={() => select(record.id)}
                >
                  <span className="conversation-trace-record-text" translate="no">
                    {record.text}
                  </span>
                  <span className="conversation-trace-record-meta">
                    <i className="conversation-trace-status" data-status={record.workflow.status} />
                    {recordLabel(record)}
                    <WorkflowElapsed workflow={record.workflow} runs={state.runs} />
                  </span>
                </button>
              ))}
            </div>
          </nav>
          <div className="conversation-trace-detail" aria-busy={busy}>
            {removed && <p className="conversation-trace-note">这条任务已移除；消息保留</p>}
            {removed && selected.runIds.length > 20 && (
              <p className="conversation-trace-note">仅加载最近 20 次运行；更早记录可在执行记录中查看。</p>
            )}
            {busy && (
              <p className="conversation-trace-note" role="status">
                正在加载记录…
              </p>
            )}
            {failure && (
              <div className="conversation-trace-failure" role="alert">
                <strong>记录加载失败</strong>
                <p translate="no">{safe(failure)}</p>
                <button type="button" className="button secondary" onClick={() => setAttempt((value) => value + 1)}>
                  重试
                </button>
              </div>
            )}
            <div
              className="conversation-trace-tabs"
              role="tablist"
              aria-label="轨迹视图"
              onKeyDown={(event) => {
                const index = traceTabs.findIndex(([id]) => id === tab);
                const next =
                  event.key === 'ArrowRight'
                    ? (index + 1) % traceTabs.length
                    : event.key === 'ArrowLeft'
                      ? (index + traceTabs.length - 1) % traceTabs.length
                      : undefined;
                if (next === undefined) return;
                event.preventDefault();
                setTab(traceTabs[next]![0]);
                event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
              }}
            >
              {traceTabs.map(([id, label]) => (
                <button
                  type="button"
                  role="tab"
                  key={id}
                  id={`${tabId}-${id}`}
                  aria-selected={tab === id}
                  aria-controls={`${tabId}-${id}-panel`}
                  tabIndex={tab === id ? 0 : -1}
                  onClick={() => setTab(id)}
                >
                  {label}
                </button>
              ))}
            </div>
            <section
              className="conversation-trace-panel"
              role="tabpanel"
              id={`${tabId}-overview-panel`}
              aria-labelledby={`${tabId}-overview`}
              hidden={tab !== 'overview'}
            >
              <div className="conversation-trace-overview">
                <span>{workflowDisplayStatus(workflow, runs).label}</span>
                <WorkflowElapsed workflow={workflow} runs={runs} />
                <span translate="no">
                  {date(workflow.startedAt ?? run?.startedAt)} → {date(run?.endedAt)}
                </span>
                {run && (
                  <span translate="no">
                    {executor(run)} · {/* The chat model only called the image tool; name what drew the image. */}
                    <code className="conversation-trace-selection">
                      {pipeline
                        ? safe(pipeline.imageModel ?? translateInterfaceText('内置生图工具'))
                        : safe(executionSelectionLabel(run))}
                    </code>
                  </span>
                )}
                <span>{policyLabels[workflow.input.executionPolicy]}</span>
                <span>{withNames('项目记忆版本 {0}', [String(workflow.memoryRevision)])}</span>
              </div>
              {pipeline && (
                <p className="conversation-trace-pipeline" aria-label="图片管线">
                  <span translate="no">{safe(shownName(pipeline.executor) || executor(run!))}</span>
                  <span aria-hidden="true">→</span>
                  {pipeline.tool === 'api-images' ? (
                    <span translate="no">
                      {pipeline.imageModel
                        ? withNames(
                            pipeline.edit ? 'OpenAI Images API（{0} · 修改）' : 'OpenAI Images API（{0} · 生成）',
                            [safe(pipeline.imageModel)],
                          )
                        : 'OpenAI Images API'}
                    </span>
                  ) : (
                    <span>内置生图工具</span>
                  )}
                  {pipeline.paths.length > 0 && (
                    <>
                      <span aria-hidden="true">→</span>
                      <span>保存到</span>
                      {pipeline.paths.map((path) => (
                        <button
                          type="button"
                          className="conversation-trace-path"
                          key={path}
                          title={safe(path)}
                          translate="no"
                          onClick={() => reveal(path)}
                        >
                          {safe(fileName(path))}
                        </button>
                      ))}
                    </>
                  )}
                  {imageReply && (
                    <>
                      <span aria-hidden="true">→</span>
                      <span>放进回复</span>
                    </>
                  )}
                </p>
              )}
              {run?.permissionOrigin ? (
                <p>{permissionLine(run.permissionOrigin)}</p>
              ) : (
                <p>{workflow.input.permissionMode === 'workspace-write' ? '可写入' : '只读'}</p>
              )}
              {run?.relay && payload('relay', '接力', json(run.relay))}
              {run?.account && payload('account', '执行账号', safe(run.account.label))}
              {workflow.review && payload('review', '审查', json(workflow.review))}
              {workflow.plan.length > 0 && (
                <ol className="conversation-trace-plan">
                  {workflow.plan.map((step) => (
                    <li key={step.id}>
                      <span translate="no">{safe(step.title)}</span>
                      <span translate="no">{step.status}</span>
                      {payload(step.id, '步骤详情', json(step))}
                      <div className="conversation-trace-run-chips">
                        {runs.map((item, index) =>
                          step.runIds.includes(item.id) ? (
                            <button
                              type="button"
                              className="button subtle"
                              key={item.id}
                              aria-pressed={item.id === run?.id}
                              onClick={() => setRunId(item.id)}
                            >
                              {attemptLabel(item, index)}
                            </button>
                          ) : null,
                        )}
                      </div>
                    </li>
                  ))}
                </ol>
              )}
              {runs.length > 0 && (
                <div className="conversation-trace-runs" aria-label="运行尝试">
                  {runs.map((item, index) => (
                    <button
                      type="button"
                      className="conversation-trace-run"
                      key={item.id}
                      aria-pressed={item.id === run?.id}
                      onClick={() => setRunId(item.id)}
                    >
                      {attemptLabel(item, index)}
                      <span> · {runLabels[item.status]}</span>
                      {workflow.plan.length > 0 && !item.stepId && <span> · 规划调用</span>}
                      {item.visualAssistant && <span> · 读图辅助</span>}
                    </button>
                  ))}
                </div>
              )}
              {selected.runIds.length > 0 && (
                <div className="conversation-trace-subtasks">
                  <h4>子任务</h4>
                  {children.map((child) => (
                    <div className="conversation-trace-child" key={child.id}>
                      <span translate="no">{safe(child.workflow.delegation?.agent?.label ?? child.text)}</span>
                      <span>{workflowDisplayStatus(child.workflow, state.runs).label}</span>
                      <WorkflowElapsed workflow={child.workflow} runs={state.runs} />
                      <button type="button" className="button subtle" onClick={() => select(child.id)}>
                        查看记录 →
                      </button>
                      {child.workflow.delegation?.checkpoints?.length
                        ? payload(`${child.id}:checkpoints`, '进度记录', json(child.workflow.delegation.checkpoints))
                        : null}
                    </div>
                  ))}
                  {bridgeRows.map((event, index) =>
                    payload(
                      `bridge:${event.seq ?? index}`,
                      event.data?.kind === 'communication' ? '内部沟通' : '分配子任务',
                      json(event.data?.detail),
                    ),
                  )}
                  {!children.length && !bridgeRows.length && <p className="conversation-trace-note">没有子任务</p>}
                </div>
              )}
            </section>
            <section
              className="conversation-trace-panel"
              role="tabpanel"
              id={`${tabId}-context-panel`}
              aria-labelledby={`${tabId}-context`}
              hidden={tab !== 'context'}
            >
              {tab === 'context' &&
                (selected.runIds.length ? (
                  <TraceContext
                    api={api}
                    workflow={workflow}
                    workflows={allWorkflows}
                    runs={runs}
                    state={state}
                    selectedRunId={run?.id}
                    refresh={terminalSignature}
                    live={runs.some(activeRun)}
                    onSelectAttempt={setRunId}
                    onOpenCalls={(id) => {
                      setRunId(id);
                      setCallsFilter((previous) => ({ filter: 'tools', id: (previous?.id ?? 0) + 1 }));
                      setTab('calls');
                    }}
                    onOpenRecord={select}
                    onShow={show}
                  />
                ) : (
                  <p className="trace-context-empty">还没有发送任何内容。第一次尝试开始后，这里会显示提示词。</p>
                ))}
              {parts.some((part) => part.kind === 'steering') && (
                <p className="conversation-trace-note">PugPort 还会附加回复语言要求。</p>
              )}
              {run?.toolless && (
                <p className="conversation-trace-note">
                  <strong>纯聊天（不读文件）</strong>
                  ：任务里有别人写的消息，执行器没有任何文件、搜索、命令、网页或扩展工具，只根据收到的文字回答。
                </p>
              )}
              {run?.textOnly && <p className="conversation-trace-note">本次运行仅接收文字。</p>}
            </section>
            <section
              className="conversation-trace-panel"
              role="tabpanel"
              id={`${tabId}-calls-panel`}
              aria-labelledby={`${tabId}-calls`}
              hidden={tab !== 'calls'}
            >
              {selected.runIds.length > 0 && run ? (
                <TrajectoryPanel
                  key={run.id}
                  run={run}
                  userInput={snapshot?.userInput ?? selected.text}
                  relatedRuns={[...runs, ...(snapshot?.relatedRuns ?? [])]}
                  onInspectRun={(id) => (runs.some((item) => item.id === id) ? setRunId(id) : onInspect(id))}
                  hideContextRows
                  filterRequest={callsFilter}
                  onLoadFullAudit={() => void loadFullAudit()}
                  auditLoading={auditLoading}
                />
              ) : (
                !busy && <p className="conversation-trace-note">尚无运行记录</p>
              )}
            </section>
            <section
              className="conversation-trace-panel"
              role="tabpanel"
              id={`${tabId}-result-panel`}
              aria-labelledby={`${tabId}-result`}
              hidden={tab !== 'result'}
            >
              {(replyImages.length > 0 || imageCaption) && (
                <div className="conversation-trace-images">
                  {imageReply && replyImages.length > 0 && (
                    <MessageAttachments conversationId={imageReply.conversationId} attachments={replyImages} />
                  )}
                  <div className="conversation-trace-image-caption">
                    {imageCaption && (
                      <small className="generated-image-source" translate="no">
                        {imageCaption}
                      </small>
                    )}
                    {pipeline?.paths[0] && (
                      <button type="button" className="button subtle tiny" onClick={() => reveal(pipeline.paths[0]!)}>
                        <FolderOpen size={13} />
                        打开所在文件夹
                      </button>
                    )}
                  </div>
                </div>
              )}
              {finalOutput && (
                <div className="conversation-trace-result">
                  <h4>最终回复</h4>
                  <pre className="conversation-trace-preview" translate="no">
                    {finalOutput.slice(0, 500)}
                    {finalOutput.length > 500 ? '…' : ''}
                  </pre>
                  {finalOutput.length > 500 && (
                    <button type="button" className="button subtle" onClick={() => show('最终回复', finalOutput)}>
                      查看完整输出
                    </button>
                  )}
                </div>
              )}
              {run?.taskOutcome && payload('outcome', '执行器报告', json(run.taskOutcome))}
              {run?.measuredFileChanges && payload('files', '改动文件', json(run.measuredFileChanges))}
              {run?.verification && payload('verification', '验证', json(run.verification))}
              {(workflow.error || run?.error || run?.errorDetail || run?.startupFailure) &&
                payload(
                  'errors',
                  '错误',
                  json({
                    workflow: workflow.error,
                    error: run?.error,
                    code: run?.errorCode,
                    detail: run?.errorDetail,
                    startup: run?.startupFailure,
                  }),
                )}
              {(workflow.stopped || workflow.userCancelled) && <p className="conversation-trace-note">任务已停止</p>}
              {Object.values(usage).some((value) => value !== null) && (
                <div className="conversation-trace-usage">
                  <h4>用量</h4>
                  <dl>
                    {usageMetricKeys.map(
                      (key) =>
                        usage[key] !== null && (
                          <div key={key}>
                            <dt>{usageLabels[key]}</dt>
                            <dd translate="no">
                              {usage[key]!.toLocaleString(currentLocale(), { maximumFractionDigits: 6 })}
                            </dd>
                          </div>
                        ),
                    )}
                  </dl>
                </div>
              )}
              {!finalOutput && !run?.taskOutcome && !workflow.error && !imageCaption && (
                <p className="conversation-trace-note">尚无结果</p>
              )}
            </section>
          </div>
        </div>
      )}
      {dialog && (
        <TrajectoryDetailDialog title={dialog.title} text={dialog.text} onClose={() => setDialog(undefined)} />
      )}
    </div>
  );
}
