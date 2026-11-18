import { ProblemReportCard } from './ProblemReport';
import type { ProblemReportInboxItem } from '../shared/problem-report';
import { useEffect, useRef, useState } from 'react';
import { Inbox, X } from 'lucide-react';
import type { InboxAction, InboxNotice, InboxSummary } from '../shared/inbox';
import type { RuntimeTarget } from '../shared/types';
import type { Api, Notice } from './Workspace';
import { readableError } from './App';
import { currentLocale, translateInterfaceText } from './i18n';
import { useDismiss } from './use-dismiss';
import { useFocusTrap } from './use-focus-trap';
import type { BankConnectionView, LinkSessionView } from '../shared/mod-data';
import { requestBankLink } from './BankLinkDialog';

const actionLabels: Record<InboxAction['kind'], string> = {
  'sign-in': '登录',
  'replace-key': '更换密钥',
  'update-cli': '更新 CLI',
  'rollback-cli': '回滚',
  'open-usage': '用量与连接',
  'view-run': '查看运行记录',
  refresh: '刷新',
  'github-merge': '合并',
  'github-run-suite': '跑全量测试',
  'open-project-rules': '查看项目规则',
  'open-bank-settings': '银行连接',
};

function relativeTime(at: string) {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(at)) / 60_000));
  const [value, unit] =
    minutes < 60
      ? [minutes, 'minute']
      : minutes < 1440
        ? [Math.floor(minutes / 60), 'hour']
        : [Math.floor(minutes / 1440), 'day'];
  return new Intl.RelativeTimeFormat(currentLocale(), { numeric: 'auto' }).format(
    -Number(value),
    unit as Intl.RelativeTimeFormatUnit,
  );
}

