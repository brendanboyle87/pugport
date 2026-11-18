import { currentLocale } from './i18n';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { nativeCliProviders, providerSpec } from '../shared/provider-registry';
import {
  ChevronDown,
  Clock,
  ExternalLink,
  KeyRound,
  Loader2,
  LogIn,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react';
import type { AppState, RuntimeSnapshot, RuntimeTarget } from '../shared/types';
import { systemTrashName } from '../shared/trash';
import { saveSettings } from './settings-permissions';
import { confirmDialog } from './confirm-dialog';
import type { NativeAccountsState, NativeAccountView } from '../shared/accounts';
import {
  apiLimitDefaults,
  apiLimitRange,
  apiPreset,
  apiPresets,
  apiCreditGone,
  freePresets,
  validateApiConnection,
  validateFreeBaseUrl,
  USD_TO_CNY,
  type ApiBudgetPolicy,
  type ApiBudgetView,
  type ApiProviderView,
  type ApiConnection,
} from '../shared/api-providers';
import { quotaOverviewWindows } from '../shared/quota-summary';
import { ProviderMark, TargetEditor, dateLabel, readableError, runtimeLabels } from './App';
import { CardName } from './CardName';
import { cliReadiness, hasUsableAccount, showDiscoveredCli } from '../shared/runtime-readiness';
import {
  externalAgentCatalog,
  grokBotIdPattern,
  webAgentRisk,
  type ExternalAgentView,
} from '../shared/external-agents';
import { webAgentUrl } from '../shared/web-bridge';
import { ExternalAgentsCard } from './ExternalAgents';
import { shownName, translateInterfaceText, withNames } from './i18n';
import type { Api, Notice } from './Workspace';
import type { WebSearchView } from '../shared/web-search';
import { apiRuntimeBusy } from './notice-lifecycle';
import { useUiUpdateBlocker } from './ui-update-guard';
import { useMenuKeys } from './use-menu-keys';

type Notify = (notice: Notice) => void;
type Props = { state: AppState; api: Api; reload: () => Promise<void>; notify: Notify };
type CursorUsageControl = { enabled: boolean; pending: boolean; change: (enabled: boolean) => Promise<void> };

/** This is one app setting, shared by every Cursor row. */
function useCursorUsageSetting({ state, api, reload, notify }: Props): CursorUsageControl {
  const [enabled, setEnabled] = useState(state.settings.cursorUsageFromEditor === true);
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!inFlight.current) setEnabled(state.settings.cursorUsageFromEditor === true);
  }, [state.settings.cursorUsageFromEditor]);
  return {
    enabled,
    pending,
    async change(value) {
      if (inFlight.current) return;
      inFlight.current = true;
      setPending(true);
      setEnabled(value);
      let committed = false;
      try {
        await saveSettings(api, state.settings, { cursorUsageFromEditor: value });
        committed = true;
        await reload();
        if (mounted.current)
          notify({
            tone: 'success',
            message: value ? '已开启自动读取 Cursor 用量，稍后在用量页显示。' : '已关闭自动读取 Cursor 用量。',
          });
      } catch (error) {
        if (mounted.current) {
          if (!committed) setEnabled(enabled);
          notify({
            tone: 'error',
            message: committed ? `设置已保存，但刷新失败：${readableError(error)}` : readableError(error),
          });
        }
      } finally {
        inFlight.current = false;
        if (mounted.current) setPending(false);
      }
    },
  };
}

/** Whether Cursor's copy of a model takes over when the native accounts run low; on unless turned off. */
function useCursorFallbackSetting({ state, api, reload, notify }: Props): CursorUsageControl {
  const saved = state.settings.cursorFallback !== false;
  const [enabled, setEnabled] = useState(saved);
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!inFlight.current) setEnabled(saved);
  }, [saved]);
  return {
    enabled,
    pending,
    async change(value) {
      if (inFlight.current) return;
      inFlight.current = true;
      setPending(true);
      setEnabled(value);
      let committed = false;
      try {
        await saveSettings(api, state.settings, { cursorFallback: value });
        committed = true;
        await reload();
        if (mounted.current)
          notify({
            tone: 'success',
            message: value
              ? '已开启：原生账号额度不足时，用 Cursor 里的同款模型接替（成人内容除外）。'
              : '已关闭 Cursor 接替：原生额度不足时任务会等额度重置。',
          });
      } catch (error) {
        if (mounted.current) {
          if (!committed) setEnabled(enabled);
          notify({
            tone: 'error',
            message: committed ? `设置已保存，但刷新失败：${readableError(error)}` : readableError(error),
          });
        }
      } finally {
        inFlight.current = false;
        if (mounted.current) setPending(false);
      }
    },
  };
}

const cliProviders: readonly string[] = nativeCliProviders;
type Currency = 'CNY' | 'USD';
/** Small amounts keep their digits (¥0.0034, not ¥0.00); larger ones use two decimals. */
export function money(amount: number, currency: string) {
  const symbol = currency === 'CNY' ? '¥' : currency === 'USD' ? '$' : `${currency} `;
  const digits = amount !== 0 && Math.abs(amount) < 0.01 ? 4 : 2;
  return `${symbol}${amount.toFixed(digits).replace(/(\.\d\d\d*?)0+$/, '$1')}`;
}
/** Converts between the two currencies shown on API cards (an approximation, labelled where shown). */
export const convert = (amount: number, from: string, to: Currency) =>
  from === to
    ? amount
    : from === 'USD' && to === 'CNY'
      ? amount * USD_TO_CNY
      : from === 'CNY' && to === 'USD'
        ? amount / USD_TO_CNY
        : amount;
const currencyKey = (id: string) => `comborunner.currency.${id}`;
function useCurrency(id: string, fallback: Currency): [Currency, () => void] {
  const [value, setValue] = useState<Currency>(() => {
    try {
      const saved = localStorage.getItem(currencyKey(id));
      if (saved === 'CNY' || saved === 'USD') return saved;
    } catch {
      /* Storage unavailable. */
    }
    return fallback;
  });
  return [
    value,
    () => {
      const next = value === 'CNY' ? 'USD' : 'CNY';
      setValue(next);
      try {
        localStorage.setItem(currencyKey(id), next);
      } catch {
        /* The choice lasts for this window. */
      }
    },
  ];
}
const tokens = (value: number | null | undefined) =>
  !value
    ? '0'
    : value >= 1e6
      ? `${(value / 1e6).toFixed(1)}M`
      : value >= 1e3
        ? `${(value / 1e3).toFixed(1)}K`
        : `${value}`;

/** The tightest account-overview window, as percent left. */
export function quotaLeft(snapshot?: RuntimeSnapshot): number | undefined {
  if (snapshot?.quota.status !== 'known') return undefined;
  const left = quotaOverviewWindows(snapshot)
    .map((window) => window.usedPercent)
    .filter((used): used is number => typeof used === 'number' && used >= 0 && used <= 100)
    .map((used) => 100 - used);
  return left.length ? Math.min(...left) : undefined;
}
const tone = (left: number) => (left <= 10 ? 'low' : left <= 30 ? 'mid' : 'good');

function useAccounts(api: Api) {
  const [accounts, setAccounts] = useState<NativeAccountsState>();
  const load = () =>
    api<NativeAccountsState>('/api/accounts', undefined, 'GET')
      .then(setAccounts)
      .catch(() => undefined);
  useEffect(() => {
    void load();
    // Cached reads only: viewing never logs in or sends a request to a model.
    const timer = setInterval(() => void load(), 10_000);
    return () => clearInterval(timer);
  }, []);
  return [accounts, load] as const;
}

async function createAndLogin(props: Props, provider: string, label: string, accounts?: NativeAccountView[]) {
  const existingIds = new Set([
    ...props.state.targets.map((target) => target.id),
    ...(accounts?.map((a) => a.runtimeId) ?? []),
  ]);
  const next = await props.api<NativeAccountsState>('/api/accounts', { provider, label });
  const added = next.accounts.filter(
    (account) => account.provider === provider && account.managed && !existingIds.has(account.runtimeId),
  );
  if (added.length !== 1) throw new Error('账号已创建，但无法唯一确认新账号；请刷新列表后在对应账号中登录。');
  await props.api(`/api/accounts/${encodeURIComponent(added[0]!.runtimeId)}/login`, {});
}

const installPages: Record<string, string> = {
  codex: 'https://developers.openai.com/codex/cli/',
  claude: 'https://code.claude.com/docs/zh-CN/overview',
  grok: 'https://github.com/xai-org/grok-cli',
  cursor: 'https://cursor.com/cli',
};

export function CliConnectionAction({
  target,
  snapshot,
  account,
  ...props
}: Props & {
  target: RuntimeTarget;
  snapshot?: RuntimeSnapshot;
  account?: NativeAccountView;
}) {
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const missing = snapshot?.status === 'missing' && !snapshot.installed;
  const login = snapshot?.status === 'auth-required' || snapshot?.availability?.reason === 'authentication';
  async function connect() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      if (login) {
        if (target.accountId) await props.api(`/api/accounts/${encodeURIComponent(target.id)}/login`, {});
        else await createAndLogin(props, target.provider, `${target.label} 账号`, []);
        props.notify({ tone: 'info', message: '已打开官方登录窗口，登录完成后会自动检查。' });
      } else {
        await props.api(
          target.accountId || providerSpec(target.provider)?.accountIdentity === 'home'
            ? `/api/accounts/${encodeURIComponent(target.id)}/check`
            : '/api/refresh',
          {},
        );
      }
      await props.reload();
    } catch (error) {
      props.notify({ tone: 'error', message: readableError(error) });
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return missing ? (
    <a className="button secondary tiny" href={installPages[target.provider]} target="_blank" rel="noreferrer">
      安装
    </a>
  ) : (
    <button
      type="button"
      className="button secondary tiny"
      disabled={busy || account?.inUse || account?.loginPending || props.state.refreshing}
      onClick={() => void connect()}
    >
      {busy ? <Loader2 size={12} className="spinning" /> : login ? <LogIn size={12} /> : <RefreshCw size={12} />}
      {login ? '登录' : '检查'}
    </button>
  );
}

