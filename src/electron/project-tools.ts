import {
  app,
  BrowserWindow,
  WebContentsView,
  ipcMain,
  type IpcMainInvokeEvent,
  type NativeImage,
  type WebContents,
} from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import type { IPty, IWindowsPtyForkOptions } from 'node-pty';
import { ensurePtyHelperExecutable } from '../server/platform/pty-helper.ts';
import {
  DESKTOP_TOOLS_CHANNEL,
  DESKTOP_TOOLS_EVENT,
  chromeEndpoint,
  type BrowserSnapshot,
  type ChromeSnapshot,
  type DesktopToolContext,
  type DesktopToolsEvent,
  type TerminalSize,
  type TerminalSnapshot,
  type ToolBounds,
  type PageCapture,
  type PagePoint,
  type PageRect,
} from '../shared/desktop-tools.ts';
import { inlineText, markupLimits } from '../shared/markup.ts';
import {
  MARKUP_WORLD_ID,
  pageViewportScript,
  pageElementScript,
  pageTextScript,
  cleanPageElement,
  cleanPageText,
} from './page-markup.ts';

/** The app's node-pty, after making its POSIX spawn helper executable (the published package omits the bit). */
export function loadNodePty(appPath: string): typeof import('node-pty') {
  const load = createRequire(join(appPath, 'package.json'));
  ensurePtyHelperExecutable(dirname(load.resolve('node-pty/package.json')));
  return load('node-pty');
}

const idPattern = /^[\w-]{1,100}$/;
const outputLimit = 256 * 1024;
type Owner = { window: BrowserWindow; active: boolean; generation: number };
type Terminal = {
  owner: Owner;
  pty: IPty;
  snapshot: TerminalSnapshot;
  subscriptions: Array<{ dispose(): void }>;
  pending: string;
  timer?: ReturnType<typeof setTimeout>;
};
type Browser = {
  owner: Owner;
  view: WebContentsView;
  snapshot: BrowserSnapshot;
  transient?: boolean;
  capturedUrl?: string;
};
type Chrome = {
  owner: Owner;
  generation: number;
  abort: AbortController;
  conversationId: string;
  snapshot: ChromeSnapshot;
};
type Dependencies = {
  origin: string;
  token?: () => string | undefined;
  context?: (conversationId: string) => Promise<DesktopToolContext>;
  spawn?: (
    shell: string,
    args: string[],
    options: IWindowsPtyForkOptions & {
      cwd: string;
      cols: number;
      rows: number;
      env: Record<string, string>;
      name: string;
    },
  ) => IPty;
  request?: typeof fetch;
  scriptTimeoutMs?: number;
  /** Tests only: a hidden window has no display surface, so capturePage cannot work there. */
  capture?: (contents: WebContents) => Promise<NativeImage>;
};
const plainUrl = (value: string) => {
  const url = new URL(value);
  return url.origin + url.pathname;
};
const cleanId = (value: unknown): string => {
  if (typeof value !== 'string' || !idPattern.test(value)) throw new Error('工具会话无效。');
  return value;
};
export function terminalSize(value: unknown): TerminalSize {
  const size = value as TerminalSize | undefined;
  if (
    !size ||
    !Number.isInteger(size.cols) ||
    !Number.isInteger(size.rows) ||
    size.cols < 2 ||
    size.cols > 500 ||
    size.rows < 1 ||
    size.rows > 200
  )
    throw new Error('终端尺寸无效。');
  return { cols: size.cols, rows: size.rows };
}
export function browserUrl(value: unknown, appPort: number): string {
  if (typeof value !== 'string' || value.length > 8192) throw new Error('网页地址无效。');
  const url = new URL(value.trim());
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    Number(url.port || (url.protocol === 'https:' ? 443 : 80)) === appPort
  )
    throw new Error('只能打开网页，不能访问 PugPort 本身或本机文件。');
  return url.href;
}
export function browserRequestAllowed(value: string, appPort: number): boolean {
  try {
    const url = new URL(value);
    if (['data:', 'blob:'].includes(url.protocol)) return true;
    return (
      ['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) &&
      Number(url.port || (['https:', 'wss:'].includes(url.protocol) ? 443 : 80)) !== appPort
    );
  } catch {
    return false;
  }
}
export function terminalEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([key, value]) =>
        value !== undefined &&
        !/^(?:ELECTRON_|PUGPORT_|COMBORUNNER_|AGENT_STUDIO_|NODE_OPTIONS$|NODE_CHANNEL_|NODE_UNIQUE_ID$)/i.test(key),
    ),
  ) as Record<string, string>;
}

