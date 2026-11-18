import { useEffect, useRef, useState } from 'react';
import { Loader2, Send } from 'lucide-react';
import {
  remoteServerExpiry,
  type RemoteServer,
  type RemoteServerExpiry,
  type RemoteServerLive,
  type RemoteServerView,
  type RemoteServersView,
  type InstaboxMachineView,
} from '../shared/remote-servers';
import { dateLabel } from './App';
import { deviceBytes, DeviceQuotaChips } from './DeviceUsage';
import { EvenCards } from './QuotaZoom';
import type { Api, Notice } from './Workspace';
import { failure, sendFilesToDevice } from './Devices';
import { desktopBridge } from './desktop';
import { withNames } from './i18n';
import type { DeviceView, DevicesView } from '../shared/devices';
import { ServerEnroll, EnrollmentStatus, type Enrollment } from './ServerEnroll';
import { ConfirmDialog } from './ConfirmDialog';

export function remoteServerExpiryLabel(expiry: RemoteServerExpiry): string {
  if (expiry.state === 'unknown') return '到期日未记录';
  if (expiry.days < 0) return '已到期';
  if (expiry.days === 0) return '今天到期';
  // Its own literal, so the catalog gets a singular entry.
  return expiry.days === 1 ? '还剩 1 天' : `还剩 ${expiry.days} 天`;
}

const share = (used?: number, total?: number) =>
  used !== undefined && total ? Math.max(0, Math.min(100, (used / total) * 100)) : undefined;
const gib = (value: number) => Number((value / 1024 ** 3).toFixed(1));
const serviceStates: Record<string, { label: string; tone: string }> = {
  active: { label: '运行中', tone: 'healthy' },
  inactive: { label: '已停止', tone: 'unknown' },
  failed: { label: '失败', tone: 'danger' },
};

/** The device card's resource cells, with the root disk in place of the GPU. */
function LiveReadings({ live, metricsOnly = false }: { live?: RemoteServerLive; metricsOnly?: boolean }) {
  const online = live?.online === true;
  const memoryUsed =
    live?.memoryTotal !== undefined && live.memoryAvailable !== undefined
      ? Math.max(0, live.memoryTotal - live.memoryAvailable)
      : undefined;
  const diskUsed =
    live?.diskTotal !== undefined && live.diskFree !== undefined
      ? Math.max(0, live.diskTotal - live.diskFree)
      : undefined;
  const items = [
    {
      id: 'cpu',
      name: 'CPU',
      value: online ? live.cpuPercent : undefined,
      detail:
        [live?.cores ? withNames('{0} 核', [String(live.cores)]) : '', live?.arch].filter(Boolean).join(' · ') || '—',
    },
    {
      id: 'memory',
      name: '内存',
      value: online ? share(memoryUsed, live.memoryTotal) : undefined,
      detail:
        memoryUsed !== undefined && live?.memoryTotal
          ? `${gib(Math.min(memoryUsed, live.memoryTotal))} / ${gib(live.memoryTotal)} GiB`
          : '—',
    },
    {
      id: 'disk',
      name: '磁盘',
      value: online ? share(diskUsed, live.diskTotal) : undefined,
      detail:
        live?.diskTotal !== undefined && live.diskFree !== undefined
          ? withNames('{0} 可用 / {1}', [deviceBytes(live.diskFree), deviceBytes(live.diskTotal)])
          : '—',
    },
  ];
  return (
    <div className="remote-server-live" style={online ? undefined : { opacity: 0.55 }}>
      <div className="device-resources">
        {items
          .filter((item) => !metricsOnly || (item.id !== 'disk' && item.value !== undefined))
          .map(({ id, name, value, detail }) => (
            <div className="device-resource" data-resource={id} key={id}>
              <div className="device-resource-label quota-window-heading">
                <span>{name}</span>
                <strong>{value === undefined ? '—' : `${Math.round(value)}%`}</strong>
              </div>
              <div
                className="device-resource-bar"
                role={value === undefined ? undefined : 'progressbar'}
                aria-label={name}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={value}
              >
                <i style={{ width: `${value ?? 0}%` }} />
              </div>
              <small title={detail} translate="no">
                {detail}
              </small>
            </div>
          ))}
      </div>
      {!!live?.services?.length && (
        <div className="device-quota-chips">
          {live.services.map((service, index) => {
            const state = serviceStates[service.state];
            return (
              <span key={index} className={`device-quota-chip ${state?.tone ?? 'warning'}`} title={service.state}>
                <span translate="no">{service.name}</span> {state?.label ?? service.state}
              </span>
            );
          })}
        </div>
      )}
      {live?.status && (
        <p className="remote-server-status" translate="no" title={live.status}>
          {live.status}
        </p>
      )}
    </div>
  );
}