export function ExternalRequestCard({
  notice,
  busy,
  decide,
  onWorkflow,
}: {
  notice: InboxNotice;
  busy: boolean;
  decide: (decision: 'approve' | 'reject' | 'always') => unknown;
  onWorkflow: (id: string) => unknown;
}) {
  const [expanded, setExpanded] = useState(false);
  const request = notice.externalRequest!;
  const approved = request.status === 'approved';
  const permalink =
    request.permalink &&
    (request.source === 'github' ? /^https:\/\/github\.com\//i : /^https:\/\/(?:[a-z0-9-]+\.)?slack\.com\//i).test(
      request.permalink,
    )
      ? request.permalink
      : undefined;
  return (
    <li className={`inbox-row external-request${request.status !== 'pending' ? ' settled' : ''}`}>
      {request.source === 'github' ? (
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          role="img"
          aria-label="GitHub"
          className="external-request-icon"
        >
          <path
            fill="currentColor"
            d="M12 .3a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2.2c-3.3.7-4-1.4-4-1.4-.5-1.4-1.3-1.8-1.3-1.8-1.1-.8.1-.8.1-.8 1.2.1 1.8 1.2 1.8 1.2 1.1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.3-5.5-6A4.7 4.7 0 0 1 5.6 8c-.1-.3-.5-1.5.1-3.2 0 0 1-.3 3.3 1.2a11.4 11.4 0 0 1 6 0c2.3-1.5 3.3-1.2 3.3-1.2.6 1.7.2 2.9.1 3.2a4.7 4.7 0 0 1 1.2 3.3c0 4.6-2.8 5.6-5.5 5.9.4.4.8 1.1.8 2.2v3.7c0 .3.2.7.8.6A12 12 0 0 0 12 .3Z"
          />
        </svg>
      ) : (
        <svg width="16" height="16" viewBox="0 0 24 24" role="img" aria-label="Slack" className="external-request-icon">
          <path
            d="M9 3v12M15 9v12M3 9h12M9 15h12"
            fill="none"
            stroke="currentColor"
            strokeWidth="4"
            strokeLinecap="round"
          />
        </svg>
      )}
      <div className="inbox-content">
        {request.status === 'pending' ? (
          <>
            <div className="external-request-heading">
              <strong>{`${request.senderName} 在 ${request.scopeLabel} 请求`}</strong>
              <time dateTime={notice.createdAt} translate="no">
                {relativeTime(notice.createdAt)}
              </time>
            </div>
            <button
              type="button"
              className={`external-request-text${expanded ? ' expanded' : ''}`}
              aria-expanded={expanded}
              aria-label={expanded ? '收起请求' : '展开请求'}
              onClick={() => setExpanded(!expanded)}
              translate="no"
            >
              {notice.body}
            </button>
            <div className="external-request-actions">
              <button type="button" className="button inbox-action" disabled={busy} onClick={() => decide('approve')}>
                批准
              </button>
              <button
                type="button"
                className="button quiet inbox-action"
                disabled={busy}
                onClick={() => decide('reject')}
              >
                拒绝
              </button>
              <button
                type="button"
                className={`button inbox-action${request.suggestAlways ? ' primary' : ' quiet'}`}
                disabled={busy}
                onClick={() => decide('always')}
              >
                以后都直接做
              </button>
              {permalink && (
                <a href={permalink} target="_blank" rel="noreferrer" className="external-request-link">
                  {request.source === 'github' ? '在 GitHub 打开 ↗' : '在 Slack 打开 ↗'}
                </a>
              )}
            </div>
          </>
        ) : (
          <div className="external-request-settled">
            <span>
              {!approved
                ? '已拒绝'
                : request.receiptState === 'done'
                  ? '已批准 · 已完成'
                  : request.receiptState === 'failed'
                    ? '已批准 · 没做成'
                    : '已批准 · 处理中'}
            </span>
            {approved && request.workflowId && (
              <button
                type="button"
                className="button quiet inbox-action"
                onClick={() => onWorkflow(request.workflowId!)}
              >
                查看任务
              </button>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

export function ExternalDigestCard({
  notice,
  busy,
  decide,
  onWorkflow,
}: {
  notice: InboxNotice;
  busy: boolean;
  decide: (id: string, decision: 'approve' | 'reject') => unknown;
  onWorkflow: (id: string) => unknown;
}) {
  const digest = notice.externalDigest!;
  type Item = (typeof digest.pending)[number];
  function row(item: Item, pending = false) {
    const url = item.permalink && /^https:\/\//i.test(item.permalink) ? item.permalink : undefined;
    return (
      <li className="external-digest-item" key={item.id}>
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          aria-label={item.source === 'github' ? 'GitHub' : 'Slack'}
          role="img"
        >
          {item.source === 'github' ? (
            <path
              fill="currentColor"
              d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.86c-2.78.61-3.37-1.18-3.37-1.18-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.61.07-.61 1 .07 1.53 1.03 1.53 1.03.89 1.53 2.34 1.09 2.91.83.09-.65.35-1.09.64-1.34-2.22-.25-4.56-1.11-4.56-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.02A9.6 9.6 0 0 1 12 6.82c.85 0 1.71.11 2.51.34 1.91-1.29 2.75-1.02 2.75-1.02.55 1.38.2 2.4.1 2.65.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.69-4.57 4.94.36.31.68.92.68 1.85v2.75c0 .27.18.58.69.48A10 10 0 0 0 12 2Z"
            />
          ) : (
            <path
              d="M9 3v12M15 9v12M3 9h12M9 15h12"
              fill="none"
              stroke="currentColor"
              strokeWidth="4"
              strokeLinecap="round"
            />
          )}
        </svg>
        {url ? (
          <a
            className="external-digest-text"
            href={url}
            target="_blank"
            rel="noreferrer"
            title={item.text}
            translate="no"
          >
            {item.text}
          </a>
        ) : item.workflowId ? (
          <button
            className="external-digest-text"
            type="button"
            onClick={() => onWorkflow(item.workflowId!)}
            title={item.text}
            translate="no"
          >
            {item.text}
          </button>
        ) : (
          <span className="external-digest-text" title={item.text} translate="no">
            {item.text}
          </span>
        )}
        {pending && item.status === 'pending' && (
          <span className="external-digest-actions">
            <button
              className="button inbox-action"
              type="button"
              disabled={busy}
              onClick={() => decide(item.id, 'approve')}
            >
              批准
            </button>
            <button
              className="button quiet inbox-action"
              type="button"
              disabled={busy}
              onClick={() => decide(item.id, 'reject')}
            >
              拒绝
            </button>
          </span>
        )}
        {pending && item.status && item.status !== 'pending' && (
          <small>{item.status === 'approved' ? '已批准' : '已拒绝'}</small>
        )}
      </li>
    );
  }
  const groups = digest.noted.filter(
    (item, index, items) =>
      items.findIndex((other) => other.source === item.source && other.group === item.group) === index,
  );
  return (
    <li className="inbox-row external-digest">
      <div className="inbox-content">
        <strong className="external-digest-title">
          <span>昨天：</span>
          {notice.title
            .replace(/^昨天：/, '')
            .split(' · ')
            .map((part, index) => (
              <span key={index} translate="no">
                {index ? ' · ' : ''}
                {translateInterfaceText(part)}
              </span>
            ))}
        </strong>
        {!!digest.pending.length && (
          <section>
            <h4>等你确认</h4>
            <ul>{digest.pending.map((item) => row(item, true))}</ul>
          </section>
        )}
        {!!digest.done.length && (
          <section>
            <h4>做完了</h4>
            <ul>{digest.done.map((item) => row(item))}</ul>
          </section>
        )}
        {!!digest.noted.length && (
          <section>
            <h4>记下来的</h4>
            {groups.map((group) => (
              <div className="external-digest-group" key={JSON.stringify([group.source, group.group])}>
                <h5 translate="no">{`${group.source === 'github' ? 'GitHub' : 'Slack'} ? ${group.group}`}</h5>
                <ul>
                  {digest.noted
                    .filter((item) => item.source === group.source && item.group === group.group)
                    .map((item) => row(item))}
                </ul>
              </div>
            ))}
          </section>
        )}
        {digest.remaining > 0 && <p className="external-digest-more">{`还有 ${digest.remaining} 条`}</p>}
      </div>
    </li>
  );
}

export function InboxButton({
  summary,
  reportCount = 0,
  reportSession = '',
  targets = [],
  api,
  reload,
  notify,
  openPage,
  onModDetails,
  onRun,
  onWorkflow,
  onProjectRules,
}: {
  summary?: InboxSummary;
  reportCount?: number;
  reportSession?: string;
  targets?: readonly Pick<RuntimeTarget, 'id' | 'accountId'>[];
  api: Api;
  reload: () => Promise<unknown>;
  notify: (notice: Notice) => void;
  openPage: (page: 'resources' | 'integrations') => unknown;
  onModDetails?: (modId?: string) => unknown;
  onRun: (id: string) => unknown;
  onWorkflow?: (id: string) => unknown;
  onProjectRules: (id: string) => unknown;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const panel = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const close = () => {
    setOpen(false);
    button.current?.focus();
  };
  const [reportViewer, setReportViewer] = useState(false);
  useDismiss(open && !reportViewer, panel, close, () => button.current);
  useFocusTrap(open && !reportViewer, panel);
  const [reports, setReports] = useState<ProblemReportInboxItem[]>([]);
  const reportGeneration = useRef(0);
  const loadReports = () => {
    const generation = ++reportGeneration.current;
    void api<{ reports: ProblemReportInboxItem[] }>('/api/problem-reports/inbox')
      .then((value) => {
        if (generation === reportGeneration.current) setReports(value.reports);
      })
      .catch(() => {
        if (generation === reportGeneration.current) setReports([]);
      });
  };
  useEffect(() => {
    reportGeneration.current++;
    setReports([]);
    if (open) loadReports();
    return () => {
      reportGeneration.current++;
    };
  }, [open, reportSession, reportCount]);
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(loadReports, 60 * 1000);
    return () => clearInterval(timer);
  }, [open, reportSession]);
  const notices = summary?.open ?? [];
  const attention = notices.some((notice) => notice.severity === 'action' && !notice.readAt);
  async function perform(action: () => Promise<unknown>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      await action();
      await reload();
    } catch (error) {
      notify({ tone: 'error', message: readableError(error) });
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  function toggle() {
    if (open) return close();
    setOpen(true);
    return perform(() => api('/api/inbox/read', {}));
  }
  function act(action: InboxAction, noticeId: string) {
    return perform(async () => {
      switch (action.kind) {
        case 'rollback-cli': {
          const result = await api<{ ok: boolean; reason?: string }>('/api/inbox/rollback-cli', {
            runtimeId: action.runtimeId,
          });
          if (!result.ok) throw new Error(result.reason || '无法回滚 CLI，请在连接页检查。');
          notify({ tone: 'success', message: result.reason || '已回滚 CLI。' });
          break;
        }
        case 'open-project-rules':
          await onProjectRules(action.projectId);
          await api(`/api/inbox/${encodeURIComponent(noticeId)}/dismiss`, {});
          break;
        case 'sign-in':
          if (!targets.some((target) => target.id === action.runtimeId && target.accountId)) {
            await openPage('integrations');
            break;
          }
          await api(`/api/accounts/${encodeURIComponent(action.runtimeId)}/login`, {});
          notify({ tone: 'info', message: '已打开官方登录窗口，登录完成后会自动检查。' });
          break;
        case 'replace-key':
        case 'update-cli':
        case 'open-usage':
          await openPage('integrations');
          break;
        case 'view-run':
          await onRun(action.runId);
          break;
        case 'github-merge':
          await api(`/api/maintainer/cards/${encodeURIComponent(action.cardId)}/merge`, {});
          break;
        case 'github-run-suite':
          await api(`/api/maintainer/cards/${encodeURIComponent(action.cardId)}/run-suite`, {});
          break;
        case 'refresh':
          await api('/api/refresh', {});
          break;
        case 'open-bank-settings': {
          // Older notices only carry the connection ID in their stable key.
          const connectionId =
            action.connectionId ?? notices.find((notice) => notice.id === noticeId)?.key.replace(/:(new|reauth)$/, '');
          const { connections } = await api<{ connections: (BankConnectionView & { modIds: string[] })[] }>(
            '/api/bank/connections',
            undefined,
            'GET',
          );
          const connection = connections.find((item) => item.id === connectionId);
          if (connection?.status === 'reauth_required') {
            await requestBankLink({
              api,
              start: () => api<LinkSessionView>('/api/bank/connections/link', { reconnect: connection.id }),
            });
          } else await onModDetails?.(action.modId ?? connection?.modIds[0]);
          break;
        }
      }
      close();
    });
  }
  return (
    <div className="sidebar-inbox-anchor">
      <button
        ref={button}
        type="button"
        className={`icon-button sidebar-inbox${attention ? ' needs-action' : ''}`}
        title="信箱"
        aria-label={summary?.unread ? `信箱，${summary.unread} 条未读提醒` : '信箱'}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={!summary && !reportCount}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={toggle}
      >
        <Inbox size={15} />
        {!!((summary?.unread ?? 0) + reportCount) && (
          <span className="nav-count">{(summary?.unread ?? 0) + reportCount}</span>
        )}
      </button>
      {open && (
        <div ref={panel} className="inbox-panel" role="dialog" aria-modal="true" aria-label="信箱">
          <header className="inbox-header">
            <div>
              <strong>信箱</strong>
              <small>{summary?.attention ? `${summary.attention} 条需要你处理` : '一切正常'}</small>
            </div>
            <button type="button" className="icon-button" aria-label="关闭信箱" onClick={close}>
              <X size={15} />
            </button>
          </header>
          {!!reports.length && (
            <ul className="inbox-list">
              {reports.map((report) => (
                <ProblemReportCard
                  key={report.id}
                  report={report}
                  api={api}
                  onViewerChange={setReportViewer}
                  onChanged={loadReports}
                  onTask={onWorkflow ?? (() => undefined)}
                />
              ))}
            </ul>
          )}
          {notices.length ? (
            <ul className="inbox-list">
              {notices.map((notice) =>
                notice.kind === 'external-digest' && notice.externalDigest ? (
                  <ExternalDigestCard
                    key={notice.id}
                    notice={notice}
                    busy={busy}
                    onWorkflow={onWorkflow ?? (() => undefined)}
                    decide={(id, decision) =>
                      perform(() => api(`/api/slack/requests/${encodeURIComponent(id)}/resolve`, { decision }))
                    }
                  />
                ) : notice.kind === 'external-request' && notice.externalRequest ? (
                  <ExternalRequestCard
                    key={notice.id}
                    notice={notice}
                    busy={busy}
                    onWorkflow={onWorkflow ?? (() => undefined)}
                    decide={(decision) =>
                      perform(() =>
                        api(
                          `/api/${notice.externalRequest!.source}/requests/${encodeURIComponent(notice.externalRequest!.eventId)}/resolve`,
                          {
                            decision,
                          },
                        ),
                      )
                    }
                  />
                ) : (
                  <li key={notice.id} className="inbox-row">
                    <span
                      role="img"
                      className={`inbox-severity ${notice.severity}`}
                      aria-label={{ info: '提示', warning: '注意', action: '需要处理' }[notice.severity]}
                    />
                    <div className="inbox-content">
                      <strong>{notice.title}</strong>
                      {notice.body &&
                        notice.body.split('\n\n').map((paragraph, index) => (
                          <p key={index} translate={notice.bodyVerbatim ? 'no' : undefined}>
                            {paragraph}
                          </p>
                        ))}
                      {notice.details && (
                        <details>
                          <summary>原始报错</summary>
                          <pre>{notice.details}</pre>
                        </details>
                      )}
                      <div className="inbox-row-footer">
                        <span className="inbox-time">
                          <time dateTime={notice.updatedAt} translate="no">
                            {relativeTime(notice.updatedAt)}
                          </time>
                          {notice.count > 1 && ` · ×${notice.count}`}
                        </span>
                        {notice.action && (
                          <button
                            type="button"
                            className="button quiet inbox-action"
                            disabled={busy}
                            onClick={() => act(notice.action!, notice.id)}
                          >
                            {actionLabels[notice.action.kind]}
                          </button>
                        )}
                        <button
                          type="button"
                          className="icon-button inbox-dismiss"
                          aria-label="关闭提醒"
                          disabled={busy}
                          onClick={() => perform(() => api(`/api/inbox/${encodeURIComponent(notice.id)}/dismiss`, {}))}
                        >
                          <X size={13} />
                        </button>
                      </div>
                    </div>
                  </li>
                ),
              )}
            </ul>
          ) : (
            <div className="inbox-empty">
              <Inbox size={24} />
              <strong>一切正常</strong>
              <p>需要你登录、换密钥或更新时，PugPort 会在这里告诉你。</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
