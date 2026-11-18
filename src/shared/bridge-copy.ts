export const githubApprovalTitle = '确认 GitHub 写入';
export const githubApprovalExpired = '4.5 分钟内无人确认，未执行任何 GitHub 写入。';
export const githubApprovalDenied = '用户未同意 GitHub 写入。';

export const connectorDraftTitle = '创建邮件草稿';
export const connectorEditTitle = '修改连接器中的内容';
export const connectorDraftNotice = '将创建草稿，不会发送邮件。';
export const connectorCalendarNotice = '日历操作包含参与者时，服务可能发送邀请、更新或取消通知。';
export const connectorApprovalExpired = '4.5 分钟内无人确认，未执行任何连接器写入。';
export const connectorDraftDenied = '用户未同意创建邮件草稿。';
export const connectorEditDenied = '用户未同意修改连接器内容。';
export const connectorAuthChanged = '账号授权已变更，请重新确认操作。';
export const approvalPreviewTooLong = '操作内容过长，无法完整展示确认。请缩短后重试。';
export const mcpApprovalDenied = '用户未同意此 MCP 写入。';
export const mcpPermissionsChanged = '项目或 MCP 权限已变化，此调用未执行。';

export const bridgeEventReplyQuestion = '回复子任务的问题';
export const bridgeEventAssignSubtask = '指派子任务';
export const bridgeEventAskCaller = '向调用方提问';
export const bridgeEventMessageSubtask = '向子任务发送消息';
export const bridgeStageVerifyRecyclePaths = '核验回收路径与受保护目录';

export function connectorApprovalDescription(
  account: { alias: string; email: string },
  name: string,
  description: string,
  preview: string,
) {
  const draft = name === 'connector_mail_create_draft';
  return [
    `账号：${account.alias} (${account.email})`,
    ...(draft ? [connectorDraftNotice] : [`操作：${name}`, description, connectorCalendarNotice]),
    preview,
  ].join('\n');
}