/** A paired server without the account's access key, on a computer that sets it up with its own SSH. */
function AccessUpgrade({ upgrade }: { upgrade: NonNullable<DeviceView['accessUpgrade']> }) {
  return (
    <p className="remote-server-reason" role="status" title={upgrade.reason}>
      {upgrade.state === 'running'
        ? '正在开通账号直连…'
        : upgrade.state === 'failed'
          ? withNames('账号直连没开通成功，稍后自动重试：{0}', [upgrade.reason ?? ''])
          : '还没开通账号直连：这台电脑会自动开通，之后登录同一账号的电脑不用配 SSH 也能用它。'}
    </p>
  );
}

function LiveState({ server }: { server: RemoteServerView }) {
  if (server.missingSsh) return null;
  const live = server.live;
  if (!server.ssh) return null;
  if (!live) return <span className="device-status">正在检查…</span>;
  return (
    <span className="remote-server-state" title={live.reason}>
      <span className={`device-status ${live.online ? 'online' : ''}`}>{live.online ? '在线' : '离线'}</span>
      {(live.online || live.lastSeenAt) && (
        <time dateTime={live.online ? live.checkedAt : live.lastSeenAt} translate="no">
          {dateLabel(live.online ? live.checkedAt : live.lastSeenAt)}
        </time>
      )}
    </span>
  );
}

