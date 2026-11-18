/**
 * The pieces of the terminal chat, laid out like Pi's interactive mode: a header, the message stream, an editor
 * framed by two rules with the working status in its top rule, and a two-line footer.
 */
import { isAbsolute, relative, sep } from 'node:path';
import type { ReplyView, ToolView } from './conversation-view.ts';
import {
  Container,
  Editor,
  Markdown,
  matchesKey,
  sliceByColumn,
  Spacer,
  Text,
  truncateToWidth,
  visibleWidth,
  type Component,
} from './pi-tui.ts';
import { pugFace, pugLogoLines, pugLogoWidth } from './pug-logo.ts';
import type { Theme } from './theme.ts';

/** Below this width the pug is replaced by its one-line face. */
export const logoMinWidth = 60;

export type HeaderInfo = { version: string; write: boolean; quota: string };

export class PugHeader implements Component {
  constructor(
    private readonly theme: Theme,
    private readonly info: () => HeaderInfo,
  ) {}
  invalidate() {}
  render(width: number): string[] {
    const { theme } = this;
    const info = this.info();
    const name = `${theme.bold(theme.fg('accent', 'PugPort'))} ${theme.fg('dim', `v${info.version}`)}`;
    const text = [
      name,
      `${theme.fg('dim', '额度')} ${info.quota || theme.fg('dim', '读取中…')}`,
      info.write
        ? theme.fg('warning', '可修改这个文件夹里的文件（--write）')
        : theme.fg('dim', '只读：不会改动文件。要让它改文件，用 pugport --write 打开'),
      [
        `${theme.fg('dim', 'Esc')} ${theme.fg('muted', '取消回复')}`,
        `${theme.fg('dim', 'Ctrl+C')} ${theme.fg('muted', '清空/退出')}`,
        `${theme.fg('dim', '/')} ${theme.fg('muted', '命令')}`,
        `${theme.fg('dim', '@')} ${theme.fg('muted', '角色或执行器')}`,
      ].join(theme.fg('dim', ' · ')),
      theme.fg('dim', '每条消息都由 PugPort 按剩余额度自动挑选账号。'),
    ];
    const lines: string[] = [];
    if (width >= logoMinWidth) {
      const logo = pugLogoLines({ color: theme.color, mode: theme.mode });
      const textWidth = width - 1 - pugLogoWidth - 3;
      const top = Math.max(0, Math.floor((logo.length - text.length) / 2));
      for (let row = 0; row < Math.max(logo.length, text.length + top); row++) {
        const right = text[row - top] ?? '';
        lines.push(` ${logo[row] ?? ' '.repeat(pugLogoWidth)}   ${truncateToWidth(right, textWidth, '…')}`);
      }
    } else {
      text[0] = `${theme.fg('accent', pugFace)} ${name}`;
      for (const line of text) lines.push(truncateToWidth(` ${line}`, width, '…'));
    }
    return lines.map((line) => truncateToWidth(line, width, ''));
  }
}

/** "~\Projects\app" for folders inside the home directory, as Pi's footer does. */
export function shortPath(path: string, home = process.env.USERPROFILE || process.env.HOME) {
  if (!home) return path;
  const inside = relative(home, path);
  if (inside === '') return '~';
  return inside.startsWith('..') || isAbsolute(inside) ? path : `~${sep}${inside}`;
}

/** The end of plain text in exactly `width` columns (at least 1), with "…" in front when it had to be cut. */
function keepEnd(text: string, width: number) {
  const full = visibleWidth(text);
  if (full <= width) return text;
  // A wide character cut in half is dropped; a space keeps the width.
  const end = sliceByColumn(text, full - width + 1, width - 1, true);
  return `…${' '.repeat(width - 1 - visibleWidth(end))}${end}`;
}

export type FooterInfo = {
  cwd: string;
  write: boolean;
  title?: string;
  quota: string;
  last?: string;
  offline?: string;
};

/** Two lines: where you are and the mode; the quota left and which account answered last. */
export class ChatFooter implements Component {
  constructor(
    private readonly theme: Theme,
    private readonly info: () => FooterInfo,
  ) {}
  invalidate() {}
  render(width: number): string[] {
    const { theme } = this;
    const info = this.info();
    const dot = theme.fg('dim', ' • ');
    const status = [
      info.write ? theme.fg('warning', '可改文件') : theme.fg('dim', '只读'),
      ...(info.offline ? [theme.fg('warning', info.offline)] : []),
    ].join(dot);
    // A long folder gives up its start rather than push the mode or a lost connection off the line; a title
    // after them is cut to " • …".
    const tail = dot + status + (info.title ? `${dot}…` : '');
    const folder = keepEnd(shortPath(info.cwd), Math.max(1, width - visibleWidth(tail)));
    const place = [theme.fg('dim', folder), status, ...(info.title ? [theme.fg('dim', info.title)] : [])].join(dot);
    const left = info.quota ? `${theme.fg('dim', '额度')} ${info.quota}` : theme.fg('dim', '额度读取中…');
    const right = info.last ? theme.fg('dim', `上一条：${info.last}`) : '';
    const leftWidth = visibleWidth(left);
    const rightRoom = width - leftWidth - 2;
    const second =
      right && rightRoom > 8
        ? (() => {
            const shown = truncateToWidth(right, rightRoom, '…');
            return left + ' '.repeat(Math.max(2, width - leftWidth - visibleWidth(shown))) + shown;
          })()
        : left;
    return [truncateToWidth(place, width, theme.fg('dim', '…')), truncateToWidth(second, width, theme.fg('dim', '…'))];
  }
}

