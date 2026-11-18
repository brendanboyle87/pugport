import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Globe,
  Loader2,
  PenLine,
  RotateCw,
  Square,
  TerminalSquare,
  X,
} from 'lucide-react';
import { ImageViewer } from './ImageViewer';
import type { MarkupResult } from './ImageMarkup';
import { desktopBridge } from './desktop';
import { useUiUpdateBlocker } from './ui-update-guard';
import {
  chromeMcpConfiguration,
  type BrowserSnapshot,
  type ChromeSnapshot,
  type DesktopToolsApi,
  type DesktopToolsEvent,
  type DesktopToolsTab,
  type TerminalSnapshot,
  type PageCapture,
} from '../shared/desktop-tools';
import '@xterm/xterm/css/xterm.css';
import './ProjectTools.css';

type Props = {
  conversationId: string;
  initialTab?: DesktopToolsTab;
  visible?: boolean;
  onClose(): void;
  onMarkup?: (result: MarkupResult) => boolean | Promise<boolean>;
};
const message = (error: unknown) =>
  (error instanceof Error ? error.message : '操作失败，请重试。').replace(
    /^Error invoking remote method '[^']+': (?:Error: )?/,
    '',
  );

// The host coalesces concurrent opens. A replaced mount must not close the resource
// that its successor is still awaiting from that same open operation.
const toolClaims = new WeakMap<DesktopToolsApi, Map<string, symbol>>();
function claimTool(api: DesktopToolsApi, kind: 'terminal' | 'browser' | 'chrome', conversationId: string) {
  let claims = toolClaims.get(api);
  if (!claims) {
    claims = new Map();
    toolClaims.set(api, claims);
  }
  const key = `${kind}:${conversationId}`,
    token = Symbol(key);
  claims.set(key, token);
  return (release: () => void) => {
    if (claims.get(key) !== token) return;
    claims.delete(key);
    release();
  };
}

function LocalTerminal({ api, conversationId }: { api: DesktopToolsApi; conversationId: string }) {
  const element = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<TerminalSnapshot>();
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!element.current) return;
    const release = claimTool(api, 'terminal', conversationId);
    let disposed = false,
      session: TerminalSnapshot | undefined,
      sequence = 0;
    const queued: DesktopToolsEvent[] = [];
    const dark = document.documentElement.dataset.theme === 'dark';
    const terminal = new Terminal({
      cursorBlink: true,
      scrollback: 3000,
      fontSize: 13,
      fontFamily: '"JetBrains Mono Variable", monospace',
      theme: dark ? { background: '#15171b', foreground: '#e1e4ea' } : { background: '#fafbfc', foreground: '#20242c' },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(element.current);
    fit.fit();
    const fail = (reason: unknown) => {
      if (!disposed) setError(message(reason));
    };
    const consume = (event: DesktopToolsEvent) => {
      if (!session) {
        if (queued.length < 1000) queued.push(event);
        return;
      }
      if (event.kind === 'terminal-data' && event.id === session.id && event.sequence > sequence) {
        sequence = event.sequence;
        terminal.write(event.data);
      } else if (event.kind === 'terminal-exit' && event.id === session.id) {
        setState((current) => (current ? { ...current, exitCode: event.exitCode } : current));
      }
    };
    const unsubscribe = api.onEvent(consume);
    const input = terminal.onData((data) => {
      if (!session) return;
      // Bound each IPC packet while preserving bracketed paste and every byte in order.
      for (let start = 0; start < data.length;) {
        let end = Math.min(data.length, start + 32 * 1024);
        if (end < data.length && /[\uD800-\uDBFF]/.test(data[end - 1]!)) end++;
        void api.writeTerminal(session.id, data.slice(start, end)).catch(fail);
        start = end;
      }
    });
    const resize = new ResizeObserver(() => {
      if (!element.current?.clientWidth || !element.current.clientHeight) return;
      fit.fit();
      if (session && session.exitCode === undefined)
        void api.resizeTerminal(session.id, { cols: terminal.cols, rows: terminal.rows }).catch(fail);
    });
    resize.observe(element.current);
    setState(undefined);
    setError('');
    void api.openTerminal(conversationId, { cols: terminal.cols, rows: terminal.rows }).then(
      (value) => {
        if (disposed) {
          release(() => {
            void api.closeTerminal(value.id).catch(() => {});
          });
          return;
        }
        session = value;
        sequence = value.sequence;
        terminal.write(value.output);
        setState(value);
        for (const event of queued) consume(event);
        queued.length = 0;
        if (element.current?.getBoundingClientRect().width) terminal.focus();
      },
      (reason) => {
        release(() => {});
        fail(reason);
      },
    );
    return () => {
      disposed = true;
      unsubscribe();
      input.dispose();
      resize.disconnect();
      terminal.dispose();
      if (session)
        release(() => {
          void api.closeTerminal(session!.id).catch(() => {});
        });
    };
  }, [api, conversationId, attempt]);
  return (
    <div className="project-tool-terminal">
      <div className="project-tools-note">本机终端，与手动打开的系统终端拥有相同权限。输入和输出不会发送给 AI。</div>
      {state && (
        <div className="project-tool-path" title={state.directory}>
          {state.directory}
        </div>
      )}
      {!state && !error && (
        <div role="status">
          <Loader2 size={14} className="spinning" /> 正在打开终端…
        </div>
      )}
      {error && (
        <div className="inline-error" role="alert">
          {error}{' '}
          <button className="button tiny quiet" onClick={() => setAttempt((value) => value + 1)}>
            重试
          </button>
        </div>
      )}
      {state?.exitCode !== undefined && (
        <div role="status">
          终端已结束（{state.exitCode}）{' '}
          <button className="button tiny quiet" onClick={() => setAttempt((value) => value + 1)}>
            新建终端
          </button>
        </div>
      )}
      <div ref={element} className="project-terminal-surface" aria-label="本机交互终端" />
    </div>
  );
}

