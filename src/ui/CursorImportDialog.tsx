import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { Conversation, Project } from '../shared/types';
import type { CursorChat, CursorChatList } from '../shared/cursor-import';
import type { Api } from './Workspace';
import { currentLocale } from './i18n';
import { readableError } from './App';

export function CursorImportDialog({
  project,
  api,
  onOpen,
  onClose,
}: {
  project: Project;
  api: Api;
  onOpen: (id: string, imported?: Conversation) => Promise<boolean>;
  onClose: () => void;
}) {
  const [list, setList] = useState<CursorChatList>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string>();
  const dialog = useRef<HTMLDialogElement>(null);
  const pending = useRef(false);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    return () => previous?.focus();
  }, []);
  useEffect(() => {
    let cancelled = false;
    void api<CursorChatList>(`/api/projects/${project.id}/cursor-chats`, undefined, 'GET')
      .then((value) => {
        if (!cancelled) setList(value);
      })
      .catch((failure) => {
        if (!cancelled) setError(readableError(failure));
      });
    return () => {
      cancelled = true;
    };
  }, [api, project.id]);
  async function choose(chat: CursorChat) {
    if (pending.current) return;
    pending.current = true;
    setBusy(chat.composerId);
    setError('');
    try {
      const imported = chat.conversationId
        ? undefined
        : await api<Conversation>(`/api/projects/${project.id}/cursor-chats/import`, { composerId: chat.composerId });
      const id = chat.conversationId ?? imported!.id;
      setList(
        (value) =>
          value && {
            ...value,
            chats: value.chats.map((item) =>
              item.composerId === chat.composerId ? { ...item, conversationId: id } : item,
            ),
          },
      );
      if (await onOpen(id, imported)) onClose();
    } catch (failure) {
      setError(readableError(failure));
    } finally {
      pending.current = false;
      setBusy(undefined);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="modal cursor-import-dialog"
      aria-label="从 Cursor 导入对话"
      onCancel={(event) => {
        event.preventDefault();
        if (!pending.current) onClose();
      }}
    >
      <header className="modal-heading">
        <h2>从 Cursor 导入对话</h2>
        <button autoFocus type="button" className="icon-button" aria-label="关闭" disabled={!!busy} onClick={onClose}>
          <X size={18} />
        </button>
      </header>
      <p className="muted cursor-import-project" translate="no" title={project.path}>
        {project.name}
      </p>
      <p className="muted">历史将作为一个 Markdown 附件，放入新对话。</p>
      {error && <p role="alert">{error}</p>}
      {!list ? (
        !error && <p role="status">加载中…</p>
      ) : !list.installed ? (
        <p role="status">这台电脑上没找到 Cursor</p>
      ) : !list.chats.length ? (
        <p role="status">没有找到这个项目的 Cursor 对话</p>
      ) : (
        <ul className="cursor-import-list" aria-label="Cursor 对话" aria-busy={!!busy}>
          {list.chats.map((chat) => (
            <li key={chat.composerId}>
              <div className="cursor-import-copy">
                <strong translate="no">{chat.name}</strong>
                <small>
                  {chat.updatedAt && (
                    <time dateTime={chat.updatedAt}>
                      {new Date(chat.updatedAt).toLocaleString(currentLocale(), {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                      })}
                    </time>
                  )}
                  {chat.conversationId && <span>已导入</span>}
                </small>
              </div>
              <button type="button" className="button" disabled={!!busy} onClick={() => void choose(chat)}>
                {busy === chat.composerId ? '处理中…' : chat.conversationId ? '打开' : '导入'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </dialog>
  );
}
