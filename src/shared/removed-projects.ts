import type { Project } from './types.ts';

/**
 * "Clear list" only hides older entries from Settings. A project with an unfinished permanent purge stays listed
 * because that entry is the only way to retry it; the full list stays in app state for everything else.
 */
export function listedRemovedProjects(projects: Project[] = [], clearedAt?: string) {
  const cleared = clearedAt ? Date.parse(clearedAt) : NaN;
  return projects.filter(
    (project) => project.purgePending || Number.isNaN(cleared) || Date.parse(project.removedAt ?? '') > cleared,
  );
}
