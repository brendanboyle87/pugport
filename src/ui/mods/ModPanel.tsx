import { useEffect, useId, useRef, useState } from 'react';
import { Ellipsis } from 'lucide-react';
import type { ConversationModeView } from '../../shared/conversation-modes';
import { ModFormView, type ModFormViewProps } from '../ConversationModeView';
import { useDismiss } from '../use-dismiss';
import { useMenuKeys } from '../use-menu-keys';
import { ModeIcon } from './mod-icons';
import { ModFrame, type ModFrameProps } from './ModFrame';

type Props = ModFormViewProps & {
  view: ConversationModeView;
  hidden: boolean;
  onRemove: () => void;
  web?: Omit<ModFrameProps, 'slot' | 'hidden'>;
};

export function ModPanel({ hidden, onRemove, web, ...form }: Props) {
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
  useEffect(() => {
    if (hidden) setOpen(false);
  }, [hidden]);
  const { manifest, instance } = form.view;
  const title = manifest?.contributions?.rightPanel?.title ?? manifest?.title ?? 'Mod';
  return (
    <aside className="mod-panel" hidden={hidden} aria-label={title}>
      <header className="mod-panel-header">
        <ModeIcon mode={manifest ?? undefined} />
        <strong translate="no">{title}</strong>
        {manifest && <small>v{manifest.version}</small>}
        <div className="mod-panel-menu" ref={wrap}>
          <button
            type="button"
            className="toolbar-button"
            ref={trigger}
            aria-label="Mod 菜单"
            aria-haspopup="menu"
            aria-expanded={open}
            aria-controls={open ? id : undefined}
            disabled={form.busy}
            onClick={() => setOpen(!open)}
          >
            <Ellipsis size={16} aria-hidden="true" />
          </button>
          {open && (
            <div className="mod-menu" id={id} ref={menu} role="menu" aria-label="Mod 菜单">
              <button
                type="button"
                role="menuitem"
                disabled={form.busy || form.view.pending?.binding === null}
                onClick={() => {
                  setOpen(false);
                  onRemove();
                }}
              >
                从此对话移除 Mod
              </button>
            </div>
          )}
        </div>
      </header>
      <div className="mod-panel-content">
        {manifest?.contributions?.rightPanel?.kind === 'web' ? (
          web && <ModFrame key={instance?.id} {...web} slot="rightPanel" hidden={hidden} />
        ) : (
          <ModFormView key={instance?.id} {...form} />
        )}
      </div>
    </aside>
  );
}
