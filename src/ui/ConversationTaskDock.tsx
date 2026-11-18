import { ListTodo } from 'lucide-react';
import type { AppState, Workflow } from '../shared/types';
import { conversationContextRun } from './ContextUsage';
import { withNames } from './i18n';

export function ConversationTaskDock({
  workflows,
  state,
  stats = false,
}: {
  workflows: Workflow[];
  state: AppState;
  stats?: boolean;
}) {
  const own = workflows.filter((w) => !w.deletedAt && !w.parentWorkflowId && !w.delegation);
  const latest = [...own].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (!latest) return null;
  const tasks =
    state.conversationPresentations?.[latest.id]?.tasks ??
    latest.plan.map((item) => ({
      title: item.title,
      status:
        item.status === 'completed' || item.status === 'skipped'
          ? 'completed'
          : item.status === 'running'
            ? 'running'
            : 'pending',
    }));
  if (!stats)
    return tasks.length ? (
      <details className="conversation-task-dock" key={latest.id}>
        <summary>
          <ListTodo size={14} />
          <span>任务</span>
          {(['completed', 'running', 'pending'] as const).map((status) => {
            const n = tasks.filter((t) => t.status === status).length;
            return n ? (
              <span key={status} translate="no">
                {withNames(status === 'completed' ? '{0} 已完成' : status === 'running' ? '{0} 进行中' : '{0} 待处理', [
                  String(n),
                ])}
              </span>
            ) : null;
          })}
        </summary>
        <ul>
          {tasks.map((task, i) => (
            <li key={i} className={task.status}>
              <span aria-hidden="true">
                {task.status === 'completed' ? '✓' : task.status === 'running' ? '●' : '○'}
              </span>
              <span translate="no">{task.title}</span>
            </li>
          ))}
        </ul>
      </details>
    ) : null;
  const ids = new Set(workflows.flatMap((w) => w.runIds));
  const runs = state.runs.filter((r) => ids.has(r.id));
  const usage = state.usage?.perRun.filter((r) => ids.has(r.runId)) ?? [];
  const reported = usage.filter((r) => r.totalTokens !== null);
  const total = reported.reduce((sum, r) => sum + r.totalTokens!, 0);
  const calls = new Set(
    workflows.flatMap((w) =>
      (state.conversationPresentations?.[w.id]?.items ?? []).flatMap(
        (item) => item.calls?.map((call) => call.key) ?? [],
      ),
    ),
  ).size;
  const callsComplete = workflows.every((workflow) => !!state.conversationPresentations?.[workflow.id]);
  const context = conversationContextRun(latest.conversationId, workflows, runs)?.context;
  const percent = context?.window ? Math.min(100, Math.round((context.tokens / context.window) * 100)) : undefined;
  // One line per account and model, only where tokens were reported.
  const perModel = new Map<string, number>();
  for (const r of reported) {
    const key = `${r.runtimeLabel} · ${r.model}`;
    perModel.set(key, (perModel.get(key) ?? 0) + r.totalTokens!);
  }
  const breakdown = [...perModel].map(([key, tokens]) => `${key}: ${tokens.toLocaleString()} tok`).join('\n');
  return (
    <div className="conversation-stats">
      <details>
        <summary translate="no">
          {/* Calls only once every turn's projection is loaded and there was at least one; never a dash. */}
          {callsComplete && calls > 0
            ? withNames('{0} 轮 · {1} 次调用', [String(workflows.length), String(calls)])
            : withNames('{0} 轮', [String(workflows.length)])}
        </summary>
        <pre translate="no">{runs.map((r) => `${r.route.runtimeId} · ${r.route.model}`).join('\n')}</pre>
      </details>
      {reported.length > 0 && (
        <details>
          <summary>
            <span translate="no">{total.toLocaleString()} tok</span>
          </summary>
          <pre translate="no">{breakdown}</pre>
        </details>
      )}
      {percent !== undefined && (
        <details>
          <summary title="最近一轮占用的上下文窗口">
            <svg width="14" height="14" viewBox="0 0 16 16">
              <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" opacity=".2" />
              <circle
                cx="8"
                cy="8"
                r="6"
                fill="none"
                stroke="currentColor"
                pathLength="100"
                strokeDasharray={`${percent} 100`}
                transform="rotate(-90 8 8)"
              />
            </svg>
            <span translate="no">{percent}%</span>
          </summary>
          <pre translate="no">
            {context!.tokens.toLocaleString()} / {context!.window!.toLocaleString()} tok
          </pre>
        </details>
      )}
    </div>
  );
}
