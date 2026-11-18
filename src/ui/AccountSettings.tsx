import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Cloud, CloudOff, RefreshCw, AlertCircle, CheckCircle2, Clock } from 'lucide-react';
import type { AccountView } from '../shared/account-ui';
import type { AppState } from '../shared/types';
import type { Api, Notice } from './Workspace';
import { SettingsGroup, SettingsRow } from './SettingsRow';
import { CliConnectionAction } from './Executors';
import { confirmDialog } from './confirm-dialog';
import { currentLocale, withNames } from './i18n';

export type AccountAction = <T = AccountView>(name: string, body?: unknown) => Promise<T>;
const dismissedKey = 'pugport-account-welcome-dismissed';
const supportedProviders: Record<string, string> = { codex: 'Codex', claude: 'Claude', grok: 'Grok', cursor: 'Cursor' };
const errors: Record<string, string> = {
  ACCOUNT_SESSION_CHANGED: '账号已更改，请重新确认。',
  SESSION_EXPIRED: '登录已过期，请重新登录。',
  REFRESH_REJECTED: '登录已过期，请重新登录。',
  UPGRADE_FAILED: '云端数据升级没有完成，会自动重试。',
  ACCOUNT_CHANGE_REQUIRES_CONSENT: '这台电脑曾同步到另一个账号。请确认是否合并本地数据。',
  OFFLINE: '暂时无法连接。恢复联网后会自动重试。',
  AUTH_TIMEOUT: '登录超时，请重试。',
  CALLBACK_TIMEOUT: '登录超时，请重试。',
  STATE_MISMATCH: '登录验证失败，请重试。',
};
const errorText = (code: string) => errors[code] ?? '操作未完成，请重试。';
const dateText = (value?: string) => (value ? new Date(value).toLocaleString(currentLocale()) : '尚未同步');
type SyncTone = 'ok' | 'busy' | 'wait' | 'error';
/** One plain status for the whole account: setup steps first, then the engine. */
function syncState(view: AccountView, merging: boolean): { tone: SyncTone; text: string } {
  if (view.setup === 'merge')
    return merging ? { tone: 'busy', text: '正在合并并上传…' } : { tone: 'wait', text: '等待确认合并' };
  if (view.setup === 'waiting-upgrade') return { tone: 'wait', text: '等待另一台电脑' };
  if (view.setup === 'upgrading') return { tone: 'busy', text: '正在升级云端数据…' };
  if (view.setup !== 'ready') return { tone: 'busy', text: '正在准备…' };
  if (view.sync === 'idle') return { tone: 'ok', text: '已同步' };
  if (view.sync === 'off') return { tone: 'wait', text: '等待设置' };
  if (view.sync === 'syncing') return { tone: 'busy', text: view.lastSyncedAt ? '正在同步…' : '正在进行第一次同步…' };
  if (view.sync === 'offline') return { tone: 'error', text: '离线，联网后自动继续' };
  return { tone: 'error', text: '同步出错' };
}
const syncIcons = { ok: CheckCircle2, busy: RefreshCw, wait: Clock, error: AlertCircle };
function SyncStateText({ view, merging }: { view: AccountView; merging: boolean }) {
  const { tone, text } = syncState(view, merging);
  const Icon = view.sync === 'offline' && view.setup === 'ready' ? CloudOff : syncIcons[tone];
  return (
    <span className={`account-sync-state ${tone}`}>
      <Icon size={13} className={tone === 'busy' ? 'spinning' : undefined} aria-hidden />
      {text}
    </span>
  );
}

export function useAccount(api: Api, enabled: boolean, broadcastView?: AccountView) {
  const view = enabled ? broadcastView : undefined;
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(dismissedKey) === '1';
    } catch {
      return false;
    }
  });
  const pending = useRef(false);
  const skip = useCallback(() => {
    setDismissed(true);
    try {
      localStorage.setItem(dismissedKey, '1');
    } catch {
      /* Memory-only preference. */
    }
  }, []);
  useEffect(() => {
    if (view?.auth.phase === 'signed-in') skip();
  }, [view?.auth.phase, skip]);
  const action: AccountAction = useCallback(
    async <T,>(name: string, body: unknown = {}) => {
      if (pending.current) throw Error('BUSY');
      pending.current = true;
      setBusy(true);
      try {
        return await api<T>('/api/account/' + name, { ...(body as object), sessionId: view?.sessionId });
      } finally {
        pending.current = false;
        setBusy(false);
      }
    },
    [api, view?.sessionId],
  );
  return { view, busy, dismissed, skip, action };
}