export function RemoteServerCard({
  api,
  notify,
  server,
  now,
  device,
  onConnect,
  onDisconnect,
  retry,
  onRetry,
  disconnecting = false,
  enrollment,
  machine,
  busy,
  onInstaboxAction,
  onMachineConnect,
  onMachineDisconnect,
}: {
  api: Api;
  notify: (notice: Notice) => void;
  server: RemoteServerView;
  now: number;
  device?: DeviceView;
  onConnect?: (server: RemoteServerView & { ssh: string }) => void;
  onDisconnect?: (server: RemoteServerView & { ssh: string }) => void;
  retry?: { message: string; purge: boolean };
  onRetry?: () => void;
  disconnecting?: boolean;
  enrollment?: Enrollment;
  machine?: InstaboxMachineView;
  busy?: string;
  onInstaboxAction?: (machine: InstaboxMachineView, action: 'pause' | 'resume') => void;
  onMachineConnect?: (machine: InstaboxMachineView) => void;
  onMachineDisconnect?: (machine: InstaboxMachineView) => void;
}) {
  const [sending, setSending] = useState(false);
  const sendFiles = async () => {
    if (!device || sending || disconnecting) return;
    setSending(true);
    try {
      const paths = await sendFilesToDevice(api, device);
      if (paths.length)
        notify({ tone: 'success', message: '已保存到「{0}」：{1}', names: [server.name, paths.join('\n')] });
    } catch (error) {
      notify({ tone: 'error', message: failure(error) });
    } finally {
      setSending(false);
    }
  };
  if (machine) {
    const pending = machine.pendingAction;
    const knownState = Object.hasOwn(instaboxStates, machine.state);
    const state = pending
      ? pending === 'pause'
        ? '正在暂停…'
        : '正在恢复…'
      : knownState
        ? instaboxStates[machine.state]
        : machine.state;
    const until = Date.parse(machine.runStartedAt ?? '') + (machine.maxRunMinutes ?? 0) * 60_000;
    const maxRun =
      machine.state === 'running' &&
      !pending &&
      Number.isFinite(until) &&
      (machine.maxRunMinutes ?? 0) > 0 &&
      Number.isFinite(new Date(until).getTime());
    const spec = [
      machine.spec?.vcpus !== undefined ? `${machine.spec.vcpus} vCPU` : '',
      machine.spec?.memMiB !== undefined ? `${machine.spec.memMiB / 1024} GiB` : '',
      machine.spec?.persistentDiskGiB !== undefined
        ? withNames('持久盘 {0} GiB', [String(machine.spec.persistentDiskGiB)])
        : '',
    ]
      .filter(Boolean)
      .join(' · ');
    const action = machine.state === 'running' ? 'pause' : machine.state === 'paused' ? 'resume' : undefined;
    return (
      <article
        className="quota-card compact-quota-card remote-server-card unknown"
        data-runtime-id={device?.id}
        tabIndex={device ? 0 : undefined}
        aria-label={device ? withNames('{0} 详情', [device.name]) : undefined}
      >
        <div className="quota-heading">
          <h3 translate="no" title={machine.name}>
            {machine.name}
          </h3>
          <span className="plan-badge" translate="no">
            instabox
          </span>
          <span
            className={`plan-badge remote-server-expiry instabox-state ${pending ? 'changing' : machine.state}`}
            translate={knownState || pending ? undefined : 'no'}
          >
            {state}
          </span>
        </div>
        <div className="quota-body">
          {onMachineConnect && !device && (
            <button type="button" className="button secondary" onClick={() => onMachineConnect(machine)}>
              接入
            </button>
          )}
          {device && (
            <div className="remote-server-connection">
              <span>已接入</span>
              <button
                type="button"
                className="button secondary tiny"
                disabled={disconnecting}
                onClick={() => onMachineDisconnect?.(machine)}
              >
                断开
              </button>
              {device.online === true && machine.state === 'running' && !machine.stale && !pending && (
                <button
                  type="button"
                  className="icon-button tiny"
                  title="发送文件…"
                  aria-label="发送文件…"
                  disabled={sending || disconnecting || !desktopBridge()?.pickFiles}
                  onClick={() => void sendFiles()}
                >
                  {sending ? <Loader2 size={14} className="spinning" /> : <Send size={14} />}
                </button>
              )}
            </div>
          )}
          {machine.state === 'running' && !pending && !machine.stale && machine.live && (
            <LiveReadings live={machine.live} metricsOnly />
          )}
          {machine.state === 'paused' && <p className="remote-server-reason">已暂停，不读实时状态</p>}
          <EnrollmentStatus job={enrollment} disabled={server.enrollmentDisabled} />
          {!machine.ssh && !server.enrollmentDisabled && <p className="remote-server-reason">首次发任务时自动接入</p>}

          {spec && (
            <p className="remote-server-spec" translate="no">
              {spec}
            </p>
          )}
          {machine.template && (
            <p className="quota-note" translate="no">
              {machine.template}
            </p>
          )}
          {machine.free && <span className="plan-badge">免费方案</span>}
          {machine.autoSuspendAfterSeconds !== undefined && machine.autoSuspendAfterSeconds >= 0 && (
            <p className="remote-server-note">
              {machine.autoSuspendAfterSeconds === 0
                ? '闲置时不暂停'
                : withNames('闲置 {0} 分钟后暂停', [String(Number((machine.autoSuspendAfterSeconds / 60).toFixed(1)))])}
            </p>
          )}
          {maxRun && (
            <p className="remote-server-note">
              {withNames('预计最晚 {0} 暂停（最长运行时间）', [
                new Date(until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }),
              ])}
            </p>
          )}
          {machine.stale && <p className="remote-server-reason">状态待更新</p>}
          {action && (
            <button
              type="button"
              className="button secondary tiny"
              disabled={!!busy || !!pending || machine.stale || !onInstaboxAction}
              onClick={() => onInstaboxAction?.(machine, action)}
            >
              {action === 'pause' ? '暂停' : '恢复运行'}
            </button>
          )}
        </div>
        <footer className="quota-footer">
          <div className="quota-footer-line">
            <time dateTime={machine.checkedAt}>
              {withNames('{0} 分钟前检查', [
                String(Math.max(0, Math.floor((now - Date.parse(machine.checkedAt)) / 60_000))),
              ])}
            </time>
          </div>
        </footer>
      </article>
    );
  }
  const expiry = remoteServerExpiry(server.expiresOn, now);
  const place = [server.provider, server.region].filter(Boolean).join(' · ');
  return (
    <article
      className={`quota-card compact-quota-card remote-server-card ${expiry.state}`}
      data-runtime-id={device?.id}
      tabIndex={device ? 0 : undefined}
      aria-label={device ? withNames('{0} 详情', [device.name]) : undefined}
    >
      <div className="quota-heading">
        <h3 translate="no" title={server.name}>
          {server.name}
        </h3>
        <span className={`plan-badge remote-server-expiry ${expiry.state}`}>{remoteServerExpiryLabel(expiry)}</span>
      </div>
      <div className="quota-body">
        {server.ssh &&
          onConnect &&
          (device ? (
            <div className="remote-server-connection">
              <p>
                已接入 ·{' '}
                <span className={`device-status ${device.online === true ? 'online' : ''}`}>
                  {device.online === undefined ? '正在检查…' : device.online ? '在线' : device.reason || '离线'}
                </span>
              </p>
              <div className="heading-actions">
                <button
                  type="button"
                  className="button secondary tiny"
                  disabled={disconnecting || sending}
                  onClick={() => onDisconnect?.({ ...server, ssh: server.ssh! })}
                >
                  断开
                </button>
                {device.online === true && (
                  <button
                    type="button"
                    className="icon-button tiny"
                    title={desktopBridge()?.pickFiles ? '发送文件…' : '请在桌面应用中选择要发送的文件。'}
                    aria-label="发送文件…"
                    disabled={sending || disconnecting || !desktopBridge()?.pickFiles}
                    onClick={() => void sendFiles()}
                  >
                    {sending ? <Loader2 size={14} className="spinning" /> : <Send size={14} />}
                  </button>
                )}
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="button secondary"
              onClick={() => onConnect({ ...server, ssh: server.ssh! })}
            >
              接入
            </button>
          ))}
        <EnrollmentStatus job={enrollment} disabled={server.enrollmentDisabled} />
        {retry && (
          <div>
            <p className="inline-error" role="alert">
              {retry.message}
            </p>
            <button type="button" className="button secondary" onClick={onRetry}>
              重试卸载
            </button>
          </div>
        )}
        {place && (
          <p className="quota-note" translate="no">
            {place}
          </p>
        )}
        {server.spec && (
          <p className="remote-server-spec" translate="no">
            {server.spec}
          </p>
        )}
        {server.purpose && (
          <p className="remote-server-purpose" translate="no">
            {server.purpose}
          </p>
        )}
        {server.ssh ? (
          <LiveReadings live={server.live} />
        ) : (
          <p className="remote-server-reason">没有 SSH 别名，不读实时状态</p>
        )}
        {server.missingSsh && (
          <p className="remote-server-reason">
            {withNames(
              '这台电脑没有 SSH 别名 {0}，这台服务器也还没开通账号直连。在一台能 SSH 登录它的电脑上打开 PugPort，接入后会自动开通。',
              [server.missingSsh],
            )}
          </p>
        )}
        {device?.accessUpgrade && <AccessUpgrade upgrade={device.accessUpgrade} />}
        {device && <DeviceQuotaChips device={device} />}
        {server.live && !server.live.online && server.live.reason && (
          <p className="remote-server-reason">{server.live.reason}</p>
        )}
        {server.credit && (
          <p className="remote-server-credit" translate="no">
            {withNames('剩余赠金 {0}', [server.credit])}
          </p>
        )}
        {server.note && (
          <p className="remote-server-note" translate="no">
            {server.note}
          </p>
        )}
      </div>
      {(expiry.state !== 'unknown' || server.ssh) && (
        <footer className="quota-footer">
          <div className="quota-footer-line">
            {expiry.state !== 'unknown' && (
              <time dateTime={expiry.date} translate="no">
                {withNames('到期日 {0}', [expiry.date])}
              </time>
            )}
            <LiveState server={server} />
          </div>
        </footer>
      )}
    </article>
  );
}

