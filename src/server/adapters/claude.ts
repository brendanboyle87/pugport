import { executorImage } from '../attachment-image.ts';
import { conversationWorkTools } from '../conversation-work-tools.ts';
import { approvalKey } from '../approval-rules.ts';
import { subscriptionPlan } from '../subscription-plan.ts';
import { readClaudeSubscription } from '../claude-subscription.ts';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type {
  Adapter,
  ExecuteContext,
  IdleNativeSession,
  ModelInfo,
  QuotaWindow,
  RuntimeSnapshot,
  RuntimeTarget,
  RunInput,
  StartupFailure,
} from '../../shared/types.js';
import {
  spawnTarget,
  captureTarget,
  terminateProcess,
  redactError,
  runtimeError,
  CliDiagnosticCapture,
  StartupTail,
} from './process.js';
import {
  auditNativeProcess,
  auditNativeProtocolMetadata,
  auditPermissionConfig,
  auditStartupPhase,
} from './execution-audit.ts';
import { deviceFullAccess } from './device-access.ts';
import { safeToolEventText, toolEventDetails } from '../../shared/tool-event-data.ts';
import { discoverNativeInHelper } from '../native-discovery-client.ts';
import { deferredBridgeToolNames } from '../../shared/bridge-catalog.ts';
import { appDirs } from '../platform/dirs.ts';

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as ObjectValue) : {};
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const effortLevels = ['low', 'medium', 'high', 'xhigh', 'max'];
type Dependencies = {
  spawn: typeof spawnTarget;
  capture: typeof captureTarget;
  terminate: typeof terminateProcess;
  profile: typeof readClaudeSubscription;
};
const defaults: Dependencies = {
  spawn: spawnTarget,
  capture: captureTarget,
  terminate: terminateProcess,
  profile: readClaudeSubscription,
};

/** Group a verified native OAuth account without exposing its email or organization. */
export function claudeAccountFingerprint(payload: unknown): string | undefined {
  const status = object(payload);
  const method = text(status.authMethod)
    .toLowerCase()
    .replace(/[^a-z]/g, '');
  const email = text(status.email).trim().toLowerCase();
  if (status.loggedIn !== true || method !== 'claudeai' || status.apiProvider !== 'firstParty' || !email.includes('@'))
    return;
  return createHash('sha256')
    .update(JSON.stringify(['claude-native-oauth', email, text(status.orgId)]))
    .digest('hex');
}

/** Status output can contain account identifiers: expose only interpreted state. */
export function claudeAuthentication(payload: unknown): {
  loggedIn?: boolean;
  accounting: NonNullable<RuntimeSnapshot['accounting']>;
} {
  const status = object(payload);
  const method = text(status.authMethod)
    .toLowerCase()
    .replace(/[^a-z]/g, '');
  const api = ['apikey', 'apitoken', 'console'].includes(method);
  const subscription =
    status.loggedIn === true &&
    method === 'claudeai' &&
    status.apiProvider === 'firstParty' &&
    ['pro', 'max', 'team', 'enterprise'].includes(text(status.subscriptionType).toLowerCase());
  return {
    ...(typeof status.loggedIn === 'boolean' ? { loggedIn: status.loggedIn } : {}),
    accounting: {
      mode: api ? 'usage' : subscription ? 'subscription' : 'unknown',
      source: 'Claude CLI auth status',
      note: subscription
        ? '官方 CLI 已确认订阅登录；剩余额度另外查询，订阅类型不代表还有可用额度。'
        : api
          ? 'CLI 使用 API 认证：只记录实际消耗，不代表账户剩余额度。'
          : '仅凭登录配置无法确认套餐或剩余额度。',
    },
  };
}

/** A streaming-input result has turn-only tokens but session-cumulative estimated cost. */
/** Context windows the CLI has reported, by the model ID it named; later runs show occupancy before their result. */
const reportedContextWindows = new Map<string, number>();

/** The window the CLI's result reports for the model that produced the latest root message. */
export function claudeContextWindow(payload: unknown, model: string): number | undefined {
  const usage = object(object(payload).modelUsage);
  const entry = object(usage[model] ?? Object.values(usage).find((value) => object(value).canonicalModel === model));
  const window = entry.contextWindow;
  return typeof window === 'number' && Number.isFinite(window) && window > 0 ? window : undefined;
}

export function claudeResultUsage(
  payload: unknown,
  nativeSessionId?: string,
  freshSession = false,
  resultId?: string,
): Record<string, unknown>[] {
  const packet = object(payload),
    usage = object(packet.usage);
  const tokens: ObjectValue = {
    source: 'Claude CLI result.usage',
    eventId: resultId ? `result-tokens:${resultId}` : 'result-tokens',
    scope: resultId ? 'assistant-message' : 'run-cumulative',
    cumulative: !resultId,
    coverage: 'main-agent-only',
    note: '仅包含主 Agent 本轮 token，不包含子 Agent；会话估算成本可能覆盖更广的调用范围。',
  };
  for (const [source, destination] of [
    ['input_tokens', 'inputTokens'],
    ['output_tokens', 'outputTokens'],
    ['cache_read_input_tokens', 'cacheReadTokens'],
    ['cache_creation_input_tokens', 'cacheWriteTokens'],
  ] as const) {
    const value = usage[source];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) tokens[destination] = value;
  }
  const buckets = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'];
  if (buckets.every((key) => typeof tokens[key] === 'number'))
    tokens.totalTokens = buckets.reduce((sum, key) => sum + Number(tokens[key]), 0);
  const events: ObjectValue[] = Object.keys(tokens).length > 6 ? [tokens] : [];
  const cost = packet.total_cost_usd;
  if (typeof cost === 'number' && Number.isFinite(cost) && cost >= 0)
    events.push({
      source: 'Claude CLI estimated session cost',
      eventId: resultId ? `result-cost:${resultId}` : 'result-cost',
      scope: 'session-cumulative',
      cumulative: true,
      estimatedCostUsd: cost,
      ...(nativeSessionId ? { sessionId: nativeSessionId } : {}),
      freshSession,
      costKind: 'estimate',
    });
  return events;
}

function approvalPreview(value: unknown): string {
  return JSON.stringify(value ?? {}, (key, item: unknown) =>
    /token|password|secret|authorization|api.?key/i.test(key) ? '[redacted]' : item,
  )
    .replace(/\b(?:sk-[\w-]+|xai-[\w-]+)\b/g, '[redacted]')
    .slice(0, 4000);
}

