import { useEffect, useState, type KeyboardEvent } from 'react';
import { Check, Pencil, X } from 'lucide-react';
import { shownName, translateInterfaceText, withNames } from './i18n';

/**
 * An executor card's name with inline renaming. Executors call each other by this name, so it is worth keeping
 * short and distinct ("Codex B", "Grok 本机"). The name shows as written, PugPort's default ones translated.
 */
export function CardName({
  label,
  as: Tag = 'h3',
  disabled = false,
  onRename,
}: {
  label: string;
  as?: 'h3' | 'strong';
  disabled?: boolean;
  onRename?: (label: string) => Promise<unknown>;
}) {
  const shown = shownName(label);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(shown);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!editing) setDraft(shown);
  }, [shown, editing]);
  async function commit() {
    const next = draft.trim();
    if (!onRename || !next || next === shown) {
      setEditing(false);
      setDraft(shown);
      return;
    }
    setSaving(true);
    try {
      await onRename(next);
      setEditing(false);
    } catch {
      // The caller reports the error; keep the field open for another try.
    } finally {
      setSaving(false);
    }
  }
  function key(event: KeyboardEvent<HTMLInputElement>) {
    // Inside a card form, Enter must rename rather than submit the launch settings.
    if (event.key === 'Enter') {
      event.preventDefault();
      void commit();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setEditing(false);
      setDraft(shown);
    }
  }
  if (editing)
    return (
      <div className="card-name editing">
        <input
          aria-label="执行器名称"
          value={draft}
          maxLength={40}
          autoFocus
          disabled={saving}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={key}
          onFocus={(event) => event.target.select()}
        />
        <button
          type="button"
          className="icon-button"
          aria-label="保存名称"
          disabled={saving}
          onClick={() => void commit()}
        >
          <Check size={14} />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="取消重命名"
          disabled={saving}
          onClick={() => {
            setEditing(false);
            setDraft(shown);
          }}
        >
          <X size={14} />
        </button>
      </div>
    );
  return (
    <div className="card-name">
      <Tag translate="no">{shown}</Tag>
      {onRename && (
        <button
          type="button"
          className="icon-button card-name-edit"
          aria-label={withNames('重命名 {0}', [shown])}
          title={translateInterfaceText('重命名（其他执行器按这个名称调用它）')}
          data-names
          disabled={disabled}
          onClick={() => setEditing(true)}
        >
          <Pencil size={13} />
        </button>
      )}
    </div>
  );
}
