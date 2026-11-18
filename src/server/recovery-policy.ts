import { createHash } from 'node:crypto';
import type { RunInput, RunRecord, Workflow } from '../shared/types.ts';
import { normalizeScope } from '../shared/scope.ts';

const recoveryScope = (scope?: readonly string[]) => {
  const paths = [...new Set(normalizeScope(scope ?? []).map((path) => path.toLowerCase()))].sort();
  return paths.filter((path, index) => !paths.slice(0, index).some((folder) => path.startsWith(`${folder}/`)));
};

const conditions: Record<string, [string, string]> = {
  'runtime-permission-or-sandbox-error': ['执行权限或文件范围不足。', '用户补充所需权限或修正文件范围后继续。'],
  'permission-denied': ['宿主拒绝了所需权限。', '用户授权所需操作后继续。'],
  'approval-required': ['操作仍在等待授权。', '用户完成原有授权后继续。'],
  'missing-input': ['缺少执行所需输入。', '用户补充缺少的输入后继续。'],
  'input-required': ['缺少执行所需输入。', '用户补充缺少的输入后继续。'],
  'authentication-required': ['当前账号认证失败。', '重新登录或改用已认证的其他账号后继续。'],
  'api-key-auth-or-configuration': ['API 认证或配置无效。', '修正认证配置或改用可用账号后继续。'],
  'api-key-workspace-required': ['API 账号缺少工作区配置。', '补齐工作区配置或改用可用账号后继续。'],
  'runtime-not-found': ['所选执行器未安装或不可用。', '安装执行器或选择已安装的执行器后继续。'],
};

export const authenticationRecoveryCodes = new Set([
  'authentication-required',
  'api-key-auth-or-configuration',
  'api-key-workspace-required',
]);

/** shortcut: this is literal matching, not semantic equivalence; the host-condition failure cap bounds paraphrase retries. */
export function delegationRecoveryKey(task: string, permission: RunInput['permissionMode'], scope?: readonly string[]) {
  return createHash('sha256')
    .update(
      JSON.stringify([
        task.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim(),
        permission,
        recoveryScope(scope),
      ]),
    )
    .digest('hex');
}

/** Only host failure codes establish a recovery condition; output and tool text confer no authority. */
export function recoveryCondition(run: RunRecord, input: RunInput, at: string): Workflow['recovery'] {
  const condition = run.errorCode ? conditions[run.errorCode] : undefined;
  if (!condition) return;
  return {
    failureCode: run.errorCode!,
    reason: condition[0],
    recoveryCondition: condition[1],
    at,
    conditionKey: createHash('sha256')
      .update(
        JSON.stringify([
          run.errorCode,
          run.route.runtimeId,
          run.account?.fingerprint ?? run.route.accountFingerprint,
          input.permissionMode,
          input.projectPath,
          recoveryScope(input.writeShare?.scope),
          input.verificationCommand,
        ]),
      )
      .digest('hex'),
  };
}

/** Existing quota/network fallback stays intact; known blockers require a changed host condition. */
export function canAutomaticallyRecover(run: RunRecord, previous: RunInput, next: RunInput): boolean {
  if (!run.errorCode || !conditions[run.errorCode]) return true;
  if (
    run.errorCode === 'runtime-permission-or-sandbox-error' ||
    run.errorCode === 'permission-denied' ||
    run.errorCode === 'approval-required' ||
    run.errorCode === 'missing-input' ||
    run.errorCode === 'input-required'
  )
    return false;
  // These fields come from the host router. A rewritten prompt is never a changed condition.
  const provider = run.account?.provider ?? previous.provider;
  return (
    (next.runtimeId !== undefined && next.runtimeId !== run.route.runtimeId) ||
    next.excludeRuntimeIds?.includes(run.route.runtimeId) === true ||
    (provider !== undefined && next.provider !== undefined && next.provider !== provider)
  );
}