function LocalBrowser({
  api,
  conversationId,
  active,
  onMarkup,
}: {
  api: DesktopToolsApi;
  conversationId: string;
  active: boolean;
  onMarkup?: Props['onMarkup'];
}) {
  const host = useRef<HTMLDivElement>(null),
    addressInput = useRef<HTMLInputElement>(null);
  const session = useRef<string | undefined>(undefined);
  const activeRef = useRef(active);
  activeRef.current = active;
  const relayout = useRef<() => void>(() => {});
  const [browser, setBrowser] = useState<BrowserSnapshot>();
  const [capturing, setCapturing] = useState(false);
  const [capture, setCapture] = useState<{ id: string; name: string; page: PageCapture }>();
  const annotateButton = useRef<HTMLButtonElement>(null);
  const closeCapture = () => {
    setCapture(undefined);
    requestAnimationFrame(() => annotateButton.current?.focus());
  };
  const [address, setAddress] = useState('');
  const editingAddress = useRef(false);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let disposed = false;
    const release = claimTool(api, 'browser', conversationId);
    const snapshots: BrowserSnapshot[] = [];
    const update = (value: BrowserSnapshot) => {
      setBrowser(value);
      if (!editingAddress.current) setAddress(value.url === 'about:blank' ? '' : value.url);
    };
    const unsubscribe = api.onEvent((event) => {
      if (event.kind === 'browser' && event.browser.conversationId === conversationId) {
        if (!session.current) snapshots.push(event.browser);
        else if (event.browser.id === session.current) update(event.browser);
      } else if (event.kind === 'browser-address' && event.id === session.current) {
        addressInput.current?.focus();
        addressInput.current?.select();
      }
    });
    const layout = () => {
      if (!session.current || !host.current) return;
      const hidden =
        !activeRef.current ||
        document.visibilityState === 'hidden' ||
        !!document.querySelector('dialog[open], [aria-modal="true"], [role="menu"]');
      const rect = host.current.getBoundingClientRect();
      void api
        .browserBounds(
          session.current,
          hidden || !rect.width || !rect.height
            ? null
            : { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        )
        .catch(() => {});
    };
    relayout.current = layout;
    const resize = new ResizeObserver(layout),
      overlays = new MutationObserver(layout);
    if (host.current) resize.observe(host.current);
    overlays.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['open', 'aria-modal', 'role'],
    });
    window.addEventListener('resize', layout);
    window.addEventListener('scroll', layout, true);
    document.addEventListener('visibilitychange', layout);
    setBrowser(undefined);
    setCapture(undefined);
    setCapturing(false);
    setError('');
    void api.openBrowser(conversationId).then(
      (value) => {
        if (disposed) {
          release(() => {
            void api.closeBrowser(value.id).catch(() => {});
          });
          return;
        }
        session.current = value.id;
        update(value);
        for (const snapshot of snapshots) if (snapshot.id === value.id) update(snapshot);
        layout();
      },
      (reason) => {
        release(() => {});
        if (!disposed) setError(message(reason));
      },
    );
    return () => {
      disposed = true;
      unsubscribe();
      resize.disconnect();
      overlays.disconnect();
      window.removeEventListener('resize', layout);
      window.removeEventListener('scroll', layout, true);
      document.removeEventListener('visibilitychange', layout);
      const id = session.current;
      session.current = undefined;
      if (id) {
        release(() => {
          void api.browserBounds(id, null).catch(() => {});
          void api.closeBrowser(id).catch(() => {});
        });
      }
    };
  }, [api, conversationId, attempt]);
  useEffect(() => {
    relayout.current();
  }, [active]);
  const act = async (action: 'navigate' | 'back' | 'forward' | 'reload' | 'stop') => {
    if (!browser) return;
    setError('');
    try {
      let url = address.trim();
      if (action === 'navigate' && !/^[a-z][a-z0-9+.-]*:/i.test(url)) url = `https://${url}`;
      editingAddress.current = false;
      setBrowser(await api.browserAction(browser.id, action, action === 'navigate' ? url : undefined));
    } catch (reason) {
      setError(message(reason));
    }
  };
  const annotate = async () => {
    if (!browser || capturing) return;
    const id = browser.id;
    setCapturing(true);
    setError('');
    try {
      const page = await api.browserCapture(id);
      if (session.current === id && activeRef.current)
        setCapture({ id, name: page.title || new URL(page.url).hostname, page });
    } catch (reason) {
      if (session.current === id) setError(message(reason));
    } finally {
      if (session.current === id) setCapturing(false);
    }
  };
  return (
    <div className="project-tool-browser">
      <form
        className="project-browser-navigation"
        onSubmit={(event) => {
          event.preventDefault();
          void act('navigate');
        }}
      >
        <button
          className="icon-button"
          type="button"
          aria-label="后退"
          disabled={!browser?.canGoBack}
          onClick={() => void act('back')}
        >
          <ArrowLeft size={16} />
        </button>
        <button
          className="icon-button"
          type="button"
          aria-label="前进"
          disabled={!browser?.canGoForward}
          onClick={() => void act('forward')}
        >
          <ArrowRight size={16} />
        </button>
        <button
          className="icon-button"
          type="button"
          aria-label={browser?.loading ? '停止加载' : '刷新网页'}
          disabled={!browser}
          onClick={() => void act(browser?.loading ? 'stop' : 'reload')}
        >
          {browser?.loading ? <Square size={14} /> : <RotateCw size={15} />}
        </button>
        <input
          ref={addressInput}
          aria-label="网页地址"
          placeholder="输入网页地址"
          value={address}
          onFocus={() => {
            editingAddress.current = true;
          }}
          onChange={(event) => setAddress(event.target.value)}
        />
        <button className="button tiny secondary" type="submit" disabled={!browser || !address.trim()}>
          打开
        </button>
        {onMarkup && (
          <button
            className="button tiny secondary"
            type="button"
            disabled={!browser?.url || browser.url === 'about:blank' || browser.loading || !!browser.error || capturing}
            ref={annotateButton}
            onClick={() => void annotate()}
          >
            <PenLine size={13} />
            标注
          </button>
        )}
      </form>
      <div className="project-tools-note">
        独立浏览资料，仅用于此对话；隐身对话使用临时资料。网站不能访问 PugPort 后台或本机文件；下载和设备权限未开放。
      </div>
      {(error || browser?.error) && (
        <div className="inline-error" role="alert">
          {error || browser?.error}
          {!browser && (
            <button className="button tiny quiet" onClick={() => setAttempt((value) => value + 1)}>
              重试
            </button>
          )}
        </div>
      )}
      <div className="project-browser-surface" ref={host} aria-label="内置网页区域">
        {!browser ? <span>正在准备浏览器…</span> : !browser.url && <span>输入地址，开始浏览。</span>}
      </div>
      {capture && (
        <ImageViewer
          images={[{ src: capture.page.dataUrl, name: capture.name }]}
          index={0}
          onIndex={() => {}}
          onClose={closeCapture}
          markup={{
            kind: 'page',
            immediate: true,
            page: {
              url: capture.page.url,
              title: capture.page.title,
              viewport: capture.page.viewport,
              elementAt: (point) => api.browserElement(capture.id, point),
              textIn: (rect) => api.browserText(capture.id, rect),
            },
            onAdd: async (result) => {
              const ok = (await onMarkup?.(result)) ?? false;
              if (ok) closeCapture();
              return ok;
            },
          }}
        />
      )}
    </div>
  );
}

