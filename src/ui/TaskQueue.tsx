import { useRef, useState } from 'react';
import { executionModel } from '../shared/execution-model';
import {
  AlertCircle,
  ArrowUp,
  Check,
  ChevronDown,
  Circle,
  Clock,
  ListTodo,
  Loader2,
  MessageSquare,
  Square,
  Terminal,
} from 'lucide-react';
import type { AppState, Workflow } from '../shared/types';
import { systemNoticeText } from '../shared/system-notices';
import { runtimeIdentity } from './core-runtime';
import { queuedSteeringRun, steerQueuedWorkflow } from './composer-steering';
import { formatElapsedDuration, workflowElapsed } from './WorkflowElapsed';
import type { Api, Notice } from './Workspace';
import {
  canCancelWorkflow,
  canContinueWorkflow,
  needsContinuation,
  canDeleteWorkflow,
  deadlineRiskLabel,
  estimatedDuration,
  isActiveWorkflow,
  isExecutingWorkflow,
  isWaitingWorkflow,
  queueDate,
  selectQueue,
  workflowStatusLabels,
  workflowDisplayStatus,
  workflowFollowUp,
  type QueueSort,
  type QueueStatusFilter,
} from './queue-utils';

type QueueProps = {
  state: AppState;
  api: Api;
  now: number;
  notify: (notice: Notice) => void;
  onConversation: (conversationId: string) => void;
  onInspect: (id: string) => void;
};

