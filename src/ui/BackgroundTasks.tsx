import { Check, Clock3, Loader2, Pause, Play, Square, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { BackgroundTask } from '../shared/types';
import type { ProgressRemainingRange } from '../shared/progress-estimate';
import { BackgroundTaskEstimates } from './background-task-estimates';
import { shownName, translateInterfaceText, withNames } from './i18n';

const imageSearch = '后台找图：';
/**
 * A task title to show as written (translate="no"): an image search is titled 后台找图：<what the agent searched for>,
 * and only 后台找图 is interface text.
 */
const shownTaskTitle = (title: string) =>
  title.startsWith(imageSearch)
    ? withNames('后台找图：{0}', [title.slice(imageSearch.length)])
    : translateInterfaceText(title);

/** "about 35 minutes" style wording for the time left in a step. */
export function remainingLabel(seconds: number): string {
  if (seconds < 60) return '这一步不到 1 分钟就好';
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `这一步预计还要约 ${minutes} 分钟`;
  return `这一步预计还要约 ${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`;
}

export function remainingRangeLabel(range: ProgressRemainingRange): string {
  const min = Math.max(1, Math.floor(range.minSeconds / 60));
  const max = Math.max(min, Math.ceil(range.maxSeconds / 60));
  if (range.maxSeconds < 60) return '预计不到 1 分钟';
  if (max < 90) return min === max ? `预计约 ${max} 分钟` : `预计约 ${min}–${max} 分钟`;
  const lowHours = (range.minSeconds / 3600).toFixed(1),
    highHours = (range.maxSeconds / 3600).toFixed(1);
  return lowHours === highHours ? `预计约 ${highHours} 小时` : `预计约 ${lowHours}–${highHours} 小时`;
}

export function taskRemainingLabel(range: ProgressRemainingRange, whole = false): string {
  const label = translateInterfaceText(remainingRangeLabel(range));
  return translateInterfaceText(whole ? `整个任务${label}` : `本步${label}`);
}
const performanceReasons = {
  'warming-up': '正在测量负载',
  balanced: '按当前负载调节并发',
  'cpu-pressure': '处理器繁忙，减少并发',
  'memory-pressure': '可用内存不足，等待资源',
  'staging-pressure': '等待外接盘复制，减少排队',
  'throughput-regression': '增加并发后速度下降，降低并发',
  calibrating: '正在比较并发速度',
};

/** Each step of a multi-step job: done ones ticked, the current one highlighted, later ones dimmed. */
function TaskSteps({ steps, whole }: { steps: NonNullable<BackgroundTask['steps']>; whole: boolean }) {
  return (
    <ol className="background-task-steps">
      {steps.map((step, index) => (
        <li key={step.label} className={step.state}>
          <span className="background-task-step-mark">
            {step.state === 'done' ? <Check size={10} strokeWidth={3} /> : index + 1}
          </span>
          {step.label}
          {step.state !== 'pending' && step.total !== null && step.total > 0 && (
            <span className="background-task-step-count">
              {step.done.toLocaleString()}/{step.total.toLocaleString()}
            </span>
          )}
          {step.state !== 'pending' && step.total === null && step.done > 0 && (
            <span className="background-task-step-count">{step.done.toLocaleString()} 个</span>
          )}
          {step.note && step.state !== 'pending' && <small>{step.note}</small>}
          {step.state === 'running' && step.remainingRange && (
            <small className="background-task-step-estimate" title={step.estimateNote}>
              {whole ? taskRemainingLabel(step.remainingRange, true) : remainingRangeLabel(step.remainingRange)}
            </small>
          )}
        </li>
      ))}
    </ol>
  );
}

/**
 * Work still going after its reply, with live progress. Stop pauses it and keeps what it
 * did; Continue picks up from there (also after a restart cut it off); Close ends it. Hovering a task shows
 * what it is looking for: the picture and the folders it searches.
 */
export function BackgroundTasks({
  tasks,
  conversationId,
  onPause,
  onResume,
  onClose,
}: {
  tasks?: BackgroundTask[];
  conversationId: string;
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onClose: (id: string) => void;
}) {
  const estimates = useRef(new BackgroundTaskEstimates());
  const [now, setNow] = useState(Date.now());
  const active = tasks?.some((task) => task.conversationId === conversationId && task.state !== 'paused');
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, [active]);
  const mine = estimates.current
    .update(tasks ?? [], Math.max(now, Date.now()))
    .filter((task) => task.conversationId === conversationId);
  if (!mine.length) return null;
  return (
    <div className="background-tasks" role="status">
      {mine.map((task) => {
        const paused = task.state === 'paused';
        const checking = !paused && task.resume?.checkingFiles ? task.resume : undefined;
        const detail = checking
          ? `正在核对文件清单 · 复用已保存的 ${checking.savedFingerprints.toLocaleString()} 份指纹`
          : task.detail;
        const done = checking ? checking.checkedFiles : task.done;
        const total = checking ? 0 : task.total;
        const checkedLabel = checking
          ? `本次已核对 ${done.toLocaleString()} 个 · 上次保存 ${checking.savedFiles.toLocaleString()} 个文件`
          : undefined;
        const steps = checking
          ? task.steps?.map((step, index) => ({
              ...step,
              ...(index === 0 ? { label: '核对已保存的文件清单', done, total: null, note: checkedLabel } : {}),
              remainingSeconds: undefined,
              remainingRange: undefined,
              estimateNote: undefined,
            }))
          : task.steps;
        const share = total ? Math.min(1, done / total) : 0;
        const title = shownTaskTitle(task.title);
        const peek = !!(task.detail || task.previewUrl || task.reference || task.folders?.length);
        return (
          <div
            className={`background-task${paused ? ' paused' : ''}${task.steps || task.assistance?.workers.length ? ' has-steps' : ''}`}
            key={task.id}
            tabIndex={peek ? 0 : undefined}
          >
            <div className="background-task-copy">
              {paused ? <Pause size={14} /> : <Loader2 size={14} className="spinning" />}
              {task.previewUrl ? <img className="background-task-thumb" src={task.previewUrl} alt="" /> : null}
              <span className="background-task-text">
                <span className="background-task-title" title={title} translate="no">
                  {title}
                </span>
                <span className="background-task-detail" title={detail}>
                  {detail}
                </span>
              </span>
              {checking || total ? (
                <span className="background-task-count" title={checkedLabel}>
                  {checking
                    ? `已核对 ${done.toLocaleString()} 个`
                    : `${done.toLocaleString()} / ${total.toLocaleString()}`}
                </span>
              ) : null}
            </div>
            <span className="background-task-bar" aria-hidden="true">
              <span style={{ width: `${Math.round(share * 100)}%` }} />
            </span>
            <span
              className="background-task-note"
              title={checking ? checkedLabel : task.steps?.find((step) => step.state === 'running')?.estimateNote}
            >
              {paused
                ? '已完成的部分保留，点继续接着处理'
                : checking
                  ? detail
                  : task.remainingRange
                    ? taskRemainingLabel(task.remainingRange, task.estimateScope === 'whole-task')
                    : task.remainingSeconds !== undefined
                      ? remainingLabel(task.remainingSeconds)
                      : '完成后结果会自动发到这里'}
            </span>
            <div className="background-task-actions">
              {paused ? (
                <button type="button" className="background-task-action resume" onClick={() => onResume(task.id)}>
                  <Play size={10} fill="currentColor" />
                  继续
                </button>
              ) : (
                <button
                  type="button"
                  className="background-task-action"
                  title="暂停，已做的部分保留"
                  onClick={() => onPause(task.id)}
                >
                  <Square size={9} fill="currentColor" />
                  停止
                </button>
              )}
              <button
                type="button"
                className="background-task-action close"
                title="结束这个任务"
                onClick={() => onClose(task.id)}
              >
                <X size={12} />
                关闭
              </button>
            </div>
            {steps && <TaskSteps steps={steps} whole={!checking && task.estimateScope === 'whole-task'} />}
            {!paused && task.performance && (
              <div className="background-task-performance" title={performanceReasons[task.performance.reason]}>
                <span>
                  CPU {task.performance.cpuPercent === undefined ? '—' : `${Math.round(task.performance.cpuPercent)}%`}
                </span>
                <span>可用内存 {(task.performance.freeMemoryBytes / 1024 ** 3).toFixed(1)} GiB</span>
                <span>
                  协助并发 {task.performance.activeAssistedChecks}/{task.performance.maxAssistants}
                </span>
                {task.performance.freshChecksPerMinute !== undefined && (
                  <span>{task.performance.freshChecksPerMinute.toFixed(1)} 组/分钟</span>
                )}
                {task.performance.staging?.copying && <span>正在复制待核验视频</span>}
              </div>
            )}
            {task.mediaAudit && (
              <div className="background-task-performance" title="核验进度按候选组合计数；相似证据不等于已回收文件">
                <span>相似证据 {task.mediaAudit.evidenceGroups.toLocaleString()} 组</span>
                {task.mediaAudit.readErrors > 0 && (
                  <span>读取/核验异常 {task.mediaAudit.readErrors.toLocaleString()}</span>
                )}
                {task.mediaAudit.scope === 'partial' && <span>本批未覆盖全部目录</span>}
              </div>
            )}
            {!!task.assistance?.workers.length && (
              <div className="background-task-assistants">
                {task.assistance.workers.map((worker, index) => (
                  <span
                    key={worker.workerId}
                    className={`background-task-assistant ${worker.status}`}
                    title={`${shownName(worker.accountLabel)} · ${worker.model ?? ''} ${worker.effort ?? ''} · ${worker.status}`}
                    data-names
                  >
                    {worker.status === 'running' ? (
                      <Loader2 size={11} className="spinning" />
                    ) : worker.status === 'waiting' ? (
                      <Clock3 size={11} />
                    ) : worker.status === 'completed' ? (
                      <Check size={11} />
                    ) : worker.status === 'failed' ? (
                      <X size={11} />
                    ) : (
                      <Pause size={11} />
                    )}
                    <span translate="no">{shownName(worker.accountLabel)}</span> {index + 1} · 队尾核验{' '}
                    {worker.checked.toLocaleString()}
                    {worker.status === 'waiting' && <small>等待资源</small>}
                    {worker.model && (
                      <small>
                        {worker.model} {worker.effort}
                      </small>
                    )}
                  </span>
                ))}
              </div>
            )}
            {peek && (
              <div className="background-task-peek" role="tooltip">
                {task.previewUrl ? (
                  <img src={task.previewUrl} alt="正在找的图片" />
                ) : task.reference ? (
                  <code>{task.reference}</code>
                ) : null}
                {detail ? <code>{detail}</code> : null}
                {task.folders?.length ? (
                  <div>
                    <small>搜索范围</small>
                    {task.folders.map((folder) => (
                      <code key={folder}>{folder}</code>
                    ))}
                  </div>
                ) : null}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