function permissionReason(value: string): string {
  return value
    .replace(/\b(?:sk|pk|xai)-[\w-]+/g, '[redacted]')
    .replace(/(bearer\s+)[\w.+/=-]+/gi, '$1[redacted]')
    .replace(/((?:api[_-]?key|token|password|secret)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]')
    .slice(0, 2000);
}

export function claudeModels(payload: unknown): ModelInfo[] {
  const list = Array.isArray(payload) ? payload : object(payload).models;
  if (!Array.isArray(list)) return [];
  return list.flatMap((item): ModelInfo[] => {
    const row = object(item);
    if (!text(row.value)) return [];
    return [
      {
        id: text(row.value),
        label: text(row.displayName) || text(row.resolvedModel) || text(row.value),
        efforts: Array.isArray(row.supportedEffortLevels)
          ? row.supportedEffortLevels.filter(
              (level): level is string => typeof level === 'string' && effortLevels.includes(level),
            )
          : [],
        lightweight: /haiku/i.test(text(row.value)),
        // Claude Code's auto permission mode is unavailable with Haiku; it silently falls back to asking.
        ...(/haiku/i.test(text(row.value)) ? { noAutoApproval: true } : {}),
      },
    ];
  });
}

export function claudeQuota(payload: unknown): RuntimeSnapshot['quota'] {
  const data = object(payload);
  const windows: QuotaWindow[] = [];
  const addWindow = (
    id: string,
    label: string,
    duration: number,
    row: ObjectValue,
    modelFamily?: QuotaWindow['modelFamily'],
  ) => {
    const used = row.utilization;
    const window: QuotaWindow = {
      id,
      label,
      durationMinutes: duration,
      usedPercent: typeof used === 'number' && Number.isFinite(used) && used >= 0 && used <= 100 ? used : null,
      resetsAt: typeof row.resets_at === 'string' && Number.isFinite(Date.parse(row.resets_at)) ? row.resets_at : null,
      ...(row.resets_at === null ? { resetNotReported: true } : {}),
      ...(modelFamily ? { modelFamily } : {}),
    };
    const index = windows.findIndex((item) => item.id === id);
    if (index < 0) windows.push(window);
    else windows[index] = window;
  };
  if (data.rate_limits_available === true) {
    const rates = object(data.rate_limits);
    for (const [id, label, duration] of [
      ['five_hour', '5 小时额度', 300],
      ['seven_day', '每周额度', 10080],
      ['seven_day_oauth_apps', 'Apps · 每周额度', 10080],
      ['seven_day_opus', 'Opus · 每周额度', 10080],
      ['seven_day_sonnet', 'Sonnet · 每周额度', 10080],
    ] as const) {
      const row = object(rates[id]);
      if (Object.keys(row).length === 0) continue;
      addWindow(
        id,
        label,
        duration,
        row,
        id === 'seven_day_opus' ? 'opus' : id === 'seven_day_sonnet' ? 'sonnet' : undefined,
      );
    }
    // New CLI usage responses publish separate model limits dynamically. Do not
    // infer them from promotional/internal fields or infer a balance from a plan.
    for (const item of Array.isArray(rates.model_scoped) ? rates.model_scoped.slice(0, 100) : []) {
      const row = object(item);
      const name = text(row.display_name).trim();
      if (!name || name.length > 80 || /[\x00-\x1f\x7f]/.test(name)) continue;
      const family = /^(fable|opus|sonnet|haiku)(?:\s|$)/i.exec(name)?.[1]?.toLowerCase() as QuotaWindow['modelFamily'];
      const id = family && name.toLowerCase() === family ? `seven_day_${family}` : `model_scoped:${name.toLowerCase()}`;
      addWindow(id, `${name} · 每周额度`, 10080, row, family);
    }
  }
  const known = windows.some((window) => window.usedPercent !== null);
  const subscription = subscriptionPlan(data.subscription_type, 'Claude CLI get_usage（登录缓存）');
  return {
    status: known ? 'known' : 'unknown',
    source: 'Claude CLI 订阅额度',
    observedAt: new Date().toISOString(),
    windows,
    ...(subscription ? { subscription } : {}),
    note: known
      ? '官方 CLI get_usage 额度快照；此控制协议仍为实验接口。未报告的重置时间保持未知，token 消耗另行累计。'
      : data.rate_limits_available === true
        ? '官方 CLI 已确认额度查询能力，但当前没有返回有效窗口；请稍后刷新，未推算剩余额度。'
        : '当前 CLI 未提供订阅额度。API 或第三方登录可能不提供此信息，token 消耗不是剩余额度。',
  };
}

export function checkedArgument(value: string, name: string): string {
  if (!/^[a-zA-Z0-9._:/\[\]-]+$/.test(value)) throw new Error(`Invalid ${name}.`);
  return value;
}

/** Agent bridge tools an executor may call without a permission prompt. */
export const agentBridgeTools = [
  'list_conversations',
  'manage_conversations',
  'list_agents',
  'delegate',
  'delegate_many',
  'get_result',
  'cancel_task',
  'message_task',
  'report_progress',
  'message_parent',
  'list_swarm',
  'message_agent',
  'set_plan',
  'ask_user',
  'add_project_rule',
  'recycle_files',
  'organize_files',
  'undo_organize',
  'git',
  'read_run_detail',
  'check_style',
  'find_files',
  'search_text',
  'read_document',
  'find_similar_images',
  'summarize_folder',
  'find_duplicates',
  'analyze_media',
  'test_page',
  'mod_load',
  'mod_debug',
  'run_remote_job',
  'remote_job_status',
  'cancel_remote_job',
  ...conversationWorkTools.map((tool) => tool.name),
  'commit_branch',
  'push_branch',
  'open_branch_pull_request',
  'merge_branch_pull_request',
  'list_remote_queries',
  'run_remote_query',
  'run_judge',
  'judge_result',
  'cancel_judge',
].map((name) => `mcp__pugport__${name}`);

export function claudeBridgeConfig(agentBridge: { url: string; token: string }): string {
  return JSON.stringify({
    mcpServers: {
      pugport: {
        type: 'http',
        url: agentBridge.url,
        headers: { Authorization: `Bearer ${agentBridge.token}` },
      },
    },
  });
}

/** The workspace verifies speech-only requests separately from task routing and privacy restrictions. */
export function claudeNativeToolMode(target: RuntimeTarget | undefined, input: RunInput): 'none' | undefined {
  return target?.provider === 'claude' &&
    target.environment === 'native' &&
    !target.gateway &&
    (input.latencySensitiveChat || input.explicitNoTools) &&
    !input.untrustedContent &&
    !input.textOnly
    ? 'none'
    : undefined;
}

export function claudeSecretRule(path: string): string | undefined {
  if (/[*?\[\]{}!]/.test(path)) return undefined;
  const normalized = path.replace(/\\/g, '/');
  const absolute = normalized.replace(/^([A-Za-z]):\//, (_, drive: string) => `/${drive.toLowerCase()}/`);
  if (!absolute.startsWith('/')) return undefined;
  return `Edit(/${absolute.replace(/\/$/, '')}/**)`;
}

export function claudeExecutionArgs(ctx: ExecuteContext, mcpConfigPath?: string): string[] {
  const automatic = ctx.approvalMode === 'auto';
  const args = [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--replay-user-messages',
    '--permission-mode',
    automatic && deviceFullAccess(ctx) ? 'bypassPermissions' : automatic ? 'auto' : 'manual',
    '--permission-prompts',
    automatic ? 'none' : 'host',
  ];
  if (!automatic) args.push('--permission-prompt-tool', 'stdio');
  if (ctx.route.model) args.push('--model', checkedArgument(ctx.route.model, 'model ID'));
  if (ctx.route.effort) {
    if (!effortLevels.includes(ctx.route.effort)) throw new Error('Unsupported Claude effort.');
    args.push('--effort', ctx.route.effort);
  }
  if (ctx.nativeSessionId) args.push('--resume', checkedArgument(ctx.nativeSessionId, 'session ID'));
  // Tool-less: no built-in tools, no MCP server from any configuration, and safe mode skips CLAUDE.md, skills,
  // plugins and hooks, so the model sees only the prompt it was given.
  if (ctx.input.untrustedContent) {
    args.push('--tools', '', '--strict-mcp-config', '--safe-mode');
    return args;
  }
  if (claudeNativeToolMode(ctx.target, ctx.input) === 'none') {
    args.push('--tools', '', '--strict-mcp-config');
    if (ctx.input.prohibitCommands === true) args.push('--safe-mode');
    return args;
  }
  if (ctx.input.autoMemoryDirectory) {
    const directory = ctx.input.autoMemoryDirectory;
    if (!isAbsolute(directory) || directory.length > 32768 || /[\0\r\n]/.test(directory))
      throw new Error('Invalid memory directory.');
  }
  const deny = [
    '~/.ssh/**',
    '~/.codex/**',
    '~/.agents/**',
    '~/.claude/skills/**',
    '~/.claude/plugins/**',
    '~/.claude/.credentials.json',
    '~/.claude.json',
    '~/.claude/settings.json',
    '~/.claude/settings.local.json',
    '~/.config/gh/**',
    '~/.git-credentials',
    '~/.pugport/**',
  ].map((path) => `Edit(${path})`);
  const secrets = claudeSecretRule(appDirs().secrets);
  if (secrets) deny.push(secrets);
  for (const folder of [
    ...(process.env.CLAUDE_CONFIG_DIR
      ? [join(process.env.CLAUDE_CONFIG_DIR, 'skills'), join(process.env.CLAUDE_CONFIG_DIR, 'plugins')]
      : []),
    ...(process.env.CODEX_HOME ? [process.env.CODEX_HOME] : []),
  ]) {
    const rule = claudeSecretRule(folder);
    if (rule) deny.push(rule);
  }
  args.push(
    '--settings',
    JSON.stringify({
      ...(ctx.input.autoMemoryDirectory ? { autoMemoryDirectory: ctx.input.autoMemoryDirectory } : {}),
      permissions: { deny },
    }),
  );
  if (ctx.input.permissionMode === 'read-only' || ctx.input.prohibitCommands === true)
    args.push(
      '--tools',
      ctx.input.permissionMode === 'workspace-write' ? 'Read,Glob,Grep,Edit,Write' : 'Read,Glob,Grep',
      '--strict-mcp-config',
    );
  if (ctx.input.prohibitCommands === true) args.push('--safe-mode');
  if (mcpConfigPath) {
    // Deferred wrappers and GitHub preserve the actual tool's permission checks and confirmations in the bridge.
    const extensionTools = (ctx.agentBridge?.extraTools ?? [])
      .filter(
        (name) =>
          automatic ||
          name.startsWith('github_') ||
          deferredBridgeToolNames.includes(name) ||
          ['web_search', 'web_fetch'].includes(name),
      )
      .map((name) => 'mcp__pugport__' + name);
    args.push('--mcp-config', mcpConfigPath, '--allowedTools', [...agentBridgeTools, ...extensionTools].join(','));
  }
  return args;
}

/** The controller supplies managed, content-validated local attachment paths. */
export async function claudeUserContent(ctx: ExecuteContext): Promise<string | ObjectValue[]> {
  const images = (ctx.input.attachments ?? []).filter((attachment) => attachment.kind === 'image');
  if (!images.length) return ctx.input.prompt;
  const content: ObjectValue[] = [{ type: 'text', text: ctx.input.prompt }];
  const imageBudget = { bytes: 0 };
  for (const attachment of images) {
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(attachment.mimeType))
      throw new Error('Claude 不支持此图片格式，请使用 PNG、JPEG、WebP 或 GIF。');
    const selected = await executorImage(attachment, 'claude', ctx, imageBudget);
    if (!selected) {
      content.push({ type: 'text', text: `${attachment.name}：图片像素未提供，原件仍保留在 ${attachment.path}。` });
      continue;
    }
    const bytes = await readFile(selected.path);
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: selected.mimeType, data: bytes.toString('base64') },
    });
  }
  return content;
}

