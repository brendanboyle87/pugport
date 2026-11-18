import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import type { Routine, RoutineInput, RoutineSchedule } from '../shared/scheduled-tasks.ts';
import type { Conversation, MessageInput, Project, Workflow } from '../shared/types.ts';
import type { Workspace } from './workspace.ts';
import { isUnstartedQueueItem } from './task-queue.ts';

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const optionalText = z.string().trim().max(1000).optional();
export const routineSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    prompt: z.string().trim().min(1).max(50000),
    schedule: z.discriminatedUnion('type', [
      z.object({ type: z.literal('daily'), time }).strict(),
      z.object({ type: z.literal('weekdays'), time }).strict(),
      z.object({ type: z.literal('weekly'), time, weekday: z.number().int().min(0).max(6) }).strict(),
      z.object({ type: z.literal('interval'), hours: z.number().int().min(1).max(8760) }).strict(),
    ]),
    permissionMode: z.enum(['read-only', 'workspace-write']),
    projectPath: optionalText,
    executor: optionalText,
    model: optionalText,
    effort: optionalText,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      (value.permissionMode === 'workspace-write' && !value.projectPath) ||
      (value.projectPath && !isAbsolute(value.projectPath))
    )
      ctx.addIssue({ code: 'custom', path: ['projectPath'], message: '请填写项目的绝对路径。' });
  });

/** Calendar schedules use local wall time. A spring gap moves forward by the gap;
 * an autumn fold uses its first occurrence only. Intervals measure elapsed hours. */
export function nextRunAt(schedule: RoutineSchedule, after: Date, anchor?: string): string {
  if (schedule.type === 'interval') {
    const period = schedule.hours * 3600000;
    const start = anchor ? Date.parse(anchor) : after.getTime();
    if (start > after.getTime()) return new Date(start).toISOString();
    return new Date(start + Math.max(1, Math.floor((after.getTime() - start) / period) + 1) * period).toISOString();
  }
  const [hour, minute] = schedule.time.split(':').map(Number);
  for (let offset = 0; offset <= 7; offset++) {
    const candidate = new Date(after.getFullYear(), after.getMonth(), after.getDate() + offset, hour, minute);
    const day = candidate.getDay();
    if (schedule.type === 'weekdays' && (day === 0 || day === 6)) continue;
    if (schedule.type === 'weekly' && day !== schedule.weekday) continue;
    if (candidate > after) return candidate.toISOString();
  }
  throw new Error('无法计算下次运行时间。');
}

const active = new Set([
  'starting',
  'queued',
  'planning',
  'running',
  'waiting-resource',
  'waiting-approval',
  'waiting-confirmation',
]);
type RoutineWorkspace = Pick<
  Workspace,
  'store' | 'controller' | 'createProject' | 'createConversation' | 'createGeneralConversation' | 'send' | 'cancel'
>;

export class ScheduledTasks {
  private launching = new Map<string, Promise<Routine>>();
  private cancelled = new Set<string>();
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;
  constructor(
    private workspace: RoutineWorkspace,
    private now = () => new Date(),
  ) {}