function ChromeConnection({ api, conversationId }: { api: DesktopToolsApi; conversationId: string }) {
  const [endpoint, setEndpoint] = useState('http://127.0.0.1:9222');
  const [connection, setConnection] = useState<ChromeSnapshot>();
  const current = useRef<ChromeSnapshot | undefined>(undefined);
  const releaseConnection = useRef<ReturnType<typeof claimTool> | undefined>(undefined);
  const pending = useRef(false);
  const live = useRef(true);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [configuration, setConfiguration] = useState('');
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      if (current.current)
        releaseConnection.current?.(() => {
          void api.disconnectChrome(current.current!.id).catch(() => {});
        });
    };
  }, [api]);
  const run = async (operation: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      await operation();
    } catch (reason) {
      if (live.current) setError(message(reason));
    } finally {
      pending.current = false;
      if (live.current) setBusy(false);
    }
  };
  const connected = (value: ChromeSnapshot) => {
    if (!live.current) {
      releaseConnection.current?.(() => {
        void api.disconnectChrome(value.id).catch(() => {});
      });
      return;
    }
    current.current = value;
    setConnection(value);
  };
  return (
    <div className="project-tool-chrome">
      <p>连接你已明确开启远程调试的本机 Chrome。这里只列出和切换标签页，不启动 Chrome，也不读取浏览器资料文件。</p>
      <form
        className="project-chrome-connect"
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            releaseConnection.current = claimTool(api, 'chrome', conversationId);
            try {
              connected(await api.connectChrome(conversationId, endpoint));
            } catch (error) {
              releaseConnection.current(() => {});
              throw error;
            }
          });
        }}
      >
        <label className="field">
          <span>Chrome 调试地址</span>
          <input
            value={endpoint}
            onChange={(event) => setEndpoint(event.target.value)}
            disabled={busy || !!connection}
          />
        </label>
        <button className="button secondary" disabled={busy || !!connection} type="submit">
          {busy && <Loader2 size={14} className="spinning" />}连接 Chrome
        </button>
      </form>
      {error && (
        <div className="inline-error" role="alert">
          {error}
        </div>
      )}
      {!connection && (
        <p className="project-tools-note">
          需要已经运行的 Chrome 调试服务，例如本机 9222 端口。未启用时会明确报告连接失败，不会替你修改 Chrome 启动参数。
        </p>
      )}
      {connection && (
        <>
          <div className="project-chrome-status" role="status">
            <span>
              {error ? '上次连接' : '已连接'} · {connection.browser}
            </span>
            <div>
              <button
                className="button tiny quiet"
                disabled={busy}
                onClick={() => void run(async () => connected(await api.refreshChrome(connection.id)))}
              >
                刷新标签页
              </button>
              <button
                className="button tiny quiet"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await api.disconnectChrome(connection.id);
                    releaseConnection.current?.(() => {});
                    current.current = undefined;
                    setConnection(undefined);
                  })
                }
              >
                断开
              </button>
            </div>
          </div>
          <ul className="project-chrome-pages">
            {connection.pages.map((page) => (
              <li key={page.id}>
                <div>
                  <strong>{page.title || '无标题页面'}</strong>
                  <span title={page.url}>{page.url}</span>
                </div>
                <button
                  className="button tiny secondary"
                  disabled={busy}
                  onClick={() => void run(() => api.activateChrome(connection.id, page.id))}
                >
                  切换到此页
                  <ExternalLink size={13} />
                </button>
              </li>
            ))}
          </ul>
          {!connection.pages.length && <p>没有可切换的网页标签页。</p>}
        </>
      )}
      <details className="project-chrome-mcp">
        <summary>让 AI 使用 Chrome 的连接配置</summary>
        <p>
          查看并复制官方 Chrome DevTools MCP 配置，再到“扩展 → 连接与服务”导入和授权。这里的连接不会自动授予 AI
          权限；启用范围仍由项目和扩展权限决定。
        </p>
        <button
          className="button tiny secondary"
          onClick={() => {
            try {
              setConfiguration(chromeMcpConfiguration(endpoint));
              setError('');
            } catch (reason) {
              setError(message(reason));
            }
          }}
        >
          查看配置
        </button>
        {configuration && (
          <>
            <textarea aria-label="Chrome MCP 配置" readOnly value={configuration} rows={9} />
            <button
              className="button tiny secondary"
              onClick={() =>
                void navigator.clipboard.writeText(configuration).catch((reason) => setError(message(reason)))
              }
            >
              复制配置
            </button>
          </>
        )}
        <button
          className="button tiny quiet"
          onClick={() => window.dispatchEvent(new CustomEvent('pugport:open-extensions'))}
        >
          打开连接与服务
        </button>
      </details>
    </div>
  );
}

