import type { ConversationMessage, RunRecord, Workflow } from './types';
import { safeToolEventText } from './tool-event-data';

/**
 * `stop` says where a task stopped and, kept apart as the executor's own words, why it says it stopped; the
 * PugPort-authored `text` never paraphrases it.
 */
export type SystemNotice = {
  text: string;
  details?: string;
  stop?: { step?: number; title?: string; reason?: string };
};

export const systemNoticeText = {
  failed: '本轮执行失败，请查看详情后重试。',
  readOnly: '本轮按只读执行，未授予写入权限；可授权写入后重跑。',
  permission: '权限或沙箱限制阻止了本轮操作，请检查权限后继续。',
  privacy: '这个免费来源可能记录内容，只能发纯文字；附件或写文件请换执行器',
  retired: '此执行器已停止支持，请在连接页选择其他执行器。',
  cancelled: '本轮已停止，可继续未完成的工作。',
  interrupted: '本轮执行中断，可继续未完成的工作。',
  background: '正在等待后台任务，完成后会自动继续。',
  unverified: '执行器结束了本轮，但完成结果尚未确认。',
  noFileChanges: '没有检测到文件改动。如果你要的是改文件，可以点继续。',
  failedChecks: '执行器报告已完成，但有检查命令最后一次没有通过，请看详情。',
  incomplete: '本轮任务尚未完成，可继续未完成的工作。',
  verification: '本轮验收未通过，请查看详情。',
  tool: '本轮工具执行失败，请核对已有结果后继续。',
  budget: '这张 API 卡的额度快用完了，请调整预算后继续。',
  expired: 'API 配置已过期，请更新配置后继续。',
  usage: 'API 用量无法核实，请检查用量后继续。',
  authentication: '执行器的登录状态无效，请重新登录后重试。',
  quota: '{0} 已达到用量上限。若有其他已登录的空闲账号，PugPort 会自动使用。',
  quotaReset: '{0} 已达到用量上限，将于 {1} 重置。若有其他已登录的空闲账号，PugPort 会自动使用。',
  network: '执行器连接失败，请检查网络后重试。',
  timeout: '执行器响应超时，请稍后重试。',
  missing: '找不到执行器程序，请检查执行器设置。',
  closed: '执行器进程意外退出，请重试。',
  protocol: '{0} 的版本与当前 PugPort 不兼容。请在连接页更新 CLI，然后重试。',
  image: '执行器未能读取本次图片，请检查图片或更换执行器。',
  moderation: '服务商的内容审核拦下了这次请求',
  model: '服务商不允许这个账号使用所选模型，请换一个模型后重试。',
  noImageExecutor: '没有已连接的执行器能生成图片。连接 Codex（订阅自带图片生成），或添加 OpenAI API Key 后再试。',
  imagePinned: '你固定的执行器不能生成图片。改成自动选择，或固定一个 Codex 账号后再试。',
  imageFailed: '能生成图片的执行器都没有做出图片，请查看详情后重试。',
  videoUnsupported: '这个执行器暂不支持视频生成。换一个文字或图片模型后再试。',
} as const;

const failureByCode: Record<string, string> = {
  'provider-retired': systemNoticeText.retired,
  'privacy-text-only': systemNoticeText.privacy,
  'runtime-permission-or-sandbox-error': systemNoticeText.permission,
  'runtime-task-unverified': systemNoticeText.unverified,
  'runtime-task-incomplete': systemNoticeText.incomplete,
  'runtime-verification-failed': systemNoticeText.verification,
  'authentication-required': systemNoticeText.authentication,
  'api-key-auth-or-configuration': systemNoticeText.authentication,
  'api-key-workspace-required': systemNoticeText.authentication,
  'quota-or-rate-limit': systemNoticeText.quota,
  'provider-refused': systemNoticeText.moderation,
  'api-budget-exhausted': systemNoticeText.budget,
  'api-budget-expired': systemNoticeText.expired,
  'api-budget-usage-unknown': systemNoticeText.usage,
  'runtime-network-error': systemNoticeText.network,
  'runtime-timeout': systemNoticeText.timeout,
  'runtime-not-found': systemNoticeText.missing,
  'runtime-process-closed': systemNoticeText.closed,
  'runtime-protocol-incompatible': systemNoticeText.protocol,
  'runtime-image-input-unavailable': systemNoticeText.image,
  'runtime-image-dropped': systemNoticeText.image,
  'runtime-model-unavailable': systemNoticeText.model,
};

