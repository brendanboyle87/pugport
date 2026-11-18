import type { Conversation } from '../shared/types';
import type { ExternalAgentId } from '../shared/external-agents';

type CreationTicket = { navigation: number };
type CreationApi = <T>(path: string, body?: unknown, method?: string) => Promise<T>;
export type ConversationCreationFailure = 'create' | 'swarm' | 'refresh';

/** Lock before React renders and keep a delayed create response from changing newer navigation. */
export class ConversationCreationGate {
  private navigation = 0;
  private pending?: CreationTicket;
  private mounted = true;

  activate() {
    this.mounted = true;
  }
  dispose() {
    this.mounted = false;
    this.navigate();
  }
  navigate() {
    this.navigation++;
  }
  begin() {
    if (!this.mounted || this.pending) return;
    const ticket = { navigation: this.navigation };
    this.pending = ticket;
    return ticket;
  }
  maySelect(ticket: CreationTicket) {
    return this.mounted && this.pending === ticket && ticket.navigation === this.navigation;
  }
  isMounted() {
    return this.mounted;
  }
  finish(ticket: CreationTicket) {
    if (this.pending === ticket) this.pending = undefined;
  }
}

/** A confirmed POST is sufficient to open an empty chat; the full state refresh is independent. */
export async function createSidebarConversation(
  gate: ConversationCreationGate,
  options: {
    api: CreationApi;
    reload: () => Promise<void>;
    projectId?: string;
    swarm?: boolean;
    incognito?: boolean;
    externalAgentId?: ExternalAgentId;
    onPending: (pending: boolean) => void;
    onCreated: (conversation: Conversation) => void;
    onError: (stage: ConversationCreationFailure, failure: unknown) => void;
  },
) {
  const ticket = gate.begin();
  if (!ticket) return;
  options.onPending(true);
  try {
    let created = options.externalAgentId
      ? await options.api<Conversation>('/api/conversations/external-agent', { agentId: options.externalAgentId })
      : await options.api<Conversation>('/api/conversations', {
          ...(options.projectId ? { projectId: options.projectId } : {}),
          ...(options.incognito ? { incognito: true } : {}),
        });
    if (options.swarm) {
      try {
        const updated = await options.api<Conversation>(`/api/conversations/${created.id}`, { swarm: true }, 'PATCH');
        created = { ...created, ...updated, swarm: true };
      } catch (failure) {
        // The conversation already exists. Preserve it even if enabling swarm mode failed.
        if (gate.isMounted()) options.onError('swarm', failure);
      }
    }
    if (gate.maySelect(ticket)) options.onCreated(created);
    void Promise.resolve()
      .then(() => options.reload())
      .catch((failure) => {
        if (gate.isMounted()) options.onError('refresh', failure);
      });
    return created;
  } catch (failure) {
    if (gate.isMounted()) options.onError('create', failure);
  } finally {
    gate.finish(ticket);
    if (gate.isMounted()) options.onPending(false);
  }
}

export function isCreatedConversationPending(current: Conversation | undefined, created: Conversation) {
  if (!current) return true;
  const currentAt = Date.parse(current.updatedAt);
  const createdAt = Date.parse(created.updatedAt);
  if (Number.isFinite(currentAt) && Number.isFinite(createdAt) && currentAt > createdAt) return false;
  return Boolean(current.swarm) !== Boolean(created.swarm);
}

/** Keep a confirmed swarm setting only while the broadcast has not caught up to it. */
export function createdConversationSelection(
  conversations: readonly Conversation[],
  created: Conversation | undefined,
  id: string,
) {
  const current = conversations.find((item) => item.id === id);
  return created?.id === id && isCreatedConversationPending(current, created) ? created : current;
}

/** Include the saved conversation in the sidebar until the server's broadcast catches up. */
export function conversationsWithCreated(conversations: Conversation[], created?: Conversation) {
  if (!created) return conversations;
  const current = conversations.find((item) => item.id === created.id);
  if (!current) return [created, ...conversations];
  return isCreatedConversationPending(current, created)
    ? conversations.map((item) => (item.id === created.id ? created : item))
    : conversations;
}
