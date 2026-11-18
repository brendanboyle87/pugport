import { currentLocale } from './i18n';
import { useCallback, useEffect, useRef, useState } from 'react';
import { CalendarClock, MoreHorizontal, Plus, X } from 'lucide-react';
import type { Routine, RoutineInput, RoutineSchedule } from '../shared/scheduled-tasks';
import type { AppState, Conversation } from '../shared/types';
import type { Api, Notice } from './Workspace';
import { confirmDialog } from './confirm-dialog';
import { withNames } from './i18n';

const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
export function scheduleLabel(schedule: RoutineSchedule) {
  if (schedule.type === 'interval') return `每隔 ${schedule.hours} 小时`;
  if (schedule.type === 'weekly') return `每周 ${weekdays[schedule.weekday]} ${schedule.time}`;
  return schedule.type === 'daily' ? `每天 ${schedule.time}` : `工作日 ${schedule.time}`;
}
const statusLabels = {
  starting: '准备中',
  queued: '排队中',
  'waiting-resource': '等待资源',
  'waiting-confirmation': '等待确认',
  planning: '规划中',
  running: '运行中',
  'waiting-approval': '等待批准',
  blocked: '受阻',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断',
};
const displayDate = (value: string) =>
  new Date(value).toLocaleString(currentLocale(), {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
type Props = {
  api: Api;
  state: AppState;
  notify: (message: Notice) => void;
  onConversation: (conversation: Conversation) => void;
};

export function ScheduledTasks({ api, state, notify, onConversation }: Props) {
  const [items, setItems] = useState<Routine[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [editor, setEditor] = useState<Routine | 'new' | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const pending = useRef(false);
  const refresh = useCallback(async () => {
    setItems(await api<Routine[]>('/api/scheduled-tasks', undefined, 'GET'));
    setLoaded(true);
  }, [api]);
  useEffect(() => {
    void refresh().catch((error) => notify({ tone: 'error', message: String(error) }));
    const timer = setInterval(() => void refresh().catch(() => {}), 15000);
    return () => clearInterval(timer);
  }, [refresh, notify]);
  async function action(id: string, work: () => Promise<unknown>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(id);
    try {
      await work();
      await refresh();
    } catch (error) {
      notify({ tone: 'error', message: String(error) });
    } finally {
      pending.current = false;
      setBusy(null);
    }
  }
  return (
    <section className="routines-page">
      <header className="management-heading">
        <div>
          <h1>定时任务</h1>
          <p className="muted">按本地时间自动运行并使用额度；错过的周期只补跑一次。</p>
        </div>
        <button className="button primary" onClick={() => setEditor('new')}>
          <Plus size={16} />
          新建任务
        </button>
      </header>
      {!items.length && (
        <div className="routines-empty">
          <CalendarClock size={32} />
          <h2>{loaded ? '还没有定时任务' : '正在加载'}</h2>
          <p className="muted">新任务默认暂停，检查设置后再开启。</p>
        </div>
      )}
      <div className="routines-list">
        {items.map((routine) => (
          <article className="routine-card" key={routine.id}>
            <div className="routine-top">
              <div className="routine-title">
                <h2 translate="no">{routine.name}</h2>
                <p>{scheduleLabel(routine.schedule)}</p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={routine.enabled}
                aria-label={withNames('{0} · 启用', [routine.name])}
                data-names
                className="routine-switch"
                disabled={!!busy}
                onClick={() =>
                  void action(routine.id, () =>
                    api(`/api/scheduled-tasks/${routine.id}`, { enabled: !routine.enabled }, 'PATCH'),
                  )
                }
              >
                <span />
              </button>
              <details className="routine-menu">
                <summary aria-label="任务操作">
                  <MoreHorizontal size={20} />
                </summary>
                <div>
                  <button
                    disabled={!!busy}
                    onClick={() => void action(routine.id, () => api(`/api/scheduled-tasks/${routine.id}/run`, {}))}
                  >
                    立即运行
                  </button>
                  <button onClick={() => setEditor(routine)}>编辑</button>
                  <button
                    className="danger"
                    disabled={!!busy}
                    onClick={async () => {
                      if (
                        await confirmDialog({
                          title: '删除这个定时任务？',
                          summary: '已有对话会保留。',
                          action: '删除',
                          tone: 'danger',
                        })
                      )
                        void action(routine.id, () => api(`/api/scheduled-tasks/${routine.id}`, undefined, 'DELETE'));
                    }}
                  >
                    删除
                  </button>
                </div>
              </details>
            </div>
            <p className="routine-next">{routine.enabled ? `下次运行：${displayDate(routine.nextRunAt)}` : '已暂停'}</p>
            <p className="muted routine-meta">
              {routine.permissionMode === 'workspace-write' ? '可写入' : '只读'} ·{' '}
              {routine.projectPath ? (
                <span title={routine.projectPath} translate="no">
                  {routine.projectPath
                    .replace(/[\\/]+$/, '')
                    .split(/[\\/]/)
                    .pop() || routine.projectPath}
                </span>
              ) : (
                '日常对话'
              )}
            </p>
            <details className="routine-history">
              <summary>
                运行历史 <span className="muted">{routine.history.length}</span>
              </summary>
              {!routine.history.length && <p className="muted">暂无运行记录</p>}
              <ol>
                {[...routine.history].reverse().map((run, index) => (
                  <li key={`${run.at}-${index}`}>
                    <div>
                      <time dateTime={run.at}>{displayDate(run.at)}</time>
                      <span className={`routine-status ${run.status}`}>{statusLabels[run.status]}</span>
                      {run.conversationId && (
                        <a
                          href={`#conversation=${run.conversationId}`}
                          onClick={(event) => {
                            event.preventDefault();
                            void api<{ conversation: Conversation }>(
                              `/api/conversations/${run.conversationId}`,
                              undefined,
                              'GET',
                            )
                              .then((result) => onConversation(result.conversation))
                              .catch((error) => notify({ tone: 'error', message: String(error) }));
                          }}
                        >
                          查看对话
                        </a>
                      )}
                    </div>
                    {run.reason && <p className="muted">{run.reason}</p>}
                  </li>
                ))}
              </ol>
            </details>
          </article>
        ))}
      </div>
      {editor && (
        <RoutineDialog
          routine={editor === 'new' ? undefined : editor}
          state={state}
          onClose={() => setEditor(null)}
          onSave={async (input) => {
            await api(
              `/api/scheduled-tasks${editor === 'new' ? '' : `/${editor.id}`}`,
              input,
              editor === 'new' ? 'POST' : 'PUT',
            );
            await refresh();
            setEditor(null);
          }}
        />
      )}
    </section>
  );
}

export function RoutineDialog({
  routine,
  state,
  onClose,
  onSave,
}: {
  routine?: Routine;
  state: Pick<AppState, 'runtimes'>;
  onClose: () => void;
  onSave: (input: RoutineInput) => Promise<void>;
}) {
  const modal = useRef<HTMLDialogElement>(null);
  const [input, setInput] = useState<RoutineInput>(() =>
    routine
      ? {
          name: routine.name,
          prompt: routine.prompt,
          schedule: routine.schedule,
          permissionMode: routine.permissionMode,
          projectPath: routine.projectPath,
          executor: routine.executor,
          model: routine.model,
          effort: routine.effort,
        }
      : { name: '', prompt: '', schedule: { type: 'daily', time: '09:00' }, permissionMode: 'read-only' },
  );
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const dialog = modal.current!;
    const previous = document.activeElement as HTMLElement | null;
    dialog.showModal();
    return () => {
      dialog.close();
      previous?.focus();
    };
  }, []);
  const field = <K extends keyof RoutineInput>(key: K, value: RoutineInput[K]) =>
    setInput((old) => ({ ...old, [key]: value }));
  const schedule = input.schedule;
  const runtime = state.runtimes.find((item) => item.id === input.executor);
  return (
    <dialog
      ref={modal}
      className="routine-dialog"
      aria-labelledby="routine-dialog-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!saving) onClose();
      }}
    >
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (savingRef.current) return;
          savingRef.current = true;
          setSaving(true);
          setError('');
          try {
            await onSave(input);
          } catch (error) {
            setError(String(error));
          } finally {
            savingRef.current = false;
            setSaving(false);
          }
        }}
      >
        <header className="routines-heading">
          <h2 id="routine-dialog-title">{routine ? '编辑定时任务' : '新建定时任务'}</h2>
          <button type="button" className="icon-button" aria-label="关闭" disabled={saving} onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        <fieldset disabled={saving}>
          <label className="field">
            <span>名称</span>
            <input
              autoFocus
              required
              maxLength={120}
              value={input.name}
              onChange={(event) => field('name', event.target.value)}
            />
          </label>
          <div className="routine-fields">
            <label className="field">
              <span>重复频率</span>
              <select
                value={schedule.type}
                onChange={(event) => {
                  const type = event.target.value as RoutineSchedule['type'];
                  field(
                    'schedule',
                    type === 'interval'
                      ? { type, hours: 4 }
                      : type === 'weekly'
                        ? { type, time: '09:00', weekday: 1 }
                        : { type, time: '09:00' },
                  );
                }}
              >
                <option value="daily">每天</option>
                <option value="weekdays">工作日</option>
                <option value="weekly">每周</option>
                <option value="interval">每隔 N 小时</option>
              </select>
            </label>
            {schedule.type === 'interval' ? (
              <label className="field">
                <span>间隔小时</span>
                <input
                  type="number"
                  min={1}
                  max={8760}
                  required
                  value={schedule.hours}
                  onChange={(event) => field('schedule', { type: 'interval', hours: Number(event.target.value) })}
                />
              </label>
            ) : (
              <label className="field">
                <span>本地时间</span>
                <input
                  type="time"
                  required
                  value={schedule.time}
                  onChange={(event) => field('schedule', { ...schedule, time: event.target.value })}
                />
              </label>
            )}
            {schedule.type === 'weekly' && (
              <label className="field">
                <span>星期</span>
                <select
                  value={schedule.weekday}
                  onChange={(event) => field('schedule', { ...schedule, weekday: Number(event.target.value) })}
                >
                  {weekdays.map((day, index) => (
                    <option key={day} value={index}>
                      {day}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          <label className="field">
            <span>权限</span>
            <select
              value={input.permissionMode}
              onChange={(event) => field('permissionMode', event.target.value as RoutineInput['permissionMode'])}
            >
              <option value="read-only">只读</option>
              <option value="workspace-write">可写入</option>
            </select>
          </label>
          <label className="field">
            <span>项目文件夹</span>
            <input
              required={input.permissionMode === 'workspace-write'}
              value={input.projectPath ?? ''}
              onChange={(event) => field('projectPath', event.target.value)}
              placeholder="只读任务可留空，使用日常对话"
            />
          </label>
          <label className="field">
            <span>执行器</span>
            <select
              value={input.executor ?? ''}
              onChange={(event) => {
                field('executor', event.target.value);
                field('model', '');
                field('effort', '');
              }}
            >
              <option value="">自动</option>
              {input.executor && !runtime && <option value={input.executor}>{input.executor}</option>}
              {state.runtimes.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <div className="routine-fields">
            <label className="field">
              <span>模型（可选）</span>
              <input
                list="routine-models"
                value={input.model ?? ''}
                onChange={(event) => field('model', event.target.value)}
              />
              <datalist id="routine-models">
                {runtime?.models.map((model) => (
                  <option key={model.id} value={model.id} />
                ))}
              </datalist>
            </label>
            <label className="field">
              <span>推理强度（可选）</span>
              <input
                list="routine-efforts"
                value={input.effort ?? ''}
                onChange={(event) => field('effort', event.target.value)}
              />
              <datalist id="routine-efforts">
                {(runtime?.models.find((model) => model.id === input.model)?.efforts ?? ['low', 'medium', 'high']).map(
                  (effort) => (
                    <option key={effort} value={effort} />
                  ),
                )}
              </datalist>
            </label>
          </div>
          <label className="field">
            <span>提示词</span>
            <textarea
              required
              rows={5}
              maxLength={50000}
              value={input.prompt}
              onChange={(event) => field('prompt', event.target.value)}
            />
          </label>
        </fieldset>
        {error && (
          <p role="alert" className="danger">
            {error}
          </p>
        )}
        <footer>
          <span className="muted">{routine ? '保存后保留当前开关状态。' : '新任务默认暂停，检查设置后再开启。'}</span>
          <button type="submit" className="button primary" disabled={saving}>
            {saving ? '正在保存' : '保存'}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
