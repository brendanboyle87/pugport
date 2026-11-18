import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { PenLine, Quote, X } from 'lucide-react';
import type { MessageQuote } from '../shared/quotes';
import { withNames } from './i18n';

/*
 * Quoting works like the Codex app: select text, choose "引用", say what you want done with it in a small
 * box, and the passage becomes a capsule above the composer. Capsules can be reopened to edit the note or
 * removed; once sent they appear on the message, and executors receive each one numbered with its note.
 */

export type DraftQuote = MessageQuote & { id: string; attachmentDraftId?: string; markupSrc?: string };

const markupLabel = (quote: MessageQuote) => {
  const markup = quote.markup!;
  return markup.marks.length === 1
    ? withNames('1 处标注 · {0}', [markup.source.name])
    : withNames('{0} 处标注 · {1}', [String(markup.marks.length), markup.source.name]);
};
const quoteNote = (quote: MessageQuote) =>
  quote.markup ? quote.markup.marks.find((mark) => mark.note)?.note : quote.note;

const excerpt = (text: string, length = 36) => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > length ? `${line.slice(0, length)}…` : line;
};

/** The small box that opens at the selection (or at a capsule) for the note about one quote. */
export function QuoteEditor({
  text,
  note,
  left,
  top,
  editing,
  onSave,
  onCancel,
  onRemove,
  onOutside,
  label,
  placeholder = '想对这段做什么？例如：解释一下、改成英文、检查对不对（可留空）',
  maxLength = 2000,
  above,
}: {
  text: string;
  note: string;
  left: number;
  top: number;
  /** Where the box ends when there is no room below `top` (the anchor's top edge); default: just above a text line. */
  above?: number;
  editing?: boolean;
  label?: string;
  placeholder?: string;
  maxLength?: number;
  onSave: (note: string) => void;
  onCancel: () => void;
  onRemove?: () => void;
  /** A pointer down outside the box; without it that cancels. */
  onOutside?: (note: string) => void;
}) {
  const [value, setValue] = useState(note);
  const latest = useRef(value);
  latest.current = value;
  const box = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState({ left, top });
  useLayoutEffect(() => {
    const rect = box.current?.getBoundingClientRect();
    if (!rect) return;
    // Stay on screen: flip above the anchor near the bottom, clamp at the sides.
    const below = top + rect.height + 12 < window.innerHeight;
    setPlace({
      left: Math.max(12, Math.min(left - rect.width / 2, window.innerWidth - rect.width - 12)),
      top: below ? top : Math.max(12, (above ?? top - 32) - rect.height - 8),
    });
  }, [left, top, above]);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!box.current?.contains(event.target as Node)) {
        if (onOutside) onOutside(latest.current.trim());
        else onCancel();
      }
    };
    // Capture phase: a press on a badge or the picture stops propagation or unmounts this box before bubbling.
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [onCancel, onOutside]);
  return (
    <div
      ref={box}
      className="quote-editor"
      role="dialog"
      aria-label={label ?? (editing ? '编辑引用' : '添加引用')}
      style={place}
      data-selection-actions="true"
    >
      {label ? (
        <p className="quote-editor-label" translate="no">
          {label}
        </p>
      ) : (
        <blockquote title={text} translate="no">
          {text}
        </blockquote>
      )}
      <textarea
        autoFocus
        rows={2}
        value={value}
        aria-label={label}
        maxLength={maxLength}
        placeholder={placeholder}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onCancel();
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            onSave(value.trim());
          }
        }}
      />
      <div className="quote-editor-actions">
        {onRemove && (
          <button type="button" className="button quiet tiny danger-text" onClick={onRemove}>
            移除
          </button>
        )}
        <span />
        <button type="button" className="button secondary tiny" onClick={onCancel}>
          取消
        </button>
        <button type="button" className="button primary tiny" onClick={() => onSave(value.trim())}>
          {editing ? '保存' : '添加引用'}
        </button>
      </div>
    </div>
  );
}

/** Capsules above the composer: click to edit the note, × to remove. */
export function QuoteChips({
  quotes,
  disabled,
  onEdit,
  onRemove,
}: {
  quotes: DraftQuote[];
  disabled?: boolean;
  onEdit: (quote: DraftQuote, anchor: DOMRect) => void;
  onRemove: (id: string) => void;
}) {
  if (!quotes.length) return null;
  return (
    <div className="quote-chips" aria-label="待发送的引用">
      {quotes.map((quote, index) => (
        <span className={`quote-chip${quote.markup ? ' markup' : ''}`} key={quote.id}>
          <button
            type="button"
            disabled={disabled}
            title={quote.note ? `${quote.text}\n\n${withNames('要求：{0}', [quote.note])}` : quote.text}
            data-names
            onClick={(event) => onEdit(quote, event.currentTarget.getBoundingClientRect())}
          >
            {quote.markup ? <PenLine size={12} /> : <Quote size={12} />}
            <b>{index + 1}</b>
            <span translate="no">{quote.markup ? markupLabel(quote) : excerpt(quote.text)}</span>
            {quoteNote(quote) && <em translate="no">{excerpt(quoteNote(quote)!, 24)}</em>}
          </button>
          <button
            type="button"
            className="quote-chip-remove"
            disabled={disabled}
            aria-label={`移除引用 ${index + 1}`}
            onClick={() => onRemove(quote.id)}
          >
            <X size={11} />
          </button>
        </span>
      ))}
    </div>
  );
}

/** The quotes on a sent message: compact capsules that expand to the full passage. */
export function MessageQuotes({ quotes }: { quotes: MessageQuote[] }) {
  const [open, setOpen] = useState<number>();
  if (!quotes.length) return null;
  return (
    <div className="message-quotes">
      {quotes.map((quote, index) => (
        <div key={index} className={`message-quote ${quote.markup ? 'markup ' : ''}${open === index ? 'open' : ''}`}>
          <button
            type="button"
            aria-expanded={open === index}
            onClick={() => setOpen(open === index ? undefined : index)}
          >
            {quote.markup ? <PenLine size={12} /> : <Quote size={12} />}
            <b>{index + 1}</b>
            <span translate="no">
              {open === index ? '' : quote.markup ? markupLabel(quote) : excerpt(quote.text, 48)}
            </span>
            {quoteNote(quote) && open !== index && <em translate="no">{excerpt(quoteNote(quote)!, 30)}</em>}
          </button>
          {open === index && (
            <div className="message-quote-body" translate="no">
              {quote.markup ? (
                // People read their own marks; the geometry text is for executors.
                quote.markup.marks.map((mark) => (
                  <p key={mark.n}>
                    {mark.note
                      ? withNames('标注 {0}：{1}', [String(mark.n), mark.note])
                      : withNames('标注 {0}', [String(mark.n)])}
                  </p>
                ))
              ) : (
                <>
                  <blockquote>{quote.text}</blockquote>
                  {quote.note && <p>{quote.note}</p>}
                </>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