/** Soonest expiry first; boxes without a recorded expiry last, in the file's order. */
const daysLeft = (server: RemoteServer, now: number) => {
  const expiry = remoteServerExpiry(server.expiresOn, now);
  return expiry.state === 'unknown' ? Infinity : expiry.days;
};

const instaboxStates: Record<string, string> = {
  running: '运行中',
  paused: '已暂停',
  starting: '正在启动…',
  pausing: '正在暂停…',
  stopping: '正在停止…',
  stopped: '已停止',
};

export function RemoteServerCards({
  api,
  notify,
  view,
  now,
  devices = [],
  onOpen,
  onConnect,
  onDisconnect,
  retry,
  onRetry,
  disconnecting = false,
  busy,
  onInstaboxAction,
  onMachineConnect,
  onMachineDisconnect,
  onRemoveSsh,
  enrollments = [],
}: {
  api: Api;
  notify: (notice: Notice) => void;
  view?: RemoteServersView;
  now: number;
  devices?: DeviceView[];
  onOpen: (id: string, from: DOMRect) => void;
  onConnect?: (server: RemoteServerView & { ssh: string }) => void;
  onDisconnect?: (server: RemoteServerView & { ssh: string }) => void;
  retry?: Record<string, { message: string; purge: boolean }>;
  busy?: string;
  onInstaboxAction?: (machine: InstaboxMachineView, action: 'pause' | 'resume') => void;
  onMachineConnect?: (machine: InstaboxMachineView) => void;
  onMachineDisconnect?: (machine: InstaboxMachineView) => void;
  onRemoveSsh?: () => void;
  enrollments?: Enrollment[];
  disconnecting?: boolean;
  onRetry?: (server: RemoteServerView & { ssh: string }) => void;
}) {
  if (
    !view ||
    (!view.servers.length &&
      !view.error &&
      !view.instabox?.machines.length &&
      !view.instabox?.error &&
      !view.instabox?.sshManaged)
  )
    return null;
  const servers = view.servers
    .filter((server) => !view.instabox?.machines.some((machine) => machine.machineId === server.name))
    .sort((a, b) => daysLeft(a, now) - daysLeft(b, now));
  return (
    <section aria-label="远程服务器" className="web-quota-section remote-server-section">
      <h2>远程服务器</h2>
      {view.instabox?.error && (
        <p className="inline-error" role="alert">
          无法连接 instabox
        </p>
      )}
      {view.instabox?.sshManaged && onRemoveSsh && (
        <button type="button" className="button secondary tiny" onClick={onRemoveSsh}>
          移除 instabox SSH 配置
        </button>
      )}
      {view.error && (
        <p className="inline-error" role="alert">
          <span>{view.error}</span>
          <code translate="no">{[view.file, view.errorAt].filter(Boolean).join(' → ')}</code>
        </p>
      )}
      <EvenCards onOpen={onOpen}>
        {[
          ...servers.map((server, index) => (
            <RemoteServerCard
              api={api}
              notify={notify}
              key={`${index}-${server.name}`}
              server={server}
              enrollment={enrollments.find((job) => job.server === server.name)}
              now={now}
              device={server.ssh ? devices.find((device) => device.tunnel?.ssh === server.ssh) : undefined}
              onConnect={onConnect}
              onDisconnect={onDisconnect}
              retry={retry?.[server.name]}
              disconnecting={disconnecting}
              onRetry={server.ssh ? () => onRetry?.({ ...server, ssh: server.ssh! }) : undefined}
            />
          )),
          ...(view.instabox?.machines ?? []).map((machine) => (
            <RemoteServerCard
              key={machine.machineId}
              api={api}
              notify={notify}
              server={{
                ...view.servers.find((server) => server.name === machine.machineId),
                name: machine.name,
                ssh: machine.ssh,
              }}
              enrollment={enrollments.find((job) => job.server === machine.machineId)}
              machine={machine}
              now={now}
              busy={busy}
              onInstaboxAction={onInstaboxAction}
              onMachineConnect={onMachineConnect}
              onMachineDisconnect={onMachineDisconnect}
              device={machine.ssh ? devices.find((d) => d.tunnel?.ssh === machine.ssh) : undefined}
              disconnecting={disconnecting}
            />
          )),
        ]}
      </EvenCards>
    </section>
  );
}