/** The merge step the main window points at; nothing syncs until the owner confirms it. */
export const accountMergeTarget = 'account-merge';
export function accountMergeWaiting(view?: AccountView) {
  return !!view?.configured && view.auth.phase === 'signed-in' && view.setup === 'merge' && !!view.merge;
}
export function AccountSyncPill({ view, onOpen }: { view?: AccountView; onOpen: () => void }) {
  const waiting = accountMergeWaiting(view);
  if (!view?.configured || view.auth.phase !== 'signed-in' || (!waiting && ['off', 'idle'].includes(view.sync)))
    return null;
  const syncing = !waiting && view.sync === 'syncing';
  const offline = !waiting && view.sync === 'offline';
  const Icon = waiting ? Clock : syncing ? RefreshCw : offline ? CloudOff : AlertCircle;
  return (
    <button
      className={`account-sync-pill ${waiting ? 'wait' : syncing ? 'syncing' : offline ? 'offline' : 'error'}`}
      onClick={onOpen}
      title="打开账号设置"
    >
      <Icon size={13} className={syncing ? 'spinning' : undefined} />
      <span>{waiting ? '待合并' : syncing ? '正在同步' : offline ? '离线' : '同步出错'}</span>
    </button>
  );
}

export function AccountWelcome({
  view,
  dismissed,
  onSkip,
  onOpen,
}: {
  view?: AccountView;
  dismissed: boolean;
  onSkip: () => void;
  onOpen: () => void;
}) {
  if (!view?.configured || dismissed || view.auth.phase === 'signed-in') return null;
  return (
    <section className="account-welcome" aria-label="跨设备同步">
      <Cloud size={20} />
      <div>
        <strong>登录以跨设备同步</strong>
        <p>可选。本地对话始终保留。</p>
      </div>
      <div className="account-actions">
        <button className="button secondary tiny" onClick={onOpen}>
          登录
        </button>
        <button className="button quiet tiny" data-account-skip onClick={onSkip}>
          跳过
        </button>
      </div>
    </section>
  );
}
export const AccountWelcomeContext = createContext<Parameters<typeof AccountWelcome>[0] | undefined>(undefined);
export function AccountWelcomeCard() {
  const props = useContext(AccountWelcomeContext);
  return props ? <AccountWelcome {...props} /> : null;
}

