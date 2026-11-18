import type { ApprovalKey, ApprovalRule } from './types.ts';

export function approvalRuleLabel(rule: ApprovalKey | ApprovalRule): string {
  return 'command' in rule ? `命令：${rule.command}` : '本项目文件夹内的文件修改';
}
