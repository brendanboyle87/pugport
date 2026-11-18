import type { Conversation, Project } from './types.ts';

export function canUseConversationCollaboration(
  project?: Pick<Project, 'id' | 'scope' | 'removedAt'>,
  conversation?: Pick<Conversation, 'projectId' | 'deletedAt' | 'closedAt' | 'collaborationEnabled'>,
) {
  return !!(
    project &&
    conversation &&
    project.id === conversation.projectId &&
    !project.removedAt &&
    !conversation.deletedAt &&
    !conversation.closedAt &&
    (project.scope !== 'chat' || conversation.collaborationEnabled)
  );
}
