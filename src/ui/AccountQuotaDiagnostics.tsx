import { currentLocale } from './i18n';
import type { RuntimeSnapshot } from '../shared/types';

type Account = Pick<
  RuntimeSnapshot,
  'provider' | 'status' | 'quota' | 'availability' | 'lastRequestFailure' | 'lastConnectionTest'
>;
const date = (value?: string | null) =>
  value && Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleString(currentLocale(), { hour12: false })
    : '时间未报告';

function passedAfterFailure(account: Account): boolean {
  const failure = account.lastRequestFailure ?? account.availability?.billingFailure;
  if (!failure) return false;
  // A finished task on the same account after the failure also shows requests go through again.
  if (account.lastRequestFailure?.laterSuccessAt) return true;
  return !!(
    account.lastConnectionTest?.ok &&
    Date.parse(account.lastConnectionTest.at) > Date.parse(failure.at) &&
    account.lastConnectionTest.model === failure.model
  );
}

export function quotaRequestConflict(account: Account): boolean {
  const failure = account.lastRequestFailure ?? account.availability?.billingFailure;
  return !!(
    failure?.statusCode === 402 &&
    !passedAfterFailure(account) &&
    account.quota.status === 'known' &&
    account.quota.windows.some(
      (window) =>
        typeof window.usedPercent === 'number' &&
        Number.isFinite(window.usedPercent) &&
        window.usedPercent >= 0 &&
        window.usedPercent < 100,
    )
  );
}

/** Discovery, billing observations and actual requests are independent facts. */
export function accountExecutionStatus(account: Account, now: number): string | undefined {
  if (account.availability?.reason === 'authentication') return '认证受阻';
  if (account.availability?.reason === 'quota') {
    const retry = Date.parse(account.availability.retryAt ?? '');
    return !Number.isFinite(retry) || retry > now ? '请求额度受限' : '已到请求复查时间';
  }
  if (account.status === 'ready' && account.lastRequestFailure && !passedAfterFailure(account))
    return '最近请求失败 · 待复查';
  return undefined;
}

const percentLabels = {
  'cli-reported': '比例由命令行明确报告',
  'web-reported': '比例由官方账单明确报告',
  'legacy-calculated': '比例由账单用量与上限计算',
  'implicit-zero': '比例按完整账单推算（接口未返回比例字段）',
  unknown: '比例来源未报告',
};

export function AccountQuotaDiagnostics({
  account,
  now,
  hideBilling = false,
  billingOnly = false,
}: {
  account: Account;
  now: number;
  hideBilling?: boolean;
  billingOnly?: boolean;
}) {
  const failure = account.lastRequestFailure ?? account.availability?.billingFailure;
  const conflict = quotaRequestConflict(account);
  const blocked = account.availability?.reason === 'quota';
  const retry = Date.parse(account.availability?.retryAt ?? '');
  const cooling = blocked && (!Number.isFinite(retry) || retry > now);
  const billing = account.quota.grokBilling;
  if ((account.provider !== 'grok' || hideBilling) && !account.availability && !failure) return null;
  return (
    <div className={`account-quota-diagnostics ${conflict ? 'quota-conflict' : ''}`}>
      {account.provider === 'grok' && !hideBilling && (
        <>
          <p>
            账单来源：{account.quota.source || '未报告'} ·{' '}
            <time dateTime={account.quota.observedAt ?? undefined}>{date(account.quota.observedAt)}</time>
          </p>
          <p>{percentLabels[billing?.percentSource ?? 'unknown']}</p>
          <p>
            {billing?.isUnifiedBillingUser === true
              ? '账单模式：共享周/月额度'
              : billing?.isUnifiedBillingUser === false
                ? '账单模式：未启用共享额度'
                : '账单模式：未报告'}
          </p>
        </>
      )}
      {!billingOnly && (
        <>
          {conflict && <strong className="quota-conflict-title">账单额度与实际请求冲突</strong>}
          {failure && (
            <p>
              最近请求失败：HTTP {failure.statusCode} · {failure.model || '模型未记录'} ·{' '}
              <time dateTime={failure.at}>{date(failure.at)}</time>
            </p>
          )}
          {account.availability?.reason === 'authentication' ? (
            <p>实际请求的认证被拒绝，需要重新登录后检查。</p>
          ) : cooling ? (
            <p>
              已暂时避开此账号 ·{' '}
              {Number.isFinite(retry) ? `${date(account.availability?.retryAt)} 后可复查` : '复查时间未报告'}
            </p>
          ) : failure && !passedAfterFailure(account) ? (
            <p>最近失败记录仍保留；账单刷新不能确认请求已恢复。</p>
          ) : failure ? (
            <p>之后同模型的实际测试已通过；此前失败保留供诊断。</p>
          ) : null}
          {failure && (
            <details>
              <summary>请求错误详情</summary>
              <p>错误来源：{failure.source}</p>
              <p>{failure.message}</p>
              <p>
                执行记录：<code>{failure.runId}</code>
              </p>
              <p>这是供应商实际请求返回的错误；不能据此判定两笔独立余额或账号绑定错误。</p>
            </details>
          )}
        </>
      )}
    </div>
  );
}
