import { codexFullAccess } from './device-access.ts';
import { CodexOutput, codexItemLimit } from './codex-output.ts';
import { approvalKey } from '../approval-rules.ts';
import { runOutputLimit, runOutputTail } from '../../shared/run-output.ts';
import { createHash } from 'node:crypto';
import { mxcRuntime } from '../sandbox/mxc-runtime.ts';
import { executionEnvironment } from '../sandbox/run-temp.ts';
import type { SandboxStatus } from '../../shared/sandbox.ts';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  nativeAccountFingerprint,
  defaultNativeAccountFingerprint,
  nativeAccountEnvironment,
  withoutOpenAiKeys,
} from '../native-accounts.ts';
import { maxImagesPerRun, stageCodexImageItem, stageCodexSavedImages } from '../image-generation.ts';
import type { GeneratedImage } from '../../shared/image-generation.ts';
import { codexResetCredits, resetCreditKey } from '../reset-credits.ts';
import { subscriptionPlan } from '../subscription-plan.ts';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { APP_NAME, APP_VERSION } from '../../shared/identity.ts';
import type {
  Adapter,
  ApprovalKey,
  ExecuteContext,
  ExecuteResult,
  ModelInfo,
  QuotaWindow,
  RuntimeSnapshot,
  RuntimeTarget,
} from '../../shared/types.js';
import { StartupTail, redactError, runtimeError, spawnTarget, targetPath, terminateProcess } from './process.js';
import { auditNativeProcess } from './execution-audit.ts';
import { discoverNativeInHelper } from '../native-discovery-client.ts';
import { toolEventDetails, safeToolEventText } from '../../shared/tool-event-data.ts';
import { redactToolDiagnostic } from '../tool-diagnostics.ts';
import { markNotSent } from '../auto-reset-cards.ts';

type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {};
const string = (value: unknown): string => (typeof value === 'string' ? value : '');
const now = () => new Date().toISOString();

/** Public configuration fields only. An RPC echo is evidence only for the fields it actually includes. */
export function codexPermissionConfig(value: unknown): JsonObject {
  const config = object(value);
  const detail: JsonObject = {};
  for (const field of ['cwd', 'approvalPolicy', 'approvalsReviewer', 'sandbox'])
    if (typeof config[field] === 'string') detail[field] = safeToolEventText(string(config[field]));
  const policyField = config.sandboxPolicy !== undefined ? 'sandboxPolicy' : 'sandbox';
  const policy = object(config[policyField]);
  const sandboxPolicy: JsonObject = {};
  if (typeof policy.type === 'string') sandboxPolicy.type = safeToolEventText(string(policy.type), 256);
  for (const field of ['networkAccess', 'excludeTmpdirEnvVar', 'excludeSlashTmp'])
    if (typeof policy[field] === 'boolean') sandboxPolicy[field] = policy[field];
  if (Array.isArray(policy.writableRoots))
    sandboxPolicy.writableRoots = policy.writableRoots
      .filter((root): root is string => typeof root === 'string')
      .map((root) => safeToolEventText(root));
  if (Object.keys(sandboxPolicy).length) detail[policyField] = sandboxPolicy;
  return detail;
}

/** Explicit public tool fields from the app-server ThreadItem schema, never the whole item. */
export function codexToolEventDetails(item: JsonObject): JsonObject {
  const type = string(item.type);
  let input = item.arguments ?? item.input;
  let output = item.aggregatedOutput ?? item.result;
  if (type === 'fileChange' && Array.isArray(item.changes)) input = { changes: item.changes };
  if (type === 'commandExecution') input = { command: item.command, cwd: item.cwd };
  if (type === 'dynamicToolCall') {
    const contentItems = Array.isArray(item.contentItems)
      ? item.contentItems.map((value) => {
          const content = object(value);
          return content.type === 'inputText'
            ? { type: 'inputText', text: content.text }
            : { type: string(content.type), omitted: 'Non-text tool content' };
        })
      : item.contentItems;
    if (item.contentItems !== undefined || typeof item.success === 'boolean')
      output = {
        ...(contentItems !== undefined ? { contentItems } : {}),
        ...(typeof item.success === 'boolean' ? { success: item.success } : {}),
      };
  }
  if (type === 'webSearch') {
    input = { query: item.query, action: item.action };
    if (item.results !== undefined) output = item.results;
  }
  if (type === 'collabAgentToolCall') {
    input = { prompt: item.prompt, receiverThreadIds: item.receiverThreadIds };
    if (item.agentsStates !== undefined)
      output = Object.fromEntries(
        Object.entries(object(item.agentsStates)).map(([id, value]) => {
          const state = object(value);
          return [id, { status: state.status, message: state.message }];
        }),
      );
  }
  if (type === 'functionCallOutput') output = item.output;
  // The image bytes (result) are staged by the adapter, never copied into the event log.
  if (type === 'imageGeneration') {
    input = item.revisedPrompt == null ? undefined : { revisedPrompt: item.revisedPrompt };
    output = { status: item.status, image: string(item.result) ? 'inline image staged by PugPort' : 'no inline image' };
  }
  const errorMessage = string(object(item.error).message);
  return {
    ...toolEventDetails({ input, output }),
    ...(item.error ? { failureDetail: codexFailure(item.error) } : {}),
    // Only the message is exposed as sanitized text; failureDetail remains a code.
    ...(typeof object(item.error).message === 'string'
      ? { failureMessage: safeToolEventText(string(object(item.error).message), 500) }
      : {}),
    ...(type === 'fileChange' && errorMessage ? { failureText: redactToolDiagnostic(errorMessage, 1500) } : {}),
    ...(item.success === false ? { isError: true } : {}),
    ...(typeof item.durationMs === 'number' && Number.isFinite(item.durationMs) ? { durationMs: item.durationMs } : {}),
    ...(input === undefined && output === undefined
      ? { captureState: 'metadata-only', observedFields: Object.keys(item).map((key) => safeToolEventText(key, 256)) }
      : {}),
  };
}

export function codexCommandOutputDelta(
  params: JsonObject,
  method: 'item/commandExecution/outputDelta' | 'item/fileChange/outputDelta' = 'item/commandExecution/outputDelta',
): JsonObject {
  return {
    itemId: safeToolEventText(string(params.itemId), 512),
    source: 'native',
    kind: method === 'item/fileChange/outputDelta' ? 'fileChange' : 'commandExecution',
    nativeMethod: method,
    observedPhase: 'output',
    outputMode: 'delta',
    ...toolEventDetails({ output: params.delta }),
  };
}

export function codexMcpToolProgress(params: JsonObject): JsonObject {
  return {
    itemId: safeToolEventText(string(params.itemId), 512),
    source: 'native',
    kind: 'mcpToolCall',
    nativeMethod: 'item/mcpToolCall/progress',
    observedPhase: 'output',
    outputMode: 'progress',
    ...toolEventDetails({ output: params.message }),
  };
}

