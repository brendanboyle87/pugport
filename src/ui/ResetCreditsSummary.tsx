import { currentLocale } from './i18n';
import { useEffect, useState } from 'react';
import type { ResetCredits, RuntimeSnapshot } from '../shared/types';
const date = (value: string | null) =>
  value ? new Date(value).toLocaleString(currentLocale(), { hour12: false }) : '未报告';
const shortDate = (value: string | null) =>
  value ? new Date(value).toLocaleDateString(currentLocale(), { month: 'long', day: 'numeric' }) : '日期未报告';
/**
 * 「额度快用完了，有 2 张重置卡（最早 3 天后到期），可以在详情里用一张」. A hint only: it never redeems. Every case is a
 * whole sentence (one card or more; expiring within the hour, in hours, or in days past a day), so English can say
 * "1 reset card" and "in 3 days".
 */
export function resetCardSuggestion(runtime: RuntimeSnapshot, now: number) {
  const credits = runtime.quota.resetCredits;
  if (runtime.provider !== 'codex' || runtime.quota.status !== 'known' || !credits) return;
  // The tightest window that has not already reset decides whether the account is low.
  const used = runtime.quota.windows
    .filter(
      (window) =>
        typeof window.usedPercent === 'number' &&
        Number.isFinite(window.usedPercent) &&
        !(Date.parse(window.resetsAt ?? '') <= now),
    )
    .map((window) => window.usedPercent!);
  if (!used.length || 100 - Math.max(...used) >= 15) return;
  const details = credits.details ?? [];
  const expired = (card: (typeof details)[number]) => card.expiresAt !== null && Date.parse(card.expiresAt) <= now;
  const available = details.filter((card) => card.kind === 'full' && card.status === 'available' && !expired(card));
  const count =
    credits.availableCount === null
      ? available.length
      : Math.max(
          0,
          credits.availableCount - details.filter((card) => card.status === 'available' && expired(card)).length,
        );
  if (!count) return;
  // Only a reported expiry is shown; count-only reports say nothing about when cards expire.
  const earliest = Math.min(...available.filter((card) => card.expiresAt).map((card) => Date.parse(card.expiresAt!)));
  const one = count === 1;
  if (!Number.isFinite(earliest))
    return one
      ? '额度快用完了，有 1 张重置卡，可以在详情里用一张'
      : `额度快用完了，有 ${count} 张重置卡，可以在详情里用一张`;
  const hours = (earliest - now) / 3_600_000;
  if (hours <= 1)
    return one
      ? '额度快用完了，有 1 张重置卡（1 小时内到期），可以在详情里用一张'
      : `额度快用完了，有 ${count} 张重置卡（最早 1 小时内到期），可以在详情里用一张`;
  if (hours <= 24) {
    const left = Math.ceil(hours);
    return one
      ? `额度快用完了，有 1 张重置卡（${left} 小时后到期），可以在详情里用一张`
      : `额度快用完了，有 ${count} 张重置卡（最早 ${left} 小时后到期），可以在详情里用一张`;
  }
  const days = Math.ceil(hours / 24);
  return one
    ? `额度快用完了，有 1 张重置卡（${days} 天后到期），可以在详情里用一张`
    : `额度快用完了，有 ${count} 张重置卡（最早 ${days} 天后到期），可以在详情里用一张`;
}
export function ResetCreditsSummary({
  credits,
  now: fixedNow,
  runtimeId,
  fingerprint,
  accountLabel,
  autoUseResetCards = false,
}: {
  credits?: ResetCredits;
  now?: number;
  runtimeId?: string;
  fingerprint?: string;
  accountLabel?: string;
  autoUseResetCards?: boolean;
}) {
  const [confirm, setConfirm] = useState<string>(),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    [, setTick] = useState(0);
  const now = fixedNow ?? Date.now();
  // Redraw the moment the next card expires, so it disappears without waiting for the next quota refresh.
  const nextExpiry = Math.min(
    ...(credits?.details ?? [])
      .filter((card) => card.status === 'available' && card.expiresAt && Date.parse(card.expiresAt) > now)
      .map((card) => Date.parse(card.expiresAt!)),
  );
  useEffect(() => {
    if (fixedNow !== undefined || !Number.isFinite(nextExpiry)) return;
    const timer = setTimeout(() => setTick((value) => value + 1), Math.min(nextExpiry - Date.now() + 500, 2 ** 31 - 1));
    return () => clearTimeout(timer);
  }, [nextExpiry, fixedNow]);
  useEffect(() => {
    setConfirm(undefined);
    setMessage('');
  }, [runtimeId, fingerprint]);
  async function redeem(key: string) {
    setBusy(true);
    setMessage('');
    try {
      const { token } = await (await fetch('/api/session')).json();
      const res = await fetch('/api/targets/' + encodeURIComponent(runtimeId!) + '/reset-credit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-agent-token': token },
        body: JSON.stringify({ key, fingerprint, confirmed: true }),
      });
      const data = await res.json();
      if (!res.ok) throw Error(data.error || '兑换结果未确认，请刷新核对');
      setMessage(
        (
          {
            reset: '重置已使用，额度已重新查询。',
            alreadyRedeemed: '该请求已处理，额度已重新查询。',
            nothingToReset: '当前没有可重置的额度，未使用重置卡。',
            noCredit: '服务端报告没有可用重置卡。',
          } as Record<string, string>
        )[data.outcome] || '请刷新核对结果',
      );
      setConfirm(undefined);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : '请求失败，请刷新核对');
    } finally {
      setBusy(false);
    }
  }
  if (!credits) return <p className="quota-note">官方重置卡：CLI 未报告</p>;
  const stale = now - Date.parse(credits.observedAt) > 180000;
  // Only cards that can still be used are listed: used or expired ones are gone, and a card that expired
  // since the last report no longer counts (the next quota refresh confirms it from the service).
  const expiredSince = (credits.details ?? []).filter(
    (card) => card.status === 'available' && card.expiresAt !== null && Date.parse(card.expiresAt) <= now,
  ).length;
  const usable = (credits.details ?? []).filter(
    (card) =>
      card.status !== 'consumed' &&
      card.status !== 'expired' &&
      !(card.expiresAt !== null && Date.parse(card.expiresAt) <= now),
  );
  const count = credits.availableCount === null ? null : Math.max(0, credits.availableCount - expiredSince);
  return (
    <section className="benefit-panel" aria-label="额度重置卡">
      <header className="benefit-header">
        <strong>额度重置卡</strong>
        <span className="benefit-badge">
          {count === null ? '次数未报告' : `${count} 次可用`}
          {stale ? ' · 待刷新' : ''}
        </span>
      </header>
      {usable.map((card, index) => {
        const status = { available: '可用', consumed: '已使用', expired: '已过期', unknown: '状态未报告' }[card.status];
        const enabled =
          !!runtimeId && !!fingerprint && !!card.key && card.kind === 'full' && card.status === 'available' && !stale;
        return (
          <article className="benefit-row" key={card.key ?? index}>
            <div className="benefit-row-main">
              <div>
                <strong>{card.kind === 'full' ? '完整额度重置' : '重置类型未识别'}</strong>
                <div className="benefit-expiry" title={date(card.expiresAt)}>
                  {shortDate(card.expiresAt)}到期{status === '可用' ? '' : ` · ${status}`}
                </div>
              </div>
              {runtimeId && (
                <button
                  className="button secondary tiny"
                  disabled={!enabled || busy}
                  onClick={() => {
                    setConfirm(card.key);
                    setMessage('');
                  }}
                >
                  使用重置
                </button>
              )}
            </div>
            {confirm === card.key && card.key && (
              <div className="benefit-confirm">
                <p>为 {accountLabel || '所选账号'} 使用这张重置卡？使用后不可撤销。</p>
                <button
                  className="button secondary tiny"
                  disabled={busy || !enabled}
                  onClick={() => void redeem(card.key!)}
                >
                  {busy ? '正在处理…' : '确认使用'}
                </button>{' '}
                <button className="button secondary tiny" disabled={busy} onClick={() => setConfirm(undefined)}>
                  取消
                </button>
              </div>
            )}
            <details className="benefit-details">
              <summary>详情</summary>
              <p>
                发放：{date(card.grantedAt)}
                <br />
                到期：{date(card.expiresAt)}（本地时间）
                <br />
                状态：{status}
              </p>
            </details>
          </article>
        );
      })}
      {credits.details && !usable.length && count === 0 && <p className="quota-note">没有可用的重置卡。</p>}
      {!credits.details?.length && (
        <p className="quota-note">
          {credits.details === null ? '卡片明细和过期时间未报告。' : '接口未返回卡片明细；可用次数以报告为准。'}
        </p>
      )}
      {message && (
        <p role="status" className="quota-note">
          {message}
        </p>
      )}
      <details className="benefit-details">
        <summary>来源与更新</summary>
        <p>
          核验：{date(credits.observedAt)}
          <br />
          {credits.source}
          <br />
          卡片到期与额度窗口重置不同。{autoUseResetCards ? '已开启按条件自动使用' : '不自动使用'}
          ；明细可能仅为部分卡片。
        </p>
      </details>
    </section>
  );
}
