import {
  backgroundAnsi,
  foregroundAnsi,
  getTerminalColorMode,
  parseColor,
  type EditorTheme,
  type MarkdownTheme,
  type RgbColor,
  type SelectListTheme,
  type TerminalColorMode,
} from './pi-tui.ts';

/** Colors for the terminal UI: Pi's interactive look, warmed up with the pug's fawn. */
const palettes = {
  dark: {
    accent: 'okhsl(65 72% 74%)',
    border: 'okhsl(229 8% 45%)',
    dim: 'okhsl(229 8% 56%)',
    muted: 'okhsl(229 6% 67%)',
    success: 'okhsl(159 59% 67%)',
    warning: 'okhsl(83 88% 67%)',
    error: 'okhsl(20 72% 67%)',
    userBg: 'okhsl(55 26% 21%)',
    toolPendingBg: 'okhsl(229 5% 22%)',
    toolSuccessBg: 'okhsl(158 40% 22%)',
    toolErrorBg: 'okhsl(19 50% 23%)',
    heading: 'okhsl(65 72% 74%)',
    link: 'okhsl(232 54% 67%)',
    code: 'okhsl(295 50% 70%)',
    codeBlock: 'okhsl(159 59% 67%)',
  },
  light: {
    accent: 'okhsl(55 80% 40%)',
    border: 'okhsl(235 7% 66%)',
    dim: 'okhsl(229 7% 55%)',
    muted: 'okhsl(229 8% 45%)',
    success: 'okhsl(159 75% 38%)',
    warning: 'okhsl(70 99% 40%)',
    error: 'okhsl(20 91% 45%)',
    userBg: 'okhsl(60 30% 91%)',
    toolPendingBg: 'okhsl(248 3% 92%)',
    toolSuccessBg: 'okhsl(156 21% 91%)',
    toolErrorBg: 'okhsl(24 23% 91%)',
    heading: 'okhsl(55 80% 40%)',
    link: 'okhsl(231 68% 47%)',
    code: 'okhsl(295 60% 46%)',
    codeBlock: 'okhsl(159 75% 38%)',
  },
} as const;
export type ColorName = keyof (typeof palettes)['dark'];
type Scheme = keyof typeof palettes;

/** NO_COLOR (https://no-color.org) or output that is not a terminal turns colors off. */
export function colorsWanted(stream: { isTTY?: boolean } = process.stdout, env: NodeJS.ProcessEnv = process.env) {
  if (env.NO_COLOR) return false;
  if (env.FORCE_COLOR && env.FORCE_COLOR !== '0') return true;
  return !!stream.isTTY && env.TERM !== 'dumb';
}

const sgr = (open: string, close: string) => (text: string) => (text ? `\x1b[${open}m${text}\x1b[${close}m` : text);

export class Theme {
  private codes = new Map<string, string>();
  constructor(
    readonly color: boolean,
    private scheme: Scheme = 'dark',
    readonly mode: TerminalColorMode = 'truecolor',
  ) {}
  get isLight() {
    return this.scheme === 'light';
  }
  /** Follows the terminal's own background once it reports it; components re-render after this. */
  useTerminalBackground(background: RgbColor | undefined) {
    if (!background) return;
    const luminance = (0.2126 * background.r + 0.7152 * background.g + 0.0722 * background.b) / 255;
    this.scheme = luminance > 0.55 ? 'light' : 'dark';
    this.codes.clear();
  }
  private code(name: ColorName, layer: 'fg' | 'bg') {
    const key = `${layer}:${name}`;
    let value = this.codes.get(key);
    if (value === undefined) {
      const color = parseColor(palettes[this.scheme][name]);
      value = layer === 'fg' ? foregroundAnsi(color, this.mode) : backgroundAnsi(color, this.mode);
      this.codes.set(key, value);
    }
    return value;
  }
  fg(name: ColorName, text: string) {
    return this.color && text ? `${this.code(name, 'fg')}${text}\x1b[39m` : text;
  }
  bg(name: ColorName, text: string) {
    return this.color && text ? `${this.code(name, 'bg')}${text}\x1b[49m` : text;
  }
  bold = (text: string) => (this.color ? sgr('1', '22')(text) : text);
  italic = (text: string) => (this.color ? sgr('3', '23')(text) : text);
  underline = (text: string) => (this.color ? sgr('4', '24')(text) : text);
  strikethrough = (text: string) => (this.color ? sgr('9', '29')(text) : text);
  /** Remaining quota: red at 10% or less, amber at 30% or less, green above (as in the tray). */
  tone(remaining: number | undefined, text: string) {
    return remaining === undefined
      ? this.fg('dim', text)
      : this.fg(remaining <= 10 ? 'error' : remaining <= 30 ? 'warning' : 'success', text);
  }
  markdown(): MarkdownTheme {
    return {
      heading: (text) => this.bold(this.fg('heading', text)),
      link: (text) => this.fg('link', text),
      linkUrl: (text) => this.fg('dim', text),
      code: (text) => this.fg('code', text),
      codeBlock: (text) => this.fg('codeBlock', text),
      codeBlockBorder: (text) => this.fg('dim', text),
      quote: (text) => this.fg('muted', text),
      quoteBorder: (text) => this.fg('dim', text),
      hr: (text) => this.fg('dim', text),
      listBullet: (text) => this.fg('accent', text),
      bold: this.bold,
      italic: this.italic,
      strikethrough: this.strikethrough,
      underline: this.underline,
    };
  }
  selectList(): SelectListTheme {
    return {
      selectedPrefix: (text) => this.fg('accent', text),
      selectedText: (text) => this.fg('accent', text),
      description: (text) => this.fg('muted', text),
      scrollInfo: (text) => this.fg('dim', text),
      noMatch: (text) => this.fg('dim', text),
    };
  }
  editor(): EditorTheme {
    return { borderColor: (text) => this.fg('border', text), selectList: this.selectList() };
  }
}

/** One theme per process, decided once from the environment. */
export function createTheme(stream: { isTTY?: boolean } = process.stdout, env: NodeJS.ProcessEnv = process.env) {
  const color = colorsWanted(stream, env);
  return new Theme(color, 'dark', color ? getTerminalColorMode() : 'truecolor');
}