/** Metadata observation is distinct from interpreting a native payload as tool input/output. */
export function codexProtocolObservation(method: string, params: JsonObject): JsonObject {
  const result: JsonObject = {
    method: safeToolEventText(method, 256),
    keys: Object.keys(params)
      .slice(0, 64)
      .map((key) => safeToolEventText(key, 256)),
  };
  for (const field of ['threadId', 'turnId', 'itemId'])
    if (typeof params[field] === 'string') result[field] = safeToolEventText(string(params[field]), 512);
  if (method === 'turn/started' || method === 'turn/completed') {
    const turn = object(params.turn);
    if (string(turn.id)) result.turnId = safeToolEventText(string(turn.id), 512);
    if (string(turn.status)) result.status = safeToolEventText(string(turn.status), 256);
  }
  return result;
}
const abortError = () => Object.assign(new Error('operation-cancelled'), { name: 'AbortError' });
const cleanDisplay = (value: string) =>
  value
    .replace(/\b(?:sk|pk)-[\w-]{12,}/g, '[redacted]')
    .replace(/(bearer\s+)[\w.+/=-]+/gi, '$1[redacted]')
    .replace(/((?:api[_-]?key|token|password|secret)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]')
    .slice(0, 12_000);

type Dependencies = {
  spawn: typeof spawnTarget;
  targetPath: typeof targetPath;
  terminate: typeof terminateProcess;
  sandboxStatus: () => Promise<SandboxStatus>;
};
const defaults: Dependencies = {
  spawn: spawnTarget,
  targetPath,
  terminate: terminateProcess,
  sandboxStatus: mxcRuntime.probe,
};

export function codexWindowsSandbox(status?: SandboxStatus): 'mxc' | 'elevated' {
  return status?.available && status.tier === 'base-container' && status.denyPathsSupported === true
    ? 'mxc'
    : 'elevated';
}

/** Process-local sandbox configuration also applies to isolated account homes. */
export function codexAppServerArgs(
  target: RuntimeTarget,
  platform: NodeJS.Platform = process.platform,
  agentBridge?: { url: string; askTools?: string[] },
  sandboxStatus?: SandboxStatus,
  prohibitCommands = false,
): string[] {
  return [
    'app-server',
    '--stdio',
    // A disabled transport is valid even when the user has never connected pugport-app.
    '-c',
    "mcp_servers.pugport-app={enabled=false,command='pugport-app'}",
    ...(prohibitCommands
      ? ['-c', 'features.shell_tool=false', '-c', 'features.unified_exec=false', '-c', 'features.hooks=false']
      : []),
    // Use Codex's default Windows sandbox, not the legacy non-admin restricted token.
    // Do not omit this: an isolated CODEX_HOME may have no sandbox backend configured.
    // Missing native sandbox setup must fail closed; never retry unsandboxed.
    ...(platform === 'win32' && target.environment === 'native'
      ? ['-c', `windows.sandbox='${codexWindowsSandbox(sandboxStatus)}'`]
      : []),
    // Values that are not valid TOML are read as plain strings, so the URL needs no quoting through cmd.exe.
    ...(agentBridge
      ? [
          '-c',
          `mcp_servers.pugport.url=${agentBridge.url}`,
          '-c',
          `mcp_servers.pugport.bearer_token_env_var=${agentBridgeTokenVariable}`,
          '-c',
          'mcp_servers.pugport.tool_timeout_sec=660',
          // The bridge gates writes by caller, with owner confirmation for risky GitHub writes and every connector write.
          '-c',
          'mcp_servers.pugport.default_tools_approval_mode=approve',
          // Extensions keep Codex's approval rule in ask mode, as with Claude.
          // cmd.exe limits command lines to 8191 characters, reached at about 70 per-tool overrides.
          ...(agentBridge.askTools ?? []).flatMap((name) => [
            '-c',
            `mcp_servers.pugport.tools.${name}.approval_mode=auto`,
          ]),
        ]
      : []),
  ];
}

/** Environment variable that carries a run's agent bridge token to its executor. */
export const agentBridgeTokenVariable = 'COMBORUNNER_AGENT_TOKEN';

/**
 * Keep Windows process-launch variables intact; redirect temporary files, add the run's bridge token, and drop OpenAI
 * key variables so the run (and its image tool) stays on the subscription instead of paid API billing.
 */
export function codexExecutionEnvironment(
  source: NodeJS.ProcessEnv,
  temporary?: string,
  bridgeToken?: string,
): NodeJS.ProcessEnv {
  return withoutOpenAiKeys(executionEnvironment(source, temporary, bridgeToken));
}

/** Interpret Codex's typed error before its human-readable diagnostic. Never expose the original body. */
export function codexFailure(value: unknown): string {
  const error = object(value),
    data = object(error.data);
  if (error.code === -32601) return 'runtime-protocol-incompatible';
  // Official app-server schema uses camelCase unit variants and externally tagged
  // HTTP variants: https://learn.chatgpt.com/docs/app-server#errors .
  const info = error.codexErrorInfo ?? data.codexErrorInfo;
  if (info === 'usageLimitExceeded' || info === 'rateLimitExceeded') return 'quota-or-rate-limit';
  if (info === 'unauthorized') return 'authentication-required';
  if (info === 'sandboxError') return 'runtime-permission-or-sandbox-error';
  if (info !== null && info !== undefined) {
    const variants = object(info);
    for (const variant of [
      'httpConnectionFailed',
      'responseStreamConnectionFailed',
      'responseStreamDisconnected',
      'responseTooManyFailedAttempts',
    ]) {
      if (!Object.hasOwn(variants, variant)) continue;
      const status = object(variants[variant]).httpStatusCode;
      if (status === 429) return 'quota-or-rate-limit';
      if (status === 401) return 'authentication-required';
      return status === null || status === undefined ? 'runtime-network-error' : 'runtime-request-failed';
    }
    // Context/session budgets, provider overload, policy blocks and generic failures
    // are not evidence that another subscription account is appropriate.
    return 'runtime-request-failed';
  }
  const message = string(error.message).slice(0, 2048);
  const classified = redactError(message);
  if (classified === 'quota-or-rate-limit')
    return /\b(?:rate[ -]?limit(?:ed| exceeded| reached)|usage[ -]?limit (?:exceeded|reached)|quota (?:exceeded|exhausted)|exceeded (?:your |the )?(?:current )?quota)\b/i.test(
      message,
    )
      ? classified
      : 'runtime-request-failed';
  if (classified === 'authentication-required')
    return /\b(?:unauthori[sz]ed|authentication required|not authenticated|not logged in|login required)\b/i.test(
      message,
    )
      ? classified
      : 'runtime-request-failed';
  return classified;
}

class CodexRpc {
  private sequence = 0;
  private pending = new Map<
    number,
    { resolve(value: JsonObject): void; reject(error: Error): void; timer: NodeJS.Timeout }
  >();
  private listeners = new Set<(method: string, params: JsonObject) => void>();
  private buffer = '';
  private decoder = new StringDecoder('utf8');
  private ended = false;
  private terminalError?: Error;
  readonly failure: Promise<never>;
  private rejectFailure!: (error: Error) => void;
  onRequest?: (method: string, params: JsonObject) => Promise<unknown>;

  readonly startup = new StartupTail();
  private invalidStartupLine = false;
  constructor(
    readonly child: ChildProcessWithoutNullStreams,
    private readonly terminate: typeof terminateProcess = terminateProcess,
    private readonly errorOptions: Parameters<typeof runtimeError>[1] = {},
  ) {
    this.failure = new Promise<never>((_, reject) => {
      this.rejectFailure = reject;
    });
    void this.failure.catch(() => {});
    child.stdout.on('data', (chunk: Buffer) => {
      this.startup.write('stdout', chunk);
      this.buffer += this.decoder.write(chunk);
      if (this.buffer.length > 16_777_216) {
        this.fail(new Error('runtime-protocol-frame-too-large'));
        return;
      }
      let newline: number;
      while ((newline = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, newline).replace(/\r$/, '');
        this.buffer = this.buffer.slice(newline + 1);
        if (line) this.receive(line);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => this.startup.write('stderr', chunk));
    child.on('error', (error) => this.fail(new Error(redactError(error))));
    child.stdin.on('error', () => {
      if (!this.startup.active) this.fail(new Error('runtime-process-closed'));
    });
    child.once('close', (code) =>
      this.fail(
        this.startup.active
          ? this.startup.failure('Codex', code ?? null, this.errorOptions)
          : new Error('runtime-process-closed'),
      ),
    );
  }

  private fail(error: Error): void {
    if (this.ended) return;
    this.ended = true;
    this.terminalError = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.rejectFailure(error);
  }

  private receive(line: string): void {
    let message: JsonObject;
    try {
      message = object(JSON.parse(line));
    } catch {
      if (this.startup.active) {
        this.invalidStartupLine = true;
        return;
      }
      this.fail(new Error('runtime-protocol-invalid-json'));
      return;
    }
    const method = string(message.method);
    if (method) {
      const params = object(message.params);
      if (typeof message.id === 'number' || typeof message.id === 'string') {
        const id = message.id;
        const handler = this.onRequest;
        void (handler ? handler(method, params) : Promise.reject(new Error('unsupported-server-request')))
          .then((result) => this.send({ id, result }))
          .catch(() => this.send({ id, error: { code: -32601, message: 'Client cannot handle this request.' } }));
      } else for (const listener of this.listeners) listener(method, params);
      return;
    }
    if (typeof message.id !== 'number') return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      const error = object(message.error);
      pending.reject(
        Object.assign(
          runtimeError(string(error.message), { ...this.errorOptions, provider: 'Codex', code: codexFailure(error) }),
          { rpcRejected: true },
        ),
      );
    } else pending.resolve(object(message.result));
  }

  private send(message: unknown): void {
    if (!this.ended && !this.child.stdin.destroyed) this.child.stdin.write(JSON.stringify(message) + '\n');
  }

  request(method: string, params?: JsonObject, timeoutMs = 20_000): Promise<JsonObject> {
    if (this.ended) return Promise.reject(this.terminalError ?? new Error('runtime-process-closed'));
    const id = ++this.sequence;
    return new Promise((resolveResult, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            this.invalidStartupLine && this.startup.active ? 'runtime-protocol-invalid-json' : 'runtime-timeout',
          ),
        );
      }, timeoutMs);
      this.pending.set(id, { resolve: resolveResult, reject, timer });
      this.send({ id, method, ...(params ? { params } : {}) });
    });
  }

  subscribe(listener: (method: string, params: JsonObject) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async initialize(): Promise<void> {
    await this.request('initialize', { clientInfo: { name: 'pugport', title: APP_NAME, version: APP_VERSION } });
    this.send({ method: 'initialized' });
  }

  async close(): Promise<void> {
    await this.terminate(this.child);
    this.fail(new Error('runtime-process-closed'));
  }
}

