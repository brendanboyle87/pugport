import type { ExternalDigest } from './external-digest.ts';
export type InboxKind =
  | 'external-request'
  | 'external-digest'
  | 'executor-login'
  | 'executor-key'
  | 'executor-missing'
  | 'executor-failing'
  | 'executor-incompatible'
  | 'executor-update'
  | 'github-card'
  | 'rule-added'
  | 'network'
  | 'api-budget'
  | 'bank-connection';
export type InboxSeverity = 'info' | 'warning' | 'action';
export type InboxAction =
  | { kind: 'sign-in' | 'replace-key' | 'update-cli' | 'rollback-cli' | 'open-usage'; runtimeId: string }
  | { kind: 'view-run'; runId: string }
  | { kind: 'refresh' }
  | { kind: 'open-bank-settings'; connectionId?: string; modId?: string }
  | { kind: 'open-project-rules'; projectId: string }
  | { kind: 'github-merge' | 'github-run-suite'; cardId: string };
export type InboxNotice = {
  externalDigest?: ExternalDigest;
  externalRequest?: {
    eventId: string;
    source: 'slack' | 'github';
    senderName: string;
    scopeLabel: string;
    permalink?: string;
    status: 'pending' | 'approved' | 'rejected';
    receiptState?: 'received' | 'working' | 'done' | 'failed' | 'rejected' | 'noted';
    workflowId?: string;
    suggestAlways: boolean;
  };
  id: string;
  kind: InboxKind;
  key: string;
  severity: InboxSeverity;
  title: string;
  body?: string;
  details?: string;
  action?: InboxAction;
  createdAt: string;
  updatedAt: string;
  count: number;
  readAt?: string;
  dismissedAt?: string;
  resolvedAt?: string;
  source?: { runtimeId?: string; runId?: string; label?: string };
  bodyVerbatim?: boolean;
};
export type InboxSummary = { unread: number; attention: number; open: InboxNotice[] };

export const inboxText = {
  bankReauthTitle: '银行连接需要重新验证',
  bankReauthBody:
    '{0} 的授权已失效。已同步的数据都保留着；点下面的「银行连接」重新登录，也可以在「扩展 › Mods」的 Mod 详情里管理。',
  bankNewDataTitle: '银行有新交易',
  bankNewDataBody: '{0} 新同步了 {1} 笔交易。',
  ruleAddedTitle: '已添加项目规则',
  ruleAddedBody: '已为「{0}」添加一条规则，可以在项目记忆里查看或删除。',
  loginTitle: '{0} 需要重新登录',
  loginBody: '登录已失效。重新登录后，PugPort 会自动检查并恢复使用。',
  keyTitle: '{0} 的 API 密钥被拒绝',
  keyBody: '服务商不接受这个密钥，可能已失效或被撤销。请更换密钥。',
  missingTitle: '找不到 {0} 的命令行程序',
  missingBody: '可能被卸载或路径变了。请检查执行器设置，然后刷新。',
  failingTitle: '{0} 连续失败 {1} 次',
  failingBody: '最近的调用没有完成，请查看运行记录。',
  updateTitle: '{0} 的命令行自动更新失败',
  updateBody: 'PugPort 夜间自动更新 {0} 的命令行时连续失败了 {1} 次。可以在终端手动运行更新命令；原始输出在下面展开。',
  updateBrokeBody: 'PugPort 夜间更新了 {0} 的命令行，但它现在无法启动。要回滚到上一个版本吗？',
  updateBrokeManualBody:
    'PugPort 夜间更新了 {0} 的命令行，但它现在无法启动。请在终端手动恢复之前的版本，然后在连接页重新检查。',
  networkTitle: '多个执行器同时连不上，可能是网络问题',
  networkBody: '恢复后会自动继续。',
  incompatibleTitle: '{0} 的命令行和 PugPort 不兼容',
  incompatibleBody: '{0} 的命令行启动时失败，任务无法开始。',
  incompatibleVersionBody: '{0} 的命令行（版本 {1}）启动时失败，任务无法开始。',
  incompatiblePausedBody: '已暂停给 {0} 派活，任务会交给其他账号。',
  incompatibleRetryBody: '下次派活时会再试一次。',
  incompatibleInvestigatingBody: '暂时不用做什么，PugPort 正在查原因。',
  // What the owner needs to do after an AI diagnosis, chosen by its action; never written by the AI.
  diagnosisNoneBody: '你什么都不用做。',
  diagnosisSignInBody: '点下面的按钮重新登录。',
  diagnosisReplaceKeyBody: '点下面的按钮换一个 API 密钥。',
  diagnosisUpdateCliBody: '在终端运行 `{0}` 更新命令行。',
  diagnosisUpdateCliFallbackBody: '请把 {0} 的命令行更新到最新版。',
  diagnosisCheckNetworkBody: '检查网络连接，恢复后会自动继续。',
  diagnosisOpenUsageBody: '打开用量页看看额度。',
  diagnosisProposalLabel: 'AI 的改法建议（未验证）：',
  budgetTitle: '{0} 的 API 配置已过期',
  budgetBody: '请更新这张卡的有效期后继续使用。',
} as const;

export function openNotices(notices: readonly InboxNotice[]) {
  return notices.filter((notice) => !notice.resolvedAt && !notice.dismissedAt);
}
export function unreadCount(notices: readonly InboxNotice[]) {
  return openNotices(notices).filter((notice) => !notice.readAt).length;
}
