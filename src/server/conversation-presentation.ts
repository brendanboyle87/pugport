import { reasoningPreview } from '../shared/reasoning-preview.ts';
import { normalizeTaskList } from '../shared/task-list.ts';
import {
  activityArgument,
  activityCategory,
  presentationPreview,
  type ActivityCategory,
} from '../shared/activity-vocabulary.ts';
import { backgroundWork } from './conversation-background.ts';
import { cleanReasoning, deriveTrajectory, type TrajectoryRow } from '../shared/trajectory.ts';
import type { RunRecord, Workflow } from '../shared/types.ts';

import {
  projectStartNotice,
  type PresentationItem,
  type ConversationPresentation,
} from '../shared/conversation-presentation.ts';
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
function toolData(row: TrajectoryRow, categories: Map<string, ActivityCategory>) {
  const detail: Record<string, unknown> = row.compactData ?? object(JSON.parse(row.detail || '{}'));
  const source = { ...object(detail.native), ...object(detail.pugport) };
  const observations = Array.isArray(detail.observations) ? detail.observations : [];
  const data = object(object(observations.at(-1)).data);
  const kind = String(detail.kind ?? data.kind ?? '');
  const categoryKey = JSON.stringify([row.label, kind, row.source]);
  let category = categories.get(categoryKey);
  if (!category) {
    category = activityCategory(row.label, kind, row.source === 'linked' ? 'pugport' : row.source);
    categories.set(categoryKey, category);
  }
  if (!['running', 'pending'].includes(row.status)) return { category, argument: '' };
  let rawInput = source.arguments ?? source.input;
  if (typeof rawInput === 'string') {
    try {
      rawInput = JSON.parse(rawInput);
    } catch {
      rawInput = {};
    }
  }
  const input = object(rawInput);
  return {
    category,
    argument: activityArgument({ ...source, ...input, ...object(input.tool_input) }),
  };
}
function flatten(rows: TrajectoryRow[]): TrajectoryRow[] {
  return rows.flatMap((row) => [row, ...flatten(row.children ?? [])]);
}
const settled = new Set<Workflow['status']>(['completed', 'failed', 'cancelled', 'interrupted']);
export function buildConversationPresentation(
  workflow: Workflow,
  runs: RunRecord[],
  members: Workflow[] = [],
  detail = false,
): ConversationPresentation {
  const items: PresentationItem[] = [];
  const categories = new Map<string, ActivityCategory>();
  const trajectories = new Map<string, TrajectoryRow[]>();
  for (const run of runs) {
    if (run.visualAssistant) continue;
    if (run.relay)
      items.push({
        key: `${run.id}:handoff`,
        kind: 'handoff',
        runId: run.id,
        target: presentationPreview(run.account?.label || run.route.runtimeId),
        reason: run.relay.reason,
      });
    const trajectory = deriveTrajectory(run, undefined, !detail).rows;
    trajectories.set(run.id, trajectory);
    const rows = flatten(trajectory).filter((row) => row.lane === 'tools' || row.lane === 'model');
    // Reasoning events have boundaries; older records only retain the run-level fallback.
    if (run.events.some((event) => event.type === 'reasoning')) {
      const fallback = rows.findIndex((row) => row.key === `${run.id}:reasoning`);
      if (fallback >= 0) rows.splice(fallback, 1);
      let block: TrajectoryRow | undefined;
      for (const [index, event] of run.events.entries()) {
        if (event.type !== 'reasoning') {
          block = undefined;
          continue;
        }
        if (!block) {
          block = {
            key: `${run.id}:reasoning:${event.seq ?? index}`,
            lane: 'model',
            label: '思考',
            status: 'info',
            text: '',
            sourceEvents: [
              {
                sequence: event.seq ?? index,
                sequenceSource: event.seq === undefined ? 'legacy-index' : 'event.seq',
                at: event.at,
                type: event.type,
              },
            ],
          };
          rows.push(block);
        }
        block.text += event.text ?? '';
      }
      for (const row of rows.filter((row) => row.key.includes(':reasoning:')))
        row.text = cleanReasoning(row.text ?? '');
    }
    rows.sort(
      (a, b) =>
        (a.sourceEvents?.[0]?.sequence ?? (a.key.endsWith(':reasoning') ? -1 : Number.MAX_SAFE_INTEGER)) -
        (b.sourceEvents?.[0]?.sequence ?? (b.key.endsWith(':reasoning') ? -1 : Number.MAX_SAFE_INTEGER)),
    );
    let group: PresentationItem | undefined;
    let latest = '';
    const seen = new Set<string>();
    for (const row of rows) {
      if (seen.has(row.key)) continue;
      seen.add(row.key);
      if (row.lane === 'tools') {
        if (!group) {
          group = {
            key: `${row.key}:group`,
            kind: 'activity-group',
            runId: run.id,
            calls: [],
            ...(detail ? { tools: [] } : {}),
          };
          items.push(group);
          latest = '';
        }
        const data = toolData(row, categories);
        group.calls!.push({ key: row.key, category: data.category });
        if (detail) group.tools!.push(row);
        if (['running', 'pending'].includes(row.status) && (row.startedAt ?? '') >= latest) {
          latest = row.startedAt ?? '';
          group.live = { key: row.key, category: data.category, detail: data.argument };
        }
      } else if (row.text || row.detail) {
        group = undefined;
        const reasoning = row.key.includes(':reasoning');
        const text = row.detail ?? row.text ?? '';
        items.push({
          key: row.key,
          kind: reasoning ? 'reasoning' : 'narration',
          runId: run.id,
          preview: presentationPreview(reasoning ? reasoningPreview(text) : (row.text ?? text)),
          ...(detail || !reasoning ? { text } : {}),
        });
      }
    }
    if (run.status === 'running' && !items.some((item) => item.runId === run.id && item.live)) {
      const reasoning = [...items].reverse().find((item) => item.runId === run.id && item.kind === 'reasoning');
      if (reasoning) {
        reasoning.live = {
          key: reasoning.key,
          category: 'thinking',
          detail: reasoningPreview(run.reasoning || reasoning.text || reasoning.preview || '', true),
        };
      }
    }
    const question = run.taskOutcome?.status === 'blocked' ? run.taskOutcome.question : undefined;
    if (question && !workflow.userQuestion)
      items.push({
        key: `${run.id}:question`,
        kind: 'question',
        runId: run.id,
        preview: presentationPreview(question.text),
        ...(detail ? { text: cleanReasoning(question.text) } : {}),
        options: question.options?.map((option) => presentationPreview(option)),
      });
  }
  const final = [...items].reverse().find((item) => item.kind === 'narration');
  if (final && workflow.status === 'completed') final.kind = 'final-answer';
  for (const member of members)
    items.push({
      key: `member:${member.id}`,
      kind: 'member',
      target: member.id,
      preview: presentationPreview(member.input.content),
      status: member.status,
    });
  if (workflow.userQuestion)
    items.push({
      key: `${workflow.id}:question`,
      kind: 'question',
      preview: presentationPreview(workflow.userQuestion.text),
      ...(detail ? { text: cleanReasoning(workflow.userQuestion.text) } : {}),
      status: workflow.userQuestion.answeredMessageId ? 'answered' : 'waiting',
      options: workflow.userQuestion.options.map((option) => presentationPreview(option)),
    });
  return {
    version: 1,
    workflowId: workflow.id,
    needsDetail: !detail,
    items,
    ...(!workflow.runIds?.length &&
    !settled.has(workflow.status) &&
    workflow.scheduling?.reason &&
    workflow.scheduling.reason !== projectStartNotice
      ? { waiting: workflow.scheduling.reason }
      : {}),
    background: backgroundWork(runs, members, detail, trajectories),
    tasks: runs
      .flatMap((run) => run.events ?? [])
      .reduce<ReturnType<typeof normalizeTaskList>>(
        (prior, event) => normalizeTaskList(object(event.data).taskList) ?? prior,
        undefined,
      ),
  };
}