// Exact diagnostic supplied from a local Claude Code CLI capture.
const missingConversationPrefix = 'No conversation found with session ID:';

class ClaudeChannel {
  readonly startup = new StartupTail();
  private buffer = '';
  private stderrPrefix = '';
  private diagnostic = new CliDiagnosticCapture();
  missingConversation = false;
  private pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private closed = false;
  private terminalError: Error | null = null;
  onPacket: (packet: ObjectValue) => void = () => undefined;
  onClose: (error: Error) => void = () => undefined;
  constructor(
    readonly child: ChildProcessWithoutNullStreams,
    public errorOptions: Parameters<typeof runtimeError>[1] = {},
  ) {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      this.startup.write('stdout', chunk);
      this.buffer += chunk;
      if (this.buffer.length > 4 * 1024 * 1024) {
        this.fail(new Error('Claude protocol line exceeds the size limit.'));
        return;
      }
      let index: number;
      while ((index = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, index).trim();
        this.buffer = this.buffer.slice(index + 1);
        if (!line) continue;
        let packet: ObjectValue;
        try {
          packet = object(JSON.parse(line));
        } catch {
          this.missingConversation ||= line.startsWith(missingConversationPrefix);
          continue;
        }
        if (packet.type === 'control_response') {
          const response = object(packet.response);
          const id = text(response.request_id);
          const waiter = this.pending.get(id);
          if (waiter) {
            clearTimeout(waiter.timer);
            this.pending.delete(id);
            if (response.subtype === 'success') waiter.resolve(response.response);
            else
              waiter.reject(
                runtimeError(text(response.error) || 'Claude control request failed.', {
                  ...this.errorOptions,
                  provider: 'Claude',
                }),
              );
          }
        } else this.onPacket(packet);
      }
    });
    // Publish only the exact missing-conversation marker and fixed diagnostic codes.
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.startup.write('stderr', chunk);
      this.diagnostic.write(chunk);
      for (const part of chunk.split(/(?<=\n)/)) {
        this.stderrPrefix = (this.stderrPrefix + part).slice(0, missingConversationPrefix.length);
        this.missingConversation ||= this.stderrPrefix === missingConversationPrefix;
        if (part.endsWith('\n')) this.stderrPrefix = '';
      }
    });
    child.on('error', (error) => this.fail(new Error(redactError(error))));
    child.on('close', (code) => {
      const error = this.startup.active
        ? this.startup.failure('Claude', code ?? null, this.errorOptions)
        : new Error(this.diagnostic.code ?? `Claude process closed (${code ?? 'signal'}).`);
      if (error.message === 'runtime-process-closed' && this.diagnostic.code) error.message = this.diagnostic.code;
      this.fail(Object.assign(error, { exitCode: code }));
    });
    child.stdin.on('error', (error) => {
      if (!this.startup.active) this.fail(new Error(redactError(error)));
    });
  }
  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.terminalError = error;
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.pending.clear();
    this.onClose(error);
  }
  cancel(error: Error): void {
    this.fail(error);
  }
  isIdleReady(): boolean {
    return (
      !this.closed &&
      !this.buffer &&
      this.pending.size === 0 &&
      this.child.exitCode === null &&
      this.child.signalCode === null
    );
  }
  resetDiagnostics(options: Parameters<typeof runtimeError>[1]): void {
    this.errorOptions = options;
    this.diagnostic = new CliDiagnosticCapture();
    this.stderrPrefix = '';
    this.missingConversation = false;
  }
  write(packet: unknown): void {
    if (this.closed) throw this.terminalError ?? new Error('Claude connection is closed.');
    this.child.stdin.write(`${JSON.stringify(packet)}\n`);
  }
  request(request: ObjectValue, timeout = 20000): Promise<unknown> {
    if (this.closed) return Promise.reject(this.terminalError ?? new Error('Claude connection is closed.'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Claude control request timed out.'));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ type: 'control_request', request_id: id, request });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  async stop(deps: Dependencies): Promise<void> {
    this.child.stdin.end();
    if (!this.closed)
      await Promise.race([
        new Promise<void>((resolve) => this.child.once('close', () => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 300)),
      ]);
    await deps.terminate(this.child);
  }
}

// Claude's command receipt follows a fresh turn's result; it is not new work or a second result.
function completedCommandReceipt(packet: ObjectValue, userId: string, sessionId?: string): boolean {
  return (
    packet.type === 'command_lifecycle' &&
    packet.state === 'completed' &&
    packet.command_uuid === userId &&
    !!sessionId &&
    packet.session_id === sessionId &&
    typeof packet.uuid === 'string' &&
    /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(packet.uuid) &&
    Object.keys(packet).every((key) => ['type', 'state', 'command_uuid', 'uuid', 'session_id'].includes(key))
  );
}

class IdleClaudeSession implements IdleNativeSession {
  private stopping?: Promise<void>;
  constructor(
    readonly key: string,
    readonly nativeSessionId: string,
    readonly model: string,
    userId: string,
    readonly channel: ClaudeChannel,
    private readonly deps: Dependencies,
    onUnexpectedPacket: () => void,
  ) {
    channel.resetDiagnostics({});
    channel.onClose = () => undefined;
    // Only this turn's terminal receipt is harmless; unknown idle work still closes the child.
    channel.onPacket = (packet) => {
      if (completedCommandReceipt(packet, userId, nativeSessionId)) return;
      try {
        if (!this.stopping) onUnexpectedPacket();
      } catch {
        // An audit failure must never keep an unsafe idle child available.
      }
      void this.close().catch(() => undefined);
    };
  }
  isAlive(): boolean {
    return !this.stopping && this.channel.isIdleReady();
  }
  close(): Promise<void> {
    return (this.stopping ??= this.channel.stop(this.deps));
  }
}

function liveSessionKey(ctx: ExecuteContext, args: string[]): string | undefined {
  if (
    !ctx.takeNativeSession ||
    !ctx.nativeSessionConfiguration ||
    !ctx.route.accountFingerprint ||
    claudeNativeToolMode(ctx.target, ctx.input) !== 'none' ||
    ctx.sandbox ||
    ctx.runTemp ||
    ctx.agentBridge ||
    ctx.input.attachments?.length
  )
    return;
  const resume = args.indexOf('--resume');
  const staticArgs = resume < 0 ? args : [...args.slice(0, resume), ...args.slice(resume + 2)];
  return createHash('sha256')
    .update(
      JSON.stringify([
        ctx.nativeSessionConfiguration,
        ctx.target,
        staticArgs,
        ctx.route.accountFingerprint,
        ctx.input.projectPath,
        ctx.input.permissionMode,
        ctx.input.permissionOrigin,
        ctx.approvalMode,
        ctx.input.skills,
        ctx.input.agentPreset,
        ctx.input.connectorRevision,
        ctx.trustedProject,
      ]),
    )
    .digest('hex');
}

export function createClaudeAdapter(overrides: Partial<Dependencies> = {}): Adapter {
  const deps = { ...defaults, ...overrides };
  return {
    async discover(target: RuntimeTarget): Promise<RuntimeSnapshot> {
      if (process.platform === 'win32' && !Object.keys(overrides).length)
        return (await discoverNativeInHelper(target)).snapshot;
      const snapshot: RuntimeSnapshot = {
        id: target.id,
        provider: 'claude',
        label: target.label,
        environment: target.environment,
        installed: false,
        status: 'missing',
        models: [],
        quota: { status: 'unknown', source: 'Claude CLI', observedAt: null, windows: [] },
        capabilities: { execute: true, resume: true, cancel: true, approvals: true, steer: true, toolless: true },
        refreshedAt: new Date().toISOString(),
      };
      let channel: ClaudeChannel | undefined;
      let auth: ReturnType<typeof claudeAuthentication> | undefined;
      let authPayload: unknown;
      try {
        // A native signed-out CLI can start and expose model names without any usable
        // credential. Check first so an unavailable control request cannot mask login state.
        const result = await deps.capture(target, ['auth', 'status'], { timeoutMs: 10000, acceptedExitCodes: [0, 1] });
        authPayload = JSON.parse(result.stdout);
        auth = claudeAuthentication(authPayload);
        snapshot.accounting = auth.accounting;
        snapshot.accountFingerprint = claudeAccountFingerprint(authPayload);
        if (auth.accounting.mode === 'subscription')
          snapshot.subscription = subscriptionPlan(
            object(authPayload).subscriptionType,
            'Claude CLI auth status（登录缓存）',
          );
        if (auth.loggedIn === false) {
          snapshot.installed = true;
          snapshot.status = 'auth-required';
          snapshot.accounting = auth.accounting;
          snapshot.quota = {
            status: 'unknown',
            source: 'Claude CLI auth status',
            observedAt: new Date().toISOString(),
            windows: [],
            note: '当前 Claude CLI 没有有效登录，尚未查询订阅额度。请使用当前 CLI 登录后刷新；未登录不代表额度为零。',
          };
          snapshot.note = '当前原生 Claude CLI 已安装，但没有有效登录；请完成该 CLI 的登录后刷新连接。';
          return snapshot;
        }
      } catch {
        /* Older or third-party launchers may not implement native auth status. */
      }
      // Account metadata does not depend on the experimental control handshake.
      // A temporary startup failure must not prevent a verified plan upgrade from
      // being displayed, and a profile failure must not make execution unavailable.
      let profilePromise: ReturnType<Dependencies['profile']> | undefined;
      const profile = (): ReturnType<Dependencies['profile']> =>
        (profilePromise ??= Promise.resolve()
          .then(() => deps.profile(target, authPayload))
          .catch(() => ({ note: '实时套餐暂未核验，当前套餐名称来自 CLI 登录缓存。' })));
      try {
        const env = { ...process.env };
        const trafficSwitches = Object.keys(env).filter((key) =>
          /^CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC$/i.test(key),
        );
        if (trafficSwitches.some((key) => !!env[key])) {
          // Claude's blanket traffic switch also blocks this explicitly requested quota read.
          for (const key of trafficSwitches) delete env[key];
          for (const name of [
            'DISABLE_TELEMETRY',
            'DISABLE_ERROR_REPORTING',
            'DISABLE_AUTOUPDATER',
            'DISABLE_FEEDBACK_COMMAND',
          ]) {
            for (const key of Object.keys(env)) if (key.toUpperCase() === name) delete env[key];
            env[name] = '1';
          }
        }
        const child = await deps.spawn(
          target,
          [
            '-p',
            '--input-format',
            'stream-json',
            '--output-format',
            'stream-json',
            '--verbose',
            '--include-partial-messages',
            '--replay-user-messages',
            '--permission-mode',
            'auto',
            '--safe-mode',
            '--no-session-persistence',
            '--strict-mcp-config',
            '--tools',
            '',
            '--permission-prompts',
            'none',
          ],
          { env },
        );
        snapshot.installed = true;
        channel = new ClaudeChannel(child, { paths: [target.agentDir] });
        const initialized = await channel.request({ subtype: 'initialize' });
        channel.startup.done();
        snapshot.models = claudeModels(initialized);
        const cliVersion = text(object(initialized).claude_code_version);
        if (/^[a-zA-Z0-9._-]{1,100}$/.test(cliVersion)) snapshot.version = cliVersion;
        const version = /^2\.1\.(\d+)$/.exec(cliVersion);
        // 2.1.302 separates quota from transcript statistics; older/unknown CLIs keep the full usage read.
        const skipBehaviors = !!version && Number(version[1]) >= 302;
        // Let native initialization refresh its own credentials before reading
        // the profile. The failure path below still performs this independent read.
        void profile();
        // Control requests carry independent IDs; model discovery and usage can
        // overlap once initialize completes. Neither request starts inference.
        const [catalog, usage] = await Promise.allSettled([
          channel.request({ subtype: 'list_models' }),
          channel.request({ subtype: 'get_usage', skip_behaviors: skipBehaviors }),
        ]);
        if (catalog.status === 'fulfilled') {
          const models = claudeModels(catalog.value);
          if (models.length) snapshot.models = models;
        }
        // Older CLI: initialize may contain models when list_models is absent.
        if (usage.status === 'fulfilled') snapshot.quota = claudeQuota(usage.value);
        else {
          snapshot.quota = {
            status: 'error',
            source: 'Claude CLI get_usage (experimental)',
            observedAt: new Date().toISOString(),
            windows: [],
            note: redactError(usage.reason),
          };
        }
        snapshot.status = snapshot.models.length ? 'ready' : 'unknown';
        snapshot.accounting = {
          mode: snapshot.quota.status === 'known' ? 'subscription' : 'unknown',
          source: snapshot.quota.source,
        };
        if (snapshot.quota.status !== 'known' && auth) snapshot.accounting = auth.accounting;
      } catch (error) {
        const message = redactError(error);
        snapshot.status =
          message === 'runtime-not-found' || /ENOENT|not found|cannot find|not installed/i.test(message)
            ? 'missing'
            : /auth|login|credential/i.test(message)
              ? 'auth-required'
              : 'error';
        snapshot.installed = snapshot.status !== 'missing';
        snapshot.note = message;
        snapshot.errorDetail = (error as { startup?: StartupFailure }).startup?.firstLine;
        snapshot.quota.note =
          message === 'runtime-protocol-incompatible'
            ? '当前 Claude CLI 不支持所需协议或安全参数，请更新官方 Claude Code 后刷新连接。'
            : '本次 CLI 启动或握手检查未完成，尚未取得额度；未改变 CLI 登录状态。';
      } finally {
        if (channel) await channel.stop(deps);
      }
      const accountProfile = await profile();
      if (auth?.accounting.mode !== 'usage') {
        snapshot.subscription = snapshot.quota.subscription ?? snapshot.subscription;
        if (accountProfile.subscription) {
          snapshot.subscription = snapshot.quota.subscription = accountProfile.subscription;
        } else if (auth?.accounting.mode === 'subscription' && snapshot.quota.status !== 'error') {
          snapshot.quota.note = [
            snapshot.quota.note,
            accountProfile.note || '实时套餐暂未核验，当前套餐名称来自 CLI 登录缓存。',
          ]
            .filter(Boolean)
            .join(' ');
        }
      }
      if (snapshot.accountFingerprint) {
        // Auth status and the control process are separate reads. An external login switch
        // during initialization must not attach the new account's usage to the old identity.
        let freshPayload: unknown;
        // A read that fails outright (timeout, unparseable output) is retried once, so a hiccup is not
        // mistaken for an account switch. Still unverified after that, nothing account-bound is published.
        for (let attempt = 0; attempt < 2 && freshPayload === undefined; attempt++)
          try {
            const result = await deps.capture(target, ['auth', 'status'], {
              timeoutMs: 10000,
              acceptedExitCodes: [0, 1],
            });
            freshPayload = JSON.parse(result.stdout);
          } catch {
            /* Retried once; then treated as unverified. */
          }
        if (claudeAccountFingerprint(freshPayload) !== snapshot.accountFingerprint) {
          const freshAuth = claudeAuthentication(freshPayload);
          snapshot.accountFingerprint = undefined;
          snapshot.subscription = undefined;
          snapshot.quota = {
            status: 'unknown',
            source: 'Claude CLI identity consistency check',
            observedAt: null,
            windows: [],
            note: '查询期间无法确认同一 Claude 账号；未采用本次额度和套餐，请刷新后重试。',
          };
          snapshot.accounting = freshAuth.accounting;
          if (freshAuth.loggedIn === false) snapshot.status = 'auth-required';
          else if (snapshot.status === 'ready' || snapshot.status === 'unknown') snapshot.status = 'unknown';
          snapshot.note = [snapshot.note, snapshot.quota.note].filter(Boolean).join(' ');
        }
      }
      return snapshot;
    },
    async execute(ctx: ExecuteContext) {
      let mcpConfigPath: string | undefined;
      const noTools = claudeNativeToolMode(ctx.target, ctx.input) === 'none';
      if (noTools) ctx.registerSteer?.(undefined, { state: 'unsupported' });
      try {
        if (ctx.signal.aborted) throw new Error('Run cancelled.');
        if (ctx.nativeSessionId) {
          // An external terminal may log in as someone else after the last quota
          // refresh. Recheck metadata before resuming, without starting inference.
          const startedAt = performance.now();
          let verified = false;
          try {
            let fingerprint: string | undefined;
            try {
              const auth = await deps.capture(ctx.target, ['auth', 'status'], {
                timeoutMs: 10000,
                acceptedExitCodes: [0, 1],
              });
              fingerprint = claudeAccountFingerprint(JSON.parse(auth.stdout));
            } catch {
              if (ctx.signal.aborted) throw new Error('Run cancelled.');
              throw new Error('native-session-identity-unverified');
            }
            if (ctx.signal.aborted) throw new Error('Run cancelled.');
            if (!fingerprint || !ctx.route.accountFingerprint) throw new Error('native-session-identity-unverified');
            if (fingerprint !== ctx.route.accountFingerprint) throw new Error('native-session-identity-changed');
            verified = true;
          } finally {
            auditStartupPhase(
              ctx.emit,
              'resume-identity',
              startedAt,
              ctx.signal.aborted ? 'cancelled' : verified ? 'completed' : 'failed',
            );
          }
        }
        const content = await claudeUserContent(ctx);
        if (ctx.signal.aborted) throw new Error('Run cancelled.');
        if (ctx.agentBridge && !ctx.input.untrustedContent && !noTools) {
          mcpConfigPath = join(ctx.runTemp ?? tmpdir(), `comborunner-mcp-${randomUUID()}.json`);
          const startedAt = performance.now();
          let written = false;
          try {
            await writeFile(mcpConfigPath, claudeBridgeConfig(ctx.agentBridge), { mode: 0o600, flag: 'wx' });
            written = true;
          } finally {
            auditStartupPhase(
              ctx.emit,
              'mcp-config',
              startedAt,
              ctx.signal.aborted ? 'cancelled' : written ? 'completed' : 'failed',
            );
          }
        }
        const args = claudeExecutionArgs(ctx, mcpConfigPath);
        const reuseKey = liveSessionKey(ctx, args);
        const saved = await ctx.takeNativeSession?.(reuseKey ?? '', ctx.nativeSessionId);
        const reused = saved instanceof IdleClaudeSession ? saved : undefined;
        if (saved && !reused) await saved.close();
        const startedAt = performance.now();
        let child: ChildProcessWithoutNullStreams | undefined = reused?.channel.child;
        try {
          if (!child)
            child = await deps.spawn(
              args.includes('--settings')
                ? {
                    ...ctx.target,
                    args: ctx.target.args?.filter(
                      (arg, index, all) =>
                        arg !== '--settings' && !arg.startsWith('--settings=') && all[index - 1] !== '--settings',
                    ),
                  }
                : ctx.target,
              args,
              {
                ...(mcpConfigPath ? { env: { ...process.env, MCP_TOOL_TIMEOUT: '660000' } } : {}),
                sandbox: ctx.sandbox,
                onSandboxFailure: ctx.onSandboxFailure,
                onSandboxSuccess: ctx.onSandboxSuccess,
                signal: ctx.signal,
                runTemp: ctx.runTemp,
                cwd: ctx.input.projectPath,
              },
            );
        } finally {
          if (!reused)
            auditStartupPhase(
              ctx.emit,
              'native-spawn',
              startedAt,
              ctx.signal.aborted ? 'cancelled' : child ? 'completed' : 'failed',
            );
        }
        const detachProcessAudit = auditNativeProcess(ctx, child, args, 'claude-stream-json', !!reused);
        const argument = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
        auditPermissionConfig(ctx, 'process/spawn', 'requested', {
          permissionMode: argument('--permission-mode'),
          permissionPrompts: argument('--permission-prompts'),
          permissionPromptTool: argument('--permission-prompt-tool'),
          tools: argument('--tools'),
          cwd: ctx.input.projectPath,
        });
        const errorOptions = {
          paths: [ctx.dataDir, ctx.target.agentDir],
          secrets: [ctx.agentBridge?.token],
          prompt: ctx.input.prompt,
        };
        const channel = reused?.channel ?? new ClaudeChannel(child, errorOptions);
        channel.resetDiagnostics(errorOptions);
        let reusable = !!reuseKey;
        let replayConfirmed = false;
        let resultCorrelated = false;
        let observedModel = '';
        let observedNoTools = false;
        const activeHooks = new Set<string>();
        let offered: IdleClaudeSession | undefined;
        let output = '';
        let hadAssistantOutput = false;
        let receivedResult = false;
        let missingResult = false;
        let turnOutputStart = 0;
        let nativeSessionId = ctx.nativeSessionId;
        let streamedThisMessage = false;
        let textItem = 0;
        let thoughtThisMessage = false;
        let lastContextMessageId: string | undefined;
        // The last root message's occupancy, re-sent with the window once a result reports it.
        let lastContextUsage: { usage: Record<string, unknown>; messageId?: string; model: string } | undefined;
        const reportedDenials = new Set<string>();
        const toolCalls = new Map<string, { name: string; background: boolean }>();
        const emitTool = (
          id: string,
          name: string,
          status: string,
          isError = false,
          details: ObjectValue = {},
        ): void => {
          hadAssistantOutput = true;
          id = id.length <= 512 && safeToolEventText(id, 512) === id ? id : '';
          name = safeToolEventText(name, 256);
          const bridge = /^mcp__pugport__(.+)$/.exec(name);
          ctx.emit({
            at: new Date().toISOString(),
            type: 'tool',
            text: name || 'Tool call',
            data: {
              ...(id ? { toolCallId: id } : {}),
              kind: bridge ? 'mcpToolCall' : 'nativeToolCall',
              tool: bridge?.[1] ?? name,
              ...(bridge ? { server: 'pugport' } : {}),
              status,
              ...(isError ? { isError: true } : {}),
              ...details,
            },
          });
        };
        let settled = false;
        let currentUserId = randomUUID();
        let steeringSupported = false;
        let steeringInitialized = false;
        let turnActive = false;
        let hasSteered = false;
        const packetWaiter = () => {
          let resolve!: () => void;
          let reject!: (error: Error) => void;
          const promise = new Promise<void>((accept, decline) => {
            resolve = accept;
            reject = decline;
          });
          void promise.catch(() => undefined);
          const timer = setTimeout(() => reject(new Error('runtime-steering-acknowledgment-timed-out')), 20000);
          return {
            promise,
            resolve: () => {
              clearTimeout(timer);
              resolve();
            },
            reject: (error: Error) => {
              clearTimeout(timer);
              reject(error);
            },
          };
        };
        type SteeringTransition = {
          originalUserId: string;
          interrupted: ReturnType<typeof packetWaiter>;
          result?: ObjectValue;
          accepted?: ReturnType<typeof packetWaiter>;
        };
        let transition: SteeringTransition | undefined;
        let resolveRun!: () => void;
        let rejectRun!: (error: Error) => void;
        const completed = new Promise<void>((resolve, reject) => {
          resolveRun = resolve;
          rejectRun = reject;
        });
        // Install a rejection observer before awaiting initialization.
        void completed.catch(() => undefined);
        const fail = (error: Error): void => {
          if (!settled) {
            settled = true;
            ctx.endTools?.();
            ctx.registerSteer?.(undefined, { state: 'finishing' });
            transition?.interrupted.reject(error);
            transition?.accepted?.reject(error);
            rejectRun(error);
          }
        };
        let heldResult: ObjectValue | undefined;
        let holdTimer: ReturnType<typeof setTimeout> | undefined;
        const emptyTurn = (packet: ObjectValue): boolean => {
          const usage = object(packet.usage);
          const buckets = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'];
          return (
            !hadAssistantOutput &&
            !output &&
            (packet.num_turns === 0 || buckets.every((key) => typeof usage[key] === 'number' && usage[key] === 0))
          );
        };
        const completeResult = (packet: ObjectValue, released = false): void => {
          if (
            !released &&
            !ctx.nativeSessionId &&
            emptyTurn(packet) &&
            packet.is_error !== true &&
            !(typeof packet.subtype === 'string' && packet.subtype.startsWith('error'))
          ) {
            heldResult = packet;
            holdTimer = setTimeout(() => {
              heldResult = undefined;
              completeResult(packet, true);
            }, 1500);
            return;
          }
          if (packet.is_error === true || (typeof packet.subtype === 'string' && packet.subtype.startsWith('error')))
            fail(
              runtimeError(text(packet.result) || text(packet.subtype) || 'Claude failed.', {
                provider: 'Claude',
                paths: [ctx.dataDir, ctx.target.agentDir],
                prompt: ctx.input.prompt,
              }),
            );
          else {
            settled = true;
            ctx.endTools?.();
            ctx.registerSteer?.(undefined, { state: 'finishing' });
            resolveRun();
          }
        };
        const publishSteer = (): void => {
          if (noTools) ctx.registerSteer?.(undefined, { state: settled ? 'finishing' : 'unsupported' });
          else if (steeringSupported && turnActive && !transition && !settled) ctx.registerSteer?.(steer);
          else
            ctx.registerSteer?.(
              undefined,
              settled
                ? { state: 'finishing' }
                : !steeringInitialized
                  ? { state: 'starting' }
                  : !steeringSupported
                    ? { state: 'unsupported', reason: '当前 Claude CLI 未提供安全续接所需的原生回执能力。' }
                    : { state: 'waiting', reason: '等待原生回复或正在续接执行阶段。' },
            );
        };
        const steer = async (prompt: string): Promise<void> => {
          if (noTools || !steeringSupported || !turnActive || transition || settled || ctx.signal.aborted)
            throw new Error('runtime-steering-unavailable');
          const pending: SteeringTransition = {
            originalUserId: currentUserId,
            interrupted: packetWaiter(),
          };
          transition = pending;
          turnActive = false;
          publishSteer();
          let interrupted = false;
          let sent = false;
          try {
            // Streaming-input interrupt preserves the process/session. Wait for the
            // old turn's correlated result before submitting exactly one continuation.
            const receipt = object(await channel.request({ subtype: 'interrupt' }));
            interrupted = true;
            if (!Array.isArray(receipt.still_queued) || !receipt.still_queued.every((id) => typeof id === 'string'))
              throw new Error('runtime-steering-interrupt-receipt-invalid');
            await pending.interrupted.promise;
            if (settled || ctx.signal.aborted) throw new Error('runtime-steering-unavailable');
            if (
              pending.result &&
              (pending.result.is_error === true || text(pending.result.subtype).startsWith('error')) &&
              !text(pending.result.terminal_reason).startsWith('aborted_')
            )
              throw runtimeError(text(pending.result.result) || text(pending.result.subtype), {
                provider: 'Claude',
                paths: [ctx.dataDir, ctx.target.agentDir],
                prompt: ctx.input.prompt,
              });
            currentUserId = randomUUID();
            turnOutputStart = output.length;
            pending.accepted = packetWaiter();
            hasSteered = true;
            sent = true;
            channel.write({
              type: 'user',
              uuid: currentUserId,
              ...(nativeSessionId ? { session_id: nativeSessionId } : {}),
              message: { role: 'user', content: prompt },
              parent_tool_use_id: null,
              origin: { kind: 'human' },
              client_composed: true,
            });
            // A replay or a correlated reply/result proves receipt. No automatic resend.
            await pending.accepted.promise;
          } catch (error) {
            const failure = runtimeError(error, {
              paths: [ctx.dataDir, ctx.target.agentDir],
              prompt: ctx.input.prompt,
            });
            if (sent || (interrupted && !pending.result)) fail(failure);
            else if (pending.result) completeResult(pending.result);
            else turnActive = true;
            throw failure;
          } finally {
            pending.interrupted.reject(new Error('runtime-steering-unavailable'));
            pending.accepted?.reject(new Error('runtime-steering-unavailable'));
            if (transition === pending) transition = undefined;
            publishSteer();
          }
        };
        const emitText = (chunk: string): void => {
          if (chunk) {
            output += chunk;
            ctx.emit({
              at: new Date().toISOString(),
              type: 'text',
              text: chunk,
              data: { itemId: `claude-text-${textItem}` },
            });
          }
        };
        const emitContext = (contextWindow?: number): void => {
          if (!lastContextUsage) return;
          ctx.emit({
            at: new Date().toISOString(),
            type: 'status',
            data: {
              messageUsage: lastContextUsage.usage,
              ...(contextWindow ? { contextWindow } : {}),
              // Lets the per-request ledger join repeated snapshots of one message; never shown as content.
              ...(lastContextUsage.messageId ? { messageId: lastContextUsage.messageId } : {}),
            },
          });
        };
        const abort = (): void => {
          const error = new Error('Run cancelled.');
          fail(error);
          channel.cancel(error);
          void deps.terminate(child);
        };
        ctx.signal.addEventListener('abort', abort, { once: true });
        channel.onClose = (error) => {
          if (heldResult && (error as Error & { exitCode?: number }).exitCode === 0) {
            const packet = heldResult;
            heldResult = undefined;
            clearTimeout(holdTimer);
            completeResult(packet, true);
          } else fail(error);
        };
        channel.onPacket = (packet) => {
          if (settled) {
            if (!completedCommandReceipt(packet, currentUserId, nativeSessionId)) reusable = false;
            return;
          }
          const answers = (id: string): boolean =>
            packet.user_message_uuid === id ||
            (Array.isArray(packet.user_message_uuids) && packet.user_message_uuids.includes(id));
          const ids = [
            packet.user_message_uuid,
            ...(Array.isArray(packet.user_message_uuids) ? packet.user_message_uuids : []),
          ].filter((value) => typeof value === 'string');
          if (
            reused &&
            ((typeof packet.session_id === 'string' && packet.session_id !== ctx.nativeSessionId) ||
              (ids.length > 0 && !answers(currentUserId)))
          ) {
            fail(new Error('native-session-reply-identity-mismatch'));
            return;
          }
          if (packet.type === 'user' && packet.isReplay === true) {
            if (packet.uuid === currentUserId) replayConfirmed = true;
            else if (reused) {
              fail(new Error('native-session-reply-identity-mismatch'));
              return;
            }
          }
          const event = object(packet.event);
          const content = object(packet.message).content;
          if (packet.type === 'system' && text(packet.subtype).startsWith('hook_')) {
            const id = text(packet.hook_id);
            if (!id) reusable = false;
            else if (packet.subtype === 'hook_started' || packet.subtype === 'hook_progress') activeHooks.add(id);
            else if (packet.subtype === 'hook_response') activeHooks.delete(id);
            else reusable = false;
          }
          const toolActivity =
            packet.type === 'control_request' ||
            object(event.content_block).type === 'tool_use' ||
            (Array.isArray(content) &&
              content.some((value) => object(value).type === 'tool_use' || object(value).type === 'tool_result')) ||
            (packet.type === 'system' && /task|permission/i.test(text(packet.subtype)));
          if (reuseKey && toolActivity) {
            fail(new Error('native-session-unexpected-tool-activity'));
            return;
          }
          if (
            reused &&
            ['assistant', 'stream_event'].includes(text(packet.type)) &&
            (packet.isReplay === true || (!replayConfirmed && !answers(currentUserId)))
          ) {
            fail(new Error('native-session-reply-identity-unverified'));
            return;
          }
          const isReply =
            packet.type === 'assistant' || (packet.type === 'stream_event' && object(packet.event).type !== 'ping');
          if (isReply && answers(currentUserId)) {
            turnActive = true;
            if (hasSteered) transition?.accepted?.resolve();
            publishSteer();
          }
          if (packet.type === 'user' && packet.isReplay === true && packet.uuid === currentUserId && hasSteered)
            transition?.accepted?.resolve();
          if (typeof packet.session_id === 'string' && packet.session_id !== nativeSessionId) {
            nativeSessionId = packet.session_id;
            ctx.emit({ at: new Date().toISOString(), type: 'session', data: { nativeSessionId } });
          }
          if (packet.type === 'control_request') {
            const request = object(packet.request);
            if (request.subtype !== 'can_use_tool')
              auditNativeProtocolMetadata(ctx, packet, false, text(request.subtype));
            const id = text(packet.request_id);
            void (async () => {
              try {
                if (request.subtype !== 'can_use_tool') {
                  channel.write({
                    type: 'control_response',
                    response: {
                      subtype: 'error',
                      request_id: id,
                      error: 'This host does not support that interactive request.',
                    },
                  });
                  return;
                }
                const tool = text(request.tool_name) || 'Tool';
                const description = approvalPreview(request.input);
                const automatic = ctx.approvalMode === 'auto';
                const commandDenied =
                  ctx.input.prohibitCommands === true &&
                  !(
                    ctx.input.permissionMode === 'workspace-write'
                      ? ['Read', 'Glob', 'Grep', 'Edit', 'Write']
                      : ['Read', 'Glob', 'Grep']
                  ).includes(tool) &&
                  !tool.startsWith('mcp__pugport__');
                const allowed =
                  automatic || commandDenied
                    ? false
                    : await ctx.approve(
                        tool,
                        description,
                        approvalKey(tool, object(request.input), ctx.input.projectPath),
                      );
                if (ctx.signal.aborted || settled) return;
                if (automatic)
                  ctx.emit({
                    at: new Date().toISOString(),
                    type: 'status',
                    text: permissionReason(`Claude ${tool} 请求人工确认；自动模式已拒绝此额外授权。`),
                    data: {
                      approvalMode: 'auto',
                      decision: 'deny',
                      source: 'Claude native permission request',
                      nativeMethod: 'control_request/can_use_tool',
                      nativePromptId: safeToolEventText(id, 512),
                      ...(text(request.tool_use_id)
                        ? { toolCallId: safeToolEventText(text(request.tool_use_id), 512) }
                        : {}),
                      nativeTool: safeToolEventText(tool, 256),
                    },
                  });
                channel.write({
                  type: 'control_response',
                  response: {
                    subtype: 'success',
                    request_id: id,
                    response: allowed
                      ? { behavior: 'allow', updatedInput: object(request.input) }
                      : {
                          behavior: 'deny',
                          message: commandDenied
                            ? 'The user prohibited commands for this run. Only scoped file tools and the host bridge are available.'
                            : automatic
                              ? 'PugPort automatic mode does not grant additional interactive permissions. Continue within the configured native permissions.'
                              : 'The user denied this tool call.',
                        },
                  },
                });
              } catch (error) {
                fail(runtimeError(error, { paths: [ctx.dataDir, ctx.target.agentDir], prompt: ctx.input.prompt }));
              }
            })();
          } else if (packet.type === 'system' && packet.subtype === 'init') {
            channel.startup.done();
            observedNoTools =
              Array.isArray(packet.tools) &&
              packet.tools.length === 0 &&
              Array.isArray(packet.mcp_servers) &&
              packet.mcp_servers.length === 0;
            observedModel = text(packet.model);
            if (reused && (!observedNoTools || observedModel !== reused.model)) {
              fail(new Error('native-session-configuration-changed'));
              return;
            }
            auditPermissionConfig(ctx, 'system/init', 'observed', { permissionMode: packet.permissionMode });
            const version = /^([0-9]+)\.([0-9]+)\.([0-9]+)/.exec(text(packet.claude_code_version));
            // v2.1.265 guarantees UUIDs even on error/no-API results. Capability
            // detection alone does not guarantee that result correlation contract.
            steeringSupported =
              !!version &&
              (Number(version[1]) > 2 ||
                (Number(version[1]) === 2 &&
                  (Number(version[2]) > 1 || (Number(version[2]) === 1 && Number(version[3]) >= 265)))) &&
              Array.isArray(packet.capabilities) &&
              packet.capabilities.includes('interrupt_receipt_v1');
            steeringInitialized = true;
            publishSteer();
            if (
              ctx.approvalMode === 'auto' &&
              typeof packet.permissionMode === 'string' &&
              packet.permissionMode !== (deviceFullAccess(ctx) ? 'bypassPermissions' : 'auto')
            ) {
              ctx.emit({
                at: new Date().toISOString(),
                type: 'status',
                text: 'Claude 当前账户、模型或原生设置未启用自动审批，已停止执行；请检查 CLI 的 auto 模式支持情况。',
              });
              fail(new Error('runtime-permission-or-sandbox-error'));
            }
          } else if (packet.type === 'system' && packet.subtype === 'permission_denied') {
            const id = text(packet.tool_use_id);
            if (id) reportedDenials.add(id);
            const reason = text(packet.decision_reason) || text(packet.message) || '原生权限策略拒绝此操作';
            ctx.emit({
              at: new Date().toISOString(),
              type: 'status',
              text: permissionReason(`Claude ${text(packet.tool_name) || '工具'} 已拒绝：${reason}`),
              data: {
                decision: 'deny',
                source: 'Claude native permission policy',
                reasonType: permissionReason(text(packet.decision_reason_type)),
                nativeMethod: 'system/permission_denied',
                ...(id ? { toolCallId: safeToolEventText(id, 512) } : {}),
                ...(text(packet.tool_name) ? { nativeTool: safeToolEventText(text(packet.tool_name), 256) } : {}),
              },
            });
          } else if (packet.type === 'stream_event') {
            const event = object(packet.event);
            if (event.type === 'message_start' || event.type === 'content_block_start') textItem++;
            if (event.type === 'message_start') {
              streamedThisMessage = false;
              thoughtThisMessage = false;
            }
            const delta = object(event.delta);
            if (delta.type === 'text_delta') {
              streamedThisMessage = true;
              emitText(text(delta.text));
            }
            if (delta.type === 'thinking_delta' && text(delta.thinking)) {
              hadAssistantOutput = true;
              thoughtThisMessage = true;
              ctx.emit({ at: new Date().toISOString(), type: 'reasoning', text: text(delta.thinking) });
            }
          } else if (packet.type === 'assistant') {
            // Context occupancy is per root message; result.usage is the turn's billed sum.
            const message = object(packet.message);
            const usage = object(message.usage);
            const messageId = text(message.id);
            if (
              packet.isReplay !== true &&
              !packet.parent_tool_use_id &&
              message.model !== '<synthetic>' &&
              typeof usage.input_tokens === 'number' &&
              (!messageId || messageId !== lastContextMessageId)
            ) {
              lastContextMessageId = messageId || undefined;
              lastContextUsage = {
                usage: {
                  input_tokens: usage.input_tokens,
                  cache_read_input_tokens: usage.cache_read_input_tokens,
                  cache_creation_input_tokens: usage.cache_creation_input_tokens,
                },
                ...(/^[\w-]{1,200}$/.test(messageId) ? { messageId } : {}),
                model: text(message.model),
              };
              emitContext(reportedContextWindows.get(lastContextUsage.model));
            }
            const content = message.content;
            if (Array.isArray(content))
              for (const item of content) {
                const block = object(item);
                if (block.type === 'text' && !streamedThisMessage) {
                  textItem++;
                  emitText(text(block.text));
                }
                if (block.type === 'thinking' && !thoughtThisMessage && text(block.thinking)) {
                  hadAssistantOutput = true;
                  ctx.emit({ at: new Date().toISOString(), type: 'reasoning', text: text(block.thinking) });
                }
                if (block.type === 'tool_use' && packet.isReplay !== true) {
                  const id = text(block.id),
                    name = text(block.name);
                  if (
                    id &&
                    id.length <= 512 &&
                    name &&
                    name.length <= 256 &&
                    !toolCalls.has(id) &&
                    toolCalls.size < 4096
                  ) {
                    if (name === 'TodoWrite')
                      ctx.emit({
                        at: new Date().toISOString(),
                        type: 'status',
                        data: { taskList: object(block.input).todos },
                      });
                    toolCalls.set(id, { name, background: object(block.input).run_in_background === true });
                    emitTool(id, name, 'inProgress', false, toolEventDetails({ input: block.input }));
                  } else emitTool('', name.slice(0, 256), 'unknown');
                }
              }
            streamedThisMessage = false;
            thoughtThisMessage = false;
          } else if (packet.type === 'user' && packet.isReplay !== true) {
            const content = object(packet.message).content;
            const results = Array.isArray(content)
              ? content.map(object).filter((block) => block.type === 'tool_result')
              : [];
            for (const block of results) {
              const id = text(block.tool_use_id),
                call = toolCalls.get(id);
              if (!call) {
                emitTool(id, '', 'unknown', false, {
                  ...toolEventDetails({ output: block.content }),
                  startUnknown: true,
                  resultObserved: true,
                });
                continue;
              }
              if (block.is_error !== undefined && typeof block.is_error !== 'boolean') {
                emitTool(id, call.name, 'unknown', false, {
                  ...toolEventDetails({ output: block.content }),
                  resultObserved: true,
                  malformedErrorFlag: true,
                });
                continue;
              }
              // Only the explicit tool result is admitted; protocol envelopes and reasoning are excluded.
              const details = results.length === 1 ? object(packet.tool_use_result) : {};
              const failed = block.is_error === true || details.interrupted === true;
              // A Bash result may merely acknowledge backgrounding. Its generated CLI output schema
              // guarantees interrupted for foreground results; missing/ambiguous metadata stays unsettled.
              const foreground =
                call.name !== 'Bash' ||
                (details.interrupted === false &&
                  details.backgroundTaskId === undefined &&
                  (details.backgroundedByUser === undefined || details.backgroundedByUser === false) &&
                  details.timedOutAfterMs === undefined);
              const settledTool = !call.background && !['Agent', 'Task'].includes(call.name) && foreground;
              emitTool(
                id,
                call.name,
                failed ? 'failed' : settledTool ? 'completed' : 'inProgress',
                failed,
                toolEventDetails({ output: block.content, exitCode: details.exitCode }),
              );
            }
          } else if (packet.type === 'rate_limit_event') {
            const info = object(packet.rate_limit_info);
            // Event utilization uses a different, not yet normalized contract. Never call it percent remaining.
            ctx.emit({
              at: new Date().toISOString(),
              type: 'quota',
              data: { source: 'Claude runtime event', status: text(info.status), window: text(info.rateLimitType) },
            });
          } else if (packet.type === 'result') {
            resultCorrelated =
              answers(currentUserId) && typeof packet.session_id === 'string' && packet.session_id === nativeSessionId;
            if (reused && !resultCorrelated) {
              fail(new Error('native-session-reply-identity-unverified'));
              return;
            }
            // Claude Code reports resuming an unknown session as an empty error result, often before it answers
            // initialize; the process close that follows must not hide it.
            if (
              ctx.nativeSessionId &&
              emptyTurn(packet) &&
              (Array.isArray(packet.errors) ? packet.errors : []).some(
                (error) => typeof error === 'string' && error.startsWith(missingConversationPrefix),
              )
            ) {
              missingResult = true;
              channel.missingConversation = true;
            }
            receivedResult = true;
            if (ctx.nativeSessionId && !transition && emptyTurn(packet)) {
              fail(new Error('native-session-unavailable'));
              return;
            }
            for (const value of Array.isArray(packet.permission_denials) ? packet.permission_denials : []) {
              const denial = object(value),
                id = text(denial.tool_use_id);
              if (id && reportedDenials.has(id)) continue;
              if (id) reportedDenials.add(id);
              ctx.emit({
                at: new Date().toISOString(),
                type: 'status',
                text: permissionReason(
                  `Claude ${text(denial.tool_name) || '工具'} 被原生权限策略拒绝，CLI 未提供具体理由。`,
                ),
                data: {
                  decision: 'deny',
                  source: 'Claude native result.permission_denials',
                  nativeMethod: 'result/permission_denials',
                  ...(id ? { toolCallId: safeToolEventText(id, 512) } : {}),
                  ...(text(denial.tool_name) ? { nativeTool: safeToolEventText(text(denial.tool_name), 256) } : {}),
                },
              });
            }
            if ((answers(currentUserId) || (!hasSteered && !transition)) && output.length === turnOutputStart)
              emitText(text(packet.result));
            // The CLI reports each model's real context window only in the result (Claude 5 models run 1M).
            const reported = lastContextUsage && claudeContextWindow(packet, lastContextUsage.model);
            if (reported && lastContextUsage) {
              const known = reportedContextWindows.get(lastContextUsage.model);
              reportedContextWindows.set(lastContextUsage.model, reported);
              if (known !== reported) emitContext(reported);
            }
            for (const data of claudeResultUsage(
              packet,
              nativeSessionId,
              !ctx.nativeSessionId,
              text(packet.uuid) || currentUserId,
            ))
              ctx.emit({ at: new Date().toISOString(), type: 'usage', data });
            if (transition && currentUserId === transition.originalUserId && answers(transition.originalUserId)) {
              turnActive = false;
              transition.result = packet;
              transition.interrupted.resolve();
            } else if ((hasSteered || transition) && !answers(currentUserId)) {
              // Other queued native work must not finish the host's continuation.
              if (!text(packet.user_message_uuid) && !Array.isArray(packet.user_message_uuids))
                fail(new Error('runtime-steering-result-identity-missing'));
            } else {
              transition?.accepted?.resolve();
              completeResult(packet);
            }
          } else if (packet.type === 'system') {
            auditNativeProtocolMetadata(ctx, packet, true);
          } else if (!['assistant', 'user', 'stream_event'].includes(text(packet.type))) {
            auditNativeProtocolMetadata(ctx, packet);
          }
        };
        try {
          if (ctx.signal.aborted) abort();
          if (!reused) await channel.request({ subtype: 'initialize' });
          if (ctx.signal.aborted) throw new Error('Run cancelled.');
          channel.write({
            type: 'user',
            uuid: currentUserId,
            ...(reused ? { session_id: ctx.nativeSessionId } : {}),
            message: { role: 'user', content },
            parent_tool_use_id: null,
          });
          await completed;
          if (
            reusable &&
            replayConfirmed &&
            resultCorrelated &&
            observedNoTools &&
            observedModel &&
            nativeSessionId &&
            activeHooks.size === 0 &&
            !ctx.signal.aborted &&
            channel.isIdleReady()
          )
            offered = new IdleClaudeSession(
              reuseKey!,
              nativeSessionId,
              observedModel,
              currentUserId,
              channel,
              deps,
              () =>
                ctx.emit({
                  at: new Date().toISOString(),
                  type: 'status',
                  data: { source: 'pugport', kind: 'native-session-idle-discard', reason: 'unexpected-packet' },
                }),
            );
          return { nativeSessionId, output, ...(offered ? { idleNativeSession: offered } : {}) };
        } catch (error) {
          if (
            ctx.nativeSessionId &&
            !hadAssistantOutput &&
            !output &&
            (!receivedResult || missingResult) &&
            channel.missingConversation &&
            !ctx.signal.aborted
          ) {
            if ((error as { startup?: unknown }).startup)
              throw runtimeError(error, {
                code: 'native-session-unavailable',
                paths: [ctx.dataDir, ctx.target.agentDir],
                prompt: ctx.input.prompt,
              });
            throw new Error('native-session-unavailable');
          }
          throw error;
        } finally {
          clearTimeout(holdTimer);
          settled = true;
          ctx.endTools?.();
          ctx.registerSteer?.(undefined, { state: 'finishing' });
          transition?.interrupted.reject(new Error('runtime-steering-unavailable'));
          transition?.accepted?.reject(new Error('runtime-steering-unavailable'));
          ctx.signal.removeEventListener('abort', abort);
          if (offered) detachProcessAudit();
          else await channel.stop(deps);
        }
      } finally {
        ctx.endTools?.();
        ctx.registerSteer?.(undefined, { state: 'finishing' });
        if (mcpConfigPath) await rm(mcpConfigPath, { force: true }).catch(() => {});
      }
    },
  };
}

export const claudeAdapter = createClaudeAdapter();
