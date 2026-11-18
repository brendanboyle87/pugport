import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Mic } from 'lucide-react';
import { withNames } from '../i18n';
import { ModeIcon } from './mod-icons';
import type { ModManifestV2 } from '../../shared/mods-manifest';
import { buildModSrcDoc, createModNonce } from '../../shared/mod-client-shim';
import type { ModRunView } from '../../shared/conversation-modes';
import { createModHostBridge, modelEvent, type ModHostContext, type ModState } from './mod-host-bridge';
import type { ModSlot } from './mod-layout';
import { modTheme } from './use-mod-host';
import { markModLoaded, recordModDiagnostic, useModDebug } from './mod-debug-store';

export type ModFrameProps = {
  host: ModHostContext;
  slot: ModSlot;
  hidden: boolean;
  state?: ModState;
  messages: { count: number; lastId?: string };
  running: boolean;
  runs?: ModRunView[];
  chatOpen?: boolean;
  onOpenChat?(): void;
};

export function ModLoading({ title }: { title: string }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), 400);
    return () => clearTimeout(timer);
  }, []);
  return (
    <div className="mod-frame-loading" role="status" style={{ opacity: visible ? 1 : 0 }}>
      {visible && (
        <>
          <Loader2 size={16} className="spinning" aria-hidden="true" />
          <span>{withNames('正在打开「{0}」…', [title])}</span>
        </>
      )}
    </div>
  );
}

export function ModFailure({
  mode,
  onReload,
  onOpenChat,
  focusReload = false,
}: {
  mode?: Pick<ModManifestV2, 'title' | 'icon' | 'logo'>;
  onReload(): void;
  onOpenChat(): void;
  focusReload?: boolean;
}) {
  const reload = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (focusReload) reload.current?.focus();
  }, [focusReload]);
  return (
    <div className="mod-frame-error mod-frame-error-main" role="status">
      <ModeIcon mode={mode} size={32} />
      <h2>{withNames('「{0}」没能打开', [mode?.title ?? 'Mod'])}</h2>
      <p>聊天和保存的内容都还在。可以重新加载，或者先去聊天。</p>
      <div className="mod-frame-error-actions">
        <button ref={reload} type="button" className="button primary" onClick={onReload}>
          重新加载
        </button>
        <button type="button" className="button" onClick={onOpenChat}>
          打开聊天
        </button>
      </div>
    </div>
  );
}

