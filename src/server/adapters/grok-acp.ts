import { executorImage } from '../attachment-image.ts';
import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { ExecuteContext, ExecuteResult, RuntimeTarget } from '../../shared/types.js';
import { imageInputErrors } from '../../shared/image-errors.ts';
import { safeToolEventText, toolEventDetails } from '../../shared/tool-event-data.ts';
import { redactToolDiagnostic } from '../tool-diagnostics.ts';
import { StartupTail, redactError, runtimeError, type spawnTarget, type terminateProcess } from './process.js';
import { auditNativeProcess, auditUnmappedSessionUpdate, auditPermissionConfig } from './execution-audit.ts';
import { deviceFullAccess } from './device-access.ts';
import { grokBuildBalanceFailure, grokBuildBillingMessage } from '../grok-billing-failure.ts';

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as ObjectValue) : {};
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const number = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const nativePermissionDenial = (value: string): boolean =>
  /permission denied|denied by prompt policy|user rejected the execution|previously rejected|\bauto mode blocked this action\b/i.test(
    redactToolDiagnostic(value, value.length + 1200),
  );

function toolFailureDetail(update: ObjectValue): { detail: string; permissionDenied: boolean } {
  const contents = Array.isArray(update.content) ? update.content.map(object) : [];
  const messages = [
    text(object(update.rawOutput).message),
    ...contents.map((content) => text(object(content.content).text)),
  ].filter(Boolean);
  const denied = messages.find(nativePermissionDenial);
  // Put the native reason first so a long execution log cannot truncate the actual blocker.
  return {
    detail: redactToolDiagnostic([...new Set(denied ? [denied, ...messages] : messages)].join('\n')),
    permissionDenied: !!denied,
  };
}

/** The one-shot Messages stream is output only. This transport owns one ACP session.
 * Protocol: xai-org/grok-build, pinned source 2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8,
 * extensions/interject.rs, session/result.rs, agent/mvp_agent/acp_agent.rs.
 */
export class GrokAcpUnsupported extends Error {
  constructor() {
    super('runtime-protocol-incompatible');
  }
}

/** 1.0.46 omits image=true despite implementing image blocks. Verified with a
 * synthetic four-shape image on 2026-10-05; do not extend this exception by semver.
 * Upstream: prompt_parser.rs / acp_session_impl/turn.rs at the pinned source above.
 */
export const grokKnownImageVersion = (version: unknown): boolean => version === '1.0.46';

export function grokAcpImageSupport(init: ObjectValue): boolean {
  return (
    object(object(init.agentCapabilities).promptCapabilities).image === true ||
    (object(init._meta).grokShell === true && grokKnownImageVersion(object(init._meta).agentVersion))
  );
}

/** Attach validated local bytes as protocol image blocks, never as prompt text. */
export async function grokAcpPromptContent(ctx: ExecuteContext, init: ObjectValue): Promise<ObjectValue[]> {
  const images = (ctx.input.attachments ?? []).filter((attachment) => attachment.kind === 'image');
  const content: ObjectValue[] = [{ type: 'text', text: ctx.input.prompt }];
  if (!images.length) return content;
  if (!grokAcpImageSupport(init)) throw new Error('runtime-image-input-unavailable');
  if (images.length > 8) throw new Error('runtime-image-input-invalid');
  const imageBudget = { bytes: 0 };
  for (const image of images) {
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(image.mimeType))
      throw new Error('runtime-image-input-invalid');
    const selected = await executorImage(image, 'grok', ctx, imageBudget).catch(() => {
      throw new Error('runtime-image-input-invalid');
    });
    if (!selected) {
      content.push({ type: 'text', text: `${image.name}：图片像素未提供，原件仍保留在 ${image.path}。` });
      continue;
    }
    let bytes: Buffer;
    try {
      const info = await stat(selected.path);
      if (!info.isFile() || info.size > 5 * 1024 * 1024) throw new Error('runtime-image-input-invalid');
      bytes = await readFile(selected.path);
    } catch {
      throw new Error('runtime-image-input-invalid');
    }
    if (!bytes.length || bytes.length > 5 * 1024 * 1024) throw new Error('runtime-image-input-invalid');
    content.push({ type: 'image', mimeType: selected.mimeType, data: bytes.toString('base64') });
  }
  return content;
}

/**
 * Tool-less Grok: an allowlist minus a denylist naming every known tool and MCP meta-tool leaves nothing (the
 * denylist wins), and a bare `*` deny rule, which matches every tool and beats any allow, refuses whatever remains.
 */
export const grokToolDenylist = ['Agent', 'Read', 'Grep', 'Edit', 'Write', 'Bash', 'search_tool', 'use_tool'];
/** Cross-session memory stays out of a tool-less prompt. */
export const grokToollessEnvironment = (): NodeJS.ProcessEnv => ({ ...process.env, GROK_MEMORY: '0' });

const hasGrokBridge = (ctx: ExecuteContext): boolean =>
  !!ctx.agentBridge && !ctx.input.untrustedContent && (ctx.input.factCheck || ctx.input.prohibitCommands !== true);
// Ask mode sends MCP calls to this host, which approves only PugPort tools; Grok's auto classifier may approve
// the user's other servers. CLI allow/deny rules did not take effect in agent stdio on Grok 1.0.62.
// User permission rules (tool, server or wildcard, also from ~/.claude/settings*.json and project .claude/settings*.json)
// and remembered tool/server grants run before asking, outside our control, like Codex's per-server auto-approve.
const hostGated = (ctx: ExecuteContext) => ctx.input.permissionMode === 'read-only' && hasGrokBridge(ctx);
const grokPermissionMode = (ctx: ExecuteContext) =>
  hostGated(ctx)
    ? 'default'
    : ctx.approvalMode === 'auto'
      ? deviceFullAccess(ctx)
        ? 'bypassPermissions'
        : 'auto'
      : 'dontAsk';

export function grokAcpArgs(ctx: ExecuteContext): string[] {
  const args = ['--permission-mode', grokPermissionMode(ctx)];
  if (ctx.input.permissionMode === 'read-only' || ctx.input.untrustedContent) args.push('--disable-web-search');
  if (ctx.input.untrustedContent) args.push('--deny', '*');
  // Allow direct PugPort MCP calls. Grok's use_tool wrapper can still undergo its native auto review.
  else if (hasGrokBridge(ctx) && ctx.input.permissionMode !== 'read-only') args.push('--allow', 'MCPTool(pugport__*)');
  // A private process prevents this host's restrictions or cancellation from touching another client.
  args.push('agent', '--no-leader');
  if (ctx.route.model) args.push('--model', ctx.route.model);
  if (ctx.route.effort) args.push('--reasoning-effort', ctx.route.effort);
  args.push('stdio');
  return args;
}

/** ACP session MCP servers: the agent bridge only, authenticated with this run's token. */
export function grokAcpMcpServers(ctx: ExecuteContext): ObjectValue[] {
  if (!hasGrokBridge(ctx) || !ctx.agentBridge) return [];
  return [
    {
      type: 'http',
      name: 'pugport',
      url: ctx.agentBridge.url,
      headers: [{ name: 'Authorization', value: `Bearer ${ctx.agentBridge.token}` }],
    },
  ];
}

