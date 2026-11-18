import { useRef, useState } from 'react';
import { GitBranch, Loader2, Pencil, RotateCcw } from 'lucide-react';
import type { Conversation, ConversationMessage } from '../shared/types';
import type { Api, Notify } from './Workspace';

type Props = {
  message: ConversationMessage;
  api: Api;
  notify: Notify;
  onConversation: (conversation: Conversation) => void;
};

export function MessageBranchActions({
  message,
  api,
  notify,
  onConversation,
  onEdit,
  lastUserMessage,
  running,
  fork = true,
}: Props & { onEdit?: () => void; lastUserMessage?: boolean; running?: boolean; fork?: boolean }) {
  const editable = onEdit && message.importedFrom?.provider !== 'cursor';
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  async function act(kind: 'fork' | 'resend') {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    try {
      const base = `/api/conversations/${encodeURIComponent(message.conversationId)}`;
      if (kind === 'fork') {
        const conversation = await api<Conversation>(`${base}/fork`, { messageId: message.id }, 'POST');
        onConversation(conversation);
      } else {
        await api(`${base}/messages/${encodeURIComponent(message.id)}/resend`, {}, 'POST');
      }
    } catch (error) {
      notify({ tone: 'error', message: error instanceof Error ? error.message : String(error) });
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  return (
    <>
      {fork && (
        <button
          type="button"
          className="icon-button"
          title="从这里分叉"
          aria-label="从这里分叉"
          disabled={busy}
          onClick={() => void act('fork')}
        >
          <GitBranch size={13} />
        </button>
      )}
      {editable && (
        <button type="button" className="icon-button" title="编辑" aria-label="编辑" disabled={busy} onClick={onEdit}>
          <Pencil size={13} />
        </button>
      )}
      {editable && lastUserMessage && (
        <button
          type="button"
          className="icon-button"
          title={running ? '任务正在运行，请结束后重新发送。' : '重新发送'}
          aria-label="重新发送"
          disabled={busy || running}
          onClick={() => void act('resend')}
        >
          <RotateCcw size={13} />
        </button>
      )}
    </>
  );
}

export function SentMessageEditor({
  message,
  api,
  notify,
  onConversation,
  onCancel,
}: Props & { onCancel: () => void }) {
  const [text, setText] = useState(message.content);
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  async function send() {
    if (locked.current || !text.trim()) return;
    locked.current = true;
    setBusy(true);
    try {
      const result = await api<{ conversation: Conversation; error?: string }>(
        `/api/conversations/${encodeURIComponent(message.conversationId)}/messages/${encodeURIComponent(message.id)}/edit-and-resend`,
        { content: text.trim() },
        'POST',
      );
      onConversation(result.conversation);
      if (result.error) notify({ tone: 'error', message: result.error });
      else onCancel();
    } catch (error) {
      notify({ tone: 'error', message: error instanceof Error ? error.message : String(error) });
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  return (
    <form
      className="sent-message-editor"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <textarea
        autoFocus
        aria-label="编辑已发送的消息"
        value={text}
        maxLength={50_000}
        disabled={busy}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !busy) {
            event.preventDefault();
            onCancel();
          }
        }}
      />
      <div className="sent-message-editor-footer">
        <small>发送后将在新分支中继续</small>
        <button type="button" className="button secondary tiny" disabled={busy} onClick={onCancel}>
          取消
        </button>
        <button type="submit" className="button primary tiny" disabled={busy || !text.trim()}>
          {busy && <Loader2 size={12} className="spinning" />}发送
        </button>
      </div>
    </form>
  );
}
