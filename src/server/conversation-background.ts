import { deriveTrajectory, type TrajectoryRow } from '../shared/trajectory.ts';
import { safeToolEventText, safeToolEventValue } from '../shared/tool-event-data.ts';
import { activityArgument, presentationPreview } from '../shared/activity-vocabulary.ts';
import type { BackgroundWork } from '../shared/conversation-presentation.ts';
import type { RunRecord, Workflow } from '../shared/types.ts';
const object = (value: unknown): Record<string, unknown> => {
  if (typeof value === 'string') {
    if (!['{', '[', '"'].includes(value.trimStart()[0])) return {};
    try {
      return object(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
};
export function backgroundWork(
  runs: RunRecord[],
  members: Workflow[],
  detail = false,
  trajectories?: Map<string, TrajectoryRow[]>,
): BackgroundWork[] {
  const jobs = new Map<string, BackgroundWork>();
  const sessions = new Map<string, string | undefined>();
  const outputSession = (output: string) => {
    if (!sessions.has(output)) sessions.set(output, output.match(/(?:session ID|task_id)[\s:=]+([\w-]+)/i)?.[1]);
    return sessions.get(output);
  };
  for (const run of runs) {
    for (const row of (trajectories?.get(run.id) ?? deriveTrajectory(run, undefined, !detail).rows).flatMap((row) => [
      row,
      ...(row.children ?? []),
    ])) {
      if (row.lane !== 'tools') continue;
      const envelope = row.compactData ?? object(row.detail);
      const source = { ...object(envelope.native), ...object(envelope.pugport) };
      const args = object(source.arguments ?? source.input);
      const raw = source.output ?? source.result ?? '';
      const result = object(raw);
      const output = typeof raw === 'string' ? raw : JSON.stringify(raw);
      const session =
        result.session_id ?? result.backgroundTaskId ?? args.session_id ?? args.task_id ?? outputSession(output);
      if (!session && args.run_in_background !== true && result.backgroundedByUser !== true) continue;
      const safeOutput = row.compactData
        ? typeof raw === 'string'
          ? safeToolEventText(raw)
          : JSON.stringify(safeToolEventValue(raw))
        : output;
      const key = run.id + ':background:' + (session === undefined ? row.key : presentationPreview(String(session)));
      const prior = jobs.get(key);
      const exitCode =
        source.exitCode ??
        result.exitCode ??
        result.exit_code ??
        output.match(/(?:exited with code|exit code)[\s:]+(-?\d+)/i)?.[1];
      const ended = exitCode !== undefined || result.status === 'completed' || row.status === 'failed';
      jobs.set(key, {
        key,
        runId: run.id,
        kind: /bash/i.test(row.label) ? 'bash' : 'pwsh',
        title:
          prior?.title || activityArgument({ ...source, ...args }) || presentationPreview(row.argumentPreview ?? ''),
        status: ended ? (row.status === 'failed' || Number(exitCode ?? 0) !== 0 ? 'failed' : 'completed') : 'running',
        startedAt: prior?.startedAt || row.startedAt || run.startedAt,
        endedAt: ended ? row.endedAt || run.endedAt : undefined,
        exitCode: exitCode === undefined ? undefined : Number(exitCode),
        tail: safeOutput.split('\n').slice(-40).join('\n').slice(-8000),
        ...(detail ? { output: safeOutput } : {}),
      });
    }
  }
  for (const member of members)
    jobs.set('member:' + member.id, {
      key: 'member:' + member.id,
      workflowId: member.id,
      conversationId: member.conversationId,
      runId: member.runIds.at(-1),
      kind: '子任务',
      title: presentationPreview(member.input.content),
      status: ['completed', 'cancelled'].includes(member.status)
        ? 'completed'
        : ['failed', 'interrupted'].includes(member.status)
          ? 'failed'
          : 'running',
      startedAt: member.startedAt || member.createdAt,
      endedAt: member.updatedAt,
      tail: member.status,
    });
  return [...jobs.values()];
}