export function grokAcpSessionMeta(ctx: ExecuteContext): ObjectValue {
  const readOnly = ctx.input.permissionMode === 'read-only' || !!ctx.input.untrustedContent;
  // ACP's own switch for skipping the classifier; it must agree with the bypass in the profile and arguments.
  const bypass = ctx.approvalMode === 'auto' && deviceFullAccess(ctx);
  return {
    yoloMode: bypass,
    autoMode: ctx.approvalMode === 'auto' && !hostGated(ctx) && !bypass,
    restoreCode: false,
    // AgentDefinition's native filter is shared with headless --tools/--disallowed-tools.
    // Without the guarded bridge, read-only sessions also deny both MCP meta-tools.
    agentProfile: {
      name: 'comborunner-grok',
      description: 'Grok task with the selected PugPort tool and permission policy',
      permissionMode: grokPermissionMode(ctx),
      ...(readOnly ? { tools: ['Read', 'Grep'] } : {}),
      ...(!readOnly && ctx.input.prohibitCommands === true ? { tools: ['Read', 'Grep', 'Edit', 'Write'] } : {}),
      disallowedTools: ctx.input.untrustedContent
        ? grokToolDenylist
        : readOnly
          ? [
              'Agent',
              'Edit',
              'Write',
              'Bash',
              ...(ctx.input.prohibitCommands === true && !ctx.input.factCheck ? ['MCPTool'] : []),
              ...(hasGrokBridge(ctx) ? [] : ['search_tool', 'use_tool']),
            ]
          : ctx.input.prohibitCommands === true
            ? ['Agent', 'Bash', 'MCPTool', 'search_tool', 'use_tool']
            : ['Agent'],
    },
  };
}

/** ACP inputTokens includes both cache buckets; preserve the app's disjoint accounting. */
export function grokAcpUsage(value: unknown): ObjectValue | undefined {
  const usage = object(value);
  const data: ObjectValue = {
    source: 'Grok CLI ACP prompt result',
    eventId: 'result',
    scope: 'run-cumulative',
    cumulative: true,
  };
  for (const [source, destination] of [
    ['outputTokens', 'outputTokens'],
    ['cachedReadTokens', 'cacheReadTokens'],
    ['cacheCreationTokens', 'cacheWriteTokens'],
    ['reasoningTokens', 'reasoningTokens'],
    ['totalTokens', 'totalTokens'],
  ]) {
    if (number(usage[source!])) data[destination!] = usage[source!];
  }
  if (number(usage.inputTokens) && number(usage.cachedReadTokens) && number(usage.cacheCreationTokens))
    data.inputTokens = Math.max(0, usage.inputTokens - usage.cachedReadTokens - usage.cacheCreationTokens);
  else if (number(usage.inputTokens)) data.incomplete = true;
  if (usage.usageIsIncomplete === true || usage.costIsPartial === true) data.incomplete = true;
  if (data.incomplete !== true && Number.isSafeInteger(usage.costUsdTicks) && number(usage.costUsdTicks)) {
    data.costUsdTicks = usage.costUsdTicks;
    data.costUsd = usage.costUsdTicks / 10_000_000_000;
    data.costKind = 'reported';
  }
  return Object.keys(data).length > 4 ? data : undefined;
}

type Dependencies = { spawn: typeof spawnTarget; terminate: typeof terminateProcess; timeoutMs?: number };
export async function grokAcpHandshake(target: RuntimeTarget, deps: Dependencies, timeoutMs: number): Promise<boolean> {
  const child = await deps.spawn(
    target,
    ['--permission-mode', 'dontAsk', '--disable-web-search', '--deny', '*', 'agent', '--no-leader', 'stdio'],
    { env: grokToollessEnvironment() },
  );
  const startup = new StartupTail();
  try {
    return await new Promise<boolean>((resolve, reject) => {
      let pending = '',
        finished = false,
        unsupported = false;
      const received = new Set<number>();
      const finish = (error?: Error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (error) reject(error);
        else {
          startup.done();
          resolve(!unsupported);
        }
      };
      const timer = setTimeout(() => finish(new Error('runtime-timeout')), timeoutMs);
      child.stderr.on('data', (chunk: Buffer) => startup.write('stderr', chunk));
      child.stdout.on('data', (chunk: Buffer) => {
        startup.write('stdout', chunk);
        pending += chunk.toString();
        let at: number;
        while ((at = pending.indexOf('\n')) >= 0 && !finished) {
          const line = pending.slice(0, at);
          pending = pending.slice(at + 1);
          if (!line.trim()) continue;
          let packet: ObjectValue;
          try {
            packet = object(JSON.parse(line));
          } catch {
            continue;
          }
          if (packet.id !== 1 && packet.id !== 2) continue;
          const code = object(packet.error).code;
          if (packet.error && code !== -32601 && code !== -32602)
            return finish(
              Object.assign(startup.failure('Grok', null, { paths: [target.agentDir] }), {
                message: 'runtime-protocol-incompatible',
              }),
            );
          if (code === -32601) unsupported = true;
          received.add(packet.id);
          if (received.size === 2) finish();
        }
      });
      child.once('error', (error) => finish(error));
      child.stdin.once('error', () => {});
      child.once('close', (code) => finish(startup.failure('Grok', code, { paths: [target.agentDir] })));
      child.stdin.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'pugport', version: '1' } },
        }) + '\n',
      );
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: '_x.ai/interject', params: {} }) + '\n');
    });
  } finally {
    await deps.terminate(child);
  }
}
type Pending = { resolve: (value: ObjectValue) => void; reject: (error: Error) => void; timer?: NodeJS.Timeout };
type McpReadiness = 'initialized' | 'bridge-ready' | 'timeout' | 'interrupted';

function rpcFailure(
  value: unknown,
  auditUnmapped?: (shape: ObjectValue) => void,
  auditBilling?: () => void,
  options: Parameters<typeof runtimeError>[1] = {},
): Error {
  if (grokBuildBalanceFailure(value)) {
    auditBilling?.();
    return runtimeError(typeof value === 'string' ? value : object(value).message, {
      ...options,
      provider: 'Grok',
      code: 'quota-or-rate-limit',
    });
  }
  const error = object(value);
  const causes = typeof value === 'string' ? [value] : [error.message, error.data];
  const detail = causes
    .filter((item) => typeof item === 'string')
    .join(' ')
    .trim();
  const code = redactError(detail || 'runtime-request-failed');
  // Classifying a transport error must not erase an unknown structured cause or a refusal and
  // turn it into permission to rotate accounts. Audit only fixed shape labels, never raw values.
  const meaningful = (item: unknown) => item !== undefined && item !== null && item !== '';
  const unmapped =
    causes.some((item) => meaningful(item) && typeof item !== 'string') ||
    Object.keys(error).some((key) => !['message', 'data', 'code'].includes(key)) ||
    (meaningful(error.code) && typeof error.code !== 'number') ||
    (meaningful(value) && typeof value !== 'string' && typeof value !== 'object') ||
    Array.isArray(value) ||
    (code === 'runtime-request-failed' &&
      causes.some((item) => typeof item === 'string' && !!item.trim() && item.trim() !== 'runtime-request-failed')) ||
    /refus|content[_ -]?(?:policy|filter|moderation)|usage[_ -]?polic|safety[_ -]?(?:system|policy)|guidelines?|拒绝|内容政策|使用政策/i.test(
      detail,
    );
  if (unmapped)
    auditUnmapped?.({
      valueShape: value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value,
      messageShape: error.message === null ? 'null' : Array.isArray(error.message) ? 'array' : typeof error.message,
      dataShape: error.data === null ? 'null' : Array.isArray(error.data) ? 'array' : typeof error.data,
      hasOtherFields: Object.keys(error).some((key) => !['message', 'data', 'code'].includes(key)),
    });
  return runtimeError(detail, { ...options, provider: 'Grok', code });
}

