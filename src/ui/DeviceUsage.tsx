import { useEffect, useRef, useState } from 'react';
import { isApiHarness } from '../shared/provider-registry';
import type { DeviceView, DevicesView } from '../shared/devices';
import { quotaTotals, type QuotaLine } from '../shared/quota-summary';
import { quotaWindowLabel } from '../shared/quota-label';
import { providerNames } from '../shared/delegation';
import { shortHardwareName } from '../shared/hardware-name';
import { dateLabel } from './App';
import type { Api, Notice } from './Workspace';
import { compactResetLabel, quotaTone, UsageBar } from './UsageQuota';
import { EvenCards, QuotaZoom } from './QuotaZoom';
import { translateInterfaceText, withNames } from './i18n';
import { RemoteServers } from './RemoteServers';

export function deviceBytes(value: number): string {
  const unit = value < 1024 ** 3 ? 'MB' : 'GB';
  const size = value / (unit === 'MB' ? 1024 ** 2 : 1024 ** 3);
  return `${Number(size.toFixed(size < 100 ? 1 : 0))} ${unit}`;
}
function Capacity({ label, total, free }: { label: string; total?: number; free?: number }) {
  if (total === undefined && free === undefined) return null;
  const share = total && free !== undefined ? Math.max(0, Math.min(100, (free / total) * 100)) : undefined;
  return (
    <div className={`quota-window ${share !== undefined && share <= 10 ? 'danger' : ''}`}>
      <div className="quota-window-heading">
        <span>{label}</span>
        <strong translate="no" className="device-capacity-value">
          {total !== undefined && free !== undefined
            ? withNames('{0} 可用 / {1}', [deviceBytes(free), deviceBytes(total)])
            : withNames('未知', [])}
        </strong>
      </div>
      <div
        className={`quota-track ${share === undefined ? 'unknown-track' : ''}`}
        role={share === undefined ? undefined : 'progressbar'}
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={share}
      >
        {share !== undefined && <span style={{ width: `${share}%` }} />}
      </div>
    </div>
  );
}
export function DeviceUsageCards({
  devices,
  now,
  onOpen,
}: {
  devices: DeviceView[];
  now: number;
  onOpen: (id: string, from: DOMRect) => void;
}) {
  // shortcut: unlisted tunnel devices stay in Settings; revisit if servers need a fallback section.
  const visible = devices.filter((device) => !device.tunnel);
  if (!visible.length) return null;
  return (
    <section aria-label="设备" className="web-quota-section device-usage-section">
      <h2>设备</h2>
      <EvenCards onOpen={onOpen}>
        {visible.map((device) => (
          <DeviceQuotaCard key={device.id} device={device} now={now} compact />
        ))}
      </EvenCards>
    </section>
  );
}

function DeviceResources({ device, compact }: { device: DeviceView; compact: boolean }) {
  const hardware = device.hardware;
  const live = device.online === true ? device.resources : undefined;
  const total = live?.memoryTotal ?? hardware?.memoryTotal;
  const used =
    live?.memoryUsed ??
    (hardware?.memoryTotal !== undefined && hardware.memoryAvailable !== undefined
      ? Math.max(0, hardware.memoryTotal - hardware.memoryAvailable)
      : undefined);
  const memory =
    device.online === true && used !== undefined && total ? Math.min(100, (used / total) * 100) : undefined;
  const counts = hardware?.threads
    ? hardware.cores
      ? withNames('{0} 核 {1} 线程', [String(hardware.cores), String(hardware.threads)])
      : withNames('{0} 线程', [String(hardware.threads)])
    : hardware?.cores
      ? withNames('{0} 核', [String(hardware.cores)])
      : '';
  const model = (name?: string) => (compact ? shortHardwareName(name ?? '') : name);
  const vram = live?.vram;
  const items = [
    {
      id: 'cpu',
      name: 'CPU',
      value: live?.cpuPercent,
      detail: [model(hardware?.cpu), counts].filter(Boolean).join(' · '),
    },
    {
      id: 'gpu',
      name: 'GPU',
      value: live?.gpuPercent,
      detail: [
        model(live?.gpuName ?? hardware?.gpu),
        ...(!compact
          ? [
              vram
                ? withNames('显存 {0}/{1} GB', [(vram.usedMiB / 1024).toFixed(1), (vram.totalMiB / 1024).toFixed(1)])
                : '',
              ...[hardware?.gpu, ...(hardware?.gpuOthers ?? [])].filter(
                (name) => name && name !== (live?.gpuName ?? hardware?.gpu),
              ),
            ]
          : []),
      ]
        .filter(Boolean)
        .join(' · '),
    },
    {
      id: 'memory',
      name: '内存',
      value: memory,
      detail:
        total !== undefined && used !== undefined
          ? `${(Math.min(used, total) / 1024 ** 3).toFixed(1)} / ${Number((total / 1024 ** 3).toFixed(1))} GiB`
          : total !== undefined
            ? deviceBytes(total)
            : '',
    },
  ].filter((item) => item.value !== undefined || item.detail);
  if (!items.length) return <p className="quiet-text">等待设备上报</p>;
  return (
    <div className="device-resources">
      {items.map(({ id, name, value, detail }) => (
        <div className="device-resource" data-resource={id} key={id}>
          <div className={`device-resource-label${compact ? ' quota-window-heading' : ''}`}>
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
          {detail && (
            <small title={detail} translate="no">
              {detail}
            </small>
          )}
        </div>
      ))}
    </div>
  );
}

