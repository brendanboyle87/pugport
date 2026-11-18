import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { ExecuteContext } from '../../shared/types.js';
import { safeToolEventText, safeToolEventValue } from '../../shared/tool-event-data.ts';

/** Startup duration only: no command, path, authentication response or process output. */
export function auditStartupPhase(
  emit: ExecuteContext['emit'],
  phase: 'sandbox-prepare' | 'resume-identity' | 'mcp-config' | 'native-spawn',
  startedAt: number,
  status: 'completed' | 'failed' | 'cancelled',
): void {
  emit({
    at: new Date().toISOString(),
    type: 'status',
    data: {
      source: 'pugport',
      kind: 'startup-timing',
      phase,
      elapsedMs: Math.max(0, performance.now() - startedAt),
      status,
    },
  });
}

/** Explicit public permission metadata, never a process environment, bridge configuration or protocol envelope. */
export function auditPermissionConfig(
  ctx: ExecuteContext,
  method: string,
  provenance: 'requested' | 'observed',
  config: Record<string, unknown>,
): void {
  const fields: Record<string, unknown> = {};
  for (const field of [
    'permissionMode',
    'approvalMode',
    'permissionPrompts',
    'permissionPromptTool',
    'tools',
    'disallowedTools',
    'agentName',
    'autoMode',
    'yoloMode',
    'restoreCode',
    'mcpServerNames',
    'permissionsReady',
    'permissionCommand',
    'permissionCommandSource',
    'permissionExtensionEnabled',
    'cwd',
  ]) {
    const value = config[field];
    if (typeof value === 'string' || typeof value === 'boolean') fields[field] = value;
    else if (Array.isArray(value)) fields[field] = value.filter((item) => typeof item === 'string');
  }
  if (!Object.keys(fields).length) return;
  ctx.emit({
    at: new Date().toISOString(),
    type: 'status',
    text: provenance === 'requested' ? '已提交本次原生权限配置。' : '已观察到原生权限配置字段。',
    data: {
      source: 'native',
      kind: 'permission-config',
      detail: safeToolEventValue({
        executor: ctx.target.label,
        provider: ctx.target.provider,
        runtimeId: ctx.target.id,
        method,
        provenance,
        ...fields,
      }),
    },
  });
}

/** Public protocol metadata only; field values outside this allowlist never enter the event. */
export function auditNativeProtocolMetadata(
  ctx: ExecuteContext,
  packet: Record<string, unknown>,
  known = false,
  subtype?: string,
): void {
  const type = typeof packet.type === 'string' ? packet.type : '';
  if (/thinking|reasoning|thought/i.test(type) || /thinking|reasoning|thought/i.test(subtype ?? '')) return;
  const detail: Record<string, unknown> = {
    executor: safeToolEventText(ctx.target.label, 256),
    provider: ctx.target.provider,
    runtimeId: safeToolEventText(ctx.target.id, 512),
    type: safeToolEventText(type, 256),
    ...(typeof subtype === 'string' || typeof packet.subtype === 'string'
      ? { subtype: safeToolEventText(subtype ?? String(packet.subtype), 256) }
      : {}),
    keys: Object.keys(packet)
      .slice(0, 64)
      .map((key) => safeToolEventText(key, 256)),
  };
  for (const field of ['status', 'role'])
    if (typeof packet[field] === 'string') detail[field] = safeToolEventText(packet[field], 256);
  for (const field of [
    'attempt',
    'maxAttempts',
    'messageCount',
    'pendingMessageCount',
    'turnIndex',
    'retryAfterMs',
    'delayMs',
  ])
    if (typeof packet[field] === 'number' && Number.isFinite(packet[field]) && packet[field] >= 0)
      detail[field] = packet[field];
  for (const field of ['success', 'willRetry', 'isStreaming', 'isCompacting'])
    if (typeof packet[field] === 'boolean') detail[field] = packet[field];
  ctx.emit({
    at: new Date().toISOString(),
    type: 'status',
    text: known ? '收到原生 CLI 生命周期更新。' : '收到尚未映射的原生协议事件。',
    data: { source: 'native', kind: known ? 'protocol-observation' : 'protocol-unmapped', detail },
  });
}