export function parseCodexQuota(value: unknown): RuntimeSnapshot['quota'] {
  const result = object(value);
  const bucketMap = object(result.rateLimitsByLimitId);
  const legacy = object(result.rateLimits);
  const buckets = Object.keys(bucketMap).length
    ? bucketMap
    : Object.keys(legacy).length
      ? { [string(legacy.limitId) || 'codex']: legacy }
      : {};
  const windows: QuotaWindow[] = [];
  for (const [id, raw] of Object.entries(buckets)) {
    const bucket = object(raw);
    for (const slot of ['primary', 'secondary'] as const) {
      const window = object(bucket[slot]);
      if (!Object.keys(window).length) continue;
      const duration = typeof window.windowDurationMins === 'number' ? window.windowDurationMins : null;
      const seconds = typeof window.resetsAt === 'number' ? window.resetsAt : NaN;
      const date = new Date(seconds * 1000);
      const used =
        typeof window.usedPercent === 'number' && Number.isFinite(window.usedPercent)
          ? Math.min(100, Math.max(0, window.usedPercent))
          : null;
      windows.push({
        id: `${id}:${slot}`,
        label: `${string(bucket.limitName) || id} · ${duration ? `${duration} min` : slot}`,
        usedPercent: used,
        resetsAt: Number.isFinite(date.getTime()) ? date.toISOString() : null,
        durationMinutes: duration,
      });
    }
  }
  return {
    status: windows.some((window) => window.usedPercent !== null) ? 'known' : 'unknown',
    source: 'Codex app-server account/rateLimits/read',
    observedAt: now(),
    windows,
    resetCredits: codexResetCredits(value),
    ...(!windows.length ? { note: 'CLI 没有提供订阅额度窗口。' } : {}),
  };
}

function numericUsage(value: unknown): JsonObject {
  const usage = object(value);
  const result: JsonObject = {};
  for (const key of ['total', 'last']) {
    const source = object(usage[key]);
    const numbers: JsonObject = {};
    for (const field of ['totalTokens', 'inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens']) {
      if (typeof source[field] === 'number') numbers[field] = source[field];
    }
    if (Object.keys(numbers).length) result[key] = numbers;
  }
  if (typeof usage.modelContextWindow === 'number') result.modelContextWindow = usage.modelContextWindow;
  return result;
}