export function DeviceQuotaChips({ device }: { device: DeviceView }) {
  if (!device.executors) return null;
  const totals = quotaTotals(
    (device.executors ?? []).map((executor, index) => ({
      ...executor,
      id: String(index),
      windows: [],
      observedAt: executor.observedAt ?? null,
      provider: executor.provider as QuotaLine['provider'],
      reference: executor.stale ? true : undefined,
    })),
  );
  const chips = [
    ...totals.map((total) => ({
      label: isApiHarness(total.provider) ? 'API' : (providerNames[total.provider] ?? total.provider),
      value: total.known ? Math.round(total.total * 100) : undefined,
      stale: total.stale,
    })),
    ...(device.executors ?? [])
      .filter((executor) => executor.provider === 'web')
      .map((executor) => ({
        label: executor.label,
        value: executor.tightest,
        stale: executor.stale,
      })),
  ];
  return (
    <>
      <div className="device-quota-heading">
        <h4>剩余额度</h4>
        <span className="quiet-text">
          {device.online !== true
            ? '—'
            : device.running === undefined
              ? '—'
              : device.running
                ? withNames('{0} 个 Agent 任务运行中', [String(device.running)])
                : '空闲'}
        </span>
      </div>
      <div className="device-quota-chips">
        {chips.map((chip, index) => (
          <span
            key={index}
            className={`device-quota-chip ${quotaTone(chip.value)}`}
            style={device.online === true && chip.stale ? { opacity: 0.55 } : undefined}
          >
            <span translate="no">{chip.label}</span> {chip.value === undefined ? '—' : `${chip.value}%`}
          </span>
        ))}
      </div>
      {!chips.length && <p className="quiet-text">这台设备还没有账号</p>}
    </>
  );
}

