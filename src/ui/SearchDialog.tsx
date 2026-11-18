import { useEffect, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import type { ConversationSearchResult } from '../shared/search';
import type { Api } from './Workspace';
import { currentLocale, shownTitle } from './i18n';

export function SearchResults({
  results,
  active,
  onSelect,
  onActive,
}: {
  results: ConversationSearchResult[];
  active: number;
  onSelect: (result: ConversationSearchResult) => void;
  onActive: (index: number) => void;
}) {
  return (
    <div className="palette-list search-results" role="listbox" id="history-search-results" aria-label="搜索结果">
      {results.map((result, index) => (
        <button
          type="button"
          role="option"
          key={`${result.conversationId}:${result.messageId}`}
          id={`history-search-${index}`}
          aria-selected={index === active}
          className={index === active ? 'active' : ''}
          onMouseMove={() => onActive(index)}
          onClick={() => onSelect(result)}
        >
          <span className="search-result-copy">
            <strong>
              <span translate="no">{shownTitle(result.title)}</span>
              {result.archivedAt && <small> · 已归档</small>}
            </strong>
            <span className="search-snippet" translate="no">
              {result.snippet.map((part, at) =>
                part.match ? <mark key={at}>{part.text}</mark> : <span key={at}>{part.text}</span>,
              )}
            </span>
          </span>
          <time dateTime={result.createdAt}>
            {new Date(result.createdAt).toLocaleString(currentLocale(), {
              month: 'short',
              day: 'numeric',
              year: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            })}
          </time>
        </button>
      ))}
    </div>
  );
}

export function SearchDialog({
  api,
  onSelect,
  onClose,
}: {
  api: Api;
  onSelect: (result: ConversationSearchResult) => Promise<void>;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ConversationSearchResult[]>([]);
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(false);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const request = useRef(0);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    input.current?.focus();
    return () => {
      previous?.focus();
    };
  }, []);
  useEffect(() => {
    const token = ++request.current;
    setResults([]);
    setActive(0);
    setError('');
    setLoading(query.trim().length >= 2);
    if (query.trim().length < 2) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void api<ConversationSearchResult[]>(
        `/api/search?q=${encodeURIComponent(query.trim())}&limit=50`,
        undefined,
        'GET',
        controller.signal,
      )
        .then((value) => {
          if (request.current === token) setResults(value);
        })
        .catch(() => {
          if (request.current === token) setError('搜索失败，请稍后重试。');
        })
        .finally(() => {
          if (request.current === token) setLoading(false);
        });
    }, 300);
    return () => {
      controller.abort();
      clearTimeout(timer);
      request.current++;
    };
  }, [query, api]);
  useEffect(() => {
    dialog.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active]);
  async function choose(result?: ConversationSearchResult) {
    if (!result || opening) return;
    setOpening(true);
    setError('');
    try {
      await onSelect(result);
      onClose();
    } catch {
      setError('无法打开搜索结果，请重试。');
    } finally {
      setOpening(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="palette history-search-dialog"
      aria-label="搜索对话内容"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="palette-input">
        <Search size={17} />
        <input
          ref={input}
          autoFocus
          type="search"
          maxLength={200}
          aria-label="搜索对话内容"
          placeholder="搜索所有对话的消息和标题…"
          value={query}
          role="combobox"
          aria-expanded="true"
          aria-controls="history-search-results"
          aria-activedescendant={results.length ? `history-search-${active}` : undefined}
          onChange={(event) => {
            request.current++;
            setResults([]);
            setQuery(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              setActive((value) =>
                results.length ? (value + (event.key === 'ArrowDown' ? 1 : results.length - 1)) % results.length : 0,
              );
            } else if (event.key === 'Enter') {
              event.preventDefault();
              void choose(results[active]);
            }
          }}
        />
        <button type="button" className="icon-button" aria-label="关闭搜索" onClick={onClose}>
          <X size={16} />
        </button>
      </div>
      <div aria-busy={loading || opening}>
        {error ? (
          <p className="palette-empty" role="alert">
            {error}
          </p>
        ) : loading ? (
          <p className="palette-empty" role="status">
            正在搜索…
          </p>
        ) : (
          !results.length && (
            <p className="palette-empty" role="status">
              {query.trim().length >= 2 ? '没有匹配的结果' : '输入至少 2 个字符，搜索所有对话'}
            </p>
          )
        )}
        <SearchResults
          results={results}
          active={active}
          onActive={setActive}
          onSelect={(result) => void choose(result)}
        />
      </div>
      <footer className="search-footer">↑ ↓ 选择 · Enter 打开 · Esc 关闭</footer>
    </dialog>
  );
}