async function approveWithAbort(
  ctx: ExecuteContext,
  tool: string,
  description: string,
  key?: ApprovalKey,
): Promise<boolean> {
  if (ctx.signal.aborted) return false;
  let onAbort: (() => void) | undefined;
  const cancelled = new Promise<boolean>((resolveApproval) => {
    onAbort = () => resolveApproval(false);
    ctx.signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([ctx.approve(tool, description, key), cancelled]);
  } finally {
    if (onAbort) ctx.signal.removeEventListener('abort', onAbort);
  }
}

async function discover(target: RuntimeTarget, deps: Dependencies): Promise<RuntimeSnapshot> {
  const snapshot: RuntimeSnapshot = {
    id: target.id,
    provider: 'codex',
    label: target.label,
    environment: target.environment,
    installed: false,
    status: 'missing',
    models: [],
    authMode: 'unknown',
    refreshedAt: now(),
    capabilities: { execute: true, resume: true, cancel: true, approvals: true, steer: true },
    quota: { status: 'unknown', source: 'Codex app-server account/rateLimits/read', observedAt: null, windows: [] },
  };
  let rpc: CodexRpc | undefined;
  try {
    rpc = new CodexRpc(await deps.spawn(target, codexAppServerArgs(target)), deps.terminate, {
      paths: [target.agentDir],
    });
    snapshot.installed = true;
    await rpc.initialize();
    snapshot.status = 'ready';
    const errors: string[] = [];
    const channel = rpc;
    // Account metadata and the paginated model catalog are independent read-only
    // RPCs. Start both now, rather than serializing provider round trips.
    const accountRead = channel.request('account/read', { refreshToken: false });
    const catalogRead = (async () => {
      const models: ModelInfo[] = [];
      let defaultModel: string | undefined;
      let cursor: string | undefined;
      for (let page = 0; page < 20; page++) {
        const result = await channel.request('model/list', {
          limit: 100,
          includeHidden: false,
          ...(cursor ? { cursor } : {}),
        });
        for (const entry of Array.isArray(result.data) ? result.data : []) {
          const model = object(entry);
          const id = string(model.model) || string(model.id);
          if (!id || models.some((item) => item.id === id)) continue;
          if (model.isDefault === true) defaultModel = id;
          const efforts = (Array.isArray(model.supportedReasoningEfforts) ? model.supportedReasoningEfforts : [])
            .map((item) => (typeof item === 'string' ? item : string(object(item).reasoningEffort)))
            .filter(Boolean);
          models.push({
            id,
            label: string(model.displayName) || id,
            efforts,
            defaultEffort: string(model.defaultReasoningEffort) || undefined,
            lightweight: /luna|mini|nano/i.test(id),
          });
        }
        cursor = string(result.nextCursor) || undefined;
        if (!cursor) break;
      }
      return { models, defaultModel, limited: !!cursor };
    })();
    // Observe catalog failures immediately while account mode is being read.
    const catalog = catalogRead.then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error }),
    );
    try {
      const result = await accountRead;
      const type = object(result.account).type;
      if (type === 'chatgpt')
        snapshot.subscription = subscriptionPlan(object(result.account).planType, 'Codex CLI account/read');
      if (type === 'chatgpt' || type === 'apiKey') snapshot.authMode = type;
      if (type === 'apiKey')
        snapshot.accounting = {
          mode: 'usage',
          source: 'Codex app-server account/read',
          note: 'API consumption is recorded per run; it is not a subscription balance.',
        };
      if (result.account === null && result.requiresOpenaiAuth === true) snapshot.status = 'auth-required';
    } catch (error) {
      const reason = redactError(error);
      errors.push(`Account mode: ${reason}`);
      if (reason === 'authentication-required') snapshot.status = 'auth-required';
    }
    try {
      if (snapshot.authMode !== 'apiKey')
        snapshot.quota = parseCodexQuota(await rpc.request('account/rateLimits/read'));
      else
        snapshot.quota = {
          ...snapshot.quota,
          note: 'API key 登录不提供 ChatGPT 订阅额度。',
        };
    } catch (error) {
      const reason = redactError(error);
      snapshot.quota = { ...snapshot.quota, status: 'unknown', note: reason };
      if (reason === 'authentication-required') snapshot.status = 'auth-required';
    }
    const catalogResult = await catalog;
    if (catalogResult.value) {
      snapshot.models = catalogResult.value.models;
      snapshot.defaultModel = catalogResult.value.defaultModel;
      if (catalogResult.value.limited) errors.push('Model catalog pagination limit reached.');
    } else {
      const reason = redactError(catalogResult.error);
      errors.push(`Model catalog: ${reason}`);
      if (reason === 'authentication-required') snapshot.status = 'auth-required';
      else if (snapshot.status !== 'auth-required') snapshot.status = 'error';
    }
    if (errors.length) snapshot.note = errors.join(' ');
  } catch (error) {
    const reason = redactError(error);
    snapshot.status =
      reason === 'runtime-not-found' ? 'missing' : reason === 'authentication-required' ? 'auth-required' : 'error';
    snapshot.note = reason;
  } finally {
    await rpc?.close();
  }
  snapshot.refreshedAt = now();
  return snapshot;
}

async function execute(ctx: ExecuteContext, deps: Dependencies): Promise<ExecuteResult> {
  if (ctx.signal.aborted) throw abortError();
  // Give compilers/test runners their own writable temp root, not the shared system temp directory.
  const temporaryRoot = ctx.input.permissionMode === 'workspace-write' ? await realpath(tmpdir()) : undefined;
  const temporary = temporaryRoot ? await mkdtemp(join(temporaryRoot, 'pugport-codex-')) : undefined;
  try {
    return await executeTurn(ctx, deps, temporary);
  } finally {
    // Remove only the directory we allocated. Node's rm unlinks junctions instead of traversing their targets.
    if (temporary && dirname(temporary) === temporaryRoot)
      await rm(temporary, { recursive: true, force: true }).catch(() => {});
  }
}