/** Request result wrappers are distinct from the surrounding JSON-RPC result. */
function extensionResult(value: ObjectValue, failure: (value: unknown) => Error): ObjectValue {
  if (value.error !== undefined && value.error !== null) throw failure(value.error);
  if (value.result === null || typeof value.result !== 'object' || Array.isArray(value.result))
    throw new Error('runtime-protocol-incompatible');
  return object(value.result);
}

export async function executeGrokAcp(ctx: ExecuteContext, deps: Dependencies): Promise<ExecuteResult> {
  if (ctx.input.prohibitCommands === true && !ctx.input.factCheck)
    ctx.emit({
      at: new Date().toISOString(),
      type: 'status',
      text: 'Command prohibition disables Grok shell and MCP tools for this run; native file tools retain the selected permission scope.',
    });
  let child: ChildProcessWithoutNullStreams | undefined;
  let dispose: (() => void) | undefined;
  try {
    if (ctx.signal.aborted) throw new Error('operation-cancelled');
    const executionArgs = grokAcpArgs(ctx);
    child = await deps.spawn(ctx.target, executionArgs, {
      sandbox: ctx.sandbox,
      onSandboxFailure: ctx.onSandboxFailure,
      onSandboxSuccess: ctx.onSandboxSuccess,
      signal: ctx.signal,
      runTemp: ctx.runTemp,
      cwd: ctx.input.projectPath,
      ...(ctx.input.untrustedContent || ctx.input.factCheck ? { env: grokToollessEnvironment() } : {}),
    });
    auditNativeProcess(ctx, child, executionArgs, 'acp');
    const nativeFailure = (value: unknown, boundary: string) =>
      rpcFailure(
        value,
        (shape) =>
          ctx.emit({
            at: new Date().toISOString(),
            type: 'status',
            text: 'Grok 原生错误包含尚未映射的原因；已保留诊断标记，不能自动接力。',
            data: {
              source: 'native',
              kind: 'protocol-unmapped',
              relayBlocked: true,
              detail: { provider: 'grok', runtimeId: ctx.target.id, transport: 'acp', boundary, ...shape },
            },
          }),
        () =>
          ctx.emit({
            at: new Date().toISOString(),
            type: 'status',
            text: grokBuildBillingMessage,
            data: {
              source: 'native',
              kind: 'billing-exhausted',
              billingSource: 'grok-build',
              detail: { provider: 'grok', runtimeId: ctx.target.id, transport: 'acp', boundary, statusCode: 402 },
            },
          }),
        { paths: [ctx.dataDir, ctx.target.agentDir], prompt: ctx.input.prompt },
      );
    const extensionResponse = (value: ObjectValue) =>
      extensionResult(value, (failure) => nativeFailure(failure, 'extension-result'));
    const process = child;
    const startup = new StartupTail();
    let invalidStartupLine = false;
    let buffer = '',
      output = '',
      sessionId = ctx.nativeSessionId ?? randomUUID();
    let sequence = 1,
      disposed = false,
      prompting = false,
      initialPromptDone = false,
      canSteer = false;
    let nativeRunning: string | undefined,
      nativeQueued = false,
      fatal: Error | undefined,
      steerSubmitted = false;
    const promptId = randomUUID();
    let submittedPromptId: string = promptId;
    const pending = new Map<number, Pending>();
    const steers = new Set<Promise<void>>();
    // A send-now RPC lives for the entire replacement turn, independently of its delivery acknowledgement.
    const replacementTurns = new Set<Promise<void>>();
    const sendNowPrompts = new Set<string>();
    const startedReplacements = new Set<string>();
    const appendedReplacements = new Set<string>();
    const replacementTexts = new Map<string, string>();
    const queuedReplacements = new Set<string>();
    const combinedReplacements = new Map<string, string>();
    const conversionWaiters = new Map<string, Pending>();
    const confirmConversion = (id: string) => {
      const waiter = conversionWaiters.get(id);
      if (!waiter) return;
      if (waiter.timer) clearTimeout(waiter.timer);
      conversionWaiters.delete(id);
      waiter.resolve({});
    };
    const receipts = new Map<
      string,
      { text: string; resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
    >();
    const usageByPrompt = new Map<string, ObjectValue>();
    const observedPrompts = new Set<string>([promptId]);
    const completedPrompts = new Set<string>();
    const toolKinds = new Map<string, string>();
    const toolNames = new Map<string, string>();
    const nativeToolNames = new Map<string, string>();
    const toolStatuses = new Map<string, string>();
    const mcpTargets = new Map<string, string>();
    const blockedTools = new Map<string, { detail?: string; deniedBy: 'host' | 'native' }>();
    // Set when this host answered a permission request with a rejection: Grok then ends the turn as cancelled.
    let hostDenied = false;
    let hostRefusal: { promptId: string; detail: string } | undefined;
    let refusalContinuations = 0;
    /**
     * PugPort's own bridge tool behind this call, if any. Grok reaches MCP tools through its use_tool meta-tool,
     * which the `MCPTool(pugport__*)` allow rule does not cover, so its auto review still asks about them.
     */
    const bridgeTarget = (toolCall: ObjectValue): string | undefined => {
      if (!grokAcpMcpServers(ctx).length) return undefined;
      const name =
        text(object(toolCall.rawInput).tool_name) || mcpTargets.get(text(toolCall.toolCallId)) || text(toolCall.title);
      return /^pugport__[\w-]+$/.test(name) ? name : undefined;
    };
    const reportPermissionBlock = (toolCall: ObjectValue, detail?: string, asked = false) => {
      const id = text(toolCall.toolCallId);
      const kind = text(toolCall.kind) || toolKinds.get(id);
      // ACP Read/Search failures can be recoverable lookups. Report only a known mutation/execute request
      // denied by the native permission layer, an MCP call it refused (use_tool carries no mutation kind),
      // or any call this host was asked about and rejected.
      const target = mcpTargets.get(id);
      if (
        !id ||
        !(asked || target || blockedTools.has(id) || ['edit', 'execute', 'delete', 'move'].includes(kind ?? ''))
      )
        return;
      // A permission request can precede its failed-tool reason. Allow one
      // generic-to-concrete enrichment, then ignore further reports for this tool.
      if (blockedTools.has(id) && (blockedTools.get(id)?.detail || !detail)) return;
      // Name the PugPort or MCP tool: the native text only says `use_tool`.
      if (target && detail) detail = `${target}：${detail}`;
      const deniedBy = blockedTools.get(id)?.deniedBy ?? (asked ? 'host' : 'native');
      blockedTools.set(id, { detail, deniedBy });
      ctx.emit({
        at: new Date().toISOString(),
        type: 'error',
        text:
          (deniedBy === 'host' ? 'PugPort 拒绝了超出本任务范围的操作。' : 'Grok 原生权限策略拒绝了操作。') +
          (detail ? ` ${detail}` : ''),
        data: {
          executionBlocked: true,
          deniedBy,
          reason: 'permission',
          toolCallId: safeToolEventText(id, 512),
          nativeMethod: asked ? 'session/request_permission' : 'session/update',
          ...(target ? { nativeTool: safeToolEventText(target, 256) } : {}),
          ...(detail ? { detail } : {}),
        },
      });
    };
    // Session MCP servers connect after session/new returns; the bridge tools must exist before the first prompt.
    let mcpReady!: (outcome: McpReadiness) => void;
    const mcpInitialized = new Promise<McpReadiness>((resolveReady) => (mcpReady = resolveReady));
    let idleChanged: (() => void) | undefined;
    let steerHandler:
      ((prompt: string, delivery?: { id: string; mode?: 'interrupt' | 'append' }) => Promise<void>) | undefined;
    let registeredState: string | undefined;
    const setSteer = (enabled: boolean, state: 'starting' | 'ready' | 'waiting' | 'finishing' = 'finishing') => {
      if (canSteer === enabled && registeredState === state) return;
      canSteer = enabled;
      registeredState = state;
      const reasons = {
        starting: 'Grok 正在建立原生输入通道。',
        ready: '可以向当前 Grok 会话补充消息。',
        waiting: 'Grok 正在确认补充消息，原生回合开始后可继续补充。',
        finishing: 'Grok 正在结束当前回合，暂不能接收补充消息。',
      };
      ctx.registerSteer?.(enabled ? steerHandler : undefined, { state, reason: reasons[state] });
    };
    const refreshSteer = () => {
      const active =
        prompting &&
        !disposed &&
        !fatal &&
        !ctx.signal.aborted &&
        ((!initialPromptDone && !completedPrompts.has(promptId)) ||
          (!!nativeRunning && !completedPrompts.has(nativeRunning)));
      setSteer(
        active,
        active
          ? 'ready'
          : // A completed native turn can still promote accepted input after the actor barrier.
            // Input availability is separate from whether this execute call has finished draining.
            prompting && !disposed && !fatal && !ctx.signal.aborted
            ? 'waiting'
            : 'finishing',
      );
    };
    const fail = (error: Error) => {
      fatal ??= error;
      mcpReady('interrupted');
      ctx.endTools?.();
      setSteer(false);
      for (const entry of pending.values()) {
        if (entry.timer) clearTimeout(entry.timer);
        entry.reject(fatal);
      }
      pending.clear();
      for (const receipt of receipts.values()) {
        clearTimeout(receipt.timer);
        receipt.reject(fatal);
      }
      receipts.clear();
      for (const waiter of conversionWaiters.values()) {
        if (waiter.timer) clearTimeout(waiter.timer);
        waiter.reject(fatal);
      }
      conversionWaiters.clear();
      idleChanged?.();
    };
    const send = (packet: ObjectValue) => {
      if (disposed || fatal) throw fatal ?? new Error('runtime-process-closed');
      if (process.stdin.destroyed || process.stdin.writableEnded) {
        if (startup.active) return;
        throw new Error('runtime-process-closed');
      }
      process.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...packet }) + '\n');
    };
    const request = (method: string, params: ObjectValue, timeoutMs: number | null = deps.timeoutMs ?? 30_000) =>
      new Promise<ObjectValue>((resolve, reject) => {
        const id = sequence++;
        const timer =
          timeoutMs === null
            ? undefined
            : setTimeout(() => {
                pending.delete(id);
                reject(
                  new Error(invalidStartupLine && startup.active ? 'runtime-protocol-incompatible' : 'runtime-timeout'),
                );
              }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        try {
          send({ id, method, params });
        } catch (error) {
          pending.delete(id);
          if (timer) clearTimeout(timer);
          reject(error);
        }
      });
    const accumulateUsage = (id: string, value: unknown) => {
      const data = grokAcpUsage(value);
      if (data) usageByPrompt.set(id, data);
    };
    const receive = (line: string) => {
      if (!line.trim() || disposed || fatal) return;
      let packet: ObjectValue;
      try {
        packet = object(JSON.parse(line));
      } catch {
        if (startup.active) {
          invalidStartupLine = true;
          return;
        }
        fail(new Error('runtime-protocol-incompatible'));
        return;
      }
      if (packet.jsonrpc !== '2.0') {
        fail(new Error('runtime-protocol-incompatible'));
        return;
      }
      if (typeof packet.method === 'string') {
        const params = object(packet.params);
        if (packet.id !== undefined) {
          // Grok performs its native auto classification; read-only bridge runs instead ask this host about every
          // MCP call. Anything still requiring a host confirmation is denied immediately, matching headless
          // auto/dontAsk, except PugPort's own tools: the bridge checks their grants and scope itself.
          if (packet.method === 'session/request_permission') {
            const options = Array.isArray(params.options) ? params.options.map(object) : [];
            const ours = params.sessionId === sessionId && prompting && !fatal;
            const toolCall = object(params.toolCall);
            const allow =
              ours &&
              !(ctx.input.prohibitCommands === true && text(toolCall.kind) === 'execute') &&
              bridgeTarget(toolCall) &&
              options.find((option) => option.kind === 'allow_once');
            if (allow && text(allow.optionId)) {
              send({ id: packet.id, result: { outcome: { outcome: 'selected', optionId: allow.optionId } } });
              return;
            }
            const deny = options.find((option) => option.kind === 'reject_once');
            if (ours) {
              hostDenied = true;
              hostRefusal = {
                promptId: nativeRunning ?? submittedPromptId,
                detail: redactToolDiagnostic(
                  text(object(toolCall.rawInput).command) ||
                    text(toolCall.title) ||
                    toolNames.get(text(toolCall.toolCallId)) ||
                    '工具',
                ),
              };
              const failure = toolFailureDetail(toolCall);
              // A rejected permission request can end as cancelled without a later failed-tool update.
              // Preserve the reason here as well; answering it remains a rejection.
              reportPermissionBlock(toolCall, failure.permissionDenied ? failure.detail : undefined, true);
            }
            send({
              id: packet.id,
              result: {
                outcome:
                  deny && text(deny.optionId)
                    ? { outcome: 'selected', optionId: deny.optionId }
                    : { outcome: 'cancelled' },
              },
            });
          } else send({ id: packet.id, error: { code: -32601, message: 'Unsupported client request.' } });
          return;
        }
        // MCP readiness arrives before the prompt it gates, so it is read ahead of the prompting filter.
        if (
          packet.method === '_x.ai/mcp_initialized' ||
          (packet.method === '_x.ai/mcp/init_progress' &&
            typeof params.total === 'number' &&
            typeof params.connected === 'number' &&
            params.connected >= params.total)
        ) {
          if (!params.sessionId || params.sessionId === sessionId) mcpReady('initialized');
          return;
        }
        if (params.sessionId !== sessionId || !prompting) return;
        if (
          packet.method === 'session/update' ||
          (packet.method === '_x.ai/session/update' && typeof object(params.update).sessionUpdate === 'string')
        ) {
          const update = object(params.update);
          auditUnmappedSessionUpdate(ctx, packet.method, update);
          const chunk = text(object(update.content).text);
          if (update.sessionUpdate === 'agent_message_chunk' && chunk) {
            output += chunk;
            ctx.emit({ at: new Date().toISOString(), type: 'text', text: chunk });
          } else if (update.sessionUpdate === 'agent_thought_chunk' && chunk)
            ctx.emit({ at: new Date().toISOString(), type: 'reasoning', text: chunk });
          else if (update.sessionUpdate === 'plan')
            ctx.emit({ at: new Date().toISOString(), type: 'status', data: { taskList: update.entries } });
          else if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
            const rawId = text(update.toolCallId);
            const id = rawId.length <= 512 && safeToolEventText(rawId, 512) === rawId ? rawId : '';
            const provenance = object(params._meta);
            const nativeIds: ObjectValue = {};
            for (const [field, destination] of [
              ['promptId', 'nativePromptId'],
              ['eventId', 'nativeEventId'],
            ] as const) {
              const value = text(provenance[field]);
              if (value && value.length <= 512 && safeToolEventText(value, 512) === value)
                nativeIds[destination] = value;
            }
            const nativeTool = object(object(update._meta)['x.ai/tool']);
            const kind = text(update.kind) || text(nativeTool.kind);
            const target = text(object(update.rawInput).tool_name);
            if (id && target) mcpTargets.set(id, target);
            const nativeName = text(update.toolName) || text(nativeTool.name);
            const name = target || mcpTargets.get(id) || nativeName || toolNames.get(id);
            // ACP argument enrichment uses kind=other and omits status. It is an
            // update of this native ID, not a new generic tool or a completion.
            if (id && kind && (kind !== 'other' || !toolKinds.has(id))) toolKinds.set(id, safeToolEventText(kind, 256));
            if (id && name) toolNames.set(id, safeToolEventText(name, 256));
            if (id && nativeName) nativeToolNames.set(id, safeToolEventText(nativeName, 256));
            const status =
              text(update.status) || toolStatuses.get(id) || (update.sessionUpdate === 'tool_call' ? 'pending' : '');
            if (id && status) toolStatuses.set(id, safeToolEventText(status, 256));
            const failure = update.status === 'failed' ? toolFailureDetail(update) : undefined;
            ctx.emit({
              at: new Date().toISOString(),
              type: 'tool',
              text: safeToolEventText(toolNames.get(id) || text(update.title) || 'Tool call', 300),
              data: {
                ...(id ? { toolCallId: id } : {}),
                ...nativeIds,
                ...(status ? { status: safeToolEventText(status, 256) } : {}),
                ...(toolKinds.get(id) ? { kind: toolKinds.get(id) } : {}),
                ...(toolNames.get(id) ? { tool: toolNames.get(id) } : {}),
                ...(nativeToolNames.get(id) ? { nativeTool: nativeToolNames.get(id) } : {}),
                ...(text(update.title) ? { title: safeToolEventText(text(update.title)) } : {}),
                ...toolEventDetails(update),
                ...(failure?.detail ? { detail: failure.detail } : {}),
              },
            });
            // Native tool_calls.rs emits Failed + text for permission rejection;
            // execution errors also carry rawOutput.message. Do not classify all Failed.
            if (failure?.permissionDenied) reportPermissionBlock(update, failure.detail);
          }
        } else if (packet.method === '_x.ai/session/interjection') {
          const id = text(params.interjectionId);
          const receipt = receipts.get(id);
          // The native echo carries only sessionId, the caller's nonce and raw text.
          // All three must identify our submission before it counts as delivered.
          if (receipt && params.text === receipt.text) {
            // An active native goal can convert sendNow into a soft interjection. Its echo is
            // evidence of receipt only; it does not mean the old command or turn was interrupted.
            if (sendNowPrompts.has(id)) {
              appendedReplacements.add(id);
              confirmConversion(id);
              ctx.emit({
                at: new Date().toISOString(),
                type: 'status',
                text: 'Grok 已接收补充；当前原生目标会在后续安全节点读取，尚未切换回合。',
                data: { steeringPhase: 'received', steeringId: id, steeringMode: 'append' },
              });
            }
            clearTimeout(receipt.timer);
            receipts.delete(id);
            receipt.resolve();
          }
        } else if (packet.method === '_x.ai/queue/changed') {
          const running = text(params.runningPromptId);
          const entries = Array.isArray(params.entries) ? params.entries.map(object) : [];
          // A delayed old running snapshot must not acknowledge or promote a newer correction.
          if (running && completedPrompts.has(running)) return;
          for (const id of [running, ...entries.map((entry) => text(entry.id))])
            if (sendNowPrompts.has(id)) queuedReplacements.add(id);
          // Grok may fold consecutive text-only sendNow inputs into the first prompt. The
          // other RPCs then return removedFromQueue before this authoritative promotion event.
          const combinedTexts = Array.isArray(params.runningCombinedTexts)
            ? params.runningCombinedTexts.filter((value): value is string => typeof value === 'string')
            : [];
          if ((running === promptId || sendNowPrompts.has(running)) && combinedTexts.length > 1) {
            const remaining = [...combinedTexts];
            const ownText = running === promptId ? ctx.input.prompt : replacementTexts.get(running);
            const ownIndex = ownText === undefined ? -1 : remaining.indexOf(ownText);
            if (ownIndex >= 0) remaining.splice(ownIndex, 1);
            for (const [id, source] of replacementTexts) {
              // Repeated queue snapshots include already-merged texts. Consume their slots
              // before considering later corrections with identical text.
              if (combinedReplacements.get(id) === running) {
                const existing = remaining.indexOf(source);
                if (existing >= 0) remaining.splice(existing, 1);
                continue;
              }
              if (
                id === running ||
                !queuedReplacements.has(id) ||
                entries.some((entry) => entry.id === id) ||
                combinedReplacements.has(id) ||
                startedReplacements.has(id) ||
                appendedReplacements.has(id)
              )
                continue;
              const index = remaining.indexOf(source);
              if (index < 0) continue;
              remaining.splice(index, 1);
              combinedReplacements.set(id, running);
              confirmConversion(id);
            }
          }
          const combinedIds = [...combinedReplacements].filter(([, owner]) => owner === running).map(([id]) => id);
          for (const id of [running, ...entries.map((entry) => text(entry.id)), ...combinedIds]) {
            const receipt = sendNowPrompts.has(id) ? receipts.get(id) : undefined;
            if (!receipt) continue;
            clearTimeout(receipt.timer);
            receipts.delete(id);
            receipt.resolve();
          }
          nativeRunning = running || undefined;
          if (nativeRunning) observedPrompts.add(nativeRunning);
          if (nativeRunning && nativeRunning !== promptId) completedPrompts.add(promptId);
          nativeQueued = entries.length > 0;
          if (nativeRunning && sendNowPrompts.has(nativeRunning) && !startedReplacements.has(nativeRunning)) {
            startedReplacements.add(nativeRunning);
            ctx.emit({
              at: new Date().toISOString(),
              type: 'status',
              text: 'Grok 已在同一会话中开始处理补充消息。',
              data: { steeringPhase: 'resuming', steeringId: nativeRunning },
            });
          } else if (nativeRunning && nativeRunning !== promptId && !sendNowPrompts.has(nativeRunning))
            ctx.emit({
              at: new Date().toISOString(),
              type: 'status',
              text: 'Grok 正在同一会话中处理刚提交的补充消息。',
            });
          for (const id of combinedIds) {
            if (startedReplacements.has(id)) continue;
            startedReplacements.add(id);
            ctx.emit({
              at: new Date().toISOString(),
              type: 'status',
              text: 'Grok 已在同一会话中开始处理补充消息。',
              data: { steeringPhase: 'resuming', steeringId: id },
            });
          }
          refreshSteer();
          idleChanged?.();
        } else if (packet.method === '_x.ai/session/prompt_complete') {
          const id = text(params.promptId);
          if (!observedPrompts.has(id)) return;
          completedPrompts.add(id);
          // Keep the turn in the drain lifecycle until its durable completion or
          // authoritative queue snapshot arrives, but stop accepting new input.
          refreshSteer();
        } else if (packet.method === '_x.ai/session/update' || packet.method === '_x.ai/session_notification') {
          const update = object(params.update);
          if (update.type === 'image_dropped') {
            ctx.emit({
              at: new Date().toISOString(),
              type: 'error',
              text: imageInputErrors['runtime-image-dropped'],
              data: { executionBlocked: true, reason: 'image-input' },
            });
            // Revoke bridge access synchronously, then stop the owned native turn.
            // Do not fall back to text execution or a different model.
            try {
              send({ method: 'session/cancel', params: { sessionId } });
            } catch {
              /* Transport closed. */
            }
            fail(new Error('runtime-image-dropped'));
          } else if (update.type === 'image_compressed') {
            ctx.emit({
              at: new Date().toISOString(),
              type: 'status',
              text: 'Grok CLI 已调整图片尺寸后继续识图；细小文字可能不够清晰。',
            });
          } else if (update.type === 'turn_completed') {
            const id = text(update.promptId);
            if (!observedPrompts.has(id)) return;
            completedPrompts.add(id);
            if (id === nativeRunning) nativeRunning = undefined;
            accumulateUsage(id, update.usage);
            if (update.stopReason === 'error' || update.errorKind)
              fail(nativeFailure({ message: update.agentResult, data: update.errorKind }, 'turn-completed'));
            refreshSteer();
            idleChanged?.();
          }
        }
        return;
      }
      if (typeof packet.id !== 'number') return;
      const entry = pending.get(packet.id);
      if (!entry) return;
      pending.delete(packet.id);
      if (entry.timer) clearTimeout(entry.timer);
      if (packet.error !== undefined) {
        const error = object(packet.error);
        // Keep the numeric code internal; user-visible diagnostics are redacted.
        entry.reject(Object.assign(nativeFailure(packet.error, 'json-rpc-error'), { rpcCode: error.code }));
      } else if (packet.result === null || typeof packet.result !== 'object')
        entry.reject(new Error('runtime-protocol-incompatible'));
      else entry.resolve(object(packet.result));
    };
    const onData = (chunk: string) => {
      startup.write('stdout', chunk);
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 4 * 1024 * 1024) {
        fail(new Error('runtime-protocol-incompatible'));
        return;
      }
      let at: number;
      while (!disposed && !fatal && (at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        receive(line);
      }
    };
    const onError = (error: Error) => fail(new Error(redactError(error)));
    const onStdinError = (error: NodeJS.ErrnoException) => {
      if (!startup.active) onError(error);
    };
    const onEnd = () => {
      if (startup.active) return;
      if (!fatal && buffer.trim()) receive(buffer);
      if (!disposed) fail(new Error('runtime-process-closed'));
    };
    const onClose = (code: number | null) => {
      if (!startup.active && !fatal && buffer.trim()) receive(buffer);
      if (!disposed)
        fail(
          startup.active
            ? startup.failure('Grok', code ?? null, {
                paths: [ctx.dataDir, ctx.target.agentDir],
                secrets: [ctx.agentBridge?.token],
                prompt: ctx.input.prompt,
              })
            : new Error('runtime-process-closed'),
        );
    };
    const abort = () => {
      try {
        send({ method: 'session/cancel', params: { sessionId } });
      } catch {
        /* Closed transport. */
      }
      fail(new Error('operation-cancelled'));
      void deps.terminate(process);
    };
    process.stdout.setEncoding('utf8');
    process.stdout.on('data', onData);
    process.stdout.once('end', onEnd);
    process.stderr.on('data', (chunk: Buffer) => startup.write('stderr', chunk));
    process.on('error', onError);
    process.stdin.on('error', onStdinError);
    process.once('close', onClose);
    ctx.signal.addEventListener('abort', abort, { once: true });
    dispose = () => {
      setSteer(false);
      disposed = true;
      ctx.signal.removeEventListener('abort', abort);
      process.stdout.off('data', onData);
      process.stdout.off('end', onEnd);
      process.off('error', onError);
      process.stdin.off('error', onStdinError);
      process.off('close', onClose);
      for (const entry of pending.values()) {
        if (entry.timer) clearTimeout(entry.timer);
        entry.reject(new Error('runtime-process-closed'));
      }
      pending.clear();
      for (const receipt of receipts.values()) {
        clearTimeout(receipt.timer);
        receipt.reject(new Error('runtime-process-closed'));
      }
      receipts.clear();
      for (const waiter of conversionWaiters.values()) {
        if (waiter.timer) clearTimeout(waiter.timer);
        waiter.reject(new Error('runtime-process-closed'));
      }
      conversionWaiters.clear();
    };
    if (ctx.signal.aborted) abort();
    setSteer(false, 'starting');
    const init = await request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 'pugport', version: '1' },
    }).catch((error) => {
      if (error.rpcCode === -32601) throw new GrokAcpUnsupported();
      throw error;
    });
    if (init.protocolVersion !== 1) throw new GrokAcpUnsupported();
    const promptContent = await grokAcpPromptContent(ctx, init);
    // An invalid-params probe verifies the extension without creating a session or a model request.
    try {
      await request('_x.ai/interject', {});
      throw new GrokAcpUnsupported();
    } catch (error) {
      if ((error as { rpcCode?: number }).rpcCode === -32601) throw new GrokAcpUnsupported();
      if ((error as { rpcCode?: number }).rpcCode !== -32602) throw error;
    }
    const auth = text(object(init._meta).defaultAuthMethodId);
    const methods = Array.isArray(init.authMethods) ? init.authMethods.map(object) : [];
    if (!auth || !methods.some((method) => method.id === auth)) throw new Error('authentication-required');
    if (ctx.nativeSessionId && object(init.agentCapabilities).loadSession !== true)
      throw new Error('native-session-unavailable');
    await request('authenticate', { methodId: auth, _meta: { headless: true } });
    startup.done();
    const meta = grokAcpSessionMeta(ctx);
    const profile = object(meta.agentProfile);
    auditPermissionConfig(ctx, ctx.nativeSessionId ? 'session/load' : 'session/new', 'requested', {
      permissionMode: profile.permissionMode,
      agentName: profile.name,
      tools: profile.tools,
      disallowedTools: profile.disallowedTools,
      autoMode: meta.autoMode,
      yoloMode: meta.yoloMode,
      restoreCode: meta.restoreCode,
      cwd: ctx.input.projectPath,
      mcpServerNames: grokAcpMcpServers(ctx).map((server) => server.name),
    });
    if (ctx.nativeSessionId) {
      await request('session/load', {
        sessionId,
        cwd: ctx.input.projectPath,
        mcpServers: grokAcpMcpServers(ctx),
        _meta: meta,
      }).catch((error) => {
        if (!ctx.signal.aborted) throw new Error('native-session-unavailable');
        throw error;
      });
    } else {
      const session = await request('session/new', {
        cwd: ctx.input.projectPath,
        mcpServers: grokAcpMcpServers(ctx),
        _meta: { ...meta, sessionId },
      });
      if (session.sessionId !== sessionId) throw new Error('native-session-identity-changed');
    }
    ctx.emit({ at: new Date().toISOString(), type: 'session', data: { nativeSessionId: sessionId } });
    if (ctx.route.model)
      await request('session/set_model', {
        sessionId,
        modelId: ctx.route.model,
        ...(ctx.route.effort ? { _meta: { reasoningEffort: ctx.route.effort } } : {}),
      });
    // Some model-specific strict harnesses take priority over _meta.agentProfile.
    // Verify the native actor retained our profile before any model request.
    const sessionInfo = extensionResponse(await request('_x.ai/session/info', { sessionId }));
    auditPermissionConfig(ctx, '_x.ai/session/info', 'observed', {
      agentName: sessionInfo.agentName,
      permissionMode: sessionInfo.permissionMode,
      autoMode: sessionInfo.autoMode,
      yoloMode: sessionInfo.yoloMode,
    });
    if (sessionInfo.sessionId !== sessionId || sessionInfo.agentName !== 'comborunner-grok')
      throw new Error('runtime-permission-policy-unverified');
    if (grokAcpMcpServers(ctx).length) {
      const waitStarted = Date.now();
      let timer: NodeJS.Timeout | undefined, pollTimer: NodeJS.Timeout | undefined;
      let polling = true,
        catalog = 'not-requested',
        pendingServers: number | undefined;
      const pollBridge = async () => {
        try {
          const snapshot = extensionResponse(await request('_x.ai/mcp/list', { sessionId, cache: true }, 10_000));
          if (!polling || fatal) return;
          const servers = Array.isArray(snapshot.servers) ? snapshot.servers.map(object) : [];
          pendingServers = servers.filter((server) => object(server.session).status === 'initializing').length;
          const bridge = servers.find(
            (server) =>
              server.name === 'pugport' &&
              ((server.type === 'http' && server.url === ctx.agentBridge?.url) ||
                // Grok 1.0.67 lists session-only HTTP servers as local stdio placeholders without their URL.
                (server.source === 'local' &&
                  server.type === 'stdio' &&
                  server.command === '' &&
                  server.url === undefined &&
                  ['args', 'env'].every((field) => {
                    const value = server[field];
                    return value === undefined || (Array.isArray(value) && value.length === 0);
                  }))),
          );
          const state = object(bridge?.session);
          if (
            state.enabled === true &&
            state.status === 'ready' &&
            state.authRequired !== true &&
            Array.isArray(state.tools) &&
            state.tools.length > 0
          ) {
            catalog = 'ready';
            mcpReady('bridge-ready');
          } else {
            catalog = 'pending';
            pollTimer = setTimeout(() => void pollBridge(), 250);
          }
        } catch {
          // Older CLIs can lack this cached snapshot; retain the existing notification/deadline path.
          catalog = 'unavailable';
        }
      };
      // Only the host's explicit no-tools chat hint may stop waiting for unrelated native MCP servers.
      if (ctx.input.selfContainedChat) {
        catalog = 'pending';
        void pollBridge();
      }
      const outcome = await Promise.race([
        mcpInitialized,
        new Promise<McpReadiness>((resolveWait) => (timer = setTimeout(() => resolveWait('timeout'), 10_000))),
      ]);
      polling = false;
      clearTimeout(timer);
      clearTimeout(pollTimer);
      ctx.emit({
        at: new Date().toISOString(),
        type: 'status',
        text: '收到原生 CLI 控制状态更新。',
        data: {
          source: 'native',
          kind: 'mcp-readiness',
          detail: {
            outcome,
            waitMs: Math.max(0, Date.now() - waitStarted),
            catalog,
            ...(pendingServers === undefined ? {} : { pendingServers }),
          },
        },
      });
      if (ctx.signal.aborted) throw new Error('operation-cancelled');
      if (fatal) throw fatal;
    }
    prompting = true;
    // Initial turns and send-now replacements share the same bounded refusal recovery and session.
    const promptTurn = async (content: ObjectValue[], id: string, sendNow = false): Promise<ObjectValue> => {
      submittedPromptId = id;
      // No deadline on a model turn; abort, EOF and the final RPC are its boundaries.
      const result = await request(
        'session/prompt',
        {
          sessionId,
          prompt: content,
          _meta: { promptId: id, screenMode: 'headless', ...(sendNow ? { sendNow: true } : {}) },
        },
        null,
      );
      const meta = object(result._meta);
      if (meta.completionKind !== 'removedFromQueue') {
        observedPrompts.add(id);
        accumulateUsage(id, meta.usage);
      }
      if (
        result.stopReason === 'cancelled' &&
        meta.cancelTrigger !== 'send_now' &&
        meta.cancelTrigger !== 'user' &&
        hostDenied &&
        hostRefusal?.promptId === id &&
        refusalContinuations < 2 &&
        ctx.input.permissionMode === 'workspace-write' &&
        !ctx.input.untrustedContent &&
        !ctx.input.prohibitCommands &&
        !ctx.input.textOnly &&
        !ctx.signal.aborted &&
        !fatal
      ) {
        const refusal = hostRefusal;
        hostDenied = false;
        hostRefusal = undefined;
        refusalContinuations++;
        completedPrompts.add(id);
        if (nativeRunning === id) nativeRunning = undefined;
        const message = `（PugPort）上一条操作超出了本任务的写入范围（只能写 ${ctx.input.projectPath}），已拒绝：${refusal.detail}。请换一种只在项目内的做法继续，不要再试这条。`;
        ctx.emit({
          at: new Date().toISOString(),
          type: 'status',
          text: message,
          data: { source: 'pugport', kind: 'permission-refusal-continuation', attempt: refusalContinuations },
        });
        const continuationId = randomUUID();
        const continued = await promptTurn([{ type: 'text', text: message }], continuationId);
        completedPrompts.add(continuationId);
        if (nativeRunning === continuationId) nativeRunning = undefined;
        return continued;
      }
      return result;
    };
    const promptRequest = promptTurn(promptContent, promptId);
    const cancelledForSendNow = (result: ObjectValue) =>
      result.stopReason === 'cancelled' &&
      object(result._meta).cancelTrigger === 'send_now' &&
      sendNowPrompts.size > 0 &&
      !hostDenied &&
      !ctx.signal.aborted;
    const interruptSteer = (prompt: string, id: string) => {
      const submittedText =
        '用户中途补充了以下要求。保留原任务中未被修改的目标，先核对上一轮已完成的操作；如果旧命令仍在后台运行，检查并停止与新要求冲突的工作，不要重复已完成的操作。\n\n' +
        prompt;
      const echo = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          receipts.delete(id);
          reject(new Error('runtime-timeout'));
        }, deps.timeoutMs ?? 30_000);
        receipts.set(id, { text: submittedText, resolve, reject, timer });
      });
      void echo.catch(() => undefined);
      sendNowPrompts.add(id);
      replacementTexts.set(id, submittedText);
      steerSubmitted = true;
      const turn = promptTurn([{ type: 'text', text: submittedText }], id, true);
      let acknowledged = false;
      const delivery = echo.then(() => {
        acknowledged = true;
      });
      void delivery.catch(() => undefined);
      let lifetime!: Promise<void>;
      lifetime = (async () => {
        try {
          const result = await turn;
          const meta = object(result._meta);
          if (meta.completionKind === 'removedFromQueue') {
            // Native goals may convert the request to an interjection. Only the matching echo
            // confirms that case; removing a queued prompt alone is not a successful delivery.
            if (!appendedReplacements.has(id) && !combinedReplacements.has(id))
              await new Promise<ObjectValue>((resolve, reject) => {
                const timer = setTimeout(() => {
                  conversionWaiters.delete(id);
                  reject(new Error('runtime-steer-not-confirmed'));
                }, deps.timeoutMs ?? 30_000);
                conversionWaiters.set(id, { resolve, reject, timer });
              });
            await echo;
          } else {
            if (result.stopReason === 'cancelled' && !cancelledForSendNow(result))
              throw new Error(hostDenied ? 'runtime-permission-or-sandbox-error' : 'operation-cancelled');
            if (!text(result.stopReason)) throw new Error('runtime-protocol-incompatible');
            if (result.stopReason === 'error')
              throw nativeFailure(
                { message: result.agentResult ?? result.message, data: result.errorKind ?? result.error },
                'prompt-result',
              );
            // A completed successful RPC is also authoritative if a queue notification was missed.
            const receipt = receipts.get(id);
            if (receipt) {
              clearTimeout(receipt.timer);
              receipts.delete(id);
              receipt.resolve();
            }
          }
          completedPrompts.add(id);
          if (nativeRunning === id) nativeRunning = undefined;
        } catch (error) {
          const failure = error instanceof Error ? error : new Error('runtime-request-failed');
          const receipt = receipts.get(id);
          if (receipt) {
            clearTimeout(receipt.timer);
            receipts.delete(id);
            receipt.reject(failure);
          }
          // A rejected submission must not cancel an unrelated still-running turn. Once the
          // native queue accepted it, however, a failed replacement is a real execution failure.
          if (acknowledged || startedReplacements.has(id)) fail(failure);
        } finally {
          replacementTurns.delete(lifetime);
          refreshSteer();
          idleChanged?.();
        }
      })();
      replacementTurns.add(lifetime);
      steers.add(delivery);
      void delivery
        .finally(() => {
          steers.delete(delivery);
          refreshSteer();
          idleChanged?.();
        })
        .catch(() => undefined);
      return delivery;
    };
    steerHandler = (prompt, delivery) => {
      if (!canSteer || disposed || fatal || ctx.signal.aborted)
        return Promise.reject(new Error('runtime-process-closed'));
      if (delivery?.mode === 'interrupt') return interruptSteer(prompt, delivery.id);
      const interjectionId = randomUUID();
      const echo = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          receipts.delete(interjectionId);
          reject(new Error('runtime-timeout'));
        }, deps.timeoutMs ?? 30_000);
        receipts.set(interjectionId, { text: prompt, resolve, reject, timer });
      });
      // Attach a rejection observer immediately; RPC failures must not leave an unhandled receipt rejection.
      void echo.catch(() => undefined);
      const operation = (async () => {
        try {
          const result = extensionResponse(
            await request('_x.ai/interject', { sessionId, text: prompt, interjectionId }),
          );
          if (result.status !== 'queued') throw new Error('runtime-protocol-incompatible');
          steerSubmitted = true;
          await echo;
          // An accepted steer can race the end of a native fallback too. Reach
          // the same actor after its Interject command before allowing drain.
          if (initialPromptDone) extensionResponse(await request('_x.ai/session/info', { sessionId }));
        } catch (error) {
          const receipt = receipts.get(interjectionId);
          if (receipt) {
            clearTimeout(receipt.timer);
            receipts.delete(interjectionId);
            receipt.reject(error instanceof Error ? error : new Error('runtime-request-failed'));
          }
          throw error;
        }
      })();
      steers.add(operation);
      void operation
        .finally(() => {
          steers.delete(operation);
          refreshSteer();
          idleChanged?.();
        })
        .catch(() => undefined);
      return operation;
    };
    refreshSteer();
    let result: ObjectValue;
    try {
      result = await promptRequest;
    } finally {
      initialPromptDone = true;
      completedPrompts.add(promptId);
      if (nativeRunning === promptId) nativeRunning = undefined;
      refreshSteer();
    }
    // A rejected permission request also ends the turn as cancelled; that is a blocked step, not a user stop.
    if (result.stopReason === 'cancelled' && !cancelledForSendNow(result))
      throw new Error(
        hostDenied && !ctx.signal.aborted ? 'runtime-permission-or-sandbox-error' : 'operation-cancelled',
      );
    if (!text(result.stopReason)) throw new Error('runtime-protocol-incompatible');
    if (result.stopReason === 'error')
      throw nativeFailure(
        { message: result.agentResult ?? result.message, data: result.errorKind ?? result.error },
        'prompt-result',
      );
    // Settle accepted requests before leaving. This metadata barrier reaches the actor after
    // Interject and exposes already-promoted native fallback turns through queue/turn updates.
    // Each input's caller receives its own delivery failure. A rejected/timed-out interjection must not
    // tear down another accepted native turn or revoke that turn's bridge token. Transport errors still
    // set `fatal`; the actor barrier and drain below retain their normal failure handling.
    if (steers.size || receipts.size) await Promise.allSettled([...steers]);
    if (steerSubmitted) extensionResponse(await request('_x.ai/session/info', { sessionId }));
    if (nativeRunning || nativeQueued || steers.size || receipts.size || replacementTurns.size)
      await new Promise<void>((resolve, reject) => {
        const check = () => {
          if (fatal) {
            idleChanged = undefined;
            reject(fatal);
          } else if (
            !nativeRunning &&
            !nativeQueued &&
            steers.size === 0 &&
            receipts.size === 0 &&
            replacementTurns.size === 0
          ) {
            idleChanged = undefined;
            resolve();
          }
        };
        idleChanged = check;
        check();
      });
    if (fatal) throw fatal;
    const total: ObjectValue = {
      source: 'Grok CLI ACP prompt result',
      eventId: 'result',
      scope: 'run-cumulative',
      cumulative: true,
    };
    for (const field of [
      'inputTokens',
      'outputTokens',
      'cacheReadTokens',
      'cacheWriteTokens',
      'reasoningTokens',
      'totalTokens',
      'costUsdTicks',
    ]) {
      const values = [...observedPrompts].map((id) => usageByPrompt.get(id)?.[field]);
      if (values.length && values.every(number)) total[field] = values.reduce((sum, value) => sum + value, 0);
    }
    if (
      (usageByPrompt.size > 0 && observedPrompts.size !== usageByPrompt.size) ||
      [...usageByPrompt.values()].some((usage) => usage.incomplete)
    )
      total.incomplete = true;
    if (number(total.costUsdTicks) && total.incomplete !== true) {
      total.costUsd = total.costUsdTicks / 10_000_000_000;
      total.costKind = 'reported';
    }
    if (Object.keys(total).length > 4) ctx.emit({ at: new Date().toISOString(), type: 'usage', data: total });
    if (!output.trim()) throw new Error('runtime-request-failed');
    return { nativeSessionId: sessionId, output };
  } finally {
    ctx.endTools?.();
    ctx.registerSteer?.(undefined, { state: 'finishing' });
    dispose?.();
    if (child) await deps.terminate(child);
  }
}
