import { setTimeout as delay } from 'node:timers/promises';
import { progressText, type Output } from './ask.ts';
import { BackendError, BackendUnavailable, type PugPortClient } from './client.ts';

type Task = Parameters<typeof progressText>[0] & { conversationId?: string; startedAt?: string };
const ended = new Set(['completed', 'failed', 'cancelled']);
const attention = new Set(['waiting-approval', 'waiting-confirmation']);
const need = (status: string) =>
  ended.has(status)
    ? 'done'
    : attention.has(status) || status === 'blocked' || status === 'interrupted'
      ? 'attention'
      : null;

export async function runWait(
  client: Pick<PugPortClient, 'get'>,
  args: { taskIds: string[]; timeoutMs: number; json?: boolean },
  io: {
    now?: () => number;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    stdout?: Output;
    stderr?: Output;
    parentAlive?: () => boolean;
    signal?: AbortSignal;
  } = {},
): Promise<number> {
  const now = io.now ?? Date.now;
  const sleep = io.sleep ?? ((ms, signal) => delay(ms, undefined, { signal }));
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const parentAlive =
    io.parentAlive ??
    (() => {
      try {
        process.kill(process.ppid, 0);
        return true;
      } catch {
        return false;
      }
    });
  const started = now();
  const deadline = started + args.timeoutMs;
  const tasks = args.taskIds.map((taskId) => ({
    task: { taskId, status: 'unknown' } as Task,
    seen: undefined as string | undefined,
    triggered: false,
  }));
  const controller = new AbortController();
  const { signal } = controller;
  let code: number | undefined;
  let silent = false;
  let failure: string | undefined;
  const unavailable = new Set<string>();
  const finish = (value: number) => {
    if (code === undefined || (code === 0 && value === 3)) code = value;
    controller.abort();
  };
  const onInterrupt = () => finish(130);
  process.once('SIGINT', onInterrupt);
  io.signal?.addEventListener('abort', onInterrupt, { once: true });
  if (io.signal?.aborted) onInterrupt();
  const timer = setTimeout(() => finish(124), args.timeoutMs);
  const ready = () => {
    if (signal.aborted) return false;
    if (!parentAlive()) {
      silent = true;
      finish(124);
      return false;
    }
    if (now() >= deadline) {
      finish(124);
      return false;
    }
    return true;
  };
  const read = async (entry: (typeof tasks)[number], initial: boolean) => {
    let backoff = 1000;
    while (ready()) {
      try {
        const reply = await client.get<Partial<Task> & { status: string }>(
          `/api/external/tasks/${entry.task.taskId}${initial ? '' : '/result?wait=50'}`,
          { signal, timeoutMs: 60_000 },
        );
        unavailable.delete(entry.task.taskId);
        const previous = entry.task.status;
        entry.task = { ...entry.task, ...reply, taskId: entry.task.taskId };
        if (initial && attention.has(reply.status)) entry.seen = reply.status;
        const age = started - Date.parse(entry.task.startedAt ?? '');
        entry.triggered =
          ended.has(reply.status) ||
          reply.status === 'blocked' ||
          reply.status === 'interrupted' ||
          (attention.has(reply.status) && ((!initial && previous !== reply.status) || (age >= 0 && age < 60000)));
        // Once we leave the initial approval, returning to it is a new request for the owner.
        if (!initial && previous !== reply.status) entry.seen = undefined;
        if (entry.triggered) finish(need(reply.status) === 'attention' ? 3 : 0);
        return;
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof BackendUnavailable) {
          if (!unavailable.size) stderr.write('PugPort 暂时连不上，继续等…\n');
          unavailable.add(entry.task.taskId);
          try {
            await sleep(Math.min(backoff, Math.max(0, deadline - now())), signal);
          } catch (error) {
            if (!signal.aborted) throw error;
          }
          backoff = Math.min(10000, backoff * 2);
          continue;
        }
        failure =
          error instanceof BackendError && error.status === 404
            ? `${entry.task.taskId} 找不到这个任务。`
            : error instanceof Error
              ? error.message
              : String(error);
        entry.task.error = failure;
        finish(1);
      }
    }
  };
  try {
    await Promise.all(tasks.map((entry) => read(entry, true)));
    if (code === undefined)
      await Promise.all(
        tasks.map(async (entry) => {
          while (ready()) await read(entry, false);
        }),
      );
  } finally {
    clearTimeout(timer);
    controller.abort();
    process.off('SIGINT', onInterrupt);
    io.signal?.removeEventListener('abort', onInterrupt);
  }
  if (silent || code === 130) return code ?? 124;
  const waitedSeconds = Math.max(0, Math.floor((now() - started) / 1000));
  tasks.sort((a, b) => Number(b.triggered) - Number(a.triggered));
  if (args.json) {
    stdout.write(
      `${JSON.stringify({
        outcome: code === 0 ? 'done' : code === 3 ? 'attention' : code === 124 ? 'timeout' : 'error',
        waitedSeconds,
        tasks: tasks.map(({ task, triggered }) => ({
          taskId: task.taskId,
          conversationId: task.conversationId ?? null,
          status: task.status,
          need: need(task.status),
          new: triggered,
          executor: task.executor ?? null,
          model: task.model ?? null,
          error: task.error ?? null,
        })),
      })}\n`,
    );
  } else
    for (const { task, triggered, seen } of tasks) {
      const oneLine = (value: string) => value.replace(/[\r\n]+/g, ' ');
      const descriptions: Record<string, string> = {
        completed: `已完成，用 task_result 读取答复${task.executor || task.model ? `（${[task.executor, task.model].filter(Boolean).join(' · ')}）` : ''}`,
        failed: `没有完成：${oneLine(task.error ?? '').slice(0, 120)}`,
        cancelled: '已取消',
        blocked: `暂停了：${task.note || task.error || ''}；主人可以在 PugPort 里继续`,
        interrupted: '中断了（PugPort 可能重启过）；主人可以在 PugPort 里继续',
        'waiting-approval': '等主人在 PugPort 里批准',
        'waiting-confirmation': '等主人在 PugPort 里确认',
      };
      // A task whose first lookup failed has no status to describe, only the error.
      if (task.status === 'unknown' && task.error)
        stdout.write(`${task.taskId} error — ${oneLine(task.error).replace(`${task.taskId} `, '')}\n`);
      else
        stdout.write(
          `${task.taskId} ${task.status} — ${oneLine(descriptions[task.status] ?? progressText(task))}${!triggered && seen === task.status ? '（开始等待前就在等）' : ''}\n`,
        );
    }
  if (failure) stderr.write(`${failure}\n`);
  if (code === 124) stderr.write(`等了 ${Number((args.timeoutMs / 60000).toFixed(2))} 分钟，没有任务需要你。\n`);
  return code ?? 1;
}