export function TaskQueue({ state, api, now, notify, onConversation, onInspect }: QueueProps) {
  const [projectId, setProjectId] = useState('');
  const [status, setStatus] = useState<QueueStatusFilter>('pending');
  const [sort, setSort] = useState<QueueSort>('progress');
  const workflows = (state.workflows ?? []).filter((workflow) => !workflow.deletedAt);
  const visible = selectQueue(workflows, projectId, status, sort);
  const scoped = workflows.filter((workflow) => !projectId || workflow.projectId === projectId);
  return (
    <section className="task-queue" aria-label="任务队列">
      <div className="management-heading">
        <h1>任务队列</h1>
      </div>
      <div className="queue-filters">
        <label className="field">
          <span>项目</span>
          <select aria-label="队列项目" value={projectId} onChange={(event) => setProjectId(event.target.value)}>
            <option value="">全部项目</option>
            {state.projects?.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>状态</span>
          <select
            aria-label="队列状态"
            value={status}
            onChange={(event) => setStatus(event.target.value as QueueStatusFilter)}
          >
            <option value="pending">待完成与需处理</option>
            <option value="all">全部状态</option>
            {Object.entries(workflowStatusLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>排序</span>
          <select aria-label="队列排序" value={sort} onChange={(event) => setSort(event.target.value as QueueSort)}>
            <option value="progress">默认</option>
            <option value="deadline">按期限</option>
            <option value="created">按加入时间</option>
          </select>
        </label>
      </div>
      <div className="queue-overview">
        <span>
          <strong>{scoped.filter(isExecutingWorkflow).length}</strong> 执行或等待审批
        </span>
        <span>
          <strong>{scoped.filter(isWaitingWorkflow).length}</strong> 排队或等待资源
        </span>
        <span>
          <strong>{scoped.filter(needsContinuation).length}</strong> 需要处理
        </span>
        <span>{visible.length} 个匹配任务</span>
      </div>
      <div className="queue-list">
        {visible.map((workflow) => (
          <QueueItem
            key={workflow.id}
            workflow={workflow}
            state={state}
            api={api}
            now={now}
            notify={notify}
            onConversation={onConversation}
            onInspect={onInspect}
          />
        ))}
      </div>
      {!visible.length && (
        <div className="queue-empty">
          <ListTodo size={25} strokeWidth={1.4} />
          <strong>{workflows.length ? '当前筛选下没有任务' : '还没有排队任务'}</strong>
          <p>
            {workflows.length
              ? '切换项目或状态，查看其他任务。'
              : '在项目对话中发送消息，可同时设置期限、开始时间和优先级。'}
          </p>
        </div>
      )}
    </section>
  );
}

export function QueueItem({
  workflow,
  state,
  api,
  now,
  notify,
  onConversation,
  onInspect,
}: QueueProps & { workflow: Workflow }) {
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const project = state.projects?.find((item) => item.id === workflow.projectId);
  const schedule = workflow.input.schedule;
  const risk = deadlineRiskLabel(workflow, now);
  const waiting = isWaitingWorkflow(workflow);
  const queueSteeringRun = queuedSteeringRun(state, workflow);
  const executing = isExecutingWorkflow(workflow);
  const displayStatus = workflowDisplayStatus(workflow, state.runs);
  const followUp = workflowFollowUp(workflow);
  const runs = workflow.runIds.flatMap((id) => {
    const run = state.runs.find((item) => item.id === id);
    return run ? [run] : [];
  });
  const elapsed = workflowElapsed(workflow, runs, now);
  const estimate = estimatedDuration(workflow);
  const hasEstimate = estimate !== '尚未估计';
  async function act(action: 'cancel' | 'continue' | 'confirm' | 'delete' | 'steer') {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    try {
      if (action === 'steer') {
        await steerQueuedWorkflow(api, workflow.id);
        notify({ tone: 'success', message: '已插入当前任务，排队任务已移除，消息记录保留。' });
        return;
      }
      await api(
        `/api/workflows/${workflow.id}${action === 'delete' ? '' : `/${action}`}`,
        action === 'delete' ? undefined : action === 'confirm' ? { proposalId: workflow.routingReview?.id } : {},
        action === 'delete' ? 'DELETE' : undefined,
      );
      if (action === 'delete') notify({ tone: 'info', message: '任务已移除，聊天与执行记录保留。' });
    } catch (error) {
      notify({ tone: 'error', message: error instanceof Error ? error.message : String(error) });
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }
  const reason = followUp
    ? '原执行记录和错误保留，后续进展见新任务。'
    : workflow.status === 'waiting-confirmation'
      ? workflow.planReview === 'pending'
        ? '请打开对话，检查并批准计划后执行。'
        : '请审核执行器、模型与推理强度，再确认开始。'
      : workflow.status === 'waiting-approval'
        ? '需要在审批卡片中确认后继续。'
        : needsContinuation(workflow)
          ? workflow.error ||
            runs.at(-1)?.error ||
            `${workflowStatusLabels[workflow.status]}；检查执行记录，处理后可继续未完成的工作。`
          : workflow.status === 'completed' && workflow.fileChangeNotice
            ? systemNoticeText.noFileChanges
            : canContinueWorkflow(workflow)
              ? workflow.error || '已停止；可从中断处继续，沿用原执行器和已完成的步骤。'
              : waiting
                ? workflow.scheduling?.reason || '等待调度器检查开始时间与可用资源。'
                : workflow.error || (executing ? undefined : '任务已结束。');
  if (workflow.deletedAt) return null;
  return (
    <details className={`queue-item queue-${workflow.status}`} data-workflow-id={workflow.id}>
      <summary>
        <div className="queue-item-heading">
          <span className="queue-state">
            {workflow.status === 'planning' || workflow.status === 'running' ? (
              <Loader2 size={13} className="spinning" />
            ) : displayStatus.verified ? (
              <Check size={13} />
            ) : workflow.status === 'completed' ? (
              workflow.input.mode === 'chat' ? (
                <MessageSquare size={13} />
              ) : (
                <Circle size={12} />
              )
            ) : (
              <Clock size={13} />
            )}
            {displayStatus.label}
          </span>
          {project ? <span translate="no">{project.name}</span> : <span>项目不可用</span>}
          {schedule?.priority === 'high' && <span className="queue-priority">高优先级</span>}
          {risk && (
            <span className="queue-risk">
              <AlertCircle size={12} />
              {risk}
            </span>
          )}
          <ChevronDown size={15} className="queue-chevron" />
        </div>
        <strong className="queue-title" translate="no">
          {workflow.input.content}
        </strong>
        {reason && <p className="queue-reason">{reason}</p>}
        {(elapsed || hasEstimate || schedule?.deadlineAt || (waiting && workflow.scheduling?.nextAttemptAt)) && (
          <div className="queue-brief">
            {elapsed && (
              <span>
                {elapsed.active ? '已运行：' : '实际用时：'}
                {formatElapsedDuration(elapsed.elapsedMs)}
              </span>
            )}
            {hasEstimate && <span>预计耗时：{estimate}</span>}
            {schedule?.deadlineAt && <span>期限：{queueDate(schedule.deadlineAt)}</span>}
            {waiting && workflow.scheduling?.nextAttemptAt && (
              <span>下次检查：{queueDate(workflow.scheduling.nextAttemptAt)}</span>
            )}
          </div>
        )}
      </summary>
      <div className="queue-detail">
        <dl className="queue-dates">
          <div>
            <dt>任务期限</dt>
            <dd>{queueDate(schedule?.deadlineAt)}</dd>
          </div>
          <div>
            <dt>最早开始</dt>
            <dd>{schedule?.notBefore ? queueDate(schedule.notBefore) : '资源可用时'}</dd>
          </div>
          <div>
            <dt>下次调度检查</dt>
            <dd>
              {waiting
                ? workflow.scheduling?.nextAttemptAt
                  ? queueDate(workflow.scheduling.nextAttemptAt)
                  : '等待状态变化'
                : '—'}
            </dd>
          </div>
          {hasEstimate && (
            <div>
              <dt>耗时估计</dt>
              <dd>{estimate}</dd>
            </div>
          )}
          {elapsed && (
            <div>
              <dt>实际用时</dt>
              <dd>{formatElapsedDuration(elapsed.elapsedMs)}</dd>
            </div>
          )}
          <div>
            <dt>加入队列</dt>
            <dd>{queueDate(workflow.createdAt)}</dd>
          </div>
          <div>
            <dt>上次评估</dt>
            <dd>
              {workflow.scheduling?.lastEvaluatedAt ? queueDate(workflow.scheduling.lastEvaluatedAt) : '尚未评估'}
            </dd>
          </div>
        </dl>
        {workflow.planning && (
          <p className="queue-note">
            {workflow.planning.strategy === 'direct'
              ? '直接执行'
              : workflow.planning.strategy === 'native'
                ? '原生 CLI 规划与执行'
                : '先规划再执行'}{' '}
            · {workflow.planning.reason}
          </p>
        )}
        {schedule?.preferExpiringQuota && <p className="queue-note">优先考虑即将重置的订阅额度。</p>}
        {workflow.error && <p className="workflow-error">{workflow.error}</p>}
        <div className="queue-actions">
          {queueSteeringRun && (
            <button
              type="button"
              className="button tiny secondary"
              disabled={pending}
              title="将这条排队消息补充到当前运行任务"
              onClick={() => void act('steer')}
            >
              {pending ? <Loader2 size={12} className="spinning" /> : <ArrowUp size={12} />}
              插入当前任务（steer）
            </button>
          )}
          {workflow.status === 'waiting-confirmation' && workflow.routingReview?.status === 'pending' && (
            <>
              <span>
                {workflow.routingReview.proposal.runtimeId} · {workflow.routingReview.proposal.model} ·{' '}
                {workflow.routingReview.proposal.effort || '默认推理强度'}
              </span>
              <button className="button tiny" disabled={pending} onClick={() => void act('confirm')}>
                确认此方案
              </button>
            </>
          )}
          {workflow.conversationId && (
            <button className="button tiny secondary" onClick={() => onConversation(workflow.conversationId)}>
              <MessageSquare size={13} />
              打开对话
            </button>
          )}
          {canCancelWorkflow(workflow) && (
            <button className="button tiny secondary" disabled={pending} onClick={() => void act('cancel')}>
              {pending ? <Loader2 size={12} className="spinning" /> : <Square size={11} />}
              {isActiveWorkflow(workflow) ? (waiting ? '取消排队' : '停止') : '取消任务'}
            </button>
          )}
          {canContinueWorkflow(workflow) && (
            <button className="button tiny secondary" disabled={pending} onClick={() => void act('continue')}>
              {pending ? <Loader2 size={12} className="spinning" /> : <ArrowUp size={12} />}继续
            </button>
          )}
          {canDeleteWorkflow(workflow) && (
            <button
              className="button tiny quiet"
              disabled={pending}
              title="移除任务卡，聊天与执行记录保留"
              onClick={() => void act('delete')}
            >
              删除任务
            </button>
          )}
        </div>
        <div className="queue-runs">
          <span>执行记录 · {runs.length}</span>
          {runs.length ? (
            runs.map((run) => (
              <button className="execution-chip" key={run.id} onClick={() => onInspect(run.id)}>
                <Terminal size={12} />
                <span>{runtimeIdentity(state, run.route.runtimeId)?.label ?? run.route.runtimeId}</span>
                <code>{executionModel(run).model}</code>
                <span>
                  {run.status === 'running'
                    ? '执行中'
                    : run.status === 'waiting-approval'
                      ? '等待审批'
                      : run.status === 'queued'
                        ? '排队中'
                        : run.status === 'completed'
                          ? '运行结束'
                          : run.status === 'cancelled'
                            ? '已取消'
                            : run.status === 'interrupted'
                              ? '已中断'
                              : '失败'}
                </span>
              </button>
            ))
          ) : (
            <p>{waiting ? '任务尚未开始，暂无执行记录。' : '暂无执行记录。'}</p>
          )}
        </div>
      </div>
    </details>
  );
}
