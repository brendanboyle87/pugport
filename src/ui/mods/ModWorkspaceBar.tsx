import { useId, useRef, useState, type RefObject } from 'react';
import { Ellipsis, MessageSquare } from 'lucide-react';
import type { ModManifestV2 } from '../../shared/mods-manifest';
import { useDismiss } from '../use-dismiss';
import { useMenuKeys } from '../use-menu-keys';
import { ModeIcon } from './mod-icons';
import { ActivityDot } from '../ActivityDot';
import { translateInterfaceText } from '../i18n';
import { ModDebugMenu, type ModDebugInfo } from './ModDebugMenu';

export function ModWorkspaceBar({
  mode,
  chatOpen,
  chatId,
  chatToggle,
  busy,
  unread = false,
  running = false,
  mac = false,
  onChat,
  onDetails,
  onHide,
  onRemove,
  debug,
}: {
  mode?: Pick<ModManifestV2, 'title' | 'icon' | 'logo'>;
  chatOpen: boolean;
  chatId: string;
  chatToggle: RefObject<HTMLButtonElement | null>;
  busy: boolean;
  unread?: boolean;
  running?: boolean;
  mac?: boolean;
  onChat(): void;
  onDetails(): void;
  onHide(): void;
  onRemove(): void;
  /** Only for a Local build from this chat's Mods author workspace. */
  debug?: ModDebugInfo;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  useDismiss(
    open,
    wrap,
    () => setOpen(false),
    () => trigger.current,
  );
  useMenuKeys(open, menu, () => setOpen(false));
  return (
    <header className="mod-workspace-bar">
      <div className="mod-workspace-title">
        <ModeIcon mode={mode} size={18} />
        <strong translate="no">{mode?.title ?? 'Mod'}</strong>
      </div>
      <button
        type="button"
        className="mod-chat-toggle"
        ref={chatToggle}
        aria-expanded={chatOpen}
        aria-controls={chatId}
        aria-label={unread && !chatOpen ? '聊天，有新回复' : '聊天'}
        aria-keyshortcuts="Control+J"
        title={translateInterfaceText('聊天 (Ctrl+J)').replace('Ctrl+J', mac ? '⌘J' : 'Ctrl+J')}
        onClick={onChat}
      >
        <MessageSquare size={16} aria-hidden="true" />
        <span className="mod-chat-label">聊天</span>
        {!chatOpen &&
          (running ? (
            <ActivityDot activity="running" />
          ) : unread ? (
            <span className="mod-chat-unread" aria-hidden="true" />
          ) : null)}
      </button>
      {debug && <ModDebugMenu debug={debug} />}
      <div className="mod-panel-menu" ref={wrap}>
        <button
          type="button"
          className="toolbar-button"
          aria-label="Mod 菜单"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? id : undefined}
          ref={trigger}
          onClick={() => setOpen(!open)}
        >
          <Ellipsis size={16} aria-hidden="true" />
        </button>
        {open && (
          <div className="mod-menu" id={id} ref={menu} role="menu" aria-label="Mod 菜单">
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onDetails();
              }}
            >
              Mod 详情
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={busy}
              onClick={() => {
                setOpen(false);
                onHide();
              }}
            >
              隐藏 Mod
            </button>
            <hr />
            <button
              type="button"
              role="menuitem"
              disabled={busy}
              onClick={() => {
                setOpen(false);
                onRemove();
              }}
            >
              从这个对话移除
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