export function ModFrame({
  host,
  slot,
  hidden,
  state,
  messages,
  running,
  runs,
  chatOpen = false,
  onOpenChat,
}: ModFrameProps) {
  const iframe = useRef<HTMLIFrameElement>(null);
  const bridge = useRef<ReturnType<typeof createModHostBridge> | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [reload, setReload] = useState(0);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [voice, setVoice] = useState<'gpt-live' | 'local'>();
  const [theme, setTheme] = useState(() => modTheme().theme);
  const focusReload = useRef(false);
  // Run results this frame already knew about when it connected are not delivered again.
  const seenRuns = useRef(new Map<string, string>());
  const contribution = host.manifest.contributions?.[slot];
  const entry = contribution?.kind === 'web' ? host.manifest.ui?.entries[contribution.entry] : undefined;
  const srcDoc = useMemo(
    () => (entry ? buildModSrcDoc(entry, createModNonce()) : ''),
    [host, entry?.html, entry?.css, entry?.js, reload],
  );
  const latest = useRef({ hidden, state, messages, running, chatOpen });
  latest.current = { hidden, state, messages, running, chatOpen };
  const fail = () => {
    if (host.isCurrent())
      recordModDiagnostic(host.conversationId, {
        level: 'error',
        source: 'host',
        text: 'The Mod frame did not open: it failed to load or did not answer within 10 seconds.',
        at: Date.now(),
      });
    focusReload.current = document.activeElement === iframe.current;
    clearTimeout(timer.current);
    bridge.current?.detach();
    bridge.current = undefined;
    setFailed(true);
    setLoading(false);
  };
  useEffect(() => {
    setFailed(false);
    setLoading(true);
    timer.current = setTimeout(fail, 10000);
    return () => {
      clearTimeout(timer.current);
      bridge.current?.detach();
      bridge.current = undefined;
    };
  }, [host, slot, srcDoc]);
  const events = () => {
    const value = latest.current;
    if (value.state) bridge.current?.emit('state', value.state);
    bridge.current?.emit('messages', value.messages);
    bridge.current?.emit('run', { running: value.running });
    bridge.current?.emit('visibility', { visible: !value.hidden });
    bridge.current?.emit('theme', modTheme());
    bridge.current?.emit('chat', { open: slot === 'mainView' && value.chatOpen && !value.hidden });
  };
  useEffect(events, [state, messages.count, messages.lastId, running, hidden, chatOpen]);
  // Debug › Reload frame reloads every frame of this chat, like the error screen's button.
  const reloads = useModDebug(host.conversationId).reloads;
  const seenReloads = useRef(reloads);
  useEffect(() => {
    if (reloads === seenReloads.current) return;
    seenReloads.current = reloads;
    setFailed(false);
    setReload((value) => value + 1);
  }, [reloads]);
  const latestRuns = useRef(runs);
  latestRuns.current = runs;
  useEffect(() => {
    for (const run of [...(runs ?? [])].reverse()) {
      if (seenRuns.current.get(run.id) === run.status) continue;
      seenRuns.current.set(run.id, run.status);
      if (run.status !== 'running') bridge.current?.emit('model', modelEvent(run));
    }
  }, [runs]);
  useEffect(() => {
    const observer = new MutationObserver(() => {
      const value = modTheme();
      setTheme(value.theme);
      bridge.current?.emit('theme', value);
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-accent', 'style'],
    });
    return () => observer.disconnect();
  }, []);
  function connect() {
    clearTimeout(timer.current);
    bridge.current?.detach();
    if (!iframe.current?.contentWindow || !host.isCurrent()) return fail();
    try {
      const channel = new MessageChannel();
      seenRuns.current = new Map((latestRuns.current ?? []).map((run) => [run.id, run.status]));
      bridge.current = createModHostBridge(
        {
          ...host,
          diagnostic: (entry) => recordModDiagnostic(host.conversationId, entry),
          info: () => ({
            ...host.info(),
            slot,
            layout: slot === 'mainView' ? 'workspace' : slot === 'sidebarPanel' ? 'sidebar' : 'panel',
          }),
        },
        { voiceChanged: setVoice },
      );
      bridge.current.connect(channel.port1);
      const receive = channel.port1.onmessage;
      channel.port1.onmessage = (event) => {
        if (event.data?.type === 'request' && event.data?.id === 'handshake' && event.data?.method === 'host.info') {
          clearTimeout(timer.current);
          setLoading(false);
          markModLoaded(host.conversationId, host.version);
        }
        receive?.call(channel.port1, event);
      };
      timer.current = setTimeout(fail, 10000);
      iframe.current.contentWindow.postMessage({ pugport: 2, type: 'connect' }, '*', [channel.port2]);
      setFailed(false);
      events();
    } catch {
      fail();
    }
  }
  return (
    <div className={`mod-frame mod-frame-${slot}`} hidden={hidden} aria-busy={loading}>
      {voice && !failed && (
        <div className="mod-voice-bar" role="status">
          <Mic size={14} aria-hidden="true" />
          <span>麦克风已开启</span>
          <span className="mod-voice-provider">{voice === 'gpt-live' ? 'GPT Live' : '本机'}</span>
          <button type="button" className="button secondary" onClick={() => bridge.current?.stopVoice()}>
            停止
          </button>
        </div>
      )}
      {loading && !failed && <ModLoading title={host.manifest.title} />}
      {failed ? (
        slot === 'mainView' ? (
          <ModFailure
            mode={host.manifest}
            focusReload={focusReload.current}
            onReload={() => {
              setFailed(false);
              setReload((value) => value + 1);
            }}
            onOpenChat={() => onOpenChat?.()}
          />
        ) : (
          <div className="mod-frame-error" role="status">
            <p>Mod 加载失败</p>
            <button
              className="button secondary"
              type="button"
              onClick={() => {
                setFailed(false);
                setReload((value) => value + 1);
              }}
            >
              重新加载
            </button>
          </div>
        )
      ) : (
        <iframe
          key={reload}
          ref={iframe}
          title={host.manifest.title}
          srcDoc={srcDoc}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'; display-capture 'none'; usb 'none'; serial 'none'; hid 'none'; bluetooth 'none'"
          onLoad={connect}
          onError={fail}
          style={{ opacity: loading ? 0 : 1, colorScheme: theme }}
        />
      )}
    </div>
  );
}
