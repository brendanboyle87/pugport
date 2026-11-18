import type { RunRecord, Workflow } from '../shared/types';

export function conversationContextRun(
  conversationId: string | undefined,
  workflows: readonly Workflow[],
  runs: readonly RunRecord[],
): RunRecord | undefined {
  if (!conversationId) return;
  const own = workflows.filter((w) => w.conversationId === conversationId && !w.deletedAt && w.runIds.length);
  const main = own.filter((w) => !w.delegation && !w.parentWorkflowId);
  const ids = new Set((main.length ? main : own).flatMap((w) => w.runIds));
  let latest: RunRecord | undefined;
  for (const run of runs)
    if (ids.has(run.id) && run.context && (!latest || run.startedAt > latest.startedAt)) latest = run;
  return latest;
}

const tokens = (value: number) =>
  value >= 1_000_000
    ? `${Number((value / 1_000_000).toFixed(1))}M`
    : value >= 1000
      ? `${Number((value / 1000).toFixed(1))}k`
      : String(value);

export function ContextUsage({ context, executor }: { context?: RunRecord['context']; executor: string }) {
  if (!context) return null;
  const percent = context.window ? (context.tokens / context.window) * 100 : undefined;
  if (percent === undefined ? context.tokens < 50_000 : percent < 70) return null;
  const title =
    percent === undefined
      ? `上下文 ${tokens(context.tokens)} tokens · 来自 ${executor}`
      : `上下文 约 ${Math.round(percent)}% · ${tokens(context.tokens)} / ${tokens(context.window!)} tokens · 来自 ${executor}`;
  const tone =
    percent !== undefined && percent >= 90 ? 'danger' : percent !== undefined && percent >= 70 ? 'warning' : 'neutral';
  return (
    <span className={`context-usage ${tone}`} title={title} aria-label={title} tabIndex={0}>
      {percent === undefined ? (
        <span>{tokens(context.tokens)} tokens</span>
      ) : (
        <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
          <circle className="context-usage-track" cx="10" cy="10" r="7" />
          <circle
            cx="10"
            cy="10"
            r="7"
            pathLength="100"
            strokeDasharray={`${Math.min(100, percent)} 100`}
            transform="rotate(-90 10 10)"
          />
        </svg>
      )}
    </span>
  );
}