  backgroundTick?: () => Promise<void>;
  start() {
    if (this.timer || this.closed) return;
    const tick = () => void this.tick().catch((error) => console.error('Scheduled tasks:', error));
    this.timer = setInterval(tick, 60000);
    this.timer.unref();
    tick();
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    await Promise.allSettled(this.launching.values());
  }
  private save(routine: Routine) {
    this.workspace.store.save('routine', routine.id, routine.id, routine);
    return routine;
  }
  get(id: string) {
    const routine = this.workspace.store.get<Routine>('routine', id);
    if (!routine) throw new Error('定时任务不存在。');
    return this.refresh(routine);
  }
  list() {
    return this.workspace.store.list<Routine>('routine', undefined, 10000).map((routine) => this.refresh(routine));
  }
  private refresh(routine: Routine) {
    if (this.launching.has(routine.id)) return routine;
    let changed = false;
    const run = routine.history.at(-1);
    if (run && active.has(run.status)) {
      const workflow = run.workflowId
        ? this.workspace.store.get<Workflow>('workflow', run.workflowId)
        : run.conversationId
          ? this.workspace.store
              .workflows(run.conversationId)
              .filter((workflow) => workflow.createdAt >= run.at)
              .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]
          : undefined;
      if (workflow) {
        const reason = workflow.error || workflow.scheduling?.reason;
        if (run.status !== workflow.status || run.reason !== reason || run.workflowId !== workflow.id) {
          Object.assign(run, { workflowId: workflow.id, status: workflow.status, reason });
          changed = true;
        }
      } else {
        run.status = 'interrupted';
        changed = true;
      }
    }
    if (changed) this.save(routine);
    return routine;
  }
  create(input: RoutineInput) {
    const value = routineSchema.parse(input);
    const now = this.now();
    return this.save({
      ...value,
      id: randomUUID(),
      enabled: false,
      createdAt: now.toISOString(),
      nextRunAt: nextRunAt(value.schedule, now),
      history: [],
    });
  }
  update(id: string, input: RoutineInput) {
    const value = routineSchema.parse(input);
    const routine = this.get(id);
    const changed = JSON.stringify(value.schedule) !== JSON.stringify(routine.schedule);
    const projectChanged = value.projectPath !== routine.projectPath;
    return this.save({
      ...routine,
      ...value,
      projectPath: value.projectPath,
      projectId: projectChanged ? undefined : routine.projectId,
      executor: value.executor,
      model: value.model,
      effort: value.effort,
      nextRunAt: changed ? nextRunAt(value.schedule, this.now()) : routine.nextRunAt,
    });
  }
  setEnabled(id: string, enabled: boolean) {
    const routine = this.get(id);
    // Time deliberately paused is not a missed run.
    if (enabled && !routine.enabled) routine.nextRunAt = nextRunAt(routine.schedule, this.now());
    routine.enabled = enabled;
    if (enabled) this.cancelled.delete(id);
    if (!enabled) this.cancelPending(routine);
    return this.save(routine);
  }
  remove(id: string) {
    this.cancelPending(this.get(id));
    this.workspace.store.db.prepare("DELETE FROM workspace_records WHERE kind='routine' AND id=?").run(id);
  }
  private cancelPending(routine: Routine) {
    if (this.launching.has(routine.id)) this.cancelled.add(routine.id);
    const run = routine.history.at(-1);
    const workflow = run?.workflowId ? this.workspace.store.get<Workflow>('workflow', run.workflowId) : undefined;
    if (workflow && isUnstartedQueueItem(workflow)) {
      this.workspace.cancel(workflow.id);
      run!.status = 'cancelled';
    }
  }
  async tick() {
    if (this.closed) return;
    try {
      await this.backgroundTick?.();
    } catch (error) {
      console.error('Scheduled digest:', error);
    }
    for (const item of this.workspace.store.list<Routine>('routine', undefined, 10000)) {
      if (this.closed) return;
      const stored = this.workspace.store.get<Routine>('routine', item.id);
      if (!stored) continue;
      const routine = this.refresh(stored);
      const now = this.now();
      const period = routine.schedule.type === 'interval' ? routine.schedule.hours * 3600000 : 8 * 86400000;
      if (Date.parse(routine.nextRunAt) - now.getTime() > period) {
        routine.nextRunAt = nextRunAt(routine.schedule, now);
        this.save(routine);
      }
      if (routine.enabled && Date.parse(routine.nextRunAt) <= this.now().getTime()) {
        try {
          await this.run(routine);
        } catch {
          /* Failure is retained in history; other routines still run. */
        }
      }
    }
  }
  runNow(id: string): Promise<Routine> {
    if (this.closed) return Promise.reject(new Error('应用正在关闭。'));
    return this.run(this.get(id));
  }
  private run(routine: Routine): Promise<Routine> {
    const id = routine.id;
    const pending = this.launching.get(id);
    if (pending) return Promise.reject(new Error('上一次运行还没结束'));
    if (active.has(routine.history.at(-1)?.status ?? '')) return Promise.reject(new Error('上一次运行还没结束'));
    // Reserve before the first await and before dispatch. Restart cannot replay the missed window.
    const now = this.now();
    routine.lastRunAt = now.toISOString();
    routine.nextRunAt = nextRunAt(routine.schedule, now, routine.nextRunAt);
    routine.history = [
      ...routine.history,
      { at: now.toISOString(), workflowId: '', status: 'starting' as const },
    ].slice(-50);
    this.workspace.controller.store.durable(() => this.save(routine));
    const promise = this.launch(routine).finally(() => {
      this.launching.delete(id);
      this.cancelled.delete(id);
    });
    this.launching.set(id, promise);
    return promise;
  }
  private async launch(routine: Routine) {
    const at = routine.lastRunAt!;
    const record = routine.history.at(-1)!;
    const persist = () => {
      // Editing, pausing or deleting during dispatch must not be undone by an old snapshot.
      const current = this.workspace.store.get<Routine>('routine', routine.id);
      if (!current) return routine;
      const index = current.history.length - 1;
      if (current.history[index]?.at === at) current.history[index] = record;
      if (current.projectPath === routine.projectPath) {
        current.projectId = routine.projectId;
        current.lastConversationId = routine.lastConversationId;
        current.lastConversationDate = routine.lastConversationDate;
      }
      return this.save(current);
    };
    try {
      if (routine.projectId) {
        const bound = this.workspace.store.get<Project>('project', routine.projectId);
        if (!bound || bound.removedAt || this.workspace.store.get('project-purge', routine.projectId))
          throw new Error('已关联的项目已移除或清空，请重新选择项目后再运行。');
      }
      const date = this.now();
      const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      const title = `${routine.name} · ${day}`;
      const project = routine.projectPath
        ? await this.workspace.createProject(routine.projectPath)
        : routine.projectId
          ? this.workspace.store.get<Project>('project', routine.projectId)
          : undefined;
      if (routine.projectId) {
        const owner = this.workspace.store.get<Project>('project', routine.projectId);
        if (!owner || owner.removedAt || this.workspace.store.get('project-purge', routine.projectId))
          throw new Error('已关联的项目已移除或清空，请重新选择项目后再运行。');
      }
      const latest = this.workspace.store.get<Routine>('routine', routine.id);
      if (!latest || (routine.enabled && !latest.enabled)) {
        record.status = 'cancelled';
        return persist();
      }
      if (project?.removedAt) throw new Error('项目已从列表移除');
      if (this.cancelled.has(routine.id)) {
        record.status = 'cancelled';
        return persist();
      }
      const previous =
        routine.lastConversationDate === day && routine.lastConversationId
          ? this.workspace.store.get<Conversation>('conversation', routine.lastConversationId)
          : undefined;
      const conversation =
        previous && !previous.deletedAt && previous.projectId === project?.id
          ? previous
          : project
            ? this.workspace.createConversation(project.id, title)
            : await this.workspace.createGeneralConversation(title);
      routine.projectId = conversation.projectId;
      routine.lastConversationId = conversation.id;
      routine.lastConversationDate = day;
      record.conversationId = conversation.id;
      persist();
      if (this.cancelled.has(routine.id)) {
        record.status = 'cancelled';
        return persist();
      }
      const input: MessageInput = {
        content: routine.prompt,
        mode: 'chat',
        permissionMode: routine.permissionMode,
        explicitWrite: routine.permissionMode === 'workspace-write',
        executionPolicy: 'cli-first',
        runtimeId: routine.executor || undefined,
        model: routine.model || undefined,
        effort: routine.effort || undefined,
        queue: true,
      };
      const { workflow } = await this.workspace.send(conversation.id, input, undefined, undefined, {
        unattended: true,
      });
      Object.assign(record, { workflowId: workflow.id, status: workflow.status, reason: workflow.scheduling?.reason });
      if (this.cancelled.has(routine.id)) this.cancelPending(routine);
    } catch (error) {
      record.status = 'failed';
      record.reason = error instanceof Error ? error.message : '请求失败';
    }
    return persist();
  }
}
