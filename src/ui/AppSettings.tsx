import { ReportProblemAction } from './ProblemReport';
import { useEffect, useRef, useState } from 'react';
import { SettingsGroup, SettingsRow } from './SettingsRow';
import { QuickChatSettingsSection } from './QuickChatSettings';
import { FolderOpen, RefreshCw } from 'lucide-react';
import { desktopBridge } from './desktop';
import type { Api } from './Workspace';
import type { AppState } from '../shared/types';
import { diagnosticInput } from '../shared/diagnostics';
import { copyDiagnosticInfo } from './diagnostics';

type Notify = (notice: { tone: 'success' | 'error' | 'info'; message: string }) => void;
type AppInfo = {
  paths: { dataDir: string; memoryDir: string };
  tools: {
    ripgrep: boolean;
    markitdown: boolean;
    voice: boolean;
    images?: { model: boolean; analyzed: number; working: boolean; gpu?: boolean };
    memory?: { model: boolean; passages: number; working?: boolean };
  };
};
const message = (error: unknown) => (error instanceof Error ? error.message : '操作失败');

function useAppInfo(api: Api) {
  const [info, setInfo] = useState<AppInfo>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const sequence = useRef(0);
  const load = async () => {
    const current = ++sequence.current;
    setLoading(true);
    setError('');
    try {
      const value = await api<AppInfo>('/api/app-info', undefined, 'GET');
      if (current === sequence.current) setInfo(value);
    } catch (failure) {
      if (current === sequence.current) setError(message(failure));
    } finally {
      if (current === sequence.current) setLoading(false);
    }
  };
  useEffect(() => {
    void load();
    return () => {
      sequence.current++;
    };
  }, [api]);
  return { info, loading, error, load };
}

function AppInfoStatus({ loading, error, retry }: { loading: boolean; error: string; retry: () => Promise<void> }) {
  if (error)
    return (
      <div className="inline-error" role="alert">
        状态读取失败：{error}
        <button type="button" className="button tiny secondary" onClick={() => void retry()}>
          <RefreshCw size={12} />
          重试
        </button>
      </div>
    );
  return loading ? (
    <p className="quiet-text" role="status">
      正在读取本机状态…
    </p>
  ) : null;
}

/** Desktop behaviour and where the app keeps its data. */
export function AppSection({
  api,
  notify,
  children,
  state,
  updateCheck,
  updatePending,
  onUpdateCheck,
}: {
  api: Api;
  notify: Notify;
  children?: React.ReactNode;
  state: Pick<AppState, 'app' | 'runtimes'>;
  updateCheck: boolean;
  updatePending: boolean;
  onUpdateCheck: (value: boolean) => void;
}) {
  const bridge = desktopBridge();
  const [atLogin, setAtLogin] = useState<boolean>();
  const [blackoutShortcut, setBlackoutShortcut] = useState('Ctrl+Alt+B');
  const [shortcutPending, setShortcutPending] = useState(false);
  const savingShortcut = useRef(false);
  useEffect(() => {
    void bridge?.launchAtLogin?.().then(setAtLogin);
    void bridge
      ?.blackoutShortcut?.()
      .then((value) => setBlackoutShortcut(value.shortcut))
      .catch((error) => notify({ tone: 'error', message: message(error) }));
  }, []);
  const saveBlackoutShortcut = async () => {
    if (!bridge?.blackoutShortcut || savingShortcut.current) return;
    savingShortcut.current = true;
    setShortcutPending(true);
    try {
      const result = await bridge.blackoutShortcut(blackoutShortcut);
      setBlackoutShortcut(result.shortcut);
    } catch (error) {
      notify({ tone: 'error', message: message(error) });
    } finally {
      savingShortcut.current = false;
      setShortcutPending(false);
    }
  };
  return (
    <SettingsGroup id="settings-app" title="这台电脑">
      {bridge?.launchAtLogin && (
        <SettingsRow
          title="开机时启动"
          description="登录后自动打开 PugPort。"
          control={
            <label className="switch">
              <input
                type="checkbox"
                aria-label="开机时启动"
                checked={!!atLogin}
                onChange={(event) => void bridge.launchAtLogin!(event.target.checked).then(setAtLogin)}
              />
              <span />
            </label>
          }
        />
      )}
      {bridge?.blackout && bridge.blackoutShortcut && (
        <SettingsRow
          title="黑屏"
          description="屏幕显示全黑并保持唤醒；按任意键恢复。"
          control={
            <button
              type="button"
              className="button secondary"
              onClick={() =>
                void bridge.blackout!().catch((error) => notify({ tone: 'error', message: message(error) }))
              }
            >
              立即黑屏
            </button>
          }
        >
          <label className="field">
            <span>黑屏快捷键</span>
            <div className="setting-control">
              <input
                id="blackout-shortcut"
                aria-label="黑屏快捷键"
                value={blackoutShortcut}
                disabled={shortcutPending}
                spellCheck={false}
                onChange={(event) => setBlackoutShortcut(event.target.value)}
                onBlur={() => void saveBlackoutShortcut()}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void saveBlackoutShortcut();
                  }
                }}
              />
            </div>
          </label>
        </SettingsRow>
      )}
      {bridge?.quickChatSettings && <QuickChatSettingsSection bridge={bridge} />}
      {children}
      <SettingsRow title="帮助" control={<ReportProblemAction />} />
      <SettingsRow
        title="检查新版本"
        description="PugPort 每天向 GitHub 查询一次最新版本号。"
        control={
          <label className="switch">
            <input
              type="checkbox"
              aria-label="检查新版本"
              checked={updateCheck}
              disabled={updatePending}
              onChange={(event) => onUpdateCheck(event.target.checked)}
            />
            <span />
          </label>
        }
      />
      <SettingsRow
        title={<span translate="no">{`PugPort ${state.app.version} · ${state.app.commit ?? 'dev'}`}</span>}
        control={
          <button
            type="button"
            className="button secondary"
            onClick={() => void copyDiagnosticInfo(diagnosticInput(state), notify)}
          >
            复制诊断信息
          </button>
        }
      />
    </SettingsGroup>
  );
}

export function SettingsFolder({ api, notify, kind }: { api: Api; notify: Notify; kind: 'data' | 'memory' }) {
  const { info, loading, error, load } = useAppInfo(api);
  const path = kind === 'data' ? info?.paths.dataDir : info?.paths.memoryDir;
  return (
    <section className="panel settings-section">
      <AppInfoStatus loading={loading} error={error} retry={load} />
      <div className="setting-row">
        <span className="setting-label">{kind === 'data' ? '数据目录' : '对话记忆'}</span>
        <div className="setting-control">
          <code className="setting-path" title={path}>
            {path ?? '…'}
          </code>
          <button
            type="button"
            className="button secondary"
            disabled={!path}
            onClick={() =>
              void api('/api/open-folder', { kind }).catch((error) =>
                notify({ tone: 'error', message: message(error) }),
              )
            }
          >
            <FolderOpen size={13} />
            打开
          </button>
        </div>
      </div>
    </section>
  );
}
