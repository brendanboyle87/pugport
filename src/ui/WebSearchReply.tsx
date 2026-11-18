import { Fragment, isValidElement, useState, type ReactNode } from 'react';
import { ChevronDown, Search } from 'lucide-react';
import type { ConversationMessage, Workflow } from '../shared/types';
import type { WebSearchResult } from '../shared/web-search';
import type { Api, Notice } from './Workspace';
import { renderMarkdown } from './markdown';
import { currentLocale } from './i18n';

const publicLink = (value: string) => {
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url.href : undefined;
  } catch {
    return undefined;
  }
};

type SourceNodeProps = {
  children?: ReactNode;
  href?: string;
  heading?: ReactNode;
  rows?: ReactNode[];
  text?: string;
  'data-local-path'?: string;
  'data-relative-path'?: string;
};
/** Search excerpts cannot turn the reply renderer's local file references into host actions. */
function sourceNode(node: ReactNode): ReactNode {
  if (Array.isArray(node)) return node.map(sourceNode);
  if (!isValidElement<SourceNodeProps>(node)) return node;
  const props = node.props;
  const Tag = node.type;
  const children = sourceNode(props.children);
  if (props['data-local-path'] || props['data-relative-path']) return <Fragment key={node.key}>{children}</Fragment>;
  if (node.type === 'a') {
    const href = publicLink(props.href ?? '');
    return href ? (
      <a key={node.key} href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ) : (
      <Fragment key={node.key}>{children}</Fragment>
    );
  }
  return (
    <Tag
      key={node.key}
      {...props}
      {...(props.heading ? { heading: sourceNode(props.heading) } : {})}
      {...(props.rows ? { rows: props.rows.map(sourceNode) } : {})}
    >
      {children}
    </Tag>
  );
}
function sourceText(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(sourceText).join('');
  if (!isValidElement<SourceNodeProps>(node))
    return typeof node === 'string' || typeof node === 'number' ? String(node) : '';
  const text = node.props.text ?? sourceText(node.props.children ?? [node.props.heading, node.props.rows]);
  return (
    text +
    (node.props.text || (typeof node.type === 'string' && /^(?:p|h[2-6]|li|tr|th|td)$/.test(node.type)) ? ' ' : '')
  );
}
function sourceBody(summary: string) {
  // Images become their alt text; renderMarkdown builds React nodes and never interprets raw HTML.
  const text = summary.replace(/!\[([^\]\n]*)\]\(\s*(?:<[^>\n]*>|[^)\n]*)\)/g, '$1');
  const body = sourceNode(renderMarkdown(text, { relativePaths: false }));
  return { body, preview: sourceText(body).replace(/\s+/g, ' ').trim() };
}
function sourceDate(value?: string) {
  if (!value) return undefined;
  const date = /^\d{4}-\d{2}-\d{2}(?:T|$)/.test(value) ? new Date(value) : undefined;
  return date && Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat(currentLocale(), {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        timeZone: 'UTC',
      }).format(date)
    : value;
}
function sourceTitle(source: WebSearchResult) {
  if (source.title.trim() && source.title !== source.url) return source.title;
  const url = new URL(source.url);
  const label = url.hostname + (url.pathname === '/' ? '' : url.pathname);
  return label.length > 80 ? label.slice(0, 77) + '…' : label;
}

