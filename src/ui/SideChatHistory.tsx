import { currentLocale } from './i18n';
import { useEffect, useRef, useState } from 'react';
import { FolderInput, History, MessageSquare, Pencil, Plus, Trash2 } from 'lucide-react';
import type { Conversation } from '../shared/types';
import { ContextMenu, type MenuItem } from './DesktopFeatures';
import { confirmDialog } from './confirm-dialog';
import { translateInterfaceText } from './i18n';

/** A default side chat title is “<main conversation> · 侧聊”: the name stays as written, the suffix is interface text. */
function splitTitle(title: string) {
  const suffix = ' · 侧聊';
  return title.endsWith(suffix) && title.length > suffix.length
    ? { name: title.slice(0, -suffix.length), suffix }
    : { name: title, suffix: '' };
}

/**
 * Saved side discussions are scoped to their main conversation and stay out of the ordinary sidebar.
 * Right-click (or the ⋯ menu) a side chat to rename it, move it into the main conversation's project as an
 * ordinary conversation, or delete it.
 */
export function SideChatHistory({
  conversations,
  onOpen,
  onNew,
  onRename,
  onPromote,
  onDelete,
}: {
  conversations: Conversation[];
  onOpen: (conversation: Conversation) => void;
  onNew: () => void;
  onRename?: (conversation: Conversation, title: string) => Promise<unknown>;
  onPromote?: (conversation: Conversation) => Promise<unknown>;
  onDelete?: (conversation: Conversation) => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] }>();
  const [editing, setEditing] = useState<string>();
  const [title, setTitle] = useState('');
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node) && !(event.target as HTMLElement).closest?.('.context-menu'))
        setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !menu && !editing) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open, menu, editing]);
  const items = (conversation: Conversation): MenuItem[] => [
    {
      label: '打开',
      icon: <MessageSquare size={14} />,
      onSelect: () => {
        setOpen(false);
        onOpen(conversation);
      },
    },
    ...(onRename
      ? [
          {
            label: '重命名',
            icon: <Pencil size={14} />,
            onSelect: () => {
              setEditing(conversation.id);
              setTitle(conversation.title);
            },
          },
        ]
      : []),
    ...(onPromote
      ? [
          {
            label: '移到主对话所在的文件夹',
            icon: <FolderInput size={14} />,
            onSelect: () => void onPromote(conversation).then(() => setOpen(false)),
          },
        ]
      : []),
    ...(onDelete
      ? [
          'separator' as const,
          {
            label: '删除',
            icon: <Trash2 size={14} />,
            danger: true,
            onSelect: async () => {
              const { name, suffix } = splitTitle(conversation.title);
              if (
                await confirmDialog({
                  title: '删除「{0}」？',
                  names: [suffix ? `${name} ${translateInterfaceText('· 侧聊')}` : name],
                  action: '删除侧聊',
                  tone: 'danger',
                })
              )
                void onDelete(conversation);
            },
          },
        ]
      : []),
  ];
  const saveTitle = (conversation: Conversation) => {
    const next = title.trim();
    setEditing(undefined);
    if (next && next !== conversation.title) void onRename?.(conversation, next);
  };
  return (
    <div className="side-chat-history toolbar-item" ref={root}>
      <button
        type="button"
        className={`toolbar-button ${open ? 'open' : ''}`}
        aria-label="侧聊记录"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <History size={15} />
        {conversations.length > 0 && <span className="toolbar-badge">{conversations.length}</span>}
      </button>
      {!open && (
        <div className="toolbar-tip">
          <strong>侧聊记录{conversations.length ? ` (${conversations.length})` : ''}</strong>
          <small>打开以前的侧聊</small>
        </div>
      )}
      {open && (
        <div className="side-chat-history-menu" role="dialog" aria-label="当前主对话的侧聊记录">
          <strong>侧聊记录</strong>
          <p>右键可重命名、移到主对话所在的文件夹或删除。</p>
          <div className="side-chat-history-list">
            {conversations.map((conversation) => {
              const { name, suffix } = splitTitle(conversation.title);
              return editing === conversation.id ? (
                <div key={conversation.id} className="side-chat-rename">
                  <MessageSquare size={14} />
                  <input
                    autoFocus
                    aria-label="侧聊名称"
                    value={title}
                    maxLength={150}
                    onChange={(event) => setTitle(event.target.value)}
                    onBlur={() => saveTitle(conversation)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') saveTitle(conversation);
                      if (event.key === 'Escape') setEditing(undefined);
                    }}
                  />
                </div>
              ) : (
                <button
                  key={conversation.id}
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    onOpen(conversation);
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setMenu({ x: event.clientX, y: event.clientY, items: items(conversation) });
                  }}
                  onKeyDown={(event) => {
                    if (event.altKey || event.ctrlKey || event.metaKey) return;
                    if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return;
                    event.preventDefault();
                    event.stopPropagation();
                    const box = event.currentTarget.getBoundingClientRect();
                    setMenu({ x: box.left, y: box.bottom, items: items(conversation) });
                  }}
                >
                  <MessageSquare size={14} />
                  <span>
                    <span translate="no">{name}</span>
                    {suffix}
                    <time>
                      {new Date(conversation.updatedAt).toLocaleString(currentLocale(), {
                        month: '2-digit',
                        day: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </time>
                  </span>
                </button>
              );
            })}
            {!conversations.length && <p className="side-chat-history-empty">还没有侧聊记录。</p>}
          </div>
          <button
            type="button"
            className="button tiny quiet"
            onClick={() => {
              setOpen(false);
              onNew();
            }}
          >
            <Plus size={14} />
            新建侧聊
          </button>
        </div>
      )}
      {menu && <ContextMenu {...menu} onClose={() => setMenu(undefined)} />}
    </div>
  );
}
