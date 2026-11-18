import type { Conversation, ConversationMessage, MessageInput, Workflow } from '../shared/types';
import type { Api, Notice } from './Workspace';
import { boundedQuotation } from './quotation';

export type Notify = (notice: Notice) => void;
export type SideChatLaunch = {
  requestId: string;
  parentConversationId: string;
  /** Reopen a saved side conversation via GET; never create a duplicate or submit a model task. */
  existingConversationId?: string;
  anchorMessageId?: string;
  quote?: string;
  selection: Pick<MessageInput, 'provider' | 'runtimeId' | 'model' | 'effort' | 'executionPolicy'>;
};
export type SideChatSnapshot = {
  conversation?: Conversation;
  messages: ConversationMessage[];
  draft: string;
  /** Read-only by default; the user may let the side chat write in the project. */
  permission: MessageInput['permissionMode'];
  loading: boolean;
  sending: boolean;
  error?: string;
  deliveryError?: string;
};
export type SideChatSendResult = { message: ConversationMessage; workflow?: Workflow };

export function mainConversations(conversations: Conversation[]): Conversation[] {
  return conversations.filter((conversation) => !conversation.sideChat);
}

export function sideChatHistory(conversations: Conversation[], parentConversationId: string): Conversation[] {
  return conversations
    .filter((conversation) => conversation.sideChat?.parentConversationId === parentConversationId)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
}

export function savedSideChatLaunch(conversation: Conversation, parentConversationId: string): SideChatLaunch {
  if (conversation.id === parentConversationId || conversation.sideChat?.parentConversationId !== parentConversationId)
    throw new Error('这条侧聊不属于当前主对话。');
  return {
    requestId: `saved:${conversation.id}`,
    existingConversationId: conversation.id,
    parentConversationId,
    anchorMessageId: conversation.sideChat.anchorMessageId,
    selection: { ...conversation.sideChat.selection },
  };
}

