import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';

const readerOpened = 'pugport-table-reader-open';

/** Long replies keep their table in the conversation's path scope, including the reading pane. */
export function TableReader({ heading, rows }: { heading: ReactNode; rows: ReactNode[] }) {
  const [reading, setReading] = useState(false);
  const id = useId();
  const reader = useRef<HTMLElement>(null);
  const launch = useRef<HTMLButtonElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const long = rows.length > 6;

  useEffect(() => {
    if (!long) return;
    const opened = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== id) setReading(false);
    };
    window.addEventListener(readerOpened, opened);
    return () => window.removeEventListener(readerOpened, opened);
  }, [id, long]);

  useEffect(() => {
    if (!reading) return;
    const panel = reader.current;
    const opener = launch.current;
    close.current?.focus({ preventScroll: true });
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !panel?.contains(event.target as Node)) return;
      event.preventDefault();
      event.stopPropagation();
      setReading(false);
    };
    document.addEventListener('keydown', escape, true);
    return () => {
      document.removeEventListener('keydown', escape, true);
      if (opener?.isConnected && (panel?.contains(document.activeElement) || document.activeElement === document.body))
        opener.focus({ preventScroll: true });
    };
  }, [reading]);

  const table = (
    <table>
      <thead>{heading}</thead>
      <tbody>{rows}</tbody>
    </table>
  );
  if (!long) return <div className="md-table">{table}</div>;
  return (
    <div className="md-table-block" data-row-count={rows.length}>
      <div className="md-table">{table}</div>
      <div className="md-table-actions">
        <span>{`共 ${rows.length} 行`}</span>
        <button
          type="button"
          ref={launch}
          aria-haspopup="dialog"
          aria-expanded={reading}
          aria-controls={reading ? `${id}-reader` : undefined}
          onClick={() => {
            window.dispatchEvent(new CustomEvent(readerOpened, { detail: id }));
            setReading(true);
          }}
        >
          在侧栏阅读
        </button>
      </div>
      {reading && (
        <aside
          ref={reader}
          className="md-table-reader"
          id={`${id}-reader`}
          role="dialog"
          aria-modal="false"
          aria-labelledby={`${id}-title`}
        >
          <div className="md-table-reader-heading">
            <div>
              <h2 id={`${id}-title`}>完整表格</h2>
              <span>{`共 ${rows.length} 行`}</span>
            </div>
            <button
              type="button"
              ref={close}
              className="icon-button"
              aria-label="关闭表格阅读"
              onClick={() => setReading(false)}
            >
              <X size={18} />
            </button>
          </div>
          <div className="md-table-reader-content">
            <div className="md-table">{table}</div>
          </div>
        </aside>
      )}
    </div>
  );
}
