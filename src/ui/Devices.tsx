import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Plus, Send, Trash2 } from 'lucide-react';
import { platformNames, type DeviceView, type DevicesView } from '../shared/devices';
import type { RemoteServersView } from '../shared/remote-servers';
import type { Api, Notice } from './Workspace';
import { SettingsGroup, SettingsRow } from './SettingsRow';
import { SettingsHeaderAction } from './SettingsShell';
import { confirmDialog } from './confirm-dialog';
import { desktopBridge } from './desktop';
import { withNames } from './i18n';

type Notify = (notice: Notice) => void;
export const failure = (error: unknown) => (error instanceof Error ? error.message : '操作没有完成，请重试。');

export async function sendFilesToDevice(api: Api, device: DeviceView): Promise<string[]> {
  const pick = desktopBridge()?.pickFiles;
  if (!pick) throw new Error('请在桌面应用中选择要发送的文件。');
  const paths = await pick();
  if (!paths.length) return [];
  const result = await api<{ files: { path: string }[] }>(`/api/devices/${encodeURIComponent(device.id)}/files`, {
    paths,
  });
  return result.files.map((file) => file.path);
}

/** The devices for the @@ list, asked only when the list opens (no check over the network). */
export function useDevices(api: Api, open: boolean) {
  const [devices, setDevices] = useState<DeviceView[]>([]);
  useEffect(() => {
    if (!open) return;
    let live = true;
    void Promise.resolve()
      .then(() => api<DevicesView>('/api/devices', undefined, 'GET'))
      .then((value) => {
        if (live && Array.isArray(value?.devices)) setDevices(value.devices);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [api, open]);
  return devices;
}

/** "在线 · Linux · 3 个执行器" or why it cannot be reached. */
export function deviceStatus(device: DeviceView): string {
  if (device.online === undefined) return '正在检查…';
  if (!device.online) return `连不上：${device.reason ?? '它可能关机或断网了'}`;
  const parts = ['在线'];
  if (device.platform) parts.push(platformNames[device.platform] ?? device.platform);
  if (device.executors) parts.push(device.executors.length ? `${device.executors.length} 个执行器` : '还没有执行器');
  if (device.running) parts.push(`${device.running} 个任务在运行`);
  return parts.join(' · ');
}

/** One line per executor on the device: "Claude B · 5h 80% · 周 62%". */
export function executorLine(executor: NonNullable<DeviceView['executors']>[number]): string {
  if (executor.status !== 'ready')
    return `${executor.label} · ${executor.status === 'auth-required' ? '要先登录' : '暂不可用'}`;
  const windows = executor.windows
    .map((window) => `${window.name} ${window.remaining === undefined ? '—' : `${window.remaining}%`}`)
    .join(' · ');
  return `${executor.label} · ${windows || '额度未知'}`;
}

/**
 * The 设备 category in Settings: the owner's other computers running PugPort as device nodes. Adding one
 * takes the address and the one-time code `pugport node pair` printed there.
 */
export function DevicesCard({ api, notify }: { api: Api; notify: Notify }) {
  const [view, setView] = useState<DevicesView>();
  const [servers, setServers] = useState<RemoteServersView['servers']>();
  const [loadError, setLoadError] = useState('');
  const [adding, setAdding] = useState(false);
  const [address, setAddress] = useState('');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState('');
  const [savedFiles, setSavedFiles] = useState<Record<string, string[]>>({});
  const sequence = useRef(0);
  const load = useCallback(
    async (refresh: boolean) => {
      const current = ++sequence.current;
      try {
        const next = await api<DevicesView>(`/api/devices${refresh ? '?refresh=1' : ''}`, undefined, 'GET');
        if (current === sequence.current) {
          setView(next);
          setLoadError('');
        }
      } catch (error) {
        if (current === sequence.current) setLoadError(failure(error));
        throw error;
      }
    },
    [api],
  );
  useEffect(() => {
    void load(false)
      .then(() => load(true))
      .catch(() => undefined);
    // Online state and quota change on their own; a look every 30 s while the card is open is enough.
    const timer = setInterval(() => void load(true).catch(() => undefined), 30_000);
    return () => {
      sequence.current++;
      clearInterval(timer);
    };
  }, [load]);
  useEffect(() => {
    let live = true;
    void Promise.resolve()
      .then(() => api<RemoteServersView>('/api/remote-servers', undefined, 'GET'))
      .then((value) => {
        if (live) setServers(value.servers ?? []);
      })
      .catch(() => {
        if (live) setServers([]);
      });
    return () => {
      live = false;
    };
  }, [api]);
  const run = async (key: string, work: () => Promise<void>) => {
    if (busy) return;
    setBusy(key);
    try {
      await work();
    } catch (error) {
      notify({ tone: 'error', message: failure(error) });
    } finally {
      setBusy('');
    }
  };
  const pair = () =>
    run('add', async () => {
      const next = await api<DevicesView>('/api/devices', {
        address: address.trim(),
        code: code.trim(),
        ...(name.trim() ? { name: name.trim() } : {}),
      });
      sequence.current++;
      setView(next);
      setLoadError('');
      setAdding(false);
      setAddress('');
      setCode('');
      setName('');
      notify({ tone: 'success', message: '已添加。在对话里输入 @@ 就能选它。' });
    });
  const remove = async (device: DeviceView) => {
    if (
      !(await confirmDialog({
        title: '移除设备「{0}」？',
        names: [device.name],
        summary: '它会忘掉这台电脑，再用时需要重新配对。',
        action: '移除设备',
        tone: 'danger',
      }))
    )
      return;
    return run(`remove:${device.id}`, async () => {
      const next = await api<DevicesView & { note?: string }>(
        `/api/devices/${encodeURIComponent(device.id)}`,
        undefined,
        'DELETE',
      );
      sequence.current++;
      setView(next);
      setLoadError('');
      notify(
        next.note
          ? { tone: 'info', message: next.note }
          : { tone: 'success', message: '已移除「{0}」。', names: [device.name] },
      );
    });
  };
  const sendFiles = (device: DeviceView) =>
    run(`files:${device.id}`, async () => {
      const paths = await sendFilesToDevice(api, device);
      if (paths.length) setSavedFiles((previous) => ({ ...previous, [device.id]: paths }));
    });
  const devices = view?.devices ?? [];
  const computers = devices.filter((device) => !device.tunnel);
  // Until the server list arrives no server is shown, so one with a card does not flash here first.
  const serversWithoutCard = devices.filter(
    (device) => device.tunnel && servers && !servers.some((server) => server.ssh === device.tunnel!.ssh),
  );
  return (
    <>
      <SettingsHeaderAction>
        <div className="external-agent-head">
          {!adding && (
            <button type="button" className="button secondary tiny" disabled={!!busy} onClick={() => setAdding(true)}>
              <Plus size={12} />
              添加设备
            </button>
          )}
        </div>
      </SettingsHeaderAction>
      <div className="devices">
        {adding && (
          <div className="external-agent-row device-add">
            <p className="device-hint">
              在那台电脑上运行 <code>pugport node pair</code>，它会显示地址和配对码。目前支持 Linux 和 macOS。
            </p>
            <div className="external-agent-fields">
              <label className="field">
                <span>设备地址</span>
                <input
                  aria-label="设备地址"
                  spellCheck={false}
                  placeholder="地址：100.x.x.x 或 Tailscale 里的名字"
                  value={address}
                  disabled={busy === 'add'}
                  onChange={(event) => setAddress(event.target.value)}
                />
              </label>
              <label className="field">
                <span>配对码</span>
                <input
                  aria-label="配对码"
                  spellCheck={false}
                  placeholder="配对码，例如 ABCD-EFGH"
                  value={code}
                  disabled={busy === 'add'}
                  autoComplete="off"
                  onChange={(event) => setCode(event.target.value)}
                />
              </label>
              <label className="field">
                <span>设备名字</span>
                <input
                  aria-label="设备名字"
                  placeholder="名字（可不填，用它的主机名）"
                  value={name}
                  maxLength={24}
                  disabled={busy === 'add'}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
            </div>
            <div className="external-agent-fields">
              <button
                type="button"
                className="button primary tiny"
                disabled={!!busy || !address.trim() || !code.trim()}
                onClick={() => void pair()}
              >
                {busy === 'add' && <Loader2 size={12} className="spinning" />}
                配对
              </button>
              <button
                type="button"
                className="button secondary tiny"
                disabled={busy === 'add'}
                onClick={() => setAdding(false)}
              >
                取消
              </button>
            </div>
          </div>
        )}
        {loadError && (
          <div className="inline-error" role="alert">
            读不到设备列表：{loadError}
            <button
              type="button"
              className="button secondary tiny"
              onClick={() => void load(true).catch(() => undefined)}
            >
              重试
            </button>
          </div>
        )}
        {!view && !loadError && (
          <p className="ext-loading" role="status">
            <Loader2 size={14} className="spinning" />
            正在加载…
          </p>
        )}
        {view && !loadError && !computers.length && !adding && <p className="device-hint">还没有添加设备。</p>}
        {[
          { title: '已添加的设备', devices: computers },
          { title: '服务器', devices: serversWithoutCard },
        ].map(
          (group) =>
            group.devices.length > 0 && (
              <SettingsGroup key={group.title} title={group.title}>
                {group.devices.map((device) => (
                  <SettingsRow
                    key={device.id}
                    title={<span translate="no">{device.name}</span>}
                    itemId={device.id}
                    status={device.online === undefined ? '正在检查…' : device.online ? '在线' : '连不上'}
                    tone={device.online ? 'live' : 'warning'}
                    control={
                      device.online ? (
                        <button
                          type="button"
                          className="button secondary tiny"
                          disabled={!!busy || !desktopBridge()?.pickFiles}
                          title={!desktopBridge()?.pickFiles ? '请在桌面应用中选择要发送的文件。' : undefined}
                          onClick={() => void sendFiles(device)}
                        >
                          {busy === `files:${device.id}` ? (
                            <Loader2 size={12} className="spinning" />
                          ) : (
                            <Send size={12} />
                          )}
                          发送文件…
                        </button>
                      ) : device.online === false ? (
                        <button
                          type="button"
                          className="button secondary tiny"
                          disabled={!!busy}
                          onClick={() => void load(true).catch(() => undefined)}
                        >
                          再试一次
                        </button>
                      ) : null
                    }
                    description={
                      <>
                        {device.online
                          ? [
                              device.platform ? (platformNames[device.platform] ?? device.platform) : '',
                              `${device.executors?.length ?? 0} 个 AI 可用`,
                              device.running ? `${device.running} 个任务在运行` : '',
                              device.allowWrite === true
                                ? '设备写入已开启'
                                : device.allowWrite === false
                                  ? '设备写入已关闭'
                                  : '',
                            ]
                              .filter(Boolean)
                              .join(' · ')
                          : (device.reason ?? '它可能关机或断网了。')}
                        {device.missingSsh && (
                          <p>
                            {withNames(
                              '这台电脑没有 SSH 别名 {0}，这台服务器也还没开通账号直连。在一台能 SSH 登录它的电脑上打开 PugPort，接入后会自动开通。',
                              [device.missingSsh],
                            )}
                          </p>
                        )}
                        {savedFiles[device.id]?.map((path) => (
                          <p key={path} className="device-saved-file" role="status">
                            {`已保存到 ${device.name}：`}
                            <code>{path}</code>
                          </p>
                        ))}
                      </>
                    }
                  >
                    <p>{deviceStatus(device)}</p>
                    <p>
                      地址 <code>{device.address}</code>
                    </p>
                    <button
                      type="button"
                      className="button quiet tiny"
                      aria-label={withNames('移除 {0}', [device.name])}
                      data-names
                      disabled={!!busy}
                      onClick={() => void remove(device)}
                    >
                      {busy === `remove:${device.id}` ? (
                        <Loader2 size={13} className="spinning" />
                      ) : (
                        <Trash2 size={13} />
                      )}
                      移除设备…
                    </button>
                    {device.online && device.executors?.length ? (
                      <ul className="device-executors">
                        {device.executors.map((executor) => (
                          <li key={executor.label}>{executorLine(executor)}</li>
                        ))}
                      </ul>
                    ) : null}
                  </SettingsRow>
                ))}
              </SettingsGroup>
            ),
        )}
      </div>
    </>
  );
}