export function sideChatMessageInput(
  launch: SideChatLaunch,
  content: string,
  permission: MessageInput['permissionMode'] = 'read-only',
): MessageInput {
  const { provider, runtimeId, model, effort, executionPolicy } = launch.selection;
  const writable = permission === 'workspace-write';
  return {
    content: content.trim(),
    // Writable side chats let the task decide between answering and editing; read-only ones only answer.
    mode: writable ? 'auto' : 'chat',
    permissionMode: writable ? 'workspace-write' : 'read-only',
    executionPolicy,
    autoEscalate: false,
    ...(provider ? { provider } : {}),
    ...(runtimeId ? { runtimeId } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
  };
}

export function sideChatEnterAction(
  key: { key: string; shiftKey: boolean; altKey?: boolean; repeat?: boolean; isComposing?: boolean; keyCode?: number },
  composition: { active: boolean; endedAt: number },
  now: number,
): 'send' | 'newline' | 'composition' | 'ignore' | 'other' {
  if (key.key !== 'Enter') return 'other';
  if (key.isComposing || key.keyCode === 229 || composition.active) return 'composition';
  if (now - composition.endedAt < 120 || key.repeat || key.altKey) return 'ignore';
  return key.shiftKey ? 'newline' : 'send';
}

export function mergeSideChatMessages(
  conversationId: string,
  ...sources: ConversationMessage[][]
): ConversationMessage[] {
  const messages = new Map<string, ConversationMessage>();
  for (const source of sources)
    for (const message of source) if (message.conversationId === conversationId) messages.set(message.id, message);
  return [...messages.values()].sort(
    (left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
  );
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Owns local UI state across hiding/unmounting; it never owns or cancels a native task. */
export class SideChatSession {
  private snapshot: SideChatSnapshot = {
    messages: [],
    draft: '',
    permission: 'read-only',
    loading: false,
    sending: false,
  };
  private listeners = new Set<() => void>();
  private opening?: Promise<void>;
  private refreshing?: Promise<void>;
  private submission?: Promise<SideChatSendResult>;
  readonly launch: SideChatLaunch;

  constructor(
    private api: Api,
    launch: SideChatLaunch,
  ) {
    this.launch = {
      ...launch,
      selection: { ...launch.selection },
      ...(launch.quote ? { quote: boundedQuotation(launch.quote) } : {}),
    };
  }

  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(value: Partial<SideChatSnapshot>) {
    this.snapshot = { ...this.snapshot, ...value };
    for (const listener of this.listeners) listener();
  }
  setDraft = (draft: string) => this.update({ draft });
  setPermission = (permission: MessageInput['permissionMode']) => this.update({ permission });

  open(): Promise<void> {
    if (this.opening) return this.opening;
    this.update({ loading: true, error: undefined });
    this.opening = (async () => {
      try {
        if (!this.snapshot.conversation) {
          const { requestId, parentConversationId, existingConversationId, anchorMessageId, quote, selection } =
            this.launch;
          const saved = existingConversationId
            ? await this.api<{ conversation: Conversation; messages: ConversationMessage[] }>(
                `/api/conversations/${encodeURIComponent(existingConversationId)}`,
                undefined,
                'GET',
              )
            : undefined;
          const conversation =
            saved?.conversation ??
            (!existingConversationId
              ? await this.api<Conversation>(
                  `/api/conversations/${encodeURIComponent(parentConversationId)}/side-chat`,
                  {
                    requestId,
                    selection,
                    ...(anchorMessageId ? { anchorMessageId } : {}),
                    ...(quote ? { quote } : {}),
                  },
                  'POST',
                )
              : undefined);
          if (
            !conversation?.id ||
            (existingConversationId && conversation.id !== existingConversationId) ||
            conversation.id === parentConversationId ||
            conversation.sideChat?.parentConversationId !== parentConversationId
          )
            throw new Error('侧聊返回了无效的会话，未向主会话发送消息。');
          this.launch.selection = { ...conversation.sideChat.selection };
          this.update({ conversation });
          if (saved) {
            if (!Array.isArray(saved.messages)) throw new Error('无法读取侧聊消息，请重试。');
            this.update({ messages: mergeSideChatMessages(conversation.id, saved.messages) });
            return;
          }
        }
        await this.refresh();
      } catch (error) {
        this.update({ error: errorText(error) });
        throw error;
      } finally {
        this.opening = undefined;
        this.update({ loading: false });
      }
    })();
    return this.opening;
  }

  refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    const conversation = this.snapshot.conversation;
    if (!conversation) return Promise.resolve();
    this.refreshing = (async () => {
      try {
        const value = await this.api<{ messages: ConversationMessage[] }>(
          `/api/conversations/${encodeURIComponent(conversation.id)}`,
          undefined,
          'GET',
        );
        if (!Array.isArray(value.messages)) throw new Error('无法读取侧聊消息，请重试。');
        this.update({
          messages: mergeSideChatMessages(conversation.id, this.snapshot.messages, value.messages),
          error: undefined,
        });
      } catch (error) {
        this.update({ error: errorText(error) });
        throw error;
      } finally {
        this.refreshing = undefined;
      }
    })();
    return this.refreshing;
  }

  send(): Promise<SideChatSendResult> {
    if (this.submission) return this.submission;
    const { conversation, draft } = this.snapshot;
    if (!conversation) return Promise.reject(new Error('侧聊尚未连接，请稍后发送。'));
    if (!draft.trim()) return Promise.reject(new Error('请先输入侧聊问题。'));
    this.update({ sending: true, deliveryError: undefined });
    this.submission = (async () => {
      try {
        const sent = await this.api<SideChatSendResult>(
          `/api/conversations/${encodeURIComponent(conversation.id)}/messages`,
          sideChatMessageInput(this.launch, draft, this.snapshot.permission),
          'POST',
        );
        if (!sent.message?.id || sent.message.conversationId !== conversation.id)
          throw new Error('未能确认侧聊消息是否送达，请核对历史后再决定是否重发。');
        this.update({
          messages: mergeSideChatMessages(conversation.id, this.snapshot.messages, [sent.message]),
          draft: this.snapshot.draft === draft ? '' : this.snapshot.draft,
          deliveryError:
            sent.message.steering?.status === 'failed'
              ? sent.message.steering.error || '补充消息未确认送达，请核对侧聊任务。'
              : undefined,
        });
        return sent;
      } catch (error) {
        this.update({ deliveryError: errorText(error) });
        throw error;
      } finally {
        this.submission = undefined;
        this.update({ sending: false });
      }
    })();
    return this.submission;
  }
}

const sessions = new WeakMap<Api, Map<string, SideChatSession>>();
export function hasSideChatDrafts(api: Api): boolean {
  return [...(sessions.get(api)?.values() ?? [])].some((session) => {
    const { draft, sending } = session.getSnapshot();
    return Boolean(draft.trim() || sending);
  });
}
export function getSideChatSession(api: Api, launch: SideChatLaunch): SideChatSession {
  let own = sessions.get(api);
  if (!own) {
    own = new Map();
    sessions.set(api, own);
  }
  const existing = own.get(launch.requestId);
  if (existing) {
    if (existing.launch.parentConversationId !== launch.parentConversationId)
      throw new Error('侧聊请求标识已属于其他会话。');
    return existing;
  }
  if (launch.existingConversationId) {
    const saved = [...own.values()].find(
      (session) => session.getSnapshot().conversation?.id === launch.existingConversationId,
    );
    if (saved) {
      if (saved.launch.parentConversationId !== launch.parentConversationId)
        throw new Error('这条侧聊不属于当前主对话。');
      own.set(launch.requestId, saved);
      return saved;
    }
  }
  const created = new SideChatSession(api, launch);
  own.set(launch.requestId, created);
  return created;
}