/** What a bare failure code means, in a few words, for the details under a notice. */
const failureCodeLabel: Record<string, string> = {
  'runtime-timeout': '执行器响应超时',
  'runtime-network-error': '执行器连接失败',
  'runtime-not-found': '找不到执行器程序',
  'runtime-process-closed': '执行器进程意外退出',
  'runtime-permission-or-sandbox-error': '被权限或沙箱限制拦下',
  'runtime-protocol-incompatible': '执行器版本与 PugPort 不兼容',
  'runtime-request-failed': '请求失败，执行器没有报告原因',
  'runtime-model-unavailable': '这个账号不能使用所选模型',
  'runtime-task-unverified': '结果未确认',
  'runtime-task-incomplete': '任务尚未完成',
  'runtime-verification-failed': '验收未通过',
  'runtime-image-input-unavailable': '执行器的图片输入不可用',
  'runtime-image-input-invalid': '图片无法读取或格式不受支持',
  'runtime-image-dropped': '执行器没有收到完整图片',
  'authentication-required': '需要重新登录',
  'api-key-auth-or-configuration': 'API Key 无效或配置有误',
  'api-key-workspace-required': '这个 API Key 需要指定工作区',
  'quota-or-rate-limit': '已达到用量上限',
  'provider-refused': systemNoticeText.moderation,
  'api-budget-exhausted': 'API 预算已用完',
  'api-budget-expired': 'API 配置已过期',
  'api-budget-usage-unknown': 'API 用量无法核实',
  'provider-retired': '此执行器已停止支持',
  'wsl-runtime-retired': '此执行器已停止支持',
  'privacy-text-only': '这个免费来源只能发纯文字',
  'native-session-unavailable': '原生会话不可用',
  'native-session-identity-changed': '原生会话的账号已变化',
  'native-session-identity-unverified': '无法确认原生会话的账号',
  'operation-cancelled': '已取消',
  'unsafe-wrapper-argument': '执行器的启动方式不受支持',
  'unsupported-runtime-wrapper': '执行器的启动方式不受支持',
  'unsupported-wsl-path': '执行器的启动方式不受支持',
};
/** Sentence starts PugPort writes before an executor's own words (server/controller.ts, server/workspace.ts). */
const detailPrefixes = [
  '结果未确认：',
  '任务尚未完成：',
  '验收命令通过，但执行器报告仍有未完成事项：',
  '原生工具拒绝原因：',
];
const cjkText = /[㐀-鿿]/;

/**
 * Details under a notice, for the interface language: a bare failure code becomes a few words, a sentence
 * PugPort wrote is translated, and an executor's or provider's own text stays exactly as written. `translate`
 * returns undefined for text it has no translation of; `partial` allows a translation that still has Chinese
 * in it (Traditional Chinese), which English must not show half-translated.
 */
export function localizeNoticeDetails(
  details: string,
  translate: (text: string) => string | undefined,
  partial = false,
): string {
  // A translated label keeps the space English puts after its colon.
  const own = (text: string) => {
    const translated = translate(text) ?? text;
    return text.endsWith('：') && translated.endsWith(':') ? `${translated} ` : translated;
  };
  return details
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      const label = Object.hasOwn(failureCodeLabel, trimmed) ? failureCodeLabel[trimmed] : undefined;
      if (label) return `${own('原因：')}${own(label)}`;
      const prefix = detailPrefixes.find((start) => line.startsWith(start));
      if (prefix) return `${own(prefix)}${line.slice(prefix.length)}`;
      if (!cjkText.test(trimmed)) return line;
      const whole = translate(trimmed);
      return whole !== undefined && whole !== trimmed && (partial || !cjkText.test(whole)) ? whole : line;
    })
    .join('\n');
}

