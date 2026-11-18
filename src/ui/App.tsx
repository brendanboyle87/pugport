import { ExecutorActivity } from './ExecutorActivity';
import { useRadioKeys } from './use-radio-keys';
import { holdUiUpdate } from './ui-update-guard';
import { RunEvidence } from './RunEvidence';
import { isApiHarness, isNativeCli, providerSpec } from '../shared/provider-registry';
import { attachmentMimeType } from './attachments';
import { approvalRuleLabel } from '../shared/approval-rules';
import { targetCommandChanged } from '../shared/permission-change';
import { saveSettings } from './settings-permissions';
import { desktopBridge } from './desktop';
import { quotaPlan, quotaReadingPending } from '../shared/quota-summary';
import { effortName } from '../shared/effort';
import { MemoryDistillationSwitch } from './MemoryAuto';
import { HindsightSettingsPanel } from './HindsightSettings';
import { cursorTimeoutReference } from '../shared/runtime-health.ts';
import { compactResetLabel, quotaConnectionLabel } from './UsageQuota';
import { systemTrashName } from '../shared/trash';
import { ExecutorChecklist } from './ExecutorChecklist';
import { executorCards, validateAutomaticExecutors } from '../shared/automatic-executors';
import { isFreePreset } from '../shared/api-providers';
import { ManualResetEditor } from './ManualResetEditor';
import { executionModel } from '../shared/execution-model';
import { mergeRunEventSnapshots } from '../shared/run-events';
import { applyRunUpdate, type RunUpdate } from './run-events';
import { resetCardSuggestion, ResetCreditsSummary } from './ResetCreditsSummary';
import { QuotaAttention } from './UsageQuota';
import { quotaPeriodLabel } from '../shared/quota-label';
import { cursorModelPoolLabel } from '../shared/cursor-models';
import { SubscriptionSummary } from './SubscriptionSummary';
import { AccountQuotaDiagnostics, accountExecutionStatus, quotaRequestConflict } from './AccountQuotaDiagnostics';
import { modelOptionLabel, newModelTitle } from './model-options';
import {
  defaultLaunchArgsMode,
  formatLaunchArgs,
  linesAreLossless,
  parseLaunchArgs,
  type LaunchArgsMode,
} from './launch-args';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  Activity,
  AlertCircle,
  ArrowRight,
  Check,
  CheckCircle2,
  Clock,
  Cloud,
  Sparkles,
  Command,
  Copy,
  FolderOpen,
  GitBranch,
  Layers,
  Loader2,
  MessageSquare,
  MousePointer2,
  Play,
  RefreshCw,
  Search,
  ShieldCheck,
  Square,
  Terminal,
  X,
} from 'lucide-react';
import {
  availableCoreTargets,
  isCoreProvider,
  isCoreRuntime,
  runtimeIdentity,
  unavailableRuntimeLabel,
} from './core-runtime';
import { RunAccountSummary } from './RunAccountSummary';
import { CardName } from './CardName';
import type { SettingsCategory } from './settings-categories';
import { AppSection, SettingsFolder } from './AppSettings';
import { SettingsRow } from './SettingsRow';
import { SandboxSettings } from './SandboxSettings';
import { RoutePolicyEditor, routeOptions } from './RoutePolicyEditor';
import { RoutingProfilesSettings } from './RoutingProfilesSettings';
import { LayaSettings } from './LayaSettings';
import { routePolicy } from '../shared/route-policy';
import { TrajectoryPanel } from './Trajectory';
import { RunEventLedger } from './RunEventLedger';
import {
  executionUserInput,
  executionWorkflowRuns,
  executionChildTree,
  requestExecutionRecord,
  type ExecutionRecordRequestState,
} from './execution-records';
import { BackendStateGate } from './backend-state-gate';
import { BackendSession, defaultRequestMethod } from './backend-session';
import { currentLocale, shownName, translateInterfaceText, withNames } from './i18n';
import type {
  AppState,
  Approval,
  ModelInfo,
  Provider,
  QuotaWindow,
  RunRecord,
  RuntimeSnapshot,
  RuntimeTarget,
  Settings,
} from '../shared/types';

import type { Notice } from './Workspace';

type Api = <T>(path: string, body?: unknown, method?: string, signal?: AbortSignal) => Promise<T>;

const providerLabels: Record<Provider, string> = {
  codex: 'Codex',
  claude: 'Claude',
  grok: 'Grok',
  cursor: 'Cursor',
  gemini: 'Gemini',
  pi: 'API',
  dsh: 'DeepSeek Harness',
};
const runLabels: Record<RunRecord['status'], string> = {
  queued: '排队中',
  running: '执行中',
  'waiting-approval': '等待审批',
  completed: '已完成',
  failed: '执行失败',
  cancelled: '已取消',
  interrupted: '已中断',
};
const runtimeLabels: Record<RuntimeSnapshot['status'], string> = {
  ready: '就绪',
  unknown: '待确认',
  'auth-required': '需要登录',
  error: '连接异常',
  missing: '未安装',
  refreshing: '发现中',
};
const activeStatuses: RunRecord['status'][] = ['queued', 'running', 'waiting-approval'];

function readableError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function dateLabel(value?: string | null, timeOnly = false): string {
  if (!value) return '尚未观测';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '时间未知';
  return date.toLocaleString(
    currentLocale(),
    timeOnly
      ? { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }
      : { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false },
  );
}
function remainingPercent(window: QuotaWindow, quotaKnown: boolean): number | null {
  return quotaKnown &&
    typeof window.usedPercent === 'number' &&
    Number.isFinite(window.usedPercent) &&
    window.usedPercent >= 0 &&
    window.usedPercent <= 100
    ? 100 - window.usedPercent
    : null;
}
function ProviderMark({ provider, small = false }: { provider: Provider; small?: boolean }) {
  return (
    <span
      className={`provider-mark provider-${provider} ${small ? 'small' : ''}`}
      aria-label={providerLabels[provider]}
    >
      {provider === 'claude' ? (
        <span className="claude-star">✳</span>
      ) : provider === 'codex' ? (
        <Command size={small ? 15 : 21} />
      ) : provider === 'grok' ? (
        <span className="grok-letter">𝕏</span>
      ) : provider === 'cursor' ? (
        <MousePointer2 size={small ? 15 : 21} />
      ) : provider === 'gemini' ? (
        <span aria-hidden="true">✦</span>
      ) : provider === 'dsh' ? (
        <Layers size={small ? 15 : 21} />
      ) : (
        <Cloud size={small ? 15 : 19} />
      )}
    </span>
  );
}
function StatusPill({ status }: { status: RunRecord['status'] }) {
  return (
    <span className={`status-pill status-${status}`}>
      <span className="status-dot" />
      {runLabels[status]}
    </span>
  );
}
function EmptyState({
  title,
  detail,
  icon = 'terminal',
}: {
  title: string;
  detail: string;
  icon?: 'terminal' | 'activity' | 'search';
}) {
  const Icon = icon === 'activity' ? Activity : icon === 'search' ? Search : Terminal;
  return (
    <div className="empty-state">
      <span className="empty-icon">
        <Icon size={25} strokeWidth={1.4} />
      </span>
      <strong>{title}</strong>
      <p>{detail}</p>
    </div>
  );
}

