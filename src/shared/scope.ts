/*
 * File scopes for subtasks that write: the files and folders a subtask declared it would change, relative to
 * the project, with "/" separators. Two scopes overlap when one names the other or a folder containing it;
 * subtasks with overlapping scopes take turns instead of editing the same files at once, while subtasks of one
 * caller whose scopes do not overlap write side by side.
 */

/** "src\\ui\\", "./src/ui/**" and "src/ui" all become "src/ui"; "." or "" means the whole project. */
export function normalizeScopePath(value: string): string {
  return value
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/\*\*?(?:\/\*)?$/, '')
    .replace(/^\.\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\/{2,}/g, '/');
}

export function normalizeScope(values: readonly string[]): string[] {
  const paths = [...new Set(values.map(normalizeScopePath))];
  return paths.includes('') || paths.includes('.') ? [''] : paths;
}

const contains = (folder: string, path: string) =>
  folder === '' ||
  path.toLowerCase() === folder.toLowerCase() ||
  path.toLowerCase().startsWith(`${folder.toLowerCase()}/`);

/** Whether a project-relative file lies inside the scope. */
export function withinScope(path: string, scope: readonly string[]): boolean {
  const file = normalizeScopePath(path);
  return scope.some((entry) => contains(entry, file));
}

/** Whether two scopes share any file. */
export function scopesOverlap(a: readonly string[], b: readonly string[]): boolean {
  return a.some((left) => b.some((right) => contains(left, right) || contains(right, left)));
}

/** A writing sub-task's caller (its workflow id) and the files it declared. */
export type WriteShare = { callerId: string; scope: readonly string[] };
export type Writer = { workflowId?: string; share?: WriteShare };

/**
 * Whether two writers in one project may run at once: a caller beside its own sub-tasks, or sub-tasks of one
 * caller whose declared files do not overlap. Everything else takes turns. Scopes are declarations, not
 * filesystem isolation: the caller is told to leave its sub-tasks' files alone, and edits outside a sub-task's
 * files are reported afterwards.
 */
export function sideBySide(a: Writer, b: Writer): boolean {
  if (a.share && a.share.callerId === b.workflowId) return true;
  if (b.share && b.share.callerId === a.workflowId) return true;
  return (
    !!a.share && !!b.share && a.share.callerId === b.share.callerId && !scopesOverlap(a.share.scope, b.share.scope)
  );
}