export function AccountSettings({
  view,
  action,
  busy,
  state,
  api,
  reload,
  notify,
  onOpenAccounts,
}: {
  view?: AccountView;
  action: AccountAction;
  busy: boolean;
  state: AppState;
  api: Api;
  reload: () => Promise<void>;
  notify: (notice: Notice) => void;
  onOpenAccounts: () => void;
}) {
  const [error, setError] = useState('');
  const [merging, setMerging] = useState(false);
  const mounted = useRef(true);
  const generation = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      ++generation.current;
    };
  }, []);
  useEffect(() => {
    ++generation.current;
    setError('');
  }, [view?.auth.phase, view?.auth.email, view?.sessionId, view?.setup]);
  if (!view?.configured) return null;
  const perform = async (name: string, body?: unknown) => {
    setError('');
    try {
      await action(name, body);
    } catch (failure) {
      if (mounted.current) setError(errorText(failure instanceof Error ? failure.message : ''));
    }
  };
  const button = (name: string, label: string, body?: unknown, disabled = false) => (
    <button
      type="button"
      className="button secondary"
      data-account-action={name}
      disabled={busy || disabled}
      onClick={() => void perform(name, body)}
    >
      {label}
    </button>
  );
  const deleteCloud = async () => {
    const current = generation.current;
    if (
      (await confirmDialog({
        title: '删除云端数据？',
        summary: '所有设备的云端副本将被删除。本地数据保留。',
        action: '删除云端数据',
        tone: 'danger',
      })) &&
      mounted.current &&
      current === generation.current
    )
      await perform('delete-cloud', { confirmed: true });
  };
  const merge = async () => {
    if (!view.merge) return;
    const changed = view.merge.accountChange;
    const current = generation.current;
    if (
      changed &&
      !(await confirmDialog({
        title: '合并到另一个账号？',
        summary: '这台电脑曾同步到另一个账号。只有确认后，本地数据才会合并到当前账号。',
        action: '确认合并',
        tone: 'danger',
      }))
    )
      return;
    if (!mounted.current || current !== generation.current) return;
    setMerging(true);
    try {
      await perform('merge', { confirmed: true, allowAccountChange: changed });
    } finally {
      if (mounted.current) setMerging(false);
    }
  };
  return (
    <div className="account-settings">
      {(error || view.error || view.auth.error) && (
        <p className="inline-error" role="alert">
          {error || errorText(view.error || view.auth.error || '')}
        </p>
      )}
      {view.auth.memoryOnly && <p className="quiet-text">系统密钥库不可用。关闭应用后需要重新登录。</p>}
      <SettingsGroup>
        {view.auth.phase === 'signed-out' ? (
          <SettingsRow
            title="PugPort 账号"
            description="登录后，对话和偏好设置会自动同步。"
            control={button('sign-in', '使用 Google 继续')}
          />
        ) : view.auth.phase === 'signing-in' ? (
          <SettingsRow title="等待浏览器完成登录…" control={button('cancel', '取消')} />
        ) : (
          <>
            <SettingsRow
              title={<span translate="no">{view.auth.email}</span>}
              description="对话和偏好设置自动同步。"
              control={button('sign-out', '退出登录')}
            />
            <SettingsRow title="同步状态" status={<SyncStateText view={view} merging={merging} />} />
            <SettingsRow
              title="上次同步"
              status={<span translate={view.lastSyncedAt ? 'no' : undefined}>{dateText(view.lastSyncedAt)}</span>}
            />
            <SettingsRow title="这台设备" status={<span translate="no">{view.deviceName}</span>} />
          </>
        )}
      </SettingsGroup>
      {view.auth.phase === 'signed-in' && (
        <>
          {view.setup === 'loading' && (
            <p role="status" className="quiet-text">
              正在读取云端数据…
            </p>
          )}
          {view.setup === 'upgrading' && (
            <p role="status" className="quiet-text">
              正在升级云端数据…
            </p>
          )}
          {view.setup === 'waiting-upgrade' && (
            <section className="account-setup" aria-label="等待另一台电脑">
              <h3>等待另一台电脑</h3>
              <p>云端副本还是旧格式。在上次同步过的电脑上打开 PugPort，它会自动升级，这台电脑随后自动开始同步。</p>
              <details>
                <summary>那台电脑用不了了？</summary>
                <p>删除云端数据并从这台电脑重新开始。本地数据保留。</p>
                <button className="button danger secondary" disabled={busy} onClick={() => void deleteCloud()}>
                  删除云端数据
                </button>
              </details>
            </section>
          )}
          {view.setup === 'merge' && view.merge && (
            <section
              className="account-setup"
              aria-label="首次同步"
              data-settings-item={accountMergeTarget}
              tabIndex={-1}
            >
              <h3>合并你的数据</h3>
              <p>合并前会先备份本地数据。两边的数据都会保留。</p>
              <table className="account-merge">
                <thead>
                  <tr>
                    <th scope="col">内容</th>
                    <th scope="col">这台设备</th>
                    <th scope="col">云端</th>
                  </tr>
                </thead>
                <tbody>
                  {(
                    [
                      ['chats', '对话'],
                      ['folders', '文件夹'],
                      ['projects', '项目'],
                      ['memories', '记忆'],
                    ] as const
                  ).map(([key, label]) => (
                    <tr key={key}>
                      <th scope="row">{label}</th>
                      <td>{view.merge!.local[key]}</td>
                      <td>{view.merge!.cloud[key]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {view.merge.accountChange && (
                <p className="inline-warning">这台电脑曾同步到另一个账号。请确认是否合并本地数据。</p>
              )}
              <button className="button primary" data-account-merge disabled={busy} onClick={() => void merge()}>
                {merging ? (
                  <>
                    <RefreshCw size={14} className="spinning" aria-hidden />
                    正在合并…
                  </>
                ) : (
                  '确认合并并同步'
                )}
              </button>
              {merging && <p className="quiet-text">正在备份本地数据并上传，数据多时需要几分钟。可以离开这个页面。</p>}
            </section>
          )}
          {!!view.devices.length && (
            <SettingsGroup title="你的设备">
              {view.devices.map((device) => (
                <SettingsRow
                  key={device.id}
                  title={<span translate="no">{device.name}</span>}
                  description={
                    <span translate="no">
                      {({ win32: 'Windows', darwin: 'macOS', linux: 'Linux' } as Record<string, string>)[
                        device.platform
                      ] ?? device.platform}
                    </span>
                  }
                  status={
                    <span translate={device.last_seen_at ? 'no' : undefined}>
                      {device.last_seen_at ? dateText(device.last_seen_at) : '尚未观测'}
                    </span>
                  }
                />
              ))}
            </SettingsGroup>
          )}
          {view.missingProviders.some((provider) => Object.hasOwn(supportedProviders, provider)) && (
            <SettingsGroup title="完成这台设备的设置" description="CLI 登录信息不会同步。">
              {view.missingProviders
                .filter((provider) => Object.hasOwn(supportedProviders, provider))
                .map((provider) => {
                  const target = state.targets.find(
                    (t) => t.provider === provider && t.environment === 'native' && !t.gateway,
                  );
                  return (
                    <SettingsRow
                      key={provider}
                      title={<span translate="no">{withNames('登录 {0}', [supportedProviders[provider]])}</span>}
                      control={
                        target ? (
                          <CliConnectionAction
                            {...{ state, api, reload, notify, target }}
                            snapshot={state.runtimes.find((r) => r.id === target.id)}
                          />
                        ) : (
                          <button className="button secondary tiny" onClick={onOpenAccounts}>
                            登录
                          </button>
                        )
                      }
                    />
                  );
                })}
            </SettingsGroup>
          )}
          <SettingsGroup>
            <SettingsRow
              title="删除云端数据"
              description="仅删除云端副本。本地数据保留。"
              control={
                <button className="button quiet danger" disabled={busy} onClick={() => void deleteCloud()}>
                  删除云端数据
                </button>
              }
            />
          </SettingsGroup>
        </>
      )}
    </div>
  );
}
