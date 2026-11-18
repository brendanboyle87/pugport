import { presentationPreview } from './activity-vocabulary.ts';
export type TaskListItem = { title: string; status: 'pending' | 'running' | 'completed' };
/** A reported empty list clears the previous snapshot; malformed reports do not. */
export function normalizeTaskList(value: unknown): TaskListItem[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const row = item as Record<string, unknown>;
      const title = row.step ?? row.content ?? row.title;
      if (typeof title !== 'string' || !title.trim()) return [];
      const state = String(row.status);
      return [
        {
          title: presentationPreview(title),
          status: ['completed', 'done'].includes(state)
            ? ('completed' as const)
            : ['in_progress', 'inProgress', 'running'].includes(state)
              ? ('running' as const)
              : ('pending' as const),
        },
      ];
    })
    .slice(0, 200);
}