export function DeviceQuotaCard({
  device,
  now,
  compact = false,
}: {
  device: DeviceView;
  now: number;
  compact?: boolean;
}) {
  const offline = device.online === false;
  const arch = device.arch === 'x64' ? 'x86_64' : device.arch === 'ia32' ? 'x86' : device.arch;
  const system = [device.hardware?.os, arch, !compact && device.version ? `PugPort ${device.version}` : '']
    .filter(Boolean)
    .join(' · ');
  const hardwareAt = offline ? device.lastSeenAt : device.online === true ? device.checkedAt : undefined;
  return (
    <article
      className={`quota-card device-quota-card ${compact ? 'compact-quota-card' : ''}`}
      data-runtime-id={compact ? device.id : undefined}
      tabIndex={compact ? 0 : undefined}
      role={compact ? 'button' : undefined}
      aria-haspopup={compact ? 'dialog' : undefined}
      aria-label={compact ? withNames('{0} 详情', [device.name]) : undefined}
    >
      <div className="quota-heading">
        <h3 translate="no">{device.name}</h3>
        <span className={`plan-badge device-status ${device.online === true ? 'online' : ''}`}>
          {device.online === undefined ? '正在检查…' : offline ? '离线' : '在线'}
        </span>
      </div>
      <div className="quota-body" style={device.online !== true ? { opacity: 0.55 } : undefined}>
        {compact ? (
          <p className="quota-note" translate="no">
            {system}
          </p>
        ) : (
          <h4 className="quiet-text">硬件</h4>
        )}
        <DeviceResources device={device} compact={compact} />
        {!device.hardware && device.version && device.resources && (
          <p className="quiet-text">更新这台设备上的 PugPort 以查看硬件</p>
        )}
        {compact ? (
          <DeviceQuotaChips device={device} />
        ) : (
          <>
            <p className="quota-note device-system" translate="no">
              {system}
            </p>
            <Capacity label="磁盘" total={device.hardware?.diskTotal} free={device.hardware?.diskFree} />
            {device.executors && <h4 className="quiet-text">设备账号</h4>}
            {device.executors?.length ? (
              device.executors.map((executor, index) => (
                <div
                  className="device-account"
                  key={index}
                  style={device.online === true && executor.stale ? { opacity: 0.55 } : undefined}
                >
                  <div className="quota-heading">
                    <span title={executor.label}>{executor.label}</span>
                    {executor.plan && <span className="plan-badge">{executor.plan}</span>}
                  </div>
                  {executor.status !== 'ready' ? (
                    <span className="quiet-text">{executor.status === 'auth-required' ? '要先登录' : '暂不可用'}</span>
                  ) : !executor.windows.length ? (
                    <span className="quiet-text">额度未知</span>
                  ) : (
                    executor.windows.map((window, i) => {
                      const family = /^(.+) (周|日)$/.exec(window.name);
                      return (
                        <div key={i}>
                          <UsageBar
                            account={executor.label}
                            label={
                              family
                                ? `${family[1]} ${translateInterfaceText(family[2])}`
                                : quotaWindowLabel(window.name)
                            }
                            left={window.remaining}
                            reset={window.resetsAt ? compactResetLabel(window.resetsAt, now) : undefined}
                            resetTitle={window.resetsAt ? dateLabel(window.resetsAt) : undefined}
                          />
                        </div>
                      );
                    })
                  )}
                </div>
              ))
            ) : device.executors ? (
              <p className="quiet-text">这台设备还没有账号</p>
            ) : null}
          </>
        )}
      </div>
      <footer className="quota-footer">
        <div className="quota-footer-line">
          {compact && device.version && <span translate="no">PugPort {device.version}</span>}
          {offline && hardwareAt && (
            <time dateTime={hardwareAt} translate="no">
              {withNames('上次在线 {0}', [dateLabel(hardwareAt)])}
            </time>
          )}
        </div>
      </footer>
    </article>
  );
}
export function DeviceUsage({
  api,
  now,
  notify,
  refreshRevision,
  onUpdated,
}: {
  api: Api;
  now: number;
  notify: (notice: Notice) => void;
  refreshRevision?: number;
  onUpdated?: (at: string | undefined) => void;
}) {
  const [devices, setDevices] = useState<DeviceView[]>([]);
  useEffect(() => {
    onUpdated?.(
      devices
        .map((device) => device.checkedAt)
        .filter((at): at is string => !!at && Number.isFinite(Date.parse(at)))
        .sort((a, b) => Date.parse(b) - Date.parse(a))[0],
    );
  }, [devices, onUpdated]);
  const [zoomed, setZoomed] = useState<{ id: string; from: DOMRect }>();
  const device = devices.find((item) => item.id === zoomed?.id);
  useEffect(() => {
    if (zoomed && !device) setZoomed(undefined);
  }, [zoomed, device]);
  const latestApi = useRef(api);
  latestApi.current = api;
  const reload = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    let live = true;
    let pending: Promise<DevicesView> | undefined;
    const load = async (refresh: boolean) => {
      if (pending || document.visibilityState === 'hidden') return;
      try {
        const value = await (pending = latestApi.current<DevicesView>(
          refresh ? '/api/devices?refresh=1' : '/api/devices',
          undefined,
          'GET',
        ));
        if (live && Array.isArray(value?.devices)) setDevices(value.devices);
      } catch {
        /* Keep the last reading until a request succeeds. */
      } finally {
        pending = undefined;
      }
    };
    reload.current = async () => {
      await pending?.catch(() => undefined);
      await load(true);
    };
    void load(false).then(() => {
      if (live) return load(true);
    });
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load(true);
    }, 5_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);
  return (
    <>
      <DeviceUsageCards devices={devices} now={now} onOpen={(id, from) => setZoomed({ id, from })} />
      <RemoteServers
        refreshRevision={refreshRevision}
        api={api}
        notify={notify}
        now={now}
        devices={devices}
        reload={() => reload.current()}
        onOpen={(id, from) => setZoomed({ id, from })}
      />
      {zoomed && device && (
        <QuotaZoom from={zoomed.from} label={device.name} onClose={() => setZoomed(undefined)}>
          <DeviceQuotaCard device={device} now={now} />
        </QuotaZoom>
      )}
    </>
  );
}
