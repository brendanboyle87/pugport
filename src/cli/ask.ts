/**
 * `pugport ask "<task>"`: hand one task to PugPort through its external task API, show who took it and how it
 * is going (on stderr), print the answer (on stdout) and exit; non-zero when it did not finish.
 */
import { type PugPortClient } from './client.ts';
import { pugFace } from './pug-logo.ts';
import { askCallerContext, askRequest } from './routing.ts';
import { probeCaller } from '../mcp/caller-probe.ts';
import type { Theme } from './theme.ts';

type TaskStatus = {
  taskId: string;
  status: string;
  phase?: string;
  planReview?: 'pending' | 'approved';
  executor?: string;
  model?: string;
  note?: string;
  error?: string;
};
type TaskResult = { status: string; result?: string; error?: string };
export type Output = { write(text: string): unknown; isTTY?: boolean };

const settled = new Set(['completed', 'blocked', 'failed', 'cancelled', 'interrupted']);
const waiting: Record<string, string> = {
  queued: '排队中',
  'waiting-resource': '在等有额度的账号',
  'waiting-confirmation': '等你在 PugPort 桌面应用里确认用哪个账号',
  'waiting-approval': '等你在 PugPort 桌面应用里批准一个操作',
  planning: '正在规划',
};
const phases: Record<string, string> = {
  route: '正在挑选账号',
  plan: '正在规划',
  verify: '正在检查结果',
  summarize: '正在整理答复',
};
const endings: Record<string, string> = {
  failed: '没有完成',
  blocked: '暂停了，可以在 PugPort 里继续',
  cancelled: '已取消',
  interrupted: '中断了，可以在 PugPort 里继续',
};

/** One short line about where the task is. */
export function progressText(status: TaskStatus) {
  if (status.status === 'waiting-confirmation' && status.planReview === 'pending')
    return '等你在 PugPort 桌面应用里批准计划';
  const who = status.executor ? `${status.executor}${status.model ? ` · ${status.model}` : ''}` : '';
  if (waiting[status.status]) return `${waiting[status.status]}${status.note ? `：${status.note}` : ''}`;
  if (status.phase && phases[status.phase] && !(status.phase === 'route' && who)) return phases[status.phase]!;
  return who ? `${who} 正在处理` : '正在处理';
}

export async function runAsk(
  command: { task: string; write: boolean; agent?: string; json?: boolean; resumeId?: string },
  deps: {
    client: PugPortClient;
    cwd: string;
    theme: Theme;
    stdout: Output;
    stderr: Output;
    /** Aborted on Ctrl+C: the task is cancelled in PugPort too. */
    signal?: AbortSignal;
    waitSeconds?: number;
    probe?: typeof probeCaller;
  },
): Promise<number> {
  const { client, theme, stderr, stdout } = deps;
  const live = !!stderr.isTTY;
  let shown = '';
  const show = (text: string) => {
    if (text === shown) return;
    shown = text;
    if (live) stderr.write(`\r\x1b[2K${theme.fg('accent', '…')} ${theme.fg('muted', text)}`);
    else stderr.write(`… ${text}\n`);
  };
  const clear = () => {
    if (live && shown) stderr.write('\r\x1b[2K');
  };
  const callerContext = command.write ? await askCallerContext(deps.cwd, deps.probe ?? probeCaller) : undefined;
  const [url, body] = command.resumeId
    ? [
        `/api/external/conversations/${encodeURIComponent(command.resumeId)}/messages`,
        {
          message: command.task,
          write: command.write,
          ...(callerContext ? { callerContext } : {}),
          ...(command.agent ? { executors: [command.agent] } : {}),
        },
      ]
    : [
        '/api/external/tasks',
        askRequest({
          task: command.task,
          projectPath: deps.cwd,
          write: command.write,
          agent: command.agent,
          callerContext,
        }),
      ];
  // No taskId: handed to a device or outside agent, or queued.
  const created = await client.post<{
    taskId?: string;
    conversationId?: string;
    title?: string;
    note?: string;
    queued?: boolean;
    handedTo?: string;
  }>(url, body, { timeoutMs: 60_000 });
  const conversationId = created.conversationId ?? command.resumeId;
  if (conversationId) stderr.write(`对话 ${conversationId}\n`);
  if (!created.taskId) {
    if (created.note) stderr.write(`${created.note}\n`);
    if (command.json)
      stdout.write(
        `${JSON.stringify({ conversationId, note: created.note, queued: created.queued, handedTo: created.handedTo })}\n`,
      );
    return 0;
  }
  stderr.write(`任务 ${created.taskId}\n`);

  stderr.write(`${theme.fg('accent', pugFace)} 已交给 PugPort${created.title ? `：${created.title}` : ''}\n`);
  const path = `/api/external/tasks/${encodeURIComponent(created.taskId)}`;
  let executor = '';
  try {
    for (;;) {
      if (deps.signal?.aborted) throw deps.signal.reason;
      const status = await client.get<TaskStatus>(path, { signal: deps.signal });
      if (status.executor) executor = `${status.executor}${status.model ? ` · ${status.model}` : ''}`;
      if (!settled.has(status.status)) show(progressText(status));
      const wait = deps.waitSeconds ?? 5;
      const result = await client.get<TaskResult>(`${path}/result?wait=${wait}`, {
        signal: deps.signal,
        timeoutMs: (wait + 30) * 1000,
      });
      if (!settled.has(result.status)) continue;
      clear();
      if (command.json) {
        const finalStatus = await client.get<TaskStatus>(path, { signal: deps.signal });
        stdout.write(
          `${JSON.stringify({ taskId: created.taskId, conversationId, status: result.status, executor: finalStatus.executor, model: finalStatus.model, result: result.result, error: result.error })}\n`,
        );
      }
      if (result.status === 'completed') {
        stderr.write(`${theme.fg('success', '✓')} 完成${executor ? theme.fg('dim', ` · ${executor}`) : ''}\n`);
        const answer = result.result ?? '';
        if (!command.json) stdout.write(answer.endsWith('\n') ? answer : `${answer}\n`);
        return 0;
      }
      stderr.write(
        `${theme.fg('error', '✗')} ${endings[result.status] ?? result.status}${result.error ? `：${result.error}` : ''}\n`,
      );
      return result.status === 'blocked' || result.status === 'interrupted' ? 3 : 1;
    }
  } catch (error) {
    if (!deps.signal?.aborted) throw error;
    clear();
    // The user pressed Ctrl+C: stop the task too, so no account keeps working on it.
    await client
      .post(`/api/external/tasks/${encodeURIComponent(created.taskId)}/cancel`, {}, { timeoutMs: 5000 })
      .catch(() => undefined);
    stderr.write(`${theme.fg('muted', '已取消。')}\n`);
    return 130;
  }
}
