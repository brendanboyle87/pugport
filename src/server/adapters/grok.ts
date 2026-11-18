import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type {
  Adapter,
  DiscoveryOptions,
  ExecuteContext,
  ModelInfo,
  RuntimeSnapshot,
  RuntimeTarget,
} from '../../shared/types.js';
import {
  StartupTail,
  spawnTarget,
  captureTarget,
  targetPath,
  terminateProcess,
  redactError,
  runtimeError,
} from './process.js';
import { readGrokQuota } from '../grok-quota.js';
import {
  executeGrokAcp,
  GrokAcpUnsupported,
  grokKnownImageVersion,
  grokToolDenylist,
  grokToollessEnvironment,
  grokAcpHandshake,
} from './grok-acp.js';
import { safeToolEventText, toolEventCaptureLimit, toolEventDetails } from '../../shared/tool-event-data.ts';
import { auditNativeProcess, auditUnmappedSessionUpdate, auditPermissionConfig } from './execution-audit.ts';
import { deviceFullAccess } from './device-access.ts';
import { discoverNativeInHelper } from '../native-discovery-client.ts';

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as ObjectValue) : {};
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
type Dependencies = {
  spawn: typeof spawnTarget;
  capture: typeof captureTarget;
  targetPath: typeof targetPath;
  terminate: typeof terminateProcess;
  quota: typeof readGrokQuota;
  handshakeTimeoutMs?: number;
};
const defaults: Dependencies = {
  spawn: spawnTarget,
  capture: captureTarget,
  targetPath,
  terminate: terminateProcess,
  quota: readGrokQuota,
};

export function grokResultUsage(payload: unknown): Record<string, unknown> | undefined {
  const packet = object(payload),
    usage = object(packet.usage);
  const data: ObjectValue = {
    source: 'Grok CLI prompt result',
    eventId: 'result',
    scope: 'run-cumulative',
    cumulative: true,
  };
  for (const [source, destination] of [
    ['input_tokens', 'inputTokens'],
    ['output_tokens', 'outputTokens'],
    ['cache_read_input_tokens', 'cacheReadTokens'],
    ['cache_creation_input_tokens', 'cacheWriteTokens'],
    ['reasoning_tokens', 'reasoningTokens'],
    ['total_tokens', 'totalTokens'],
  ] as const) {
    const value = usage[source];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) data[destination] = value;
  }
  const buckets = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'];
  if (data.totalTokens === undefined && buckets.every((key) => typeof data[key] === 'number'))
    data.totalTokens = buckets.reduce((sum, key) => sum + Number(data[key]), 0);
  if (packet.cost_is_partial === true || packet.usage_is_incomplete === true) data.incomplete = true;
  // The CLI only stamps complete server cost. Missing/partial cost never means zero.
  const cost = packet.total_cost_usd;
  if (data.incomplete !== true && typeof cost === 'number' && Number.isFinite(cost) && cost >= 0) {
    data.costUsd = cost;
    data.costKind = 'reported';
    if (Number.isSafeInteger(packet.total_cost_usd_ticks) && Number(packet.total_cost_usd_ticks) >= 0)
      data.costUsdTicks = packet.total_cost_usd_ticks;
  }
  return Object.keys(data).length > 4 ? data : undefined;
}

export function grokModels(stdout: string): ModelInfo[] {
  const seen = new Set<string>();
  const models: ModelInfo[] = [];
  const plain = stdout.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
  for (const line of plain.split(/\r?\n/)) {
    const match = /^\s*[*-]\s+([a-zA-Z0-9._:/-]+)(?:\s+\(default\))?\s*$/.exec(line);
    if (!match?.[1] || seen.has(match[1])) continue;
    const id = match[1];
    seen.add(id);
    // Official model-specific effort support; unknown models get no invented levels.
    const efforts = /^grok-4\.[67](?:$|-)/.test(id)
      ? ['low', 'medium', 'high', 'xhigh']
      : id === 'grok-4.5'
        ? ['low', 'medium', 'high']
        : [];
    models.push({ id, label: id, efforts, ...(efforts.length ? { defaultEffort: 'high' } : {}) });
  }
  return models;
}