/** The user's message on a tinted band, as Pi shows it. */
export function userMessage(theme: Theme, text: string): Component {
  return new Markdown(text, 1, 1, theme.markdown(), { bgColor: (line) => theme.bg('userBg', line) });
}

/** A plain note from the terminal itself (help, quota, errors). */
export function noteMessage(
  theme: Theme,
  text: string,
  tone: 'muted' | 'error' | 'warning' | 'plain' = 'muted',
): Component {
  const box = new Container();
  box.addChild(new Spacer(1));
  box.addChild(new Text(tone === 'plain' ? text : text.replace(/[^\n]+/g, (line) => theme.fg(tone, line)), 1, 0));
  return box;
}

const toolIcon = { running: '…', done: '✓', error: '✗' } as const;

/** One reply: who answered, the tool calls on tinted lines, then the answer as Markdown. */
export class ReplyBlock extends Container {
  private readonly heading = new Text('', 1, 0);
  private readonly tools = new Container();
  private readonly body: Markdown;
  private readonly footnote = new Text('', 1, 0);
  private toolKey = '';
  constructor(private readonly theme: Theme) {
    super();
    this.body = new Markdown('', 1, 0, theme.markdown());
    this.addChild(new Spacer(1));
    this.addChild(this.heading);
    this.addChild(this.tools);
    this.addChild(this.body);
    this.addChild(this.footnote);
  }
  update(view: ReplyView) {
    const { theme } = this;
    this.heading.setText(
      `${theme.fg('accent', '●')} ${theme.bold('PugPort')}${view.label ? theme.fg('dim', ` · ${view.label}`) : ''}`,
    );
    const key = JSON.stringify(view.tools);
    if (key !== this.toolKey) {
      this.toolKey = key;
      this.tools.clear();
      if (view.tools.length > 12)
        this.tools.addChild(new Text(theme.fg('dim', `（前面还有 ${view.tools.length - 12} 个操作）`), 1, 0));
      for (const tool of view.tools.slice(-12)) this.tools.addChild(this.toolLine(tool));
      if (view.tools.length) this.tools.addChild(new Spacer(1));
    }
    this.body.setText(view.text.trim());
    const notes = [
      ...(view.note ? [theme.fg('dim', view.note)] : []),
      ...(view.error ? [theme.fg(view.status === 'cancelled' ? 'muted' : 'error', view.error)] : []),
    ];
    this.footnote.setText(notes.join('\n'));
  }
  private toolLine(tool: ToolView): Component {
    const { theme } = this;
    const background =
      tool.status === 'error' ? 'toolErrorBg' : tool.status === 'done' ? 'toolSuccessBg' : 'toolPendingBg';
    const icon = theme.fg(
      tool.status === 'error' ? 'error' : tool.status === 'done' ? 'success' : 'dim',
      toolIcon[tool.status],
    );
    const line = `${icon} ${theme.bold(tool.name)}${tool.detail ? ` ${theme.fg('muted', tool.detail)}` : ''}`;
    return new ToolLine(line, (text) => theme.bg(background, text));
  }
}

/** A single tinted line, cut to the width instead of wrapping. */
class ToolLine implements Component {
  constructor(
    private readonly line: string,
    private readonly tint: (text: string) => string,
  ) {}
  invalidate() {}
  render(width: number): string[] {
    const inner = truncateToWidth(this.line, Math.max(1, width - 2), '…');
    return [this.tint(` ${inner}${' '.repeat(Math.max(0, width - 2 - visibleWidth(inner)))} `)];
  }
}

/**
 * The input box. Esc, Ctrl+C and Ctrl+D go to the chat first (cancel, clear/exit, exit); while a reply runs,
 * its status is written into the top rule like Pi's working indicator.
 */
export class PugEditor extends Editor {
  status?: () => string | undefined;
  onEscape?: () => boolean;
  onCtrlC?: () => void;
  onCtrlD?: () => void;
  override handleInput(data: string) {
    if (matchesKey(data, 'ctrl+c')) {
      this.onCtrlC?.();
      return;
    }
    if (matchesKey(data, 'escape') && !this.isShowingAutocomplete() && this.onEscape?.()) return;
    if (matchesKey(data, 'ctrl+d') && this.getText().length === 0) {
      this.onCtrlD?.();
      return;
    }
    super.handleInput(data);
  }
  protected override renderTopBorder(width: number, hiddenLineCount: number): string {
    const status = this.status?.();
    if (!status || hiddenLineCount > 0 || width < 8) return super.renderTopBorder(width, hiddenLineCount);
    const label = truncateToWidth(status, width - 5, '…');
    return `${this.borderColor('── ')}${label}${this.borderColor(` ${'─'.repeat(Math.max(0, width - 4 - visibleWidth(label)))}`)}`;
  }
}