/** Older searches stored the same source list as Markdown rather than structured fields. */
export function savedSearchSources(message: ConversationMessage): WebSearchResult[] {
  if (Array.isArray(message.webSearch?.results))
    return message.webSearch.results
      .slice(0, 10)
      .filter((item) => typeof item?.url === 'string' && !!publicLink(item.url))
      .map((item) => ({
        ...item,
        title: typeof item.title === 'string' ? item.title : '',
        summary: typeof item.summary === 'string' ? item.summary : '',
        date: typeof item.date === 'string' ? item.date : undefined,
      }));
  const results: WebSearchResult[] = [];
  for (const line of message.content.slice(0, 32000).split(/\r?\n/)) {
    const match = /^\d+\. \[(.*)\]\(<(https?:\/\/[^>]+)>\)(?: · (.*))?$/.exec(line);
    if (match) {
      if (results.length === 10) break;
      if (publicLink(match[2]!))
        results.push({
          title: match[1]!.replace(/\\([\\`*_[\]<>])/g, '$1'),
          url: match[2]!,
          summary: '',
          date: match[3],
        });
    } else if (results.length && !/^(来源：DeepSeek 搜索|网页摘要已截短)/.test(line)) {
      const result = results.at(-1)!;
      result.summary += (result.summary ? '\n' : '') + line.replace(/^>\s?/, '');
    }
  }
  return results;
}

export function searchAnswerLabel(message: ConversationMessage, workflow?: Workflow): string {
  if (message.webSearch?.status === 'running') return '正在搜索网页…';
  if (message.webSearch?.status === 'failed') return '搜索未完成';
  if (workflow?.status === 'completed') return '已整理回答';
  if (workflow && ['failed', 'blocked', 'cancelled', 'interrupted'].includes(workflow.status))
    return '回答已停止，网页资料已保留';
  if (workflow && ['waiting-confirmation', 'waiting-approval'].includes(workflow.status)) return '等待确认后整理回答';
  if (workflow && ['queued', 'waiting-resource'].includes(workflow.status)) return '正在等待执行器整理回答';
  if (workflow || message.webSearch?.answer?.status === 'starting') return '正在整理回答…';
  if (message.webSearch?.answer?.status === 'started') return '回答任务已提交';
  return '搜索已完成，网页资料已保留';
}

export function WebSearchReply({
  message,
  workflow,
  api,
  notify,
}: {
  message: ConversationMessage;
  workflow?: Workflow;
  api?: Api;
  notify?: (notice: Notice) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState('');
  const sources = savedSearchSources(message);
  const search = message.webSearch!;
  const canAnswer =
    search.status === 'completed' && (!search.answer || ['failed', 'unavailable'].includes(search.answer.status));
  async function answer() {
    if (!api || busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await api<{ reply?: ConversationMessage; workflow?: Workflow }>(
        `/api/conversations/${message.conversationId}/messages/${message.id}/search-answer`,
        {},
      );
      const answer = result.reply?.webSearch?.answer;
      if (answer && ['failed', 'unavailable'].includes(answer.status))
        setError(answer.error || '暂时无法开始回答，网页资料仍已保留。');
      else setSubmitted(true);
    } catch {
      setError('暂时无法开始回答，网页资料仍已保留。');
      notify?.({ tone: 'error', message: '暂时无法开始回答，网页资料仍已保留。' });
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="web-search-reply" aria-label="联网搜索">
      <div className="web-search-progress" role="status" aria-live="polite">
        <Search size={14} aria-hidden="true" />
        <span>DS 搜索</span>
        <span>
          {busy
            ? '正在整理回答…'
            : submitted && search.answer?.status !== 'started'
              ? '回答任务已提交'
              : searchAnswerLabel(message, workflow)}
        </span>
        {canAnswer && !submitted && api && (
          <button type="button" className="button quiet" disabled={busy} onClick={() => void answer()}>
            整理成回答
          </button>
        )}
      </div>
      {(error || search.answer?.error) && (
        <p className="inline-error" role="alert">
          {error || search.answer?.error}
        </p>
      )}
      {search.status === 'failed' && <p>{message.content}</p>}
      {search.status === 'completed' && (
        <details className="web-search-sources">
          <summary>
            <span>网页资料{sources.length ? ` · ${sources.length} 个来源` : ''}</span>
            <ChevronDown size={14} aria-hidden="true" />
          </summary>
          <p className="web-search-query">
            实际检索：
            {Array.from(search.searchQuery || search.query)
              .slice(0, 128)
              .join('')}
          </p>
          {sources.length ? (
            <ol className="web-search-source-list">
              {sources.map((source, index) => {
                const summary = source.summary.trim();
                const { body, preview } = sourceBody(summary);
                const long = preview.length > 240;
                return (
                  <li className="web-search-source" key={source.url + index}>
                    <a href={publicLink(source.url)} title={source.url} target="_blank" rel="noopener noreferrer">
                      {sourceTitle(source)}
                    </a>
                    <div className="web-search-source-origin">
                      {new URL(source.url).hostname}
                      {source.date && (
                        <>
                          {' '}
                          · <time dateTime={source.date}>{sourceDate(source.date)}</time>
                        </>
                      )}
                    </div>
                    {long && (
                      <p className="web-search-source-preview" translate="no">
                        {preview.slice(0, 240)}…
                      </p>
                    )}
                    {summary && !long && <div className="markdown web-search-source-article">{body}</div>}
                    {long && (
                      <details className="web-search-source-full">
                        <summary>展开完整摘要</summary>
                        <div className="markdown web-search-source-article">{body}</div>
                      </details>
                    )}
                  </li>
                );
              })}
            </ol>
          ) : (
            <div className="markdown web-search-original web-search-source-article">
              {sourceBody(message.content).body}
            </div>
          )}
          <div className="web-search-receipt">
            DeepSeek 搜索{search.durationMs !== undefined ? ` · ${(search.durationMs / 1000).toFixed(2)} 秒` : ''}
            {search.estimatedCostCny !== undefined ? ` · 搜索费用估算 ¥${search.estimatedCostCny.toFixed(3)}` : ''}
          </div>
        </details>
      )}
    </section>
  );
}
