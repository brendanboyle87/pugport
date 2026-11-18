import { currentLocale } from './i18n';
import type { SubscriptionPlan } from '../shared/types';
export function SubscriptionSummary({
  plan,
  usage,
  identity,
}: {
  plan?: SubscriptionPlan;
  usage?: boolean;
  identity?: string;
}) {
  return (
    <div className="subscription-summary">
      <div className="runtime-connection">
        <span>会员方案</span>
        <strong>{usage ? 'API 按量计费' : plan?.label || '未报告'}</strong>
      </div>
      {identity && <p className="quota-note">账号标识：{identity.slice(0, 8)}（本地匿名标识）</p>}
      {plan && !usage && (
        <p className="quota-note" title={plan.source}>
          套餐核验：{new Date(plan.observedAt).toLocaleString(currentLocale(), { hour12: false })}
        </p>
      )}
      {!usage && (
        <p className="quota-note">
          百分比相对于此账号的当前套餐额度；不同套餐不可直接比较。供应商未报告绝对总量时，不换算成 Token 或次数。
        </p>
      )}
    </div>
  );
}