async function executeTurn(ctx: ExecuteContext, deps: Dependencies, temporary?: string): Promise<ExecuteResult> {
  if (ctx.signal.aborted) throw abortError();
  const cwd = await deps.targetPath(ctx.target, ctx.input.projectPath);
  const sandboxStatus =
    process.platform === 'win32' && ctx.target.environment === 'native' ? await deps.sandboxStatus() : undefined;
  const windowsSandbox = sandboxStatus ? codexWindowsSandbox(sandboxStatus) : undefined;
  const automatic = ctx.approvalMode === 'auto';
  const args = codexAppServerArgs(
    ctx.target,
    process.platform,
    ctx.agentBridge && {
      ...ctx.agentBridge,
      askTools: automatic ? undefined : ctx.agentBridge.askTools,
    },
    sandboxStatus,
    ctx.input.prohibitCommands === true,
  );
  if (ctx.input.factCheck) args.push('-c', 'project_doc_max_bytes=0', '-c', 'features.memory_tool=false');
  // The built-in image tool is stable and on by default; say so explicitly for an image request.
  if (ctx.input.imageGeneration) args.push('-c', 'features.image_generation=true');
  const imageRunStarted = Date.now();
  const imageStaging: Array<Promise<Awaited<ReturnType<typeof stageCodexImageItem>>>> = [];
  const child = await deps.spawn(ctx.target, args, {
    cwd,
    env: codexExecutionEnvironment(process.env, temporary, ctx.agentBridge?.token),
  });
  auditNativeProcess(ctx, child, args, 'codex-app-server');
  const rpc = new CodexRpc(child, deps.terminate, {
    paths: [ctx.dataDir, ctx.target.agentDir],
    secrets: [ctx.agentBridge?.token],
    prompt: ctx.input.prompt,
  });
  const approvalPolicy = automatic ? 'never' : 'on-request';
  const trustedWrite = codexFullAccess(ctx);
  let threadId = ctx.nativeSessionId ?? '';
  let turnId = '';
  let turnRequested = false;
  let turnSettled = false;
  let quotaEventEmitMs: number | undefined;
  let lastTerminalError: Error | undefined;
  const messages = new CodexOutput();
  const fileChangeNotes = new Map<string, string>();
  const operationDetails = new Map<string, { detail: string; key?: ApprovalKey }>();
  let finish!: (value: ExecuteResult) => void;
  let fail!: (error: Error) => void;
  const completion = new Promise<ExecuteResult>((resolveResult, reject) => {
    finish = resolveResult;
    fail = reject;
  });
  void completion.catch(() => {});
  const output = () => messages.output();
  let operationChars = 0;
  const forgetOperation = (id: string) => {
    const key = createHash('sha256').update(id).digest('hex');
    operationChars -= operationDetails.get(key)?.detail.length ?? 0;
    operationDetails.delete(key);
  };
  const rememberOperation = (id: string, text: string, key?: ApprovalKey) => {
    forgetOperation(id);
    // cleanDisplay can return a small substring backed by a very large raw diff.
    const detail = Buffer.from(runOutputTail(text), 'utf16le').toString('utf16le');
    operationDetails.set(createHash('sha256').update(id).digest('hex'), { detail, key });
    operationChars += detail.length;
    while (operationChars > runOutputLimit || operationDetails.size > codexItemLimit) {
      const key = operationDetails.keys().next().value!;
      operationChars -= operationDetails.get(key)!.detail.length;
      operationDetails.delete(key);
    }
  };
  const permissionConfig = (method: string, provenance: 'requested' | 'observed', value: unknown) => {
    const config = codexPermissionConfig(value);
    if (!Object.keys(config).length) return;
    ctx.emit({
      at: now(),
      type: 'status',
      text: provenance === 'requested' ? '已向 Codex 提交本次权限配置。' : 'Codex 已返回权限配置字段。',
      data: {
        source: 'native',
        kind: 'permission-config',
        detail: {
          executor: safeToolEventText(ctx.target.label, 256),
          provider: ctx.target.provider,
          runtimeId: safeToolEventText(ctx.target.id, 512),
          method,
          provenance,
          ...(provenance === 'requested' && windowsSandbox
            ? {
                windowsSandbox,
                sandboxStatus: sandboxStatus!.message,
              }
            : {}),
          ...config,
        },
      },
    });
  };
  const observeProtocol = (method: string, params: JsonObject, known = false) => {
    if (!turnRequested) return;
    ctx.emit({
      at: now(),
      type: 'status',
      text: known ? '收到原生 CLI 控制状态更新。' : '收到尚未识别的原生协议事件。',
      data: {
        source: 'native',
        kind: known ? 'protocol-observation' : 'protocol-unmapped',
        detail: {
          executor: safeToolEventText(ctx.target.label, 256),
          provider: ctx.target.provider,
          runtimeId: safeToolEventText(ctx.target.id, 512),
          ...codexProtocolObservation(method, params),
        },
      },
    });
  };
  let cancelPromise: Promise<void> | undefined;
  const cancel = () => {
    ctx.endTools?.();
    ctx.registerSteer?.(undefined, { state: 'finishing' });
    cancelPromise ??= (async () => {
      if (threadId && turnId) await rpc.request('turn/interrupt', { threadId, turnId }, 2000).catch(() => {});
      fail(abortError());
      await rpc.close();
    })();
    return cancelPromise;
  };
  const onAbort = () => {
    void cancel();
  };
  ctx.signal.addEventListener('abort', onAbort, { once: true });
  const unsubscribe = rpc.subscribe((method, params) => {
    if (method === 'account/rateLimits/updated') {
      ctx.emit({
        at: now(),
        type: 'quota',
        data: {
          quotaUpdate: 'sparse',
          quota: { ...parseCodexQuota(params), source: 'Codex app-server account/rateLimits/updated', note: undefined },
        },
      });
      return;
    }
    if (string(params.threadId) && string(params.threadId) !== threadId) return;
    if (method === 'turn/started') turnId ||= string(object(params.turn).id);
    if (turnId && string(params.turnId) && string(params.turnId) !== turnId) return;
    if (method === 'turn/started') {
      if (turnId && string(object(params.turn).id) !== turnId) return;
      observeProtocol(method, params, true);
    } else if (method === 'item/agentMessage/delta') {
      const itemId = string(params.itemId) || 'assistant';
      const delta = string(params.delta);
      if (delta && messages.delta(itemId, delta)) {
        ctx.emit({ at: now(), type: 'text', text: delta, data: { itemId } });
      }
    } else if (method === 'item/commandExecution/outputDelta' || method === 'item/fileChange/outputDelta') {
      if (method === 'item/fileChange/outputDelta') {
        const id = string(params.itemId);
        const delta = string(params.delta);
        if (id && delta) {
          const next = `${fileChangeNotes.get(id) ?? ''}${delta}`.slice(-8000);
          if (fileChangeNotes.size >= 64 && !fileChangeNotes.has(id))
            fileChangeNotes.delete(fileChangeNotes.keys().next().value!);
          fileChangeNotes.set(id, next);
        }
      }
      const data = codexCommandOutputDelta(params, method);
      ctx.emit({ at: now(), type: 'tool', text: `${data.kind}: output`, data });
    } else if (method === 'item/mcpToolCall/progress') {
      ctx.emit({ at: now(), type: 'tool', text: 'mcpToolCall: progress', data: codexMcpToolProgress(params) });
    } else if (method === 'item/started' || method === 'item/completed') {
      const item = object(params.item);
      const itemId = string(item.id) || 'assistant';
      const type = string(item.type);
      if (ctx.input.prohibitCommands === true && turnRequested && type === 'commandExecution') {
        fail(new Error('runtime-command-policy-violation'));
        void cancel();
        return;
      }
      if (method === 'item/completed') forgetOperation(itemId);
      if (
        method === 'item/completed' &&
        type === 'imageGeneration' &&
        ctx.input.imageGeneration &&
        imageStaging.length < maxImagesPerRun
      )
        imageStaging.push(stageCodexImageItem(item, ctx.input.imageGeneration.outputDir).catch(() => undefined));
      if (method === 'item/started' && type === 'fileChange' && Array.isArray(item.changes))
        rememberOperation(
          itemId,
          cleanDisplay(
            item.changes
              .map((value) => {
                const change = object(value);
                return `${string(change.path)}\n${string(change.diff)}`;
              })
              .join('\n\n'),
          ),
          approvalKey('Codex file change', item, ctx.input.projectPath),
        );
      if (method === 'item/started' && type === 'commandExecution')
        rememberOperation(itemId, cleanDisplay([string(item.command), string(item.cwd)].filter(Boolean).join('\n')));
      if (type === 'agentMessage' && method === 'item/completed') {
        const finalText = string(item.text);
        const delta = messages.complete(itemId, finalText);
        if (delta) ctx.emit({ at: now(), type: 'text', text: delta, data: { itemId } });
      } else if (!['agentMessage', 'reasoning', 'userMessage'].includes(type)) {
        ctx.emit({
          at: now(),
          type: 'tool',
          text: `${type}: ${method === 'item/started' ? 'started' : string(item.status) || 'completed'}`,
          // MCP calls carry the tool name, so the interface can say which local tool is working.
          data: {
            itemId,
            kind: type,
            // Some item types (sub-agents, dynamic tool calls) carry no status of their own. item/completed is
            // their terminal notice, so say so; otherwise progress tracking holds them as never finished.
            status: string(item.status) || (method === 'item/completed' ? 'completed' : 'inProgress'),
            ...(string(item.tool) ? { tool: string(item.tool) } : {}),
            ...(string(item.server) ? { server: string(item.server) } : {}),
            ...(typeof item.exitCode === 'number' ? { exitCode: item.exitCode } : {}),
            ...(item.error || object(item.result).isError === true ? { isError: true } : {}),
            ...(string(item.command) ? { command: safeToolEventText(string(item.command)) } : {}),
            ...(string(item.cwd) ? { cwd: safeToolEventText(string(item.cwd)) } : {}),
            ...(() => {
              const details = codexToolEventDetails(item);
              return {
                ...details,
                ...(type === 'fileChange' &&
                method === 'item/completed' &&
                string(item.status) === 'failed' &&
                fileChangeNotes.get(itemId) &&
                details.output === undefined
                  ? { output: redactToolDiagnostic(fileChangeNotes.get(itemId) ?? '', 1500) }
                  : {}),
              };
            })(),
          },
        });
      }
    } else if (method === 'thread/tokenUsage/updated') {
      const usage = numericUsage(params.tokenUsage);
      const baseline = !turnRequested && !!ctx.nativeSessionId;
      ctx.emit({
        at: now(),
        type: 'usage',
        data: {
          ...usage,
          scope: 'session-cumulative',
          sessionId: threadId,
          freshSession: !ctx.nativeSessionId,
          baseline,
          eventId: `${baseline ? 'baseline' : 'tokens'}-${JSON.stringify(usage.total)}`,
          source: 'Codex thread token usage',
        },
      });
    } else if (method === 'error') {
      const classified = codexFailure(params.error);
      if (params.willRetry === false)
        lastTerminalError = runtimeError(string(object(params.error).message), {
          provider: 'Codex',
          code: classified,
          paths: [ctx.dataDir, ctx.target.agentDir],
          prompt: ctx.input.prompt,
        });
      ctx.emit({ at: now(), type: 'error', text: classified });
    } else if (method === 'turn/completed') {
      const turn = object(params.turn);
      if (turnId && string(turn.id) !== turnId) return;
      observeProtocol(method, params, true);
      turnSettled = true;
      ctx.endTools?.();
      ctx.registerSteer?.(undefined, { state: 'finishing' });
      if (ctx.signal.aborted || turn.status === 'interrupted') fail(abortError());
      else if (turn.status === 'completed') finish({ nativeSessionId: threadId, output: output() });
      else
        fail(
          Object.keys(object(turn.error)).length
            ? runtimeError(string(object(turn.error).message), {
                provider: 'Codex',
                code: codexFailure(turn.error),
                paths: [ctx.dataDir, ctx.target.agentDir],
                prompt: ctx.input.prompt,
              })
            : (lastTerminalError ?? new Error('runtime-request-failed')),
        );
    } else if (method === 'turn/plan/updated') {
      ctx.emit({ at: now(), type: 'status', data: { taskList: params.plan } });
    } else
      observeProtocol(
        method,
        params,
        ['turn/plan/updated', 'turn/diff/updated', 'thread/status/changed'].includes(method),
      );
  });
  rpc.onRequest = async (method, params) => {
    if (string(params.threadId) && string(params.threadId) !== threadId) throw new Error('unsupported-server-request');
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
      const tool = method.includes('commandExecution') ? 'Codex command' : 'Codex file change';
      if (ctx.input.prohibitCommands === true && method === 'item/commandExecution/requestApproval')
        return { decision: 'decline' };
      if (automatic) {
        ctx.emit({
          at: now(),
          type: 'status',
          text: cleanDisplay(
            `${tool} 被原生权限边界拦截；自动模式不批准额外权限。${string(params.reason) ? ` 原因：${string(params.reason)}` : ''}`,
          ),
          data: {
            approvalMode: 'auto',
            kind: 'native-denied',
            reason: safeToolEventText(
              cleanDisplay(string(params.reason) || 'Automatic mode denies extra permissions'),
              300,
            ),
            decision: 'deny',
            source: 'Codex native permission request',
            nativeMethod: method,
            ...(string(params.itemId) ? { itemId: safeToolEventText(string(params.itemId), 512) } : {}),
          },
        });
        return { decision: 'decline' };
      }
      const details = [string(params.reason), string(params.command), string(params.cwd), string(params.grantRoot)];
      const operation = operationDetails.get(createHash('sha256').update(string(params.itemId)).digest('hex'));
      if (operation) {
        details.unshift(operation.detail);
        for (let i = details.length - 1; i > 0; i--)
          if (details[i] && operation.detail.split('\n').includes(details[i]!)) details.splice(i, 1);
      } else if (Array.isArray(params.changes)) details.unshift(JSON.stringify(params.changes));
      if (params.networkApprovalContext) details.push(JSON.stringify(params.networkApprovalContext));
      const approved = await approveWithAbort(
        ctx,
        tool,
        cleanDisplay([...new Set(details.filter(Boolean))].join('\n') || 'Approve this individual operation?'),
        params.grantRoot != null || params.networkApprovalContext != null
          ? undefined
          : 'changes' in params
            ? approvalKey(tool, params, string(params.cwd) || ctx.input.projectPath)
            : operation?.key,
      );
      return { decision: approved && !ctx.signal.aborted ? 'accept' : 'decline' };
    }
    if (method === 'item/permissions/requestApproval') {
      if (automatic) {
        ctx.emit({
          at: now(),
          type: 'status',
          text: cleanDisplay(
            `Codex 请求额外权限，自动模式已拒绝。${string(params.reason) ? ` 原因：${string(params.reason)}` : ''}`,
          ),
          data: {
            approvalMode: 'auto',
            kind: 'native-denied',
            reason: safeToolEventText(
              cleanDisplay(string(params.reason) || 'Automatic mode denies extra permissions'),
              300,
            ),
            decision: 'deny',
            source: 'Codex native permission request',
            nativeMethod: method,
            ...(string(params.itemId) ? { itemId: safeToolEventText(string(params.itemId), 512) } : {}),
          },
        });
        return { permissions: {}, scope: 'turn' };
      }
      const requested = object(params.permissions);
      const approved = await approveWithAbort(
        ctx,
        'Codex permissions',
        cleanDisplay(`${string(params.reason)}\n${JSON.stringify(requested)}`),
      );
      return { permissions: approved && !ctx.signal.aborted ? requested : {}, scope: 'turn' };
    }
    if (method === 'mcpServer/elicitation/request') {
      const meta = object(params._meta);
      if (
        !automatic &&
        string(params.serverName) === 'pugport' &&
        meta.codex_approval_kind === 'mcp_tool_call' &&
        params.mode === 'form' &&
        Object.keys(object(object(params.requestedSchema).properties)).length === 0
      ) {
        const approved = await approveWithAbort(
          ctx,
          'Codex MCP tool',
          cleanDisplay(
            [string(params.message), string(meta.tool_description).slice(0, 300), JSON.stringify(meta.tool_params)]
              .filter(Boolean)
              .join('\n'),
          ),
        );
        if (approved && !ctx.signal.aborted) return { action: 'accept', content: {}, _meta: null };
      }
      // Everything else fails closed: other servers have no bridge gate, automatic mode never asks the owner,
      // and the yes/no card cannot fill forms or perform auth.
      return { action: 'decline', content: null };
    }
    if (method === 'item/tool/requestUserInput') {
      ctx.emit({
        at: now(),
        type: 'status',
        text: 'Codex requested structured user input; answer in the native CLI or continue with a new prompt.',
      });
      return { answers: {} };
    }
    observeProtocol(method, params);
    throw new Error('unsupported-server-request');
  };
  try {
    if (ctx.signal.aborted) throw abortError();
    await rpc.initialize();
    if (ctx.signal.aborted) throw abortError();
    const permission = ctx.input.permissionMode === 'workspace-write' ? 'workspace-write' : 'read-only';
    const threadMethod = threadId ? 'thread/resume' : 'thread/start';
    const threadConfig = {
      ...(ctx.input.factCheck
        ? {
            baseInstructions: 'You are an independent web fact checker. Follow only the supplied checking task.',
            developerInstructions: '',
          }
        : {}),
      ...(threadId ? { threadId } : {}),
      cwd,
      model: ctx.route.model,
      approvalPolicy,
      approvalsReviewer: 'user',
      sandbox: trustedWrite ? 'danger-full-access' : permission,
    };
    permissionConfig(threadMethod, 'requested', threadConfig);
    const thread = await rpc.request(threadMethod, threadConfig, 45_000).catch((error) => {
      if (
        ctx.nativeSessionId &&
        !turnRequested &&
        !ctx.signal.aborted &&
        (error as { rpcRejected?: boolean }).rpcRejected
      )
        throw new Error('native-session-unavailable');
      throw error;
    });
    rpc.startup.done();
    permissionConfig(threadMethod, 'observed', thread);
    threadId = string(object(thread.thread).id);
    if (!threadId) throw new Error('runtime-protocol-missing-thread-id');
    ctx.emit({ at: now(), type: 'session', data: { nativeSessionId: threadId } });
    if (trustedWrite) ctx.emit({ at: now(), type: 'status', text: '信任项目：本次不使用沙箱' });
    if (ctx.signal.aborted) throw abortError();
    turnRequested = true;
    const turnConfig = {
      threadId,
      input: [
        { type: 'text', text: ctx.input.prompt },
        ...(ctx.input.attachments ?? [])
          .filter((attachment) => attachment.kind === 'image')
          .map((attachment) => ({ type: 'localImage', path: attachment.path })),
        // Reference images for image generation, the app-server's equivalent of `codex exec -i`.
        ...(ctx.input.imageGeneration?.references ?? []).map((image) => ({ type: 'localImage', path: image.path })),
      ],
      cwd,
      model: ctx.route.model,
      ...(ctx.route.effort ? { effort: ctx.route.effort } : {}),
      approvalPolicy,
      approvalsReviewer: 'user',
      sandboxPolicy:
        permission === 'read-only'
          ? { type: 'readOnly', networkAccess: false }
          : trustedWrite
            ? { type: 'dangerFullAccess' }
            : {
                type: 'workspaceWrite',
                // Dependency junction targets remain read/execute-only; never add the parent checkout.
                writableRoots: [cwd, ...(ctx.input.gitWritePaths ?? []), ...(temporary ? [temporary] : [])],
                networkAccess: ctx.input.network === true,
                excludeTmpdirEnvVar: true,
                excludeSlashTmp: true,
              },
    };
    permissionConfig('turn/start', 'requested', turnConfig);
    const turn = await rpc.request('turn/start', turnConfig, 45_000);
    permissionConfig('turn/start', 'observed', turn);
    turnId ||= string(object(turn.turn).id);
    if (!turnId) throw new Error('runtime-protocol-missing-turn-id');
    if (!turnSettled && !ctx.signal.aborted)
      ctx.registerSteer?.(async (prompt) => {
        if (turnSettled || ctx.signal.aborted) throw new Error('runtime-steering-unavailable');
        // Official app-server steering appends input to this exact active turn. It cannot change its route or sandbox.
        const accepted = await rpc.request('turn/steer', {
          threadId,
          input: [{ type: 'text', text: prompt }],
          expectedTurnId: turnId,
        });
        if (string(accepted.turnId) !== turnId) throw new Error('runtime-protocol-steer-turn-mismatch');
      });
    if (ctx.signal.aborted) await cancel();
    const result = await Promise.race([completion, rpc.failure]);
    if (ctx.input.imageGeneration) {
      const generatedImages = await collectCodexImages(ctx, imageStaging, threadId, imageRunStarted);
      if (generatedImages.length) result.generatedImages = generatedImages;
    }
    if (
      ctx.route.accountFingerprint &&
      ctx.target.environment === 'native' &&
      !ctx.target.gateway &&
      !ctx.signal.aborted
    ) {
      const requestedAt = now();
      let observed = false;
      try {
        const response = await rpc.request('account/rateLimits/read', undefined, 1000);
        const buckets = object(response.rateLimitsByLimitId);
        const complete =
          response.ordinaryUsageAllowed !== false &&
          (Object.keys(buckets).length ? Object.values(buckets) : [response.rateLimits]).every((raw) => {
            const bucket = object(raw);
            const windows = [bucket.primary, bucket.secondary].filter((window) => window != null);
            return (
              bucket.spendControlReached !== true &&
              bucket.individualLimit == null &&
              windows.length > 0 &&
              windows.every((rawWindow) => {
                const window = object(rawWindow);
                return (
                  typeof window.usedPercent === 'number' &&
                  Number.isFinite(window.usedPercent) &&
                  window.usedPercent >= 0 &&
                  window.usedPercent <= 100 &&
                  typeof window.resetsAt === 'number' &&
                  Number.isFinite(window.resetsAt) &&
                  window.resetsAt * 1000 > Date.now()
                );
              })
            );
          });
        const accountId = string(response.accountId);
        const identity = accountId
          ? createHash('sha256')
              .update(JSON.stringify(['codex', 'account_id', accountId]))
              .digest('hex')
          : undefined;
        if (complete && identity === ctx.route.accountFingerprint && !ctx.signal.aborted) {
          const quota = parseCodexQuota(response);
          result.postTurnQuota = {
            source: 'codex/account/rateLimits/read',
            complete: true,
            accountFingerprint: identity,
            turnCompletedAt: requestedAt,
            requestedAt,
            receivedAt: now(),
            quota,
          };
          observed = true;
        }
      } catch {
        // The completed reply survives a failed optional read; the controller retains normal settlement.
      }
      const quotaEventStarted = performance.now();
      try {
        ctx.emit({
          at: now(),
          type: 'status',
          text: '核对本轮结束后的 Codex 额度',
          data: {
            source: 'pugport',
            kind: 'post-turn-quota-read',
            outcome: observed ? 'observed' : 'unavailable',
            durationMs: Date.now() - Date.parse(requestedAt),
          },
        });
      } finally {
        quotaEventEmitMs = Math.max(0, performance.now() - quotaEventStarted);
      }
      if (ctx.signal.aborted) throw abortError();
    }
    return result;
  } catch (error) {
    if (ctx.signal.aborted) throw abortError();
    throw runtimeError(error, { paths: [ctx.dataDir, ctx.target.agentDir], prompt: ctx.input.prompt });
  } finally {
    turnSettled = true;
    ctx.endTools?.();
    ctx.registerSteer?.(undefined, { state: 'finishing' });
    ctx.signal.removeEventListener('abort', onAbort);
    unsubscribe();
    const closeStarted = performance.now();
    let closeOutcome = 'failed';
    try {
      await rpc.close();
      closeOutcome = 'completed';
    } finally {
      const rpcCloseMs = Math.max(0, performance.now() - closeStarted);
      try {
        ctx.emit({
          at: now(),
          type: 'status',
          text: '记录 Codex 回合清理耗时',
          data: {
            source: 'pugport',
            kind: 'post-turn-cleanup-timing',
            ...(quotaEventEmitMs === undefined ? {} : { quotaEventEmitMs }),
            rpcCloseMs,
            closeOutcome,
          },
        });
      } catch {
        // Optional diagnostics must not replace an execution or cleanup failure.
      }
    }
  }
}