function stoppedRun(workflow: Workflow, runs: readonly RunRecord[]) {
  const latest = workflow.runIds
    .map((id) => runs.find((run) => run.id === id && (!run.workflowId || run.workflowId === workflow.id)))
    .filter((run): run is RunRecord => !!run && !run.visualAssistant)
    .at(-1);
  const plan = workflow.plan ?? [];
  const activeIndex = plan.findIndex((step) => step.id === workflow.activeStepId);
  const stepIndex =
    activeIndex >= 0 ? activeIndex : latest ? plan.findIndex((step) => step.runIds.includes(latest.id)) : -1;
  const onStep = !!latest && (stepIndex < 0 || plan[stepIndex]!.runIds.includes(latest.id));
  return { latest, plan, stepIndex, onStep };
}

/** Verdicts annotate an executor answer; they never replace it. */
export function stoppedPlanOutput(workflow: Workflow, runs: readonly RunRecord[]): string | undefined {
  const { latest, plan, stepIndex, onStep } = stoppedRun(workflow, runs);
  if (
    !['blocked', 'failed', 'cancelled', 'interrupted'].includes(workflow.status) ||
    !onStep ||
    (stepIndex >= 0 && latest?.stepId !== plan[stepIndex]!.id)
  )
    return undefined;
  return safeToolEventText(latest?.output ?? '').trim() || undefined;
}

/** Explain only controller/adapter classifications, never infer a cause from an executor's prose. */
export function failureNotice(
  workflow: Workflow,
  runs: readonly RunRecord[],
  context?: { provider?: string; resetsAt?: string | null; availability?: { retryAt?: string } },
): SystemNotice {
  const { latest, plan, stepIndex, onStep } = stoppedRun(workflow, runs);
  const code =
    latest?.errorCode ?? (workflow.error && Object.hasOwn(failureByCode, workflow.error) ? workflow.error : '');
  const provider = context?.provider ?? latest?.account?.provider;
  const cli =
    (
      {
        codex: 'Codex',
        claude: 'Claude',
        grok: 'Grok',
        cursor: 'Cursor',
        gemini: 'Gemini',
        pi: 'Pi',
        dsh: 'DSH',
      } as Record<string, string>
    )[provider ?? ''] ?? 'CLI';
  const reset = context?.resetsAt ?? context?.availability?.retryAt;
  const resetTime =
    reset && Number.isFinite(Date.parse(reset))
      ? new Date(reset).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
      : undefined;
  const classified =
    code === 'quota-or-rate-limit'
      ? (resetTime ? systemNoticeText.quotaReset.replace('{1}', resetTime) : systemNoticeText.quota).replace('{0}', cli)
      : code === 'runtime-protocol-incompatible'
        ? systemNoticeText.protocol.replace('{0}', cli)
        : failureByCode[code ?? ''];
  const moderation =
    /^Pi(?: · [^:]+)?: Provider finish_reason: (content_filter|sensitive)$/.exec(latest?.errorDetail ?? '')?.[1] ??
    (latest?.apiProvider === 'zai-cn' &&
    /(?:^|[{,\s])(?:"code"|'code'|code)\s*[:=]\s*(?:"1301"|'1301'|1301(?=[\s,}]|$))/i.test(latest?.errorDetail ?? '')
      ? '1301'
      : undefined);
  const details = [
    ...new Set([workflow.error, latest?.error, latest?.errorDetail].filter((value): value is string => !!value)),
  ].join('\n\n');
  const readOnlyBlocked =
    workflow.input.readOnlyTrigger &&
    (code === 'runtime-permission-or-sandbox-error' || (!code && latest?.taskOutcome?.source === 'native-permission'));
  const outcomeText =
    latest?.verification?.status === 'failed'
      ? systemNoticeText.verification
      : latest?.taskOutcome?.source === 'native-permission'
        ? systemNoticeText.permission
        : latest?.events?.some(
              (event) => event.type === 'tool' && (event.data?.status === 'failed' || event.data?.isError === true),
            )
          ? systemNoticeText.tool
          : latest?.taskOutcome?.status === 'unverified'
            ? systemNoticeText.unverified
            : ['partial', 'blocked'].includes(latest?.taskOutcome?.status ?? '')
              ? systemNoticeText.incomplete
              : undefined;
  const clip = (value?: string) => {
    const text = safeToolEventText(value ?? '').trim();
    return text ? text.slice(0, 1500) : undefined;
  };
  const reported = latest?.taskOutcome;
  const completed = reported?.status === 'completed';
  const outcome = completed ? undefined : reported;
  const executorReason =
    onStep && ['executor-report', 'executor-tool'].includes(outcome?.source ?? '') ? clip(outcome?.summary) : undefined;
  // A blocked run that did not file its own report still keeps the last summary, or the last model text.
  const kept =
    onStep && !completed && !['executor-report', 'executor-tool'].includes(outcome?.source ?? '')
      ? (clip(outcome?.summary) ?? clip(latest?.output))
      : undefined;
  // The executor's own summary stays; raw output is not repeated when it is already the message body.
  const reason =
    executorReason ??
    (workflow.status === 'blocked' && (outcome?.summary || !stoppedPlanOutput(workflow, runs)) ? kept : undefined);
  const stop =
    workflow.status === 'blocked' && (stepIndex >= 0 || reason)
      ? {
          ...(stepIndex >= 0 && plan.length > 1 ? { step: stepIndex + 1, title: plan[stepIndex]!.title } : {}),
          ...(reason ? { reason } : {}),
        }
      : undefined;
  return {
    ...(stop && Object.keys(stop).length ? { stop } : {}),
    text:
      workflow.status === 'cancelled'
        ? systemNoticeText.cancelled
        : workflow.status === 'interrupted'
          ? systemNoticeText.interrupted
          : workflow.waitingOn
            ? systemNoticeText.background
            : readOnlyBlocked
              ? systemNoticeText.readOnly
              : moderation
                ? `${systemNoticeText.moderation} · ${moderation}`
                : (classified ?? outcomeText ?? systemNoticeText.failed),
    ...(details ? { details } : {}),
  };
}