function useBackend() {
  const [state, setState] = useState<AppState | null>(null);
  const [connection, setConnection] = useState<'connecting' | 'connected' | 'reconnecting' | 'error'>('connecting');
  const [error, setError] = useState('');
  const sessionRef = useRef(new BackendSession());
  const mounted = useRef(true);
  const stateGate = useRef(new BackendStateGate());

  const api: Api = useCallback(
    // A call without a body is a read: defaulting it to POST once sent every detail load to a missing route.
    async <T,>(path: string, body?: unknown, method = defaultRequestMethod(body), signal?: AbortSignal): Promise<T> => {
      const releaseUpdate = method.toUpperCase() === 'GET' ? () => {} : holdUiUpdate();
      try {
        // Binary bodies (attachments and recorded audio) go as they are; everything else as JSON.
        const binary = body instanceof Blob || body instanceof ArrayBuffer || ArrayBuffer.isView(body);
        const localizedBody =
          !binary && /^\/api\/(?:conversations\/[^/]+\/messages|workflows\/[^/]+\/(?:continue|rerun-write))$/.test(path)
            ? { ...(body && typeof body === 'object' ? body : {}), uiLocale: currentLocale() }
            : body;
        const response = await sessionRef.current.request(path, {
          method,
          signal,
          headers: {
            'Content-Type':
              body instanceof File
                ? attachmentMimeType(body)
                : body instanceof Blob
                  ? body.type || 'application/octet-stream'
                  : binary
                    ? 'application/octet-stream'
                    : 'application/json',
            ...(body instanceof File ? { 'x-attachment-name': encodeURIComponent(body.name) } : {}),
          },
          ...(localizedBody === undefined ? {} : { body: binary ? (body as BodyInit) : JSON.stringify(localizedBody) }),
        });
        const payload = await response.json().catch(() => ({}));
        // Slack views include a connection error even when the settings request succeeds.
        const slackView =
          path.startsWith('/api/slack') && typeof payload.enabled === 'boolean' && Array.isArray(payload.users);
        if (!response.ok || (payload.error && !slackView))
          throw Object.assign(
            new Error(typeof payload.error === 'string' ? payload.error : `请求失败（${response.status}）`),
            {
              code: typeof payload.code === 'string' ? payload.code : undefined,
              status: response.status,
            },
          );
        return payload as T;
      } finally {
        releaseUpdate();
      }
    },
    [],
  );

  const reload = useCallback(async () => {
    const snapshot = stateGate.current.beginSnapshot();
    const response = await fetch('/api/state');
    if (!response.ok) throw new Error(`无法读取工作台状态（${response.status}）`);
    const data = (await response.json()) as AppState;
    if (mounted.current && stateGate.current.accepts(snapshot)) {
      setState(data);
      setError('');
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    let alive = true;
    let events: EventSource | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let sessionGeneration = 0;
    const initialize = async () => {
      retry = undefined;
      try {
        const tokenGeneration = sessionRef.current.generation;
        const response = await fetch('/api/session');
        if (!response.ok) throw new Error('本地服务暂不可用。请检查服务进程并重试。');
        const session = (await response.json()) as { token: string };
        if (!alive) return;
        sessionRef.current.accept(tokenGeneration, session.token);
        await reload();
        if (!alive) return;
        events = new EventSource('/api/events');
        events.onopen = () => {
          const generation = ++sessionGeneration;
          const tokenGeneration = sessionRef.current.clear();
          // A recovered backend rotates its local CSRF token. Keep drafts mounted and renew the session.
          void (async () => {
            try {
              const response = await fetch('/api/session');
              if (!response.ok) throw new Error('无法恢复本地会话。');
              const value = (await response.json()) as { token: string };
              if (!alive || generation !== sessionGeneration) return;
              if (!sessionRef.current.accept(tokenGeneration, value.token)) throw new Error('无法恢复本地会话。');
              await reload();
              if (!alive || generation !== sessionGeneration) return;
              setConnection('connected');
              setError('');
            } catch (failure) {
              if (!alive || generation !== sessionGeneration) return;
              sessionRef.current.clear();
              setConnection('reconnecting');
              setError(readableError(failure));
            }
          })();
        };
        events.onerror = () => {
          sessionGeneration++;
          sessionRef.current.clear();
          setConnection('reconnecting');
          if (events?.readyState === EventSource.CLOSED && !retry) {
            events.close();
            retry = setTimeout(initialize, 5000);
          }
        };
        events.addEventListener('state', (message) => {
          try {
            const data = JSON.parse((message as MessageEvent).data) as AppState;
            stateGate.current.liveEvent();
            setState(data);
          } catch {
            setError('收到无法解析的状态数据。');
          }
        });
        events.addEventListener('run', (message) => {
          try {
            const update = JSON.parse((message as MessageEvent).data) as RunUpdate;
            stateGate.current.liveEvent();
            setState((previous) => (previous ? applyRunUpdate(previous, update) : previous));
          } catch {
            setError('收到无法解析的任务事件。');
          }
        });
      } catch (failure) {
        if (!alive) return;
        setConnection('error');
        setError(readableError(failure));
        retry = setTimeout(initialize, 5000);
      }
    };
    void initialize();
    return () => {
      alive = false;
      sessionGeneration++;
      mounted.current = false;
      events?.close();
      if (retry) clearTimeout(retry);
    };
  }, [reload]);
  return { state, setState, connection, error, api, reload };
}

const usd = (value: number | null) => (value === null || !Number.isFinite(value) ? '未知' : `$${value.toFixed(2)}`);
/** Cursor's credit grants and on-demand spending, read live from cursor.com. */
function CursorLiveCredits({
  credits,
  now,
  details = false,
}: {
  details?: boolean;
  credits: NonNullable<RuntimeSnapshot['quota']['cursorCredits']>;
  now: number;
}) {
  const expired = (at: string | null) => at !== null && Date.parse(at) <= now;
  const hasExpiredGrant = credits.grants.some((grant) => expired(grant.expiresAt));
  return (
    <div className="cursor-live-credits">
      {!details && (credits.grants.length > 0 || typeof credits.accountUsd === 'number') && (
        <div className="cursor-credit-line" aria-label="账户余额与赠送额度">
          {typeof credits.accountUsd === 'number' && (
            <span className="cursor-credit">
              {credits.accountUsd < 0 ? '账户欠款' : '账户余额'}
              <strong>{usd(Math.abs(credits.accountUsd))}</strong>
            </span>
          )}
          {credits.grants.map((grant, index) => (
            <span
              className={`cursor-credit ${expired(grant.expiresAt) ? 'cursor-credit-expired' : ''}`}
              key={`${grant.name}-${index}`}
              title={grant.totalUsd !== null ? `共 ${usd(grant.totalUsd)}` : undefined}
            >
              {grant.name === 'Event credits' ? '活动赠金' : grant.name}
              <strong>{usd(grant.remainingUsd)}</strong>
              {expired(grant.expiresAt) && <small>到期前报告</small>}
            </span>
          ))}
        </div>
      )}
      {details && credits.balanceUsd !== null && (
        <p className="cursor-credit-expiry">
          {hasExpiredGrant ? '最近报告的赠送额度余额' : '赠送额度合计剩余'} {usd(credits.balanceUsd)}
          {credits.totalUsd !== null ? `（共 ${usd(credits.totalUsd)}）` : ''}
          {hasExpiredGrant ? ' · 含已到期记录，待刷新确认' : ''}
        </p>
      )}
      {details && credits.onDemand && (
        <p className={`cursor-credit-expiry ${credits.onDemand.enabled ? 'cursor-expiry-notice' : ''}`}>
          {credits.onDemand.enabled
            ? `超额按量付费：已开启（上限 ${usd(credits.onDemand.limitUsd)}，本期已用 ${usd(credits.onDemand.usedUsd)}）`
            : '超额按量付费：已关闭'}
        </p>
      )}
    </div>
  );
}

/** Grok's extra usage credits (spent after the included limit) and whether auto top-up is on. */
function GrokExtraCredits({ credits }: { credits: NonNullable<RuntimeSnapshot['quota']['grokCredits']> }) {
  return (
    <p className="quota-note">
      额外积分 · {credits.autoTopup === null ? '未知' : credits.autoTopup ? '已开启' : '已关闭'}
      {credits.autoTopup || (credits.extraUsd ?? 0) > 0 ? ` · ${usd(credits.extraUsd)}` : ''}
    </p>
  );
}

/** A card's quota windows: remaining share, bar, and when each resets (local time). */
function QuotaWindows({ runtime, now, known }: { runtime: RuntimeSnapshot; now: number; known: boolean }) {
  const conflict = quotaRequestConflict(runtime);
  return (
    <div className="quota-windows">
      {runtime.quota.windows.map((window) => {
        const remaining = remainingPercent(window, known);
        const tone =
          remaining === null
            ? 'unknown'
            : remaining <= 10
              ? 'danger'
              : conflict || remaining <= 30
                ? 'warning'
                : 'healthy';
        return (
          <div className={`quota-window ${tone}`} key={window.id}>
            <div className="quota-window-heading" title={window.observedAt ?? runtime.quota.observedAt ?? undefined}>
              <span>{quotaPeriodLabel(window)}</span>
              <strong>
                {remaining === null ? '未知' : `${Math.round(remaining * 10) / 10}%`}
                <small>
                  {remaining === null
                    ? ''
                    : runtime.quota.grokBilling?.percentSource === 'implicit-zero'
                      ? ' 剩余（推算）'
                      : ' 剩余'}
                </small>
              </strong>
            </div>
            <div
              className={`quota-track ${remaining === null ? 'unknown-track' : ''}`}
              role={remaining === null ? undefined : 'progressbar'}
              aria-label={withNames('{0} {1}剩余额度', [
                shownName(runtime.label),
                translateInterfaceText(quotaPeriodLabel(window)),
              ])}
              data-names
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={remaining ?? undefined}
            >
              {remaining !== null && <span style={{ width: `${remaining}%` }} />}
            </div>
            <time
              className="reset-time"
              dateTime={window.resetsAt ?? undefined}
              title={
                window.resetsAt && Number.isFinite(Date.parse(window.resetsAt))
                  ? new Date(window.resetsAt).toLocaleString(currentLocale())
                  : undefined
              }
            >
              <Clock size={11} />
              {compactResetLabel(window.resetsAt, now)}
            </time>
          </div>
        );
      })}
    </div>
  );
}

function QuotaCard({
  runtime: liveRuntime,
  now,
  maxAge,
  zoomable = false,
  autoUseResetCards = false,
}: {
  runtime: RuntimeSnapshot;
  now: number;
  maxAge: number;
  zoomable?: boolean;
  autoUseResetCards?: boolean;
}) {
  const reference = liveRuntime.quota.status !== 'known' && liveRuntime.lastKnownQuota?.status === 'known';
  const runtime = reference ? { ...liveRuntime, quota: liveRuntime.lastKnownQuota! } : liveRuntime;
  const known = runtime.quota.status === 'known';
  const pending = quotaReadingPending(runtime);
  const requestStatus = accountExecutionStatus(runtime, now);
  const softTimeout = cursorTimeoutReference(liveRuntime, now);
  const displayStatus = softTimeout ? 'request-limited' : runtime.status;
  const cursorConnectionIssue =
    runtime.provider === 'cursor' && runtime.status !== 'ready' && runtime.note
      ? ((
          {
            'runtime-timeout': softTimeout ? '检查超时，显示上次读数' : 'Cursor 连接检查超时，会自动重试。',
            'runtime-network-error': 'Cursor 连接检查遇到网络错误，会自动重试。',
            'runtime-process-closed': 'Cursor 命令行在连接检查期间退出，会自动重试。',
            'runtime-request-failed': 'Cursor 连接检查失败，会自动重试。',
            'runtime-protocol-incompatible': 'Cursor CLI 返回的协议与当前适配器不兼容。',
            'authentication-required': 'Cursor CLI 需要重新登录。',
            'runtime-not-found': '没有找到 Cursor CLI，请检查启动路径。',
          } as Record<string, string>
        )[runtime.note] ?? runtime.note)
      : undefined;
  const nativeQuotaProvider = isNativeCli(runtime.provider);
  const usageOnly =
    runtime.accounting?.mode === 'usage' && !nativeQuotaProvider && !(known && runtime.quota.windows.length > 0);
  const stale = [runtime.quota.observedAt, ...runtime.quota.windows.map((window) => window.observedAt)].some(
    (value) => {
      if (!value) return false;
      const observed = Date.parse(value);
      return !Number.isFinite(observed) || observed > now || now - observed >= maxAge * 1000;
    },
  );
  const observationTime =
    usageOnly || (cursorConnectionIssue && !runtime.quota.observedAt) ? runtime.refreshedAt : runtime.quota.observedAt;
  const apiBilling =
    runtime.authMode === 'apiKey' ||
    (runtime.provider !== 'cursor' &&
      runtime.accounting?.mode === 'usage' &&
      !runtime.subscription &&
      runtime.quota.windows.length === 0);
  const planLabel = apiBilling ? 'API 按量计费' : quotaPlan(runtime)?.label;
  const resetCredits = runtime.quota.resetCredits;
  const expiredCredits = (resetCredits?.details ?? []).filter(
    (card) => card.status === 'available' && card.expiresAt !== null && Date.parse(card.expiresAt) <= now,
  ).length;
  const credits =
    typeof resetCredits?.availableCount === 'number' ? Math.max(0, resetCredits.availableCount - expiredCredits) : null;
  const resetSuggestion = known ? resetCardSuggestion(runtime, now) : undefined;
  const connectionTest = runtime.lastConnectionTest && (
    <p className={`connection-test-result ${runtime.lastConnectionTest.ok ? '' : 'failed'}`}>
      {runtime.lastConnectionTest.ok ? <CheckCircle2 size={12} /> : <AlertCircle size={12} />}
      <span>
        实际请求{runtime.lastConnectionTest.ok ? '通过' : '失败'} · {dateLabel(runtime.lastConnectionTest.at)}
        <small>
          {runtime.lastConnectionTest.model}
          {runtime.lastConnectionTest.error ? ` · ${runtime.lastConnectionTest.error}` : ''}
        </small>
      </span>
    </p>
  );
  // Every card has the same skeleton (heading, quota body, footer pinned to the bottom) so cards
  // line up in the grid; secondary facts live in the collapsible details.
  return (
    <article
      className={`quota-card ${runtime.status === 'missing' ? 'muted-card' : ''}`}
      data-runtime-id={runtime.id}
      tabIndex={zoomable ? 0 : undefined}
      role={zoomable ? 'button' : undefined}
      aria-label={zoomable ? withNames('{0} 额度详情', [shownName(runtime.label)]) : undefined}
      aria-haspopup={zoomable ? 'dialog' : undefined}
      aria-describedby={zoomable ? `${runtime.id}-quota-body` : undefined}
      data-names
    >
      <div className="quota-heading">
        <ProviderMark provider={runtime.provider} />
        <div>
          <h3 translate="no">{shownName(runtime.label)}</h3>
          <ExecutorActivity
            id={runtime.id}
            error={
              (runtime.availability?.reason !== 'quota' && requestStatus) ||
              (softTimeout
                ? '检查超时 · 显示上次读数'
                : ['error', 'auth-required', 'missing'].includes(displayStatus)
                  ? runtimeLabels[runtime.status]
                  : undefined) ||
              undefined
            }
            idle={requestStatus || runtimeLabels[runtime.status]}
            warning={!!softTimeout}
          />
        </div>
        {planLabel && <span className="plan-badge">{planLabel}</span>}
      </div>
      <>
        <div className="quota-body" id={zoomable ? `${runtime.id}-quota-body` : undefined}>
          {reference && !softTimeout && <p className="quota-note">上次报告 · 正在等待新的额度读数</p>}
          {cursorConnectionIssue && !softTimeout && (
            <p className="quota-connection-note" role="status">
              {cursorConnectionIssue}
            </p>
          )}
          {runtime.lastConnectionTest && !runtime.lastConnectionTest.ok && connectionTest}
          {usageOnly ? (
            <div className="usage-mode-card">
              <strong>按累计用量统计</strong>
              <p>{runtime.accounting?.note || '记录模型调用消耗，无需读取框架的剩余额度。'}</p>
              <span>在“累计消耗”中查看词元和参考费用</span>
            </div>
          ) : pending ? (
            <p className="quota-note" role="status">
              正在读取额度…
            </p>
          ) : runtime.quota.windows.length ? (
            <QuotaWindows runtime={runtime} now={now} known={known} />
          ) : (
            <div className="quota-unknown">
              <span>
                {known && runtime.quota.unlimited === true
                  ? '不限量'
                  : known
                    ? '额度信息'
                    : runtime.quota.status === 'error'
                      ? '额度读取失败'
                      : '额度未报告'}
              </span>
              <p>{quotaConnectionLabel(runtime.quota.note) || '尚未获取到供应商额度窗口；连接状态单独判断。'}</p>
              {!known && <div className="quota-track unknown-track" />}
            </div>
          )}
          {runtime.quota.cursorCredits && <CursorLiveCredits credits={runtime.quota.cursorCredits} now={now} />}
          {runtime.quota.grokCredits && <GrokExtraCredits credits={runtime.quota.grokCredits} />}
          <QuotaAttention runtime={runtime} now={now} />
          {resetSuggestion && <p className="quota-note">{resetSuggestion}</p>}
          <AccountQuotaDiagnostics account={runtime} now={now} hideBilling />
          {runtime.autoResetNotes?.map((note, index) => (
            <p className="quota-note" key={index}>
              {note}
            </p>
          ))}
        </div>
        <footer className="quota-footer">
          <div className="quota-footer-line">
            {(!pending || cursorConnectionIssue) &&
              (usageOnly || (cursorConnectionIssue && !runtime.quota.observedAt)) && (
                <time title={observationTime ?? ''} dateTime={observationTime ?? undefined}>
                  {usageOnly ? '发现' : '连接检查'} {dateLabel(observationTime)}
                </time>
              )}
            {typeof credits === 'number' && credits > 0 && <span className="plan-badge">重置卡 {credits}</span>}
          </div>
          <details className="quota-details">
            <summary>详情</summary>
            {runtime.quota.cursorCredits && (
              <CursorLiveCredits credits={runtime.quota.cursorCredits} now={now} details />
            )}
            {runtime.provider === 'grok' && <AccountQuotaDiagnostics account={runtime} now={now} billingOnly />}
            <SubscriptionSummary plan={quotaPlan(runtime)} usage={apiBilling} identity={runtime.accountFingerprint} />
            {runtime.lastConnectionTest?.ok && connectionTest}
            {!usageOnly && (stale || reference) && <p className="quota-note">当前显示上次报告的额度，刷新后核对。</p>}
            <div className="quota-meta">
              <span>
                <span className="metadata-key">来源</span>
                <span title={usageOnly ? runtime.accounting?.source : runtime.quota.source}>
                  {(usageOnly ? runtime.accounting?.source : runtime.quota.source) || '不可用'}
                </span>
              </span>
              <span>
                <span className="metadata-key">环境</span>
                <span>{runtime.environment === 'wsl' ? 'WSL' : '本机'}</span>
              </span>
            </div>
            {!usageOnly && runtime.quota.windows.length > 0 && runtime.quota.note && (
              <p className="quota-note">{runtime.quota.note}</p>
            )}
            {runtime.note && !softTimeout && <p className="quota-note">{runtime.note}</p>}
            {nativeQuotaProvider && runtime.provider !== 'cursor' && (
              <ResetCreditsSummary
                credits={runtime.quota.resetCredits}
                now={now}
                runtimeId={runtime.provider === 'codex' ? runtime.id : undefined}
                fingerprint={runtime.accountFingerprint}
                accountLabel={runtime.label}
                autoUseResetCards={autoUseResetCards}
              />
            )}
            {nativeQuotaProvider && runtime.provider !== 'cursor' && runtime.environment === 'native' && (
              <ManualResetEditor runtimeId={runtime.id} />
            )}
            {nativeQuotaProvider && (
              <p className="quota-note">
                {runtime.provider === 'cursor'
                  ? '在“用量与连接”的 Cursor 一项里设置“自动读取用量和赠送额度”；开启后通过编辑器登录向 cursor.com 查询，调用消耗另记在“累计消耗”。'
                  : '调用消耗另记在“累计消耗”；剩余额度以当前连接服务报告为准。'}
              </p>
            )}
          </details>
        </footer>
      </>
    </article>
  );
}

function ModelFields({
  models,
  model,
  effort,
  onModel,
  onEffort,
  disabled = false,
}: {
  models: ModelInfo[];
  model: string;
  effort: string;
  onModel: (value: string) => void;
  onEffort: (value: string) => void;
  disabled?: boolean;
}) {
  const selected = models.find((m) => m.id === model);
  return (
    <>
      <label className="field">
        <span>模型</span>
        <select
          value={model}
          disabled={disabled}
          onChange={(e) => {
            onModel(e.target.value);
            onEffort('');
          }}
        >
          <option value="">{disabled ? '由路由器选择' : '自动选择模型'}</option>
          {model && !selected && <option value={model}>{model} · 需重新确认</option>}
          {models.map((m) => (
            <option key={m.id} value={m.id} title={m.discovered ? newModelTitle : undefined}>
              {modelOptionLabel(m)}
              {m.quotaPool ? ` · ${cursorModelPoolLabel(m.quotaPool)}` : ''}
              {m.lightweight ? ' · 轻量' : ''}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>
          思考强度 <span className="field-en">effort</span>
        </span>
        <select value={effort} disabled={disabled || !selected} onChange={(e) => onEffort(e.target.value)}>
          <option value="">按任务选择强度</option>
          {effort && !selected?.efforts.includes(effort) && <option value={effort}>{effort} · 需重新确认</option>}
          {selected?.efforts.map((level) => (
            <option key={level} value={level}>
              {effortName(level)}
            </option>
          ))}
        </select>
      </label>
    </>
  );
}

function RunOutput({
  run: listed,
  runtimes,
  targets = [],
  api,
  notify,
  onHandoff,
  initialTab = 'output',
  relatedRuns = [],
  onInspectRun,
  onTrace,
  userInput,
  workflowRuns = [],
  finalOutput: suppliedFinalOutput,
}: {
  run?: RunRecord;
  runtimes: RuntimeSnapshot[];
  targets?: RuntimeTarget[];
  api: Api;
  notify: (notice: Notice) => void;
  onHandoff: () => void;
  initialTab?: 'output' | 'trajectory';
  relatedRuns?: RunRecord[];
  onInspectRun?: (id: string) => void;
  /** Opens the run's chat with its Trace (absent for runs without a chat). */
  onTrace?: () => void;
  userInput?: string;
  workflowRuns?: RunRecord[];
  finalOutput?: string;
}) {
  // Broadcast state only carries summaries of finished runs; load the full output and events on demand.
  const [full, setFull] = useState<RunRecord>();
  const [detail, setDetail] = useState<{ id: string; state: 'loading' | 'failed'; error?: string }>();
  const [attempt, setAttempt] = useState(0);
  const [executionDetail, setExecutionDetail] = useState<ExecutionRecordRequestState>();
  const [executionSnapshot, setExecutionSnapshot] = useState<ExecutionRecordRequestState>();
  const snapshot =
    executionSnapshot &&
    executionSnapshot.workflowId === listed?.workflowId &&
    executionSnapshot.selectedRunId === listed?.id
      ? executionSnapshot.record
      : undefined;
  const familyWorkflows = new Set([
    listed?.workflowId,
    ...(snapshot?.relatedWorkflows?.map((workflow) => workflow.id) ?? []),
  ]);
  const familyRuns = new Set(snapshot?.relatedRuns.map((record) => record.id) ?? []);
  const familyUpdates = [...workflowRuns, ...relatedRuns].filter(
    (record) => (record.workflowId && familyWorkflows.has(record.workflowId)) || familyRuns.has(record.id),
  );
  const chainDetailKey = familyUpdates
    .map(
      (record) =>
        `${record.id}:${record.status}:${record.endedAt ?? ''}:${record.output.length}:${record.output.slice(-120)}:${record.events.length}:${record.events.at(-1)?.at ?? ''}:${record.events.at(-1)?.seq ?? ''}:${record.eventsDropped ?? 0}`,
    )
    .join('|');
  const liveSignature = `${chainDetailKey}:${listed?.status}:${listed?.output.length}:${listed?.output.slice(-120)}:${listed?.events.length}:${listed?.events.at(-1)?.seq}:${listed?.eventsDropped}:${suppliedFinalOutput?.length}:${suppliedFinalOutput?.slice(-120)}`;
  const terminalSignature = familyUpdates
    .filter((record) => !activeStatuses.includes(record.status))
    .map((record) => `${record.id}:${record.status}:${record.endedAt ?? ''}`)
    .join('|');
  const recordRequest = useRef<{
    cancel?: () => void;
    timer?: ReturnType<typeof setTimeout>;
    signature?: string;
    terminal?: string;
  }>({});
  const fetchExecutionRecord = useRef<() => void>(() => {});
  fetchExecutionRecord.current = () => {
    if (!listed?.workflowId) return;
    recordRequest.current.cancel?.();
    const request = requestExecutionRecord(api, listed.workflowId, listed.id, (state) => {
      setExecutionDetail(state);
      if (state.status === 'ready') setExecutionSnapshot(state);
    });
    recordRequest.current.cancel = request.cancel;
  };
  useEffect(() => {
    recordRequest.current.signature = liveSignature;
    recordRequest.current.terminal = terminalSignature;
    fetchExecutionRecord.current();
    return () => {
      recordRequest.current.cancel?.();
      clearTimeout(recordRequest.current.timer);
      recordRequest.current.timer = undefined;
    };
  }, [listed?.id, listed?.workflowId, api, attempt]);
  useEffect(() => {
    if (!listed?.workflowId || recordRequest.current.signature === liveSignature) return;
    const terminalChanged = recordRequest.current.terminal !== terminalSignature;
    recordRequest.current.signature = liveSignature;
    recordRequest.current.terminal = terminalSignature;
    if (!activeStatuses.includes(listed.status) || terminalChanged) {
      clearTimeout(recordRequest.current.timer);
      recordRequest.current.timer = undefined;
      fetchExecutionRecord.current();
    } else if (!recordRequest.current.timer) {
      // A fixed window coalesces streaming events without postponing the read indefinitely.
      recordRequest.current.timer = setTimeout(() => {
        recordRequest.current.timer = undefined;
        fetchExecutionRecord.current();
      }, 400);
    }
  }, [listed?.workflowId, liveSignature, terminalSignature]);
  const finalOutput = listed?.workflowId ? snapshot?.finalOutput : suppliedFinalOutput;
  useEffect(() => {
    if (!listed?.summary || listed.workflowId) return;
    let alive = true;
    const id = listed.id;
    setDetail({ id, state: 'loading' });
    api<RunRecord>(`/api/runs/${encodeURIComponent(id)}`, undefined, 'GET')
      .then((value) => {
        if (!alive) return;
        setFull(value);
        setDetail(undefined);
      })
      .catch((error) => {
        if (alive) setDetail({ id, state: 'failed', error: readableError(error) });
      });
    return () => {
      alive = false;
    };
  }, [listed?.id, listed?.workflowId, listed?.summary, listed?.status, api, attempt]);
  const [audit, setAudit] = useState<RunRecord>();
  const [auditLoading, setAuditLoading] = useState(false);
  const auditRequest = useRef(0);
  useEffect(() => {
    auditRequest.current++;
    setAudit(undefined);
    setAuditLoading(false);
    return () => {
      auditRequest.current++;
    };
  }, [listed?.id]);
  const workflowDetailRun = snapshot?.runs.find((record) => record.id === listed?.id);
  const selectedDetailRun = workflowDetailRun ?? full;
  const view =
    listed && selectedDetailRun?.id === listed.id
      ? {
          ...selectedDetailRun,
          ...listed,
          output: listed.summary ? selectedDetailRun.output : listed.output,
          summary: selectedDetailRun.summary,
          events: mergeRunEventSnapshots(selectedDetailRun.events, listed.events),
        }
      : listed;
  const run =
    view && audit?.id === view.id
      ? {
          ...view,
          events: mergeRunEventSnapshots(audit.events, view.events),
        }
      : view;
  async function loadFullAudit() {
    if (!listed || auditLoading) return;
    const id = listed.id,
      request = ++auditRequest.current;
    setAuditLoading(true);
    try {
      const value = await api<RunRecord>(`/api/runs/${encodeURIComponent(id)}`, undefined, 'GET');
      if (request !== auditRequest.current) return;
      if (value.id !== id) throw new Error('返回的执行记录与所选记录不一致。');
      setAudit(value);
    } catch (error) {
      if (request === auditRequest.current) notify({ tone: 'error', message: readableError(error) });
    } finally {
      if (request === auditRequest.current) setAuditLoading(false);
    }
  }
  // True while only the broadcast summary (last 1,000 characters, no events) is on screen.
  const partial = Boolean(run?.summary);
  const detailState = partial && detail?.id === run?.id ? detail : undefined;
  const [tab, setTab] = useState<'output' | 'trajectory' | 'events' | 'verification'>(initialTab);
  const [cancelling, setCancelling] = useState(false);
  const [follow, setFollow] = useState(true);
  const outputRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setTab(initialTab);
    setFollow(true);
  }, [run?.id, initialTab]);
  useEffect(() => {
    if (tab === 'output' && follow && outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight;
  }, [finalOutput, follow, tab]);
  const active = run && activeStatuses.includes(run.status);
  const runtime = runtimeIdentity({ runtimes, targets }, run?.route.runtimeId);
  const events = run?.events.filter((event) => event.type !== 'text') ?? [];
  const originalInput = run ? executionUserInput(run, snapshot?.userInput ?? userInput) : undefined;
  const chain = run
    ? executionWorkflowRuns(
        run,
        snapshot?.runs ?? workflowRuns.filter((record) => record.workflowId === listed?.workflowId),
      )
    : [];
  const childChain = snapshot?.relatedRuns ?? [];
  const childTree = executionChildTree(chain, childChain, snapshot?.relatedWorkflows);
  const currentExecutionDetail =
    executionDetail && executionDetail.selectedRunId === listed?.id && executionDetail.workflowId === listed?.workflowId
      ? executionDetail
      : undefined;
  function renderChild(child: RunRecord, seen = new Set<string>()): React.ReactNode {
    if (seen.has(child.id)) return null;
    const next = new Set([...seen, child.id]);
    return (
      <section key={child.id} aria-label={`子 agent ${child.id}`}>
        <p className="quiet-text">子 agent · {child.id.slice(0, 8)}</p>
        <TrajectoryPanel run={child} relatedRuns={childChain} onInspectRun={onInspectRun} />
        {childTree.children.get(child.id)?.map((descendant) => renderChild(descendant, next))}
      </section>
    );
  }
  async function cancel() {
    if (!run) return;
    setCancelling(true);
    try {
      await api(`/api/runs/${encodeURIComponent(run.id)}/cancel`, {});
      notify({ tone: 'info', message: '已发送取消请求，等待执行器结束。' });
    } catch (error) {
      notify({ tone: 'error', message: readableError(error) });
    } finally {
      setCancelling(false);
    }
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(finalOutput ?? '');
      notify({ tone: 'success', message: '输出已复制。' });
    } catch {
      notify({ tone: 'error', message: '浏览器未允许访问剪贴板，请手动选择输出复制。' });
    }
  }
  return (
    <section className="panel output-panel" aria-labelledby="output-title">
      <div className="panel-heading">
        <div>
          <span className="panel-number">02</span>
          <h2 id="output-title">执行现场</h2>
          {run && <StatusPill status={run.status} />}
        </div>
        <div className="output-tools">
          {run && (
            <>
              <button
                type="button"
                className="icon-button"
                title="复制任务输出"
                aria-label="复制任务输出"
                onClick={() => void copy()}
              >
                <Copy size={14} />
              </button>
              {onTrace && (
                <button className="button tiny secondary" onClick={onTrace}>
                  <Activity size={12} />
                  在对话中查看轨迹
                </button>
              )}
              {!active && (
                <button className="button tiny secondary" onClick={onHandoff}>
                  <GitBranch size={12} />
                  交接
                </button>
              )}
              {active && (
                <button className="button tiny danger" disabled={cancelling} onClick={() => void cancel()}>
                  {cancelling ? <Loader2 size={12} className="spinning" /> : <Square size={11} />}停止
                </button>
              )}
            </>
          )}
        </div>
      </div>
      {!run ? (
        <EmptyState title="准备好开始你的下一个任务" detail="开始新任务，或从左侧选择已有记录，查看执行过程与输出。" />
      ) : (
        <>
          <div className="run-context">
            <div>
              <ProviderMark provider={runtime?.provider ?? 'codex'} small />
              <span>{runtime?.label ?? run.route.runtimeId}</span>
              <span className="context-divider">/</span>
              <code>{executionModel(run).model}</code>
              {executionModel(run).effort && <span className="effort-tag">{executionModel(run).effort}</span>}
            </div>
            <time>{dateLabel(run.startedAt, true)}</time>
          </div>
          <RunAccountSummary
            run={run}
            fromLabel={runtimeIdentity({ runtimes, targets }, run.relay?.fromRuntimeId)?.label}
          />
          <RunEvidence run={run} />
          <div className="run-prompt">
            <span>用户原文</span>
            <p translate={originalInput === undefined ? undefined : 'no'}>{originalInput ?? '暂无用户原文。'}</p>
          </div>
          {listed?.workflowId && currentExecutionDetail?.status !== 'ready' && (
            <div
              className={`run-detail-notice ${currentExecutionDetail?.status === 'failed' ? 'failed' : ''}`}
              role={currentExecutionDetail?.status === 'failed' ? 'alert' : 'status'}
            >
              {currentExecutionDetail?.status === 'failed' ? (
                <>
                  <AlertCircle size={13} />
                  {/* The error is usually interface text, possibly itself a pattern (请求失败（404）): translate it first. */}
                  <span>{`任务完整执行链加载失败（${translateInterfaceText(currentExecutionDetail.error ?? '')}）。`}</span>
                  <button type="button" className="button tiny secondary" onClick={() => setAttempt((n) => n + 1)}>
                    <RefreshCw size={12} />
                    重试
                  </button>
                </>
              ) : (
                <>
                  <Loader2 size={13} className="spinning" />
                  <span>正在加载任务完整执行链…</span>
                </>
              )}
            </div>
          )}
          {partial && !listed?.workflowId && (
            <div className={`run-detail-notice ${detailState?.state === 'failed' ? 'failed' : ''}`} role="status">
              {detailState?.state === 'failed' ? (
                <>
                  <AlertCircle size={13} />
                  <span>
                    完整记录加载失败（{detailState.error}）。下面只是摘要：输出的最后 1,000
                    个字符，不含事件。记录本身仍保存在本地。
                  </span>
                  <button type="button" className="button tiny secondary" onClick={() => setAttempt((n) => n + 1)}>
                    <RefreshCw size={12} />
                    重试
                  </button>
                </>
              ) : (
                <>
                  <Loader2 size={13} className="spinning" />
                  <span>正在加载完整记录，当前显示的是摘要（输出的最后 1,000 个字符，不含事件）。</span>
                </>
              )}
            </div>
          )}
          <div className="output-tabs" role="tablist" aria-label="执行内容">
            <button
              role="tab"
              aria-selected={tab === 'trajectory'}
              onClick={() => setTab('trajectory')}
              className={tab === 'trajectory' ? 'active' : ''}
            >
              <Activity size={13} />
              轨迹
            </button>
            <button
              role="tab"
              aria-selected={tab === 'output'}
              onClick={() => setTab('output')}
              className={tab === 'output' ? 'active' : ''}
            >
              <Terminal size={13} />
              输出
            </button>
            <button
              role="tab"
              aria-selected={tab === 'events'}
              onClick={() => setTab('events')}
              className={tab === 'events' ? 'active' : ''}
            >
              <Activity size={13} />
              原始事件<span>{events.length}</span>
            </button>
            {run.verification && (
              <button
                role="tab"
                aria-selected={tab === 'verification'}
                onClick={() => setTab('verification')}
                className={tab === 'verification' ? 'active' : ''}
              >
                <ShieldCheck size={13} />
                验证
              </button>
            )}
            <span className="output-tab-spacer" />
            {tab === 'output' && (
              <label className="follow-toggle">
                <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
                跟随输出
              </label>
            )}
          </div>
          <div
            className="output-body"
            ref={outputRef}
            role="tabpanel"
            tabIndex={0}
            aria-label={
              tab === 'trajectory'
                ? '执行轨迹'
                : tab === 'output'
                  ? '任务输出'
                  : tab === 'events'
                    ? '任务事件'
                    : '验证结果'
            }
          >
            {tab === 'trajectory' &&
              chain.map((attemptRun) => (
                <section key={attemptRun.id} aria-label={`执行记录 ${attemptRun.id}`}>
                  {attemptRun.summary && (
                    <p className="quiet-text">该执行当前只有摘要，完整事件尚未取得；可打开这一执行记录重试。</p>
                  )}
                  {chain.length > 1 && (
                    <p className="quiet-text">
                      执行 {attemptRun.id.slice(0, 8)} · {attemptRun.route.runtimeId}
                    </p>
                  )}
                  <TrajectoryPanel
                    run={attemptRun}
                    relatedRuns={childChain}
                    onInspectRun={onInspectRun}
                    userInput={originalInput}
                    onLoadFullAudit={attemptRun.id === run.id ? () => void loadFullAudit() : undefined}
                    auditLoading={attemptRun.id === run.id && auditLoading}
                  />
                  {childTree.children.get(attemptRun.id)?.map((child) => renderChild(child))}
                </section>
              ))}
            {tab === 'trajectory' &&
              [...childTree.workflowChildren].map(([parentWorkflowId, records]) => (
                <section key={parentWorkflowId} aria-label={`父任务 ${parentWorkflowId} 的关联子任务`}>
                  <p className="quiet-text">父任务 {parentWorkflowId} 的关联子任务 · 未报告父执行记录 ID</p>
                  {records.map((child) => renderChild(child))}
                </section>
              ))}
            {tab === 'trajectory' && childTree.unassociated.length > 0 && (
              <section aria-label="关联子任务">
                <p className="quiet-text">关联子任务 · 未报告可用的父执行记录关系</p>
                {childTree.unassociated.map((child) => renderChild(child))}
              </section>
            )}
            {tab === 'trajectory' && finalOutput && (
              <section aria-label="PugPort 最终消息">
                <p className="quiet-text">PugPort 最终消息</p>
                <pre className="agent-output">{finalOutput}</pre>
              </section>
            )}
            {tab === 'output' && (
              <>
                {finalOutput ? (
                  <pre className="agent-output">{finalOutput}</pre>
                ) : (
                  <div className="output-waiting">
                    {active ? (
                      <>
                        <Loader2 size={17} className="spinning" />
                        <span>等待 PugPort 最终消息…</span>
                      </>
                    ) : (
                      <span>该任务尚无 PugPort 最终消息。</span>
                    )}
                  </div>
                )}
              </>
            )}
            {tab === 'events' && (
              <RunEventLedger run={run} onLoadFullAudit={() => void loadFullAudit()} loading={auditLoading} />
            )}
            {tab === 'verification' && run.verification && (
              <div className="verification-result">
                <span className={`verification-status ${run.verification.status}`}>
                  {run.verification.status === 'passed' ? <CheckCircle2 size={17} /> : <AlertCircle size={17} />}
                  {run.verification.status === 'passed'
                    ? '验证通过'
                    : run.verification.status === 'cancelled'
                      ? '验证已取消'
                      : run.verification.status === 'skipped'
                        ? '验证已跳过'
                        : '验证未通过'}
                  <small>exit {run.verification.exitCode ?? '—'}</small>
                </span>
                <code className="verification-command">$ {run.verification.command}</code>
                {run.verification.output ? (
                  <pre className="agent-output">{run.verification.output}</pre>
                ) : (
                  <p className="quiet-text">命令未产生输出。</p>
                )}
              </div>
            )}
          </div>
          <div className="output-footer">
            <span>
              <FolderOpen size={12} />
              <span title={run.projectPath}>{run.projectPath}</span>
            </span>
            <span>
              {run.nativeSessionId ? '原生会话已保存' : '本地任务记录'}
              {run.endedAt && ` · ${dateLabel(run.endedAt, true)}`}
            </span>
          </div>
        </>
      )}
    </section>
  );
}

function TargetEditor({
  target,
  snapshot,
  api,
  reload,
  notify,
  embedded = false,
}: {
  /** Inside an executors-page row: the row already shows the name, state and switch. */
  embedded?: boolean;
  target: RuntimeTarget;
  snapshot?: RuntimeSnapshot;
  api: Api;
  reload: () => Promise<void>;
  notify: (notice: Notice) => void;
}) {
  const supportsAutoDiscovery =
    target.id === `${target.provider}-native` &&
    !!providerSpec(target.provider)?.commandAutoDiscovery &&
    target.environment === 'native';
  const [command, setCommand] = useState(target.command);
  const savedArgs = target.args ?? [];
  const [argsMode, setArgsMode] = useState<LaunchArgsMode>(() => defaultLaunchArgsMode(savedArgs));
  const [args, setArgs] = useState(() => formatLaunchArgs(savedArgs, defaultLaunchArgsMode(savedArgs)));
  const [enabled, setEnabled] = useState(target.enabled);
  const [accountingMode, setAccountingMode] = useState<NonNullable<RuntimeTarget['accountingMode']>>(
    target.accountingMode ?? 'auto',
  );
  const [commandDiscovery, setCommandDiscovery] = useState<NonNullable<RuntimeTarget['commandDiscovery']>>(
    target.commandDiscovery ?? 'fixed',
  );
  const [testModel, setTestModel] = useState('');
  const [testing, setTesting] = useState(false);
  // Until the new result arrives, the card says a test is running instead of showing the previous result.
  const [testStartedAt, setTestStartedAt] = useState<number>();
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setCommand(target.command);
    const mode = defaultLaunchArgsMode(target.args ?? []);
    setArgsMode(mode);
    setArgs(formatLaunchArgs(target.args ?? [], mode));
    setEnabled(target.enabled);
    setAccountingMode(target.accountingMode ?? 'auto');
    setCommandDiscovery(target.commandDiscovery ?? 'fixed');
  }, [target.command, target.enabled, target.accountingMode, target.commandDiscovery, JSON.stringify(target.args)]);
  async function testConnection() {
    setTesting(true);
    setTestStartedAt(Date.now());
    try {
      await api<RunRecord>(`/api/targets/${encodeURIComponent(target.id)}/test`, testModel ? { model: testModel } : {});
      await reload();
    } catch (error) {
      setTestStartedAt(undefined);
      notify({ tone: 'error', message: readableError(error) });
    } finally {
      setTesting(false);
    }
  }
  const lastTestAt = snapshot?.lastConnectionTest ? Date.parse(snapshot.lastConnectionTest.at) : 0;
  const testPending = testStartedAt !== undefined && lastTestAt < testStartedAt && Date.now() - testStartedAt < 180_000;
  function toggleArgsMode() {
    try {
      const current = parseLaunchArgs(args, argsMode);
      const next: LaunchArgsMode = argsMode === 'lines' ? 'json' : 'lines';
      if (next === 'lines' && !linesAreLossless(current))
        throw new Error('这些参数包含换行、首尾空格或空参数，只能用 JSON 编辑，否则保存时会被改动。');
      setArgsMode(next);
      setArgs(formatLaunchArgs(current, next));
    } catch (error) {
      notify({ tone: 'error', message: readableError(error) });
    }
  }
  async function rename(label: string) {
    try {
      await api(`/api/targets/${encodeURIComponent(target.id)}`, { label }, 'PATCH');
      await reload();
    } catch (error) {
      notify({ tone: 'error', message: readableError(error) });
      throw error;
    }
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    try {
      // Untouched arguments are sent back exactly as stored, whatever the editing mode.
      const parsed = args === formatLaunchArgs(savedArgs, argsMode) ? savedArgs : parseLaunchArgs(args, argsMode);
      if (!command.trim()) throw new Error('请填写执行命令或可执行文件路径。');
      setSaving(true);
      const commandPatch = { command: command.trim(), args: parsed };
      if (targetCommandChanged(target, commandPatch)) {
        const change = desktopBridge()?.changePermission;
        if (!change) throw new Error('请在桌面应用中修改权限。');
        if (!(await change({ kind: 'target-command', id: target.id, patch: commandPatch }))) return;
      }
      await api(
        `/api/targets/${encodeURIComponent(target.id)}`,
        {
          enabled,
          accountingMode,
          commandDiscovery: supportsAutoDiscovery ? commandDiscovery : 'fixed',
        },
        'PATCH',
      );
      await reload();
      notify({ tone: 'success', message: '{0} 的启动配置已保存。', names: [shownName(target.label)] });
    } catch (error) {
      notify({ tone: 'error', message: readableError(error) });
    } finally {
      setSaving(false);
    }
  }
  if (!isCoreRuntime(target))
    return (
      <article className="target-card retired-runtime">
        <h3>{target.label}</h3>
        <p>已移出核心，不可用。已有执行记录与用量仍保留。</p>
      </article>
    );
  return (
    <form className={embedded ? 'target-body' : 'target-card'} onSubmit={(e) => void save(e)}>
      {!embedded && (
        <>
          <div className="target-heading">
            <ProviderMark provider={target.provider} />
            <div>
              <CardName label={target.label} onRename={rename} />
              <span>
                {target.environment === 'wsl'
                  ? 'Windows Subsystem for Linux'
                  : isApiHarness(target.provider)
                    ? 'API'
                    : '本机 CLI'}
                {snapshot?.version ? ` · ${snapshot.version}` : ''}
              </span>
            </div>
            <label className="switch" title={enabled ? '关闭执行器' : '启用执行器'}>
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
                aria-label={withNames(enabled ? '关闭 {0}' : '启用 {0}', [shownName(target.label)])}
                data-names
              />
              <span />
            </label>
          </div>
          <div className="target-state">
            <span className={`runtime-dot ${snapshot?.status ?? 'unknown'}`} />
            {snapshot ? runtimeLabels[snapshot.status] : '尚未发现'}
            <span className="target-model-count">{snapshot?.models.length ?? 0} 个已发现模型</span>
          </div>
          {snapshot?.note && <p className="target-note">{snapshot.note}</p>}
          {target.sharedConfigNote && <p className="target-note">{target.sharedConfigNote}</p>}
        </>
      )}
      {/* Launch details rarely change; they stay folded so the card shows status first. */}
      {target.gateway !== 'api' && (
        <details className="target-advanced">
          <summary>启动与统计设置</summary>
          <div className="fields-grid two">
            {target.provider === 'pi' ? (
              <div className="field">
                <span>执行组件</span>
                <p className="quiet-text">只记录模型调用的实际消耗。</p>
              </div>
            ) : (
              <label className="field">
                <span>用量统计方式</span>
                <select
                  value={accountingMode}
                  onChange={(event) => setAccountingMode(event.target.value as typeof accountingMode)}
                >
                  <option value="auto">自动识别</option>
                  <option value="subscription">订阅额度 + 调用消耗</option>
                  <option value="usage">仅累计消耗 · 无余额要求</option>
                </select>
              </label>
            )}
            <label className="field">
              <span>CLI 路径</span>
              <select
                value={supportsAutoDiscovery ? commandDiscovery : 'fixed'}
                disabled={!supportsAutoDiscovery}
                onChange={(event) => setCommandDiscovery(event.target.value as typeof commandDiscovery)}
              >
                {supportsAutoDiscovery && <option value="auto">自动发现</option>}
                <option value="fixed">固定启动命令</option>
              </select>
            </label>
          </div>
          <label className="field">
            <span>
              启动命令{supportsAutoDiscovery && commandDiscovery === 'auto' && <small>手动修改后使用固定命令</small>}
            </span>
            <input
              value={command}
              onChange={(e) => {
                setCommand(e.target.value);
                setCommandDiscovery('fixed');
              }}
              spellCheck={false}
              className="mono-input"
            />
          </label>
          <label className="field">
            <span>
              启动参数 <small>{argsMode === 'lines' ? '每行一个，可留空' : 'JSON 字符串数组，按原样保存'}</small>
              <button type="button" className="button tiny quiet" onClick={toggleArgsMode}>
                {argsMode === 'lines' ? '改用 JSON 编辑' : '改为每行一个'}
              </button>
            </span>
            <textarea
              value={args}
              onChange={(e) => setArgs(e.target.value)}
              spellCheck={false}
              className="mono-input"
              rows={Math.min(6, Math.max(2, args.split('\n').length))}
            />
          </label>
          <div className="target-footer">
            <span>保留执行器原生登录</span>
            <button className="button secondary tiny" disabled={saving || testing}>
              {saving ? <Loader2 size={12} className="spinning" /> : <Check size={12} />}保存配置
            </button>
          </div>
        </details>
      )}
      <div className="target-test">
        <label className="field">
          <span>连接测试模型</span>
          <select
            aria-label={withNames('{0} 连接测试模型', [shownName(target.label)])}
            data-names
            onFocus={() => {
              if (target.gateway === 'api')
                void api(`/api/api-providers/${encodeURIComponent(target.id)}/models`, {}).catch(() => undefined);
            }}
            value={testModel}
            onChange={(event) => setTestModel(event.target.value)}
          >
            <option value="">自动选择测试模型</option>
            {snapshot?.models.map((model) => (
              <option key={model.id} value={model.id} title={model.discovered ? newModelTitle : undefined}>
                {modelOptionLabel(model)}
                {model.quotaPool ? ` · ${cursorModelPoolLabel(model.quotaPool)}` : ''}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="button secondary"
          disabled={saving || testing || testPending || !target.enabled || snapshot?.status === 'missing'}
          onClick={() => void testConnection()}
        >
          {testing || testPending ? <Loader2 size={13} className="spinning" /> : <Play size={13} />}测试连接
        </button>
        <p>发送一次最小的真实请求，会产生少量用量。</p>
        {testPending ? (
          <p className="connection-test-result">
            <Loader2 size={12} className="spinning" />
            <span>正在测试连接…</span>
          </p>
        ) : (
          snapshot?.lastConnectionTest && (
            <p className={`connection-test-result ${snapshot.lastConnectionTest.ok ? '' : 'failed'}`}>
              {snapshot.lastConnectionTest.ok ? <CheckCircle2 size={12} /> : <AlertCircle size={12} />}
              <span>
                上次实际请求{snapshot.lastConnectionTest.ok ? '通过' : '失败'} ·{' '}
                {dateLabel(snapshot.lastConnectionTest.at)}
                <small>
                  {snapshot.lastConnectionTest.model}
                  {snapshot.lastConnectionTest.error
                    ? ` · ${connectionTestErrors[snapshot.lastConnectionTest.error] ?? snapshot.lastConnectionTest.error}`
                    : ''}
                </small>
              </span>
            </p>
          )
        )}
      </div>
    </form>
  );
}

/** What a failed connection test means and what to do, instead of the internal error code. */
const connectionTestErrors: Record<string, string> = {
  'api-key-workspace-required':
    '这个 Key 没有绑定工作区，平台要求每次请求注明工作区。请在上面「工作区 ID」填上控制台「设置 → 工作区」里的 ID（wrkspc_ 开头）并保存；或者新建 Key 时直接选一个工作区。',
  'api-key-auth-or-configuration': 'Key 被平台拒绝：请确认 Key 完整、没有过期，账户里还有可用额度。',
  'authentication-required': '需要重新登录这个账号。',
  'quota-or-rate-limit': '额度不足或被限流，稍后再试。',
  'runtime-network-error': '网络连接失败，检查网络或代理后再试。',
  'runtime-timeout': '请求超时，稍后再试。',
  'runtime-not-found': '找不到这个执行器的程序，请检查安装或启动路径。',
};

/** 0 means no limit. */
const concurrencyChoices = [0, 1, 2, 3, 4, 6, 8];

function SettingsPage({
  state,
  api,
  reload,
  notify,
  category = 'general',
}: {
  category?: SettingsCategory;
  state: AppState;
  api: Api;
  reload: () => Promise<void>;
  notify: (notice: Notice) => void;
}) {
  const trash = systemTrashName(state.app.platform);
  const radioKeys = useRadioKeys();
  const [form, setForm] = useState<Settings>(state.settings);
  const hasUnavailablePreference = [form.designProvider, form.architectureProvider, form.routineProvider].some(
    (provider) => !isCoreProvider(provider),
  );
  const [pendingSwitch, setPendingSwitch] = useState<keyof Settings>();
  const [pickingFolder, setPickingFolder] = useState(false);
  const saving = pendingSwitch !== undefined;
  const draft = useRef(form);
  const current = useRef(state.settings);
  const edited = useRef(new Set<keyof Settings>());
  const pending = useRef(new Set<keyof Settings>());
  const queue = useRef(Promise.resolve());
  const mounted = useRef(true);
  useEffect(() => {
    current.current = state.settings;
    setForm((previous) => {
      const next = { ...state.settings };
      for (const key of new Set([...edited.current, ...pending.current])) Object.assign(next, { [key]: previous[key] });
      draft.current = next;
      return next;
    });
  }, [state.settings]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const key of edited.current) void flush(key);
    };
  }, []);
  function edit<K extends keyof Settings>(key: K, value: Settings[K]) {
    edited.current.add(key);
    draft.current = { ...draft.current, [key]: value };
    setForm(draft.current);
  }
  function flush(key: keyof Settings) {
    if (!edited.current.delete(key)) return;
    return toggle(key, draft.current[key], '设置', '设置已保存。', true);
  }
  function change<K extends keyof Settings>(key: K, value: Settings[K]) {
    void toggle(key, value, '设置', '设置已保存。');
  }
  /** Serialize field patches, including blur followed immediately by category navigation. */
  function toggle<K extends keyof Settings>(
    key: K,
    value: Settings[K],
    label: string,
    message?: string,
    keepDraft = false,
  ) {
    pending.current.add(key);
    draft.current = { ...draft.current, [key]: value };
    if (mounted.current) setForm(draft.current);
    const work = async () => {
      const before = current.current[key];
      if (mounted.current) setPendingSwitch(key);
      let committed = false;
      try {
        const bounds = { reservePercent: [0, 95], refreshSeconds: [30, 600], maxQuotaAgeSeconds: [30, 1800] };
        const range = bounds[key as keyof typeof bounds];
        if (range && (typeof value !== 'number' || !Number.isInteger(value) || value < range[0]! || value > range[1]!))
          throw new Error('请输入范围内的整数。');
        if (key === 'excludedExecutors')
          validateAutomaticExecutors(
            state.targets.filter((target) => !(value as string[]).includes(target.id)).map((target) => target.id),
            state.targets,
          );
        if (!(await saveSettings(api, current.current, { [key]: value }))) {
          draft.current = { ...draft.current, [key]: before };
          if (mounted.current) setForm(draft.current);
          return;
        }
        committed = true;
        current.current = { ...current.current, [key]: value };
        await reload();
        if (mounted.current)
          notify({ tone: 'success', message: message ?? (value ? `${label}：已开启` : `${label}：已关闭`) });
      } catch (error) {
        if (!committed && mounted.current) {
          if (keepDraft) edited.current.add(key);
          else draft.current = { ...draft.current, [key]: before };
          setForm(draft.current);
        }
        notify({
          tone: 'error',
          message: committed ? `设置已保存，但刷新失败：${readableError(error)}` : readableError(error),
        });
      } finally {
        pending.current.delete(key);
        if (mounted.current) setPendingSwitch(undefined);
      }
    };
    queue.current = queue.current.then(work);
    return queue.current;
  }
  return (
    <div className="settings-form">
      <fieldset className="settings-fields" aria-busy={saving}>
        {category === 'general' && (
          <>
            <AppSection
              api={api}
              notify={notify}
              state={state}
              updateCheck={form.updateCheck !== false}
              updatePending={pendingSwitch === 'updateCheck'}
              onUpdateCheck={(value) => change('updateCheck', value)}
            >
              <SettingsRow
                title={<span id="keep-awake-label">任务运行时不让电脑休眠</span>}
                control={
                  <label className="switch">
                    <input
                      type="checkbox"
                      aria-labelledby="keep-awake-label"
                      checked={form.keepAwake !== false}
                      aria-busy={pendingSwitch === 'keepAwake'}
                      onChange={(event) => void toggle('keepAwake', event.target.checked, '任务运行时不让电脑休眠')}
                    />
                    <span />
                  </label>
                }
              />
              <SettingsRow
                title="完成通知"
                control={
                  <select
                    aria-label="任务完成通知"
                    value={form.notifyOnFinish ?? 'background'}
                    onChange={(event) => change('notifyOnFinish', event.target.value as Settings['notifyOnFinish'])}
                  >
                    <option value="background">离开时通知</option>
                    <option value="always">总是通知</option>
                    <option value="never">不通知</option>
                  </select>
                }
              />
              {form.notifyOnFinish !== 'never' && (
                <SettingsRow
                  title={<span id="notify-sound-label">播放提示音</span>}
                  control={
                    <label className="switch">
                      <input
                        type="checkbox"
                        aria-labelledby="notify-sound-label"
                        checked={form.notifySound !== false}
                        aria-busy={pendingSwitch === 'notifySound'}
                        onChange={(event) => change('notifySound', event.target.checked)}
                      />
                      <span />
                    </label>
                  }
                />
              )}
            </AppSection>
          </>
        )}
        {category === 'personal' && (
          <>
            <section id="settings-personal-instructions" className="panel settings-section">
              <div className="section-title">
                <MessageSquare size={18} />
                <div>
                  <h2>
                    <label htmlFor="global-instructions">个人指令</label>
                  </h2>
                  <p id="global-instructions-hint">对所有对话生效；项目规则优先</p>
                </div>
              </div>
              <textarea
                id="global-instructions"
                className="personal-instructions-input"
                aria-describedby={
                  (form.globalInstructions?.length ?? 0) > 3500
                    ? 'global-instructions-hint global-instructions-count'
                    : 'global-instructions-hint'
                }
                value={form.globalInstructions ?? ''}
                maxLength={4000}
                rows={5}
                placeholder="例如：先给结论，再用简短的步骤解释。"
                onBlur={() => void flush('globalInstructions')}
                onChange={(event) => edit('globalInstructions', event.target.value)}
              />
              {(edited.current.has('globalInstructions') ||
                (form.globalInstructions ?? '') !== (current.current.globalInstructions ?? '')) && (
                <button
                  type="button"
                  className="button secondary tiny"
                  disabled={pending.current.has('globalInstructions')}
                  onClick={() => void flush('globalInstructions')}
                >
                  保存
                </button>
              )}
              {(form.globalInstructions?.length ?? 0) > 3500 && (
                <p id="global-instructions-count" className="personal-instructions-count">
                  {form.globalInstructions?.length ?? 0} / 4000
                </p>
              )}
            </section>
            <MemoryDistillationSwitch
              settings={form}
              onChange={(value) => void toggle('memoryDistillation', value, '自动整理项目记忆')}
            />
            <HindsightSettingsPanel
              state={state}
              settings={form.hindsight}
              disabled={pendingSwitch === 'hindsight'}
              api={api}
              onChange={(value) => void toggle('hindsight', value, 'Hindsight 项目记忆', 'Hindsight 设置已保存。')}
            />
            <SettingsFolder api={api} notify={notify} kind="memory" />
          </>
        )}
        {category === 'conversation' && (
          <>
            <section className="panel settings-section">
              <label className="setting-row">
                <span className="setting-label">
                  发送快捷键
                  <small>Shift+Enter 换行</small>
                </span>
                <select
                  aria-label="发送快捷键"
                  value={form.composerSendKey ?? 'enter'}
                  onChange={(event) =>
                    void toggle(
                      'composerSendKey',
                      event.target.value as Settings['composerSendKey'],
                      '发送快捷键',
                      '发送快捷键已保存。',
                    )
                  }
                >
                  <option value="enter">Enter</option>
                  <option value="ctrl-enter">
                    {translateInterfaceText('Ctrl+Enter').replaceAll(
                      'Ctrl+',
                      state.app.platform === 'darwin' ? 'Cmd+' : 'Ctrl+',
                    )}
                  </option>
                </select>
              </label>
              <label className="setting-row">
                <span className="setting-label">
                  自动插话
                  <small>任务运行时，发送即补充给当前任务。</small>
                </span>
                <span className="switch">
                  <input
                    type="checkbox"
                    checked={form.steerOnSend !== false}
                    aria-busy={pendingSwitch === 'steerOnSend'}
                    aria-label="自动插话"
                    onChange={(e) => void toggle('steerOnSend', e.target.checked, '自动插话')}
                  />
                  <span />
                </span>
              </label>
              <label className="setting-row">
                <span className="setting-label">显示自动回复的执行器、模型和强度</span>
                <span className="switch">
                  <input
                    type="checkbox"
                    checked={form.showAutomaticReplyIdentity !== false}
                    aria-label="显示自动回复的执行器、模型和强度"
                    aria-busy={pendingSwitch === 'showAutomaticReplyIdentity'}
                    onChange={(event) =>
                      void toggle(
                        'showAutomaticReplyIdentity',
                        event.target.checked,
                        '显示自动回复的执行器、模型和强度',
                      )
                    }
                  />
                  <span />
                </span>
              </label>
            </section>
          </>
        )}
        {category === 'routing' && (
          <>
            <section id="settings-routing" className="panel settings-section">
              <div className="section-title">
                <Sparkles size={18} />
                <div>
                  <h2>自动路由</h2>
                  <p>从本机已连接且可用的 CLI 和 API 中，自动选择执行器、模型和强度。</p>
                </div>
              </div>
              <details className="routing-options">
                <summary>允许自动选择的执行器</summary>
                <ExecutorChecklist
                  state={state}
                  value={state.targets
                    .filter((target) => !(form.excludedExecutors ?? []).includes(target.id))
                    .map((target) => target.id)}
                  onChange={(ids) =>
                    change('excludedExecutors', [
                      ...(form.excludedExecutors ?? []).filter(
                        (id) =>
                          !executorCards(state.targets).some(
                            (card) => card.id === id && (card.gateway !== 'api' || isFreePreset(card.apiProvider)),
                          ),
                      ),
                      ...executorCards(state.targets)
                        .filter(
                          (card) =>
                            (card.gateway !== 'api' || isFreePreset(card.apiProvider)) && !ids.includes(card.id),
                        )
                        .map((card) => card.id),
                    ])
                  }
                />
              </details>
              <div className="goal-picker" role="radiogroup" aria-label="路由目标" onKeyDown={radioKeys}>
                {(
                  [
                    ['save', '轻量', '简单任务优先用轻量或免费模型。'],
                    ['balanced', '均衡', '按任务难度自动调整。'],
                    ['quality', '质量', '优先用最强模型和更高强度。'],
                  ] as const
                ).map(([value, label, detail]) => (
                  <button
                    type="button"
                    key={value}
                    role="radio"
                    aria-checked={(form.routeGoal ?? 'balanced') === value}
                    tabIndex={(form.routeGoal ?? 'balanced') === value ? 0 : -1}
                    className={(form.routeGoal ?? 'balanced') === value ? 'on' : ''}
                    onClick={() => change('routeGoal', value)}
                  >
                    <strong>{label}</strong>
                    <small>{detail}</small>
                  </button>
                ))}
              </div>
            </section>
            <RoutingProfilesSettings state={state} api={api} reload={reload} notify={notify} />
            <LayaSettings api={api} reload={reload} notify={notify} section="sharing" />
            <section className="panel settings-section">
              <div className="section-title">
                <h2>任务处理方式</h2>
              </div>
              <p className="quiet-text">设置会应用于之后发送的任务。</p>
              <label className="field">
                <span>默认调度方式</span>
                <select
                  aria-label="默认调度方式"
                  value={form.decisionMode ?? 'auto'}
                  onChange={(event) => change('decisionMode', event.target.value as Settings['decisionMode'])}
                >
                  <option value="auto">自动选择并运行</option>
                  <option value="confirm">先给建议，确认后运行</option>
                </select>
              </label>
              <p className="quiet-text">建议后确认：先展示执行器、模型和思考强度，确认后再运行。</p>
            </section>
            <section className="panel settings-section">
              <div className="section-title">
                <h2>连接与协作</h2>
              </div>
              <label className="field">
                <span>账号使用顺序</span>
                <select
                  aria-label="账号使用顺序"
                  value={form.preferCli ? 'subscription' : 'auto'}
                  onChange={(event) => change('preferCli', event.target.value === 'subscription')}
                >
                  <option value="subscription">订阅账号优先，API 补充</option>
                  <option value="auto">按任务选择所有账号</option>
                </select>
              </label>
              <label className="setting-row">
                <span className="setting-label">
                  允许执行器互相调用
                  <small>
                    在任务里点名卡片名称（如“让 Codex B
                    检查”），执行器可把子任务交给它并取回结果；子任务默认只读，不能再往下调用。
                  </small>
                </span>
                <span className="switch">
                  <input
                    type="checkbox"
                    checked={form.agentBridge !== false}
                    aria-busy={pendingSwitch === 'agentBridge'}
                    onChange={(e) => void toggle('agentBridge', e.target.checked, '允许执行器互相调用')}
                  />
                  <span />
                </span>
              </label>
            </section>
            <details className="panel settings-section">
              <summary>
                <strong>额度策略</strong>
              </summary>
              <p className="quiet-text">仅适用于订阅额度。API 另行累计调用消耗。</p>
              <label className="setting-row">
                <span className="setting-label">
                  额度用完时自动用重置卡
                  <small>
                    默认关闭。开启后，有任务等待且额度耗尽时用一张；卡片到期前 10
                    分钟内，只要额度用过就用掉它。优先用最早到期的卡，不改变路由排序。
                  </small>
                </span>
                <span className="switch">
                  <input
                    type="checkbox"
                    checked={form.autoUseResetCards === true}
                    aria-busy={pendingSwitch === 'autoUseResetCards'}
                    onChange={(e) => void toggle('autoUseResetCards', e.target.checked, '自动用重置卡')}
                  />
                  <span />
                </span>
              </label>
              <div className="fields-grid two">
                <label className="field">
                  <span>
                    保留额度 <span className="field-en">%</span>
                  </span>
                  <input
                    type="number"
                    min={0}
                    max={95}
                    step={1}
                    value={form.reservePercent}
                    onBlur={() => void flush('reservePercent')}
                    onChange={(e) => edit('reservePercent', e.target.valueAsNumber)}
                    required
                  />
                  <small>
                    各额度窗口分别计算：平时保留上述额度；距重置 24 小时内最多保留 2%，最后 6
                    小时可用完。重置时间或剩余额度不明确时，仍保留上述额度。
                  </small>
                </label>
              </div>
              <label className="field">
                <span>订阅额度未报告时</span>
                <select
                  value={form.unknownQuotaPolicy}
                  onChange={(e) => change('unknownQuotaPolicy', e.target.value as Settings['unknownQuotaPolicy'])}
                >
                  <option value="manual-only">已检查的订阅账号有限尝试，其他账号需单次允许</option>
                  <option value="allow">允许执行（无法保证剩余额度）</option>
                </select>
              </label>
              {form.unknownQuotaPolicy === 'allow' && (
                <div className="inline-warning">
                  <AlertCircle size={15} />
                  <span>额度未知的执行器可能在运行时触及供应商限额。</span>
                </div>
              )}
            </details>
          </>
        )}
        {category === 'permissions' && (
          <>
            <section className="panel settings-section">
              <div className="section-title">
                <Terminal size={18} />
                <div>
                  <h2>工具执行</h2>
                </div>
              </div>
              <label className="field">
                <span>命令与文件操作</span>
                <select
                  aria-label="工具确认方式"
                  value={form.toolApprovalMode ?? 'auto'}
                  onChange={(event) => change('toolApprovalMode', event.target.value as Settings['toolApprovalMode'])}
                >
                  <option value="auto">自动执行 · 默认</option>
                  <option value="ask">需要时逐项确认</option>
                </select>
              </label>
              <p className="quiet-text">自动执行：日常操作直接进行，超出任务权限的操作会被拒绝并在执行记录里说明。</p>
            </section>
            <section className="panel settings-section">
              <label className="setting-row">
                <span className="setting-label">
                  {`删除文件时直接移到${trash}`}
                  <small>
                    {`对任务已授权的删除，PugPort 直接移到系统${trash}，不额外确认；原生 CLI 仍会检查权限。可在${trash}还原；放不进${trash}的文件会跳过，不会永久删除。`}
                  </small>
                </span>
                <span className="switch">
                  <input
                    type="checkbox"
                    checked={form.recycleWithoutAsking !== false}
                    aria-busy={pendingSwitch === 'recycleWithoutAsking'}
                    onChange={(e) =>
                      void toggle('recycleWithoutAsking', e.target.checked, `删除文件时直接移到${trash}`)
                    }
                  />
                  <span />
                </span>
              </label>
            </section>{' '}
            <SandboxSettings
              status={state.sandboxStatus}
              settings={form}
              change={change}
              api={api}
              reload={reload}
              notify={notify}
            />
            <p className="quiet-text">PugPort 不会生成涉及未成年人的性内容。</p>
          </>
        )}
        {category === 'advanced' && (
          <>
            <section className="panel settings-section">
              <label className="setting-row">
                <span className="setting-label">
                  显示其他 Agent 派来的对话
                  <small>侧栏不列出这些对话，任务页、搜索和链接仍可打开。</small>
                </span>
                <span className="switch">
                  <input
                    type="checkbox"
                    checked={form.showAgentConversations === true}
                    aria-label="显示其他 Agent 派来的对话"
                    aria-busy={pendingSwitch === 'showAgentConversations'}
                    onChange={(event) =>
                      void toggle('showAgentConversations', event.target.checked, '显示其他 Agent 派来的对话')
                    }
                  />
                  <span />
                </span>
              </label>
            </section>
            <LayaSettings api={api} reload={reload} notify={notify} />
            <section className="panel settings-section">
              <div className="section-title">
                <GitBranch size={18} />
                <div>
                  <h2>路由偏好</h2>
                  <p>可选的固定平台与顺序偏好；关闭时由自动路由选择，命名方案仍可单独使用。</p>
                </div>
              </div>
              <label className="setting-row" style={{ gridTemplateColumns: 'minmax(0, 1fr) auto' }}>
                <span className="setting-label">启用固定路由偏好</span>
                <span className="switch">
                  <input
                    type="checkbox"
                    aria-label="启用固定路由偏好"
                    checked={form.routePreferencesEnabled === true}
                    aria-busy={pendingSwitch === 'routePreferencesEnabled'}
                    onChange={(event) => void toggle('routePreferencesEnabled', event.target.checked, '固定路由偏好')}
                  />
                  <span />
                </span>
              </label>
              <p className="quiet-text">默认关闭。已保存的偏好会保留，开启后才用于后续自动任务。</p>
              {form.routePreferencesEnabled === true && (
                <>
                  {hasUnavailablePreference && (
                    <p className="unavailable-runtime" role="alert">
                      部分已保存的平台偏好不可用，请重新连接或移除。
                    </p>
                  )}
                  <RoutePolicyEditor
                    value={routePolicy(form)}
                    options={routeOptions(state.targets, state.runtimes)}
                    onChange={(next) => change('routePolicy', next)}
                  />
                </>
              )}
            </section>
            <section className="panel settings-section">
              <div className="section-title">
                <FolderOpen size={18} />
                <div>
                  <h2>工作环境</h2>
                </div>
              </div>
              <div className="settings-work-folder">
                <label className="field">
                  <span>默认工作文件夹</span>
                  <input
                    aria-label="默认工作文件夹"
                    value={form.defaultProjectPath}
                    onBlur={() => void flush('defaultProjectPath')}
                    onChange={(e) => edit('defaultProjectPath', e.target.value)}
                    spellCheck={false}
                    placeholder="选择你的日常工作目录"
                  />
                </label>
                <button
                  type="button"
                  className="button secondary"
                  disabled={pickingFolder || !desktopBridge()?.pickDirectory}
                  onClick={async () => {
                    setPickingFolder(true);
                    try {
                      const path = await desktopBridge()?.pickDirectory();
                      if (path && mounted.current) {
                        edit('defaultProjectPath', path);
                        await flush('defaultProjectPath');
                      }
                    } catch (error) {
                      notify({ tone: 'error', message: readableError(error) });
                    } finally {
                      if (mounted.current) setPickingFolder(false);
                    }
                  }}
                >
                  <FolderOpen size={15} />
                  选择文件夹
                </button>
              </div>
              <details className="routing-options">
                <summary>
                  {!(form.maxConcurrentRuns ?? 0) && !(form.maxRunsPerAccount ?? 0)
                    ? '任务并发：自动'
                    : '任务并发：自定义'}
                </summary>
                <div className="fields-grid two">
                  <label className="field">
                    <span>同时运行的任务</span>
                    <select
                      value={form.maxConcurrentRuns}
                      onChange={(e) => change('maxConcurrentRuns', Number(e.target.value))}
                    >
                      {concurrencyChoices.map((value) => (
                        <option key={value} value={value}>
                          {value ? `最多 ${value} 个` : '自动'}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>每个账号同时运行</span>
                    <select
                      value={form.maxRunsPerAccount ?? 0}
                      onChange={(e) => change('maxRunsPerAccount', Number(e.target.value))}
                    >
                      {concurrencyChoices.map((value) => (
                        <option key={value} value={value}>
                          {value ? `最多 ${value} 个` : '自动'}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              </details>
              <p className="quiet-text">按电脑负载自动排队，同一对话依次执行，并避免同一目录中的写入冲突。</p>
            </section>
            <section className="panel settings-section">
              <div className="fields-grid two">
                <label className="field">
                  <span>
                    刷新间隔 <span className="field-en">秒</span>
                  </span>
                  <input
                    type="number"
                    min={30}
                    max={600}
                    value={form.refreshSeconds}
                    onBlur={() => void flush('refreshSeconds')}
                    onChange={(e) => edit('refreshSeconds', e.target.valueAsNumber)}
                    required
                  />
                </label>
                <label className="field">
                  <span>
                    额度最长有效期 <span className="field-en">秒</span>
                  </span>
                  <input
                    type="number"
                    min={30}
                    max={1800}
                    value={form.maxQuotaAgeSeconds}
                    onBlur={() => void flush('maxQuotaAgeSeconds')}
                    onChange={(e) => edit('maxQuotaAgeSeconds', e.target.valueAsNumber)}
                    required
                  />
                </label>
              </div>
            </section>
            <SettingsFolder api={api} notify={notify} kind="data" />
          </>
        )}
      </fieldset>
    </div>
  );
}

function ApprovalCard({ approval, api, notify }: { approval: Approval; api: Api; notify: (notice: Notice) => void }) {
  const [pending, setPending] = useState<boolean | null>(null);
  const changePermission = desktopBridge()?.changePermission;
  const toolLabel =
    ['Bash', 'Codex command', 'Cursor command', 'Cursor execute', 'Pi command'].includes(approval.tool) ||
    /^Pi · (?:bash|powershell) · 执行命令$/.test(approval.tool)
      ? '运行命令'
      : ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Codex file change'].includes(approval.tool)
        ? '修改文件'
        : approval.tool;
  async function answer(allow: boolean, remember = false) {
    setPending(allow);
    try {
      if (allow) {
        if (!changePermission) throw new Error('请在 PugPort 桌面窗口中允许');
        if (!(await changePermission({ kind: 'approval', id: approval.id, allow: true, remember })))
          throw new Error('操作没有完成，请重试。');
      } else {
        await api(`/api/approvals/${encodeURIComponent(approval.id)}`, { allow: false });
      }
    } catch (error) {
      notify({ tone: 'error', message: readableError(error) });
      setPending(null);
    }
  }
  return (
    <section
      className="approval-card"
      role="alertdialog"
      aria-labelledby={`approval-${approval.id}`}
      aria-describedby={`approval-description-${approval.id}`}
    >
      <div className="approval-icon">
        <ShieldCheck size={20} />
      </div>
      <div className="approval-content">
        <span className="eyebrow">需要你的确认</span>
        <h3
          id={`approval-${approval.id}`}
          translate={
            toolLabel !== approval.tool ||
            ['确认 GitHub 写入', '创建邮件草稿', '修改连接器中的内容'].includes(approval.tool)
              ? undefined
              : 'no'
          }
        >
          {toolLabel}
        </h3>
        <p id={`approval-description-${approval.id}`}>
          {approval.description.split('\n').map((line, index) => (
            <span
              key={index}
              translate={
                (approval.tool === '创建邮件草稿' || approval.tool === '修改连接器中的内容') &&
                ((index === 0 && line.startsWith('账号：')) ||
                  (index === 1 && line === '将创建草稿，不会发送邮件。') ||
                  (index === 3 && line === '日历操作包含参与者时，服务可能发送邀请、更新或取消通知。'))
                  ? undefined
                  : 'no'
              }
            >
              {(approval.tool === '创建邮件草稿' || approval.tool === '修改连接器中的内容') &&
              index === 0 &&
              line.startsWith('账号：') ? (
                <>
                  账号：<span translate="no">{line.slice(3)}</span>
                </>
              ) : (
                line
              )}
            </span>
          ))}
        </p>
        <div className="approval-actions">
          <button className="button secondary" disabled={pending !== null} onClick={() => void answer(false)}>
            {pending === false ? <Loader2 size={13} className="spinning" /> : <X size={13} />}拒绝
          </button>
          <button
            className="button primary"
            disabled={pending !== null || !changePermission}
            title={!changePermission ? '请在 PugPort 桌面窗口中允许' : undefined}
            onClick={() => void answer(true)}
          >
            {pending === true ? <Loader2 size={13} className="spinning" /> : <Check size={13} />}允许此操作
          </button>
        </div>
        {approval.key && (
          <button
            className="button tiny quiet approval-remember"
            disabled={pending !== null || !changePermission}
            title={!changePermission ? '请在 PugPort 桌面窗口中允许' : undefined}
            data-approval-remember
            onClick={() => void answer(true, true)}
          >
            本对话中总是允许：<code translate="no">{translateInterfaceText(approvalRuleLabel(approval.key))}</code>
          </button>
        )}
      </div>
    </section>
  );
}

function HandoffModal({
  run,
  state,
  api,
  onClose,
  onRun,
  notify,
}: {
  run: RunRecord;
  state: AppState;
  api: Api;
  onClose: () => void;
  onRun: (run: RunRecord) => void;
  notify: (notice: Notice) => void;
}) {
  const [runtimeId, setRuntimeId] = useState(
    state.runtimes.find(
      (r) =>
        r.id !== run.route.runtimeId &&
        isCoreProvider(r.provider) &&
        r.capabilities.execute &&
        availableCoreTargets(state.targets).some((t) => t.id === r.id),
    )?.id ?? '',
  );
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [allowUnknownQuota, setAllowUnknownQuota] = useState(false);
  const [pending, setPending] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const availableRuntimes = state.runtimes.filter(
    (runtime) =>
      isCoreProvider(runtime.provider) &&
      runtime.capabilities.execute &&
      availableCoreTargets(state.targets).some((target) => target.id === runtime.id),
  );
  const unavailableRuntime = Boolean(runtimeId && !availableRuntimes.some((runtime) => runtime.id === runtimeId));
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => previous?.focus();
  }, []);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!runtimeId || unavailableRuntime) return;
    setPending(true);
    try {
      const next = await api<RunRecord>(`/api/handoff/${encodeURIComponent(run.id)}`, {
        runtimeId,
        allowUnknownQuota,
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
      });
      onRun(next);
      onClose();
      notify({ tone: 'success', message: '交接任务已创建。' });
    } catch (error) {
      notify({ tone: 'error', message: readableError(error) });
    } finally {
      setPending(false);
    }
  }
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !pending) onClose();
      }}
    >
      <div
        className="modal"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="handoff-title"
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !pending) onClose();
          if (e.key === 'Tab') {
            const elements = dialogRef.current?.querySelectorAll<HTMLElement>(
              'button:not([disabled]), select:not([disabled]), input:not([disabled])',
            );
            if (!elements?.length) return;
            const first = elements[0];
            const last = elements[elements.length - 1];
            if (e.shiftKey && document.activeElement === first) {
              e.preventDefault();
              last.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
              e.preventDefault();
              first.focus();
            }
          }
        }}
      >
        <div className="modal-heading">
          <span className="empty-icon">
            <GitBranch size={23} />
          </span>
          <button ref={closeRef} className="icon-button" onClick={onClose} disabled={pending} aria-label="关闭交接窗口">
            <X size={18} />
          </button>
        </div>
        <h2 id="handoff-title">换一个执行器，继续任务</h2>
        <p>交接基于任务描述、可见输出与验收结果；新任务以只读模式启动。</p>
        <div className="handoff-source">
          <span>当前任务</span>
          <strong>{run.prompt.slice(0, 140)}</strong>
          <code>
            {run.route.runtimeId} / {run.route.model}
          </code>
        </div>
        <form onSubmit={(e) => void submit(e)}>
          <label className="field">
            <span>目标执行器</span>
            <select
              required
              value={runtimeId}
              onChange={(e) => {
                setRuntimeId(e.target.value);
                setModel('');
                setEffort('');
              }}
            >
              <option value="">选择执行器</option>
              {unavailableRuntime && (
                <option value={runtimeId} disabled>
                  {unavailableRuntimeLabel(state, runtimeId)}
                </option>
              )}
              {availableRuntimes.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label} · {runtimeLabels[r.status]}
                </option>
              ))}
            </select>
          </label>
          <div className="fields-grid two">
            <ModelFields
              models={state.runtimes.find((r) => r.id === runtimeId)?.models ?? []}
              model={model}
              effort={effort}
              onModel={setModel}
              onEffort={setEffort}
              disabled={!runtimeId || unavailableRuntime}
            />
          </div>
          {unavailableRuntime && (
            <p className="unavailable-runtime" role="alert">
              目标执行器不可用，请重新选择。
            </p>
          )}
          <details className="target-advanced">
            <summary>高级设置</summary>
            <label className="check-row">
              <input
                type="checkbox"
                checked={state.settings.unknownQuotaPolicy === 'allow' || allowUnknownQuota}
                disabled={state.settings.unknownQuotaPolicy === 'allow'}
                onChange={(e) => setAllowUnknownQuota(e.target.checked)}
              />
              <span>
                本次允许目标执行器订阅额度未报告
                <small>
                  {state.settings.unknownQuotaPolicy === 'allow'
                    ? '设置中已允许未知额度；可前往设置恢复为每次手动确认。'
                    : '未能读取额度时，运行可能触及供应商限额。'}
                </small>
              </span>
            </label>
          </details>
          <div className="modal-actions">
            <button type="button" className="button secondary" onClick={onClose} disabled={pending}>
              取消
            </button>
            <button className="button primary" disabled={pending || !runtimeId || unavailableRuntime}>
              {pending ? <Loader2 className="spinning" size={14} /> : <ArrowRight size={14} />}创建交接任务
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export {
  ProviderMark,
  runtimeLabels,
  useBackend,
  QuotaCard,
  RunOutput,
  TargetEditor,
  SettingsPage,
  ApprovalCard,
  HandoffModal,
  StatusPill,
  EmptyState,
  dateLabel,
  readableError,
};
