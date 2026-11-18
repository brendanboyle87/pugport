import type { Delegation, Provider } from './types.ts';

export const delegationRoleLabels: Record<Delegation['role'], string> = {
  scout: '调查',
  worker: '实现',
  reviewer: '审查',
};

export const providerNames: Record<Provider, string> = {
  codex: 'Codex',
  claude: 'Claude',
  grok: 'Grok',
  cursor: 'Cursor',
  gemini: 'Gemini',
  pi: 'Pi',
  dsh: 'DSH',
};

/** e.g. "子任务 · 审查（交叉审查 Codex 的结果）". */
export function delegationLabel(delegation: Delegation): string {
  const role = delegationRoleLabels[delegation.role];
  const agent = delegation.agent;
  if (agent) return `子任务 · ${role} · ${agent.label}${agent.caller ? `（由 ${agent.caller} 调用）` : ''}`;
  const check = delegation.crossCheck;
  if (!check) return `子任务 · ${role}`;
  return check.sameProvider
    ? `子任务 · ${role}（仍由 ${providerNames[check.of]} 审查，没有其他可用执行器）`
    : `子任务 · ${role}（交叉审查 ${providerNames[check.of]} 的结果）`;
}

/** First line of a delegated task's answer in the conversation. */
export function delegationHeading(delegation: Delegation): string {
  return `${delegationLabel(delegation)} · 已完成（父任务 ${delegation.parentId.slice(0, 8)}）`;
}