/**
 * The last readings at once, then a refresh; every minute while the window is visible after that. The backend
 * checks each box at most every few minutes, so most refreshes just return what it already has.
 */
export function RemoteServers({
  api,
  notify,
  now,
  devices,
  reload,
  onOpen,
  refreshRevision = 0,
}: {
  api: Api;
  notify: (notice: Notice) => void;
  now: number;
  devices: DeviceView[];
  reload: () => Promise<void>;
  refreshRevision?: number;
  onOpen: (id: string, from: DOMRect) => void;
}) {
  const [view, setView] = useState<RemoteServersView>();
  const [enrollments, setEnrollments] = useState<Enrollment[]>([]);
  const [enroll, setEnroll] = useState<RemoteServerView>();
  const [enrollMachine, setEnrollMachine] = useState<InstaboxMachineView>();
  const [removeSsh, setRemoveSsh] = useState(false);
  const [disconnect, setDisconnect] = useState<RemoteServerView & { ssh: string }>();
  const [purge, setPurge] = useState(false);
  const [retry, setRetry] = useState<Record<string, { message: string; purge: boolean }>>({});
  const [disconnecting, setDisconnecting] = useState(false);
  const remove = async (server: RemoteServerView & { ssh: string }, removeFiles: boolean) => {
    setDisconnecting(true);
    try {
      const result = await api<DevicesView & { note?: string }>(
        '/api/remote-servers/disconnect',
        { name: server.name, purge: removeFiles },
        'POST',
      );
      await reload();
      await reloadServers.current();
      setRetry((previous) => {
        const next = { ...previous };
        if (result.note) next[server.name] = { message: result.note, purge: removeFiles };
        else delete next[server.name];
        return next;
      });
    } catch (error) {
      setRetry((previous) => ({
        ...previous,
        [server.name]: {
          message: error instanceof Error ? error.message : '操作没有完成，请重试。',
          purge: removeFiles,
        },
      }));
    } finally {
      setDisconnecting(false);
    }
  };
  const latestApi = useRef(api);
  latestApi.current = api;
  const latestReload = useRef(reload);
  latestReload.current = reload;
  const reloadServers = useRef<() => Promise<void>>(async () => {});
  const generation = useRef(0);
  const acting = useRef(false);
  const [busy, setBusy] = useState<string>();
  const act = async (machine: InstaboxMachineView, action: 'pause' | 'resume') => {
    if (acting.current || machine.pendingAction || machine.stale) return;
    acting.current = true;
    generation.current++;
    setBusy(machine.machineId);
    setView(
      (previous) =>
        previous && {
          ...previous,
          instabox: previous.instabox && {
            ...previous.instabox,
            machines: previous.instabox.machines.map((item) =>
              item.machineId === machine.machineId ? { ...item, pendingAction: action } : item,
            ),
          },
        },
    );
    try {
      const result = await latestApi.current<RemoteServersView>(
        '/api/remote-servers/instabox/action',
        { machineId: machine.machineId, action },
        'POST',
      );
      setView(result);
    } catch (error) {
      setView(
        (previous) =>
          previous && {
            ...previous,
            instabox: previous.instabox && {
              ...previous.instabox,
              machines: previous.instabox.machines.map((item) =>
                item.machineId === machine.machineId ? { ...item, pendingAction: undefined } : item,
              ),
            },
          },
      );
      notify({ tone: 'error', message: failure(error) });
    } finally {
      acting.current = false;
      setBusy(undefined);
      await reloadServers.current();
    }
  };
  useEffect(() => {
    let live = true;
    let pending: Promise<void> | undefined;
    const load = async (refresh: boolean) => {
      if (pending || acting.current || document.visibilityState === 'hidden') return;
      const version = generation.current;
      pending = (async () => {
        try {
          const value = await latestApi.current<RemoteServersView>(
            refresh ? '/api/remote-servers?refresh=1' : '/api/remote-servers',
            undefined,
            'GET',
          );
          if (live && version === generation.current && Array.isArray(value?.servers)) setView(value);
        } catch {
          /* Keep the last reading until a request succeeds. */
        } finally {
          pending = undefined;
        }
      })();
      await pending;
    };
    reloadServers.current = async () => {
      await pending;
      if (live) await load(true);
    };
    void load(false).then(() => {
      if (live) return load(true);
    });
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load(true);
    }, 60_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    let live = true;
    let pending = false;
    const completed = new Set<string>();
    const poll = async () => {
      if (pending || document.visibilityState === 'hidden') return;
      pending = true;
      try {
        const value = await latestApi.current<{ enrollments: Enrollment[] }>(
          '/api/remote-servers/enrollments',
          undefined,
          'GET',
        );
        if (live && Array.isArray(value?.enrollments)) {
          setEnrollments(value.enrollments);
          const fresh = value.enrollments.filter((job) => job.status === 'completed' && !completed.has(job.id));
          if (fresh.length) {
            await latestReload.current();
            for (const job of fresh) completed.add(job.id);
            if (live) await reloadServers.current();
          }
        }
      } catch {
        // Keep the last known progress until the next successful read.
      } finally {
        pending = false;
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 3000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);
  const lastRevision = useRef(refreshRevision);
  useEffect(() => {
    if (lastRevision.current !== refreshRevision) {
      lastRevision.current = refreshRevision;
      void reloadServers.current();
    }
  }, [refreshRevision]);
  return (
    <>
      <RemoteServerCards
        api={api}
        notify={notify}
        view={view}
        enrollments={enrollments}
        now={now}
        devices={devices}
        onOpen={onOpen}
        busy={busy}
        onInstaboxAction={(machine, action) => void act(machine, action)}
        onMachineConnect={(machine) => {
          setEnrollMachine(machine);
          setEnroll({ name: machine.name, ssh: machine.ssh });
        }}
        onMachineDisconnect={(machine) => {
          void api('/api/remote-servers/disconnect', { machineId: machine.machineId, purge: false }, 'POST')
            .then(async () => {
              await reload();
              await reloadServers.current();
            })
            .catch((error) => notify({ tone: 'error', message: failure(error) }));
        }}
        onRemoveSsh={() => setRemoveSsh(true)}
        onConnect={(server) => {
          setEnrollMachine(undefined);
          setEnroll(server);
        }}
        onDisconnect={(server) => {
          setPurge(false);
          setDisconnect(server);
        }}
        retry={retry}
        disconnecting={disconnecting}
        onRetry={(server) => {
          if (!disconnecting) void remove(server, retry[server.name]?.purge ?? false);
        }}
      />
      {enroll && (
        <ServerEnroll
          api={api}
          server={enroll}
          machine={enrollMachine}
          onClose={() => {
            setEnroll(undefined);
            void reload().catch(() => undefined);
            void reloadServers.current();
          }}
        />
      )}
      {removeSsh && (
        <ConfirmDialog
          options={{ title: '移除 instabox SSH 配置？', action: '移除', tone: 'danger' }}
          onAnswer={(answer) => {
            setRemoveSsh(false);
            if (answer)
              void api<RemoteServersView>('/api/remote-servers/instabox/ssh', undefined, 'DELETE')
                .then(setView)
                .catch((error) => notify({ tone: 'error', message: failure(error) }));
          }}
        />
      )}
      {disconnect && (
        <ConfirmDialog
          options={{ title: '断开服务器？', action: '断开', tone: 'danger' }}
          onAnswer={(answer) => {
            const server = disconnect;
            setDisconnect(undefined);
            if (answer) void remove(server, purge);
          }}
        >
          <label>
            <input type="checkbox" checked={purge} onChange={(event) => setPurge(event.currentTarget.checked)} />{' '}
            同时删除服务器上的 PugPort
          </label>
        </ConfirmDialog>
      )}
    </>
  );
}