/** Tool-less headless Grok: see grokToolDenylist. */
const grokToollessArgs = [
  '--tools',
  'Read,Grep',
  '--disallowed-tools',
  grokToolDenylist.join(','),
  '--deny',
  '*',
  '--disable-web-search',
];

export function grokExecutionArgs(ctx: ExecuteContext, promptFile: string, sessionId: string): string[] {
  // Native auto classifies tool calls; headless calls it cannot allow are denied,
  // not presented as interactive prompts. Only a device's write task on this computer bypasses it.
  const args = [
    '--prompt-file',
    promptFile,
    '--output-format',
    'streaming-messages-json',
    '--include-partial-messages',
    '--permission-mode',
    ctx.approvalMode === 'auto' ? (deviceFullAccess(ctx) ? 'bypassPermissions' : 'auto') : 'dontAsk',
    '--no-subagents',
  ];
  if (ctx.route.model) args.push('--model', ctx.route.model);
  if (ctx.route.effort) args.push('--reasoning-effort', ctx.route.effort);
  if (ctx.nativeSessionId) args.push('--resume', ctx.nativeSessionId);
  else args.push('--session-id', sessionId);
  if (ctx.input.untrustedContent) args.push(...grokToollessArgs);
  else if (ctx.input.permissionMode === 'read-only') {
    args.push(
      '--tools',
      'Read,Grep',
      '--allow',
      'Read',
      '--allow',
      'Grep',
      '--deny',
      'Edit',
      '--deny',
      'Bash',
      '--deny',
      'MCPTool',
      '--disable-web-search',
    );
  } else if (ctx.input.prohibitCommands === true) {
    args.push(
      '--tools',
      'Read,Grep,Edit,Write',
      '--disallowed-tools',
      'Bash,Agent,MCPTool,search_tool,use_tool',
      '--deny',
      'Bash',
      '--deny',
      'MCPTool',
    );
  }
  return args;
}

