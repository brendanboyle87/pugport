import type { Conversation, Project, Workflow } from '../shared/types';
import type { ConversationFolder } from '../shared/conversation-folders';
import { workflowContinuation, workflowNeedsUser } from './queue-utils';

export const activityFilters = [
  ['all', '全部'],
  ['running', '运行中'],
  ['unread', '未读'],
] as const;
export type ActivityFilter = (typeof activityFilters)[number][0];
export type SidebarActivity = { running: boolean; waiting: boolean; unread: boolean };

/** One shared snapshot for counts, filtering and navigation; running and waiting can overlap. */
export function sidebarActivity(
  conversations: Conversation[],
  workflows: Workflow[],
  unread: (conversation: Conversation) => boolean,
  now = Date.now(),
) {
  const byId = new Map<string, SidebarActivity>();
  const counts = { all: 0, running: 0, waiting: 0, unread: 0 };
  for (const conversation of conversations) {
    if (conversation.archivedAt || conversation.deletedAt || conversation.sideChat) continue;
    byId.set(conversation.id, { running: false, waiting: false, unread: unread(conversation) });
  }
  for (const workflow of workflows) {
    const flags = byId.get(workflow.conversationId);
    if (!flags || workflow.deletedAt || workflowContinuation(workflow)) continue;
    flags.running ||= workflow.status === 'planning' || workflow.status === 'running';
    flags.waiting ||= workflowNeedsUser(workflow, now);
  }
  for (const flags of byId.values()) {
    counts.all++;
    counts.running += Number(flags.running);
    counts.waiting += Number(flags.waiting);
    counts.unread += Number(flags.unread);
  }
  return { byId, counts };
}

export function matchesActivity(
  id: string,
  byId: Map<string, SidebarActivity>,
  filter: ActivityFilter,
  selectedId: string,
) {
  const flags = byId.get(id);
  return !!flags && (id === selectedId || filter === 'all' || flags[filter]);
}

/**
 * Sidebar list only. Dispatch projects need an owner chat; ordinary empty projects stay.
 * A chat waiting for the owner stays until that is handled. The setting returns lists unchanged.
 */
export function sidebarScope(
  conversations: Conversation[],
  projects: Project[],
  workflows: Workflow[],
  hiddenIds: readonly string[],
  showAgentConversations: boolean,
  now = Date.now(),
) {
  if (showAgentConversations) return { conversations, projects };
  const waiting = new Set(
    workflows
      .filter((workflow) => !workflow.deletedAt && !workflowContinuation(workflow) && workflowNeedsUser(workflow, now))
      .map((workflow) => workflow.conversationId),
  );
  const hidden = new Set(hiddenIds.filter((id) => !waiting.has(id)));
  const groups = new Map<string, { any: boolean; own: boolean }>();
  for (const item of conversations) {
    if (item.deletedAt || item.sideChat) continue;
    const group = groups.get(item.projectId) ?? { any: false, own: false };
    group.any = true;
    if (!hidden.has(item.id)) group.own = true;
    groups.set(item.projectId, group);
  }
  return {
    conversations: conversations.filter((item) => !hidden.has(item.id)),
    projects: projects.filter((project) => {
      const group = groups.get(project.id);
      return project.origin === 'dispatch' ? !!group?.own : !group?.any || group.own;
    }),
  };
}

/** Same tree order as the sidebar, without visibility or collapse restrictions. */
export function sidebarConversationOrder(
  conversations: Conversation[],
  projects: Project[],
  folders: ConversationFolder[],
) {
  const active = conversations.filter((item) => !item.archivedAt && !item.deletedAt && !item.sideChat);
  const pinned = active.filter((item) => item.pinnedAt).sort((a, b) => b.pinnedAt!.localeCompare(a.pinnedAt!));
  const unpinned = active.filter((item) => !item.pinnedAt).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const projectIds = new Set(projects.filter((item) => item.scope !== 'chat').map((item) => item.id));
  const chats = unpinned.filter((item) => !projectIds.has(item.projectId));
  const sortedFolders = [...folders].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const folderIds = new Set(folders.map((item) => item.id));
  return [
    ...pinned,
    ...sortedFolders.flatMap((folder) => chats.filter((item) => item.folderId === folder.id)),
    ...chats.filter((item) => !item.folderId || !folderIds.has(item.folderId)),
    ...projects.flatMap((project) =>
      projectIds.has(project.id) ? unpinned.filter((item) => item.projectId === project.id) : [],
    ),
  ];
}

export function nextNeedingMe(order: Conversation[], byId: Map<string, SidebarActivity>, selectedId: string) {
  const start = order.findIndex((item) => item.id === selectedId);
  for (let offset = 1; offset <= order.length; offset++) {
    const item = order[(start + offset) % order.length]!;
    const flags = byId.get(item.id);
    if (flags?.waiting || flags?.unread) return item;
  }
}
