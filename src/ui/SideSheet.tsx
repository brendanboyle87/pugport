import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

const Layer = createContext<HTMLElement | null>(null);

/**
 * Sheets and menus inside render into `value` instead: a CSS size container (container-type) above them would
 * otherwise become their positioning box and pin them inside the column.
 */
export function OverlayLayer({ value, children }: { value: HTMLElement | null; children: ReactNode }) {
  return <Layer.Provider value={value}>{children}</Layer.Provider>;
}

/** Renders its children into the nearest OverlayLayer, or in place when there is none. */
export function InOverlayLayer({ children }: { children: ReactNode }) {
  const layer = useContext(Layer);
  return layer ? createPortal(children, layer) : children;
}

/**
 * A panel that slides in over the right side of its container, for looking at something without leaving the
 * conversation. It stays open while you scroll or type elsewhere, and closes on its button or Escape.
 */
export function SideSheet({
  title,
  label,
  names,
  subtitle,
  leading,
  actions,
  className = '',
  onClose,
  children,
}: {
  title: ReactNode;
  /** Accessible name when the title is not plain text. */
  label: string;
  /** The label was filled in with withNames: the window leaves it as it is. */
  names?: boolean;
  subtitle?: ReactNode;
  leading?: ReactNode;
  actions?: ReactNode;
  className?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) close.current();
    };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, []);
  return (
    <InOverlayLayer>
      <aside className={`side-sheet ${className}`} role="dialog" aria-label={label} data-names={names || undefined}>
        <header className="side-sheet-head">
          {leading}
          <div className="side-sheet-title">
            <strong>{title}</strong>
            {subtitle && <small>{subtitle}</small>}
          </div>
          <div className="side-sheet-actions">
            {actions}
            <button type="button" className="icon-button" aria-label="关闭" title="关闭（Esc）" onClick={onClose}>
              <X size={15} />
            </button>
          </div>
        </header>
        <div className="side-sheet-body">{children}</div>
      </aside>
    </InOverlayLayer>
  );
}