/** Old saved system failures gain a display notice without rewriting stored text or model replies. */
export function noticeMessage(
  message: ConversationMessage,
  workflow: Workflow | undefined,
  runs: readonly RunRecord[],
): ConversationMessage {
  // A stop notice saved before notices said where the task stopped gains that, from the same runs.
  if (message.systemNotice) {
    const savedNotice = message.systemNotice;
    if (
      workflow &&
      message.role === 'assistant' &&
      !message.device &&
      (!message.workflowId || message.workflowId === workflow.id) &&
      workflow.conversationId === message.conversationId &&
      workflow.finalMessageId === message.id &&
      (!message.content.trim() || message.content === message.systemNotice.text)
    ) {
      const output = stoppedPlanOutput(workflow, runs);
      if (output) message = { ...message, content: output };
    }
    if (
      savedNotice.stop ||
      !workflow ||
      message.role !== 'assistant' ||
      message.device ||
      (message.workflowId && message.workflowId !== workflow.id) ||
      workflow.status !== 'blocked' ||
      workflow.conversationId !== message.conversationId ||
      workflow.finalMessageId !== message.id
    )
      return message;
    const { stop } = failureNotice(workflow, runs);
    return stop ? { ...message, systemNotice: { ...savedNotice, stop } } : message;
  }
  if (
    message.role !== 'assistant' ||
    message.replyIdentity?.kind !== 'system' ||
    message.device ||
    !workflow ||
    workflow.conversationId !== message.conversationId ||
    (message.workflowId && message.workflowId !== workflow.id) ||
    workflow.finalMessageId !== message.id ||
    !['failed', 'blocked', 'interrupted', 'cancelled'].includes(workflow.status)
  )
    return message;
  const notice = failureNotice(workflow, runs);
  return {
    ...message,
    // The saved text was a failure report, already kept in details: show the run's answer, else the notice.
    content: stoppedPlanOutput(workflow, runs) ?? notice.text,
    systemNotice: { ...notice, ...(message.content ? { details: message.content } : {}) },
  };
}