/** argv only: never inspect process environment or a native protocol envelope. */
export function safeExecutionArgs(args: string[]): string[] {
  let redactNext = false;
  return args.map((arg) => {
    if (redactNext) {
      redactNext = false;
      return '[redacted]';
    }
    if (/^--?[^=]*(?:token|key|password|secret|credential|auth|headers?|env|mcp[-_]config)/i.test(arg)) {
      const equal = arg.indexOf('=');
      if (equal >= 0) return safeToolEventText(arg.slice(0, equal), 256) + '=[redacted]';
      redactNext = true;
      return safeToolEventText(arg, 256);
    }
    // An opaque credential may occur in a bridge URL path, with no token= label.
    if (/[a-z][a-z0-9+.-]*:\/\//i.test(arg)) return '[redacted: URL argument]';
    return safeToolEventText(arg);
  });
}

export function auditNativeProcess(
  ctx: ExecuteContext,
  child: ChildProcessWithoutNullStreams,
  args: string[],
  transport: string,
  reused = false,
): () => void {
  const identity = {
    executor: ctx.target.label,
    provider: ctx.target.provider,
    runtimeId: ctx.target.id,
    ...(typeof child.pid === 'number' && Number.isSafeInteger(child.pid) ? { pid: child.pid } : {}),
    transport,
  };
  ctx.emit({
    at: new Date().toISOString(),
    type: 'status',
    ...(!reused ? { text: '原生 CLI 进程已创建。' } : {}),
    data: {
      source: 'native',
      kind: reused ? 'process-reuse' : 'process-start',
      detail: safeToolEventValue({
        ...identity,
        ...(reused
          ? { nativeSessionId: ctx.nativeSessionId }
          : {
              command: ctx.target.command,
              commandSource: 'configured',
              args: safeExecutionArgs([...(ctx.target.args ?? []), ...args]),
            }),
        cwd: ctx.input.projectPath,
      }),
    },
  });
  const exited = (exitCode: number | null, signal: NodeJS.Signals | null) => {
    ctx.emit({
      at: new Date().toISOString(),
      type: 'status',
      text: '原生 CLI 进程已退出。',
      data: { source: 'native', kind: 'process-exit', detail: safeToolEventValue({ ...identity, exitCode, signal }) },
    });
  };
  child.once('close', exited);
  return () => {
    child.removeListener('close', exited);
  };
}

const mappedSessionUpdates = new Set(['agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update']);
const controlSessionUpdates = new Set([
  'user_message_chunk',
  'plan',
  'available_commands_update',
  'current_mode_update',
  'config_option_update',
  'session_info_update',
  'usage_update',
]);

export function auditUnmappedSessionUpdate(
  ctx: ExecuteContext,
  method: unknown,
  update: Record<string, unknown>,
): void {
  const variant = typeof update.sessionUpdate === 'string' ? update.sessionUpdate : '';
  if (!variant || mappedSessionUpdates.has(variant)) return;
  const operational: Record<string, unknown> = {};
  const valueRow = (value: unknown): Record<string, unknown> =>
    value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  // Public ACP control fields only. Config/tool catalogs and user/thought bodies
  // are not operational diagnostics and are never copied wholesale.
  if (variant === 'plan' && Array.isArray(update.entries)) {
    operational.entryCount = update.entries.length;
    operational.entries = safeToolEventValue(
      update.entries.slice(0, 256).map((value) => {
        const entry = valueRow(safeToolEventValue(value));
        return Object.fromEntries(
          ['content', 'priority', 'status']
            .filter((key) => typeof entry[key] === 'string')
            .map((key) => [key, entry[key]]),
        );
      }),
    );
    if (update.entries.length > 256) operational.entriesTruncated = true;
  }
  if (variant === 'current_mode_update') {
    for (const field of ['currentModeId', 'modeId'])
      if (typeof update[field] === 'string') operational[field] = safeToolEventText(update[field], 256);
  }
  if (variant === 'session_info_update' && typeof update.title === 'string')
    operational.title = safeToolEventText(update.title, 4096);
  if (variant === 'available_commands_update' && Array.isArray(update.availableCommands))
    operational.commandCount = update.availableCommands.length;
  if (variant === 'config_option_update' && Array.isArray(update.configOptions))
    operational.optionCount = update.configOptions.length;
  if (variant === 'usage_update') {
    for (const field of ['used', 'size', 'inputTokens', 'outputTokens', 'totalTokens']) {
      const value = update[field];
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) operational[field] = value;
    }
    const cost = valueRow(update.cost);
    if (typeof cost.amount === 'number' && Number.isFinite(cost.amount) && cost.amount >= 0)
      operational.cost = {
        amount: cost.amount,
        ...(typeof cost.currency === 'string' ? { currency: safeToolEventText(cost.currency, 32) } : {}),
      };
  }
  const control = controlSessionUpdates.has(variant);
  ctx.emit({
    at: new Date().toISOString(),
    type: 'status',
    text: control ? '收到原生 CLI 控制状态更新。' : '收到尚未识别的原生协议事件。',
    data: {
      source: 'native',
      kind: control ? 'protocol-observation' : 'protocol-unmapped',
      detail: {
        executor: safeToolEventText(ctx.target.label, 256),
        provider: ctx.target.provider,
        runtimeId: safeToolEventText(ctx.target.id, 512),
        variant: safeToolEventText(variant, 256),
        method: typeof method === 'string' ? safeToolEventText(method, 256) : '',
        keys: Object.keys(update)
          .slice(0, 64)
          .map((key) => safeToolEventText(key, 256)),
        ...operational,
      },
    },
  });
}