/** Hidden panels keep their processes; unmounting explicitly closes the owned resources. */
export function ProjectTools({ conversationId, initialTab = 'terminal', visible = true, onClose, onMarkup }: Props) {
  const [tab, setTab] = useState<DesktopToolsTab>(initialTab);
  const [visited, setVisited] = useState<DesktopToolsTab[]>([initialTab]);
  const api = desktopBridge()?.projectTools;
  useUiUpdateBlocker(() => true, 'desktop-tools');
  return (
    <section
      className="project-tools"
      aria-label="桌面工具"
      data-ui-update-block="true"
      hidden={!visible}
      style={visible ? undefined : { display: 'none' }}
    >
      <header>
        <div role="tablist" aria-label="桌面工具类型">
          {(
            [
              ['terminal', '终端', TerminalSquare],
              ['browser', '浏览器', Globe],
              ['chrome', 'Chrome', ExternalLink],
            ] as const
          ).map(([value, title, Icon]) => (
            <button
              key={value}
              role="tab"
              aria-selected={tab === value}
              className={tab === value ? 'active' : ''}
              onClick={() => {
                setTab(value);
                setVisited((current) => (current.includes(value) ? current : [...current, value]));
              }}
            >
              <Icon size={15} />
              {title}
            </button>
          ))}
        </div>
        <button
          className="icon-button"
          aria-label="关闭工具面板"
          title="关闭工具面板会结束其中的终端"
          onClick={onClose}
        >
          <X size={17} />
        </button>
      </header>
      {!api ? (
        <p className="project-tools-unavailable">请使用支持桌面工具的 PugPort 桌面版。</p>
      ) : (
        visited.map((value) => (
          <div
            className="project-tools-content"
            role="tabpanel"
            key={`${conversationId}:${value}`}
            hidden={tab !== value}
          >
            {value === 'terminal' ? (
              <LocalTerminal api={api} conversationId={conversationId} />
            ) : value === 'browser' ? (
              <LocalBrowser
                api={api}
                conversationId={conversationId}
                active={visible && tab === 'browser'}
                onMarkup={onMarkup}
              />
            ) : (
              <ChromeConnection api={api} conversationId={conversationId} />
            )}
          </div>
        ))
      )}
    </section>
  );
}
