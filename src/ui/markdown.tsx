import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { AlertCircle, Check, Copy, X } from 'lucide-react';
import { createPortal } from 'react-dom';
import { TableReader } from './TableReader';

/*
 * A small Markdown renderer for executor replies: headings, emphasis, inline code, links, lists, tables,
 * quotes, rules and fenced code. It builds React elements only (no HTML strings), so model output can
 * never inject markup. Local file links (C:/…/file.ts:12) show as a compact file name with the full path
 * on hover; web links open in the browser.
 */

const webUrl = /^(https?:\/\/|mailto:)/i;

export function CodeBlock({ language, text }: { language: string; text: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      clearTimeout(timer.current);
    };
  }, []);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      if (!alive.current) return;
      setFailed(false);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      if (alive.current) {
        setCopied(false);
        setFailed(true);
      }
    }
  }
  return (
    <div className="message-code">
      <div className="message-code-head">
        <span>{language}</span>
        <button type="button" className="button tiny quiet" onClick={() => void copy()}>
          {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
          <span aria-live="polite">{copied ? '已复制' : '复制'}</span>
        </button>
      </div>
      <pre>
        <code>{text}</code>
      </pre>
      {failed &&
        createPortal(
          <div className="notice notice-error" role="alert">
            <AlertCircle size={17} aria-hidden="true" />
            <span>无法复制，请选择文本后复制。</span>
            <button type="button" className="icon-button" aria-label="关闭提示" onClick={() => setFailed(false)}>
              <X size={15} aria-hidden="true" />
            </button>
          </div>,
          document.body,
        )}
    </div>
  );
}

export type MarkdownOptions = { relativePaths?: boolean; plainText?: (text: string, key: string) => ReactNode };

function decodedFilePath(value: string): string | undefined {
  if (!/^file:/i.test(value)) return value;
  if (!/^file:\/\//i.test(value)) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'file:' || url.search || url.hash) return undefined;
    const path = decodeURIComponent(url.pathname);
    return url.hostname && url.hostname !== 'localhost'
      ? `\\\\${url.hostname}${path.replace(/\//g, '\\')}`
      : path.replace(/^\/(?=[A-Za-z]:[\\/])/, '');
  } catch {
    return undefined;
  }
}

/** The path itself, without a file:// prefix or a :line(:column) suffix. */
export function localPathOf(value: string): string | undefined {
  const path = decodedFilePath(value.trim())?.replace(/:\d+(?::\d+)?$/, '');
  if (path && /^\/(?!\/)/.test(path)) return /[\u0000-\u001f]/.test(path) ? undefined : path;
  return path && /^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/])/.test(path) && !/[\u0000-\u001f<>|"*?]/.test(path)
    ? path
    : undefined;
}

/**
 * A relative file or folder path written as code ("1.jpg", "汪熙妍\\图片\\20.jpg"): clickable when the same reply
 * names a full path or the renderer receives project context. The click handler resolves it before opening.
 */