/** Resolves the directory from the authenticated local backend, never from a renderer-supplied path. */
export async function desktopToolContext(
  origin: string,
  conversationId: string,
  request: typeof fetch = fetch,
  token?: string,
): Promise<DesktopToolContext> {
  cleanId(conversationId);
  if (!token) throw new Error('本地会话无法确认。');
  const response = await request(`${origin}/api/conversations/${encodeURIComponent(conversationId)}/desktop-context`, {
    headers: { 'x-agent-token': token },
    signal: AbortSignal.timeout(5000),
    redirect: 'error',
  });
  if (!response.ok) throw new Error('对话或目录已不可用，请重新打开工具面板。');
  const context = (await response.json()) as DesktopToolContext;
  if (
    context.conversationId !== conversationId ||
    !idPattern.test(context.projectId) ||
    typeof context.directory !== 'string' ||
    !isAbsolute(context.directory)
  )
    throw new Error('后台返回的目录无效。');
  const directory = await realpath(context.directory);
  if (!(await stat(directory)).isDirectory()) throw new Error('工作目录不存在。');
  return { ...context, directory };
}

/** Window-owned human tools. No model bridge, task logging, persistent terminal transcripts or shell commands in IPC. */
export class ProjectTools {
  private owners = new Map<number, Owner>();
  private terminals = new Map<string, Terminal>();
  private browsers = new Map<string, Browser>();
  private chrome = new Map<string, Chrome>();
  private opening = new Map<string, Promise<unknown>>();
  private hardened = new Set<string>();
  private port: number;
  private request: typeof fetch;
  constructor(private options: Dependencies) {
    this.port = Number(new URL(options.origin).port);
    this.request = options.request ?? fetch;
  }
  get activeTerminals() {
    return [...this.terminals.values()].filter((terminal) => terminal.snapshot.exitCode === undefined).length;
  }
  install() {
    ipcMain.handle(DESKTOP_TOOLS_CHANNEL, (event, value) => this.handle(event, value));
  }
  register(window: BrowserWindow) {
    if (this.owners.has(window.webContents.id)) return;
    const owner = { window, active: true, generation: 0 };
    this.owners.set(window.webContents.id, owner);
    window.once('closed', () => this.releaseOwner(owner));
    window.webContents.on('render-process-gone', () => {
      owner.generation++;
      this.releaseTools(owner);
    });
    window.webContents.on('did-start-navigation', (_event, _url, _inPlace, mainFrame) => {
      if (mainFrame)
        for (const browser of this.browsers.values()) if (browser.owner === owner) browser.view.setVisible(false);
    });
  }
  private owner(event: IpcMainInvokeEvent): Owner {
    const owner = this.owners.get(event.sender.id);
    if (
      !owner?.active ||
      owner.window.isDestroyed() ||
      event.sender !== owner.window.webContents ||
      event.senderFrame !== event.sender.mainFrame
    )
      throw new Error('只有 PugPort 窗口可以使用这些工具。');
    try {
      if (new URL(event.senderFrame.url).origin === this.options.origin) return owner;
    } catch {}
    throw new Error('页面来源无效。');
  }
  private send(owner: Owner, event: DesktopToolsEvent) {
    if (owner.active && !owner.window.isDestroyed()) owner.window.webContents.send(DESKTOP_TOOLS_EVENT, event);
  }
  private owned<T extends { owner: Owner }>(map: Map<string, T>, id: unknown, owner: Owner): T {
    const item = map.get(cleanId(id));
    if (!item || item.owner !== owner) throw new Error('工具不属于当前窗口。');
    return item;
  }
  private async context(owner: Owner, conversationId: unknown) {
    const id = cleanId(conversationId);
    const generation = owner.generation;
    const context = await (this.options.context?.(id) ??
      desktopToolContext(this.options.origin, id, this.request, this.options.token?.()));
    if (
      !owner.active ||
      owner.window.isDestroyed() ||
      owner.generation !== generation ||
      new URL(owner.window.webContents.getURL()).origin !== this.options.origin
    )
      throw new Error('窗口已关闭或页面已变化。');
    return context;
  }
  private oneOpen<T>(key: string, work: () => Promise<T>): Promise<T> {
    const existing = this.opening.get(key);
    if (existing) return existing as Promise<T>;
    if (this.opening.size >= 24) return Promise.reject(new Error('正在打开的工具过多，请稍后重试。'));
    const operation = work().finally(() => {
      if (this.opening.get(key) === operation) this.opening.delete(key);
    });
    this.opening.set(key, operation);
    return operation;
  }
  async handle(event: IpcMainInvokeEvent, raw: unknown): Promise<unknown> {
    const owner = this.owner(event);
    const value = raw as Record<string, unknown> | null;
    if (!value || typeof value !== 'object') throw new Error('工具请求无效。');
    switch (value.action) {
      case 'terminal.open':
        return this.oneOpen(`terminal:${event.sender.id}:${cleanId(value.conversationId)}`, () =>
          this.openTerminal(owner, value.conversationId, terminalSize(value.size)),
        );
      case 'terminal.write': {
        const terminal = this.owned(this.terminals, value.id, owner);
        if (typeof value.data !== 'string' || value.data.length > 64 * 1024)
          throw new Error('一次输入过长，请分段粘贴。');
        if (terminal.snapshot.exitCode !== undefined) throw new Error('终端已结束。');
        terminal.pty.write(value.data);
        return;
      }
      case 'terminal.resize': {
        const terminal = this.owned(this.terminals, value.id, owner),
          size = terminalSize(value.size);
        if (terminal.snapshot.exitCode === undefined) terminal.pty.resize(size.cols, size.rows);
        return;
      }
      case 'terminal.close':
        this.closeTerminal(this.owned(this.terminals, value.id, owner));
        return;
      case 'browser.open':
        return this.oneOpen(`browser:${event.sender.id}:${cleanId(value.conversationId)}`, () =>
          this.openBrowser(owner, value.conversationId),
        );
      case 'browser.action':
        return this.navigate(this.owned(this.browsers, value.id, owner), value.command, value.url);
      case 'browser.capture':
      case 'browser.element':
      case 'browser.text': {
        const browser = this.owned(this.browsers, value.id, owner);
        const generation = owner.generation;
        const result = await (value.action === 'browser.capture'
          ? this.capturePage(browser)
          : value.action === 'browser.element'
            ? this.pageElement(browser, value.point)
            : this.pageText(browser, value.rect));
        this.owned(this.browsers, value.id, this.owner(event));
        if (owner.generation !== generation) throw new Error('窗口已关闭或页面已变化。');
        return result;
      }
      case 'browser.bounds': {
        const browser = this.owned(this.browsers, value.id, owner);
        if (value.bounds === null) {
          browser.view.setVisible(false);
          return;
        }
        const bounds = value.bounds as ToolBounds;
        if (!bounds || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite))
          throw new Error('网页区域无效。');
        const [width, height] = owner.window.getContentSize();
        const x = Math.max(0, Math.min(width, Math.round(bounds.x))),
          y = Math.max(0, Math.min(height, Math.round(bounds.y)));
        const w = Math.max(0, Math.min(width - x, Math.round(bounds.width))),
          h = Math.max(0, Math.min(height - y, Math.round(bounds.height)));
        browser.view.setBounds({ x, y, width: w, height: h });
        browser.view.setVisible(w >= 40 && h >= 40);
        return;
      }
      case 'browser.close':
        this.closeBrowser(this.owned(this.browsers, value.id, owner));
        return;
      case 'chrome.connect':
        return this.oneOpen(`chrome:${event.sender.id}:${cleanId(value.conversationId)}`, () =>
          this.connectChrome(owner, value.conversationId, value.endpoint),
        );
      case 'chrome.refresh': {
        const connection = this.owned(this.chrome, value.id, owner);
        return this.chromeSnapshot(connection);
      }
      case 'chrome.activate': {
        const connection = this.owned(this.chrome, value.id, owner);
        const snapshot = await this.chromeSnapshot(connection);
        if (typeof value.pageId !== 'string' || !snapshot.pages.some((page) => page.id === value.pageId))
          throw new Error('这个 Chrome 标签页已经关闭。');
        await this.chromeRequest(
          connection.snapshot.endpoint,
          `/json/activate/${encodeURIComponent(value.pageId)}`,
          false,
          connection.abort.signal,
        );
        return;
      }
      case 'chrome.disconnect': {
        const connection = this.owned(this.chrome, value.id, owner);
        connection.abort.abort();
        this.chrome.delete(connection.snapshot.id);
        return;
      }
      default:
        throw new Error('不支持的工具操作。');
    }
  }
  private async openTerminal(owner: Owner, conversationId: unknown, size: TerminalSize) {
    const context = await this.context(owner, conversationId);
    const existing = [...this.terminals.values()].find(
      (item) => item.owner === owner && item.snapshot.conversationId === context.conversationId,
    );
    if (existing) {
      this.flushTerminal(existing);
      return { ...existing.snapshot };
    }
    if (this.terminals.size >= 16) throw new Error('终端数量已达上限，请先关闭不用的终端。');
    const shell =
      process.platform === 'win32'
        ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
        : process.env.SHELL && isAbsolute(process.env.SHELL)
          ? process.env.SHELL
          : '/bin/sh';
    const args = process.platform === 'win32' ? ['-NoLogo', '-NoProfile'] : [];
    const spawn =
      this.options.spawn ??
      ((file, arguments_, settings) => loadNodePty(app.getAppPath()).spawn(file, arguments_, settings));
    let pty: IPty;
    try {
      pty = spawn(shell, args, {
        cwd: context.directory,
        ...size,
        env: terminalEnvironment(process.env),
        name: 'xterm-256color',
        // The bundled ConPTY implementation closes its own console without a PID-list helper race.
        ...(process.platform === 'win32' ? { useConptyDll: true } : {}),
      });
    } catch {
      throw new Error('无法启动本机终端，请检查桌面安装的终端组件。');
    }
    const terminal: Terminal = {
      owner,
      pty,
      subscriptions: [],
      pending: '',
      snapshot: {
        id: randomUUID(),
        conversationId: context.conversationId,
        directory: context.directory,
        shell,
        output: '',
        sequence: 0,
      },
    };
    this.terminals.set(terminal.snapshot.id, terminal);
    terminal.subscriptions.push(
      pty.onData((data) => {
        terminal.snapshot.output = (terminal.snapshot.output + data).slice(-outputLimit);
        terminal.pending += data;
        if (terminal.pending.length > outputLimit)
          terminal.pending = '\r\n[输出过快，较早输出已省略]\r\n' + terminal.pending.slice(-outputLimit);
        terminal.timer ??= setTimeout(() => this.flushTerminal(terminal), 16);
      }),
      pty.onExit(({ exitCode }) => {
        this.flushTerminal(terminal);
        terminal.snapshot.exitCode = exitCode;
        this.send(owner, { kind: 'terminal-exit', id: terminal.snapshot.id, exitCode });
      }),
    );
    return { ...terminal.snapshot };
  }
  private flushTerminal(terminal: Terminal) {
    clearTimeout(terminal.timer);
    terminal.timer = undefined;
    if (!terminal.pending) return;
    this.send(terminal.owner, {
      kind: 'terminal-data',
      id: terminal.snapshot.id,
      sequence: ++terminal.snapshot.sequence,
      data: terminal.pending,
    });
    terminal.pending = '';
  }
  private closeTerminal(terminal: Terminal) {
    this.terminals.delete(terminal.snapshot.id);
    clearTimeout(terminal.timer);
    terminal.pending = '';
    for (const subscription of terminal.subscriptions) subscription.dispose();
    if (terminal.snapshot.exitCode === undefined) {
      try {
        terminal.pty.kill();
      } catch {}
    }
    terminal.snapshot.output = '';
  }
  private async evaluate(contents: WebContents, code: string): Promise<unknown> {
    if (contents.isDestroyed()) throw new Error('网页已停止，请刷新重试。');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        contents.executeJavaScriptInIsolatedWorld(MARKUP_WORLD_ID, [{ code }]),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('网页没有响应，无法读取元素。')),
            this.options.scriptTimeoutMs ?? 2000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  private async capturePage(browser: Browser): Promise<PageCapture> {
    const contents = browser.view.webContents;
    browser.capturedUrl = undefined;
    if (contents.isDestroyed()) throw new Error('网页已停止，请刷新重试。');
    if (contents.isLoading()) throw new Error('网页还在加载，稍后再试。');
    let url: string;
    try {
      url = plainUrl(browserUrl(contents.getURL(), this.port));
    } catch {
      throw new Error('还没有打开网页。');
    }
    if (url.length > markupLimits.url) throw new Error('网页地址无效。');
    const image = await (this.options.capture?.(contents) ?? contents.capturePage());
    if (image.isEmpty()) throw new Error('网页截图失败，请重试。');
    const viewport = (await this.evaluate(contents, pageViewportScript).catch(() => undefined)) as
      (PageCapture['viewport'] & { title?: unknown }) | undefined;
    if (
      !viewport ||
      ![viewport.width, viewport.height].every((n) => Number.isInteger(n) && n > 0 && n <= markupLimits.size)
    )
      throw new Error('网页截图失败，请重试。');
    const full = contents.isDestroyed() ? '' : contents.getURL();
    if (!full || contents.isLoading() || plainUrl(full) !== url) throw new Error('窗口已关闭或页面已变化。');
    // The full address, kept here only, so a query or hash navigation (#/login) also counts as a different page.
    browser.capturedUrl = full;
    return {
      dataUrl: image.toDataURL(),
      url,
      // document.title, not getTitle(): without a <title> Chromium returns the whole address, query included.
      title: inlineText(typeof viewport.title === 'string' ? viewport.title : '', markupLimits.title),
      viewport: { width: viewport.width, height: viewport.height },
    };
  }
  private pageMatches(browser: Browser) {
    const contents = browser.view.webContents;
    try {
      return !!browser.capturedUrl && !contents.isDestroyed() && contents.getURL() === browser.capturedUrl;
    } catch {
      return false;
    }
  }
  private async pageElement(browser: Browser, raw: unknown) {
    const point = raw as PagePoint | undefined;
    if (!point || ![point.x, point.y].every((n) => Number.isFinite(n) && n >= 0 && n <= 20000))
      throw new Error('标注位置无效。');
    if (!this.pageMatches(browser)) return null;
    const result = await this.evaluate(browser.view.webContents, pageElementScript({ x: point.x, y: point.y }));
    return this.pageMatches(browser) ? cleanPageElement(result) : null;
  }
  private async pageText(browser: Browser, raw: unknown) {
    const rect = raw as PageRect | undefined;
    if (!rect || ![rect.x, rect.y, rect.width, rect.height].every((n) => Number.isFinite(n) && n >= 0 && n <= 20000))
      throw new Error('标注区域无效。');
    if (!this.pageMatches(browser)) return '';
    const result = await this.evaluate(
      browser.view.webContents,
      pageTextScript({ x: rect.x, y: rect.y, width: rect.width, height: rect.height }),
    );
    return this.pageMatches(browser) ? cleanPageText(result) : '';
  }
  private browserSnapshot(browser: Browser) {
    const contents = browser.view.webContents;
    Object.assign(browser.snapshot, {
      url: contents.getURL(),
      title: contents.getTitle(),
      loading: contents.isLoading(),
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
    });
    return { ...browser.snapshot };
  }
  private async openBrowser(owner: Owner, conversationId: unknown) {
    const context = await this.context(owner, conversationId);
    const existing = [...this.browsers.values()].find(
      (item) => item.owner === owner && item.snapshot.conversationId === context.conversationId,
    );
    if (existing) return this.browserSnapshot(existing);
    if (this.browsers.size >= 8) throw new Error('网页数量已达上限，请先关闭不用的网页。');
    const partition = context.incognito
      ? `pugport-browser-private-${randomUUID()}`
      : `persist:pugport-browser-${createHash('sha256').update(context.conversationId).digest('hex').slice(0, 32)}`;
    const view = new WebContentsView({
      webPreferences: { partition, sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false },
    });
    const contents = view.webContents;
    if (context.incognito || !this.hardened.has(partition)) {
      if (!context.incognito) this.hardened.add(partition);
      contents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      contents.session.setPermissionCheckHandler(() => false);
      contents.session.webRequest.onBeforeRequest((details, callback) =>
        callback({ cancel: !browserRequestAllowed(details.url, this.port) }),
      );
      contents.session.on('will-download', (event) => event.preventDefault());
    }
    const browser: Browser = {
      owner,
      view,
      transient: context.incognito === true,
      snapshot: {
        id: randomUUID(),
        conversationId: context.conversationId,
        url: '',
        title: '',
        loading: false,
        canGoBack: false,
        canGoForward: false,
      },
    };
    const update = () => {
      if (!contents.isDestroyed()) this.send(owner, { kind: 'browser', browser: this.browserSnapshot(browser) });
    };
    const guard = (event: { preventDefault(): void }, url: string) => {
      try {
        browserUrl(url, this.port);
      } catch {
        event.preventDefault();
        browser.snapshot.error = '此地址无法在内置浏览器打开。';
        update();
      }
    };
    contents.on('will-navigate', guard);
    contents.on('will-redirect', guard);
    contents.setWindowOpenHandler(({ url }) => {
      try {
        void contents.loadURL(browserUrl(url, this.port)).catch(() => {});
      } catch {}
      return { action: 'deny' };
    });
    contents.on('did-start-loading', update);
    contents.on('did-stop-loading', update);
    contents.on('did-navigate', update);
    contents.on('did-navigate-in-page', update);
    contents.on('page-title-updated', update);
    contents.on('did-fail-load', (_event, code, _description, _url, mainFrame) => {
      if (mainFrame && code !== -3) {
        browser.snapshot.error = '网页加载失败，请检查地址后重试。';
        update();
      }
    });
    contents.on('render-process-gone', () => {
      browser.snapshot.error = '网页已停止，请刷新重试。';
      update();
    });
    contents.on('before-input-event', (event, input) => {
      if ((input.control || input.meta) && input.key.toLowerCase() === 'l') {
        event.preventDefault();
        this.send(owner, { kind: 'browser-address', id: browser.snapshot.id });
      }
    });
    owner.window.contentView.addChildView(view);
    view.setVisible(false);
    this.browsers.set(browser.snapshot.id, browser);
    return this.browserSnapshot(browser);
  }
  private async navigate(browser: Browser, command: unknown, url: unknown) {
    const contents = browser.view.webContents;
    browser.snapshot.error = undefined;
    if (command === 'navigate') {
      const target = browserUrl(url, this.port);
      void contents.loadURL(target).catch(() => {});
    } else if (command === 'back' && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
    else if (command === 'forward' && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
    else if (command === 'reload') contents.reload();
    else if (command === 'stop') contents.stop();
    else if (!['back', 'forward'].includes(String(command))) throw new Error('网页操作无效。');
    return this.browserSnapshot(browser);
  }
  private closeBrowser(browser: Browser) {
    this.browsers.delete(browser.snapshot.id);
    if (!browser.owner.window.isDestroyed()) browser.owner.window.contentView.removeChildView(browser.view);
    if (!browser.view.webContents.isDestroyed()) {
      const session = browser.view.webContents.session;
      browser.view.webContents.close();
      if (browser.transient) void session.clearStorageData().catch(() => {});
    }
  }
  private async chromeRequest(endpoint: string, path: string, json = true, signal?: AbortSignal): Promise<any> {
    const response = await this.request(endpoint + path, {
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(4000)]) : AbortSignal.timeout(4000),
    });
    if (!response.ok || !response.body)
      throw new Error('无法连接此 Chrome 调试地址。请先在 Chrome 中明确启用远程调试。');
    const reader = response.body.getReader();
    let text = '',
      bytes = 0;
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.length;
        if (bytes > 512 * 1024) throw new Error('Chrome 返回的数据过大。');
        text += decoder.decode(chunk.value, { stream: true });
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    text += decoder.decode();
    return json ? JSON.parse(text) : text;
  }
  private async chromeSnapshot(connection: Chrome): Promise<ChromeSnapshot> {
    const endpoint = connection.snapshot.endpoint;
    connection.abort.signal.throwIfAborted();
    const version = await this.chromeRequest(endpoint, '/json/version', true, connection.abort.signal);
    if (typeof version.Browser !== 'string' || !/(?:Chrome|Chromium)\//.test(version.Browser))
      throw new Error('此地址未返回 Chrome 调试接口。');
    const rows = await this.chromeRequest(endpoint, '/json/list', true, connection.abort.signal);
    if (!Array.isArray(rows)) throw new Error('Chrome 标签页列表无效。');
    const pages = rows
      .filter(
        (row) =>
          row?.type === 'page' &&
          typeof row.id === 'string' &&
          /^[\w-]{1,128}$/.test(row.id) &&
          typeof row.url === 'string',
      )
      .slice(0, 100)
      .map((row) => ({ id: row.id, title: String(row.title ?? '').slice(0, 500), url: row.url.slice(0, 8192) }));
    connection.abort.signal.throwIfAborted();
    if (!connection.owner.active || connection.generation !== connection.owner.generation)
      throw new Error('窗口已关闭。');
    connection.snapshot = { ...connection.snapshot, browser: version.Browser.slice(0, 100), pages };
    return { ...connection.snapshot };
  }
  private async connectChrome(owner: Owner, conversationId: unknown, value: unknown) {
    const context = await this.context(owner, conversationId);
    if (typeof value !== 'string') throw new Error('Chrome 地址无效。');
    const endpoint = chromeEndpoint(value);
    if (Number(new URL(endpoint).port) === this.port) throw new Error('不能连接 PugPort 的后台端口。');
    const previous = [...this.chrome.values()].find(
      (item) => item.owner === owner && item.conversationId === context.conversationId,
    );
    if (!previous && this.chrome.size >= 16) throw new Error('Chrome 连接数量已达上限。');
    const connection: Chrome = {
      owner,
      generation: owner.generation,
      abort: new AbortController(),
      conversationId: context.conversationId,
      snapshot: { id: randomUUID(), endpoint, browser: '', pages: [] },
    };
    const snapshot = await this.chromeSnapshot(connection);
    if (previous) {
      previous.abort.abort();
      this.chrome.delete(previous.snapshot.id);
    }
    this.chrome.set(snapshot.id, connection);
    return snapshot;
  }
  private releaseTools(owner: Owner) {
    for (const terminal of [...this.terminals.values()]) if (terminal.owner === owner) this.closeTerminal(terminal);
    for (const browser of [...this.browsers.values()]) if (browser.owner === owner) this.closeBrowser(browser);
    for (const [id, connection] of this.chrome)
      if (connection.owner === owner) {
        connection.abort.abort();
        this.chrome.delete(id);
      }
  }
  private releaseOwner(owner: Owner) {
    owner.active = false;
    this.releaseTools(owner);
    for (const [id, value] of this.owners) if (value === owner) this.owners.delete(id);
  }
  dispose() {
    for (const owner of this.owners.values()) this.releaseOwner(owner);
    ipcMain.removeHandler(DESKTOP_TOOLS_CHANNEL);
  }
}
