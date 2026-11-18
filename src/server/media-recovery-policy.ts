import { resolve } from 'node:path';
import type { Conversation, Project, Workflow } from '../shared/types.ts';
import type { MediaAnalysisReport } from './media-analysis.ts';

/** Recovery only restores an already authorized local job; it never creates or continues an agent run. */
export function canRecoverMediaJob(
  report: MediaAnalysisReport,
  conversation: Conversation | undefined,
  project: Project | undefined,
  getWorkflow: (id: string) => Workflow | undefined,
): boolean {
  if (
    !report.owner ||
    !conversation ||
    conversation.deletedAt ||
    conversation.id !== report.owner.conversationId ||
    !project ||
    project.id !== conversation.projectId ||
    !report.owner.projectPath
  )
    return false;
  const fold = (path: string) => (process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path));
  if (fold(project.path) !== fold(report.owner.projectPath)) return false;
  let id = report.owner.workflowId;
  const seen = new Set<string>();
  while (id) {
    if (seen.has(id)) return false;
    seen.add(id);
    const workflow = getWorkflow(id);
    if (
      !workflow ||
      workflow.conversationId !== conversation.id ||
      workflow.projectId !== project.id ||
      workflow.stopped ||
      workflow.deletedAt ||
      workflow.status === 'cancelled'
    )
      return false;
    id = workflow.delegation?.parentId;
  }
  return true;
}
