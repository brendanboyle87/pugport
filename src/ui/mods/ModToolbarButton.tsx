import { useEffect, useId, useRef, useState } from 'react';
import type { ModeBinding, ModeCatalogEntry, PendingModeBinding } from '../../shared/conversation-modes';
import { useDismiss } from '../use-dismiss';
import { useMenuKeys } from '../use-menu-keys';
import { ModeIcon } from './mod-icons';
import { friendlyModError } from '../mod-errors';

type Props = {
  installed: readonly ModeCatalogEntry[];
  binding?: ModeBinding | null;
  pendingBinding?: PendingModeBinding | null;
  mode?: Pick<ModeCatalogEntry, 'title' | 'icon' | 'logo'>;
  hidden: boolean;
  hasSurface: boolean;
  busy?: boolean;
  loading?: boolean;
  error?: string;
  onRetry?: () => void;
  onOpen?: () => void;
  onSelect: (modeId: string) => void;
  onToggle: () => void;
  onStore: () => void;
};

export function ModToolbarButton({
  installed,
  binding,
  pendingBinding,
  mode,
  hidden,
  hasSurface,
  busy,
  loading,
  error,
  onRetry,
  onOpen,
  onSelect,
  onToggle,
  onStore,
}: Props) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const refresh = useRef(onOpen);
  refresh.current = onOpen;
  const id = useId();
  const statusId = useId();
  const toggles = !!binding && hasSurface;
  useDismiss(
    open,
    wrap,
    () => setOpen(false),
    () => trigger.current,
  );
  useMenuKeys(open, menu, () => setOpen(false));
  useEffect(() => {
    refresh.current?.();
  }, []);
  useEffect(() => setOpen(false), [binding?.instanceId, toggles]);
  useEffect(() => {
    if (!installed.length && !binding) setOpen(false);
  }, [installed.length, binding]);
  if (!installed.length && !binding) return null;
  const current = mode ?? installed.find((entry) => entry.id === binding?.modeId && entry.version === binding.version);
  const label = !binding ? '添加 Mod' : toggles ? (hidden ? '显示 Mod' : '隐藏 Mod') : 'Mod 菜单';
  const showMenu = () => {
    if (!open) refresh.current?.();
    setOpen(!open);
  };
  const choose = (action: () => void) => {
    setOpen(false);
    trigger.current?.focus();
    action();
  };
  return (
    <div className="mod-toolbar" ref={wrap}>
      <button
        type="button"
        className="toolbar-button mod-toolbar-button"
        ref={trigger}
        disabled={busy}
        aria-label={label}
        title={current ? `${label} · ${current.title}` : label}
        aria-pressed={toggles ? !hidden : undefined}
        aria-haspopup={toggles ? undefined : 'menu'}
        aria-expanded={toggles ? undefined : open}
        aria-controls={!toggles && open ? id : undefined}
        aria-describedby={pendingBinding ? statusId : undefined}
        onClick={toggles ? onToggle : showMenu}
        onKeyDown={(event) => {
          if (!toggles && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
            event.preventDefault();
            if (!open) showMenu();
          }
        }}
      >
        <ModeIcon mode={current} />
      </button>
      {pendingBinding && (
        <span className="mod-pending-status" id={statusId} role="status">
          本轮结束后切换
        </span>
      )}
      {open && !toggles && (
        <div className="mod-menu" id={id} ref={menu} role="menu" aria-label={label}>
          {error && (
            <>
              <p role="alert">{friendlyModError(error).text}</p>
              <button type="button" role="menuitem" disabled={busy} onClick={onRetry}>
                重新读取
              </button>
            </>
          )}
          {loading && <p role="status">正在加载模式…</p>}
          {!binding &&
            installed.map((entry) => (
              <button
                type="button"
                role="menuitem"
                key={`${entry.id}@${entry.version}`}
                disabled={busy}
                onClick={() => choose(() => onSelect(entry.id))}
              >
                <ModeIcon mode={entry} />
                <span>{entry.title}</span>
              </button>
            ))}
          {binding && (
            <button type="button" role="menuitem" onClick={() => choose(onStore)}>
              打开 Mods Store
            </button>
          )}
        </div>
      )}
    </div>
  );
}
