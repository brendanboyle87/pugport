import type { PageElement } from './markup.ts';

/** Human-operated desktop tools. Terminal bytes never enter the task or model event stream. */
export const DESKTOP_TOOLS_CHANNEL = 'pugport:desktop-tools';
export const DESKTOP_TOOLS_EVENT = 'pugport:desktop-tools-event';
export type DesktopToolsTab = 'terminal' | 'browser' | 'chrome';
export type DesktopToolContext = { conversationId: string; projectId: string; directory: string; incognito?: boolean };
export type TerminalSize = { cols: number; rows: number };
export type ToolBounds = { x: number; y: number; width: number; height: number };
export type PagePoint = { x: number; y: number };
export type PageRect = ToolBounds;
export type PageCapture = {
  dataUrl: string;
  url: string;
  title: string;
  viewport: { width: number; height: number };
};
export type PageElementHit = PageElement & { rect: PageRect };
export type TerminalSnapshot = {
  id: string;
  conversationId: string;
  directory: string;
  shell: string;
  output: string;
  sequence: number;
  exitCode?: number;
};
export type BrowserSnapshot = {
  id: string;
  conversationId: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  error?: string;
};
export type ChromePage = { id: string; title: string; url: string };
export type ChromeSnapshot = { id: string; endpoint: string; browser: string; pages: ChromePage[] };
export type DesktopToolsEvent =
  | { kind: 'terminal-data'; id: string; sequence: number; data: string }
  | { kind: 'terminal-exit'; id: string; exitCode: number }
  | { kind: 'browser'; browser: BrowserSnapshot }
  | { kind: 'browser-address'; id: string };
export type BrowserAction = 'navigate' | 'back' | 'forward' | 'reload' | 'stop';
export interface DesktopToolsApi {
  openTerminal(conversationId: string, size: TerminalSize): Promise<TerminalSnapshot>;
  writeTerminal(id: string, data: string): Promise<void>;
  resizeTerminal(id: string, size: TerminalSize): Promise<void>;
  closeTerminal(id: string): Promise<void>;
  openBrowser(conversationId: string): Promise<BrowserSnapshot>;
  browserAction(id: string, action: BrowserAction, url?: string): Promise<BrowserSnapshot>;
  browserBounds(id: string, bounds: ToolBounds | null): Promise<void>;
  browserCapture(id: string): Promise<PageCapture>;
  browserElement(id: string, point: PagePoint): Promise<PageElementHit | null>;
  browserText(id: string, rect: PageRect): Promise<string>;
  closeBrowser(id: string): Promise<void>;
  connectChrome(conversationId: string, endpoint: string): Promise<ChromeSnapshot>;
  refreshChrome(id: string): Promise<ChromeSnapshot>;
  activateChrome(id: string, pageId: string): Promise<void>;
  disconnectChrome(id: string): Promise<void>;
  onEvent(listener: (event: DesktopToolsEvent) => void): () => void;
}

/** Only an explicit local HTTP debugging endpoint; never a profile, executable or arbitrary URL. */
export function chromeEndpoint(value: string): string {
  const url = new URL(value.trim());
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    !url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new Error('请输入本机 Chrome 调试地址，例如 http://127.0.0.1:9222。');
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
  return url.origin;
}

/** Configuration only: importing and authorizing MCP tools remains an explicit separate action. */
export function chromeMcpConfiguration(endpoint: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        'chrome-explicit': {
          command: 'npx',
          args: [
            '-y',
            'chrome-devtools-mcp@1.12.0',
            `--browser-url=${chromeEndpoint(endpoint)}`,
            '--no-usage-statistics',
          ],
        },
      },
    },
    null,
    2,
  );
}