export function createGrokAdapter(overrides: Partial<Dependencies> = {}): Adapter {
  const deps = { ...defaults, ...overrides };
  return {
    async discover(target: RuntimeTarget, options?: DiscoveryOptions): Promise<RuntimeSnapshot> {
      const snapshot: RuntimeSnapshot = {
        id: target.id,
        provider: 'grok',
        label: target.label,
        environment: target.environment,
        installed: false,
        status: 'missing',
        models: [],
        quota: {
          status: 'unknown',
          source: 'Grok CLI',
          observedAt: null,
          windows: [],
          note: '尚未读取此账号的订阅额度。',
        },
        capabilities: { execute: true, resume: true, cancel: true, approvals: false, toolless: true },
        refreshedAt: new Date().toISOString(),
      };
      try {
        if (process.platform === 'win32' && !Object.keys(overrides).length)
          return (await discoverNativeInHelper(target, { discovery: options })).snapshot;
        // These metadata commands do not start a model turn. Their process startup
        // can overlap instead of making every refresh pay both cold starts in series.
        const [version, result] = await Promise.all([
          deps.capture(target, ['--version'], { timeoutMs: 10000 }),
          deps.capture(target, ['models'], { timeoutMs: 20000 }),
        ]);
        snapshot.installed = true;
        snapshot.version = /\b\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?\b/.exec(version.stdout)?.[0];
        snapshot.capabilities.imageInput = grokKnownImageVersion(snapshot.version);
        // 1.0.44's stdio extension was metadata-probed locally; each execution
        // verifies the method before creating a session or sending a model prompt.
        const versionParts = snapshot.version?.split('.').map(Number);
        snapshot.capabilities.steer = Boolean(
          versionParts &&
          (versionParts[0]! > 1 || (versionParts[0] === 1 && (versionParts[1]! > 0 || versionParts[2]! >= 44))),
        );
        if (
          snapshot.version === options?.grokHandshake?.lastPassedVersion &&
          options?.grokHandshake?.lastPassedSteer === false
        )
          snapshot.capabilities.steer = false;
        snapshot.models = grokModels(result.stdout);
        const apiKey = /logged in with (?:an? )?api.?key/i.test(result.stdout);
        const subscription = /logged in with (?:grok\.com|(?:an? )?(?:browser|web|oauth))/i.test(result.stdout);
        snapshot.accounting = {
          mode: apiKey ? 'usage' : subscription ? 'subscription' : 'unknown',
          source: 'Grok CLI 登录类型',
          note: '订阅登录与剩余额度分别核验；额度未知不会变成按量计费。',
        };
        snapshot.status =
          result.diagnostic === 'authentication-required' ||
          /not (?:logged|signed) in|authentication required|run.*grok login/i.test(result.stdout)
            ? 'auth-required'
            : result.diagnostic === 'runtime-protocol-incompatible'
              ? 'error'
              : /logged in with/i.test(result.stdout) && snapshot.models.length
                ? 'ready'
                : 'unknown';
        if (
          snapshot.status === 'ready' &&
          (snapshot.version !== options?.grokHandshake?.lastPassedVersion ||
            options?.grokHandshake?.afterStartupFailure)
        ) {
          snapshot.grokHandshakeAttempt = { passed: false };
          try {
            const supported = await grokAcpHandshake(target, deps, deps.handshakeTimeoutMs ?? 20_000);
            snapshot.grokHandshakeAttempt.passed = true;
            if (!supported) snapshot.capabilities.steer = false;
          } catch (error) {
            if (!(error instanceof Error) || error.message !== 'runtime-timeout') throw error;
          }
        }
        if (snapshot.status === 'ready' && !apiKey) {
          try {
            snapshot.quota = await deps.quota(target);
            snapshot.subscription = snapshot.quota.subscription;
          } catch {
            snapshot.quota = {
              status: 'error',
              source: 'Grok CLI 账单额度',
              observedAt: null,
              windows: [],
              note: '暂时无法读取 Grok 额度，剩余额度未知。',
            };
          }
        } else if (apiKey) snapshot.quota.note = 'API 密钥登录不提供订阅剩余额度。';
        if (snapshot.status === 'auth-required') {
          snapshot.accounting.mode = 'unknown';
          snapshot.note = 'authentication-required';
          snapshot.quota.note = '当前 Grok CLI 未登录或登录已过期，请重新登录后刷新连接；缓存模型列表不代表登录有效。';
        } else
          snapshot.note =
            result.diagnostic ??
            '支持原生 Grok 流式执行与会话恢复。自动模式使用 Grok 原生判断；无法自动放行的操作会被拒绝，不弹确认窗口。逐次确认模式下，仅执行 CLI 已许可的操作。';
      } catch (error) {
        snapshot.note = redactError(error);
        snapshot.errorDetail = (error as { startup?: { firstLine?: string } }).startup?.firstLine;
        snapshot.status =
          snapshot.note === 'runtime-not-found'
            ? 'missing'
            : snapshot.note === 'authentication-required'
              ? 'auth-required'
              : 'error';
        snapshot.installed = snapshot.status !== 'missing';
        if (snapshot.status === 'auth-required')
          snapshot.quota.note = '当前 Grok CLI 未登录或登录已过期，请重新登录后刷新连接。';
      }
      return snapshot;
    },
    async execute(ctx: ExecuteContext) {
      if (ctx.signal.aborted) throw new Error('Run cancelled.');
      const hasImages = ctx.input.attachments?.some((attachment) => attachment.kind === 'image');
      if (ctx.registerSteer || hasImages || ctx.input.factCheck) {
        try {
          return await executeGrokAcp(ctx, deps);
        } catch (error) {
          if (!(error instanceof GrokAcpUnsupported) || ctx.input.factCheck) throw error;
          if (hasImages) throw new Error('runtime-image-input-unavailable');
          ctx.registerSteer?.(undefined, {
            state: 'unsupported',
            reason: '当前 Grok CLI 的 ACP 协议未提供插话方法。',
          });
          ctx.emit({
            at: new Date().toISOString(),
            type: 'status',
            text: '此 Grok CLI 不支持 ACP 插话，当前任务使用无界面执行，运行中补充消息不可用。',
          });
        }
      }
      const directory = await mkdtemp(join(ctx.runTemp ?? tmpdir(), 'agent-studio-grok-'));
      const promptFile = join(directory, 'prompt.txt');
      let child: Awaited<ReturnType<typeof spawnTarget>> | undefined;
      let output = '';
      let nativeSessionId = ctx.nativeSessionId ?? randomUUID();
      try {
        await writeFile(promptFile, ctx.input.prompt, { encoding: 'utf8', mode: 0o600 });
        const runtimePromptFile = await deps.targetPath(ctx.target, promptFile);
        const executionArgs = grokExecutionArgs(ctx, runtimePromptFile, nativeSessionId);
        child = await deps.spawn(ctx.target, executionArgs, {
          sandbox: ctx.sandbox,
          onSandboxFailure: ctx.onSandboxFailure,
          onSandboxSuccess: ctx.onSandboxSuccess,
          signal: ctx.signal,
          runTemp: ctx.runTemp,
          cwd: ctx.input.projectPath,
          ...(ctx.input.untrustedContent ? { env: grokToollessEnvironment() } : {}),
        });
        const process = child;
        const startup = new StartupTail();
        auditNativeProcess(ctx, process, executionArgs, 'streaming-messages-json');
        const argument = (flag: string) =>
          executionArgs.includes(flag) ? executionArgs[executionArgs.indexOf(flag) + 1] : undefined;
        auditPermissionConfig(ctx, 'process/spawn', 'requested', {
          permissionMode: argument('--permission-mode'),
          tools: argument('--tools'),
          cwd: ctx.input.projectPath,
        });
        ctx.emit({ at: new Date().toISOString(), type: 'session', data: { nativeSessionId } });
        ctx.emit({
          at: new Date().toISOString(),
          type: 'status',
          text:
            ctx.approvalMode === 'auto'
              ? 'Grok 自动运行：由原生 auto 模式判断操作；不能自动放行的操作会被拒绝并返回模型，不等待人工确认。'
              : 'Grok 使用 dontAsk：仅执行 CLI 已许可的操作，其余操作会被拒绝；当前无界面协议不支持逐次确认。',
        });
        await new Promise<void>((resolve, reject) => {
          let buffer = '';
          const toolCalls = new Map<string, string>();
          const toolInputs = new Map<string, string>();
          const acpKinds = new Map<string, string>();
          const acpStatuses = new Map<string, string>();
          const acpNativeNames = new Map<string, string>();
          const acpTargets = new Map<string, string>();
          const streamedTools = new Map<number, { id: string; name: string; json: string; truncated?: boolean }>();
          const emitToolStart = (block: ObjectValue) => {
            const rawId = text(block.id),
              id = rawId.length <= 512 && safeToolEventText(rawId, 512) === rawId ? rawId : '',
              name = safeToolEventText(text(block.name), 256);
            const details = toolEventDetails(block);
            const inputKey = JSON.stringify(details.input);
            if (id && toolCalls.has(id) && (details.input === undefined || toolInputs.get(id) === inputKey)) return;
            if (id && toolCalls.size < 4096) toolCalls.set(id, name);
            if (id && details.input !== undefined) toolInputs.set(id, inputKey);
            ctx.emit({
              at: new Date().toISOString(),
              type: 'tool',
              text: name || 'Tool call',
              data: {
                ...(id ? { toolCallId: id } : {}),
                kind: 'nativeToolCall',
                tool: name,
                status: 'inProgress',
                ...details,
              },
            });
          };
          let streamedThisMessage = false;
          let resultError: Error | undefined;
          let done = false;
          const complete = (error?: Error): void => {
            if (done) return;
            done = true;
            ctx.signal.removeEventListener('abort', abort);
            if (error) reject(error);
            else resolve();
          };
          let thoughtThisMessage = false;
          const emitReasoning = (chunk: string): void => {
            if (chunk) ctx.emit({ at: new Date().toISOString(), type: 'reasoning', text: chunk });
          };
          const emitText = (chunk: string): void => {
            if (!chunk) return;
            output += chunk;
            ctx.emit({ at: new Date().toISOString(), type: 'text', text: chunk });
          };
          const onLine = (line: string): void => {
            let packet: ObjectValue;
            try {
              packet = object(JSON.parse(line));
            } catch {
              return;
            }
            startup.done();
            const returnedSession = text(packet.session_id) || text(packet.sessionId);
            if (returnedSession && returnedSession !== nativeSessionId) {
              nativeSessionId = returnedSession;
              ctx.emit({ at: new Date().toISOString(), type: 'session', data: { nativeSessionId } });
            }
            const event = packet.type === 'stream_event' ? object(packet.event) : packet;
            if (event.type === 'message_start') {
              streamedThisMessage = false;
              thoughtThisMessage = false;
            }
            if (event.type === 'content_block_start' && object(event.content_block).type === 'tool_use') {
              const block = object(event.content_block);
              if (
                typeof event.index === 'number' &&
                text(block.id) &&
                text(block.id).length <= 512 &&
                safeToolEventText(text(block.id), 512) === text(block.id) &&
                streamedTools.size < 4096
              )
                streamedTools.set(event.index, { id: text(block.id), name: text(block.name), json: '' });
              emitToolStart(block);
            }
            const delta = object(event.delta);
            if (
              event.type === 'content_block_delta' &&
              delta.type === 'input_json_delta' &&
              typeof event.index === 'number'
            ) {
              const tool = streamedTools.get(event.index);
              if (tool && !tool.truncated) {
                const json = tool.json + text(delta.partial_json);
                tool.truncated = json.length > toolEventCaptureLimit;
                tool.json = json.slice(0, toolEventCaptureLimit);
              }
            }
            if (event.type === 'content_block_stop' && typeof event.index === 'number') {
              const tool = streamedTools.get(event.index);
              streamedTools.delete(event.index);
              if (tool?.json) {
                if (tool.truncated) {
                  emitToolStart({
                    id: tool.id,
                    name: tool.name,
                    input: '[capture truncated: streamed argument size limit]',
                  });
                  return;
                }
                try {
                  emitToolStart({ id: tool.id, name: tool.name, input: JSON.parse(tool.json) });
                } catch {
                  /* Partial JSON is not invented input. */
                }
              }
            }
            if (event.type === 'content_block_delta' && delta.type === 'text_delta') {
              streamedThisMessage = true;
              emitText(text(delta.text));
            }
            if (event.type === 'content_block_delta' && delta.type === 'thinking_delta') {
              thoughtThisMessage = true;
              emitReasoning(text(delta.thinking));
            }
            if (packet.type === 'assistant') {
              const content = object(packet.message).content;
              if (Array.isArray(content))
                for (const item of content) {
                  const block = object(item);
                  if (block.type === 'text' && !streamedThisMessage) emitText(text(block.text));
                  if (block.type === 'thinking' && !thoughtThisMessage) emitReasoning(text(block.thinking));
                  if (block.type === 'tool_use' && packet.isReplay !== true) emitToolStart(block);
                }
              streamedThisMessage = false;
              thoughtThisMessage = false;
            }
            if (packet.type === 'user' && packet.isReplay !== true) {
              const content = object(packet.message).content;
              if (Array.isArray(content))
                for (const value of content) {
                  const block = object(value),
                    id = text(block.tool_use_id);
                  if (block.type !== 'tool_result' || !id || !toolCalls.has(id)) continue;
                  const failed = block.is_error === true;
                  const name = toolCalls.get(id) ?? '';
                  // A native result may acknowledge background work; do not turn it into a safe handoff proof.
                  const uncertain =
                    ['Bash', 'Agent', 'Task'].includes(name) ||
                    (block.is_error !== undefined && typeof block.is_error !== 'boolean');
                  ctx.emit({
                    at: new Date().toISOString(),
                    type: 'tool',
                    text: toolCalls.get(id) || 'Tool call',
                    data: {
                      toolCallId: id,
                      kind: 'nativeToolCall',
                      tool: toolCalls.get(id),
                      status: failed ? 'failed' : uncertain ? 'unknown' : 'completed',
                      ...(failed ? { isError: true } : {}),
                      ...toolEventDetails({ output: block.content }),
                    },
                  });
                }
            }
            // Accept ACP-style updates too, for CLI versions that wrap the native messages format.
            const update =
              packet.method === 'session/update' || packet.method === '_x.ai/session/update'
                ? object(object(packet.params).update)
                : packet;
            if (update.sessionUpdate === 'agent_message_chunk') emitText(text(object(update.content).text));
            if (update.sessionUpdate === 'agent_thought_chunk') emitReasoning(text(object(update.content).text));
            const toolType = text(update.sessionUpdate) || text(update.type);
            auditUnmappedSessionUpdate(ctx, packet.method, update);
            if (toolType === 'tool_call' || toolType === 'tool_call_update') {
              const rawId = text(update.toolCallId);
              const id = rawId.length <= 512 && safeToolEventText(rawId, 512) === rawId ? rawId : '';
              const provenance = object(object(packet.params)._meta);
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
              const nativeName = text(update.toolName) || text(nativeTool.name);
              const target = text(object(update.rawInput).tool_name);
              const kind = text(update.kind) || text(nativeTool.kind);
              if (id && acpKinds.size < 4096) {
                if (kind && (kind !== 'other' || !acpKinds.has(id))) acpKinds.set(id, safeToolEventText(kind, 256));
                if (target) acpTargets.set(id, safeToolEventText(target, 256));
                if (nativeName) acpNativeNames.set(id, safeToolEventText(nativeName, 256));
              }
              const name = target || acpTargets.get(id) || nativeName || toolCalls.get(id);
              if (id && name && toolCalls.size < 4096) toolCalls.set(id, safeToolEventText(name, 256));
              const status = text(update.status) || acpStatuses.get(id) || (toolType === 'tool_call' ? 'pending' : '');
              if (id && status && acpStatuses.size < 4096) acpStatuses.set(id, safeToolEventText(status, 256));
              ctx.emit({
                at: new Date().toISOString(),
                type: 'tool',
                text: safeToolEventText(name || text(update.title) || 'Tool call', 300),
                data: {
                  ...(id ? { toolCallId: id } : {}),
                  ...nativeIds,
                  ...(acpKinds.get(id) ? { kind: acpKinds.get(id) } : {}),
                  ...(name ? { tool: safeToolEventText(name, 256) } : {}),
                  ...(acpNativeNames.get(id) ? { nativeTool: acpNativeNames.get(id) } : {}),
                  ...(text(update.title) ? { title: safeToolEventText(text(update.title)) } : {}),
                  ...(status ? { status: safeToolEventText(status, 256) } : {}),
                  ...toolEventDetails(update),
                },
              });
            }
            if (packet.type === 'result') {
              if (packet.is_error === true || text(packet.subtype).startsWith('error'))
                resultError = grokFailure(packet, ctx);
              else if (!output) emitText(text(packet.result));
              const data = grokResultUsage(packet);
              if (data) ctx.emit({ at: new Date().toISOString(), type: 'usage', data });
            }
            if (packet.type === 'error' || event.type === 'error') resultError = grokFailure(event, ctx);
          };
          const abort = (): void => {
            complete(new Error('Run cancelled.'));
            void deps.terminate(process);
          };
          process.stdout.setEncoding('utf8');
          process.stdout.on('data', (chunk: string) => {
            if (done) return;
            startup.write('stdout', chunk);
            buffer += chunk;
            if (buffer.length > 4 * 1024 * 1024) {
              complete(new Error('Grok protocol line exceeds the size limit.'));
              return;
            }
            let index: number;
            while ((index = buffer.indexOf('\n')) >= 0) {
              const line = buffer.slice(0, index);
              buffer = buffer.slice(index + 1);
              if (line.trim()) onLine(line);
            }
          });
          process.stderr.on('data', (chunk: Buffer) => startup.write('stderr', chunk));
          process.on('error', (error) => complete(new Error(redactError(error))));
          process.stdin.on('error', (error) => {
            if (!startup.active) complete(new Error(redactError(error)));
          });
          process.on('close', (code) => {
            if (buffer.trim()) onLine(buffer);
            complete(
              ctx.signal.aborted
                ? new Error('Run cancelled.')
                : startup.active
                  ? startup.failure('Grok', code ?? null, {
                      paths: [ctx.dataDir, ctx.target.agentDir],
                      prompt: ctx.input.prompt,
                    })
                  : resultError
                    ? resultError
                    : code !== 0
                      ? new Error(`Grok process exited (${code ?? 'signal'}).`)
                      : !output.trim()
                        ? new Error('Grok returned no assistant text. Check native CLI authentication and permissions.')
                        : undefined,
            );
          });
          ctx.signal.addEventListener('abort', abort, { once: true });
          if (ctx.signal.aborted) abort();
          else process.stdin.end();
        });
        return { nativeSessionId, output };
      } finally {
        if (child) await deps.terminate(child);
        await unlink(promptFile).catch(() => undefined);
        await rmdir(directory).catch(() => undefined);
      }
    },
  };
}

