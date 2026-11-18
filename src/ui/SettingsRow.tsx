import { useId, useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';

export function SettingsGroup({
  title,
  description,
  children,
  itemId,
  id,
  className = '',
}: {
  /** Left out where the surrounding sheet or page already names the group. */
  title?: string;
  description?: ReactNode;
  children: ReactNode;
  itemId?: string;
  id?: string;
  className?: string;
}) {
  return (
    <section id={id} className={`settings-group ${className}`} data-settings-item={itemId} tabIndex={-1}>
      {title && <h3>{title}</h3>}
      {description && <p className="settings-group-description">{description}</p>}
      <div className="settings-group-box">{children}</div>
    </section>
  );
}

export function SettingsRow({
  title,
  description,
  status,
  tone,
  control,
  children,
  footer,
  defaultExpanded = false,
  expanded: controlledExpanded,
  onExpandedChange,
  itemId,
  className = '',
}: {
  /** A name the user chose goes in a translate="no" element. */
  title: ReactNode;
  description?: ReactNode;
  status?: ReactNode;
  tone?: 'live' | 'warning' | 'danger';
  control?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  defaultExpanded?: boolean;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  itemId?: string;
  className?: string;
}) {
  const [localExpanded, setExpanded] = useState(defaultExpanded);
  const expanded = controlledExpanded ?? localExpanded;
  const detailsId = useId();
  return (
    <div className={`settings-row ${className}`} data-settings-item={itemId} tabIndex={-1}>
      <div className="settings-row-main">
        <div className="settings-row-copy">
          {children ? (
            <button
              type="button"
              className="settings-row-expand"
              aria-expanded={expanded}
              aria-controls={detailsId}
              onClick={() => {
                setExpanded(!expanded);
                onExpandedChange?.(!expanded);
              }}
            >
              {title}
              <ChevronDown size={14} aria-hidden="true" />
            </button>
          ) : (
            <span className="settings-row-title">{title}</span>
          )}
          {description && <div className="settings-row-description">{description}</div>}
        </div>
        {(status || control) && (
          <div className="settings-row-actions">
            {status && (
              <span className="settings-row-status" role="status">
                {tone && <span className={`settings-status-dot ${tone}`} aria-hidden="true" />}
                {status}
              </span>
            )}
            {control}
          </div>
        )}
      </div>
      {footer}
      {children && (
        <div id={detailsId} className="settings-row-details" hidden={!expanded}>
          {children}
        </div>
      )}
    </div>
  );
}
