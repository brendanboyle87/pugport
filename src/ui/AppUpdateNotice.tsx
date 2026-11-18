import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import type { AppState } from '../shared/types';
import type { MacUpdateError, MacUpdateStatus } from '../shared/app-update';
import { desktopBridge } from './desktop';

const storageKey = 'pugport-dismissed-app-update';
const errorText: Record<MacUpdateError, string> = {
  network: '升级失败：无法连接更新服务器。',
  manifest: '升级失败：更新信息校验未通过。',
  download: '升级失败：下载没有完成。',
  checksum: '升级失败：更新包校验未通过。',
  package: '升级失败：更新包内容不正确。',
  install: '升级失败：无法替换当前应用，请手动下载。',
  'not-newer': '当前已是最新版本。',
};

/**
 * The Mac updater's status from the desktop app. `none` means no updater answers here (a browser tab, or a desktop
 * without one), so only the download link is offered; undefined means the first answer is still on its way.
 */
function useMacUpdate(enabled: boolean) {
  const bridge = enabled ? desktopBridge()?.appUpdate : undefined;
  const [status, setStatus] = useState<MacUpdateStatus | 'none'>();
  useEffect(() => {
    if (!bridge) return;
    let live = true;
    const stop = bridge.onStatus((next) => live && setStatus(next));
    bridge.status().then(
      (next) => live && setStatus(next),
      () => live && setStatus('none'),
    );
    return () => {
      live = false;
      stop();
    };
  }, [bridge]);
  if (!enabled) return undefined;
  return bridge && status !== 'none' ? (status ? { bridge, status } : undefined) : 'none';
}

/**
 * One notice, a path per platform: the Windows native updater pushes its downloaded update (`status`), a signed Mac
 * feed entry (`mac`) drives one-click install, and anything else is the plain release link.
 */
export function AppUpdateNotice({
  update: sourceUpdate,
  enabled = true,
}: {
  update?: AppState['appUpdate'];
  enabled?: boolean;
}) {
  const [nativeUpdate, setNativeUpdate] = useState<AppState['appUpdate']>();
  useEffect(() => desktopBridge()?.onAppUpdate?.(setNativeUpdate), []);
  const update = enabled ? (nativeUpdate ?? sourceUpdate) : undefined;
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(storageKey);
    } catch {
      return null;
    }
  });
  const mac = useMacUpdate(!!update?.mac);
  const busy = typeof mac === 'object' && mac.status.phase !== 'idle';
  if (!update || (dismissed === update.version && !busy)) return null;
  const dismiss = (
    <button
      type="button"
      className="icon-button"
      aria-label="关闭更新提醒"
      onClick={() => {
        setDismissed(update.version);
        try {
          localStorage.setItem(storageKey, update.version);
        } catch {
          /* Dismiss for this window. */
        }
      }}
    >
      <X size={13} />
    </button>
  );
  if (!update.mac)
    return (
      <div className="ui-update-notice app-update-notice" role="status">
        <span>
          {update.status === 'waiting'
            ? `任务结束后更新到 PugPort ${update.version}`
            : update.status === 'ready'
              ? `PugPort ${update.version} 已准备好`
              : `PugPort ${update.version} 已可用`}
        </span>
        {update.status !== 'waiting' && (
          <>
            <span aria-hidden="true"> · </span>
            {update.status === 'ready' ? (
              <button
                type="button"
                className="app-update-action"
                onClick={() =>
                  void desktopBridge()
                    ?.restartToUpdate?.()
                    .catch(() => {})
                }
              >
                重启更新
              </button>
            ) : (
              <a href={update.url} target="_blank" rel="noreferrer">
                更新说明
              </a>
            )}
          </>
        )}
        {dismiss}
      </div>
    );
  // The desktop updater answers within a moment; the plain link is for a Mac that cannot install in place.
  if (!mac) return null;
  const status = mac === 'none' ? undefined : mac.status;
  if (mac === 'none' || !status || !status.installable || (status.phase === 'error' && status.error === 'install'))
    return (
      <div className="ui-update-notice app-update-notice" role="status">
        <span>{status?.phase === 'error' ? errorText.install : `PugPort ${update.version} 已可用`}</span>
        <span aria-hidden="true"> · </span>
        <a href={update.url} target="_blank" rel="noreferrer">
          下载新版本
        </a>
        {dismiss}
      </div>
    );
  const { bridge } = mac;
  const version = status.version ?? update.version;
  const download = () => void bridge.download().catch(() => {});
  const percent = status.total ? Math.min(100, Math.floor(((status.received ?? 0) * 100) / status.total)) : 0;
  return (
    <div className="ui-update-notice app-update-notice mac-update-notice" role="status" aria-live="polite">
      {status.phase === 'idle' ? (
        <>
          <span>{`PugPort ${version} 已可用`}</span>
          <button type="button" className="button primary tiny" onClick={download}>
            升级
          </button>
          {dismiss}
        </>
      ) : status.phase === 'downloading' ? (
        <>
          <span>{`正在下载 PugPort ${version}…`}</span>
          <span className="mac-update-percent">{`${percent}%`}</span>
          <span className="mac-update-progress" aria-hidden="true">
            <span style={{ width: `${percent}%` }} />
          </span>
        </>
      ) : status.phase === 'verifying' ? (
        <span>正在校验更新…</span>
      ) : status.phase === 'ready' ? (
        <>
          <span>{`PugPort ${version} 已准备好`}</span>
          <button type="button" className="button primary tiny" onClick={() => void bridge.install().catch(() => {})}>
            重启并升级
          </button>
        </>
      ) : status.phase === 'installing' ? (
        <span>正在重启并升级…</span>
      ) : (
        <>
          <span>{errorText[status.error ?? 'download']}</span>
          {status.error !== 'not-newer' && (
            <button type="button" className="button tiny" onClick={download}>
              重试
            </button>
          )}
          {dismiss}
        </>
      )}
    </div>
  );
}
