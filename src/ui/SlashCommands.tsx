import { useEffect, useRef } from 'react';

export const slashCommands = [
  { id: '搜索', label: '联网搜索' },
  { id: 'plan', label: '先计划' },
  { id: 'side', label: '侧聊' },
  { id: 'new', label: '新建对话' },
] as const;
export type SlashCommand = (typeof slashCommands)[number]['id'];
export function slashCommandAt(text: string, caret = text.length): string | undefined {
  const prefix = text.slice(0, caret);
  return /^\/[a-z搜索]*$/i.test(prefix) ? prefix : undefined;
}
export function filterSlashCommands(text: string, incognito = false) {
  if (slashCommandAt(text) === undefined) return [];
  const query = text
    .slice(1)
    .toLowerCase()
    .replace(/^search$/, '搜索');
  return slashCommands
    .filter(
      (command) =>
        (command.id.startsWith(query) || (command.id === '搜索' && 'search'.startsWith(query))) &&
        (!incognito || command.id !== 'side'),
    )
    .sort((a, b) => Number(b.id === query) - Number(a.id === query));
}
export function SlashCommands({
  text,
  incognito,
  active,
  onHover,
  onRun,
}: {
  text: string;
  incognito?: boolean;
  active: number;
  onHover: (index: number) => void;
  onRun: (command: SlashCommand) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' });
  }, [active]);
  const items = filterSlashCommands(text, incognito);
  return (
    <div className="mention-menu composer-command-menu" role="listbox" aria-label="快捷命令" ref={ref}>
      {items.map((item, index) => (
        <button
          type="button"
          role="option"
          key={item.id}
          className={`mention-row ${index === active ? 'active' : ''}`}
          aria-selected={index === active}
          onMouseDown={(event) => event.preventDefault()}
          onMouseEnter={() => onHover(index)}
          onClick={() => onRun(item.id)}
        >
          <code>/{item.id}</code>
          <span>{item.label}</span>
        </button>
      ))}
      {!items.length && <p className="mention-empty">没有匹配的命令</p>}
    </div>
  );
}