/**
 * Images from the stream's imageGeneration items; if none arrived, the files Codex saved for this thread during the
 * run. Each staged image is recorded in the trace with the executor that made it. Codex's image tool does not report
 * its image model, so none is recorded: the route's chat model only called the tool.
 */
async function collectCodexImages(
  ctx: ExecuteContext,
  staging: Array<Promise<Awaited<ReturnType<typeof stageCodexImageItem>>>>,
  threadId: string,
  startedAt: number,
): Promise<GeneratedImage[]> {
  const request = ctx.input.imageGeneration!;
  let staged = (await Promise.all(staging)).filter((item) => !!item);
  if (!staged.length && ctx.target.environment === 'native' && threadId) {
    const codexHome = nativeAccountEnvironment(ctx.target).CODEX_HOME ?? join(homedir(), '.codex');
    staged = await stageCodexSavedImages(codexHome, threadId, startedAt, request.outputDir);
  }
  return staged.slice(0, maxImagesPerRun).map((image) => {
    const generated: GeneratedImage = {
      path: image.path,
      mimeType: image.mimeType,
      executor: ctx.target.label,
      runtimeId: ctx.target.id,
      tool: 'native-tool',
      imageModel: null,
      ...(image.revisedPrompt ? { revisedPrompt: image.revisedPrompt } : {}),
    };
    ctx.emit({
      at: now(),
      type: 'status',
      text: `${ctx.target.label} 用内置生图工具生成了一张图片`,
      data: {
        source: 'native',
        kind: 'image-generation',
        detail: {
          executor: safeToolEventText(ctx.target.label, 256),
          runtimeId: safeToolEventText(ctx.target.id, 512),
          imageModel: null,
          imageModelNote: 'not reported',
          tool: 'image_generation',
          mimeType: image.mimeType,
          path: safeToolEventText(image.path),
          ...(image.revisedPrompt ? { revisedPrompt: safeToolEventText(image.revisedPrompt) } : {}),
        },
      },
    });
    return generated;
  });
}