/** Only compact projections are cached. Durable run/audit records rebuild them after restart. */
export class ConversationPresentationCache {
  private entries = new Map<
    string,
    { revision: string; value: ConversationPresentation; liveAt: Map<string, number> }
  >();
  get(workflow: Workflow, revision: string, load: () => RunRecord[], members: Workflow[], now = Date.now()) {
    const prior = this.entries.get(workflow.id);
    if (prior?.revision === revision) return prior.value;
    const value = buildConversationPresentation(workflow, load(), members);
    const liveAt = new Map<string, number>();
    for (const item of value.items) {
      if (!item.live) continue;
      const previous = prior?.value.items.find((candidate) => candidate.key === item.key)?.live;
      const at = prior?.liveAt.get(item.key) ?? now;
      if (previous && now - at < 150) item.live = previous;
      liveAt.set(item.key, previous && JSON.stringify(previous) === JSON.stringify(item.live) ? at : now);
    }
    // A held live title must be reconsidered even without another event.
    const held = value.items.some((item) => item.live && now - (liveAt.get(item.key) ?? 0) < 150);
    this.entries.set(workflow.id, { revision: held ? '' : revision, value, liveAt });
    return value;
  }
  retain(ids: Set<string>) {
    for (const id of this.entries.keys()) if (!ids.has(id)) this.entries.delete(id);
  }
}