export const grokAdapter = createGrokAdapter();

/** Classify only error envelopes; never expose their raw diagnostics as assistant output. */
function grokFailure(packet: ObjectValue, ctx: ExecuteContext): Error {
  const nested = object(packet.error),
    response = object(packet.response);
  const codes = [
    packet.status,
    packet.status_code,
    packet.code,
    nested.status,
    nested.status_code,
    nested.code,
    response.status,
  ].map(String);
  const detail = [
    packet.result,
    packet.message,
    packet.subtype,
    packet.error,
    nested.message,
    nested.type,
    nested.code,
    ...(Array.isArray(packet.errors) ? packet.errors : []),
  ]
    .filter((value) => typeof value === 'string')
    .join(' ')
    .slice(0, 32000);
  // 402: the Build usage balance is exhausted (payment required), the same limit as a quota.
  const failure = (code: string) =>
    runtimeError(detail, {
      provider: 'Grok',
      code,
      paths: [ctx.dataDir, ctx.target.agentDir],
      prompt: ctx.input.prompt,
    });
  if (
    codes.includes('429') ||
    codes.includes('402') ||
    /rate.?limit|usage.?limit|quota|resource_exhausted|insufficient.?credits|credits?.?exhausted|balance.?exhausted|payment.?required/i.test(
      detail,
    )
  )
    return failure('quota-or-rate-limit');
  if (
    codes.includes('401') ||
    /authentication_error|authentication.?required|unauthori[sz]ed|not.?logged.?in|token.?expired/i.test(detail)
  )
    return failure('authentication-required');
  return failure(redactError(new Error(detail)));
}
