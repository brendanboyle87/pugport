import { isApiHarness } from '../shared/provider-registry.ts';
import type { RuntimeSnapshot, RuntimeTarget } from '../shared/types.ts';
export function accountSnapshot(snapshot: RuntimeSnapshot, target: RuntimeTarget): RuntimeSnapshot {
  if (target.accountingMode && target.accountingMode !== 'auto')
    return {
      ...snapshot,
      accounting: {
        mode: target.accountingMode,
        source: '用户选择统计方式',
        note: '统计方式不改变模型供应商的计费规则。',
      },
    };
  if (snapshot.quota.status === 'known')
    return {
      ...snapshot,
      accounting: {
        mode: 'subscription',
        source: snapshot.quota.source,
        note: '使用供应商实际报告的额度窗口；消耗另行记录。',
      },
    };
  if (snapshot.accounting && snapshot.accounting.mode !== 'unknown') return snapshot;
  if (isApiHarness(snapshot.provider))
    return {
      ...snapshot,
      accounting: {
        mode: 'usage',
        source: '运行时消耗事件',
        note: '此入口按已报告的 token 和参考费用累计；不要求自身余额，也不据此推断 API 或订阅计费身份。',
      },
    };
  return {
    ...snapshot,
    accounting: { mode: 'unknown', source: '未确认统计方式', note: '尚无可靠的额度或计费类型信息。' },
  };
}