const relativePath = /^(?![-\s])[^`<>|"*?:\n]{1,200}$/;
export function relativePathOf(value: string, explicitLink = false): string | undefined {
  const text = value.trim();
  if (!relativePath.test(text) || localPathOf(text)) return undefined;
  if (/^(?:npm|pnpm|yarn|git|node|python|powershell|cmd)\s/i.test(text)) return undefined;
  return /[\\/]/.test(text) ||
    /\.[A-Za-z0-9]{2,5}$/.test(text) ||
    /^[\p{Script=Han}][\p{Script=Han}\d _（）()-]{0,49}$/u.test(text) ||
    (explicitLink && /^[A-Za-z_][\w .()-]{0,99}$/.test(text))
    ? text
    : undefined;
}

/** "C:/a/b/routing.ts:114" → "routing.ts:114". */
export function fileLabel(path: string): string {
  const clean = (decodedFilePath(path) ?? path).replace(/[\\/]+$/, '');
  return clean.split(clean.startsWith('/') ? '/' : /[\\/]/).pop() || clean;
}

function linkTo(href: string, children: ReactNode, key: string, options: MarkdownOptions): ReactNode {
  const target = href.trim();
  if (webUrl.test(target))
    return (
      <a key={key} href={target} target="_blank" rel="noreferrer" title={target}>
        {children}
      </a>
    );
  const path = localPathOf(target);
  const relative = !path && options.relativePaths ? relativePathOf(target, true) : undefined;
  if (path || relative)
    return (
      <span
        key={key}
        className="file-ref"
        role="button"
        tabIndex={0}
        title={`${decodedFilePath(target) ?? target}\n点击打开所在文件夹`}
        data-local-path={path}
        data-relative-path={relative}
      >
        {children}
      </span>
    );
  return <Fragment key={key}>{children}</Fragment>;
}

const inlinePattern = new RegExp(
  [
    /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/.source, // 1,2 code
    /\*\*(?=\S)([\s\S]*?\S)\*\*/.source, // 3 bold
    /__(?=\S)([\s\S]*?\S)__/.source, // 4 bold
    /~~(?=\S)([\s\S]*?\S)~~/.source, // 5 strike
    /\[([^\]\n]+)\]\(\s*<([^>\n]+)>\s*\)/.source, // 6,7 link to <target>
    /\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.source, // 8,9 link
    /<((?:https?:\/\/|mailto:|file:\/\/|[A-Za-z]:[\\/]|\/(?!\/)(?=[^<>\n]*\/))[^>\n]+)>/.source, // 10 autolink
    /(https?:\/\/[^\s<>()（）[\]"'，。；！？、]+[^\s<>()（）[\]"'，。；！？、.,;:!?])/.source, // 11 bare url
    /(?<![\w*])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![\w*])/.source, // 12 italic
    /(?<![\p{L}\p{N}_])((?:[A-Za-z]:[\\/]|\\\\(?=[^\s\\/]+[\\/]))[^\s<>|"'*?`，。；！？、：“”‘’（）()\[\]{}]*)/u.source, // 13 clearly delimited bare Windows path
    /\\[\\`*_{}\[\]()#+.!>|~-]/.source, // escaped plain text, after paths
  ].join('|'),
  'gu',
);

export function renderInline(text: string, prefix = 'i', options: MarkdownOptions = {}): ReactNode[] {
  // A complete path on its own line has an explicit boundary. Keep spaces and balanced-looking
  // filename parentheses instead of creating a link to only "C:\\...\\Altium" from a pasted path list.
  const standalone = text.trim();
  if (
    /^(?:[A-Za-z]:[\\/]|\\\\|\/(?!\/))/.test(standalone) &&
    localPathOf(standalone) &&
    !/[`\r\n，。；！？“”]/.test(standalone) &&
    !/[.,;!]$/.test(standalone) &&
    !/\s[A-Za-z]:[\\/]/.test(standalone)
  )
    return [
      text.slice(0, text.indexOf(standalone)),
      linkTo(standalone, standalone, `${prefix}-path`, options),
      text.slice(text.indexOf(standalone) + standalone.length),
    ];
  const out: ReactNode[] = [];
  let last = 0,
    index = 0;
  // Each invocation owns its parser state, including nested emphasis and blockquotes.
  const pattern = new RegExp(inlinePattern);
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    if (match.index > last)
      out.push(
        options.plainText?.(text.slice(last, match.index), `${prefix}-text-${last}`) ?? text.slice(last, match.index),
      );
    const key = `${prefix}-${index++}`;
    const [whole] = match;
    if (/^\\[\\`*_{}\[\]()#+.!>|~-]$/.test(whole)) out.push(whole.slice(1));
    else if (match[2] !== undefined) {
      const path = localPathOf(match[2]);
      const relative = !path && options.relativePaths ? relativePathOf(match[2]) : undefined;
      out.push(
        path ? (
          <code
            key={key}
            className="path-ref"
            role="button"
            tabIndex={0}
            data-local-path={path}
            title="点击在文件夹中打开"
          >
            {match[2]}
          </code>
        ) : relative ? (
          <code
            key={key}
            className="path-ref"
            role="button"
            tabIndex={0}
            data-relative-path={relative}
            title="点击在文件夹中打开"
          >
            {match[2]}
          </code>
        ) : (
          <code key={key}>{match[2]}</code>
        ),
      );
    } else if (match[3] !== undefined || match[4] !== undefined)
      out.push(<strong key={key}>{renderInline(match[3] ?? match[4]!, key, options)}</strong>);
    else if (match[5] !== undefined) out.push(<del key={key}>{renderInline(match[5], key, options)}</del>);
    else if (match[6] !== undefined) out.push(linkTo(match[7]!, label(match[6], match[7]!, key), key, options));
    else if (match[8] !== undefined) out.push(linkTo(match[9]!, label(match[8], match[9]!, key), key, options));
    else if (match[10] !== undefined)
      out.push(linkTo(match[10], webUrl.test(match[10]) ? shortUrl(match[10]) : fileLabel(match[10]), key, options));
    else if (match[11] !== undefined) out.push(linkTo(match[11], shortUrl(match[11]), key, options));
    else if (match[12] !== undefined) out.push(<em key={key}>{renderInline(match[12], key, options)}</em>);
    else if (match[13] !== undefined) {
      const path = match[13].replace(/[.,;!]+$/, '');
      out.push(linkTo(path, path, key, options), match[13].slice(path.length));
    } else out.push(whole);
    last = match.index + whole.length;
  }
  if (last < text.length) out.push(options.plainText?.(text.slice(last), `${prefix}-text-${last}`) ?? text.slice(last));
  return out;
}

/** A link whose text is just its own path reads better as the file name. */
function label(text: string, href: string, key: string): ReactNode {
  const plain = text.trim();
  if (localPathOf(plain) || plain === href.trim()) return localPathOf(plain) ? fileLabel(plain) : shortUrl(plain);
  return renderInline(text, key);
}

function shortUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/$/, '');
    const shown = `${parsed.hostname.replace(/^www\./, '')}${path}`;
    return shown.length > 48 ? `${shown.slice(0, 45)}…` : shown;
  } catch {
    return url;
  }
}

const tableRow = /^\s*\|?(.+?)\|?\s*$/;
const splitCells = (line: string) =>
  (line.match(tableRow)?.[1] ?? line).split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'));
const isSeparator = (line: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
const listItem = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/;

type ListNode = { ordered: boolean; start: number; items: Array<{ text: string[]; children: ListNode[] }> };

function renderList(list: ListNode, key: string, options: MarkdownOptions): ReactNode {
  const items = list.items.map((item, index) => (
    <li key={index}>
      {item.text.map((line, lineIndex) => (
        <Fragment key={lineIndex}>
          {lineIndex > 0 && '\n'}
          {renderInline(line, `${key}-${index}-${lineIndex}`, options)}
        </Fragment>
      ))}
      {item.children.map((child, childIndex) => renderList(child, `${key}-${index}-c${childIndex}`, options))}
    </li>
  ));
  return list.ordered ? (
    <ol key={key} start={list.start !== 1 ? list.start : undefined}>
      {items}
    </ol>
  ) : (
    <ul key={key}>{items}</ul>
  );
}

export function renderMarkdown(source: string, options: MarkdownOptions = {}): ReactNode[] {
  // Relative paths become clickable only next to a full path they can be resolved against.
  const context = {
    ...options,
    relativePaths: options.relativePaths ?? /(?:^|[\s`(（"“<])(?:file:\/\/|[A-Za-z]:[\\/]|\\\\|\/(?!\/))/i.test(source),
  };
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (!paragraph.length) return;
    const key = `p${blocks.length}`;
    blocks.push(
      <p key={key}>
        {paragraph.map((line, index) => (
          <Fragment key={index}>
            {index > 0 && '\n'}
            {renderInline(line, `${key}-${index}`, context)}
          </Fragment>
        ))}
      </p>,
    );
    paragraph = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const key = `b${blocks.length}`;
    const fence = line.match(/^\s*(```+|~~~+)\s*([\w+#.-]*)/);
    if (fence) {
      flush();
      const body: string[] = [];
      for (i++; i < lines.length && !lines[i]!.trim().startsWith(fence[1]!); i++) body.push(lines[i]!);
      blocks.push(<CodeBlock key={key} language={fence[2] || ''} text={body.join('\n')} />);
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (heading) {
      flush();
      const level = Math.min(heading[1]!.length + 1, 6);
      const Tag = `h${level}` as 'h2';
      blocks.push(<Tag key={key}>{renderInline(heading[2]!, key, context)}</Tag>);
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      blocks.push(<hr key={key} />);
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && isSeparator(lines[i + 1]!)) {
      flush();
      const head = splitCells(line);
      const align = splitCells(lines[i + 1]!).map((cell) =>
        cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : undefined,
      );
      const rows: string[][] = [];
      for (i += 2; i < lines.length && lines[i]!.includes('|') && lines[i]!.trim(); i++)
        rows.push(splitCells(lines[i]!));
      i--;
      blocks.push(
        <TableReader
          key={key}
          heading={
            <tr>
              {head.map((cell, index) => (
                <th key={index} scope="col" style={{ textAlign: align[index] }}>
                  {renderInline(cell, `${key}-h${index}`, context)}
                </th>
              ))}
            </tr>
          }
          rows={rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {head.map((_, index) => (
                <td key={index} style={{ textAlign: align[index] }}>
                  {renderInline(row[index] ?? '', `${key}-${rowIndex}-${index}`, context)}
                </td>
              ))}
            </tr>
          ))}
        />,
      );
      continue;
    }
    if (/^\s{0,3}>/.test(line)) {
      flush();
      const quoted: string[] = [];
      for (; i < lines.length && /^\s{0,3}>/.test(lines[i]!); i++) quoted.push(lines[i]!.replace(/^\s{0,3}>\s?/, ''));
      i--;
      blocks.push(<blockquote key={key}>{renderMarkdown(quoted.join('\n'), context)}</blockquote>);
      continue;
    }
    if (listItem.test(line)) {
      flush();
      // Nested lists by indentation; continuation lines join the item above.
      const root: ListNode[] = [];
      const stack: Array<{ indent: number; list: ListNode }> = [];
      for (; i < lines.length; i++) {
        const current = lines[i]!;
        const item = current.match(listItem);
        if (!item) {
          if (!current.trim() || !stack.length || !/^\s+/.test(current)) break;
          stack.at(-1)!.list.items.at(-1)!.text.push(current.trim());
          continue;
        }
        const indent = item[1]!.replace(/\t/g, '    ').length;
        const ordered = /\d/.test(item[2]!);
        while (stack.length && stack.at(-1)!.indent > indent) stack.pop();
        // Switching between bullets and numbers at the same depth starts a new list.
        if (stack.at(-1)?.indent === indent && stack.at(-1)!.list.ordered !== ordered) stack.pop();
        let top = stack.at(-1);
        if (!top || top.indent < indent) {
          const list: ListNode = { ordered, start: ordered ? parseInt(item[2]!, 10) : 1, items: [] };
          if (top) top.list.items.at(-1)!.children.push(list);
          else root.push(list);
          stack.push((top = { indent, list }));
        }
        top.list.items.push({ text: [item[3]!], children: [] });
      }
      i--;
      root.forEach((list, index) => blocks.push(renderList(list, `${key}-${index}`, context)));
      continue;
    }
    paragraph.push(line.trim());
  }
  flush();
  return blocks;
}