export function createCodexAdapter(overrides: Partial<Dependencies> = {}): Adapter {
  const deps = { ...defaults, ...overrides };
  return {
    discover: async (target) =>
      process.platform === 'win32' && !Object.keys(overrides).length
        ? (await discoverNativeInHelper(target)).snapshot
        : discover(target, deps),
    execute: (ctx) => execute(ctx, deps),
  };
}
export const codexAdapter: Adapter = createCodexAdapter();

/** Single-card redemption. The caller selects and authorizes it; never switch cards or retry here. */
export async function consumeCodexReset(
  target: RuntimeTarget,
  key: string,
  expectedIdentity: string,
  overrides: Partial<Dependencies> = {},
  identity = () => (target.accountId ? nativeAccountFingerprint(target) : defaultNativeAccountFingerprint(target)),
  authorize?: (quota: RuntimeSnapshot['quota']) => void,
) {
  const deps = { ...defaults, ...overrides };
  let rpc: CodexRpc | undefined;
  // Everything before the consume request can fail without spending the card.
  let sent = false;
  try {
    if (target.provider !== 'codex' || target.environment !== 'native' || target.gateway)
      throw Error('仅支持原生 Codex 订阅账号');
    if (!/^[a-f0-9]{64}$/.test(key) || !expectedIdentity || identity() !== expectedIdentity)
      throw Error('账号身份已变化，请刷新后重新选择');
    rpc = new CodexRpc(await deps.spawn(target, codexAppServerArgs(target)), deps.terminate, {
      paths: [target.agentDir],
    });
    await rpc.initialize();
    const auth = await rpc.request('account/read', { refreshToken: false });
    if (object(auth.account).type !== 'chatgpt') throw Error('仅支持 ChatGPT 订阅登录');
    const response = await rpc.request('account/rateLimits/read');
    const accountId = string(response.accountId);
    const reported = accountId
      ? createHash('sha256')
          .update(JSON.stringify(['codex', 'account_id', accountId]))
          .digest('hex')
      : undefined;
    if (reported !== expectedIdentity || identity() !== expectedIdentity)
      throw Error('无法确认当前额度与所选账号一致，请刷新');
    const credits = object(response.rateLimitResetCredits),
      rows = Array.isArray(credits.credits) ? credits.credits : [];
    const card = rows.map(object).find((row) => typeof row.id === 'string' && resetCreditKey(row.id) === key);
    if (!card || card.status !== 'available' || card.resetType !== 'codexRateLimits')
      throw Error('该重置卡当前不可用，请刷新');
    if (typeof card.expiresAt === 'number' && card.expiresAt * 1000 <= Date.now()) throw Error('该重置卡已到期');
    // Stable per account/card, including after network failure or application restart.
    const idempotencyKey = createHash('sha256')
      .update(JSON.stringify(['comborunner-reset-v1', expectedIdentity, key]))
      .digest('hex');
    if (identity() !== expectedIdentity) throw Error('账号身份已变化');
    authorize?.(parseCodexQuota(response));
    sent = true;
    const result = await rpc.request('account/rateLimitResetCredit/consume', { creditId: card.id, idempotencyKey });
    const outcome = string(result.outcome);
    if (!['reset', 'alreadyRedeemed', 'nothingToReset', 'noCredit'].includes(outcome))
      throw Error('兑换结果未确认，请刷新后核对，勿重复使用其他卡');
    return { outcome };
  } catch (error) {
    throw sent ? error : markNotSent(error);
  } finally {
    await rpc?.close();
  }
}