export function ConnectAccounts({ onClose, ...props }: Props & { onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [accounts] = useAccounts(props.api);
  useEffect(() => ref.current?.showModal(), []);
  return (
    <dialog
      ref={ref}
      className="native-dialog"
      onCancel={onClose}
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
    >
      <div className="dialog-inner add-executor">
        <div className="dialog-title">
          <h2>连接账号</h2>
          <button type="button" className="icon-button" aria-label="关闭" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <p>已有登录会自动发现和检查。选一个账号，完成它缺少的步骤即可开始。</p>
        {props.state.targets
          .filter(
            (target) => cliProviders.includes(target.provider) && !target.gateway && target.environment === 'native',
          )
          .map((target) => {
            const snapshot = props.state.runtimes.find((runtime) => runtime.id === target.id);
            const { usable, label } = cliReadiness(target, snapshot);
            return (
              <div className="setting-row" key={target.id}>
                <span className="setting-label">
                  <span translate="no">{shownName(target.label)}</span>
                </span>
                <div className="setting-control">
                  <span>{label}</span>
                  {!usable && (
                    <CliConnectionAction
                      {...props}
                      target={target}
                      snapshot={snapshot}
                      account={accounts?.accounts.find((a) => a.runtimeId === target.id)}
                    />
                  )}
                </div>
              </div>
            );
          })}
        <div className="dialog-actions">
          <button type="button" className="button primary" onClick={onClose}>
            {hasUsableAccount(props.state) ? '开始聊天' : '返回对话'}
          </button>
        </div>
      </div>
    </dialog>
  );
}

function Row({
  mark,
  name,
  detail,
  metric,
  enabled,
  onEnabled,
  onOpen,
  summary,
  menu = [],
  children,
}: {
  onOpen?: () => void;
  /** Actions reachable without expanding the row. */
  menu?: Array<{ label: string; disabled?: boolean; onSelect: () => void }>;
  mark: ReactNode;
  name: ReactNode;
  detail: ReactNode;
  metric?: ReactNode;
  summary?: ReactNode;
  enabled: boolean;
  onEnabled: (value: boolean) => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuTrigger = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  useMenuKeys(menuOpen, menuRef, () => setMenuOpen(false));
  useEffect(() => {
    if (!menuOpen) return;
    const outside = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [menuOpen]);
  const toggle = () => {
    if (!open) onOpen?.();
    setOpen(!open);
  };
  return (
    <div className={`exec-row ${open ? 'open' : ''} ${enabled ? '' : 'off'}`}>
      <div className="exec-head">
        <button type="button" className="exec-toggle" aria-expanded={open} aria-controls={bodyId} onClick={toggle}>
          {mark}
          <span className="exec-name">
            {name}
            <small>{detail}</small>
          </span>
          {metric && <span className="exec-metric">{metric}</span>}
        </button>
        <button
          type="button"
          className="icon-button exec-expand"
          aria-label={open ? '收起' : '展开'}
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={toggle}
        >
          <ChevronDown size={15} className="exec-chevron" />
        </button>
        {menu.length > 0 && (
          <div className="exec-add" ref={menuRef}>
            <button
              type="button"
              ref={menuTrigger}
              className="icon-button exec-expand exec-more"
              aria-label="更多操作"
              title="更多操作"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-controls={menuId}
              onClick={() => setMenuOpen(!menuOpen)}
            >
              <MoreHorizontal size={15} />
            </button>
            {menuOpen && (
              <div className="context-menu exec-add-menu" id={menuId} role="menu" aria-label="更多操作">
                {menu.map((item) => (
                  <button
                    type="button"
                    role="menuitem"
                    key={item.label}
                    className="danger-text"
                    disabled={item.disabled}
                    onClick={() => {
                      // The menu unmounts; a confirm dialog must return focus to a stable trigger.
                      menuTrigger.current?.focus();
                      setMenuOpen(false);
                      item.onSelect();
                    }}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <label className="switch" title={enabled ? '停用' : '启用'}>
          <input type="checkbox" checked={enabled} onChange={(event) => onEnabled(event.target.checked)} />
          <span />
        </label>
      </div>
      {summary}
      {open && (
        <div className="exec-body" id={bodyId}>
          {children}
        </div>
      )}
    </div>
  );
}

function CliRow({
  target,
  snapshot,
  account,
  accounts,
  usage,
  cursorUsage,
  cursorFallback,
  ...props
}: Props & {
  target: RuntimeTarget;
  snapshot?: RuntimeSnapshot;
  account?: NativeAccountView;
  accounts: NativeAccountView[];
  usage?: { runs: number; totalTokens: number | null };
  cursorUsage: CursorUsageControl;
  cursorFallback?: CursorUsageControl;
}) {
  const left = quotaLeft(snapshot);
  const trash = systemTrashName(props.state.app.platform);
  const [purging, setPurging] = useState(false);
  const [purgeName, setPurgeName] = useState('');
  const apiBilling = snapshot?.authMode === 'apiKey';
  const duplicate = account?.duplicateOf && accounts.find((item) => item.runtimeId === account.duplicateOf);
  const patch = (body: object) =>
    props
      .api(`/api/targets/${encodeURIComponent(target.id)}`, body, 'PATCH')
      .then(props.reload)
      .catch((error) => props.notify({ tone: 'error', message: readableError(error) }));
  const accountAction = (action: 'login' | 'check') =>
    props
      .api(`/api/accounts/${encodeURIComponent(target.id)}/${action}`, {})
      .then(() =>
        props.notify({
          tone: 'info',
          message: action === 'login' ? '已打开官方登录窗口，登录完成后会自动检查。' : '登录状态已检查。',
        }),
      )
      .then(props.reload)
      .catch((error) => props.notify({ tone: 'error', message: readableError(error) }));
  const removeAccount = async () => {
    if (
      !(await confirmDialog({
        title: '移除 {0}？',
        names: [shownName(target.label)],
        summary: `登录信息移到${trash}，执行记录和用量保留。`,
        action: '移除账号',
        tone: 'danger',
      }))
    )
      return;
    void props
      .api<{ loginFolderRecycled: boolean }>(`/api/accounts/${encodeURIComponent(target.id)}`, undefined, 'DELETE')
      .then((result) =>
        props.notify({
          tone: 'success',
          message: result.loginFolderRecycled
            ? '已移除 {0}，登录信息在{1}里，需要时可以还原。'
            : '已移除 {0}。登录文件夹没能移到{1}，仍留在原处。',
          names: [shownName(target.label), translateInterfaceText(trash)],
        }),
      )
      .then(props.reload)
      .catch((error) => props.notify({ tone: 'error', message: readableError(error) }));
  };
  // The default native card: removes only PugPort's card, never the CLI or its login.
  const removable =
    target.id === `${target.provider}-native` &&
    target.environment === 'native' &&
    !target.accountId &&
    !target.gateway;
  const removeCard = async () => {
    if (
      !(await confirmDialog({
        title: `从 PugPort 移除 ${target.label}？`,
        summary: '只移除 PugPort 里的这张卡；本机的命令行工具和它的登录都不动。',
        action: '移除',
        tone: 'danger',
      }))
    )
      return;
    void props
      .api(`/api/accounts/${encodeURIComponent(target.id)}`, undefined, 'DELETE')
      .then(() => props.notify({ tone: 'success', message: `已移除 ${target.label}。` }))
      .then(props.reload)
      .catch((error) => props.notify({ tone: 'error', message: readableError(error) }));
  };
  const busyAccount = !!(account?.inUse || account?.loginPending);
  return (
    <Row
      menu={
        account?.managed
          ? [{ label: '移除账号', disabled: busyAccount, onSelect: () => void removeAccount() }]
          : removable
            ? [{ label: '移除', disabled: busyAccount, onSelect: () => void removeCard() }]
            : []
      }
      mark={<ProviderMark provider={target.provider} small />}
      name={<strong translate="no">{shownName(target.label)}</strong>}
      detail={
        <>
          {[
            snapshot ? runtimeLabels[snapshot.status] : '尚未发现',
            account?.loginPending ? '登录中' : '',
            target.sharedConfigNote ?? '',
            usage?.runs ? `${usage.runs} 次任务` : '',
            usage?.totalTokens ? `${tokens(usage.totalTokens)} tokens` : '',
          ]
            .filter(Boolean)
            .join(' · ')}
        </>
      }
      metric={
        apiBilling ? (
          <span className="exec-tag">API 计费</span>
        ) : left !== undefined ? (
          <span className={`quota-chip ${tone(left)}`} translate="no">
            {withNames('剩余 {0}%', [String(Math.round(left))])}
          </span>
        ) : undefined
      }
      enabled={target.enabled}
      onEnabled={(enabled) => void patch({ enabled })}
    >
      {duplicate && (
        <p className="inline-warning" translate="no">
          {withNames('与 {0} 是同一个账号，不算独立额度。', [shownName(duplicate.label)])}
        </p>
      )}
      <div className="exec-actions">
        <CardName as="strong" label={target.label} onRename={(label) => patch({ label })} />
        {snapshot?.version && (
          <span className="exec-version" translate="no">
            v{snapshot.version.replace(/^v/, '')}
          </span>
        )}
        <CliConnectionAction {...props} target={target} snapshot={snapshot} account={account} />
      </div>
      <details className="target-advanced">
        <summary>高级设置</summary>
        {account?.managed && (
          <div className="exec-actions">
            <button
              type="button"
              className="button secondary tiny"
              disabled={account.inUse || account.loginPending}
              onClick={() => void accountAction('login')}
            >
              <LogIn size={12} />
              {account.status === 'auth-required' ? '登录' : '重新登录'}
            </button>
            <button
              type="button"
              className="button secondary tiny"
              disabled={account.inUse || account.loginPending}
              onClick={() => void accountAction('check')}
            >
              <RefreshCw size={12} />
              检查登录
            </button>
            <button
              type="button"
              className="button quiet tiny danger-text"
              disabled={account.inUse || account.loginPending}
              onClick={() => void removeAccount()}
            >
              <Trash2 size={12} />
              移除账号
            </button>
            <button
              type="button"
              className="button quiet tiny danger-text"
              disabled={account.inUse || account.loginPending}
              title="彻底删掉它在这台电脑上的登录和配置，不能还原"
              aria-expanded={purging}
              onClick={() => {
                setPurging(!purging);
                setPurgeName('');
              }}
            >
              <Trash2 size={12} />
              彻底清空
            </button>
          </div>
        )}
        {account?.managed && purging && (
          <div className="purge-confirm" role="group" aria-label={withNames('彻底清空 {0}', [target.label])} data-names>
            <p translate="no">
              {withNames('会删掉 {0} 在这台电脑上的登录文件和配置，无法还原；执行记录和用量保留。输入账号名确认：', [
                target.label,
              ])}
            </p>
            <div className="purge-confirm-row">
              <input
                value={purgeName}
                placeholder={target.label}
                aria-label={translateInterfaceText('输入账号名确认')}
                data-names
                onChange={(event) => setPurgeName(event.target.value)}
              />
              <button type="button" className="button quiet tiny" onClick={() => setPurging(false)}>
                取消
              </button>
              <button
                type="button"
                className="button tiny danger"
                disabled={purgeName.trim() !== target.label}
                onClick={() => {
                  setPurging(false);
                  void props
                    .api<{ loginFolderDeleted: boolean }>(
                      `/api/accounts/${encodeURIComponent(target.id)}?purge=1`,
                      undefined,
                      'DELETE',
                    )
                    .then((result) =>
                      props.notify({
                        tone: 'success',
                        message: result.loginFolderDeleted
                          ? '已彻底清空 {0}。'
                          : '已移除 {0}，但它的登录文件夹没能删掉，仍留在原处。',
                        names: [shownName(target.label)],
                      }),
                    )
                    .then(props.reload)
                    .catch((error) => props.notify({ tone: 'error', message: readableError(error) }));
                }}
              >
                彻底清空
              </button>
            </div>
          </div>
        )}
        {removable && (
          <div className="exec-actions">
            <button
              type="button"
              className="button quiet tiny danger-text"
              disabled={account?.inUse || account?.loginPending}
              onClick={() => void removeCard()}
            >
              <Trash2 size={12} />
              移除
            </button>
          </div>
        )}
        {target.provider === 'cursor' && (
          <div className="exec-option">
            <label className="check-row">
              <input
                type="checkbox"
                checked={cursorUsage.enabled}
                disabled={cursorUsage.pending}
                aria-busy={cursorUsage.pending}
                onChange={(event) => void cursorUsage.change(event.target.checked)}
              />
              <span>自动读取用量和赠送额度</span>
            </label>
            {account?.managed ? (
              <small>
                Cursor 没有公开的余额查询。开启后读取这个账号自己的 Cursor 登录，定期向 Cursor 官网
                查询本账期用量和赠送额度；登录信息只发送给 Cursor 官方服务，不另行保存。
              </small>
            ) : (
              <small>
                Cursor 没有公开的余额查询。开启后读取本机 Cursor 编辑器的登录信息，定期向 Cursor 官网
                查询本账期用量和赠送额度；登录信息只发送给 Cursor 官方服务，不另行保存。
              </small>
            )}
          </div>
        )}
        {target.provider === 'cursor' && cursorFallback && (
          <div className="exec-option">
            <label className="check-row">
              <input
                type="checkbox"
                checked={cursorFallback.enabled}
                disabled={cursorFallback.pending}
                aria-busy={cursorFallback.pending}
                onChange={(event) => void cursorFallback.change(event.target.checked)}
              />
              <span>原生额度不足时用 Cursor 的同款模型接替</span>
            </label>
            <small>
              Grok、Claude、Codex 的账号都低于保留额度时，同一模型改由 Cursor 运行（例如 grok-4.7 high → Cursor 的
              grok-4.7-high），计入 Cursor 的额度。成人内容不会转给 Cursor，仍等原执行器的额度重置。
            </small>
          </div>
        )}
        <TargetEditor embedded target={target} snapshot={snapshot} {...props} />
      </details>
    </Row>
  );
}

/** A datetime-local input shows the user's timezone; only offset-bearing ISO dates go to the server. */
function localBudgetDate(value?: string) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
    : '';
}
function budgetDraft(policy?: ApiBudgetPolicy) {
  return {
    limitUsd: policy?.limitUsd === undefined ? '' : String(policy.limitUsd),
    expiresAt: localBudgetDate(policy?.expiresAt).slice(0, 10),
    perRunUsd: String(policy?.perRunUsd ?? 1),
    maxConcurrentRuns: String(policy?.maxConcurrentRuns ?? 1),
    burstConcurrentRuns: String(policy?.burstConcurrentRuns ?? 4),
    preferExpiring: policy?.preferExpiring ?? true,
    monthly: policy?.monthlyUsd !== undefined,
    monthlyUsd: String(policy?.monthlyUsd ?? 200),
    linkedAccountId: policy?.linkedAccountId ?? '',
  };
}

function budgetInput(draft: ReturnType<typeof budgetDraft>, previous?: ApiBudgetPolicy) {
  const limitUsd = draft.limitUsd.trim() ? Number(draft.limitUsd) : undefined;
  const perRunUsd = Number(draft.perRunUsd);
  const maxConcurrentRuns = Number(draft.maxConcurrentRuns);
  const burstConcurrentRuns = Number(draft.burstConcurrentRuns);
  const monthlyUsd = draft.monthly ? Number(draft.monthlyUsd) : undefined;
  if (monthlyUsd !== undefined && (!Number.isFinite(monthlyUsd) || monthlyUsd <= 0))
    throw new Error('每月额度必须是大于 0 的金额。');
  if (monthlyUsd !== undefined && !draft.expiresAt) throw new Error('每月续期赠金需要填下次续期日。');
  if (
    (limitUsd !== undefined && (!Number.isFinite(limitUsd) || limitUsd <= 0)) ||
    !Number.isFinite(perRunUsd) ||
    perRunUsd <= 0
  )
    throw new Error('额度和每次预留必须是大于 0 的金额。');
  if ([maxConcurrentRuns, burstConcurrentRuns].some((value) => !Number.isInteger(value) || value < 1 || value > 16))
    throw new Error('并发数必须是 1～16 的整数。');
  if (burstConcurrentRuns < maxConcurrentRuns) throw new Error('快到期时的并发不能低于平时。');
  if (limitUsd !== undefined && perRunUsd > limitUsd) throw new Error('每次预留不能大于整个额度。');
  // A date alone means the start of that day in the user's timezone.
  const expiry = draft.expiresAt ? new Date(`${draft.expiresAt}T00:00`) : undefined;
  if (expiry && !Number.isFinite(expiry.getTime())) throw new Error('到期日无效。');
  return {
    ...(limitUsd === undefined ? {} : { limitUsd }),
    ...(expiry
      ? {
          expiresAt:
            draft.expiresAt === localBudgetDate(previous?.expiresAt).slice(0, 10)
              ? previous!.expiresAt!
              : expiry.toISOString(),
        }
      : {}),
    perRunUsd,
    maxConcurrentRuns,
    burstConcurrentRuns,
    preferExpiring: draft.preferExpiring,
    ...(monthlyUsd === undefined ? {} : { monthlyUsd }),
    ...(monthlyUsd !== undefined && draft.linkedAccountId ? { linkedAccountId: draft.linkedAccountId } : {}),
  };
}

const apiProtocols: Record<ApiConnection['protocol'], string> = {
  'azure-openai-responses': 'Azure OpenAI Responses',
  'openai-responses': 'OpenAI Responses',
  'openai-completions': 'OpenAI Chat Completions',
  'anthropic-messages': 'Anthropic Messages',
};

function ApiBudgetSettings({
  provider,
  blocked: cardBusy,
  state,
  api,
  reload,
  notify,
}: Pick<Props, 'state' | 'api' | 'reload' | 'notify'> & { provider: ApiProviderView; blocked: boolean }) {
  const runtimeBusy = apiRuntimeBusy(state?.runs ?? [], provider.targetId);
  const blocked = cardBusy || runtimeBusy;
  const budget = provider.budget;
  const saved = JSON.stringify(budget?.policy ?? null);
  const applied = useRef(saved);
  const [draft, setDraft] = useState(() => budgetDraft(budget?.policy));
  const draftRef = useRef(draft);
  const baseline = useRef(JSON.stringify(draft));
  const requested = useRef(baseline.current);
  const [pending, setPending] = useState(0);
  const [error, setError] = useState('');
  const [savedRecently, setSavedRecently] = useState(false);
  const savedTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const queue = useRef(Promise.resolve());
  const inFlight = useRef(0);
  const removing = useRef(false);
  const badNumbers = useRef(new Set<string>());
  const mounted = useRef(true);
  const dirty = JSON.stringify(draft) !== baseline.current;
  useUiUpdateBlocker(() => dirty || !!pending || !!inFlight.current, 'api-budget');
  useEffect(() => {
    // Live spending updates must not replace an in-progress configuration draft.
    if (!inFlight.current && saved !== applied.current) {
      applied.current = saved;
      const next = budgetDraft(budget?.policy);
      if (JSON.stringify(draftRef.current) === baseline.current) {
        draftRef.current = next;
        setDraft(next);
        requested.current = JSON.stringify(next);
      }
      baseline.current = JSON.stringify(next);
    }
  }, [saved, pending]);
  const change = <K extends keyof typeof draft>(field: K, value: (typeof draft)[K], immediate = false) => {
    if (blocked || removing.current) return;
    if (field === 'monthly' && !value) badNumbers.current.delete('monthlyUsd');
    draftRef.current = { ...draftRef.current, [field]: value };
    setDraft(draftRef.current);
    setError('');
    setSavedRecently(false);
    if (immediate) void save();
  };
  function save(action: 'save' | 'remove' | 'reset' = 'save') {
    if (blocked || removing.current) return;
    const snapshot = draftRef.current;
    const key = JSON.stringify(snapshot);
    if (action !== 'remove' && badNumbers.current.size) {
      if (mounted.current) setError('额度和每次预留必须是大于 0 的金额。');
      return;
    }
    if (action === 'save' && key === requested.current) return;
    let body: null | (Omit<ApiBudgetPolicy, 'startedAt'> & { reset?: boolean });
    try {
      body =
        action === 'remove'
          ? null
          : { ...budgetInput(snapshot, budget?.policy), ...(action === 'reset' ? { reset: true } : {}) };
    } catch (error) {
      if (mounted.current) setError(readableError(error));
      return;
    }
    requested.current = key;
    removing.current = action === 'remove';
    inFlight.current++;
    if (mounted.current) {
      setPending(inFlight.current);
      setError('');
      setSavedRecently(false);
    }
    // Serialize snapshots: blur, Enter and unmount share one request, while later edits keep their order.
    queue.current = queue.current.then(async () => {
      let committed = false;
      try {
        await api(`/api/api-providers/${encodeURIComponent(provider.targetId)}/budget`, body, 'PUT');
        committed = true;
        baseline.current = key;
        if (action === 'remove') {
          const empty = budgetDraft();
          baseline.current = requested.current = JSON.stringify(empty);
          badNumbers.current.clear();
          draftRef.current = empty;
          if (mounted.current) setDraft(empty);
        }
        await reload();
        if (mounted.current) {
          if (action === 'remove') notify({ tone: 'success', message: '已清除额度。' });
          else if (key === JSON.stringify(draftRef.current) && inFlight.current === 1) {
            setSavedRecently(true);
            clearTimeout(savedTimer.current);
            savedTimer.current = setTimeout(() => setSavedRecently(false), 2000);
          }
        }
      } catch (error) {
        const message = readableError(error);
        if (!committed && requested.current === key) requested.current = baseline.current;
        if (mounted.current) setError(committed ? `额度已保存，但刷新失败：${message}` : message);
        if (!committed && message === '请等这个 API 的运行结束后再修改预算。') await reload().catch(() => undefined);
      } finally {
        if (action === 'remove') removing.current = false;
        inFlight.current--;
        if (mounted.current) setPending(inFlight.current);
      }
    });
    return queue.current;
  }
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(savedTimer.current);
      void saveRef.current();
    };
  }, []);
  async function restartCountdown() {
    if (
      await confirmDialog({
        title: '从现在重新倒数？',
        summary: '这会把已用清零，按当前填写的额度重新倒数。历史用量记录保留。',
        action: '从现在重新倒数',
      })
    ) {
      if (mounted.current) void saveRef.current('reset');
    }
  }
  return (
    <>
      <details className="target-advanced">
        <summary>
          额度与到期{budget?.policy.limitUsd || budget?.policy.expiresAt ? '' : '（可选）'}
          {savedRecently && (
            <small className="api-budget-saved" role="status">
              已保存
            </small>
          )}
        </summary>
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
        {runtimeBusy && <p className="quiet-text">请等这个 API 的运行结束后再修改预算。</p>}
        <form
          className="target-body"
          noValidate
          onInputCapture={(event) => {
            const input = event.target;
            if (input instanceof HTMLInputElement && input.type === 'number') {
              if (input.validity.badInput) badNumbers.current.add(input.name);
              else badNumbers.current.delete(input.name);
            }
          }}
          onBlur={(event) => {
            if (event.target instanceof HTMLInputElement && event.target.type === 'number') void save();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
              event.preventDefault();
              void save();
            }
          }}
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <fieldset className="settings-fields" disabled={blocked || removing.current} aria-busy={!!pending}>
            <div className="fields-grid two">
              <label className="field">
                <span>额度（美元）</span>
                <input
                  type="number"
                  min="0"
                  step="any"
                  placeholder="如 200"
                  name="limitUsd"
                  value={draft.limitUsd}
                  onChange={(event) => change('limitUsd', event.target.value)}
                />
              </label>
              <label className="field">
                <span>到期日（可留空）</span>
                <input
                  type="date"
                  value={draft.expiresAt}
                  onChange={(event) => change('expiresAt', event.target.value, true)}
                />
              </label>
            </div>
            <p className="quiet-text">
              填控制台里显示的剩余金额，PugPort 从现在起按估算费用倒数，快到期时优先用它。储值没有期限就只填金额。
            </p>
            <div className="exec-option">
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={draft.monthly}
                  onChange={(event) => change('monthly', event.target.checked, true)}
                />
                <span>每月续期赠金</span>
              </label>
              <small>
                如 ChatGPT Pro 每月送的 API 额度。到期日填下次续费日；到期后自动恢复为每月额度，没用完的不累计。
              </small>
            </div>
            {draft.monthly && (
              <label className="field">
                <span>每月额度（美元）</span>
                <input
                  type="number"
                  min="0"
                  step="any"
                  required
                  name="monthlyUsd"
                  value={draft.monthlyUsd}
                  onChange={(event) => change('monthlyUsd', event.target.value)}
                />
              </label>
            )}
            {draft.monthly && (
              <label className="field">
                <span>关联账号</span>
                <select
                  value={draft.linkedAccountId}
                  onChange={(event) => change('linkedAccountId', event.target.value, true)}
                >
                  <option value="">不关联</option>
                  {(state?.runtimes ?? [])
                    .filter(
                      (runtime) =>
                        runtime.id === draft.linkedAccountId ||
                        (runtime.authMode === 'chatgpt' && !!runtime.subscription),
                    )
                    .map((runtime) => (
                      <option key={runtime.id} value={runtime.id} translate="no">
                        {shownName(runtime.label)}
                        {runtime.subscription ? ` · ${runtime.subscription.label}` : ''}
                      </option>
                    ))}
                </select>
                <small className="quiet-text">
                  关联送赠金的会员账号。它显示不是付费会员（如
                  Pro、Plus）时，赠金马上暂停、到期也不续；恢复后自动接着用。
                </small>
              </label>
            )}
            <details className="target-advanced">
              <summary>调度细节</summary>
              <div className="fields-grid two">
                <label className="field">
                  <span>每次任务预留（美元）</span>
                  <input
                    type="number"
                    min="0"
                    step="any"
                    required
                    name="perRunUsd"
                    value={draft.perRunUsd}
                    onChange={(event) => change('perRunUsd', event.target.value)}
                  />
                </label>
                <label className="field">
                  <span>平时同时跑几个</span>
                  <input
                    type="number"
                    min="1"
                    max="16"
                    step="1"
                    required
                    name="maxConcurrentRuns"
                    value={draft.maxConcurrentRuns}
                    onChange={(event) => change('maxConcurrentRuns', event.target.value)}
                  />
                </label>
                <label className="field">
                  <span>快到期时最多同时跑几个</span>
                  <input
                    type="number"
                    min="1"
                    max="16"
                    step="1"
                    required
                    name="burstConcurrentRuns"
                    value={draft.burstConcurrentRuns}
                    onChange={(event) => change('burstConcurrentRuns', event.target.value)}
                  />
                </label>
              </div>
              <div className="exec-option">
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={draft.preferExpiring}
                    onChange={(event) => change('preferExpiring', event.target.checked, true)}
                  />
                  <span>快到期时优先用它并提速</span>
                </label>
                <small>剩不到 7 天优先，不到 3 天加快，最后一天全力用完；仍受全局并发上限约束。</small>
              </div>
              {budget && (
                <button
                  type="button"
                  className="button quiet tiny"
                  disabled={blocked || removing.current}
                  onClick={() => void restartCountdown()}
                >
                  从现在重新倒数
                </button>
              )}
              <p className="quiet-text">
                费用是本地估算，不是平台账单。已发出的请求可能超过预留金额；硬性上限请在平台控制台设置。
              </p>
            </details>
            <div className="exec-actions">
              {budget && (
                <button
                  type="button"
                  className="button quiet tiny"
                  disabled={blocked || removing.current}
                  onClick={() => void save('remove')}
                >
                  清除额度
                </button>
              )}
            </div>
          </fieldset>
        </form>
      </details>
    </>
  );
}

function apiDeadline(budget: ApiBudgetView, now: number) {
  const expires = budget.policy.expiresAt ? Date.parse(budget.policy.expiresAt) : NaN;
  const days = Number.isFinite(expires) ? (expires - now) / 86_400_000 : undefined;
  const expired = budget.phase === 'expired' || (days !== undefined && days <= 0);
  const day = Number.isFinite(expires)
    ? new Date(expires).toLocaleDateString(currentLocale(), { year: 'numeric', month: 'numeric', day: 'numeric' })
    : '';
  const monthly = budget.policy.monthlyUsd;
  const deadline =
    days === undefined
      ? '没有到期日'
      : expired || days <= 0
        ? monthly
          ? '赠金暂停 · 关联账号确认是付费会员后自动恢复'
          : `${day} 已到期`
        : monthly
          ? `${day} 重置为 ${money(monthly, 'USD')} · 还剩 ${Math.max(1, Math.floor(days))} 天`
          : days < 1
            ? `${day} 到期 · 不到 1 天`
            : `${day} 到期 · 还剩 ${Math.floor(days)} 天`;
  return { days, deadline, expired };
}

/** Local credit includes reservations; absent estimates must never become a fabricated zero. */
export function apiCredit(budget: ApiBudgetView | undefined, now = Date.now()) {
  const limit = budget?.policy.monthlyUsd ?? budget?.policy.limitUsd;
  if (!budget || limit === undefined || !Number.isFinite(limit) || limit <= 0) return undefined;
  const { days, deadline, expired } = apiDeadline(budget, now);
  const left = expired ? 0 : Number.isFinite(budget.remainingUsd) ? Math.max(0, budget.remainingUsd!) : undefined;
  const percent = left === undefined ? undefined : Math.max(0, Math.min(100, (left / limit) * 100));
  return {
    limit,
    left,
    percent,
    days,
    deadline,
    tone: percent === undefined ? '' : percent <= 10 ? 'danger' : percent <= 30 ? 'warning' : 'healthy',
  };
}

function ApiBudgetSummary({ provider }: { provider: ApiProviderView }) {
  const budget = provider.budget;
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!budget?.policy.expiresAt) return;
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [budget?.policy.expiresAt]);
  if (!budget) return null;
  const credit = apiCredit(budget, Math.max(now, Date.now()));
  if (!credit && !budget.policy.expiresAt) return null;
  const deadline = credit?.deadline ?? apiDeadline(budget, Math.max(now, Date.now())).deadline;
  const remainingText =
    credit?.left === undefined
      ? translateInterfaceText('剩余额度未知')
      : budget.policy.monthlyUsd
        ? withNames('{0} 剩余，本月共 {1}', [money(credit.left, 'USD'), money(credit.limit, 'USD')])
        : withNames('{0} 剩余', [money(credit.left, 'USD')]);
  return (
    <div className={`quota-window api-credit ${credit?.tone ?? ''}`}>
      {credit && (
        <>
          <div className="quota-window-heading">
            {/* The monthly total is already in the remaining text; repeating it here read as a contradiction. */}
            <span>{budget.policy.monthlyUsd ? '本月额度' : <>本地额度 {money(credit.limit, 'USD')}</>}</span>
            <strong translate="no">{remainingText}</strong>
          </div>
          <div
            className={`quota-track${credit.percent === undefined ? ' unknown-track' : ''}`}
            role="progressbar"
            aria-label={withNames('{0} 本地额度剩余', [shownName(provider.label)])}
            data-names
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={credit.percent === undefined ? undefined : Math.round(credit.percent)}
            aria-valuetext={remainingText}
          >
            {credit.percent !== undefined && <span style={{ width: `${credit.percent}%` }} />}
          </div>
        </>
      )}
      <span className="reset-time">
        <Clock size={11} />
        {deadline}
      </span>
      <small className="api-credit-note">
        本地估算，非平台余额
        {budget.reservedUsd > 0 && <> · 已预留 {money(budget.reservedUsd, 'USD')}</>}
        {budget.unreportedRuns > 0 && <> · {budget.unreportedRuns} 次费用未知</>}
      </small>
      {(budget.phase === 'expired' || budget.phase === 'exhausted') && (
        <small className="api-credit-note">
          额度已用完或暂停：钉选时也不会按次计费。要按次付费，请在设置里清除额度。
        </small>
      )}
    </div>
  );
}

/** DeepSeek web search is a separate credential; this only offers to reuse the card's key, server-side. */
function DeepSeekSearchLine({ provider, api, notify }: Pick<Props, 'api' | 'notify'> & { provider: ApiProviderView }) {
  const [view, setView] = useState<WebSearchView>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void api<WebSearchView>('/api/web-search', undefined, 'GET').then(setView, () => undefined);
  }, [api]);
  if (!view) return null;
  const connected = view.enabled && view.configured;
  return (
    <p className="quiet-text">
      {connected ? '网页搜索已连接（扩展 → 连接 → 网页搜索），搜索费用单独计算。' : '网页搜索未连接。'}{' '}
      {!connected && (
        <button
          type="button"
          className="button secondary tiny"
          disabled={busy || !provider.keyHint}
          onClick={async () => {
            setBusy(true);
            try {
              setView(
                await api<WebSearchView>(
                  `/api/api-providers/${encodeURIComponent(provider.targetId)}/web-search`,
                  {},
                  'POST',
                ),
              );
              notify({ tone: 'success', message: '已用这个 Key 开启网页搜索。' });
            } catch (error) {
              notify({ tone: 'error', message: readableError(error) });
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy && <Loader2 size={12} className="spinning" />}用这个 Key 开启网页搜索
        </button>
      )}
    </p>
  );
}

function ApiRow({
  provider,
  target,
  snapshot,
  usage,
  ...props
}: Props & {
  provider: ApiProviderView;
  target: RuntimeTarget;
  snapshot?: RuntimeSnapshot;
  usage?: { runs: number; totalTokens: number | null; estimatedCostUsd: number | null };
}) {
  const preset = apiPreset(provider.preset);
  const connection = provider.connection;
  const priced = provider.preset !== 'custom-api' || !!connection?.price;
  const [busy, setBusy] = useState('');
  const [key, setKey] = useState('');
  const [workspace, setWorkspace] = useState(provider.workspaceId ?? '');
  // The workspace can be filled in automatically after the card is shown.
  useEffect(() => setWorkspace(provider.workspaceId ?? ''), [provider.workspaceId]);
  const act = async (name: string, run: () => Promise<unknown>, done?: string) => {
    setBusy(name);
    try {
      await run();
      await props.reload();
      if (done) props.notify({ tone: 'success', message: done });
    } catch (error) {
      props.notify({ tone: 'error', message: readableError(error) });
    } finally {
      setBusy('');
    }
  };
  const id = encodeURIComponent(provider.targetId);
  const [currency, toggleCurrency] = useCurrency(provider.targetId, provider.currency);
  // Costs are estimated in USD from catalog prices; voice tidying adds its own usage.
  // A budget measures spending since its current credit period began, not lifetime usage.
  const costKnown = provider.budget
    ? Number.isFinite(provider.budget.spentUsd)
    : priced && (usage ? Number.isFinite(usage.estimatedCostUsd) : Number.isFinite(provider.extra?.costUsd));
  const costUsd = provider.budget?.spentUsd ?? (usage?.estimatedCostUsd ?? 0) + (provider.extra?.costUsd ?? 0);
  const totalTokens = (usage?.totalTokens ?? 0) + (provider.extra?.tokens ?? 0);
  const cost = money(convert(costUsd, 'USD', currency), currency);
  const balance = provider.balance?.amounts
    ?.map((item) => money(convert(item.total, item.currency, currency), currency))
    .join(' / ');
  const switcher = (
    <button
      type="button"
      className="currency-toggle"
      title={`切换为${currency === 'CNY' ? '美元' : '人民币'}显示`}
      aria-label={`切换为${currency === 'CNY' ? '美元' : '人民币'}显示`}
      onClick={(event) => {
        event.stopPropagation();
        toggleCurrency();
      }}
    >
      <span className={currency === 'CNY' ? 'on' : ''}>¥</span>
      <span className={currency === 'USD' ? 'on' : ''}>$</span>
    </button>
  );
  // The balance endpoint is free, so opening the card refreshes a missing or stale balance.
  const refreshBalance = () => {
    const age = provider.balance ? Date.now() - Date.parse(provider.balance.observedAt) : Infinity;
    if (preset?.balance && provider.keyHint && age > 10 * 60_000 && !busy)
      void act('balance', () => props.api(`/api/api-providers/${id}/balance`, {}));
  };
  return (
    <Row
      mark={<span className="provider-mark small provider-api">{(preset?.label ?? provider.label).slice(0, 1)}</span>}
      name={<strong translate="no">{shownName(provider.label)}</strong>}
      detail={[
        provider.unavailable
          ? runtimeLabels.error
          : !provider.keyHint
            ? '缺少 Key'
            : snapshot
              ? runtimeLabels[snapshot.status]
              : '检查中',
        snapshot?.models.length ? `${snapshot.models.length} 个模型` : '',
        provider.keyHint ? `Key ${provider.keyHint}` : '',
      ]
        .filter(Boolean)
        .join(' · ')}
      metric={
        <span className="exec-money">
          {balance && <b>余额 {balance}</b>}
          <span
            title={
              connection
                ? connection.price
                  ? '按你填写的单价本地估算，可能与账单不同。'
                  : '未设置单价，费用未知，不能设置本地预算。'
                : currency === 'CNY'
                  ? `按官方单价估算 · 1 美元≈${USD_TO_CNY} 元`
                  : '按官方单价估算'
            }
          >
            {costKnown ? <>已用 {cost}</> : '费用未知'}
          </span>
        </span>
      }
      summary={
        <>
          <ApiBudgetSummary provider={provider} />
          {provider.unavailable && (
            <p className="inline-error" role="status">
              {provider.unavailable}
            </p>
          )}
        </>
      }
      enabled={provider.enabled}
      onEnabled={(enabled) => void act('enabled', () => props.api(`/api/targets/${id}`, { enabled }, 'PATCH'))}
      onOpen={refreshBalance}
    >
      <div className="exec-stats-head">
        <CardName
          as="strong"
          label={provider.label}
          onRename={(label) => props.api(`/api/targets/${id}`, { label }, 'PATCH').then(props.reload)}
        />
        {switcher}
      </div>
      {preset?.id === 'deepseek' && <DeepSeekSearchLine provider={provider} api={props.api} notify={props.notify} />}
      {preset?.id === 'meta-model-api' && (
        <p className="quiet-text">API 按 Meta 的价格计费，与 Muse 网页版登录分开。</p>
      )}
      <dl className="exec-stats">
        {balance && (
          <div>
            <dt>余额</dt>
            <dd>
              {balance}
              {preset?.balance && (
                <button
                  type="button"
                  className="icon-button tiny"
                  title="查询余额"
                  disabled={!!busy || !provider.keyHint}
                  onClick={() => void act('balance', () => props.api(`/api/api-providers/${id}/balance`, {}))}
                >
                  {busy === 'balance' ? <Loader2 size={12} className="spinning" /> : <RefreshCw size={12} />}
                </button>
              )}
            </dd>
            {provider.balance && (
              <small>{provider.balance.error ?? `更新于 ${dateLabel(provider.balance.observedAt)}`}</small>
            )}
          </div>
        )}
        <div>
          <dt>累计用量</dt>
          <dd>{tokens(totalTokens)} tokens</dd>
          <small>
            {usage?.runs ?? 0} 次任务{provider.extra?.calls ? ` · 语音整理 ${provider.extra.calls} 次` : ''}
          </small>
        </div>
      </dl>
      {provider.connectionError && (
        <p className="inline-error" role="alert">
          {provider.connectionError}
        </p>
      )}
      {connection && (
        <dl className="exec-stats api-connection-details">
          <div>
            <dt>协议</dt>
            <dd>{apiProtocols[connection.protocol]}</dd>
          </div>
          <div>
            <dt>Endpoint</dt>
            <dd>{connection.baseUrl}</dd>
          </div>
          <div>
            <dt>{connection.protocol === 'azure-openai-responses' ? '部署名称' : '模型 ID'}</dt>
            <dd>{connection.model}</dd>
          </div>
          <div>
            <dt>单价（USD / 100 万 tokens）</dt>
            <dd>
              {connection.price ? `输入 ${connection.price.input} · 输出 ${connection.price.output}` : '费用未知'}
            </dd>
          </div>
          {connection.limits && props.state.app.platform === 'darwin' && (
            <div>
              <dt>上下文 / 输出上限（tokens）</dt>
              <dd>
                {(connection.limits.contextWindow ?? apiLimitDefaults.contextWindow).toLocaleString('en-US')} /{' '}
                {(connection.limits.maxTokens ?? apiLimitDefaults.maxTokens).toLocaleString('en-US')}
              </dd>
            </div>
          )}
        </dl>
      )}
      {priced ? (
        <ApiBudgetSettings provider={provider} blocked={!!busy} {...props} />
      ) : (
        <p className="quiet-text">未设置单价，费用未知，不能设置本地预算。</p>
      )}
      <div className="exec-actions">
        {provider.console && (
          <a className="button secondary tiny" href={provider.console} target="_blank" rel="noreferrer">
            <ExternalLink size={12} />
            控制台
          </a>
        )}
        <input
          type="password"
          className="exec-key"
          aria-label={withNames('{0} 新 Key', [shownName(provider.label)])}
          placeholder={translateInterfaceText('粘贴新 Key 以替换')}
          data-names
          autoComplete="off"
          value={key}
          onChange={(event) => setKey(event.target.value)}
        />
        <button
          type="button"
          className="button secondary tiny"
          disabled={!!busy || !key.trim()}
          onClick={() =>
            void act(
              'key',
              () => props.api(`/api/api-providers/${id}/key`, { key }, 'PUT').then(() => setKey('')),
              'Key 已更换。',
            )
          }
        >
          <KeyRound size={12} />
          更换
        </button>
        <button
          type="button"
          className="button quiet tiny danger-text"
          disabled={!!busy}
          onClick={async () => {
            if (
              await confirmDialog({
                title: '移除 {0}？',
                names: [shownName(provider.label)],
                summary: 'Key 从本机删除，历史记录保留。',
                action: '移除提供方',
                tone: 'danger',
              })
            )
              void act('remove', () => props.api(`/api/api-providers/${id}`, undefined, 'DELETE'), '已移除。');
          }}
        >
          <Trash2 size={12} />
          移除
        </button>
      </div>
      <details className="target-advanced">
        <summary>高级</summary>
        {!balance && preset?.balance && (
          <button
            type="button"
            className="button secondary tiny"
            disabled={!!busy || !provider.keyHint}
            onClick={() => void act('balance', () => props.api(`/api/api-providers/${id}/balance`, {}))}
          >
            查询余额
          </button>
        )}
        {provider.preset === 'anthropic' && (
          <div className="exec-actions api-workspace">
            <input
              className="exec-key"
              aria-label={withNames('{0} 工作区 ID', [shownName(provider.label)])}
              placeholder={translateInterfaceText('工作区 ID（Key 没绑定工作区时填，如 wrkspc_…）')}
              data-names
              autoComplete="off"
              spellCheck={false}
              value={workspace}
              onChange={(event) => setWorkspace(event.target.value)}
            />
            <button
              type="button"
              className="button secondary tiny"
              disabled={!!busy || workspace.trim() === (provider.workspaceId ?? '')}
              onClick={() =>
                void act(
                  'workspace',
                  () => props.api(`/api/api-providers/${id}/workspace`, { workspaceId: workspace.trim() }, 'PUT'),
                  workspace.trim() ? '工作区 ID 已保存，正在重新检查连接。' : '已清除工作区 ID。',
                )
              }
            >
              保存
            </button>
          </div>
        )}
        {provider.preset === 'anthropic' && !provider.workspaceId && provider.workspaceLookup && (
          <p className="quiet-text api-workspace-lookup">{workspaceLookupText(provider.workspaceLookup)}</p>
        )}
        <TargetEditor embedded target={target} snapshot={snapshot} {...props} />
      </details>
    </Row>
  );
}

/** Why the workspace was not filled in by itself, in words the user can act on. */
function workspaceLookupText(lookup: NonNullable<ApiProviderView['workspaceLookup']>) {
  if (lookup.outcome === 'refused')
    return `没能自动填上：平台不让这把 Key 查看工作区列表（${lookup.status}）。请手动填写，或新建 Key 时选一个工作区。`;
  if (lookup.outcome === 'several') return `找到 ${lookup.count} 个工作区，没法确定用哪个，请手动填写。`;
  if (lookup.outcome === 'none') return '这把 Key 下没有可用的工作区，请到控制台检查。';
  return '自动查找工作区时连不上平台，请检查网络后再测一次。';
}

export function FreeSourceRow({
  provider,
  snapshot,
  ...props
}: Props & { provider: ApiProviderView; snapshot?: RuntimeSnapshot }) {
  const [key, setKey] = useState('');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const preset = apiPreset(provider.preset)!;
  const id = encodeURIComponent(provider.targetId);
  const cooldown = provider.cooldown;
  const minutes = cooldown?.retryAt ? Math.max(1, Math.ceil((Date.parse(cooldown.retryAt) - Date.now()) / 60000)) : 0;
  const status =
    cooldown?.reason === 'authentication'
      ? '需要更换密钥'
      : cooldown?.reason === 'quota' && minutes
        ? `限流中 · 约 ${minutes} 分钟后恢复`
        : provider.detected
          ? `已发现 ${provider.modelCount ?? 0} 个模型`
          : snapshot?.status === 'auth-required'
            ? '需要密钥'
            : '暂未发现模型';
  async function act(work: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    try {
      await work();
      await props.reload();
    } catch (error) {
      props.notify({ tone: 'error', message: readableError(error) });
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="free-source-row">
      <div className="setting-row">
        <div className="setting-label">
          <strong translate="no">{shownName(provider.label)}</strong>
          <small>{status}</small>
          {provider.unavailable && <small role="status">{provider.unavailable}</small>}
        </div>
        <div className="setting-control">
          {provider.mayLog &&
            (preset.termsUrl ? (
              <a className="quota-chip" href={preset.termsUrl} title={preset.termsUrl} target="_blank" rel="noreferrer">
                可能被记录
              </a>
            ) : (
              <span className="quota-chip" title="请向此地址的运营方确认隐私条款。">
                可能被记录
              </span>
            ))}
          <button
            type="button"
            className="icon-button"
            aria-label="检查来源"
            title="检查来源"
            disabled={busy}
            onClick={() => void act(() => props.api(`/api/free-sources/${id}/probe`, {}))}
          >
            <RefreshCw size={14} />
          </button>
          {!preset.local && (
            <button
              type="button"
              className="icon-button"
              aria-label="更换密钥"
              title="更换密钥"
              disabled={busy}
              onClick={() => setEditing(!editing)}
            >
              <KeyRound size={14} />
            </button>
          )}
          <button
            type="button"
            className="icon-button"
            aria-label="移除来源"
            title="移除来源"
            disabled={busy}
            onClick={() => void act(() => props.api(`/api/api-providers/${id}`, undefined, 'DELETE'))}
          >
            <Trash2 size={14} />
          </button>
          <label className="switch" title={provider.enabled ? '停用' : '启用'}>
            <input
              type="checkbox"
              role="switch"
              aria-label={withNames('启用 {0}', [shownName(provider.label)])}
              data-names
              checked={provider.enabled}
              disabled={busy}
              onChange={(event) =>
                void act(() => props.api(`/api/targets/${id}`, { enabled: event.target.checked }, 'PATCH'))
              }
            />
            <span />
          </label>
        </div>
      </div>
      {editing && (
        <div className="setting-row">
          <label className="field">
            <span>新密钥</span>
            <input type="password" autoComplete="off" value={key} onChange={(event) => setKey(event.target.value)} />
          </label>
          <button
            type="button"
            className="button secondary"
            disabled={busy || !key.trim()}
            onClick={() =>
              void act(async () => {
                await props.api(`/api/api-providers/${id}/key`, { key }, 'PUT');
                setKey('');
                setEditing(false);
              })
            }
          >
            保存
          </button>
        </div>
      )}
    </div>
  );
}

const accountProviders: Record<string, string> = {
  codex: 'Codex',
  claude: 'Claude',
  grok: 'Grok',
  cursor: 'Cursor',
};
type AddKind = 'cli' | 'api' | 'free' | 'bot';
type BotId = 'muse' | 'grok-bot';
const botIds: BotId[] = ['muse', 'grok-bot'];

export function AddDialog({
  accounts,
  onClose,
  onBotAdded,
  initialKind = 'cli',
  ...props
}: Props & {
  accounts?: NativeAccountsState;
  onClose: () => void;
  onBotAdded?: () => void;
  initialKind?: AddKind;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [kind, setKind] = useState<AddKind>(initialKind);
  const [provider, setProvider] = useState('codex');
  const [preset, setPreset] = useState(initialKind === 'free' ? freePresets[0]!.id : apiPresets[0]!.id);
  const [label, setLabel] = useState('');
  const [workspace, setWorkspace] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [mayLog, setMayLog] = useState(true);
  const [key, setKey] = useState('');
  const [connection, setConnection] = useState({
    protocol: 'azure-openai-responses' as ApiConnection['protocol'],
    baseUrl: '',
    model: '',
    inputPrice: '',
    outputPrice: '',
    contextWindow: '',
    maxTokens: '',
  });
  const [withBudget, setWithBudget] = useState(false);
  const [budget, setBudget] = useState(() => budgetDraft());
  const [error, setError] = useState('');
  const errorRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (error) errorRef.current?.scrollIntoView({ block: 'nearest' });
  }, [error]);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const [bot, setBot] = useState<BotId>('muse');
  const [botAgents, setBotAgents] = useState<ExternalAgentView[]>();
  const [botLoading, setBotLoading] = useState(false);
  const [botLoadError, setBotLoadError] = useState('');
  const [botLoadAttempt, setBotLoadAttempt] = useState(0);
  const [museUrl, setMuseUrl] = useState(externalAgentCatalog.muse.defaultUrl ?? '');
  const [grokBotId, setGrokBotId] = useState('');
  useEffect(() => ref.current?.showModal(), []);
  useEffect(() => {
    if (kind !== 'bot') return;
    let live = true;
    setBotLoading(true);
    setBotLoadError('');
    void props.api<{ agents: ExternalAgentView[] }>('/api/external-agents', undefined, 'GET').then(
      ({ agents }) => {
        if (!live) return;
        if (!Array.isArray(agents) || botIds.some((id) => !agents.some((agent) => agent.id === id))) {
          setBotLoadError('Bot 列表不完整，请重试。');
          setBotLoading(false);
          return;
        }
        setBotAgents(agents);
        setBot((current) => {
          if (agents.some((agent) => agent.id === current && agent.added === false)) return current;
          return botIds.find((id) => agents.some((agent) => agent.id === id && agent.added === false)) ?? current;
        });
        setMuseUrl(agents.find((agent) => agent.id === 'muse')?.url || externalAgentCatalog.muse.defaultUrl || '');
        setGrokBotId(agents.find((agent) => agent.id === 'grok-bot')?.botId ?? '');
        setBotLoading(false);
      },
      (error) => {
        if (!live) return;
        setBotLoadError(readableError(error));
        setBotLoading(false);
      },
    );
    return () => {
      live = false;
    };
  }, [kind, props.api, botLoadAttempt]);
  const supported = (id: string) => accounts?.providers.some((item) => item.id === id && item.supported);
  const chosen = apiPreset(preset)!;
  const customApi = kind === 'api' && preset === 'custom-api';
  // Context and output limits are a macOS setting; the server ignores them on other systems.
  const customLimits = customApi && props.state.app.platform === 'darwin';
  const selectedBot = botAgents?.find((agent) => agent.id === bot);
  const botAdded = !!selectedBot && selectedBot.added !== false;
  const submitBlocked =
    busy ||
    (kind === 'bot'
      ? botLoading || !!botLoadError || !selectedBot || botAdded || (bot === 'muse' && !museUrl.trim())
      : kind === 'free'
        ? preset === 'custom'
          ? !baseUrl.trim()
          : !chosen.keyless && !key.trim()
        : kind === 'api'
          ? !key.trim()
          : !supported(provider));
  async function submit() {
    if (submitting.current || submitBlocked) return;
    submitting.current = true;
    setBusy(true);
    setError('');
    try {
      if (kind === 'bot' && selectedBot) {
        const body: Record<string, unknown> = { added: true, enabled: true };
        if (bot === 'muse') {
          const url = museUrl.trim();
          if (!webAgentUrl(url)) throw new Error('网址要以 https:// 开头。');
          body.url = url;
          if (!selectedBot.riskAccepted) {
            if (!(await confirmDialog({ title: '添加 Muse？', ...webAgentRisk, action: '添加 Muse' }))) return;
            body.acceptRisk = true;
          }
        } else {
          const id = grokBotId.trim();
          if (id && !grokBotIdPattern.test(id)) throw new Error('Bot ID 只能包含字母、数字、下划线和连字符。');
          body.botId = id;
        }
        const result = await props.api<{ agents: ExternalAgentView[] }>(`/api/external-agents/${bot}`, body, 'PATCH');
        setBotAgents(result.agents);
        onBotAdded?.();
        props.notify({ tone: 'success', message: `${selectedBot.name} 已添加。` });
        onClose();
        return;
      } else if (kind === 'free') {
        const url = preset === 'custom' ? validateFreeBaseUrl(baseUrl) : undefined;
        await props.api('/api/free-sources', {
          preset,
          key: key.trim() || undefined,
          label: label.trim() || undefined,
          baseUrl: url,
          mayLog: preset === 'custom' ? mayLog : undefined,
        });
        props.notify({
          tone: 'success',
          message: '免费来源已添加，可以手动指定使用。',
        });
      } else if (kind === 'api') {
        if (!key.trim()) throw new Error('请输入 API Key。');
        const customConnection = customApi
          ? validateApiConnection({
              protocol: connection.protocol,
              baseUrl: connection.baseUrl,
              model: connection.model.trim(),
              ...(connection.inputPrice.trim() || connection.outputPrice.trim()
                ? {
                    price: { input: Number(connection.inputPrice), output: Number(connection.outputPrice) },
                  }
                : {}),
              ...(customLimits && (connection.contextWindow.trim() || connection.maxTokens.trim())
                ? {
                    limits: {
                      ...(connection.contextWindow.trim() ? { contextWindow: Number(connection.contextWindow) } : {}),
                      ...(connection.maxTokens.trim() ? { maxTokens: Number(connection.maxTokens) } : {}),
                    },
                  }
                : {}),
            })
          : undefined;
        if (customConnection && withBudget && !customConnection.price)
          throw new Error('设置预算前，填写输入和输出单价。');
        const customBudget = customApi && withBudget ? budgetInput(budget) : undefined;
        await props.api('/api/api-providers', {
          preset,
          key,
          label: label.trim() || undefined,
          ...(preset === 'anthropic' && workspace.trim() ? { workspaceId: workspace.trim() } : {}),
          ...(customConnection ? { connection: customConnection } : {}),
          ...(customBudget ? { budget: customBudget } : {}),
        });
        props.notify({
          tone: 'success',
          message: '{0} 已添加。',
          names: [shownName(label.trim() || chosen.label)],
        });
      } else {
        const name =
          label.trim() ||
          `${accountProviders[provider]} ${(accounts?.accounts.filter((a) => a.provider === provider).length ?? 0) + 1}`;
        // Straight to the official sign-in; the new account checks itself once sign-in finishes.
        await createAndLogin(props, provider, name, accounts?.accounts);
        props.notify({
          tone: 'info',
          message: '已创建 {0}，请在弹出的官方登录窗口里登录另一个账号。浏览器若已登录原账号，先在网页上换成另一个。',
          names: [name],
        });
      }
      await props.reload();
      onClose();
    } catch (error) {
      setError(readableError(error));
      props.notify({ tone: 'error', message: readableError(error) });
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  return (
    <dialog
      ref={ref}
      className="native-dialog"
      aria-labelledby={titleId}
      aria-busy={busy}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <form
        className="dialog-inner add-executor"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="dialog-title">
          <h2 id={titleId}>添加</h2>
          <button type="button" className="icon-button" onClick={onClose} disabled={busy} aria-label="关闭">
            <X size={18} />
          </button>
        </div>
        <div className="add-executor-scroll">
          <fieldset className="settings-fields add-executor-fields" disabled={busy}>
            <div className="segmented" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={kind === 'api'}
                disabled={busy}
                onClick={() => {
                  setKind('api');
                  setPreset(apiPresets[0]!.id);
                  setKey('');
                }}
              >
                API
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={kind === 'cli'}
                disabled={busy}
                onClick={() => setKind('cli')}
              >
                订阅账号
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={kind === 'free'}
                disabled={busy}
                onClick={() => {
                  setKind('free');
                  setPreset(freePresets[0]!.id);
                  setKey('');
                }}
              >
                免费
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={kind === 'bot'}
                disabled={busy}
                onClick={() => setKind('bot')}
              >
                Bot
              </button>
            </div>
            {kind === 'bot' ? (
              <>
                <label className="field">
                  <span>平台</span>
                  <select
                    aria-label="Bot 平台"
                    value={bot}
                    disabled={busy || botLoading || !!botLoadError}
                    onChange={(event) => setBot(event.target.value as BotId)}
                  >
                    {botIds.map((id) => {
                      const added = botAgents?.some((agent) => agent.id === id && agent.added !== false);
                      return (
                        <option key={id} value={id} disabled={added}>
                          {added ? `${externalAgentCatalog[id].name}（已添加）` : externalAgentCatalog[id].name}
                        </option>
                      );
                    })}
                  </select>
                </label>
                {botLoading ? (
                  <p className="quiet-text" role="status">
                    正在读取 Bot 列表…
                  </p>
                ) : botLoadError ? (
                  <div className="inline-error" role="alert">
                    读不到 Bot 列表：{botLoadError}
                    <button
                      type="button"
                      className="button secondary tiny"
                      onClick={() => setBotLoadAttempt((value) => value + 1)}
                    >
                      重试
                    </button>
                  </div>
                ) : botAdded ? (
                  <p className="quiet-text">已添加的 Bot 可在下方 Bot 列表里管理。</p>
                ) : bot === 'muse' ? (
                  <>
                    <label className="field">
                      <span>Muse 网址</span>
                      <input
                        aria-label="Muse 网址"
                        type="url"
                        value={museUrl}
                        maxLength={2000}
                        spellCheck={false}
                        disabled={busy}
                        onChange={(event) => setMuseUrl(event.target.value)}
                      />
                    </label>
                    <p className="quiet-text">添加后，在 Bot 列表里打开 Muse 并登录。</p>
                  </>
                ) : (
                  <>
                    <label className="field">
                      <span>Bot ID（可选）</span>
                      <input
                        aria-label="Bot ID（可选）"
                        value={grokBotId}
                        maxLength={200}
                        autoComplete="off"
                        spellCheck={false}
                        disabled={busy}
                        onChange={(event) => setGrokBotId(event.target.value)}
                      />
                    </label>
                    <p className="quiet-text">留空使用 Grok Bot 首页；添加后可在 Bot 列表里管理。</p>
                  </>
                )}
              </>
            ) : kind === 'free' ? (
              <>
                <div className="preset-grid" role="radiogroup" aria-label="免费来源">
                  {freePresets.map((item) => (
                    <button
                      type="button"
                      key={item.id}
                      role="radio"
                      aria-checked={preset === item.id}
                      className={`route-chip ${preset === item.id ? 'on' : ''}`}
                      onClick={() => {
                        setPreset(item.id);
                        setKey('');
                      }}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
                {preset === 'custom' && (
                  <>
                    <label className="field">
                      <span>自定义地址</span>
                      <input
                        value={baseUrl}
                        maxLength={2000}
                        placeholder="https://example.com/v1"
                        onChange={(event) => setBaseUrl(event.target.value)}
                      />
                    </label>
                    <label className="field">
                      <span>
                        <input type="checkbox" checked={mayLog} onChange={(event) => setMayLog(event.target.checked)} />
                        可能被记录
                      </span>
                    </label>
                  </>
                )}
                {!chosen.local && (
                  <label className="field">
                    <span>
                      {chosen.keyless ? '密钥（可选）' : '密钥'}
                      {chosen.keyPage && (
                        <a href={chosen.keyPage} target="_blank" rel="noreferrer">
                          获取密钥 <ExternalLink size={11} />
                        </a>
                      )}
                    </span>
                    <input
                      type="password"
                      autoComplete="off"
                      value={key}
                      onChange={(event) => setKey(event.target.value)}
                    />
                  </label>
                )}
                <p className="quiet-text">仅使用官方来源和你自己的密钥。</p>
              </>
            ) : kind === 'api' ? (
              <>
                <div className="preset-grid" role="radiogroup" aria-label="平台">
                  {apiPresets.map((item) => (
                    <button
                      type="button"
                      key={item.id}
                      role="radio"
                      aria-checked={preset === item.id}
                      className={`route-chip ${preset === item.id ? 'on' : ''}`}
                      onClick={() => setPreset(item.id)}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
                {preset === 'meta-model-api' && (
                  <p className="quiet-text">API 按 Meta 的价格计费，与 Muse 网页版登录分开。</p>
                )}
                {customApi && (
                  <>
                    <label className="field">
                      <span>协议</span>
                      <select
                        name="api-protocol"
                        aria-label="协议"
                        value={connection.protocol}
                        onChange={(event) =>
                          setConnection({ ...connection, protocol: event.target.value as ApiConnection['protocol'] })
                        }
                      >
                        {Object.entries(apiProtocols).map(([value, name]) => (
                          <option key={value} value={value}>
                            {name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="field">
                      <span>Endpoint</span>
                      <input
                        name="api-endpoint"
                        aria-label="Endpoint"
                        value={connection.baseUrl}
                        maxLength={2000}
                        autoComplete="off"
                        spellCheck={false}
                        inputMode="url"
                        placeholder={
                          connection.protocol === 'azure-openai-responses'
                            ? 'https://example.openai.azure.com/openai/v1/responses'
                            : 'https://example.com/v1'
                        }
                        onChange={(event) => setConnection({ ...connection, baseUrl: event.target.value })}
                      />
                    </label>
                    <label className="field">
                      <span>{connection.protocol === 'azure-openai-responses' ? '部署名称' : '模型 ID'}</span>
                      <input
                        name="api-model"
                        aria-label={connection.protocol === 'azure-openai-responses' ? '部署名称' : '模型 ID'}
                        value={connection.model}
                        maxLength={200}
                        autoComplete="off"
                        spellCheck={false}
                        onChange={(event) => setConnection({ ...connection, model: event.target.value })}
                      />
                    </label>
                  </>
                )}
                <label className="field">
                  <span>
                    API Key
                    {chosen.keyPage && (
                      <a href={chosen.keyPage} target="_blank" rel="noreferrer">
                        获取 Key <ExternalLink size={11} />
                      </a>
                    )}
                  </span>
                  <input
                    type="password"
                    name="api-key"
                    autoComplete="off"
                    value={key}
                    onChange={(event) => setKey(event.target.value)}
                    placeholder={`粘贴 ${chosen.label} 的 Key`}
                  />
                </label>
                <p className="quiet-text">
                  {customApi ? (
                    'Key 只保存在这台电脑上，只发送到你填写的 Endpoint。添加不会发送模型请求。'
                  ) : (
                    <>Key 只保存在这台电脑上，只用于调用 {chosen.label}。</>
                  )}
                </p>
                {customApi && (
                  <details className="target-advanced api-add-budget" open={withBudget || undefined}>
                    <summary>单价与预算（可选）</summary>
                    <p className="quiet-text">未填写单价时，费用未知。填写的是本地估算单价，不是平台账单。</p>
                    <div className="fields-grid two">
                      <label className="field">
                        <span>输入（USD / 100 万 tokens）</span>
                        <input
                          name="api-input-price"
                          aria-label="输入（USD / 100 万 tokens）"
                          type="number"
                          min="0"
                          step="any"
                          value={connection.inputPrice}
                          onChange={(event) => setConnection({ ...connection, inputPrice: event.target.value })}
                        />
                      </label>
                      <label className="field">
                        <span>输出（USD / 100 万 tokens）</span>
                        <input
                          name="api-output-price"
                          aria-label="输出（USD / 100 万 tokens）"
                          type="number"
                          min="0"
                          step="any"
                          value={connection.outputPrice}
                          onChange={(event) => setConnection({ ...connection, outputPrice: event.target.value })}
                        />
                      </label>
                    </div>
                    <p className="quiet-text">
                      缓存读取按输入单价估算，缓存写入按输入单价的 2 倍估算。实际账单可能不同。
                    </p>
                    <label className="check-row exec-option">
                      <input
                        type="checkbox"
                        name="api-budget"
                        checked={withBudget}
                        onChange={(event) => setWithBudget(event.target.checked)}
                      />
                      <span>设置本地预算</span>
                    </label>
                    {withBudget && (
                      <>
                        <div className="fields-grid two">
                          <label className="field">
                            <span>额度（美元）</span>
                            <input
                              name="api-budget-limit"
                              aria-label="额度（美元）"
                              type="number"
                              min="0"
                              step="any"
                              value={budget.limitUsd}
                              onChange={(event) => setBudget({ ...budget, limitUsd: event.target.value })}
                            />
                          </label>
                          <label className="field">
                            <span>到期日（可留空）</span>
                            <input
                              name="api-budget-expiry"
                              aria-label="到期日（可留空）"
                              type="date"
                              value={budget.expiresAt}
                              onChange={(event) => setBudget({ ...budget, expiresAt: event.target.value })}
                            />
                          </label>
                        </div>
                        <label className="field">
                          <span>每次任务预留（美元）</span>
                          <input
                            name="api-budget-reserve"
                            aria-label="每次任务预留（美元）"
                            type="number"
                            min="0"
                            step="any"
                            value={budget.perRunUsd}
                            onChange={(event) => setBudget({ ...budget, perRunUsd: event.target.value })}
                          />
                        </label>
                        <p className="quiet-text">
                          费用是本地估算，不是平台账单。已发出的请求可能超过预留金额；硬性上限请在平台控制台设置。
                        </p>
                      </>
                    )}
                  </details>
                )}
                {customLimits && (
                  <details className="target-advanced api-add-limits">
                    <summary>上下文与输出上限（可选）</summary>
                    <p className="quiet-text">
                      留空时使用默认值：上下文 32,768 tokens，单次输出 4,096
                      tokens。先推理再回答的模型，推理和回答共用输出上限，建议设为 32,768 或更高。
                    </p>
                    <div className="fields-grid two">
                      <label className="field">
                        <span>上下文长度（tokens）</span>
                        <input
                          name="api-context-window"
                          aria-label="上下文长度（tokens）"
                          type="number"
                          min={apiLimitRange.min}
                          max={apiLimitRange.max}
                          step="1"
                          placeholder={String(apiLimitDefaults.contextWindow)}
                          value={connection.contextWindow}
                          onChange={(event) => setConnection({ ...connection, contextWindow: event.target.value })}
                        />
                      </label>
                      <label className="field">
                        <span>单次输出上限（tokens）</span>
                        <input
                          name="api-max-tokens"
                          aria-label="单次输出上限（tokens）"
                          type="number"
                          min={apiLimitRange.min}
                          max={apiLimitRange.max}
                          step="1"
                          placeholder={String(apiLimitDefaults.maxTokens)}
                          value={connection.maxTokens}
                          onChange={(event) => setConnection({ ...connection, maxTokens: event.target.value })}
                        />
                      </label>
                    </div>
                  </details>
                )}
                {chosen.id === 'anthropic' && (
                  <label className="field">
                    <span>工作区 ID（可选）</span>
                    <input
                      value={workspace}
                      maxLength={100}
                      autoComplete="off"
                      spellCheck={false}
                      placeholder="Key 没绑定工作区时填，如 wrkspc_…"
                      onChange={(event) => setWorkspace(event.target.value)}
                    />
                  </label>
                )}
              </>
            ) : (
              <>
                <label className="field">
                  <span>平台</span>
                  <select value={provider} onChange={(event) => setProvider(event.target.value)}>
                    <option value="codex" disabled={!supported('codex')}>
                      Codex（ChatGPT 账号）
                    </option>
                    <option value="claude" disabled={!supported('claude')}>
                      Claude（Claude 订阅账号）
                    </option>
                    <option value="grok" disabled={!supported('grok')}>
                      Grok（X 账号）
                    </option>
                    <option value="cursor" disabled={!supported('cursor')}>
                      Cursor（Cursor 账号）
                    </option>
                  </select>
                </label>
                <p className="quiet-text">登录另一个订阅账号，额度用完时自动接力。原来的本机登录不受影响。</p>
              </>
            )}
            {kind !== 'bot' && (
              <label className="field">
                <span>名称（可选）</span>
                <input value={label} maxLength={60} onChange={(event) => setLabel(event.target.value)} />
              </label>
            )}
            {error && (
              <p ref={errorRef} className="inline-error" role="alert">
                {error}
              </p>
            )}
          </fieldset>
        </div>
        <div className="dialog-actions">
          <button type="button" className="button secondary" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button
            type="submit"
            className="button primary"
            disabled={submitBlocked}
            onClick={(event) => {
              event?.preventDefault();
              void submit();
            }}
          >
            {busy ? <Loader2 className="spinning" size={14} /> : <Plus size={14} />}
            {kind === 'cli' ? '创建并登录' : '添加'}
          </button>
        </div>
      </form>
    </dialog>
  );
}

/** Subscription CLIs and pay-as-you-go APIs in one compact list; each row opens for details. */
export function ExecutorsPage({
  refresh,
  refreshing,
  ...props
}: Props & { refresh: () => Promise<void>; refreshing: boolean }) {
  const { state } = props;
  const cursorUsage = useCursorUsageSetting(props);
  const cursorFallback = useCursorFallbackSetting(props);
  const [accounts, loadAccounts] = useAccounts(props.api);
  const [adding, setAdding] = useState<AddKind>();
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const addMenuRef = useRef<HTMLDivElement>(null);
  const addTriggerRef = useRef<HTMLButtonElement>(null);
  const restoreAddFocus = useRef(false);
  const addMenuId = useId();
  useEffect(() => {
    if (adding || !restoreAddFocus.current) return;
    restoreAddFocus.current = false;
    addTriggerRef.current?.focus();
  }, [adding]);
  useMenuKeys(addMenuOpen, addMenuRef, () => setAddMenuOpen(false));
  useEffect(() => {
    if (!addMenuOpen) return;
    const outside = (event: PointerEvent) => {
      if (!addMenuRef.current?.contains(event.target as Node)) setAddMenuOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [addMenuOpen]);
  const [botRefreshKey, setBotRefreshKey] = useState(0);
  const [connecting, setConnecting] = useState(false);
  const snapshot = (id: string) => state.runtimes.find((runtime) => runtime.id === id);
  const usage = (id: string) => state.usage?.byRuntime.find((item) => item.runtimeId === id);
  const cli = state.targets.filter(
    (target) =>
      cliProviders.includes(target.provider) &&
      !target.gateway &&
      target.environment !== 'wsl' &&
      showDiscoveredCli(target, snapshot(target.id)),
  );
  const paid = (state.apiProviders ?? []).filter((item) => item.tier !== 'free');
  // A one-time credit that has run out and switched its card off folds away; turning it back on brings it back.
  const ended = (item: ApiProviderView) =>
    !item.enabled && apiCreditGone(snapshot(item.targetId)?.apiBudgetState ?? item.budget, Date.now());
  const apis = paid.filter((item) => !ended(item));
  const endedApis = paid.filter(ended);
  const freeSources = (state.apiProviders ?? []).filter((item) => item.tier === 'free');
  const reload = async () => {
    await props.reload();
    await loadAccounts();
  };
  return (
    <>
      <div className="management-heading">
        <h1>{currentLocale() === 'en' ? 'Connections' : '连接'}</h1>
        <div className="heading-actions">
          <button className="button secondary" disabled={refreshing} onClick={() => void refresh()}>
            <RefreshCw size={13} className={refreshing ? 'spinning' : ''} />
            刷新
          </button>
          <div className="exec-add" ref={addMenuRef}>
            <button
              type="button"
              ref={addTriggerRef}
              className="button primary"
              aria-haspopup="menu"
              aria-expanded={addMenuOpen}
              aria-controls={addMenuId}
              onClick={() => setAddMenuOpen(!addMenuOpen)}
            >
              <Plus size={13} />
              添加
            </button>
            {addMenuOpen && (
              <div className="context-menu exec-add-menu" id={addMenuId} role="menu" aria-label="添加">
                {(
                  [
                    ['api', 'API 密钥'],
                    ['free', '免费来源'],
                    ['cli', '原生 CLI'],
                  ] as const
                ).map(([kind, label]) => (
                  <button
                    type="button"
                    role="menuitem"
                    key={kind}
                    onClick={() => {
                      // The menu item disappears; the dialog must return to a stable trigger.
                      restoreAddFocus.current = true;
                      addTriggerRef.current?.focus();
                      setAddMenuOpen(false);
                      setAdding(kind);
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
      {!hasUsableAccount(state) && (
        <section className="panel settings-section">
          <p>{state.refreshing ? '正在检查已有登录…' : '连接一个账号即可开始，已输入的消息会保留。'}</p>
          <button type="button" className="button primary" onClick={() => setConnecting(true)}>
            连接账号
          </button>
        </section>
      )}
      <section className="exec-group">
        <h2>
          订阅账号<small>自动发现本机已安装的官方客户端</small>
        </h2>
        {cli.length ? (
          cli.map((target) =>
            snapshot(target.id)?.status === 'missing' && !snapshot(target.id)?.installed ? (
              <div className="setting-row" key={target.id}>
                <span className="setting-label" translate="no">
                  {shownName(target.label)}
                </span>
                <div className="setting-control">
                  <span>未安装</span>
                  <CliConnectionAction {...props} reload={reload} target={target} snapshot={snapshot(target.id)} />
                </div>
              </div>
            ) : (
              <CliRow
                key={target.id}
                {...props}
                reload={reload}
                target={target}
                snapshot={snapshot(target.id)}
                account={accounts?.accounts.find((account) => account.runtimeId === target.id)}
                accounts={accounts?.accounts ?? []}
                usage={usage(target.id)}
                cursorUsage={cursorUsage}
                cursorFallback={cursorFallback}
              />
            ),
          )
        ) : (
          <p className="exec-empty">尚未发现本机客户端。安装后会自动发现，也可以点“刷新”立即检查。</p>
        )}
        <button type="button" className="button quiet tiny" onClick={() => setConnecting(true)}>
          安装或连接客户端
        </button>
      </section>
      <section className="exec-group">
        <h2>
          API<small>按用量计费</small>
        </h2>
        {apis.length ? (
          apis.map((provider) => {
            const target = state.targets.find((item) => item.id === provider.targetId);
            return (
              target && (
                <ApiRow
                  key={provider.targetId}
                  {...props}
                  reload={reload}
                  provider={provider}
                  target={target}
                  snapshot={snapshot(target.id)}
                  usage={usage(target.id)}
                />
              )
            );
          })
        ) : !cli.length && !freeSources.length && !endedApis.length ? (
          <button type="button" className="exec-empty add" onClick={() => setAdding('api')}>
            <Plus size={14} />
            添加 API 密钥
          </button>
        ) : null}
        {endedApis.length > 0 && (
          <details className="exec-ended">
            <summary>{withNames('已结束的赠金 · {0}', [String(endedApis.length)])}</summary>
            {endedApis.map((provider) => {
              const target = state.targets.find((item) => item.id === provider.targetId);
              return (
                target && (
                  <ApiRow
                    key={provider.targetId}
                    {...props}
                    reload={reload}
                    provider={provider}
                    target={target}
                    snapshot={snapshot(target.id)}
                    usage={usage(target.id)}
                  />
                )
              );
            })}
          </details>
        )}
      </section>
      {freeSources.length > 0 && (
        <section className="exec-group free-sources">
          <h2>
            免费模型<small>可以手动指定使用，或通过 @免费 使用免费来源接力。</small>
          </h2>
          {freeSources.map((provider) => (
            <FreeSourceRow
              key={provider.targetId}
              {...props}
              reload={reload}
              provider={provider}
              snapshot={snapshot(provider.targetId)}
            />
          ))}
        </section>
      )}
      <ExternalAgentsCard api={props.api} notify={props.notify} mode="bots" refreshKey={botRefreshKey} />
      {adding && (
        <AddDialog
          {...props}
          initialKind={adding}
          reload={reload}
          accounts={accounts}
          onBotAdded={() => setBotRefreshKey((value) => value + 1)}
          onClose={() => setAdding(undefined)}
        />
      )}
      {connecting && <ConnectAccounts {...props} reload={reload} onClose={() => setConnecting(false)} />}
    </>
  );
}
