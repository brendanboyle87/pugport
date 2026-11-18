import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react';
import { textMatches } from '../shared/search';

const bodySelector =
  '[data-message-id] .message-text, [data-message-id] .markdown, [data-message-id] .system-notice-text';
/** DOM ranges preserve React ownership, Markdown formatting, links and copy/paste. */
export function findMessageRanges(container: HTMLElement, query: string): Range[] {
  if (!query) return [];
  const ranges: Range[] = [];
  const roots = [...container.querySelectorAll<HTMLElement>(bodySelector)].filter(
    (root) => !root.parentElement?.closest(bodySelector),
  );
  for (const root of roots) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) =>
        node.parentElement?.closest('button, script, style, [aria-hidden="true"]')
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT,
    });
    const nodes: Array<{ node: Text; start: number; end: number }> = [];
    let text = '';
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const start = text.length;
      text += node.textContent;
      nodes.push({ node: node as Text, start, end: text.length });
    }
    for (const match of textMatches(text, query)) {
      const first = nodes.find((part) => part.end > match.start);
      const last = nodes.find((part) => part.end >= match.end);
      if (!first || !last) continue;
      const range = document.createRange();
      range.setStart(first.node, match.start - first.start);
      range.setEnd(last.node, match.end - last.start);
      ranges.push(range);
    }
  }
  return ranges;
}

// A window can show several conversation panes. Each owns its ranges independently.
const paneHighlights = new Map<symbol, { all: Range[]; active?: Range }>();
function paint() {
  if (typeof CSS === 'undefined' || !CSS.highlights || typeof Highlight === 'undefined') return;
  const all = [...paneHighlights.values()];
  CSS.highlights.set('conversation-find', new Highlight(...all.flatMap((pane) => pane.all)));
  const active = new Highlight(...all.flatMap((pane) => (pane.active ? [pane.active] : [])));
  active.priority = 1;
  CSS.highlights.set('conversation-find-active', active);
}

export function FindBar({
  containerRef,
  conversationId,
  open,
  onOpenChange,
}: {
  containerRef: RefObject<HTMLDivElement | null>;
  conversationId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<{ query: string; ranges: Range[] }>({ query: '', ranges: [] });
  const { ranges } = matches;
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const owner = useRef(Symbol());
  const lastScrolled = useRef('');
  const latest = useRef(onOpenChange);
  latest.current = onOpenChange;
  const priorFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    setQuery('');
    setActive(0);
    latest.current(false);
  }, [conversationId]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        !(event.ctrlKey || event.metaKey) ||
        event.shiftKey ||
        event.altKey ||
        event.key.toLowerCase() !== 'f'
      )
        return;
      if (document.querySelector('dialog[open], [aria-modal="true"], .palette-backdrop')) return;
      const pane = containerRef.current?.closest('.conversation-workspace');
      const focusedPane = document.activeElement?.closest('.conversation-workspace');
      if (!pane || (focusedPane ? pane !== focusedPane : pane !== document.querySelector('.conversation-workspace')))
        return;
      event.preventDefault();
      if (!open) priorFocus.current = document.activeElement as HTMLElement;
      latest.current(true);
      input.current?.focus();
      input.current?.select();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [containerRef, open]);
  useLayoutEffect(() => {
    if (!open || !containerRef.current) {
      lastScrolled.current = '';
      return;
    }
    input.current?.focus();
    const container = containerRef.current;
    let frame = 0;
    const update = () => {
      frame = 0;
      setMatches({ query, ranges: findMessageRanges(container, query) });
    };
    update();
    const observer = new MutationObserver(() => {
      if (!frame) frame = requestAnimationFrame(update);
    });
    observer.observe(container, { childList: true, characterData: true, subtree: true });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [open, query, containerRef, conversationId]);
  useLayoutEffect(() => {
    const id = owner.current;
    const index = ranges.length ? active % ranges.length : 0;
    if (open) paneHighlights.set(id, { all: ranges, active: ranges[index] });
    else paneHighlights.delete(id);
    paint();
    const range = open && matches.query === query ? ranges[index] : undefined;
    const scrollKey = `${query}:${active}`;
    if (open && matches.query === query && lastScrolled.current !== scrollKey) {
      if (range) {
        lastScrolled.current = scrollKey;
        let element = range.startContainer.parentElement;
        while (element && element !== containerRef.current) {
          if (element instanceof HTMLDetailsElement) element.open = true;
          element = element.parentElement;
        }
        range.startContainer.parentElement?.scrollIntoView({ block: 'center' });
      }
    }
    return () => {
      paneHighlights.delete(id);
      paint();
    };
  }, [matches, active, open, query, containerRef]);
  const next = (step: number) =>
    setActive((value) => (ranges.length ? (value + step + ranges.length) % ranges.length : 0));
  const close = () => {
    latest.current(false);
    priorFocus.current?.focus({ preventScroll: true });
  };
  if (!open) return null;
  return (
    <div
      className="conversation-find-bar"
      role="search"
      aria-label="在对话中查找"
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          close();
        } else if (event.key === 'Enter') {
          event.preventDefault();
          next(event.shiftKey ? -1 : 1);
        }
      }}
    >
      <Search size={15} />
      <small>只查最近 500 条</small>
      <input
        ref={input}
        autoFocus
        aria-label="在对话中查找"
        placeholder="在对话中查找"
        maxLength={200}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
        }}
      />
      <output aria-live="polite">
        {ranges.length ? (active % ranges.length) + 1 : 0}/{ranges.length}
      </output>
      <button
        type="button"
        className="icon-button"
        disabled={!ranges.length}
        title="上一个匹配（Shift+Enter）"
        aria-label="上一个匹配"
        onClick={() => next(-1)}
      >
        <ChevronUp size={16} />
      </button>
      <button
        type="button"
        className="icon-button"
        disabled={!ranges.length}
        title="下一个匹配（Enter）"
        aria-label="下一个匹配"
        onClick={() => next(1)}
      >
        <ChevronDown size={16} />
      </button>
      <button type="button" className="icon-button" title="关闭查找（Esc）" aria-label="关闭查找" onClick={close}>
        <X size={16} />
      </button>
    </div>
  );
}
